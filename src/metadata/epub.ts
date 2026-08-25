import {
	strFromU8,
	strToU8,
	unzipSync,
	zipSync,
	type Zippable,
} from "fflate";

import {
	cleanText,
	isMeaningful,
	normalizeIsbn,
} from "./normalize";

import {
	resolveMetadata,
} from "./resolver";

import type {
	BookMetadata,
	MetadataResolverOptions,
	ResolvedMetadata,
} from "./types";

export interface RepairedEpub {
	bytes: Uint8Array;

	resolved:
		ResolvedMetadata;
}

function decodeXml(
	value: string,
): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

function encodeXml(
	value: string,
): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function findOpfPath(
	files:
		Record<string, Uint8Array>,
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

	const match =
		xml.match(
			/<rootfile\b[^>]*full-path=["']([^"']+)["']/i,
		);

	if (!match?.[1]) {
		throw new Error(
			"Invalid EPUB: package document not found",
		);
	}

	const path =
		decodeXml(match[1]);

	if (!files[path]) {
		throw new Error(
			`Invalid EPUB: ${path} is missing`,
		);
	}

	return path;
}

function extractElement(
	xml: string,
	tag: string,
): string | undefined {
	const match =
		xml.match(
			new RegExp(
				`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
				"i",
			),
		);

	return cleanText(
		match?.[1],
	);
}

function extractAllElements(
	xml: string,
	tag: string,
): string[] {
	const values:
		string[] = [];

	const regex =
		new RegExp(
			`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
			"gi",
		);

	let match:
		| RegExpExecArray
		| null;

	while (
		(match = regex.exec(xml))
	) {
		const value =
			cleanText(match[1]);

		if (value) {
			values.push(value);
		}
	}

	return values;
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

	const patterns = [
		new RegExp(
			`<meta\\b[^>]*name=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*\\/?>`,
			"i",
		),

		new RegExp(
			`<meta\\b[^>]*content=["']([^"']*)["'][^>]*name=["']${escaped}["'][^>]*\\/?>`,
			"i",
		),
	];

	for (const pattern of patterns) {
		const match =
			xml.match(pattern);

		if (match?.[1]) {
			return cleanText(
				match[1],
			);
		}
	}

	return undefined;
}

function extractEpub3Series(
	xml: string,
): {
	series?: string;
	index?: string;
} {
	const collection =
		xml.match(
			/<meta\b(?=[^>]*property=["']belongs-to-collection["'])(?=[^>]*id=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/meta>/i,
		);

	if (!collection) {
		return {};
	}

	const id =
		collection[1];

	const series =
		cleanText(
			collection[2],
		);

	if (!series) {
		return {};
	}

	const escaped =
		id.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);

	const position =
		xml.match(
			new RegExp(
				`<meta\\b(?=[^>]*refines=["']#${escaped}["'])(?=[^>]*property=["']group-position["'])[^>]*>([\\s\\S]*?)<\\/meta>`,
				"i",
			),
		);

	return {
		series,

		index:
			cleanText(
				position?.[1],
			),
	};
}

function findIsbn(
	xml: string,
): string | undefined {
	for (
		const identifier
		of extractAllElements(
			xml,
			"dc:identifier",
		)
	) {
		const isbn =
			normalizeIsbn(
				identifier,
			);

		if (isbn) {
			return isbn;
		}
	}

	return undefined;
}

function readExistingMetadata(
	opf: string,
): BookMetadata {
	const epub3Series =
		extractEpub3Series(opf);

	return {
		title:
			extractElement(
				opf,
				"dc:title",
			),

		author:
			extractElement(
				opf,
				"dc:creator",
			),

		description:
			extractElement(
				opf,
				"dc:description",
			),

		language:
			extractElement(
				opf,
				"dc:language",
			),

		isbn:
			findIsbn(opf),

		publisher:
			extractElement(
				opf,
				"dc:publisher",
			),

		published:
			extractElement(
				opf,
				"dc:date",
			),

		series:
			epub3Series.series ??
			extractMetaContent(
				opf,
				"calibre:series",
			),

		seriesIndex:
			epub3Series.index ??
			extractMetaContent(
				opf,
				"calibre:series_index",
			),

		subjects:
			extractAllElements(
				opf,
				"dc:subject",
			),
	};
}

function insertMetadata(
	opf: string,
	xml: string,
): string {
	const index =
		opf.search(
			/<\/metadata\s*>/i,
		);

	if (index === -1) {
		throw new Error(
			"EPUB OPF metadata section is missing",
		);
	}

	return (
		opf.slice(0, index) +
		"\n" +
		xml +
		"\n" +
		opf.slice(index)
	);
}

function setElement(
	opf: string,
	tag: string,
	value?: string,
): string {
	if (!value) {
		return opf;
	}

	const regex =
		new RegExp(
			`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`,
			"i",
		);

	const xml =
		`<${tag}>${encodeXml(value)}</${tag}>`;

	if (regex.test(opf)) {
		return opf.replace(
			regex,
			xml,
		);
	}

	return insertMetadata(
		opf,
		xml,
	);
}

function removeElements(
	opf: string,
	tag: string,
): string {
	return opf.replace(
		new RegExp(
			`\\s*<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`,
			"gi",
		),
		"",
	);
}

function removeCalibreSeries(
	opf: string,
): string {
	return opf
		.replace(
			/\s*<meta\b[^>]*name=["']calibre:series["'][^>]*\/?>/gi,
			"",
		)
		.replace(
			/\s*<meta\b[^>]*name=["']calibre:series_index["'][^>]*\/?>/gi,
			"",
		);
}

function setSubjects(
	opf: string,
	subjects?: string[],
): string {
	if (!subjects?.length) {
		return opf;
	}

	let result =
		removeElements(
			opf,
			"dc:subject",
		);

	const xml =
		subjects
			.slice(0, 12)
			.map(
				(subject) =>
					`<dc:subject>${encodeXml(subject)}</dc:subject>`,
			)
			.join("\n");

	return insertMetadata(
		result,
		xml,
	);
}

function setSeries(
	opf: string,
	series?: string,
	index?: string,
): string {
	if (!series) {
		return opf;
	}

	let result =
		removeCalibreSeries(
			opf,
		);

	const lines = [
		`<meta name="calibre:series" content="${encodeXml(series)}" />`,
	];

	if (index) {
		lines.push(
			`<meta name="calibre:series_index" content="${encodeXml(index)}" />`,
		);
	}

	return insertMetadata(
		result,
		lines.join("\n"),
	);
}

function setIsbn(
	opf: string,
	isbn?: string,
): string {
	if (!isbn) {
		return opf;
	}

	if (
		findIsbn(opf) === isbn
	) {
		return opf;
	}

	return insertMetadata(
		opf,
		`<dc:identifier id="ereader-sync-isbn">${encodeXml(isbn)}</dc:identifier>`,
	);
}

function setPageCount(
	opf: string,
	pageCount?: number,
): string {
	if (!pageCount) {
		return opf;
	}

	let result =
		opf.replace(
			/\s*<meta\b[^>]*name=["']ereader-sync:page_count["'][^>]*\/?>/gi,
			"",
		);

	return insertMetadata(
		result,
		`<meta name="ereader-sync:page_count" content="${pageCount}" />`,
	);
}

function rewriteMetadata(
	opf: string,
	metadata: BookMetadata,
): string {
	let result = opf;

	if (
		isMeaningful(
			metadata.title,
		)
	) {
		result =
			setElement(
				result,
				"dc:title",
				metadata.title,
			);
	}

	if (
		isMeaningful(
			metadata.author,
		)
	) {
		result =
			setElement(
				result,
				"dc:creator",
				metadata.author,
			);
	}

	if (metadata.description) {
		result =
			setElement(
				result,
				"dc:description",
				metadata.description,
			);
	}

	if (metadata.language) {
		result =
			setElement(
				result,
				"dc:language",
				metadata.language,
			);
	}

	if (metadata.publisher) {
		result =
			setElement(
				result,
				"dc:publisher",
				metadata.publisher,
			);
	}

	if (metadata.published) {
		result =
			setElement(
				result,
				"dc:date",
				metadata.published,
			);
	}

	result =
		setIsbn(
			result,
			metadata.isbn,
		);

	result =
		setSeries(
			result,
			metadata.series,
			metadata.seriesIndex,
		);

	result =
		setSubjects(
			result,
			metadata.subjects,
		);

	result =
		setPageCount(
			result,
			metadata.pageCount,
		);

	return result;
}

function rebuildEpub(
	files:
		Record<string, Uint8Array>,
): Uint8Array {
	const output:
		Zippable = {};

	/*
	 * EPUB requirement:
	 * mimetype first and uncompressed.
	 */
	output.mimetype = [
		strToU8(
			"application/epub+zip",
		),
		{
			level: 0,
		},
	];

	for (
		const [name, bytes]
		of Object.entries(files)
	) {
		if (
			name === "mimetype"
		) {
			continue;
		}

		output[name] = [
			bytes,
			{
				level: 6,
			},
		];
	}

	return zipSync(output);
}

export async function repairEpub(
	originalBytes: Uint8Array,
	originalFileName: string,
	options:
		MetadataResolverOptions,
): Promise<RepairedEpub> {
	let files:
		Record<
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
			"The uploaded file is not a valid EPUB",
		);
	}

	const opfPath =
		findOpfPath(
			files,
		);

	const originalOpf =
		strFromU8(
			files[opfPath],
		);

	const existing =
		readExistingMetadata(
			originalOpf,
		);

	const resolved =
		await resolveMetadata(
			existing,
			originalFileName,
			options,
		);

	const rewritten =
		rewriteMetadata(
			originalOpf,
			resolved.metadata,
		);

	files[opfPath] =
		strToU8(
			rewritten,
		);

	return {
		bytes:
			rebuildEpub(
				files,
			),

		resolved,
	};
}