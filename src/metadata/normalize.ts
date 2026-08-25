import type {
	BookMetadata,
	BookSearchHints,
} from "./types";

const BAD_VALUES = new Set([
	"",
	"unknown",
	"unknown author",
	"unknown title",
	"untitled",
	"no title",
	"no author",
	"desconocido",
	"desconocida",
	"autor desconocido",
	"autora desconocida",
	"sin autor",
	"sin autora",
	"sin titulo",
	"sin título",
	"none",
	"null",
	"n a",
	"n/a",
]);

const STOP_WORDS = new Set([
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"unos",
	"unas",
	"de",
	"del",
	"al",
	"y",
	"e",
	"en",
	"the",
	"a",
	"an",
	"of",
	"and",
	"in",
]);

export function clamp(
	value: number,
	min = 0,
	max = 100,
): number {
	return Math.max(
		min,
		Math.min(
			max,
			value,
		),
	);
}

export function cleanText(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const clean = value
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/[ \t]+/g, " ")
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return clean || undefined;
}

export function normalizeText(
	value?: string,
): string {
	return (value ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export function isMeaningful(
	value?: string,
): boolean {
	const normalized =
		normalizeText(value);

	return (
		normalized.length > 0 &&
		!BAD_VALUES.has(
			normalized,
		)
	);
}

function isValidIsbn10(value: string): boolean {
	if (!/^\d{9}[\dX]$/.test(value)) {
		return false;
	}

	let sum = 0;

	for (let index = 0; index < 10; index++) {
		const char = value[index];
		const digit = char === "X" ? 10 : Number(char);

		sum += digit * (10 - index);
	}

	return sum % 11 === 0;
}

function isValidIsbn13(value: string): boolean {
	if (!/^\d{13}$/.test(value)) {
		return false;
	}

	let sum = 0;

	for (let index = 0; index < 12; index++) {
		const digit = Number(value[index]);
		sum += digit * (index % 2 === 0 ? 1 : 3);
	}

	const expected = (10 - (sum % 10)) % 10;
	return expected === Number(value[12]);
}

export function normalizeIsbn(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const clean = value
		.toUpperCase()
		.replace(/[^0-9X]/g, "");

	if (clean.length === 10) {
		return isValidIsbn10(clean)
			? clean
			: undefined;
	}

	if (clean.length === 13) {
		return isValidIsbn13(clean)
			? clean
			: undefined;
	}

	return undefined;
}

export function normalizeSeriesIndex(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const clean = value
		.trim()
		.replace(",", ".");

	const number =
		Number(clean);

	if (
		!Number.isFinite(number) ||
		number < 0
	) {
		return undefined;
	}

	return Number.isInteger(number)
		? String(number)
		: String(number);
}

export function sameSeriesIndex(
	left?: string,
	right?: string,
): boolean {
	const a =
		normalizeSeriesIndex(left);

	const b =
		normalizeSeriesIndex(right);

	return (
		!!a &&
		!!b &&
		a === b
	);
}

function usefulWords(
	value?: string,
): string[] {
	return normalizeText(value)
		.split(" ")
		.filter(
			(word) =>
				word.length > 1 &&
				!STOP_WORDS.has(
					word,
				),
		);
}

export function wordSimilarity(
	left?: string,
	right?: string,
): number {
	const aText =
		normalizeText(left);

	const bText =
		normalizeText(right);

	if (!aText || !bText) {
		return 0;
	}

	if (aText === bText) {
		return 1;
	}

	const a =
		new Set(
			usefulWords(left),
		);

	const b =
		new Set(
			usefulWords(right),
		);

	if (
		a.size === 0 ||
		b.size === 0
	) {
		return 0;
	}

	let intersection = 0;

	for (const word of a) {
		if (b.has(word)) {
			intersection++;
		}
	}

	const union =
		new Set([
			...a,
			...b,
		]).size;

	return union > 0
		? intersection / union
		: 0;
}

export function titleSimilarity(
	left?: string,
	right?: string,
): number {
	const a =
		normalizeText(left);

	const b =
		normalizeText(right);

	if (!a || !b) {
		return 0;
	}

	if (a === b) {
		return 1;
	}

	if (
		a.length >= 8 &&
		b.length >= 8 &&
		(
			a.includes(b) ||
			b.includes(a)
		)
	) {
		return 0.92;
	}

	return wordSimilarity(
		left,
		right,
	);
}

export function authorSimilarity(
	left?: string,
	right?: string,
): number {
	const a =
		normalizeText(left);

	const b =
		normalizeText(right);

	if (!a || !b) {
		return 0;
	}

	if (a === b) {
		return 1;
	}

	if (
		a.includes(b) ||
		b.includes(a)
	) {
		return 0.9;
	}

	const aParts =
		a.split(" ");

	const bParts =
		b.split(" ");

	const aLast =
		aParts[
			aParts.length - 1
		];

	const bLast =
		bParts[
			bParts.length - 1
		];

	if (
		aLast &&
		bLast &&
		aLast === bLast
	) {
		return 0.78;
	}

	return wordSimilarity(
		a,
		b,
	);
}

export function languageMatches(
	expected?: string,
	actual?: string,
): boolean {
	if (
		!expected ||
		!actual
	) {
		return true;
	}

	const a =
		expected
			.slice(0, 2)
			.toLowerCase();

	const b =
		actual
			.slice(0, 2)
			.toLowerCase();

	return a === b;
}

export interface StructuredSeriesTitle {
	title: string;
	series: string;
	seriesIndex: string;
}

export function parseStructuredSeriesTitle(
	value?: string,
): StructuredSeriesTitle | undefined {
	const clean =
		cleanText(value);

	if (!clean) {
		return undefined;
	}

	/*
	 * This parser is deliberately stricter
	 * than filename parsing. It is for titles
	 * returned by catalog providers that embed
	 * series information in a display title.
	 *
	 * Accepted examples:
	 *   Rose Hill 01 - Wild Love
	 *   Rose Hill #1 - Wild Love
	 *   Rose Hill Book 1: Wild Love
	 *   Rose Hill Vol. 1 — Wild Love
	 *
	 * NOT accepted:
	 *   Area 51
	 *   Catch-22
	 *   1984
	 *   Area 51 - Annie Jacobsen
	 */
	const explicitPatterns = [
		/^(.*?)\s+(?:book|libro|vol(?:ume|umen)?|tomo)\.?\s*(?:n(?:[º°o]\.?)?\s*)?#?\s*(\d+(?:[.,]\d+)?)\s*(?:-|–|—|:)\s*(.+)$/i,
		/^(.*?)\s+#\s*(\d+(?:[.,]\d+)?)\s*(?:-|–|—|:)\s*(.+)$/i,
	];

	for (const pattern of explicitPatterns) {
		const match =
			clean.match(pattern);

		if (!match) {
			continue;
		}

		const series =
			cleanText(match[1]);

		const seriesIndex =
			normalizeSeriesIndex(
				match[2],
			);

		const title =
			cleanText(match[3]);

		if (
			series &&
			seriesIndex &&
			seriesIndex !== "0" &&
			title
		) {
			return {
				title,
				series,
				seriesIndex,
			};
		}
	}

	/*
	 * A zero-padded ordinal immediately before
	 * a separator is a common catalogue format:
	 *
	 *   Rose Hill 01 - Wild Love
	 *
	 * Requiring the leading zero is intentional.
	 * Plain "Area 51 - ..." does not match.
	 */
	const padded =
		clean.match(
			/^(.*?)\s+(0\d{1,2})\s*(?:-|–|—|:)\s*(.+)$/,
		);

	if (padded) {
		const series =
			cleanText(padded[1]);

		const seriesIndex =
			normalizeSeriesIndex(
				padded[2],
			);

		const title =
			cleanText(padded[3]);

		if (
			series &&
			seriesIndex &&
			seriesIndex !== "0" &&
			title
		) {
			return {
				title,
				series,
				seriesIndex,
			};
		}
	}

	return undefined;
}

export function normalizePublicationDate(
	value?: string,
): string | undefined {
	const clean = cleanText(value);

	if (!clean) {
		return undefined;
	}

	if (/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(clean)) {
		return isPlausiblePublicationDate(clean)
			? clean
			: undefined;
	}

	const yearOnly = clean.match(/\b(1\d{3}|20\d{2})\b/);
	const parsed = Date.parse(clean);

	if (Number.isFinite(parsed)) {
		const date = new Date(parsed);
		const iso = date.toISOString().slice(0, 10);

		if (isPlausiblePublicationDate(iso)) {
			return iso;
		}
	}

	if (yearOnly && isPlausiblePublicationDate(yearOnly[1])) {
		return yearOnly[1];
	}

	return undefined;
}

export function isPlausiblePublicationDate(
	value?: string,
): boolean {
	if (!value) {
		return false;
	}

	const clean =
		value.trim();

	/*
	 * Full timestamps in EPUB metadata are often
	 * converter/import timestamps, not publication
	 * dates. We only accept YYYY, YYYY-MM or
	 * YYYY-MM-DD.
	 */
	if (/T\d{2}:\d{2}/i.test(clean)) {
		return false;
	}

	const match =
		clean.match(
			/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/,
		);

	if (!match) {
		return false;
	}

	const year =
		Number(match[1]);

	const maxYear =
		new Date()
			.getUTCFullYear() + 2;

	/*
	 * This is edition metadata for an EPUB, not a
	 * historical-work dating system. Years such as
	 * 0101 are almost certainly sentinel/corrupt data.
	 */
	if (
		year < 1000 ||
		year > maxYear
	) {
		return false;
	}

	if (!match[2]) {
		return true;
	}

	const month =
		Number(match[2]);

	if (month < 1 || month > 12) {
		return false;
	}

	if (!match[3]) {
		return true;
	}

	const day =
		Number(match[3]);

	const maxDay =
		new Date(
			Date.UTC(
				year,
				month,
				0,
			),
		).getUTCDate();

	return (
		day >= 1 &&
		day <= maxDay
	);
}

export function scoreTitleMatch(
	expected: BookSearchHints,
	candidate: BookMetadata,
): number {
	if (!expected.title) {
		return 0;
	}

	const titleScore =
		titleSimilarity(
			expected.title,
			candidate.title,
		);

	if (titleScore <= 0) {
		return 0;
	}

	let score: number;

	if (expected.author) {
		const authorScore =
			authorSimilarity(
				expected.author,
				candidate.author,
			);

		score =
			titleScore * 65 +
			authorScore * 30;

		if (
			expected.author &&
			candidate.author &&
			authorScore < 0.45
		) {
			score -= 25;
		}
	} else {
		/*
		 * With no author to corroborate,
		 * title similarity carries almost
		 * the whole score.
		 */
		score =
			titleScore * 95;
	}

	if (
		expected.language &&
		candidate.language &&
		languageMatches(
			expected.language,
			candidate.language,
		)
	) {
		score += 3;
	}

	if (candidate.description) {
		score += 2;
	}

	return Math.round(
		clamp(score),
	);
}

export function scoreSeriesMatch(
	expected: BookSearchHints,
	candidate: BookMetadata,
): number {
	if (
		!expected.series ||
		!expected.seriesIndex ||
		!candidate.series ||
		!candidate.seriesIndex
	) {
		return 0;
	}

	const seriesScore =
		titleSimilarity(
			expected.series,
			candidate.series,
		);

	if (
		seriesScore < 0.55 ||
		!sameSeriesIndex(
			expected.seriesIndex,
			candidate.seriesIndex,
		)
	) {
		return 0;
	}

	let score =
		seriesScore * 55 +
		30;

	if (expected.author) {
		const authorScore =
			authorSimilarity(
				expected.author,
				candidate.author,
			);

		score +=
			authorScore * 15;

		if (
			candidate.author &&
			authorScore < 0.45
		) {
			score -= 20;
		}
	}

	return Math.round(
		clamp(score),
	);
}

export function mergeSubjects(
	...lists: Array<
		string[] | undefined
	>
): string[] | undefined {
	const seen =
		new Set<string>();

	const result:
		string[] = [];

	for (const list of lists) {
		for (
			const value
			of list ?? []
		) {
			const clean =
				cleanText(value);

			if (!clean) {
				continue;
			}

			const normalized =
				normalizeText(clean);

			if (
				normalized &&
				!seen.has(
					normalized,
				)
			) {
				seen.add(
					normalized,
				);

				result.push(
					clean,
				);
			}
		}
	}

	return result.length
		? result
		: undefined;
}
