import {
	strFromU8,
	strToU8,
	unzipSync,
	zipSync,
} from "fflate";

import {
	cleanText,
	normalizeIsbn,
	normalizePublicationDate,
} from "./normalize";

import {
	resolveMetadata,
} from "./resolver";

import type {
	BookMetadata,
	MetadataResolverOptions,
	ResolvedMetadata,
} from "./types";

export interface EpubRepairResult {
	bytes: Uint8Array;
	originalMetadata: BookMetadata;
	resolved: ResolvedMetadata;
	opfPath: string;
}

function decodeXmlEntities(
	value: string,
): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");
}

function stripXml(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	return cleanText(
		decodeXmlEntities(
			value.replace(/<[^>]+>/g, " "),
		),
	);
}

function escapeXml(
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
	files: Record<string, Uint8Array>,
): string {
	const container =
		files["META-INF/container.xml"];

	if (container) {
		const xml = strFromU8(container);
		const match = xml.match(
			/<rootfile\b[^>]*\bfull-path=["']([^"']+)["'][^>]*>/i,
		);

		if (
			match?.[1] &&
			files[match[1]]
		) {
			return match[1];
		}
	}

	const fallback = Object.keys(files)
		.find((name) =>
			name.toLowerCase().endsWith(".opf"),
		);

	if (!fallback) {
		throw new Error(
			"Could not locate the EPUB OPF package document",
		);
	}

	return fallback;
}

function extractElement(
	xml: string,
	localName: string,
): string | undefined {
	const pattern = new RegExp(
		`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}>`,
		"i",
	);

	return stripXml(
		pattern.exec(xml)?.[1],
	);
}

function extractAllElements(
	xml: string,
	localName: string,
): string[] {
	const pattern = new RegExp(
		`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}>`,
		"gi",
	);

	const values: string[] = [];
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(xml))) {
		const value = stripXml(match[1]);
		if (value) {
			values.push(value);
		}
	}

	return values;
}

function extractMetaContentByName(
	xml: string,
	name: string,
): string | undefined {
	const tags = xml.match(/<meta\b[^>]*>/gi) ?? [];

	for (const tag of tags) {
		const nameMatch = tag.match(
			/\bname=["']([^"']+)["']/i,
		);

		if (
			nameMatch?.[1]?.toLowerCase() !==
			name.toLowerCase()
		) {
			continue;
		}

		const content = tag.match(
			/\bcontent=["']([^"']*)["']/i,
		)?.[1];

		return content
			? decodeXmlEntities(content).trim()
			: undefined;
	}

	return undefined;
}

function extractPropertyMeta(
	xml: string,
	property: string,
): string | undefined {
	const pattern = new RegExp(
		`<meta\\b(?=[^>]*\\bproperty=["']${property.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}["'])[^>]*>([\\s\\S]*?)<\\/meta>`,
		"i",
	);

	return stripXml(
		pattern.exec(xml)?.[1],
	);
}

function extractSeries(
	opf: string,
): {
	series?: string;
	seriesIndex?: string;
} {
	const calibreSeries =
		extractMetaContentByName(
			opf,
			"calibre:series",
		);

	const calibreIndex =
		extractMetaContentByName(
			opf,
			"calibre:series_index",
		);

	if (calibreSeries) {
		return {
			series: cleanText(calibreSeries),
			seriesIndex:
				cleanText(calibreIndex),
		};
	}

	const epubSeries =
		extractPropertyMeta(
			opf,
			"belongs-to-collection",
		);

	let epubIndex: string | undefined;

	const groupPosition = opf.match(
		/<meta\b(?=[^>]*\bproperty=["']group-position["'])[^>]*>([\s\S]*?)<\/meta>/i,
	)?.[1];

	if (groupPosition) {
		epubIndex = stripXml(groupPosition);
	}

	return {
		series: epubSeries,
		seriesIndex: epubIndex,
	};
}

export function readEpubMetadata(
	bytes: Uint8Array,
): {
	metadata: BookMetadata;
	opfPath: string;
} {
	const files = unzipSync(bytes);
	const opfPath = findOpfPath(files);
	const opf = strFromU8(files[opfPath]);

	const identifiers =
		extractAllElements(
			opf,
			"identifier",
		);

	const isbn = identifiers
		.map((value) => normalizeIsbn(value))
		.find((value): value is string => !!value);

	const series = extractSeries(opf);

	const pageCountRaw =
		extractMetaContentByName(
			opf,
			"ereader-sync:page_count",
		);

	const pageCountNumber =
		pageCountRaw
			? Number(pageCountRaw)
			: undefined;

	return {
		opfPath,
		metadata: {
			title: extractElement(opf, "title"),
			author: extractElement(opf, "creator"),
			description:
				extractElement(opf, "description"),
			language:
				extractElement(opf, "language"),
			isbn,
			publisher:
				extractElement(opf, "publisher"),
			published:
				normalizePublicationDate(
					extractElement(opf, "date"),
				),
			pageCount:
				pageCountNumber &&
				Number.isFinite(pageCountNumber) &&
				pageCountNumber > 0
					? pageCountNumber
					: undefined,
			series: series.series,
			seriesIndex:
				series.seriesIndex,
			subjects:
				extractAllElements(
					opf,
					"subject",
				),
		},
	};
}

function insertIntoMetadata(
	xml: string,
	fragment: string,
): string {
	const close = xml.search(
		/<\/(?:[\w.-]+:)?metadata\s*>/i,
	);

	if (close < 0) {
		throw new Error(
			"EPUB OPF does not contain a metadata section",
		);
	}

	return (
		xml.slice(0, close) +
		"\n    " +
		fragment +
		"\n" +
		xml.slice(close)
	);
}

function setElement(
	xml: string,
	localName: string,
	value?: string,
): string {
	if (!value) {
		return xml;
	}

	const escaped = escapeXml(value);
	const pattern = new RegExp(
		`<((?:[\\w.-]+:)?${localName})\\b([^>]*)>[\\s\\S]*?<\\/\\1>`,
		"i",
	);

	if (pattern.test(xml)) {
		return xml.replace(
			pattern,
			(_full, tagName: string, attrs: string) =>
				`<${tagName}${attrs}>${escaped}</${tagName}>`,
		);
	}

	return insertIntoMetadata(
		xml,
		`<dc:${localName}>${escaped}</dc:${localName}>`,
	);
}

function setNamedMeta(
	xml: string,
	name: string,
	value?: string,
): string {
	if (!value) {
		return xml;
	}

	const escapedName = name.replace(
		/[.*+?^${}()|[\]\\]/g,
		"\\$&",
	);
	const pattern = new RegExp(
		`<meta\\b(?=[^>]*\\bname=["']${escapedName}["'])[^>]*(?:\\/?>)`,
		"i",
	);

	const replacement =
		`<meta name="${escapeXml(name)}" content="${escapeXml(value)}" />`;

	if (pattern.test(xml)) {
		return xml.replace(
			pattern,
			replacement,
		);
	}

	return insertIntoMetadata(
		xml,
		replacement,
	);
}

function setIsbn(
	xml: string,
	isbn?: string,
): string {
	const normalized = normalizeIsbn(isbn);

	if (!normalized) {
		return xml;
	}

	const pattern = /<((?:[\w.-]+:)?identifier)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(xml))) {
		if (!normalizeIsbn(stripXml(match[3]))) {
			continue;
		}

		const replacement =
			`<${match[1]}${match[2]}>urn:isbn:${normalized}</${match[1]}>`;

		return (
			xml.slice(0, match.index) +
			replacement +
			xml.slice(match.index + match[0].length)
		);
	}

	return insertIntoMetadata(
		xml,
		`<dc:identifier id="ereader-sync-isbn">urn:isbn:${normalized}</dc:identifier>`,
	);
}

function setSubjects(
	xml: string,
	subjects?: string[],
): string {
	const cleanSubjects = (subjects ?? [])
		.map((value) => cleanText(value))
		.filter((value): value is string => !!value)
		.filter(
			(value, index, array) =>
				array.findIndex(
					(other) =>
						other.toLowerCase() ===
						value.toLowerCase(),
				) === index,
		);

	if (cleanSubjects.length === 0) {
		return xml;
	}

	let output = xml.replace(
		/<(?:[\w.-]+:)?subject\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?subject\s*>/gi,
		"",
	);

	for (const subject of cleanSubjects) {
		output = insertIntoMetadata(
			output,
			`<dc:subject>${escapeXml(subject)}</dc:subject>`,
		);
	}

	return output;
}

function setEpub3SeriesMetadata(
	xml: string,
	series?: string,
	seriesIndex?: string,
): string {
	if (!series) {
		return xml;
	}

	let output = xml
		.replace(
			/<meta\b[^>]*\bid=["']ereader-sync-series["'][^>]*>[\s\S]*?<\/meta>/gi,
			"",
		)
		.replace(
			/<meta\b(?=[^>]*\brefines=["']#ereader-sync-series["'])[^>]*>[\s\S]*?<\/meta>/gi,
			"",
		);

	output = insertIntoMetadata(
		output,
		`<meta property="belongs-to-collection" id="ereader-sync-series">${escapeXml(series)}</meta>`,
	);

	output = insertIntoMetadata(
		output,
		`<meta refines="#ereader-sync-series" property="collection-type">series</meta>`,
	);

	if (seriesIndex) {
		output = insertIntoMetadata(
			output,
			`<meta refines="#ereader-sync-series" property="group-position">${escapeXml(seriesIndex)}</meta>`,
		);
	}

	return output;
}

function rewriteOpf(
	opf: string,
	metadata: BookMetadata,
): string {
	let output = opf;

	output = setElement(
		output,
		"title",
		metadata.title,
	);
	output = setElement(
		output,
		"creator",
		metadata.author,
	);
	output = setElement(
		output,
		"description",
		metadata.description,
	);
	output = setElement(
		output,
		"language",
		metadata.language,
	);
	output = setElement(
		output,
		"publisher",
		metadata.publisher,
	);
	output = setElement(
		output,
		"date",
		normalizePublicationDate(
			metadata.published,
		),
	);
	output = setIsbn(
		output,
		metadata.isbn,
	);
	output = setSubjects(
		output,
		metadata.subjects,
	);

	if (metadata.series) {
		output = setNamedMeta(
			output,
			"calibre:series",
			metadata.series,
		);
		output = setNamedMeta(
			output,
			"calibre:series_index",
			metadata.seriesIndex ?? "1",
		);
		output = setEpub3SeriesMetadata(
			output,
			metadata.series,
			metadata.seriesIndex,
		);
	}

	if (
		metadata.pageCount &&
		metadata.pageCount > 0
	) {
		output = setNamedMeta(
			output,
			"ereader-sync:page_count",
			String(metadata.pageCount),
		);
	}

	return output;
}

function rebuildEpub(
	files: Record<string, Uint8Array>,
	opfPath: string,
	opf: string,
): Uint8Array {
	const ordered: Record<
		string,
		Uint8Array | [Uint8Array, { level: number }]
	> = {};

	const mimetype =
		files.mimetype ??
		strToU8("application/epub+zip");

	/*
	 * EPUB requires mimetype to be the first ZIP entry and to
	 * be stored without compression.
	 */
	ordered.mimetype = [
		mimetype,
		{ level: 0 },
	];

	for (const [name, bytes] of Object.entries(files)) {
		if (name === "mimetype") {
			continue;
		}

		ordered[name] =
			name === opfPath
				? strToU8(opf)
				: bytes;
	}

	return zipSync(
		ordered,
		{ level: 6 },
	);
}

export async function repairEpub(
	originalBytes: Uint8Array,
	originalFileName: string,
	options: MetadataResolverOptions = {},
): Promise<EpubRepairResult> {
	const files = unzipSync(originalBytes);
	const opfPath = findOpfPath(files);
	const opf = strFromU8(files[opfPath]);

	const {
		metadata: originalMetadata,
	} = readEpubMetadata(
		originalBytes,
	);

	const resolved = await resolveMetadata(
		originalMetadata,
		originalFileName,
		options,
	);

	const rewrittenOpf = rewriteOpf(
		opf,
		resolved.metadata,
	);

	const bytes = rebuildEpub(
		files,
		opfPath,
		rewrittenOpf,
	);

	/*
	 * Parse the output once before returning. If the rewritten
	 * EPUB is malformed, fail before it ever reaches R2.
	 */
	readEpubMetadata(bytes);

	return {
		bytes,
		originalMetadata,
		resolved,
		opfPath,
	};
}
