import {
	cleanText,
	normalizeIsbn,
	scoreBookMatch,
} from "../normalize";

import type {
	FilenameMetadata,
	MetadataCandidate,
} from "../types";

interface GoogleBooksResponse {
	items?: GoogleVolume[];
}

interface GoogleVolume {
	id?: string;

	volumeInfo?: {
		title?: string;
		subtitle?: string;

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
		normalizeIsbn(isbn13) ??
		normalizeIsbn(isbn10)
	);
}

export async function lookupGoogleBooks(
	query: FilenameMetadata & {
		isbn?: string;
	},
	apiKey?: string,
): Promise<
	MetadataCandidate | undefined
> {
	if (!apiKey) {
		return undefined;
	}

	let searchQuery: string;

	if (query.isbn) {
		searchQuery =
			`isbn:${query.isbn}`;
	} else {
		if (!query.title) {
			return undefined;
		}

		const parts = [
			`intitle:"${query.title}"`,
		];

		if (query.author) {
			parts.push(
				`inauthor:"${query.author}"`,
			);
		}

		searchQuery =
			parts.join(" ");
	}

	const params =
		new URLSearchParams({
			q: searchQuery,

			key:
				apiKey,

			maxResults:
				"10",

			projection:
				"full",

			langRestrict:
				"es",
		});

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
			const info =
				item.volumeInfo;

			if (!info) {
				continue;
			}

			const order =
				info.seriesInfo
					?.volumeSeries?.[0]
					?.orderNumber;

			const metadata = {
				title:
					cleanText(
						info.title,
					),

				author:
					cleanText(
						info.authors?.[0],
					),

				description:
					cleanText(
						info.description,
					),

				language:
					info.language,

				isbn:
					getBestIsbn(
						item,
					),

				publisher:
					cleanText(
						info.publisher,
					),

				published:
					cleanText(
						info.publishedDate,
					),

				pageCount:
					info.pageCount,

				/*
				 * Google exposes seriesInfo,
				 * but not always a reliable
				 * human-readable series title.
				 *
				 * Do NOT confuse
				 * shortSeriesBookTitle with
				 * the series name.
				 */
				seriesIndex:
					order !== undefined
						? String(order)
						: undefined,

				subjects:
					info.categories
						?.map(cleanText)
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
				};
			}
		}

		if (
			!best ||
			best.score < 65
		) {
			return undefined;
		}

		return best;
	} catch {
		return undefined;
	}
}