import {
	strFromU8,
	strToU8,
	unzipSync,
	zipSync,
	type Zippable,
} from "fflate";

export interface EpubMetadata {
	title?: string;
	author?: string;
	description?: string;
	language?: string;
	isbn?: string;
	publisher?: string;
	published?: string;
	series?: string;
	seriesIndex?: string;
}

export interface EpubRepairResult {
	bytes: Uint8Array;
	metadata: EpubMetadata;
	repairedFields: string[];
	warnings: string[];
	source?: string;
}

interface OpenLibrarySearchResponse {
	docs?: OpenLibrarySearchDocument[];
}

interface OpenLibrarySearchDocument {
	key?: string;
	title?: string;
	author_name?: string[];
	first_publish_year?: number;
	isbn?: string[];
	publisher?: string[];
	language?: string[];
	series?: string[];
}

interface OpenLibraryWork {
	description?:
		| string
		| {
				value?: string;
		  };
}

const OPEN_LIBRARY_HEADERS = {
	Accept: "application/json",
	"User-Agent":
		"EreaderTelegramSync/0.2 personal-library",
};

const BAD_VALUES = new Set([
	"",
	"unknown",
	"unknown author",
	"unknown title",
	"untitled",
	"no title",
	"no author",
	"desconocido",
	"desconocida",
	"autor desconocido",
	"autora desconocida",
	"sin autor",
	"sin autora",
	"sin titulo",
	"sin título",
	"n/a",
	"none",
	"null",
]);

function decodeXml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

function encodeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function cleanText(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const cleaned = decodeXml(
		value
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);

	return cleaned || undefined;
}

function normalizeForComparison(
	value?: string,
): string {
	return (value ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\b(vol(?:umen)?|book|libro)\.?\s*/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function isMeaningful(
	value?: string,
): boolean {
	if (!value) {
		return false;
	}

	return !BAD_VALUES.has(
		normalizeForComparison(value),
	);
}

function extractElement(
	xml: string,
	tag: string,
): string | undefined {
	const regex = new RegExp(
		`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
		"i",
	);

	return cleanText(
		xml.match(regex)?.[1],
	);
}

function normalizeIsbn(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const cleaned = value
		.toUpperCase()
		.replace(/[^0-9X]/g, "");

	if (
		cleaned.length === 10 ||
		cleaned.length === 13
	) {
		return cleaned;
	}

	return undefined;
}

function findIsbn(
	xml: string,
): string | undefined {
	const regex =
		/<dc:identifier\b[^>]*>([\s\S]*?)<\/dc:identifier>/gi;

	let match: RegExpExecArray | null;

	while ((match = regex.exec(xml))) {
		const isbn = normalizeIsbn(
			cleanText(match[1]),
		);

		if (isbn) {
			return isbn;
		}
	}

	return undefined;
}

function extractMetaContent(
	xml: string,
	name: string,
): string | undefined {
	const escaped =
		name.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);

	const regex1 = new RegExp(
		`<meta\\b[^>]*name=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*\\/?>`,
		"i",
	);

	const regex2 = new RegExp(
		`<meta\\b[^>]*content=["']([^"']*)["'][^>]*name=["']${escaped}["'][^>]*\\/?>`,
		"i",
	);

	return cleanText(
		xml.match(regex1)?.[1] ??
			xml.match(regex2)?.[1],
	);
}

function extractExistingMetadata(
	opf: string,
): EpubMetadata {
	return {
		title: extractElement(
			opf,
			"dc:title",
		),

		author: extractElement(
			opf,
			"dc:creator",
		),

		description: extractElement(
			opf,
			"dc:description",
		),

		language: extractElement(
			opf,
			"dc:language",
		),

		isbn: findIsbn(opf),

		publisher: extractElement(
			opf,
			"dc:publisher",
		),

		published: extractElement(
			opf,
			"dc:date",
		),

		series: extractMetaContent(
			opf,
			"calibre:series",
		),

		seriesIndex: extractMetaContent(
			opf,
			"calibre:series_index",
		),
	};
}

function inferFromFileName(
	fileName: string,
): {
	title?: string;
	author?: string;
} {
	const base = fileName
		.replace(/\.epub$/i, "")
		.replace(/_/g, " ")
		.trim();

	const parts = base
		.split(/\s+-\s+/)
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length >= 2) {
		return {
			title: parts
				.slice(
					0,
					parts.length - 1,
				)
				.join(" - "),

			author:
				parts[
					parts.length - 1
				],
		};
	}

	return {
		title:
			isMeaningful(base)
				? base
				: undefined,
	};
}

function wordSimilarity(
	a?: string,
	b?: string,
): number {
	const left =
		normalizeForComparison(a);

	const right =
		normalizeForComparison(b);

	if (!left || !right) {
		return 0;
	}

	if (left === right) {
		return 1;
	}

	const leftWords =
		new Set(left.split(" "));

	const rightWords =
		new Set(right.split(" "));

	let intersection = 0;

	for (const word of leftWords) {
		if (
			word.length > 1 &&
			rightWords.has(word)
		) {
			intersection++;
		}
	}

	const union =
		new Set([
			...leftWords,
			...rightWords,
		]).size;

	if (union === 0) {
		return 0;
	}

	return intersection / union;
}

function authorMatches(
	expected?: string,
	actual?: string,
): boolean {
	const left =
		normalizeForComparison(expected);

	const right =
		normalizeForComparison(actual);

	if (!left || !right) {
		return false;
	}

	if (
		left === right ||
		left.includes(right) ||
		right.includes(left)
	) {
		return true;
	}

	const leftParts =
		left.split(" ");

	const rightParts =
		right.split(" ");

	return (
		leftParts[
			leftParts.length - 1
		] ===
		rightParts[
			rightParts.length - 1
		]
	);
}

function scoreDocument(
	document: OpenLibrarySearchDocument,
	title?: string,
	author?: string,
): number {
	let score = 0;

	const titleScore =
		wordSimilarity(
			title,
			document.title,
		);

	score += titleScore * 10;

	if (
		author &&
		document.author_name?.some(
			(candidate) =>
				authorMatches(
					author,
					candidate,
				),
		)
	) {
		score += 8;
	}

	return score;
}

async function searchOpenLibrary(
	title?: string,
	author?: string,
	isbn?: string,
): Promise<OpenLibrarySearchDocument | undefined> {
	const params =
		new URLSearchParams();

	if (isbn) {
		params.set("isbn", isbn);
	} else {
		if (!title) {
			return undefined;
		}

		params.set(
			"title",
			title,
		);

		if (author) {
			params.set(
				"author",
				author,
			);
		}
	}

	params.set(
		"fields",
		[
			"key",
			"title",
			"author_name",
			"first_publish_year",
			"isbn",
			"publisher",
			"language",
			"series",
		].join(","),
	);

	params.set(
		"limit",
		"10",
	);

	const response = await fetch(
		`https://openlibrary.org/search.json?${params.toString()}`,
		{
			headers:
				OPEN_LIBRARY_HEADERS,
		},
	);

	if (!response.ok) {
		return undefined;
	}

	const data =
		(await response.json()) as OpenLibrarySearchResponse;

	const docs = data.docs ?? [];

	if (docs.length === 0) {
		return undefined;
	}

	if (isbn) {
		return docs[0];
	}

	let best:
		| OpenLibrarySearchDocument
		| undefined;

	let bestScore = 0;

	for (const document of docs) {
		const score =
			scoreDocument(
				document,
				title,
				author,
			);

		if (score > bestScore) {
			bestScore = score;
			best = document;
		}
	}

	/*
	 * Exact-ish title = 10.
	 * Matching author = +8.
	 *
	 * Requiring 11 prevents a vague
	 * title-only match from being accepted.
	 */
	if (bestScore < 11) {
		return undefined;
	}

	return best;
}

async function getWorkDescription(
	key?: string,
): Promise<string | undefined> {
	if (!key) {
		return undefined;
	}

	const workId = key
		.replace(
			/^\/works\//,
			"",
		);

	if (
		!/^OL\d+W$/i.test(workId)
	) {
		return undefined;
	}

	const response = await fetch(
		`https://openlibrary.org/works/${encodeURIComponent(workId)}.json`,
		{
			headers:
				OPEN_LIBRARY_HEADERS,
		},
	);

	if (!response.ok) {
		return undefined;
	}

	const work =
		(await response.json()) as OpenLibraryWork;

	if (
		typeof work.description ===
		"string"
	) {
		return cleanText(
			work.description,
		);
	}

	return cleanText(
		work.description?.value,
	);
}

function mapLanguage(
	language?: string,
): string | undefined {
	if (!language) {
		return undefined;
	}

	const map: Record<
		string,
		string
	> = {
		spa: "es",
		eng: "en",
		fra: "fr",
		fre: "fr",
		deu: "de",
		ger: "de",
		ita: "it",
		por: "pt",
		cat: "ca",
	};

	return (
		map[
			language.toLowerCase()
		] ??
		language
	);
}

function parseSeries(
	value?: string,
): {
	name?: string;
	index?: string;
} {
	if (!value) {
		return {};
	}

	const patterns = [
		/^(.*?)\s*#\s*(\d+(?:\.\d+)?)$/i,

		/^(.*?)\s*\(\s*(?:book|libro)\s+(\d+(?:\.\d+)?)\s*\)$/i,

		/^(.*?)\s*,\s*(\d+(?:\.\d+)?)$/i,
	];

	for (
		const pattern of patterns
	) {
		const match =
			value.match(pattern);

		if (match) {
			return {
				name:
					match[1].trim(),

				index:
					match[2],
			};
		}
	}

	return {
		name:
			value.trim(),
	};
}

async function lookupMetadata(
	existing: EpubMetadata,
	fileInfo: {
		title?: string;
		author?: string;
	},
): Promise<EpubMetadata | undefined> {
	/*
	 * 1. ISBN is strongest.
	 */
	if (existing.isbn) {
		const isbnResult =
			await searchOpenLibrary(
				undefined,
				undefined,
				existing.isbn,
			);

		if (isbnResult) {
			return documentToMetadata(
				isbnResult,
			);
		}
	}

	/*
	 * 2. Filename is deliberately
	 * preferred over dubious embedded
	 * metadata.
	 *
	 * Example:
	 * El Reino ... - Kerri Maniscalco.epub
	 */
	if (
		fileInfo.title &&
		fileInfo.author
	) {
		const filenameResult =
			await searchOpenLibrary(
				fileInfo.title,
				fileInfo.author,
			);

		if (filenameResult) {
			return documentToMetadata(
				filenameResult,
			);
		}
	}

	/*
	 * 3. Embedded metadata only when
	 * it is actually meaningful.
	 */
	if (
		isMeaningful(
			existing.title,
		) &&
		isMeaningful(
			existing.author,
		)
	) {
		const embeddedResult =
			await searchOpenLibrary(
				existing.title,
				existing.author,
			);

		if (embeddedResult) {
			return documentToMetadata(
				embeddedResult,
			);
		}
	}

	return undefined;
}

async function documentToMetadata(
	document: OpenLibrarySearchDocument,
): Promise<EpubMetadata> {
	const description =
		await getWorkDescription(
			document.key,
		);

	const series =
		parseSeries(
			document.series?.[0],
		);

	const isbn13 =
		document.isbn
			?.map(normalizeIsbn)
			.find(
				(value) =>
					value?.length ===
					13,
			);

	const anyIsbn =
		document.isbn
			?.map(normalizeIsbn)
			.find(Boolean);

	return {
		title:
			cleanText(
				document.title,
			),

		author:
			cleanText(
				document
					.author_name?.[0],
			),

		description,

		language:
			mapLanguage(
				document
					.language?.[0],
			),

		isbn:
			isbn13 ??
			anyIsbn,

		publisher:
			cleanText(
				document
					.publisher?.[0],
			),

		published:
			document
				.first_publish_year
				? String(
						document
							.first_publish_year,
					)
				: undefined,

		series:
			series.name,

		seriesIndex:
			series.index,
	};
}

function findOpfPath(
	files: Record<
		string,
		Uint8Array
	>,
): string {
	const container =
		files[
			"META-INF/container.xml"
		];

	if (!container) {
		throw new Error(
			"Invalid EPUB: META-INF/container.xml is missing",
		);
	}

	const xml =
		strFromU8(container);

	const match = xml.match(
		/<rootfile\b[^>]*full-path=["']([^"']+)["']/i,
	);

	if (!match?.[1]) {
		throw new Error(
			"Invalid EPUB: package document not found",
		);
	}

	const path =
		decodeXml(
			match[1],
		);

	if (!files[path]) {
		throw new Error(
			`Invalid EPUB: missing ${path}`,
		);
	}

	return path;
}

function replaceElement(
	xml: string,
	tag: string,
	value: string,
): string {
	const regex =
		new RegExp(
			`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`,
			"i",
		);

	const replacement =
		`<${tag}>${encodeXml(value)}</${tag}>`;

	if (regex.test(xml)) {
		return xml.replace(
			regex,
			replacement,
		);
	}

	return insertMetadata(
		xml,
		replacement,
	);
}

function insertMetadata(
	opf: string,
	value: string,
): string {
	const index =
		opf.search(
			/<\/metadata\s*>/i,
		);

	if (index === -1) {
		throw new Error(
			"OPF metadata section not found",
		);
	}

	return (
		opf.slice(0, index) +
		"\n" +
		value +
		"\n" +
		opf.slice(index)
	);
}

function addIdentifier(
	opf: string,
	isbn: string,
): string {
	return insertMetadata(
		opf,
		`<dc:identifier id="ereader-sync-isbn">${encodeXml(isbn)}</dc:identifier>`,
	);
}

function addSeries(
	opf: string,
	series: string,
	index?: string,
): string {
	let metadata =
		`<meta name="calibre:series" content="${encodeXml(series)}" />`;

	if (index) {
		metadata +=
			`\n<meta name="calibre:series_index" content="${encodeXml(index)}" />`;
	}

	return insertMetadata(
		opf,
		metadata,
	);
}

function repairOpf(
	opf: string,
	existing: EpubMetadata,
	final: EpubMetadata,
	forceTitleAuthor: boolean,
): {
	opf: string;
	repairedFields: string[];
} {
	let result = opf;

	const repairedFields:
		string[] = [];

	if (
		final.title &&
		(
			!isMeaningful(
				existing.title,
			) ||
			forceTitleAuthor
		)
	) {
		if (
			normalizeForComparison(
				existing.title,
			) !==
			normalizeForComparison(
				final.title,
			)
		) {
			result =
				replaceElement(
					result,
					"dc:title",
					final.title,
				);

			repairedFields.push(
				"title",
			);
		}
	}

	if (
		final.author &&
		(
			!isMeaningful(
				existing.author,
			) ||
			forceTitleAuthor
		)
	) {
		if (
			normalizeForComparison(
				existing.author,
			) !==
			normalizeForComparison(
				final.author,
			)
		) {
			result =
				replaceElement(
					result,
					"dc:creator",
					final.author,
				);

			repairedFields.push(
				"author",
			);
		}
	}

	const simpleFields: Array<{
		key:
			| "description"
			| "language"
			| "publisher"
			| "published";
		tag: string;
	}> = [
		{
			key: "description",
			tag: "dc:description",
		},
		{
			key: "language",
			tag: "dc:language",
		},
		{
			key: "publisher",
			tag: "dc:publisher",
		},
		{
			key: "published",
			tag: "dc:date",
		},
	];

	for (
		const field of simpleFields
	) {
		if (
			!isMeaningful(
				existing[field.key],
			) &&
			final[field.key]
		) {
			result =
				replaceElement(
					result,
					field.tag,
					final[
						field.key
					]!,
				);

			repairedFields.push(
				field.key,
			);
		}
	}

	if (
		!existing.isbn &&
		final.isbn
	) {
		result =
			addIdentifier(
				result,
				final.isbn,
			);

		repairedFields.push(
			"isbn",
		);
	}

	if (
		!existing.series &&
		final.series
	) {
		result =
			addSeries(
				result,
				final.series,
				final.seriesIndex,
			);

		repairedFields.push(
			"series",
		);

		if (
			final.seriesIndex
		) {
			repairedFields.push(
				"seriesIndex",
			);
		}
	}

	return {
		opf: result,
		repairedFields,
	};
}

function rebuildEpub(
	files: Record<
		string,
		Uint8Array
	>,
): Uint8Array {
	const output:
		Zippable = {};

	output.mimetype = [
		strToU8(
			"application/epub+zip",
		),
		{
			level: 0,
		},
	];

	for (
		const [name, data]
		of Object.entries(files)
	) {
		if (
			name === "mimetype"
		) {
			continue;
		}

		output[name] = [
			data,
			{
				level: 6,
			},
		];
	}

	return zipSync(output);
}

export async function repairEpubMetadata(
	originalBytes: Uint8Array,
	originalFileName: string,
): Promise<EpubRepairResult> {
	let files: Record<
		string,
		Uint8Array
	>;

	try {
		files =
			unzipSync(
				originalBytes,
			);
	} catch {
		throw new Error(
			"Uploaded file is not a valid EPUB",
		);
	}

	const opfPath =
		findOpfPath(files);

	const originalOpf =
		strFromU8(
			files[opfPath],
		);

	const existing =
		extractExistingMetadata(
			originalOpf,
		);

	const fileInfo =
		inferFromFileName(
			originalFileName,
		);

	const external =
		await lookupMetadata(
			existing,
			fileInfo,
		);

	/*
	 * If the EPUB says its author
	 * is "Desconocido" but the
	 * filename gives us an author
	 * and Open Library confirms it,
	 * treat embedded title+author
	 * as untrusted.
	 */
	const embeddedIdentityBroken =
		!isMeaningful(
			existing.author,
		) ||
		!isMeaningful(
			existing.title,
		);

	const finalMetadata:
		EpubMetadata = {
			title:
				external?.title ??
				(
					isMeaningful(
						existing.title,
					)
						? existing.title
						: fileInfo.title
				),

			author:
				external?.author ??
				(
					isMeaningful(
						existing.author,
					)
						? existing.author
						: fileInfo.author
				),

			description:
				isMeaningful(
					existing.description,
				)
					? existing.description
					: external
							?.description,

			language:
				isMeaningful(
					existing.language,
				)
					? existing.language
					: external
							?.language,

			isbn:
				existing.isbn ??
				external?.isbn,

			publisher:
				isMeaningful(
					existing.publisher,
				)
					? existing.publisher
					: external
							?.publisher,

			published:
				isMeaningful(
					existing.published,
				)
					? existing.published
					: external
							?.published,

			series:
				isMeaningful(
					existing.series,
				)
					? existing.series
					: external
							?.series,

			seriesIndex:
				isMeaningful(
					existing.seriesIndex,
				)
					? existing.seriesIndex
					: external
							?.seriesIndex,
		};

	const repair =
		repairOpf(
			originalOpf,
			existing,
			finalMetadata,
			embeddedIdentityBroken &&
				!!external,
		);

	files[opfPath] =
		strToU8(
			repair.opf,
		);

	const warnings:
		string[] = [];

	if (!external) {
		warnings.push(
			"No confident Open Library match was found",
		);
	}

	if (
		!finalMetadata.description
	) {
		warnings.push(
			"Description is still missing",
		);
	}

	if (!finalMetadata.author) {
		warnings.push(
			"Author is still missing",
		);
	}

	if (!finalMetadata.title) {
		warnings.push(
			"Title is still missing",
		);
	}

	return {
		bytes:
			rebuildEpub(
				files,
			),

		metadata:
			finalMetadata,

		repairedFields:
			repair.repairedFields,

		warnings,

		source:
			external
				? "Open Library"
				: undefined,
	};
}