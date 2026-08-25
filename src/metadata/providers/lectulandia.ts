import {
	authorSimilarity,
	clamp,
	sameSeriesIndex,
	scoreSeriesMatch,
	scoreTitleMatch,
	titleSimilarity,
} from "../normalize";

import type {
	MetadataCandidate,
	SearchHypothesis,
} from "../types";

const DEFAULT_BASE_URL =
	"https://ww3.lectulandia.com";

const REQUEST_HEADERS = {
	Accept:
		"text/html,application/xhtml+xml",

	"User-Agent":
		"Mozilla/5.0 (compatible; EreaderSync/0.6; personal-library)",
};

interface ParsedLectulandiaBook {
	url: string;
	title?: string;
	author?: string;
	series?: string;
	seriesIndex?: string;
	description?: string;
	subjects?: string[];
}

function slugify(
	value: string,
): string {
	return value
		.normalize("NFD")
		.replace(
			/[\u0300-\u036f]/g,
			"",
		)
		.toLowerCase()
		.replace(
			/[^a-z0-9]+/g,
			"-",
		)
		.replace(
			/^-+|-+$/g,
			"",
		);
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
		.replace(/&ntilde;/gi, "ñ")
		.replace(
			/&#(\d+);/g,
			(_, code: string) =>
				String.fromCodePoint(
					Number(code),
				),
		)
		.replace(
			/&#x([0-9a-f]+);/gi,
			(_, code: string) =>
				String.fromCodePoint(
					parseInt(
						code,
						16,
					),
				),
		);
}

function htmlToText(
	html: string,
	preserveBreaks = false,
): string | undefined {
	let value =
		html;

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
		decodeHtmlEntities(
			value,
		);

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

async function fetchHtml(
	url: string,
): Promise<
	string | undefined
> {
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

		if (
			/cloudflare|just a moment|cf-chl|challenge-platform/i.test(
				html.slice(
					0,
					12000,
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

	return regex.exec(
		html,
	)?.[1];
}

function extractTitle(
	html: string,
): string | undefined {
	const block =
		extractBlock(
			html,
			"title",
		);

	const h1 =
		block?.match(
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

	const anchor =
		block?.match(
			/<a\b[^>]*>([\s\S]*?)<\/a>/i,
		)?.[1];

	return anchor
		? htmlToText(anchor)
		: undefined;
}

function extractSeries(
	html: string,
): {
	series?: string;
	seriesIndex?: string;
} {
	const block =
		extractBlock(
			html,
			"serie",
		);

	if (!block) {
		return {};
	}

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

	return {
		series:
			anchor
				? htmlToText(
						anchor,
					)
				: undefined,

		seriesIndex:
			labelText?.match(
				/Libro\s+(\d+(?:[.,]\d+)?)\s+de:/i,
			)?.[1]
				?.replace(
					",",
					".",
				),
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
		(match =
			regex.exec(block))
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
	 * STRICT:
	 * The description comes ONLY from
	 * <div id="sinopsis">.
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

function parseBookPage(
	html: string,
	url: string,
): ParsedLectulandiaBook {
	const series =
		extractSeries(
			html,
		);

	return {
		url,
		title:
			extractTitle(html),
		author:
			extractAuthor(html),
		series:
			series.series,
		seriesIndex:
			series.seriesIndex,
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
		(match =
			regex.exec(html))
	) {
		try {
			urls.add(
				new URL(
					match[1],
					baseUrl,
				).toString(),
			);
		} catch {
			// Ignore malformed URLs.
		}
	}

	return [...urls];
}

async function discoverCandidateUrls(
	hypothesis:
		SearchHypothesis,
	baseUrl: string,
): Promise<string[]> {
	const urls =
		new Set<string>();

	const hints =
		hypothesis.hints;

	/*
	 * Exact/direct title lookup.
	 * This makes title-only filenames useful
	 * even when there is no author.
	 */
	if (hints.title) {
		const slug =
			slugify(
				hints.title,
			);

		if (slug) {
			urls.add(
				`${baseUrl}/book/${slug}/`,
			);
		}
	}

	if (hints.author) {
		const authorUrl =
			`${baseUrl}/autor/${slugify(hints.author)}/`;

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

	if (
		hints.series &&
		hints.seriesIndex
	) {
		const seriesUrl =
			`${baseUrl}/serie/${slugify(hints.series)}/`;

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

function scoreCandidate(
	hypothesis:
		SearchHypothesis,
	book:
		ParsedLectulandiaBook,
): number {
	let score = 0;

	if (
		hypothesis.kind ===
		"title"
	) {
		score =
			scoreTitleMatch(
				hypothesis.hints,
				book,
			);
	} else if (
		hypothesis.kind ===
		"series"
	) {
		score =
			scoreSeriesMatch(
				hypothesis.hints,
				book,
			);
	}

	/*
	 * Hypothesis confidence is a small
	 * modifier, not a replacement for the
	 * actual provider match.
	 */
	score *=
		0.88 +
		0.12 *
			hypothesis.confidence;

	return Math.round(
		clamp(score),
	);
}

export async function lookupLectulandia(
	hypothesis:
		SearchHypothesis,
	baseUrl =
		DEFAULT_BASE_URL,
): Promise<
	MetadataCandidate | undefined
> {
	if (
		hypothesis.kind ===
		"isbn"
	) {
		return undefined;
	}

	const hints =
		hypothesis.hints;

	if (
		!hints.title &&
		!hints.series &&
		!hints.author
	) {
		return undefined;
	}

	const normalizedBase =
		baseUrl.replace(
			/\/$/,
			"",
		);

	console.log(
		"[Lectulandia] query:",
		JSON.stringify({
			origin:
				hypothesis.origin,
			...hints,
		}),
	);

	const candidateUrls =
		await discoverCandidateUrls(
			hypothesis,
			normalizedBase,
		);

	if (!candidateUrls.length) {
		return undefined;
	}

	const candidates:
		Array<{
			book:
				ParsedLectulandiaBook;
			score:
				number;
		}> = [];

	/*
	 * Avoid an unbounded crawl of an
	 * author's catalogue.
	 */
	const urls =
		candidateUrls.slice(
			0,
			30,
		);

	const batchSize =
		4;

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
								hypothesis,
								book,
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
	 * Additional hard guards.
	 */
	if (
		hypothesis.kind ===
			"series"
	) {
		if (
			!hints.series ||
			!hints.seriesIndex ||
			!best.book.series ||
			!best.book.seriesIndex ||
			titleSimilarity(
				hints.series,
				best.book.series,
			) < 0.7 ||
			!sameSeriesIndex(
				hints.seriesIndex,
				best.book
					.seriesIndex,
			)
		) {
			return undefined;
		}
	}

	if (
		hints.author &&
		best.book.author &&
		authorSimilarity(
			hints.author,
			best.book.author,
		) < 0.55
	) {
		return undefined;
	}

	console.log(
		"[Lectulandia] MATCH:",
		JSON.stringify({
			title:
				best.book.title,
			author:
				best.book.author,
			series:
				best.book.series,
			seriesIndex:
				best.book.seriesIndex,
			score:
				best.score,
			url:
				best.book.url,
		}),
	);

	return {
		source:
			"lectulandia",

		metadata: {
			title:
				best.book.title,
			author:
				best.book.author,
			description:
				best.book
					.description,
			series:
				best.book.series,
			seriesIndex:
				best.book
					.seriesIndex,
			subjects:
				best.book
					.subjects,
		},

		score:
			best.score,

		url:
			best.book.url,

		matchedHypothesis:
			hypothesis,
	};
}
