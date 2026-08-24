interface Env {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_ALLOWED_USER_ID?: string;
	LIBRARY_TOKEN: string;
	EREADER_BUCKET: R2Bucket;
}

interface TelegramDocument {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramMessage {
	chat: {
		id: number;
	};
	from?: {
		id: number;
		first_name?: string;
		username?: string;
	};
	text?: string;
	document?: TelegramDocument;
}

interface TelegramUpdate {
	message?: TelegramMessage;
}

interface TelegramFileResponse {
	ok: boolean;
	result?: {
		file_id: string;
		file_unique_id: string;
		file_size?: number;
		file_path?: string;
	};
	description?: string;
}

async function sendTelegramMessage(
	token: string,
	chatId: number,
	text: string,
): Promise<void> {
	const response = await fetch(
		`https://api.telegram.org/bot${token}/sendMessage`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				chat_id: chatId,
				text,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Telegram sendMessage failed: ${error}`);
	}
}

function formatBytes(bytes?: number): string {
	if (bytes === undefined) {
		return "Unknown";
	}

	if (bytes < 1024) {
		return `${bytes} B`;
	}

	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}

	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isEpub(document: TelegramDocument): boolean {
	const fileName = document.file_name?.toLowerCase() ?? "";
	const mimeType = document.mime_type?.toLowerCase() ?? "";

	return (
		fileName.endsWith(".epub") ||
		mimeType === "application/epub+zip"
	);
}

function sanitizeFileName(fileName: string): string {
	return fileName
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
		.trim();
}

async function getTelegramFilePath(
	token: string,
	fileId: string,
): Promise<string> {
	const response = await fetch(
		`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
	);

	if (!response.ok) {
		throw new Error(
			`Telegram getFile failed with HTTP ${response.status}`,
		);
	}

	const data = (await response.json()) as TelegramFileResponse;

	if (!data.ok || !data.result?.file_path) {
		throw new Error(
			`Telegram getFile failed: ${data.description ?? "Unknown error"}`,
		);
	}

	return data.result.file_path;
}

async function downloadTelegramFile(
	token: string,
	filePath: string,
): Promise<Response> {
	const response = await fetch(
		`https://api.telegram.org/file/bot${token}/${filePath}`,
	);

	if (!response.ok) {
		throw new Error(
			`Telegram file download failed with HTTP ${response.status}`,
		);
	}

	return response;
}

async function saveEpubToR2(
	env: Env,
	document: TelegramDocument,
): Promise<string> {
	const filePath = await getTelegramFilePath(
		env.TELEGRAM_BOT_TOKEN,
		document.file_id,
	);

	const downloadResponse = await downloadTelegramFile(
		env.TELEGRAM_BOT_TOKEN,
		filePath,
	);

	const originalFileName =
		document.file_name ?? `${document.file_unique_id}.epub`;

	const safeFileName = sanitizeFileName(originalFileName);

	const r2Key = `books/${safeFileName}`;

	await env.EREADER_BUCKET.put(
		r2Key,
		downloadResponse.body,
		{
			httpMetadata: {
				contentType:
					document.mime_type ?? "application/epub+zip",
			},
			customMetadata: {
				telegramFileId: document.file_id,
				telegramFileUniqueId: document.file_unique_id,
				originalFileName,
			},
		},
	);

	return r2Key;
}

async function listBooks(env: Env): Promise<Response> {
	const result = await env.EREADER_BUCKET.list({
		prefix: "books/",
	});

	const books = result.objects
		.filter((object) => object.key.toLowerCase().endsWith(".epub"))
		.map((object) => ({
			name: object.key.replace(/^books\//, ""),
			key: object.key,
			size: object.size,
			uploaded: object.uploaded.toISOString(),
		}));

	return Response.json({
		count: books.length,
		books,
	});
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function isLibraryAuthorized(url: URL, env: Env): boolean {
	const token = url.searchParams.get("token");

	return token === env.LIBRARY_TOKEN;
}

async function generateOpdsFeed(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);

	if (!isLibraryAuthorized(url, env)) {
		return new Response("Unauthorized", {
			status: 401,
		});
	}

	const result = await env.EREADER_BUCKET.list({
		prefix: "books/",
	});

	const books = result.objects.filter((object) =>
		object.key.toLowerCase().endsWith(".epub"),
	);

	const latestUpdated =
		books.length > 0
			? books
					.reduce((latest, book) =>
						book.uploaded > latest.uploaded
							? book
							: latest,
					)
					.uploaded.toISOString()
			: new Date().toISOString();

	const entries = books
		.map((book) => {
			const fileName = book.key.replace(/^books\//, "");

			const downloadUrl =
				`${url.origin}/download` +
				`?key=${encodeURIComponent(book.key)}` +
				`&token=${encodeURIComponent(env.LIBRARY_TOKEN)}`;

			return `
	<entry>
		<title>${escapeXml(fileName.replace(/\.epub$/i, ""))}</title>

		<id>urn:ereader:${escapeXml(book.key)}</id>

		<updated>${book.uploaded.toISOString()}</updated>

		<content type="text">
			${escapeXml(fileName)}
		</content>

		<link
			rel="http://opds-spec.org/acquisition"
			href="${escapeXml(downloadUrl)}"
			type="application/epub+zip"
		/>
	</entry>`;
		})
		.join("\n");

	const selfUrl =
		`${url.origin}/opds` +
		`?token=${encodeURIComponent(env.LIBRARY_TOKEN)}`;

	const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed
	xmlns="http://www.w3.org/2005/Atom"
	xmlns:opds="http://opds-spec.org/2010/catalog"
>
	<title>Ereader Library</title>

	<id>urn:ereader:library</id>

	<updated>${latestUpdated}</updated>

	<link
		rel="self"
		href="${escapeXml(selfUrl)}"
		type="application/atom+xml;profile=opds-catalog;kind=acquisition"
	/>

	<author>
		<name>Ereader Sync</name>
	</author>

${entries}

</feed>`;

	return new Response(feed, {
		headers: {
			"Content-Type":
				"application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

async function downloadBook(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);

	if (!isLibraryAuthorized(url, env)) {
		return new Response("Unauthorized", {
			status: 401,
		});
	}

	const key = url.searchParams.get("key");

	if (!key || !key.startsWith("books/")) {
		return new Response("Invalid book", {
			status: 400,
		});
	}

	const object = await env.EREADER_BUCKET.get(key);

	if (!object) {
		return new Response("Book not found", {
			status: 404,
		});
	}

	const fileName = key.replace(/^books\//, "");

	const headers = new Headers();

	object.writeHttpMetadata(headers);

	headers.set(
		"Content-Type",
		"application/epub+zip",
	);

	headers.set(
		"Content-Disposition",
		`attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
	);

	headers.set("ETag", object.httpEtag);

	return new Response(object.body, {
		headers,
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(
				"Ereader Telegram Sync is running",
			);
		}

		if (request.method === "GET" && url.pathname === "/books") {
			return listBooks(env);
		}

		if (request.method === "GET" && url.pathname === "/opds") {
			return generateOpdsFeed(request, env);
		}

		if (request.method === "GET" && url.pathname === "/download") {
			return downloadBook(request, env);
		}

		if (
			request.method === "POST" &&
			url.pathname === "/telegram"
		) {
			const update =
				(await request.json()) as TelegramUpdate;

			const message = update.message;

			if (!message) {
				return new Response("OK");
			}

			const chatId = message.chat.id;
			const userId = message.from?.id;
			const text = message.text ?? "";

			if (text === "/id") {
				await sendTelegramMessage(
					env.TELEGRAM_BOT_TOKEN,
					chatId,
					`Tu Telegram User ID es:\n${userId ?? "No disponible"}`,
				);

				return new Response("OK");
			}

			if (
				env.TELEGRAM_ALLOWED_USER_ID &&
				String(userId) !==
					env.TELEGRAM_ALLOWED_USER_ID
			) {
				console.log(
					`Unauthorized Telegram user: ${userId}`,
				);

				return new Response("OK");
			}

			if (text === "/start") {
				await sendTelegramMessage(
					env.TELEGRAM_BOT_TOKEN,
					chatId,
					[
						"📚 Ereader Sync",
						"",
						"Mándame un EPUB y lo guardaré en tu biblioteca.",
					].join("\n"),
				);

				return new Response("OK");
			}

			if (message.document) {
				const document = message.document;

				if (!isEpub(document)) {
					await sendTelegramMessage(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						[
							"❌ Ese archivo no parece ser un EPUB.",
							"",
							`Archivo: ${
								document.file_name ??
								"Sin nombre"
							}`,
						].join("\n"),
					);

					return new Response("OK");
				}

				if (
					document.file_size &&
					document.file_size >
						20 * 1024 * 1024
				) {
					await sendTelegramMessage(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						[
							"❌ El EPUB es demasiado grande.",
							"",
							`Tamaño: ${formatBytes(
								document.file_size,
							)}`,
							"",
							"Telegram permite al bot descargar archivos de hasta 20 MB.",
						].join("\n"),
					);

					return new Response("OK");
				}

				try {
					await sendTelegramMessage(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						`☁️ Guardando ${document.file_name ?? "EPUB"}...`,
					);

					const r2Key = await saveEpubToR2(
						env,
						document,
					);

					await sendTelegramMessage(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						[
							"📚 EPUB guardado",
							"",
							`Archivo: ${
								document.file_name ??
								"Sin nombre"
							}`,
							`Tamaño: ${formatBytes(
								document.file_size,
							)}`,
							"",
							`☁️ ${r2Key}`,
							"",
							"✅ Ya está en tu biblioteca.",
						].join("\n"),
					);
				} catch (error) {
					console.error(error);

					await sendTelegramMessage(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						[
							"❌ No he podido guardar el EPUB.",
							"",
							error instanceof Error
								? error.message
								: "Error desconocido",
						].join("\n"),
					);
				}

				return new Response("OK");
			}

			await sendTelegramMessage(
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				"Envíame un archivo .epub 📚",
			);

			return new Response("OK");
		}

		return new Response("Not found", {
			status: 404,
		});
	},
};