import type {
	Env,
} from "./env";

import {
	repairEpub,
} from "./metadata/epub";

import type {
	BookMetadata,
	MetadataSource,
	ResolvedMetadata,
} from "./metadata/types";

export interface StoredEpubResult {
	key: string;
	fileName: string;
	size: number;
	metadata: BookMetadata;
	resolved: ResolvedMetadata;
	message: string;
}

export function safeFileName(
	fileName: string,
): string {
	const clean = fileName
		.replace(/[\\/\0]/g, "_")
		.replace(/[\u0001-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	const base = clean || "book.epub";

	return base.toLowerCase().endsWith(".epub")
		? base
		: `${base}.epub`;
}

function formatSourceList(
	resolved: ResolvedMetadata,
): string | undefined {
	const bestBySource = new Map<
		MetadataSource,
		number
	>();

	for (const match of resolved.matches) {
		const previous =
			bestBySource.get(
				match.source,
			) ?? 0;

		if (match.score > previous) {
			bestBySource.set(
				match.source,
				match.score,
			);
		}
	}

	const order: MetadataSource[] = [
		"lectulandia",
		"google-books",
		"open-library",
	];

	const values = order
		.filter((source) =>
			bestBySource.has(source),
		)
		.map(
			(source) =>
				`${source} (${bestBySource.get(source)}%)`,
		);

	return values.length
		? values.join(", ")
		: undefined;
}

function formatDateAndPages(
	metadata: BookMetadata,
): string | undefined {
	const parts: string[] = [];

	if (metadata.published) {
		parts.push(metadata.published);
	}

	if (metadata.pageCount) {
		parts.push(
			`${metadata.pageCount} páginas`,
		);
	}

	return parts.length
		? parts.join(" · ")
		: undefined;
}

function formatTelegramMessage(
	key: string,
	metadata: BookMetadata,
	resolved: ResolvedMetadata,
): string {
	const lines: string[] = [
		"📚 EPUB preparado",
		"",
		metadata.title ?? "Título desconocido",
		metadata.author ?? "Autor desconocido",
	];

	if (metadata.series) {
		lines.push(
			"",
			`📖 Serie: ${metadata.series}${
				metadata.seriesIndex
					? ` #${metadata.seriesIndex}`
					: ""
			}`,
		);
	}

	const dateAndPages =
		formatDateAndPages(metadata);

	if (dateAndPages) {
		lines.push(
			`📅 ${dateAndPages}`,
		);
	}

	if (metadata.subjects?.length) {
		lines.push(
			`🏷️ ${metadata.subjects.join(" · ")}`,
		);
	}

	if (metadata.isbn) {
		lines.push(
			`ISBN: ${metadata.isbn}`,
		);
	}

	if (metadata.publisher) {
		lines.push(
			`Editorial: ${metadata.publisher}`,
		);
	}

	if (resolved.repairedFields.length) {
		lines.push(
			"",
			`🔧 Actualizado: ${resolved.repairedFields.join(", ")}`,
		);
	}

	const sources =
		formatSourceList(resolved);

	if (sources) {
		lines.push(
			`🔎 Fuentes: ${sources}`,
		);
	}

	const warnings = [
		...resolved.warnings,
	];

	const hasGoogle =
		resolved.matches.some(
			(match) =>
				match.source ===
				"google-books",
		);

	if (!hasGoogle) {
		warnings.push(
			"Google Books returned no confident match",
		);
	}

	if (warnings.length) {
		lines.push("");

		for (const warning of [
			...new Set(warnings),
		]) {
			lines.push(`⚠️ ${warning}`);
		}
	}

	lines.push(
		"",
		`☁️ ${key}`,
		"",
		"✅ Listo para sincronizar.",
	);

	return lines.join("\n");
}

function metadataSourcesForR2(
	resolved: ResolvedMetadata,
): string {
	return Object.entries(
		resolved.sources,
	)
		.map(
			([field, source]) =>
				`${field}:${source}`,
		)
		.join(",");
}

export async function prepareAndStoreEpub(
	env: Env,
	originalBytes: Uint8Array,
	originalFileName: string,
): Promise<StoredEpubResult> {
	const fileName =
		safeFileName(
			originalFileName,
		);

	const repaired = await repairEpub(
		originalBytes,
		fileName,
		{
			googleBooksApiKey:
				env.GOOGLE_BOOKS_API_KEY,
			lectulandiaBaseUrl:
				env.LECTULANDIA_BASE_URL,
		},
	);

	const metadata =
		repaired.resolved.metadata;

	const key = `books/${fileName}`;

	const customMetadata: Record<
		string,
		string
	> = {
		metadataRepaired:
			repaired.resolved.repairedFields.length
				? "true"
				: "false",
		metadataSources:
			metadataSourcesForR2(
				repaired.resolved,
			),
	};

	const compactFields: Array<
		[keyof BookMetadata, string]
	> = [
		["title", "title"],
		["author", "author"],
		["language", "language"],
		["isbn", "isbn"],
		["publisher", "publisher"],
		["published", "published"],
		["series", "series"],
		["seriesIndex", "seriesIndex"],
	];

	for (const [field, name] of compactFields) {
		const value = metadata[field];
		if (
			typeof value === "string" &&
			value
		) {
			customMetadata[name] =
				value.slice(0, 500);
		}
	}

	if (metadata.pageCount) {
		customMetadata.pageCount =
			String(metadata.pageCount);
	}

	if (metadata.description) {
		customMetadata.descriptionPreview =
			metadata.description.slice(0, 300);
	}

	await env.EREADER_BUCKET.put(
		key,
		repaired.bytes,
		{
			httpMetadata: {
				contentType:
					"application/epub+zip",
				contentDisposition:
					`attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
			},
			customMetadata,
		},
	);

	return {
		key,
		fileName,
		size: repaired.bytes.byteLength,
		metadata,
		resolved: repaired.resolved,
		message: formatTelegramMessage(
			key,
			metadata,
			repaired.resolved,
		),
	};
}
