import {
	authorSimilarity,
	cleanText,
	normalizeText,
	wordSimilarity,
} from "../normalize";

import type {
	FilenameMetadata,
	MetadataCandidate,
} from "../types";

const DEFAULT_BASE_URL =
	"https://ww3.lectulandia.com";

const REQUEST_HEADERS = {
	Accept:
		"text/html,application/xhtml+xml",

	"User-Agent":
		"Mozilla/5.0 (compatible; EreaderSync/0.4; personal-library)",
};

interface SeriesHint {
	name?: string;
	index?: string;
}

interface ParsedLectulandiaBook {
	url: string;

	title?: string;
	author?: string;

	series?: string;
	seriesIndex?: string;

	description?: string;

	subjects?: string[];
}

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

function slugify(
	value: string,
): string {
	return normalizeText(value)
		.replace(/\s+/g, "-");
}

function decodeHtmlEntities(
	value: string,
): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")

		.replace(/&aacute;/gi, "á")
		.replace(/&eacute;/gi, "é")
		.replace(/&iacute;/gi, "í")
		.replace(/&oacute;/gi, "ó")
		.replace(/&uacute;/gi, "ú")
		.replace(/&uuml;/gi, "ü")
		.replace(/&ntilde;/gi, "ñ");
}

function htmlToText(
	html: string,
	preserveBreaks = false,
): string | undefined {
	let value = html;

	if (preserveBreaks) {
		value = value
			.replace(
				/<br\s*\/?>/gi,
				"\n",
			)
			.replace(
				/<\/p>/gi,
				"\n",
			);
	}

	value = value
		.replace(
			/<script\b[\s\S]*?<\/script>/gi,
			"",
		)
		.replace(
			/<style\b[\s\S]*?<\/style>/gi,
			"",
		)
		.replace(
			/<[^>]+>/g,
			"",
		);

	value =
		decodeHtmlEntities(value);

	if (preserveBreaks) {
		value = value
			.replace(/[ \t]+/g, " ")
			.replace(
				/[ \t]*\n[ \t]*/g,
				"\n",
			)
			.replace(
				/\n{3,}/g,
				"\n\n",
			)
			.trim();
	} else {
		value = value
			.replace(/\s+/g, " ")
			.trim();
	}

	return value || undefined;
}

/* -------------------------------------------------------------------------- */
/*  HTTP                                                                      */
/* -------------------------------------------------------------------------- */

async function fetchHtml(
	url: string,
): Promise<string | undefined> {
	try {
		const response =
			await fetch(
				url,
				{
					headers:
						REQUEST_HEADERS,

					redirect:
						"follow",

					signal:
						AbortSignal.timeout(
							7000,
						),
				},
			);

		if (!response.ok) {
			console.log(
				"[Lectulandia]",
				url,
				"HTTP",
				response.status,
			);

			return undefined;
		}

		const html =
			await response.text();

		/*
		 * Do not attempt to bypass
		 * Cloudflare challenges.
		 */
		if (
			/cloudflare|just a moment|cf-chl|challenge-platform/i.test(
				html.slice(
					0,
					10000,
				),
			)
		) {
			console.log(
				"[Lectulandia] Cloudflare challenge:",
				url,
			);

			return undefined;
		}

		return html;
	} catch (error) {
		console.log(
			"[Lectulandia] fetch failed:",
			url,
			error,
		);

		return undefined;
	}
}

/* -------------------------------------------------------------------------- */
/*  Filename hints                                                            */
/* -------------------------------------------------------------------------- */

function extractSeriesHint(
	title?: string,
): SeriesHint {
	if (!title) {
		return {};
	}

	const value = title
		.replace(
			/\.(epub|mobi|azw3)$/i,
			"",
		)
		.trim();

	const patterns = [
		/*
		 * El Reino De Los Malditos Vol. 3
		 * El Reino De Los Malditos Volumen 3
		 * El Reino De Los Malditos Libro 3
		 * El Reino De Los Malditos Tomo 3
		 */
		/^(.*?)\s+(?:vol(?:umen)?|tomo|libro|book)\.?\s*#?\s*(\d+(?:\.\d+)?)$/i,

		/*
		 * El Reino De Los Malditos #3
		 */
		/^(.*?)\s*#\s*(\d+(?:\.\d+)?)$/i,

		/*
		 * El Reino De Los Malditos - 3
		 */
		/^(.*?)\s+-\s*(\d+(?:\.\d+)?)$/i,

		/*
		 * El Reino De Los Malditos 3
		 *
		 * Lowest priority because a
		 * number can theoretically be
		 * part of a real title.
		 */
		/^(.*?)\s+(\d+(?:\.\d+)?)$/i,
	];

	for (const pattern of patterns) {
		const match =
			value.match(pattern);

		if (!match) {
			continue;
		}

		const name =
			cleanText(match[1]);

		const index =
			match[2];

		if (
			name &&
			index
		) {
			return {
				name,
				index,
			};
		}
	}

	return {};
}

/* -------------------------------------------------------------------------- */
/*  Exact Lectulandia blocks                                                  */
/* -------------------------------------------------------------------------- */

function extractBlock(
	html: string,
	id: string,
): string | undefined {
	const escaped =
		id.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);

	const regex =
		new RegExp(
			`<div\\b[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/div>`,
			"i",
		);

	return regex.exec(html)?.[1];
}

function extractTitle(
	html: string,
): string | undefined {
	const block =
		extractBlock(
			html,
			"title",
		);

	if (!block) {
		return undefined;
	}

	const h1 =
		block.match(
			/<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
		)?.[1];

	return h1
		? htmlToText(h1)
		: undefined;
}

function extractAuthor(
	html: string,
): string | undefined {
	const block =
		extractBlock(
			html,
			"autor",
		);

	if (!block) {
		return undefined;
	}

	const anchor =
		block.match(
			/<a\b[^>]*>([\s\S]*?)<\/a>/i,
		)?.[1];

	return anchor
		? htmlToText(anchor)
		: undefined;
}

function extractSeries(
	html: string,
): SeriesHint {
	const block =
		extractBlock(
			html,
			"serie",
		);

	if (!block) {
		return {};
	}

	/*
	 * Exact Lectulandia structure:
	 *
	 * <span class="tagTitle">
	 *   Libro 1 de:
	 * </span>
	 *
	 * <a ...>
	 *   El reino de los Malditos
	 * </a>
	 */

	const label =
		block.match(
			/<span\b[^>]*class=["'][^"']*tagTitle[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
		)?.[1];

	const anchor =
		block.match(
			/<a\b[^>]*>([\s\S]*?)<\/a>/i,
		)?.[1];

	const labelText =
		label
			? htmlToText(label)
			: undefined;

	const series =
		anchor
			? htmlToText(anchor)
			: undefined;

	const index =
		labelText?.match(
			/Libro\s+(\d+(?:\.\d+)?)\s+de:/i,
		)?.[1];

	return {
		name:
			series,

		index,
	};
}

function extractSubjects(
	html: string,
): string[] | undefined {
	const block =
		extractBlock(
			html,
			"genero",
		);

	if (!block) {
		return undefined;
	}

	const subjects:
		string[] = [];

	const regex =
		/<a\b[^>]*>([\s\S]*?)<\/a>/gi;

	let match:
		| RegExpExecArray
		| null;

	while (
		(match = regex.exec(block))
	) {
		const subject =
			htmlToText(
				match[1],
			);

		if (
			subject &&
			!subjects.includes(
				subject,
			)
		) {
			subjects.push(
				subject,
			);
		}
	}

	return subjects.length
		? subjects
		: undefined;
}

function extractDescription(
	html: string,
): string | undefined {
	/*
	 * IMPORTANT:
	 *
	 * Description comes ONLY from:
	 *
	 *     <div id="sinopsis">
	 *
	 * We never use:
	 * - meta description
	 * - paragraphs around genres
	 * - comments
	 * - page text
	 * - OpenGraph
	 *
	 * If #sinopsis is absent, Lectulandia
	 * has no description for our purposes.
	 */

	const block =
		extractBlock(
			html,
			"sinopsis",
		);

	if (!block) {
		return undefined;
	}

	return htmlToText(
		block,
		true,
	);
}

/* -------------------------------------------------------------------------- */
/*  Book page                                                                 */
/* -------------------------------------------------------------------------- */

function parseBookPage(
	html: string,
	url: string,
): ParsedLectulandiaBook {
	const series =
		extractSeries(html);

	return {
		url,

		title:
			extractTitle(
				html,
			),

		author:
			extractAuthor(
				html,
			),

		series:
			series.name,

		seriesIndex:
			series.index,

		description:
			extractDescription(
				html,
			),

		subjects:
			extractSubjects(
				html,
			),
	};
}

/* -------------------------------------------------------------------------- */
/*  Discovery                                                                 */
/* -------------------------------------------------------------------------- */

function extractBookUrls(
	html: string,
	baseUrl: string,
): string[] {
	const urls =
		new Set<string>();

	const regex =
		/<a\b[^>]*href=["']([^"']*\/book\/[^"'#?]+\/?)["'][^>]*>/gi;

	let match:
		| RegExpExecArray
		| null;

	while (
		(match = regex.exec(html))
	) {
		try {
			const url =
				new URL(
					match[1],
					baseUrl,
				).toString();

			urls.add(url);
		} catch {
			// Ignore malformed URL.
		}
	}

	return [...urls];
}

async function discoverCandidateUrls(
	query: FilenameMetadata,
	baseUrl: string,
	seriesHint: SeriesHint,
): Promise<string[]> {
	const urls =
		new Set<string>();

	/*
	 * Source 1:
	 * author page.
	 */
	if (query.author) {
		const authorUrl =
			`${baseUrl}/autor/${slugify(query.author)}/`;

		const html =
			await fetchHtml(
				authorUrl,
			);

		if (html) {
			for (
				const url
				of extractBookUrls(
					html,
					baseUrl,
				)
			) {
				urls.add(url);
			}
		}
	}

	/*
	 * Source 2:
	 * series page.
	 *
	 * This is especially useful when the
	 * filename is:
	 *
	 * El Reino De Los Malditos Vol. 3
	 *
	 * because we know the series even
	 * though we DON'T know the book title.
	 */
	if (seriesHint.name) {
		const seriesUrl =
			`${baseUrl}/serie/${slugify(seriesHint.name)}/`;

		const html =
			await fetchHtml(
				seriesUrl,
			);

		if (html) {
			for (
				const url
				of extractBookUrls(
					html,
					baseUrl,
				)
			) {
				urls.add(url);
			}
		}
	}

	return [...urls];
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                  */
/* -------------------------------------------------------------------------- */

function scoreCandidate(
	book: ParsedLectulandiaBook,
	query: FilenameMetadata,
	seriesHint: SeriesHint,
): number {
	let score = 0;

	/*
	 * AUTHOR
	 *
	 * Very strong identity signal.
	 */
	if (
		query.author &&
		book.author
	) {
		score +=
			authorSimilarity(
				query.author,
				book.author,
			) * 30;
	}

	/*
	 * SERIES
	 *
	 * Filename may contain series instead
	 * of the actual book title.
	 */
	if (
		seriesHint.name &&
		book.series
	) {
		score +=
			wordSimilarity(
				seriesHint.name,
				book.series,
			) * 45;
	}

	/*
	 * SERIES POSITION
	 *
	 * Exact volume is extremely strong.
	 */
	if (
		seriesHint.index &&
		book.seriesIndex
	) {
		if (
			seriesHint.index ===
			book.seriesIndex
		) {
			score += 25;
		} else {
			/*
			 * Correct-looking series but
			 * wrong volume must lose.
			 */
			score -= 60;
		}
	}

	/*
	 * REAL TITLE
	 *
	 * Useful for ordinary filenames.
	 *
	 * For series-based filenames this may
	 * legitimately be near zero.
	 */
	if (
		query.title &&
		book.title
	) {
		score +=
			wordSimilarity(
				query.title,
				book.title,
			) * 30;
	}

	return Math.max(
		0,
		Math.min(
			100,
			Math.round(score),
		),
	);
}

/* -------------------------------------------------------------------------- */
/*  Provider                                                                  */
/* -------------------------------------------------------------------------- */

export async function lookupLectulandia(
	query: FilenameMetadata,
	baseUrl =
		DEFAULT_BASE_URL,
): Promise<
	MetadataCandidate | undefined
> {
	if (
		!query.title &&
		!query.author
	) {
		return undefined;
	}

	const normalizedBase =
		baseUrl.replace(
			/\/$/,
			"",
		);

	const seriesHint =
		extractSeriesHint(
			query.title,
		);

	console.log(
		"[Lectulandia] query:",
		JSON.stringify({
			title:
				query.title,

			author:
				query.author,

			seriesHint,
		}),
	);

	const candidateUrls =
		await discoverCandidateUrls(
			query,
			normalizedBase,
			seriesHint,
		);

	console.log(
		"[Lectulandia] candidate URLs:",
		candidateUrls.length,
	);

	if (!candidateUrls.length) {
		return undefined;
	}

	/*
	 * Avoid hammering the site.
	 *
	 * This is a personal library tool,
	 * so checking a modest number of
	 * candidate books is sufficient.
	 */
	const urls =
		candidateUrls.slice(
			0,
			25,
		);

	const candidates:
		Array<{
			book:
				ParsedLectulandiaBook;

			score:
				number;
		}> = [];

	/*
	 * Process in small batches instead of
	 * firing 25 requests simultaneously.
	 */
	const batchSize = 4;

	for (
		let offset = 0;
		offset < urls.length;
		offset += batchSize
	) {
		const batch =
			urls.slice(
				offset,
				offset +
					batchSize,
			);

		const parsed =
			await Promise.all(
				batch.map(
					async (
						url,
					) => {
						const html =
							await fetchHtml(
								url,
							);

						if (!html) {
							return undefined;
						}

						const book =
							parseBookPage(
								html,
								url,
							);

						const score =
							scoreCandidate(
								book,
								query,
								seriesHint,
							);

						console.log(
							"[Lectulandia] candidate:",
							JSON.stringify({
								title:
									book.title,

								author:
									book.author,

								series:
									book.series,

								seriesIndex:
									book.seriesIndex,

								score,

								url,
							}),
						);

						return {
							book,
							score,
						};
					},
				),
			);

		for (const item of parsed) {
			if (item) {
				candidates.push(
					item,
				);
			}
		}
	}

	candidates.sort(
		(a, b) =>
			b.score -
			a.score,
	);

	const best =
		candidates[0];

	if (!best) {
		return undefined;
	}

	/*
	 * For series filenames:
	 *
	 * author ~30
	 * series ~45
	 * exact volume +25
	 *
	 * → essentially 100 without needing
	 * title similarity.
	 */
	const minimumScore =
		seriesHint.name &&
		seriesHint.index
			? 80
			: 60;

	if (
		best.score <
		minimumScore
	) {
		console.log(
			"[Lectulandia] best candidate below threshold:",
			best.score,
		);

		return undefined;
	}

	const metadata = {
		title:
			best.book.title,

		author:
			best.book.author,

		description:
			best.book.description,

		series:
			best.book.series,

		seriesIndex:
			best.book
				.seriesIndex,

		subjects:
			best.book.subjects,
	};

	console.log(
		"[Lectulandia] MATCH:",
		JSON.stringify({
			...metadata,

			description:
				metadata.description
					? `${metadata.description.slice(0, 80)}...`
					: undefined,

			score:
				best.score,

			url:
				best.book.url,
		}),
	);

	return {
		source:
			"lectulandia",

		metadata,

		score:
			best.score,

		url:
			best.book.url,
	};
}