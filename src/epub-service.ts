import type {
	Env,
} from "./env";

import {
	repairEpub,
} from "./metadata/epub";

import {
	optimizeEpubWithEpubKit,
} from "./epubkit";

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

function sanitizeFilePart(
	value: string,
): string {
	return value
		.replace(
			/[\u0000-\u001f\u007f]/g,
			"",
		)
		.replace(
			/[\\/:*?"<>|]/g,
			" - ",
		)
		.replace(
			/\s+-\s+-\s+/g,
			" - ",
		)
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/g, "")
		.trim();
}

function truncateUnicode(
	value: string,
	maxLength: number,
): string {
	const chars =
		Array.from(value);

	if (
		chars.length <=
			maxLength
	) {
		return value;
	}

	return chars
		.slice(
			0,
			maxLength,
		)
		.join("")
		.trim()
		.replace(
			/[. -]+$/g,
			"",
		);
}

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
	if (
		!isMeaningful(
			metadata.title,
		)
	) {
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

	return cleaned ||
		undefined;
}

function canonicalAuthor(
	metadata: BookMetadata,
): string | undefined {
	if (
		!isMeaningful(
			metadata.author,
		)
	) {
		return undefined;
	}

	const cleaned =
		sanitizeFilePart(
			metadata.author!,
		);

	return cleaned ||
		undefined;
}

function fallbackBaseName(
	originalFileName: string,
): string {
	const withoutExtension =
		originalFileName
			.replace(
				/\.epub$/i,
				"",
			)
			.trim();

	return (
		sanitizeFilePart(
			withoutExtension,
		) ||
		"book"
	);
}

export function buildCanonicalEpubFileName(
	metadata: BookMetadata,
	originalFileName: string,
): {
	fileName: string;
	syncTitle: string;
	syncAuthor?: string;
} {
	const title =
		canonicalTitle(
			metadata,
		) ??
		fallbackBaseName(
			originalFileName,
		);

	const author =
		canonicalAuthor(
			metadata,
		);

	const authorSuffix =
		author
			? ` - ${author}`
			: "";

	const maxTitleLength =
		Math.max(
			30,
			MAX_CANONICAL_BASENAME_LENGTH -
				Array.from(
					authorSuffix,
				).length,
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

export function safeFileName(
	fileName: string,
): string {
	const clean =
		fileName
			.replace(
				/[\\/\0]/g,
				"_",
			)
			.replace(
				/[\u0001-\u001f\u007f]/g,
				"",
			)
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
	const bestBySource =
		new Map<
			MetadataSource,
			number
		>();

	for (
		const match
		of resolved.matches
	) {
		const previous =
			bestBySource.get(
				match.source,
			) ?? 0;

		if (
			match.score >
				previous
		) {
			bestBySource.set(
				match.source,
				match.score,
			);
		}
	}

	const order:
		MetadataSource[] = [
			"goodreads",
			"lectulandia",
			"google-books",
			"open-library",
		];

	const values =
		order
			.filter(
				(source) =>
					bestBySource.has(
						source,
					),
			)
			.map(
				(source) =>
					`${source} (${bestBySource.get(source)}%)`,
			);

	return values.length
		? values.join(", ")
		: undefined;
}

function formatTelegramMessage(
	metadata: BookMetadata,
	resolved: ResolvedMetadata,
	optimization: {
		originalSize: number;
		optimizedSize: number;
		optimizedImages: number;
		totalImages: number;
		svgFixes: number;
	},
): string {
	const lines:
		string[] = [
			"📚 EPUB preparado",
			"",
			metadata.title ??
				"Título desconocido",
			metadata.author ??
				"Autor desconocido",
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

	if (metadata.published) {
		lines.push(
			`📅 ${metadata.published}`,
		);
	}

	const displayedSubjects =
		metadata.subjects
			?.slice(
				0,
				12,
			);

	if (
		displayedSubjects
			?.length
	) {
		lines.push(
			`🏷️ ${displayedSubjects.join(" · ")}`,
		);
	}

	const sources =
		formatSourceList(
			resolved,
		);

	if (sources) {
		lines.push(
			"",
			`🔎 Fuentes: ${sources}`,
		);
	}

	const sizeMb =
		(value: number) =>
			`${(
				value /
				(1024 * 1024)
			).toFixed(2)} MB`;

	lines.push(
		"",
		`🖼️ X4: ${optimization.optimizedImages} imágenes optimizadas` +
			(
				optimization.svgFixes
					? ` · ${optimization.svgFixes} SVG corregidos`
					: ""
			),
		`📦 X4: ${sizeMb(optimization.originalSize)} → ${sizeMb(optimization.optimizedSize)}`,
		"",
		"✅ Listo para sincronizar.",
	);

	const message =
		lines.join("\n");

	/*
	 * Telegram accepts up to 4096 characters for message text.
	 * Subjects are already capped, but retain a final safety net.
	 */
	if (
		message.length <=
			4000
	) {
		return message;
	}

	return (
		`${message.slice(
			0,
			3940,
		)}\n\n✅ Listo para sincronizar.`
	);
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
	const inputFileName =
		safeFileName(
			originalFileName,
		);

	const repaired =
		await repairEpub(
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
		repaired.resolved
			.metadata;

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

	/*
	 * EPUBKit handles the X4 image/structure pass externally.
	 * The repaired EPUB stays untouched for Kindle.
	 */
	const xteinkOptimization =
		await optimizeEpubWithEpubKit(
			repaired.bytes,
			fileName,
		);

	const customMetadata:
		Record<
			string,
			string
		> = {
			metadataRepaired:
				repaired.resolved
					.repairedFields
					.length
					? "true"
					: "false",

			metadataSources:
				metadataSourcesForR2(
					repaired.resolved,
				),

			syncTitle:
				canonical.syncTitle,

			originalFileName:
				originalFileName.slice(
					0,
					500,
				),
		};

	if (
		canonical.syncAuthor
	) {
		customMetadata.syncAuthor =
			canonical.syncAuthor;
	}

	const compactFields:
		Array<
			[
				keyof BookMetadata,
				string,
			]
		> = [
			["title", "title"],
			["author", "author"],
			["language", "language"],
			["isbn", "isbn"],
			["publisher", "publisher"],
			["published", "published"],
			["series", "series"],
			[
				"seriesIndex",
				"seriesIndex",
			],
		];

	for (
		const [
			field,
			name,
		]
		of compactFields
	) {
		const value =
			metadata[field];

		if (
			typeof value ===
				"string" &&
			value
		) {
			customMetadata[name] =
				value.slice(
					0,
					500,
				);
		}
	}

	if (
		metadata.pageCount
	) {
		customMetadata.pageCount =
			String(
				metadata.pageCount,
			);
	}

	if (
		metadata.description
	) {
		customMetadata
			.descriptionPreview =
			metadata.description.slice(
				0,
				300,
			);
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
						"xteink-epubkit",

					optimizedImages:
						String(
							xteinkOptimization
								.optimizedImages,
						),

					totalImages:
						String(
							xteinkOptimization
								.totalImages,
						),

					svgFixes:
						String(
							xteinkOptimization
								.svgFixes,
						),

					sourceSize:
						String(
							xteinkOptimization
								.originalSize,
						),
				},
			},
		),
	]);

	return {
		key,
		xteinkKey,
		fileName,
		size:
			repaired.bytes
				.byteLength,

		xteinkSize:
			xteinkOptimization
				.optimizedSize,

		metadata,
		resolved:
			repaired.resolved,

		message:
			formatTelegramMessage(
				metadata,
				repaired.resolved,
				xteinkOptimization,
			),
	};
}
