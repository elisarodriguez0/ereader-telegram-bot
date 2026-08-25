import type {
	BookMetadata,
	FilenameMetadata,
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
	"n/a",
]);

export function cleanText(
	value?: string,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const clean = value
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
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
		.replace(
			/\b(vol(?:umen)?|tomo|book|libro)\.?\s*/g,
			"",
		)
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export function isMeaningful(
	value?: string,
): boolean {
	if (!value) {
		return false;
	}

	return !BAD_VALUES.has(
		normalizeText(value),
	);
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

	if (
		clean.length !== 10 &&
		clean.length !== 13
	) {
		return undefined;
	}

	return clean;
}

export function inferFromFileName(
	fileName: string,
): FilenameMetadata {
	const base = fileName
		.replace(/\.epub$/i, "")
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const parts = base
		.split(/\s+-\s+/)
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length >= 2) {
		return {
			title: parts
				.slice(0, parts.length - 1)
				.join(" - "),

			author:
				parts[
					parts.length - 1
				],
		};
	}

	return {
		title: isMeaningful(base)
			? base
			: undefined,
	};
}

export function wordSimilarity(
	left?: string,
	right?: string,
): number {
	const a = normalizeText(left);
	const b = normalizeText(right);

	if (!a || !b) {
		return 0;
	}

	if (a === b) {
		return 1;
	}

	if (
		a.length >= 7 &&
		b.length >= 7 &&
		(a.includes(b) ||
			b.includes(a))
	) {
		return 0.9;
	}

	const aWords = new Set(
		a.split(" ").filter(Boolean),
	);

	const bWords = new Set(
		b.split(" ").filter(Boolean),
	);

	const usefulA = [...aWords].filter(
		(word) => word.length > 1,
	);

	const usefulB = [...bWords].filter(
		(word) => word.length > 1,
	);

	const union = new Set([
		...usefulA,
		...usefulB,
	]);

	if (union.size === 0) {
		return 0;
	}

	let common = 0;

	for (const word of usefulA) {
		if (bWords.has(word)) {
			common++;
		}
	}

	return common / union.size;
}

export function authorSimilarity(
	left?: string,
	right?: string,
): number {
	const a = normalizeText(left);
	const b = normalizeText(right);

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

	const aParts = a.split(" ");
	const bParts = b.split(" ");

	const aLast =
		aParts[aParts.length - 1];

	const bLast =
		bParts[bParts.length - 1];

	if (
		aLast &&
		bLast &&
		aLast === bLast
	) {
		return 0.75;
	}

	return wordSimilarity(a, b);
}

export function scoreBookMatch(
	expected: FilenameMetadata & {
		isbn?: string;
	},
	candidate: BookMetadata,
): number {
	const expectedIsbn =
		normalizeIsbn(expected.isbn);

	const candidateIsbn =
		normalizeIsbn(candidate.isbn);

	if (
		expectedIsbn &&
		candidateIsbn &&
		expectedIsbn === candidateIsbn
	) {
		return 100;
	}

	let score = 0;

	const titleScore =
		wordSimilarity(
			expected.title,
			candidate.title,
		);

	score += titleScore * 55;

	if (
		expected.author &&
		candidate.author
	) {
		score +=
			authorSimilarity(
				expected.author,
				candidate.author,
			) * 35;
	}

	if (
		candidate.language &&
		/^es(?:-|$)/i.test(
			candidate.language,
		)
	) {
		score += 5;
	}

	if (candidate.description) {
		score += 2;
	}

	if (candidate.series) {
		score += 3;
	}

	return Math.min(
		100,
		Math.round(score),
	);
}

export function mergeSubjects(
	...lists: Array<
		string[] | undefined
	>
): string[] | undefined {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const list of lists) {
		for (const value of list ?? []) {
			const clean = cleanText(value);

			if (!clean) {
				continue;
			}

			const normalized =
				normalizeText(clean);

			if (
				normalized &&
				!seen.has(normalized)
			) {
				seen.add(normalized);
				result.push(clean);
			}
		}
	}

	return result.length
		? result
		: undefined;
}