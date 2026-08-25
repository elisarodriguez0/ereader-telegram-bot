import {
	cleanText,
	normalizeSeriesIndex,
	normalizeText,
} from "./normalize";

import type {
	ParsedFileName,
	SearchHypothesis,
} from "./types";

interface SeriesParse {
	series: string;
	seriesIndex: string;
	explicit: boolean;
}

function stripExtension(
	fileName: string,
): string {
	return fileName
		.replace(
			/\.(epub|mobi|azw3)$/i,
			"",
		)
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function parseExplicitSeries(
	value: string,
): SeriesParse | undefined {
	const clean =
		value.trim();

	const patterns = [
		/^(.*?)\s+(?:vol(?:umen)?|tomo|libro|book)\.?\s*(?:n(?:[º°o]\.?)?\s*)?#?\s*(\d+(?:[.,]\d+)?)$/i,
		/^(.*?)\s+#\s*(\d+(?:[.,]\d+)?)$/i,
	];

	for (const pattern of patterns) {
		const match =
			clean.match(
				pattern,
			);

		if (!match) {
			continue;
		}

		const series =
			cleanText(
				match[1],
			);

		const index =
			normalizeSeriesIndex(
				match[2],
			);

		if (
			series &&
			index
		) {
			return {
				series,
				seriesIndex:
					index,
				explicit:
					true,
			};
		}
	}

	return undefined;
}

function parseAmbiguousSeries(
	value: string,
): SeriesParse | undefined {
	const clean =
		value.trim();

	const match =
		clean.match(
			/^(.*?)\s+(\d+(?:[.,]\d+)?)$/,
		);

	if (!match) {
		return undefined;
	}

	const series =
		cleanText(
			match[1],
		);

	const index =
		normalizeSeriesIndex(
			match[2],
		);

	if (
		!series ||
		!index
	) {
		return undefined;
	}

	/*
	 * A trailing year is far more likely to
	 * be part of the title than a series
	 * number. Keep it only as a title.
	 */
	const numeric =
		Number(index);

	if (
		Number.isInteger(numeric) &&
		numeric >= 1800 &&
		numeric <= 2100
	) {
		return undefined;
	}

	return {
		series,
		seriesIndex:
			index,
		explicit:
			false,
	};
}

function deduplicate(
	hypotheses:
		SearchHypothesis[],
): SearchHypothesis[] {
	const map =
		new Map<
			string,
			SearchHypothesis
		>();

	for (
		const hypothesis
		of hypotheses
	) {
		const h =
			hypothesis.hints;

		const key = [
			hypothesis.kind,
			normalizeText(h.title),
			normalizeText(h.author),
			normalizeText(h.series),
			h.seriesIndex ?? "",
			h.isbn ?? "",
		].join("|");

		const current =
			map.get(key);

		if (
			!current ||
			hypothesis.confidence >
				current.confidence
		) {
			map.set(
				key,
				hypothesis,
			);
		}
	}

	return [...map.values()]
		.sort(
			(a, b) =>
				b.confidence -
				a.confidence,
		);
}

function addBookPartHypotheses(
	target:
		SearchHypothesis[],
	bookPart: string,
	author:
		string | undefined,
	split: boolean,
): void {
	const explicit =
		parseExplicitSeries(
			bookPart,
		);

	const ambiguous =
		parseAmbiguousSeries(
			bookPart,
		);

	if (explicit) {
		target.push({
			kind:
				"series",

			origin:
				"filename-series-explicit",

			confidence:
				split
					? 0.99
					: 0.96,

			hints: {
				series:
					explicit.series,

				seriesIndex:
					explicit
						.seriesIndex,

				author,
			},
		});

		/*
		 * Keep a low-confidence title
		 * hypothesis as a safety net.
		 * We never assume the series parse
		 * is infallible.
		 */
		target.push({
			kind:
				"title",

			origin:
				split
					? "filename-split"
					: "filename-full",

			confidence:
				0.35,

			hints: {
				title:
					bookPart,
				author,
			},
		});

		return;
	}

	target.push({
		kind:
			"title",

		origin:
			split
				? "filename-split"
				: "filename-full",

		confidence:
			split
				? 0.9
				: 0.84,

		hints: {
			title:
				bookPart,
			author,
		},
	});

	if (ambiguous) {
		/*
		 * "Area 51", "1984", etc. must NOT
		 * automatically become series.
		 *
		 * This hypothesis can only win if
		 * an external provider positively
		 * confirms series + position.
		 */
		target.push({
			kind:
				"series",

			origin:
				"filename-series-ambiguous",

			confidence:
				split
					? 0.48
					: 0.35,

			hints: {
				series:
					ambiguous.series,

				seriesIndex:
					ambiguous
						.seriesIndex,

				author,
			},
		});
	}
}

export function parseFileName(
	fileName: string,
): ParsedFileName {
	const baseName =
		stripExtension(
			fileName,
		);

	const hypotheses:
		SearchHypothesis[] =
			[];

	/*
	 * Hypothesis 1:
	 * the entire filename is the title.
	 *
	 * This is important for:
	 *   1984.epub
	 *   Area 51.epub
	 *   The Girl - Who Lived.epub
	 */
	addBookPartHypotheses(
		hypotheses,
		baseName,
		undefined,
		false,
	);

	/*
	 * Hypothesis 2:
	 * "left - right" may be
	 * "title - author".
	 *
	 * It is only a hypothesis, never a
	 * fact. The full-title hypothesis
	 * above remains available.
	 */
	const parts =
		baseName
			.split(
				/\s+(?:-|–|—)\s+/,
			)
			.map(
				(part) =>
					part.trim(),
			)
			.filter(Boolean);

	if (parts.length >= 2) {
		const possibleAuthor =
			cleanText(
				parts[
					parts.length -
						1
				],
			);

		const possibleBookPart =
			cleanText(
				parts
					.slice(
						0,
						-1,
					)
					.join(" - "),
			);

		if (
			possibleBookPart &&
			possibleAuthor
		) {
			addBookPartHypotheses(
				hypotheses,
				possibleBookPart,
				possibleAuthor,
				true,
			);
		}
	}

	/*
	 * If the split hypothesis found an
	 * explicit series marker, the complete
	 * filename (which also contains the
	 * possible author) is a poor title
	 * fallback. Keep it only as a weak
	 * safety hypothesis for external
	 * matching.
	 */
	if (
		hypotheses.some(
			(hypothesis) =>
				hypothesis.origin ===
					"filename-series-explicit",
		)
	) {
		for (const hypothesis of hypotheses) {
			if (
				hypothesis.origin ===
					"filename-full"
			) {
				hypothesis.confidence =
					Math.min(
						hypothesis.confidence,
						0.35,
					);
			}
		}
	}

	return {
		baseName,
		hypotheses:
			deduplicate(
				hypotheses,
			),
	};
}
