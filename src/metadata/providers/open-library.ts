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

interface SearchEdition {
	key?: string;
	title?: string;
	isbn?: string[];
	publisher?: string[];
	publish_date?: string[];
	number_of_pages?: number;
	language?: string[];
}

interface SearchDocument {
	key?: string;
	title?: string;
	author_name?: string[];
	first_publish_year?: number;
	language?: string[];

	editions?: {
		docs?: SearchEdition[];
	};
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
		.replace(
			/^\/languages\//,
			"",
		)
		.trim()
		.toLowerCase();

	const map:
		Record<string, string> = {
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

function openLibraryLanguageCode(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const clean =
		value
			.slice(0, 2)
			.toLowerCase();

	const map:
		Record<string, string> = {
			es: "spa",
			en: "eng",
			fr: "fre",
			de: "ger",
			it: "ita",
			pt: "por",
			ca: "cat",
			gl: "glg",
			eu: "eus",
		};

	return map[clean];
}

function escapeQueryPhrase(
	value: string,
): string {
	return value
		.replace(
			/\\/g,
			"\\\\",
		)
		.replace(
			/"/g,
			'\\"',
		);
}

async function fetchJson<T>(
	url: string,
	timeout = 5000,
): Promise<T | undefined> {
	try {
		const response =
			await fetch(
				url,
				{
					headers: {
						Accept:
							"application/json",
					},

					signal:
						AbortSignal.timeout(
							timeout,
						),
				},
			);

		if (!response.ok) {
			console.log(
				"[Open Library] HTTP",
				response.status,
				url,
			);

			return undefined;
		}

		return (
			await response.json()
		) as T;
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

	const workId =
		key
			.replace(
				/^\/?works\//,
				"",
			)
			.replace(
				/^\//,
				"",
			)
			.trim();

	if (
		!/^OL\d+W$/i.test(
			workId,
		)
	) {
		return {};
	}

	const work =
		await fetchJson<WorkResponse>(
			`https://openlibrary.org/works/${encodeURIComponent(workId)}.json`,
		);

	if (!work) {
		return {};
	}

	const description =
		typeof work.description ===
		"string"
			? cleanText(
					work.description,
				)
			: cleanText(
					work.description
						?.value,
				);

	const subjects =
		work.subjects
			?.slice(
				0,
				12,
			)
			.map((value) =>
				cleanText(value),
			)
			.filter(
				(
					value,
				): value is string =>
					!!value,
			);

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

	const normalizedKey =
		key.startsWith("/")
			? key
			: `/authors/${key}`;

	const author =
		await fetchJson<AuthorResponse>(
			`https://openlibrary.org${normalizedKey}.json`,
		);

	return cleanText(
		author?.name,
	);
}

function bestIsbn(
	values?: string[],
): string | undefined {
	const normalized =
		(values ?? [])
			.map((value) =>
				normalizeIsbn(value),
			)
			.filter(
				(
					value,
				): value is string =>
					!!value,
			);

	return (
		normalized.find(
			(value) =>
				value.length ===
				13,
		) ??
		normalized[0]
	);
}

function selectEdition(
	doc: SearchDocument,
	expectedLanguage?: string,
): SearchEdition | undefined {
	const editions =
		doc.editions?.docs ??
		[];

	if (
		editions.length === 0
	) {
		return undefined;
	}

	if (expectedLanguage) {
		const matching =
			editions.find(
				(edition) =>
					(
						edition.language ??
						[]
					).some(
						(code) =>
							languageMatches(
								expectedLanguage,
								mapLanguage(
									code,
								),
							),
					),
			);

		if (matching) {
			return matching;
		}
	}

	return editions[0];
}

function mapDocument(
	doc: SearchDocument,
	expectedLanguage?: string,
): BookMetadata {
	const edition =
		selectEdition(
			doc,
			expectedLanguage,
		);

	const editionLanguage =
		edition?.language
			?.map((value) =>
				mapLanguage(value),
			)
			.find((value) =>
				expectedLanguage
					? languageMatches(
							expectedLanguage,
							value,
						)
					: !!value,
			);

	const workLanguage =
		doc.language
			?.map((value) =>
				mapLanguage(value),
			)
			.find((value) =>
				expectedLanguage
					? languageMatches(
							expectedLanguage,
							value,
						)
					: !!value,
			);

	return {
		title:
			cleanText(
				edition?.title,
			) ??
			cleanText(
				doc.title,
			),

		author:
			cleanText(
				doc
					.author_name?.[0],
			),

		language:
			editionLanguage ??
			workLanguage,

		/*
		 * SearchDocument ISBNs represent the entire Work
		 * and can mix several languages/editions.
		 *
		 * Only use the ISBN from the Spanish edition
		 * selected above.
		 */
		isbn:
			bestIsbn(
				edition?.isbn,
			),

		publisher:
			cleanText(
				edition
					?.publisher?.[0],
			),

		published:
			normalizePublicationDate(
				edition
					?.publish_date?.[0],
			) ??
			(
				doc.first_publish_year
					? String(
							doc.first_publish_year,
						)
					: undefined
			),

		pageCount:
			edition
				?.number_of_pages &&
			edition.number_of_pages >
				0
				? edition.number_of_pages
				: undefined,
	};
}

async function lookupExactIsbn(
	hypothesis:
		SearchHypothesis,
): Promise<
	MetadataCandidate | undefined
> {
	const isbn =
		normalizeIsbn(
			hypothesis.hints.isbn,
		);

	if (!isbn) {
		return undefined;
	}

	const edition =
		await fetchJson<EditionResponse>(
			`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`,
		);

	if (!edition?.title) {
		return undefined;
	}

	const exactIsbns = [
		...(edition.isbn_13 ??
			[]),

		...(edition.isbn_10 ??
			[]),
	]
		.map((value) =>
			normalizeIsbn(value),
		)
		.filter(
			(
				value,
			): value is string =>
				!!value,
		);

	if (
		exactIsbns.length > 0 &&
		!exactIsbns.includes(
			isbn,
		)
	) {
		return undefined;
	}

	const editionLanguage =
		mapLanguage(
			edition
				.languages?.[0]
				?.key,
		);

	/*
	 * ISBN identifies an edition.
	 *
	 * An English ISBN is therefore not interchangeable
	 * with the Spanish edition of the same book.
	 */
	if (
		hypothesis.hints.language &&
		(
			!editionLanguage ||
			!languageMatches(
				hypothesis.hints
					.language,
				editionLanguage,
			)
		)
	) {
		return undefined;
	}

	const [
		author,
		workData,
	] =
		await Promise.all([
			getAuthorName(
				edition
					.authors?.[0]
					?.key,
			),

			getDescriptionAndSubjects(
				edition
					.works?.[0]
					?.key,
			),
		]);

	const metadata:
		BookMetadata = {
			title:
				cleanText(
					edition.title,
				),

			author,

			/*
			 * Work descriptions are often English even
			 * if this exact Edition is Spanish.
			 *
			 * They remain on the candidate for debugging,
			 * but our search path below doesn't use them
			 * for normal Spanish enrichment.
			 */
			description:
				workData.description,

			language:
				editionLanguage,

			isbn,

			publisher:
				cleanText(
					edition
						.publishers?.[0],
				),

			published:
				normalizePublicationDate(
					edition.publish_date,
				),

			pageCount:
				edition
					.number_of_pages &&
				edition.number_of_pages >
					0
					? edition
							.number_of_pages
					: undefined,

			subjects:
				workData.subjects,
		};

	return {
		source:
			"open-library",

		metadata,

		score:
			100,

		url:
			edition.key
				? `https://openlibrary.org${edition.key}`
				: `https://openlibrary.org/isbn/${isbn}`,

		matchedHypothesis:
			hypothesis,
	};
}

async function lookupSearch(
	hypothesis:
		SearchHypothesis,
): Promise<
	MetadataCandidate | undefined
> {
	if (
		hypothesis.kind ===
		"series"
	) {
		return undefined;
	}

	const hints =
		hypothesis.hints;

	if (
		hypothesis.kind !==
			"title" ||
		!hints.title
	) {
		return undefined;
	}

	const params =
		new URLSearchParams();

	const qParts = [
		`title:"${escapeQueryPhrase(hints.title)}"`,
	];

	if (hints.author) {
		qParts.push(
			`author:"${escapeQueryPhrase(hints.author)}"`,
		);
	}

	const olLanguage =
		openLibraryLanguageCode(
			hints.language,
		);

	if (olLanguage) {
		/*
		 * lang=es merely boosts Spanish records.
		 *
		 * language:spa actually requires the work to
		 * expose a Spanish edition.
		 */
		qParts.push(
			`language:${olLanguage}`,
		);

		params.set(
			"lang",
			hints.language!
				.slice(0, 2)
				.toLowerCase(),
		);
	}

	params.set(
		"q",
		qParts.join(" AND "),
	);

	params.set(
		"fields",
		[
			"key",
			"title",
			"author_name",
			"first_publish_year",
			"language",
			"editions",
			"editions.key",
			"editions.title",
			"editions.isbn",
			"editions.publisher",
			"editions.publish_date",
			"editions.number_of_pages",
			"editions.language",
		].join(","),
	);

	params.set(
		"limit",
		"10",
	);

	const data =
		await fetchJson<SearchResponse>(
			`https://openlibrary.org/search.json?${params.toString()}`,
		);

	if (!data) {
		return undefined;
	}

	let bestDoc:
		| SearchDocument
		| undefined;

	let bestMetadata:
		| BookMetadata
		| undefined;

	let bestScore = 0;

	for (
		const doc
		of data.docs ?? []
	) {
		const metadata =
			mapDocument(
				doc,
				hints.language,
			);

		/*
		 * Do not merely prefer Spanish.
		 *
		 * Require the selected result to represent the
		 * target language, otherwise its ISBN could cause
		 * an incorrect exact-edition pass afterwards.
		 */
		if (
			hints.language &&
			(
				!metadata.language ||
				!languageMatches(
					hints.language,
					metadata.language,
				)
			)
		) {
			continue;
		}

		let score =
			scoreTitleMatch(
				hints,
				metadata,
			);

		score *=
			0.88 +
			0.12 *
				hypothesis.confidence;

		score =
			Math.round(
				clamp(score),
			);

		if (
			score >
			bestScore
		) {
			bestScore =
				score;

			bestDoc =
				doc;

			bestMetadata =
				metadata;
		}
	}

	if (
		!bestDoc ||
		!bestMetadata ||
		bestScore <= 0
	) {
		return undefined;
	}

	/*
	 * Deliberately do NOT append Open Library's Work
	 * description or subjects here.
	 *
	 * Those are frequently English regardless of the
	 * language of the selected Edition.
	 *
	 * Lectulandia or a Spanish Google Books volume are
	 * much safer sources for prose metadata.
	 */

	let url:
		| string
		| undefined;

	if (bestDoc.key) {
		const key =
			bestDoc.key
				.startsWith("/")
				? bestDoc.key
				: `/works/${bestDoc.key}`;

		url =
			`https://openlibrary.org${key}`;
	}

	return {
		source:
			"open-library",

		metadata:
			bestMetadata,

		score:
			bestScore,

		url,

		matchedHypothesis:
			hypothesis,
	};
}

export async function lookupOpenLibrary(
	hypothesis:
		SearchHypothesis,
): Promise<
	MetadataCandidate | undefined
> {
	if (
		hypothesis.kind ===
		"isbn"
	) {
		return lookupExactIsbn(
			hypothesis,
		);
	}

	return lookupSearch(
		hypothesis,
	);
}