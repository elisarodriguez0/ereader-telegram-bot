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
const IDENTITY_PREFIX = "_book_identity/sha256/";

interface ExistingBookIdentity {
	key: string;
	xteinkKey: string;
	fileName: string;
}

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
	updatedExisting = false,
): string {
	const lines:
		string[] = [
			updatedExisting
				? "📚 EPUB actualizado"
				: "📚 EPUB preparado",
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
		updatedExisting
			? "✅ Libro existente actualizado."
			: "✅ Listo para sincronizar.",
	);

	const message =
		lines.join("\n");

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
		)}\n\n${
			updatedExisting
				? "✅ Libro existente actualizado."
				: "✅ Listo para sincronizar."
		}`
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

async function sha256Hex(
	bytes: Uint8Array,
): Promise<string> {
	const copy = new Uint8Array(
		bytes.byteLength,
	);
	copy.set(bytes);

	const digest =
		await crypto.subtle.digest(
			"SHA-256",
			copy.buffer,
		);

	return Array.from(
		new Uint8Array(digest),
	)
		.map((byte) =>
			byte.toString(16).padStart(2, "0"),
		)
		.join("");
}

function normalizeOriginalFileName(
	value?: string,
): string {
	return (value ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function identityObjectKey(
	sourceHash: string,
): string {
	return `${IDENTITY_PREFIX}${sourceHash}.json`;
}

async function readIdentityIndex(
	env: Env,
	sourceHash: string,
): Promise<ExistingBookIdentity | undefined> {
	const object =
		await env.EREADER_BUCKET.get(
			identityObjectKey(
				sourceHash,
			),
		);

	if (!object) {
		return undefined;
	}

	try {
		const data =
			await object.json<
				ExistingBookIdentity
			>();

		if (
			data?.key &&
			data?.fileName
		) {
			return {
				key:
					data.key,
				xteinkKey:
					data.xteinkKey ||
					`books_xteink/${data.fileName}`,
				fileName:
					data.fileName,
			};
		}
	} catch (error) {
		console.warn(
			"[EPUB] invalid identity index:",
			error,
		);
	}

	return undefined;
}

async function listAllBookObjects(
	env: Env,
): Promise<any[]> {
	const objects: any[] = [];
	let cursor:
		string | undefined;

	do {
		const page =
			await env.EREADER_BUCKET.list({
				prefix:
					"books/",
				limit:
					1000,
				...(cursor
					? { cursor }
					: {}),
			});

		objects.push(
			...(page.objects ?? []),
		);

		cursor =
			page.truncated
				? page.cursor
				: undefined;
	} while (cursor);

	return objects.filter(
		(object) =>
			String(object.key)
				.toLowerCase()
				.endsWith(".epub"),
	);
}

function existingIdentityFromKey(
	key: string,
): ExistingBookIdentity {
	const fileName =
		key.replace(
			/^books\//,
			"",
		);

	return {
		key,
		xteinkKey:
			`books_xteink/${fileName}`,
		fileName,
	};
}

async function findExistingBook(
	env: Env,
	sourceHash: string,
	originalFileName: string,
	isbn?: string,
): Promise<ExistingBookIdentity | undefined> {
	const indexed =
		await readIdentityIndex(
			env,
			sourceHash,
		);

	if (indexed) {
		const current =
			await env.EREADER_BUCKET.head(
				indexed.key,
			);

		if (current) {
			return indexed;
		}
	}

	const normalizedOriginal =
		normalizeOriginalFileName(
			originalFileName,
		);

	const books =
		await listAllBookObjects(
			env,
		);

	for (const book of books) {
		const head =
			await env.EREADER_BUCKET.head(
				book.key,
			);

		if (!head) {
			continue;
		}

		const metadata =
			head.customMetadata ?? {};

		if (
			metadata.sourceHash ===
				sourceHash
		) {
			return existingIdentityFromKey(
				book.key,
			);
		}

		if (
			normalizedOriginal &&
			normalizeOriginalFileName(
				metadata.originalFileName,
			) ===
				normalizedOriginal
		) {
			return existingIdentityFromKey(
				book.key,
			);
		}

		if (
			isbn &&
			metadata.isbn &&
			metadata.isbn ===
				isbn
		) {
			return existingIdentityFromKey(
				book.key,
			);
		}
	}

	return undefined;
}

async function writeIdentityIndex(
	env: Env,
	sourceHash: string,
	identity: ExistingBookIdentity,
): Promise<void> {
	await env.EREADER_BUCKET.put(
		identityObjectKey(
			sourceHash,
		),
		JSON.stringify(
			identity,
		),
		{
			httpMetadata: {
				contentType:
					"application/json",
			},
			customMetadata: {
				sourceHash,
				bookKey:
					identity.key,
			},
		},
	);
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

	const sourceHash =
		await sha256Hex(
			originalBytes,
		);

	/*
	 * Fast path for exact re-uploads and migration path for older entries:
	 * - SHA-256 identity index when available
	 * - sourceHash custom metadata
	 * - same original Telegram filename
	 *
	 * ISBN matching is added after metadata resolution below.
	 */
	let existing =
		await findExistingBook(
			env,
			sourceHash,
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

	if (
		!existing &&
		metadata.isbn
	) {
		existing =
			await findExistingBook(
				env,
				sourceHash,
				originalFileName,
				metadata.isbn,
			);
	}

	const canonical =
		buildCanonicalEpubFileName(
			metadata,
			originalFileName,
		);

	const fileName =
		existing?.fileName ??
		canonical.fileName;

	const key =
		existing?.key ??
		`books/${fileName}`;

	const xteinkKey =
		existing?.xteinkKey ??
		`books_xteink/${fileName}`;

	const updatedExisting =
		!!existing;

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

			sourceHash,
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

	await writeIdentityIndex(
		env,
		sourceHash,
		{
			key,
			xteinkKey,
			fileName,
		},
	);

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
				updatedExisting,
			),
	};
}
