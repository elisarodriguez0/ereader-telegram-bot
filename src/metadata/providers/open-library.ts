import {
	cleanText,
	normalizeIsbn,
	scoreBookMatch,
} from "../normalize";

import type {
	FilenameMetadata,
	MetadataCandidate,
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

	series?: string[];
}

interface WorkResponse {
	description?:
		| string
		| {
				value?: string;
		  };
}

function mapLanguage(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

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

	return (
		map[
			value.toLowerCase()
		] ??
		value
	);
}

async function getDescription(
	key?: string,
): Promise<
	string | undefined
> {
	if (!key) {
		return undefined;
	}

	const workId =
		key
			.replace(
				/^\/?works\//,
				"",
			)
			.trim();

	if (
		!/^OL\d+W$/i.test(
			workId,
		)
	) {
		return undefined;
	}

	try {
		const response =
			await fetch(
				`https://openlibrary.org/works/${encodeURIComponent(workId)}.json`,
				{
					signal:
						AbortSignal.timeout(
							5000,
						),
				},
			);

		if (!response.ok) {
			return undefined;
		}

		const work =
			(await response.json()) as WorkResponse;

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
	} catch {
		return undefined;
	}
}

export async function lookupOpenLibrary(
	query: FilenameMetadata & {
		isbn?: string;
	},
): Promise<
	MetadataCandidate | undefined
> {
	const params =
		new URLSearchParams();

	if (query.isbn) {
		params.set(
			"isbn",
			query.isbn,
		);
	} else {
		if (!query.title) {
			return undefined;
		}

		params.set(
			"title",
			query.title,
		);

		if (query.author) {
			params.set(
				"author",
				query.author,
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
			"subject",
			"series",
		].join(","),
	);

	params.set("limit", "10");

	try {
		const response =
			await fetch(
				`https://openlibrary.org/search.json?${params.toString()}`,
				{
					signal:
						AbortSignal.timeout(
							5000,
						),
				},
			);

		if (!response.ok) {
			return undefined;
		}

		const data =
			(await response.json()) as SearchResponse;

		let bestDoc:
			| SearchDocument
			| undefined;

		let bestScore = 0;

		for (
			const doc
			of data.docs ?? []
		) {
			const isbn13 =
				doc.isbn
					?.map(
						normalizeIsbn,
					)
					.find(
						(value) =>
							value
								?.length ===
							13,
					);

			const anyIsbn =
				doc.isbn
					?.map(
						normalizeIsbn,
					)
					.find(Boolean);

			const metadata = {
				title:
					cleanText(
						doc.title,
					),

				author:
					cleanText(
						doc
							.author_name?.[0],
					),

				language:
					mapLanguage(
						doc
							.language?.[0],
					),

				isbn:
					isbn13 ??
					anyIsbn,

				publisher:
					cleanText(
						doc
							.publisher?.[0],
					),

				published:
					doc
						.first_publish_year
						? String(
								doc.first_publish_year,
							)
						: undefined,

				series:
					cleanText(
						doc
							.series?.[0],
					),

				subjects:
					doc.subject
						?.slice(
							0,
							10,
						)
						.map(
							cleanText,
						)
						.filter(
							(
								value,
							): value is string =>
								!!value,
						),
			};

			const score =
				scoreBookMatch(
					query,
					metadata,
				);

			if (
				score >
				bestScore
			) {
				bestScore =
					score;

				bestDoc =
					doc;
			}
		}

		if (
			!bestDoc ||
			bestScore < 70
		) {
			return undefined;
		}

		const isbn13 =
			bestDoc.isbn
				?.map(
					normalizeIsbn,
				)
				.find(
					(value) =>
						value?.length ===
						13,
				);

		return {
			source:
				"open-library",

			score:
				bestScore,

			url:
				bestDoc.key
					? `https://openlibrary.org${bestDoc.key.startsWith("/") ? "" : "/works/"}${bestDoc.key}`
					: undefined,

			metadata: {
				title:
					cleanText(
						bestDoc.title,
					),

				author:
					cleanText(
						bestDoc
							.author_name?.[0],
					),

				description:
					await getDescription(
						bestDoc.key,
					),

				language:
					mapLanguage(
						bestDoc
							.language?.[0],
					),

				isbn:
					isbn13 ??
					bestDoc.isbn
						?.map(
							normalizeIsbn,
						)
						.find(Boolean),

				publisher:
					cleanText(
						bestDoc
							.publisher?.[0],
					),

				published:
					bestDoc
						.first_publish_year
						? String(
								bestDoc.first_publish_year,
							)
						: undefined,

				series:
					cleanText(
						bestDoc
							.series?.[0],
					),

				subjects:
					bestDoc.subject
						?.slice(
							0,
							10,
						)
						.map(
							cleanText,
						)
						.filter(
							(
								value,
							): value is string =>
								!!value,
						),
			},
		};
	} catch {
		return undefined;
	}
}