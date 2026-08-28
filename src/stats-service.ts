import type {
	Env,
} from "./env";

const KINDLE_STATS_KEY =
	"stats/kindle/snapshot.json";
const MAX_SNAPSHOT_BYTES =
	1024 * 1024;

export interface KindleStatsDay {
	book: string;
	title?: string;
	author?: string;
	date: string;
	reading_seconds: number;
	sessions: number;
}

export interface KindleStatsSnapshot {
	schema_version: 1;
	device: "kindle";
	generated_at: string;
	days: KindleStatsDay[];
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

function emptySnapshot(): KindleStatsSnapshot {
	return {
		schema_version: 1,
		device: "kindle",
		generated_at:
			new Date(0).toISOString(),
		days: [],
	};
}

function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value)
	);
}

function cleanOptionalString(
	value: unknown,
): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const cleaned = value.trim();
	return cleaned || undefined;
}

function cleanRequiredString(
	value: unknown,
	field: string,
): string {
	const cleaned =
		cleanOptionalString(value);

	if (!cleaned) {
		throw new Error(
			`${field} must be a non-empty string`,
		);
	}

	if (cleaned.length > 512) {
		throw new Error(
			`${field} is too long`,
		);
	}

	return cleaned;
}

function cleanInteger(
	value: unknown,
	field: string,
): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0
	) {
		throw new Error(
			`${field} must be a non-negative number`,
		);
	}

	return Math.floor(value);
}

function cleanDate(
	value: unknown,
): string {
	const date =
		cleanRequiredString(
			value,
			"date",
		);

	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(
			date,
		)
	) {
		throw new Error(
			"date must use YYYY-MM-DD",
		);
	}

	const parsed = new Date(
		`${date}T00:00:00Z`,
	);

	if (
		Number.isNaN(
			parsed.getTime(),
		) ||
		parsed.toISOString()
			.slice(0, 10) !== date
	) {
		throw new Error(
			`invalid date: ${date}`,
		);
	}

	return date;
}

function normalizeSnapshot(
	value: unknown,
): KindleStatsSnapshot {
	if (!isPlainObject(value)) {
		throw new Error(
			"snapshot must be a JSON object",
		);
	}

	if (value.schema_version !== 1) {
		throw new Error(
			"unsupported schema_version",
		);
	}

	if (value.device !== "kindle") {
		throw new Error(
			'device must be "kindle"',
		);
	}

	if (!Array.isArray(value.days)) {
		throw new Error(
			"days must be an array",
		);
	}

	if (value.days.length > 20000) {
		throw new Error(
			"too many day records",
		);
	}

	const grouped =
		new Map<
			string,
			KindleStatsDay
		>();

	for (
		let index = 0;
		index < value.days.length;
		index += 1
	) {
		const raw =
			value.days[index];

		if (!isPlainObject(raw)) {
			throw new Error(
				`days[${index}] must be an object`,
			);
		}

		const book =
			cleanRequiredString(
				raw.book,
				`days[${index}].book`,
			);
		const date =
			cleanDate(raw.date);
		const readingSeconds =
			cleanInteger(
				raw.reading_seconds,
				`days[${index}].reading_seconds`,
			);
		const sessions =
			cleanInteger(
				raw.sessions,
				`days[${index}].sessions`,
			);

		const title =
			cleanOptionalString(
				raw.title,
			);
		const author =
			cleanOptionalString(
				raw.author,
			);

		const key =
			`${book}\u0000${date}`;

		const current =
			grouped.get(key);

		if (!current) {
			grouped.set(
				key,
				{
					book,
					...(title
						? { title }
						: {}),
					...(author
						? { author }
						: {}),
					date,
					reading_seconds:
						readingSeconds,
					sessions,
				},
			);
			continue;
		}

		/*
		 * This is a cumulative snapshot. Duplicate book/day
		 * records should never add together at the Worker,
		 * because that could double-count a buggy upload.
		 * Keep the highest cumulative values instead.
		 */
		current.reading_seconds =
			Math.max(
				current.reading_seconds,
				readingSeconds,
			);
		current.sessions =
			Math.max(
				current.sessions,
				sessions,
			);

		if (!current.title && title) {
			current.title = title;
		}
		if (!current.author && author) {
			current.author = author;
		}
	}

	const generatedAt =
		typeof value.generated_at ===
			"string" &&
		!Number.isNaN(
			Date.parse(
				value.generated_at,
			),
		)
			? new Date(
					value.generated_at,
				).toISOString()
			: new Date().toISOString();

	return {
		schema_version: 1,
		device: "kindle",
		generated_at: generatedAt,
		days: Array.from(
			grouped.values(),
		).sort((a, b) => {
			const dateOrder =
				a.date.localeCompare(
					b.date,
				);
			if (dateOrder !== 0) {
				return dateOrder;
			}
			return a.book.localeCompare(
				b.book,
			);
		}),
	};
}

async function getKindleStats(
	env: Env,
): Promise<Response> {
	const object =
		await env.EREADER_BUCKET.get(
			KINDLE_STATS_KEY,
		);

	if (!object) {
		return Response.json(
			emptySnapshot(),
			{
				headers: {
					"Cache-Control":
						"no-store",
				},
			},
		);
	}

	const headers = new Headers({
		"Content-Type":
			"application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});

	if (object.etag) {
		headers.set(
			"ETag",
			object.httpEtag ??
				`"${object.etag}"`,
		);
	}

	return new Response(
		object.body,
		{ headers },
	);
}

async function putKindleStats(
	request: Request,
	env: Env,
): Promise<Response> {
	const contentLength =
		Number(
			request.headers.get(
				"Content-Length",
			) ?? "0",
		);

	if (
		Number.isFinite(
			contentLength,
		) &&
		contentLength >
			MAX_SNAPSHOT_BYTES
	) {
		return new Response(
			"Snapshot too large",
			{ status: 413 },
		);
	}

	const body =
		await request.text();

	if (
		new TextEncoder()
			.encode(body).byteLength >
		MAX_SNAPSHOT_BYTES
	) {
		return new Response(
			"Snapshot too large",
			{ status: 413 },
		);
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(body);
	} catch {
		return new Response(
			"Invalid JSON",
			{ status: 400 },
		);
	}

	let snapshot:
		KindleStatsSnapshot;

	try {
		snapshot =
			normalizeSnapshot(
				parsed,
			);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: String(error);

		return Response.json(
			{
				ok: false,
				error: message,
			},
			{ status: 400 },
		);
	}

	const serialized =
		JSON.stringify(snapshot);

	await env.EREADER_BUCKET.put(
		KINDLE_STATS_KEY,
		serialized,
		{
			httpMetadata: {
				contentType:
					"application/json; charset=utf-8",
			},
			customMetadata: {
				kind:
					"kindle-reading-stats-snapshot",
				schemaVersion: "1",
				generatedAt:
					snapshot.generated_at,
				records:
					String(
						snapshot.days
							.length,
					),
			},
		},
	);

	return Response.json(
		{
			ok: true,
			key: KINDLE_STATS_KEY,
			generated_at:
				snapshot.generated_at,
			records:
				snapshot.days.length,
		},
		{
			headers: {
				"Cache-Control":
					"no-store",
			},
		},
	);
}

export async function handleStatsRoute(
	request: Request,
	env: Env,
): Promise<Response | undefined> {
	const url =
		new URL(request.url);

	if (
		url.pathname !==
		"/stats/kindle"
	) {
		return undefined;
	}

	if (!authorized(request, env)) {
		return unauthorized();
	}

	if (request.method === "GET") {
		return getKindleStats(env);
	}

	if (
		request.method === "PUT" ||
		request.method === "POST"
	) {
		return putKindleStats(
			request,
			env,
		);
	}

	return new Response(
		"Method not allowed",
		{
			status: 405,
			headers: {
				Allow: "GET, PUT, POST",
			},
		},
	);
}
