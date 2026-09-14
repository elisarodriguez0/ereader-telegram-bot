import type {
	Env,
} from "./env";

import {
	repairEpub,
} from "./metadata/epub";

import {
	optimizeEpubForXteink,
} from "./epub-optimizer";

import {
	isMeaningful,
	parseStructuredSeriesTitle,
} from "./metadata/normalize";

import type {
	BookMetadata,
	MetadataSource,
	ResolvedMetadata,
} from "./metadata/types";

export interface StoredEpubResult {
	key: string;
	xteinkKey: string;
	fileName: string;
	size: number;
	xteinkSize: number;
	metadata: BookMetadata;
	resolved: ResolvedMetadata;
	message: string;
}

const MAX_CANONICAL_BASENAME_LENGTH = 180;

/**
 * Sanitize a filename component to be compatible with FAT/exFAT, Kindle,
 * KOReader, and CrossInk. Preserves accents, apostrophes, and Unicode text.
 */
function sanitizeFilePart(
	value: string,
): string {
	return value
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[\\/:*?"<>|]/g, " - ")
		.replace(/\s+-\s+-\s+/g, " - ")
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/g, "")
		.trim();
}

function truncateUnicode(
	value: string,
	maxLength: number,
): string {
	const chars = Array.from(value);

	if (chars.length <= maxLength) {
		return value;
	}

	return chars
		.slice(0, maxLength)
		.join("")
		.trim()
		.replace(/[. -]+$/g, "");
}

/**
 * Strip retailer edition labels from book titles while keeping genuine
 * subtitles and series information intact. Only removes explicit trailing
 * markers such as "(Standard Edition)" or "[Kindle Edition]".
 */
function stripTrailingEditionLabel(
	value: string,
): string {
	return value
		.replace(
			/\s*[([]\s*(?:(?:standard|special|deluxe|collector(?:'s)?|collectors?|international|anniversary|movie\s+tie[- ]?in|illustrated|limited|signed)\s+)?edition\s*[)\]]\s*$/i,
			"",
		)
		.replace(
			/\s*[([]\s*(?:(?:edici[oó]n)\s+(?:est[aá]ndar|especial|de\s+lujo|coleccionista|ilustrada|limitada))\s*[)\]]\s*$/i,
			"",
		)
		.trim();
}

function canonicalTitle(
	metadata: BookMetadata,
): string | undefined {
	if (!isMeaningful(metadata.title)) {
		return undefined;
	}

	const structured =
		parseStructuredSeriesTitle(
			metadata.title,
		);

	const rawTitle =
		structured?.title ??
		metadata.title!;

	const cleaned =
		sanitizeFilePart(
			stripTrailingEditionLabel(
				rawTitle,
			),
		);

	return cleaned || undefined;
}

function canonicalAuthor(
	metadata: BookMetadata,
): string | undefined {
	if (!isMeaningful(metadata.author)) {
		return undefined;
	}

	const cleaned =
		sanitizeFilePart(
			metadata.author!,
		);

	return cleaned || undefined;
}

function fallbackBaseName(
	originalFileName: string,
): string {
	const withoutExtension =
		originalFileName
			.replace(/\.epub$/i, "")
			.trim();

	return (
		sanitizeFilePart(
			withoutExtension,
		) ||
		"book"
	);
}

/**
 * Build a canonical EPUB filename from metadata and original filename.
 * Enforces conservative limits for cross-device compatibility (Kindle, X4).
 */
export function buildCanonicalEpubFileName(
	metadata: BookMetadata,
	originalFileName: string,
): {
	fileName: string;
	syncTitle: string;
	syncAuthor?: string;
} {
	const title =
		canonicalTitle(metadata) ??
		fallbackBaseName(
			originalFileName,
		);

	const author =
		canonicalAuthor(metadata);

	const authorSuffix =
		author
			? ` - ${author}`
			: "";

	/* Keep filename length conservative and consistent across devices. */
	const maxTitleLength =
		Math.max(
			30,
			MAX_CANONICAL_BASENAME_LENGTH -
				Array.from(authorSuffix).length,
		);

	const syncTitle =
		truncateUnicode(
			title,
			maxTitleLength,
		);

	const basename =
		`${syncTitle}${authorSuffix}`;

	return {
		fileName:
			`${basename}.epub`,
		syncTitle,
		syncAuthor:
			author,
	};
}

/**
 * Fallback filename generator for cases where metadata repair has not occurred.
 * Used as a metadata search hint before determining real title/author.
 */
export function safeFileName(
	fileName: string,
): string {
	/* Use light-touch sanitization to preserve punctuation for search hints. */
	const clean = fileName
		.replace(/[\\/\0]/g, "_")
		.replace(/[\u0001-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	const base =
		clean ||
		"book.epub";

	return base
		.toLowerCase()
		.endsWith(".epub")
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
	xteinkKey: string,
	metadata: BookMetadata,
	resolved: ResolvedMetadata,
	optimization: {
		originalSize: number;
		optimizedSize: number;
		optimizedImages: number;
		skippedImages: number;
		svgFixes: number;
	},
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

	const sizeMb = (value: number) =>
		`${(value / (1024 * 1024)).toFixed(2)} MB`;

	lines.push(
		"",
		`☁️ Kindle: ${key}`,
		`⚙️ X4: ${xteinkKey}`,
		`🖼️ X4: ${optimization.optimizedImages} imágenes optimizadas` +
			(optimization.skippedImages
				? ` · ${optimization.skippedImages} conservadas`
				: "") +
			(optimization.svgFixes
				? ` · ${optimization.svgFixes} SVG corregidos`
				: ""),
		`📦 X4: ${sizeMb(optimization.originalSize)} → ${sizeMb(optimization.optimizedSize)}`,
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
	/*
	 * The original filename is used only as a metadata hint.
	 * We do NOT decide the final R2/Kindle/X4 filename until repairEpub()
	 * has finished and we know the best title/author available.
	 */
	const inputFileName =
		safeFileName(
			originalFileName,
		);

	const repaired = await repairEpub(
		originalBytes,
		inputFileName,
		{
			googleBooksApiKey:
				env.GOOGLE_BOOKS_API_KEY,
			lectulandiaBaseUrl:
				env.LECTULANDIA_BASE_URL,
		},
	);

	const metadata =
		repaired.resolved.metadata;

	const canonical =
		buildCanonicalEpubFileName(
			metadata,
			originalFileName,
		);

	const fileName =
		canonical.fileName;

	const key =
		`books/${fileName}`;

	const xteinkKey =
		`books_xteink/${fileName}`;

	const xteinkOptimization =
		await optimizeEpubForXteink(
			env,
			repaired.bytes,
		);

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

		/*
		 * OPDS uses these two fields so CrossInk's "Title - Author"
		 * filename option produces the same basename as the Kindle plugin.
		 */
		syncTitle:
			canonical.syncTitle,
		originalFileName:
			originalFileName.slice(0, 500),
	};

	if (canonical.syncAuthor) {
		customMetadata.syncAuthor =
			canonical.syncAuthor;
	}

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

	const commonHttpMetadata = {
		contentType:
			"application/epub+zip",
		contentDisposition:
			`attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
	};

	await Promise.all([
		env.EREADER_BUCKET.put(
			key,
			repaired.bytes,
			{
				httpMetadata:
					commonHttpMetadata,
				customMetadata: {
					...customMetadata,
					variant:
						"original-repaired",
				},
			},
		),
		env.EREADER_BUCKET.put(
			xteinkKey,
			xteinkOptimization.bytes,
			{
				httpMetadata:
					commonHttpMetadata,
				customMetadata: {
					...customMetadata,
					variant:
						"xteink-optimized",
					optimizedImages:
						String(
							xteinkOptimization.optimizedImages,
						),
					skippedImages:
						String(
							xteinkOptimization.skippedImages,
						),
					svgFixes:
						String(
							xteinkOptimization.svgFixes,
						),
					sourceSize:
						String(
							xteinkOptimization.originalSize,
						),
				},
			},
		),
	]);

	return {
		key,
		xteinkKey,
		fileName,
		size: repaired.bytes.byteLength,
		xteinkSize:
			xteinkOptimization.optimizedSize,
		metadata,
		resolved: repaired.resolved,
		message: formatTelegramMessage(
			key,
			xteinkKey,
			metadata,
			repaired.resolved,
			xteinkOptimization,
		),
	};
}
