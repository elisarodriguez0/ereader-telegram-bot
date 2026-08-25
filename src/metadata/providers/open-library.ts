import {
	clamp,
	cleanText,
	languageMatches,
	normalizeIsbn,
	normalizePublicationDate,
	scoreTitleMatch,
} from "../normalize";

import type {
	BookMetadata,
	MetadataCandidate,
	SearchHypothesis,
} from "../types";

interface SearchResponse {
	docs?: SearchDocument[];
}

interface SearchDocument {
	key?: string;
	title?: string;
	author_name?: string[];
	first_publish_year?: number;
	isbn?: string[];
	publisher?: string[];
	language?: string[];
	subject?: string[];
}

interface WorkResponse {
	description?:
		| string
		| {
				value?: string;
		  };
	subjects?: string[];
}

interface EditionResponse {
	key?: string;
	title?: string;
	publish_date?: string;
	number_of_pages?: number;
	publishers?: string[];
	languages?: Array<{
		key?: string;
	}>;
	authors?: Array<{
		key?: string;
	}>;
	works?: Array<{
		key?: string;
	}>;
	subjects?: Array<
		| string
		| {
				name?: string;
		  }
	>;
	isbn_10?: string[];
	isbn_13?: string[];
}

interface AuthorResponse {
	name?: string;
}

function mapLanguage(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const clean = value
		.replace(/^\/languages\//, "")
		.trim()
		.toLowerCase();

	const map: Record<string, string> = {
		spa: "es",
		eng: "en",
		fra: "fr",
		fre: "fr",
		deu: "de",
		ger: "de",
		ita: "it",
		por: "pt",
		cat: "ca",
		glg: "gl",
		eus: "eu",
	};

	return map[clean] ?? clean;
}

async function fetchJson<T>(
	url: string,
	timeout = 5000,
): Promise<T | undefined> {
	try {
		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) {
			console.log(
				"[Open Library] HTTP",
				response.status,
				url,
			);
			return undefined;
		}

		return (await response.json()) as T;
	} catch (error) {
		console.log(
			"[Open Library] fetch failed:",
			url,
			error,
		);
		return undefined;
	}
}

async function getDescriptionAndSubjects(
	key?: string,
): Promise<{
	description?: string;
	subjects?: string[];
}> {
	if (!key) {
		return {};
	}

	const workId = key
		.replace(/^\/?works\//, "")
		.replace(/^\//, "")
		.trim();

	if (!/^OL\d+W$/i.test(workId)) {
		return {};
	}

	const work = await fetchJson<WorkResponse>(
		`https://openlibrary.org/works/${encodeURIComponent(workId)}.json`,
	);

	if (!work) {
		return {};
	}

	const description =
		typeof work.description === "string"
			? cleanText(work.description)
			: cleanText(work.description?.value);

	const subjects = work.subjects
		?.slice(0, 12)
		.map((value) => cleanText(value))
		.filter((value): value is string => !!value);

	return {
		description,
		subjects,
	};
}

async function getAuthorName(
	key?: string,
): Promise<string | undefined> {
	if (!key) {
		return undefined;
	}

	const normalizedKey = key.startsWith("/")
		? key
		: `/authors/${key}`;

	const author = await fetchJson<AuthorResponse>(
		`https://openlibrary.org${normalizedKey}.json`,
	);

	return cleanText(author?.name);
}

function bestIsbn(
	values?: string[],
): string | undefined {
	const normalized = (values ?? [])
		.map((value) => normalizeIsbn(value))
		.filter((value): value is string => !!value);

	return (
		normalized.find((value) => value.length === 13) ??
		normalized[0]
	);
}

function mapDocument(
	doc: SearchDocument,
): BookMetadata {
	return {
		title: cleanText(doc.title),
		author: cleanText(doc.author_name?.[0]),
		language: mapLanguage(doc.language?.[0]),
		isbn: bestIsbn(doc.isbn),
		publisher: cleanText(doc.publisher?.[0]),
		published: doc.first_publish_year
			? String(doc.first_publish_year)
			: undefined,
		subjects: doc.subject
			?.slice(0, 12)
			.map((value) => cleanText(value))
			.filter((value): value is string => !!value),
	};
}

async function lookupExactIsbn(
	hypothesis: SearchHypothesis,
): Promise<MetadataCandidate | undefined> {
	const isbn = normalizeIsbn(
		hypothesis.hints.isbn,
	);

	if (!isbn) {
		return undefined;
	}

	const edition = await fetchJson<EditionResponse>(
		`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`,
	);

	if (!edition?.title) {
		return undefined;
	}

	const exactIsbns = [
		...(edition.isbn_13 ?? []),
		...(edition.isbn_10 ?? []),
	]
		.map((value) => normalizeIsbn(value))
		.filter((value): value is string => !!value);

	if (
		exactIsbns.length > 0 &&
		!exactIsbns.includes(isbn)
	) {
		return undefined;
	}

	const [author, workData] = await Promise.all([
		getAuthorName(
			edition.authors?.[0]?.key,
		),
		getDescriptionAndSubjects(
			edition.works?.[0]?.key,
		),
	]);

	const editionSubjects = edition.subjects
		?.map((subject) =>
			typeof subject === "string"
				? cleanText(subject)
				: cleanText(subject.name),
		)
		.filter((value): value is string => !!value);

	const subjects = [
		...(editionSubjects ?? []),
		...(workData.subjects ?? []),
	].filter(
		(value, index, array) =>
			array.findIndex(
				(other) =>
					other.toLowerCase() ===
					value.toLowerCase(),
			) === index,
	);

	const metadata: BookMetadata = {
		title: cleanText(edition.title),
		author,
		description: workData.description,
		language: mapLanguage(
			edition.languages?.[0]?.key,
		),
		isbn,
		publisher: cleanText(
			edition.publishers?.[0],
		),
		published: normalizePublicationDate(
			edition.publish_date,
		),
		pageCount:
			edition.number_of_pages &&
			edition.number_of_pages > 0
				? edition.number_of_pages
				: undefined,
		subjects:
			subjects.length > 0
				? subjects.slice(0, 12)
				: undefined,
	};

	return {
		source: "open-library",
		metadata,
		score: 100,
		url: edition.key
			? `https://openlibrary.org${edition.key}`
			: `https://openlibrary.org/isbn/${isbn}`,
		matchedHypothesis: hypothesis,
	};
}

async function lookupSearch(
	hypothesis: SearchHypothesis,
): Promise<MetadataCandidate | undefined> {
	if (hypothesis.kind === "series") {
		return undefined;
	}

	const hints = hypothesis.hints;
	const params = new URLSearchParams();

	if (
		hypothesis.kind === "title" &&
		hints.title
	) {
		params.set("title", hints.title);

		if (hints.author) {
			params.set("author", hints.author);
		}
	} else {
		return undefined;
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
			"subject",
		].join(","),
	);
	params.set("limit", "10");

	const language = hints.language
		?.slice(0, 2)
		.toLowerCase();

	if (
		language &&
		/^[a-z]{2}$/.test(language)
	) {
		params.set("lang", language);
	}

	const data = await fetchJson<SearchResponse>(
		`https://openlibrary.org/search.json?${params.toString()}`,
	);

	if (!data) {
		return undefined;
	}

	let bestDoc: SearchDocument | undefined;
	let bestMetadata: BookMetadata | undefined;
	let bestScore = 0;

	for (const doc of data.docs ?? []) {
		const metadata = mapDocument(doc);

		let score = scoreTitleMatch(
			hints,
			metadata,
		);

		if (
			hints.language &&
			metadata.language &&
			!languageMatches(
				hints.language,
				metadata.language,
			)
		) {
			score -= 15;
		}

		score *=
			0.88 +
			0.12 * hypothesis.confidence;

		score = Math.round(
			clamp(score),
		);

		if (score > bestScore) {
			bestScore = score;
			bestDoc = doc;
			bestMetadata = metadata;
		}
	}

	if (
		!bestDoc ||
		!bestMetadata ||
		bestScore <= 0
	) {
		return undefined;
	}

	const workData = await getDescriptionAndSubjects(
		bestDoc.key,
	);

	bestMetadata.description =
		workData.description;

	if (
		(!bestMetadata.subjects ||
			bestMetadata.subjects.length === 0) &&
		workData.subjects?.length
	) {
		bestMetadata.subjects =
			workData.subjects;
	}

	let url: string | undefined;

	if (bestDoc.key) {
		const key = bestDoc.key.startsWith("/")
			? bestDoc.key
			: `/works/${bestDoc.key}`;

		url = `https://openlibrary.org${key}`;
	}

	return {
		source: "open-library",
		metadata: bestMetadata,
		score: bestScore,
		url,
		matchedHypothesis: hypothesis,
	};
}

export async function lookupOpenLibrary(
	hypothesis: SearchHypothesis,
): Promise<MetadataCandidate | undefined> {
	if (hypothesis.kind === "isbn") {
		return lookupExactIsbn(hypothesis);
	}

	return lookupSearch(hypothesis);
}
