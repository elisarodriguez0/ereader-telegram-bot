import type {
	Env,
} from "./env";

interface ManifestEntry {
	name: string;
	key: string;
	size: number;
	updated: string;
	etag: string;
	download_url: string;
}

function xmlEscape(
	value: string,
): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function authorized(
	request: Request,
	env: Env,
): boolean {
	const url = new URL(request.url);
	const queryToken =
		url.searchParams.get("token");
	const authorization =
		request.headers.get("Authorization");
	const bearer = authorization
		?.match(/^Bearer\s+(.+)$/i)?.[1];

	return (
		queryToken === env.LIBRARY_TOKEN ||
		bearer === env.LIBRARY_TOKEN
	);
}

function unauthorized(): Response {
	return new Response(
		"Unauthorized",
		{
			status: 401,
			headers: {
				"Content-Type":
					"text/plain; charset=utf-8",
			},
		},
	);
}

async function listAllObjects(
	env: Env,
	prefix: string,
): Promise<any[]> {
	const objects: any[] = [];
	let cursor: string | undefined;

	do {
		const page = await env.EREADER_BUCKET.list({
			prefix,
			limit: 1000,
			...(cursor ? { cursor } : {}),
		});

		objects.push(
			...(page.objects ?? []),
		);

		cursor = page.truncated
			? page.cursor
			: undefined;
	} while (cursor);

	return objects;
}

function entryFromObject(
	request: Request,
	env: Env,
	object: any,
	prefix: string,
	downloadPath: string,
): ManifestEntry {
	const base = new URL(request.url);
	const download = new URL(
		downloadPath,
		base.origin,
	);

	download.searchParams.set(
		"key",
		object.key,
	);
	download.searchParams.set(
		"token",
		env.LIBRARY_TOKEN,
	);

	return {
		name: String(object.key).slice(
			prefix.length,
		),
		key: object.key,
		size: object.size,
		updated:
			object.uploaded instanceof Date
				? object.uploaded.toISOString()
				: new Date(
						object.uploaded ?? Date.now(),
					).toISOString(),
		etag: object.etag ?? "",
		download_url: download.toString(),
	};
}

async function manifest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (!authorized(request, env)) {
		return unauthorized();
	}

	const [
		bookObjects,
		kindleWallpaperObjects,
		xteinkWallpaperObjects,
	] = await Promise.all([
		listAllObjects(
			env,
			"books/",
		),
		listAllObjects(
			env,
			"wallpapers/kindle/",
		),
		listAllObjects(
			env,
			"wallpapers/xteink/",
		),
	]);

	const books = bookObjects
		.filter((object) =>
			String(object.key)
				.toLowerCase()
				.endsWith(".epub"),
		)
		.map((object) =>
			entryFromObject(
				request,
				env,
				object,
				"books/",
				"/download",
			),
		)
		.sort((a, b) =>
			a.name.localeCompare(b.name),
		);

	const wallpapers =
		kindleWallpaperObjects
			.map((object) =>
				entryFromObject(
					request,
					env,
					object,
					"wallpapers/kindle/",
					"/wallpaper/download",
				),
			)
			.sort((a, b) =>
				a.name.localeCompare(b.name),
			);

	const wallpapers_xteink =
		xteinkWallpaperObjects
			.map((object) =>
				entryFromObject(
					request,
					env,
					object,
					"wallpapers/xteink/",
					"/wallpaper/download",
				),
			)
			.sort((a, b) =>
				a.name.localeCompare(b.name),
			);

	return Response.json(
		{
			generated_at:
				new Date().toISOString(),
			books,
			wallpapers,
			wallpapers_xteink,
		},
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}

async function booksJson(
	request: Request,
	env: Env,
): Promise<Response> {
	if (!authorized(request, env)) {
		return unauthorized();
	}

	const objects = await listAllObjects(
		env,
		"books/",
	);

	return Response.json(
		objects
			.filter((object) =>
				String(object.key)
					.toLowerCase()
					.endsWith(".epub"),
			)
			.map((object) => ({
				key: object.key,
				name: String(object.key).slice(
					"books/".length,
				),
				size: object.size,
				etag: object.etag,
				updated:
					object.uploaded instanceof Date
						? object.uploaded.toISOString()
						: object.uploaded,
				metadata:
					object.customMetadata ?? {},
			})),
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}

async function opds(
	request: Request,
	env: Env,
): Promise<Response> {
	if (!authorized(request, env)) {
		return unauthorized();
	}

	const objects = await listAllObjects(
		env,
		"books/",
	);

	const url = new URL(request.url);
	const feedId = `${url.origin}/opds`;

	const entries = objects
		.filter((object) =>
			String(object.key)
				.toLowerCase()
				.endsWith(".epub"),
		)
		.map((object) => {
			const name = String(object.key).slice(
				"books/".length,
			);
			/*
			 * syncTitle/syncAuthor are the canonical filename components.
			 * CrossInk can be configured as "Title - Author", so exposing
			 * these in OPDS keeps its downloaded filename identical to the
			 * R2/Kindle filename even when the provider title contains an
			 * edition label such as "(Standard Edition)".
			 */
			const title =
				object.customMetadata?.syncTitle ??
				object.customMetadata?.title ??
				name.replace(/\.epub$/i, "");
			const author =
				object.customMetadata?.syncAuthor ??
				object.customMetadata?.author;
			const updated =
				object.uploaded instanceof Date
					? object.uploaded.toISOString()
					: new Date(
							object.uploaded ?? Date.now(),
						).toISOString();

			const download = new URL(
				"/download",
				url.origin,
			);
			download.searchParams.set(
				"key",
				object.key,
			);
			download.searchParams.set(
				"token",
				env.LIBRARY_TOKEN,
			);

			return `
  <entry>
    <title>${xmlEscape(String(title))}</title>
    <id>${xmlEscape(`urn:ereader-sync:${object.key}`)}</id>
    <updated>${xmlEscape(updated)}</updated>
    ${author ? `<author><name>${xmlEscape(String(author))}</name></author>` : ""}
    <link rel="http://opds-spec.org/acquisition" href="${xmlEscape(download.toString())}" type="application/epub+zip" />
  </entry>`;
		})
		.join("");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>e-reader library</title>
  <id>${xmlEscape(feedId)}</id>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="${xmlEscape(request.url)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition" />
${entries}
</feed>`;

	return new Response(xml, {
		headers: {
			"Content-Type":
				"application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

async function serveR2Object(
	request: Request,
	env: Env,
	allowedPrefixes: string[],
): Promise<Response> {
	if (!authorized(request, env)) {
		return unauthorized();
	}

	const url = new URL(request.url);
	const key = url.searchParams.get("key");

	if (
		!key ||
		!allowedPrefixes.some((prefix) =>
			key.startsWith(prefix),
		)
	) {
		return new Response(
			"Invalid key",
			{ status: 400 },
		);
	}

	const object = await env.EREADER_BUCKET.get(
		key,
	);

	if (!object) {
		return new Response(
			"Not found",
			{ status: 404 },
		);
	}

	const headers = new Headers();

	if (
		typeof object.writeHttpMetadata ===
		"function"
	) {
		object.writeHttpMetadata(headers);
	} else if (
		object.httpMetadata?.contentType
	) {
		headers.set(
			"Content-Type",
			object.httpMetadata.contentType,
		);
	}

	headers.set(
		"ETag",
		object.httpEtag ??
			`"${object.etag}"`,
	);
	headers.set(
		"Cache-Control",
		"private, max-age=0, must-revalidate",
	);

	if (!headers.has("Content-Disposition")) {
		const name = key.split("/").pop() ??
			"download";
		headers.set(
			"Content-Disposition",
			`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
		);
	}

	return new Response(
		object.body,
		{
			headers,
		},
	);
}

export async function handleLibraryRoute(
	request: Request,
	env: Env,
): Promise<Response | undefined> {
	const url = new URL(request.url);

	switch (url.pathname) {
		case "/manifest":
			return manifest(request, env);

		case "/books":
			return booksJson(request, env);

		case "/opds":
			return opds(request, env);

		case "/download":
			return serveR2Object(
				request,
				env,
				["books/"],
			);

		case "/wallpaper/download":
			return serveR2Object(
				request,
				env,
				[
					"wallpapers/kindle/",
					"wallpapers/xteink/",
				],
			);

		default:
			return undefined;
	}
}
