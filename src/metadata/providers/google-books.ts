import {
	authorSimilarity,
	clamp,
	cleanText,
	languageMatches,
	normalizeIsbn,
	normalizePublicationDate,
	sameSeriesIndex,
	scoreTitleMatch,
} from "../normalize";

import type {
	BookMetadata,
	MetadataCandidate,
	SearchHypothesis,
} from "../types";

interface GoogleBooksResponse {
	items?: GoogleVolume[];
}

interface GoogleVolume {
	id?: string;

	volumeInfo?: {
		title?: string;
		authors?: string[];
		publisher?: string;
		publishedDate?: string;
		description?: string;

		industryIdentifiers?: Array<{
			type?: string;
			identifier?: string;
		}>;

		pageCount?: number;
		categories?: string[];
		language?: string;

		seriesInfo?: {
			bookDisplayNumber?: string;
			shortSeriesBookTitle?: string;

			volumeSeries?: Array<{
				orderNumber?: number;
				seriesId?: string;
			}>;
		};
	};
}

function getBestIsbn(
	volume: GoogleVolume,
): string | undefined {
	const ids =
		volume.volumeInfo
			?.industryIdentifiers ??
		[];

	const isbn13 =
		ids.find(
			(id) =>
				id.type ===
				"ISBN_13",
		)?.identifier;

	const isbn10 =
		ids.find(
			(id) =>
				id.type ===
				"ISBN_10",
		)?.identifier;

	return (
		normalizeIsbn(
			isbn13,
		) ??
		normalizeIsbn(
			isbn10,
		)
	);
}

function getSeriesIndex(
	volume: GoogleVolume,
): string | undefined {
	const info =
		volume.volumeInfo
			?.seriesInfo;

	const order =
		info
			?.volumeSeries?.[0]
			?.orderNumber;

	if (
		order !== undefined &&
		order !== null
	) {
		return String(order);
	}

	return info
		?.bookDisplayNumber
		?.match(
			/\d+(?:[.,]\d+)?/,
		)?.[0]
		?.replace(
			",",
			".",
		);
}

function mapVolume(
	volume: GoogleVolume,
): BookMetadata {
	const info =
		volume.volumeInfo;

	return {
		title:
			cleanText(
				info?.title,
			),

		author:
			cleanText(
				info?.authors?.[0],
			),

		description:
			cleanText(
				info?.description,
			),

		language:
			info?.language,

		isbn:
			getBestIsbn(
				volume,
			),

		publisher:
			cleanText(
				info?.publisher,
			),

		published:
			normalizePublicationDate(
				info?.publishedDate,
			),

		pageCount:
			info?.pageCount,

		seriesIndex:
			getSeriesIndex(
				volume,
			),

		subjects:
			info?.categories
				?.map(
					(value) =>
						cleanText(
							value,
						),
				)
				.filter(
					(
						value,
					): value is string =>
						!!value,
				),
	};
}

function buildQuery(
	hypothesis:
		SearchHypothesis,
): string | undefined {
	const hints =
		hypothesis.hints;

	if (hints.isbn) {
		return `isbn:${hints.isbn}`;
	}

	if (
		hypothesis.kind ===
			"title" &&
		hints.title
	) {
		const parts = [
			`intitle:"${hints.title}"`,
		];

		if (hints.author) {
			parts.push(
				`inauthor:"${hints.author}"`,
			);
		}

		return parts.join(" ");
	}

	if (
		hypothesis.kind ===
			"series" &&
		hints.series
	) {
		const parts = [
			`"${hints.series}"`,
		];

		if (hints.author) {
			parts.push(
				`inauthor:"${hints.author}"`,
			);
		}

		return parts.join(" ");
	}

	return undefined;
}

function scoreCandidate(
	hypothesis:
		SearchHypothesis,
	volume:
		GoogleVolume,
	metadata:
		BookMetadata,
): number {
	const hints =
		hypothesis.hints;

	if (
		hypothesis.kind ===
		"isbn"
	) {
		const expected =
			normalizeIsbn(
				hints.isbn,
			);

		const identifiers =
			volume.volumeInfo
				?.industryIdentifiers ??
			[];

		const matches =
			identifiers.some(
				(identifier) =>
					normalizeIsbn(
						identifier.identifier,
					) === expected,
			);

		return expected && matches
			? 100
			: 0;
	}

	if (
		hypothesis.kind ===
		"title"
	) {
		let score =
			scoreTitleMatch(
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
			0.12 *
				hypothesis.confidence;

		return Math.round(
			clamp(score),
		);
	}

	if (
		hypothesis.kind ===
			"series"
	) {
		const expectedIndex =
			hints.seriesIndex;

		const actualIndex =
			getSeriesIndex(
				volume,
			);

		/*
		 * Google can only resolve a
		 * series hypothesis if its own
		 * seriesInfo confirms the volume
		 * position. Merely finding the
		 * series words in search results
		 * is not enough.
		 */
		if (
			!expectedIndex ||
			!actualIndex ||
			!sameSeriesIndex(
				expectedIndex,
				actualIndex,
			)
		) {
			return 0;
		}

		let score = 70;

		if (hints.author) {
			const authorScore =
				authorSimilarity(
					hints.author,
					metadata.author,
				);

			if (
				metadata.author &&
				authorScore < 0.5
			) {
				return 0;
			}

			score +=
				authorScore *
				30;
		}

		score *=
			0.88 +
			0.12 *
				hypothesis.confidence;

		return Math.round(
			clamp(score),
		);
	}

	return 0;
}

export async function lookupGoogleBooks(
	hypothesis:
		SearchHypothesis,
	apiKey?: string,
): Promise<
	MetadataCandidate | undefined
> {
	const searchQuery =
		buildQuery(
			hypothesis,
		);

	if (!searchQuery) {
		return undefined;
	}

	const params =
		new URLSearchParams({
			q:
				searchQuery,

			maxResults:
				"20",

			projection:
				"full",
		});

	if (apiKey) {
		params.set(
			"key",
			apiKey,
		);
	}

	const language =
		hypothesis.hints
			.language
			?.slice(0, 2)
			.toLowerCase();

	if (
		language &&
		/^[a-z]{2}$/.test(
			language,
		)
	) {
		params.set(
			"langRestrict",
			language,
		);
	}

	try {
		const response =
			await fetch(
				`https://www.googleapis.com/books/v1/volumes?${params.toString()}`,
				{
					signal:
						AbortSignal.timeout(
							6000,
						),
				},
			);

		if (!response.ok) {
			console.log(
				"[Google Books] HTTP",
				response.status,
			);

			return undefined;
		}

		const data =
			(await response.json()) as GoogleBooksResponse;

		let best:
			| MetadataCandidate
			| undefined;

		for (
			const item
			of data.items ?? []
		) {
			if (
				!item.volumeInfo
					?.title
			) {
				continue;
			}

			const metadata =
				mapVolume(
					item,
				);

			/*
			 * Google Books does not give us
			 * a reliable human-readable
			 * series name in volumeInfo.
			 *
			 * If seriesInfo confirms the
			 * requested position, we retain
			 * the queried series name as the
			 * confirmed series label.
			 */
			if (
				hypothesis.kind ===
					"series" &&
				hypothesis.hints
					.series &&
				sameSeriesIndex(
					hypothesis.hints
						.seriesIndex,
					metadata
						.seriesIndex,
				)
			) {
				metadata.series =
					hypothesis.hints
						.series;
			}

			const score =
				scoreCandidate(
					hypothesis,
					item,
					metadata,
				);

			if (
				score <= 0
			) {
				continue;
			}

			if (
				!best ||
				score >
					best.score
			) {
				best = {
					source:
						"google-books",

					metadata,

					score,

					url:
						item.id
							? `https://books.google.com/books?id=${encodeURIComponent(item.id)}`
							: undefined,

					matchedHypothesis:
						hypothesis,
				};
			}
		}

		return best;
	} catch (error) {
		console.log(
			"[Google Books] fetch failed:",
			error,
		);

		return undefined;
	}
}
