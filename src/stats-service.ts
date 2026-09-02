import type {
	Env,
} from "./env";

const KINDLE_STATS_KEY =
	"stats/kindle/snapshot.json";
const MAX_SNAPSHOT_BYTES =
	1024 * 1024;
const MAX_SESSION_DETAILS_PER_DAY =
	512;

export interface KindleStatsSessionDetail {
	start_time: number;
	end_time: number;
	reading_seconds: number;
	morning_seconds: number;
	afternoon_seconds: number;
	night_seconds: number;
}

export interface KindleStatsDay {
	book: string;
	title?: string;
	author?: string;
	date: string;
	reading_seconds: number;
	sessions: number;
	morning_seconds?: number;
	afternoon_seconds?: number;
	night_seconds?: number;
	session_details?: KindleStatsSessionDetail[];
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

function cleanOptionalInteger(
	value: unknown,
	field: string,
): number {
	if (value === undefined || value === null) {
		return 0;
	}
	return cleanInteger(value, field);
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

function normalizeSessionDetails(
	value: unknown,
	field: string,
): KindleStatsSessionDetail[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(
			`${field} must be an array`,
		);
	}
	if (value.length > MAX_SESSION_DETAILS_PER_DAY) {
		throw new Error(
			`${field} has too many entries`,
		);
	}

	const grouped =
		new Map<number, KindleStatsSessionDetail>();

	for (let index = 0; index < value.length; index += 1) {
		const raw = value[index];
		if (!isPlainObject(raw)) {
			throw new Error(
				`${field}[${index}] must be an object`,
			);
		}

		const startTime = cleanInteger(
			raw.start_time,
			`${field}[${index}].start_time`,
		);
		const endTime = cleanInteger(
			raw.end_time,
			`${field}[${index}].end_time`,
		);
		const readingSeconds = cleanInteger(
			raw.reading_seconds,
			`${field}[${index}].reading_seconds`,
		);
		const morningSeconds = cleanOptionalInteger(
			raw.morning_seconds,
			`${field}[${index}].morning_seconds`,
		);
		const afternoonSeconds = cleanOptionalInteger(
			raw.afternoon_seconds,
			`${field}[${index}].afternoon_seconds`,
		);
		const nightSeconds = cleanOptionalInteger(
			raw.night_seconds,
			`${field}[${index}].night_seconds`,
		);

		if (startTime === 0 || endTime < startTime || readingSeconds === 0) {
			throw new Error(
				`${field}[${index}] has invalid session timing`,
			);
		}

		const next: KindleStatsSessionDetail = {
			start_time: startTime,
			end_time: endTime,
			reading_seconds: readingSeconds,
			morning_seconds: morningSeconds,
			afternoon_seconds: afternoonSeconds,
			night_seconds: nightSeconds,
		};

		const current = grouped.get(startTime);
		if (!current || next.reading_seconds >= current.reading_seconds) {
			grouped.set(startTime, next);
		}
	}

	return Array.from(grouped.values())
		.sort((a, b) => a.start_time - b.start_time);
}

function mergeSessionDetails(
	left: KindleStatsSessionDetail[] | undefined,
	right: KindleStatsSessionDetail[],
): KindleStatsSessionDetail[] | undefined {
	if ((!left || left.length === 0) && right.length === 0) {
		return undefined;
	}
	const grouped =
		new Map<number, KindleStatsSessionDetail>();
	for (const detail of left ?? []) {
		grouped.set(detail.start_time, detail);
	}
	for (const detail of right) {
		const current = grouped.get(detail.start_time);
		if (!current || detail.reading_seconds >= current.reading_seconds) {
			grouped.set(detail.start_time, detail);
		}
	}
	return Array.from(grouped.values())
		.sort((a, b) => a.start_time - b.start_time)
		.slice(-MAX_SESSION_DETAILS_PER_DAY);
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
		new Map<string, KindleStatsDay>();

	for (
		let index = 0;
		index < value.days.length;
		index += 1
	) {
		const raw = value.days[index];

		if (!isPlainObject(raw)) {
			throw new Error(
				`days[${index}] must be an object`,
			);
		}

		const book = cleanRequiredString(
			raw.book,
			`days[${index}].book`,
		);
		const date = cleanDate(raw.date);
		const readingSeconds = cleanInteger(
			raw.reading_seconds,
			`days[${index}].reading_seconds`,
		);
		const sessions = cleanInteger(
			raw.sessions,
			`days[${index}].sessions`,
		);
		const morningSeconds = cleanOptionalInteger(
			raw.morning_seconds,
			`days[${index}].morning_seconds`,
		);
		const afternoonSeconds = cleanOptionalInteger(
			raw.afternoon_seconds,
			`days[${index}].afternoon_seconds`,
		);
		const nightSeconds = cleanOptionalInteger(
			raw.night_seconds,
			`days[${index}].night_seconds`,
		);
		const sessionDetails = normalizeSessionDetails(
			raw.session_details,
			`days[${index}].session_details`,
		);

		const title = cleanOptionalString(raw.title);
		const author = cleanOptionalString(raw.author);
		const key = `${book}\u0000${date}`;
		const current = grouped.get(key);

		if (!current) {
			grouped.set(
				key,
				{
					book,
					...(title ? { title } : {}),
					...(author ? { author } : {}),
					date,
					reading_seconds: readingSeconds,
					sessions,
					...(morningSeconds > 0 ? { morning_seconds: morningSeconds } : {}),
					...(afternoonSeconds > 0 ? { afternoon_seconds: afternoonSeconds } : {}),
					...(nightSeconds > 0 ? { night_seconds: nightSeconds } : {}),
					...(sessionDetails.length > 0 ? { session_details: sessionDetails } : {}),
				},
			);
			continue;
		}

		/* Cumulative values: duplicates keep the highest value, never sum. */
		current.reading_seconds = Math.max(current.reading_seconds, readingSeconds);
		current.sessions = Math.max(current.sessions, sessions);

		const mergedMorning = Math.max(current.morning_seconds ?? 0, morningSeconds);
		const mergedAfternoon = Math.max(current.afternoon_seconds ?? 0, afternoonSeconds);
		const mergedNight = Math.max(current.night_seconds ?? 0, nightSeconds);
		if (mergedMorning > 0) current.morning_seconds = mergedMorning;
		else delete current.morning_seconds;
		if (mergedAfternoon > 0) current.afternoon_seconds = mergedAfternoon;
		else delete current.afternoon_seconds;
		if (mergedNight > 0) current.night_seconds = mergedNight;
		else delete current.night_seconds;

		const mergedDetails = mergeSessionDetails(current.session_details, sessionDetails);
		if (mergedDetails) current.session_details = mergedDetails;
		else delete current.session_details;

		if (!current.title && title) current.title = title;
		if (!current.author && author) current.author = author;
	}

	const generatedAt =
		typeof value.generated_at === "string" &&
		!Number.isNaN(Date.parse(value.generated_at))
			? new Date(value.generated_at).toISOString()
			: new Date().toISOString();

	return {
		schema_version: 1,
		device: "kindle",
		generated_at: generatedAt,
		days: Array.from(grouped.values())
			.sort((a, b) => {
				const dateOrder = a.date.localeCompare(b.date);
				return dateOrder !== 0 ? dateOrder : a.book.localeCompare(b.book);
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
					"Cache-Control": "no-store",
				},
			},
		);
	}

	const headers = new Headers({
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});

	if (object.etag) {
		headers.set(
			"ETag",
			object.httpEtag ?? `"${object.etag}"`,
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
	const contentLength = Number(
		request.headers.get("Content-Length") ?? "0",
	);

	if (Number.isFinite(contentLength) && contentLength > MAX_SNAPSHOT_BYTES) {
		return new Response(
			"Snapshot too large",
			{ status: 413 },
		);
	}

	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_SNAPSHOT_BYTES) {
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

	let snapshot: KindleStatsSnapshot;
	try {
		snapshot = normalizeSnapshot(parsed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json(
			{ ok: false, error: message },
			{ status: 400 },
		);
	}

	const serialized = JSON.stringify(snapshot);
	await env.EREADER_BUCKET.put(
		KINDLE_STATS_KEY,
		serialized,
		{
			httpMetadata: {
				contentType: "application/json; charset=utf-8",
			},
			customMetadata: {
				kind: "kindle-reading-stats-snapshot",
				schemaVersion: "1",
				generatedAt: snapshot.generated_at,
				records: String(snapshot.days.length),
			},
		},
	);

	return Response.json(
		{
			ok: true,
			key: KINDLE_STATS_KEY,
			generated_at: snapshot.generated_at,
			records: snapshot.days.length,
		},
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}

export async function handleStatsRoute(
	request: Request,
	env: Env,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== "/stats/kindle") {
		return undefined;
	}

	if (!authorized(request, env)) {
		return unauthorized();
	}

	if (request.method === "GET") {
		return getKindleStats(env);
	}

	if (request.method === "PUT" || request.method === "POST") {
		return putKindleStats(request, env);
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
