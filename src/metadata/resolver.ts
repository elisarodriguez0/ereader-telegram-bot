import {
	authorSimilarity,
	isMeaningful,
	isPlausiblePublicationDate,
	mergeSubjects,
	normalizeIsbn,
	parseStructuredSeriesTitle,
	stripEditionNoise,
	titleSimilarity,
} from "./normalize";

import { parseFileName } from "./filename";
import { lookupGoodreads } from "./providers/goodreads";
import { lookupGoogleBooks } from "./providers/google-books";
import { lookupLectulandia } from "./providers/lectulandia";
import { lookupOpenLibrary } from "./providers/open-library";

import type {
	BookMetadata,
	MetadataCandidate,
	MetadataResolverOptions,
	MetadataSource,
	ResolvedMetadata,
	SearchHypothesis,
} from "./types";

const PREFERRED_LANGUAGE = "es";

function isSpanishLanguage(value?: string): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase().replace(/^\/languages\//, "").trim();
	return normalized === "es" || normalized === "es-es" || normalized === "spa";
}

function looksSpanishText(value?: string): boolean {
	if (!value) return false;
	const text = ` ${value.toLowerCase()} `;
	if (/[áéíóúñ¿¡]/i.test(value)) return true;
	const markers = [
		" el ", " la ", " los ", " las ", " un ", " una ",
		" de ", " del ", " que ", " y ", " para ", " con ",
		" por ", " su ", " sus ", " se ", " en ", " como ",
		" cuando ", " pero ", " más ", " amor ", " vida ",
	];
	let hits = 0;
	for (const marker of markers) if (text.includes(marker)) hits++;
	return hits >= 3;
}

function spanishSafeDescription(
	value: string | undefined,
	source: MetadataSource,
): string | undefined {
	if (!value) return undefined;
	if (source === "lectulandia") return value;
	return looksSpanishText(value) ? value : undefined;
}

function setField<K extends keyof BookMetadata>(
	target: BookMetadata,
	sources: ResolvedMetadata["sources"],
	field: K,
	value: BookMetadata[K],
	source: MetadataSource,
	overwrite = false,
): void {
	if (value === undefined || value === null) return;
	if (!overwrite && target[field] !== undefined) return;
	target[field] = value;
	sources[field] = source;
}

function canonicalizeCandidate(
	candidate: MetadataCandidate | undefined,
): MetadataCandidate | undefined {
	if (!candidate) return undefined;
	const metadata = { ...candidate.metadata };
	metadata.title = stripEditionNoise(metadata.title);
	const structured = parseStructuredSeriesTitle(metadata.title);
	if (structured) {
		console.log("[Metadata] structured provider title:", JSON.stringify({
			original: metadata.title,
			title: structured.title,
			series: structured.series,
			seriesIndex: structured.seriesIndex,
			source: candidate.source,
		}));
		metadata.title = structured.title;
		if (!metadata.series) metadata.series = structured.series;
		if (!metadata.seriesIndex) metadata.seriesIndex = structured.seriesIndex;
	}
	if (metadata.published && !isPlausiblePublicationDate(metadata.published)) {
		metadata.published = undefined;
	}
	return { ...candidate, metadata };
}

function deduplicateHypotheses(hypotheses: SearchHypothesis[]): SearchHypothesis[] {
	const map = new Map<string, SearchHypothesis>();
	for (const hypothesis of hypotheses) {
		const h = hypothesis.hints;
		const key = JSON.stringify({
			kind: hypothesis.kind,
			title: h.title?.toLowerCase(),
			author: h.author?.toLowerCase(),
			series: h.series?.toLowerCase(),
			seriesIndex: h.seriesIndex,
			isbn: normalizeIsbn(h.isbn),
		});
		const previous = map.get(key);
		if (!previous || hypothesis.confidence > previous.confidence) map.set(key, hypothesis);
	}
	return [...map.values()];
}

function buildIdentityHypotheses(
	existing: BookMetadata,
	originalFileName: string,
): SearchHypothesis[] {
	const parsed = parseFileName(originalFileName);
	const hypotheses: SearchHypothesis[] = [];
	const isbn = normalizeIsbn(existing.isbn);
	if (isbn) {
		hypotheses.push({
			kind: "isbn",
			origin: "embedded-isbn",
			confidence: 1,
			hints: { isbn, language: PREFERRED_LANGUAGE },
		});
	}
	if (isMeaningful(existing.title)) {
		const hasAuthor = isMeaningful(existing.author);
		hypotheses.push({
			kind: "title",
			origin: "embedded-title",
			confidence: hasAuthor ? 0.94 : 0.78,
			hints: {
				title: existing.title,
				author: hasAuthor ? existing.author : undefined,
				language: PREFERRED_LANGUAGE,
			},
		});
	}
	for (const hypothesis of parsed.hypotheses) {
		hypotheses.push({
			...hypothesis,
			hints: { ...hypothesis.hints, language: PREFERRED_LANGUAGE },
		});
	}
	return deduplicateHypotheses(hypotheses);
}

function minimumIdentityScore(hypothesis: SearchHypothesis): number {
	if (hypothesis.kind === "isbn") return 99;
	if (hypothesis.origin === "filename-series-explicit") return 78;
	if (hypothesis.origin === "filename-series-ambiguous") return 94;
	if (hypothesis.kind === "title") {
		if (hypothesis.hints.author) return 78;
		return 90;
	}
	return 90;
}

function isAcceptedCandidate(candidate: MetadataCandidate): boolean {
	const hypothesis = candidate.matchedHypothesis;
	if (!hypothesis) return false;
	return candidate.score >= minimumIdentityScore(hypothesis);
}

function providerBonus(source: MetadataSource): number {
	switch (source) {
		case "lectulandia": return 3;
		case "google-books": return 1;
		default: return 0;
	}
}

function chooseBestCandidate(candidates: MetadataCandidate[]): MetadataCandidate | undefined {
	return candidates
		.filter(isAcceptedCandidate)
		.sort((a, b) =>
			(b.score + providerBonus(b.source)) -
			(a.score + providerBonus(a.source)),
		)[0];
}

function orderHypothesesForIdentity(hypotheses: SearchHypothesis[]): SearchHypothesis[] {
	const originRank: Partial<Record<SearchHypothesis["origin"], number>> = {
		"embedded-isbn": 100,
		"discovered-isbn": 100,
		"filename-series-explicit": 95,
		"filename-split": 90,
		"filename-full": 80,
		"embedded-title": 75,
		"filename-series-ambiguous": 50,
	};
	return [...hypotheses].sort((a, b) =>
		(originRank[b.origin] ?? 0) - (originRank[a.origin] ?? 0) ||
		b.confidence - a.confidence,
	);
}

async function findLectulandiaCandidates(
	hypotheses: SearchHypothesis[],
	options: MetadataResolverOptions,
): Promise<MetadataCandidate[]> {
	const results: MetadataCandidate[] = [];
	const eligible = orderHypothesesForIdentity(hypotheses)
		.filter((hypothesis) => hypothesis.kind !== "isbn")
		.slice(0, 4);
	for (const hypothesis of eligible) {
		const candidate = canonicalizeCandidate(
			await lookupLectulandia(hypothesis, options.lectulandiaBaseUrl),
		);
		if (candidate) {
			results.push(candidate);
			if (isAcceptedCandidate(candidate) && candidate.score >= 97) break;
		}
	}
	return results;
}

async function findGoogleCandidates(
	hypotheses: SearchHypothesis[],
	options: MetadataResolverOptions,
): Promise<MetadataCandidate[]> {
	const results: MetadataCandidate[] = [];
	const eligible = orderHypothesesForIdentity(hypotheses)
		.filter((hypothesis) => {
			if (hypothesis.kind !== "series") return true;
			if (
				hypothesis.origin === "filename-series-ambiguous" &&
				!hypothesis.hints.author
			) return false;
			return true;
		})
		.slice(0, 5);
	for (const hypothesis of eligible) {
		const candidate = canonicalizeCandidate(
			await lookupGoogleBooks(hypothesis, options.googleBooksApiKey),
		);
		if (candidate) {
			results.push(candidate);
			if (isAcceptedCandidate(candidate) && candidate.score >= 99) break;
		}
	}
	return results;
}

async function findOpenLibraryCandidates(
	hypotheses: SearchHypothesis[],
): Promise<MetadataCandidate[]> {
	const results: MetadataCandidate[] = [];
	const eligible = orderHypothesesForIdentity(hypotheses)
		.filter((hypothesis) => hypothesis.kind !== "series")
		.slice(0, 4);
	for (const hypothesis of eligible) {
		const candidate = canonicalizeCandidate(await lookupOpenLibrary(hypothesis));
		if (candidate) {
			results.push(candidate);
			if (isAcceptedCandidate(candidate) && candidate.score >= 99) break;
		}
	}
	return results;
}

function bestFilenameTitle(
	hypotheses: SearchHypothesis[],
): SearchHypothesis | undefined {
	return hypotheses
		.filter((hypothesis) =>
			hypothesis.kind === "title" &&
			hypothesis.origin === "filename-full" &&
			hypothesis.confidence >= 0.7,
		)
		.sort((a, b) => b.confidence - a.confidence)[0];
}

function candidateStronglyBackedByFilename(candidate: MetadataCandidate): boolean {
	const hypothesis = candidate.matchedHypothesis;
	if (!hypothesis) return false;
	return (
		hypothesis.origin === "filename-series-explicit" ||
		hypothesis.origin === "filename-series-ambiguous" ||
		hypothesis.origin === "filename-split" ||
		hypothesis.origin === "filename-full"
	);
}

function shouldReplaceTitle(
	existingTitle: string | undefined,
	candidate: MetadataCandidate,
): boolean {
	const candidateTitle = candidate.metadata.title;
	if (!isMeaningful(candidateTitle)) return false;
	if (!isMeaningful(existingTitle)) return true;
	if (titleSimilarity(existingTitle, candidateTitle) >= 0.8) return true;
	return candidateStronglyBackedByFilename(candidate) && isAcceptedCandidate(candidate);
}

function shouldReplaceAuthor(
	existingAuthor: string | undefined,
	candidate: MetadataCandidate,
): boolean {
	const candidateAuthor = candidate.metadata.author;
	if (!isMeaningful(candidateAuthor)) return false;
	if (!isMeaningful(existingAuthor)) return true;
	if (authorSimilarity(existingAuthor, candidateAuthor) >= 0.8) return true;
	const hypothesis = candidate.matchedHypothesis;
	return !!hypothesis?.hints.author &&
		candidateStronglyBackedByFilename(candidate) &&
		isAcceptedCandidate(candidate);
}

function deduplicateMatches(candidates: MetadataCandidate[]): MetadataCandidate[] {
	const map = new Map<MetadataSource, MetadataCandidate>();
	for (const candidate of candidates) {
		const previous = map.get(candidate.source);
		if (!previous || candidate.score > previous.score) map.set(candidate.source, candidate);
	}
	return [...map.values()].sort((a, b) => b.score - a.score);
}

function addExistingMetadata(
	result: BookMetadata,
	sources: ResolvedMetadata["sources"],
	existing: BookMetadata,
): void {
	const structuredTitle = parseStructuredSeriesTitle(existing.title);
	if (structuredTitle) {
		setField(result, sources, "title", structuredTitle.title, "epub");
		if (!isMeaningful(existing.series)) {
			setField(result, sources, "series", structuredTitle.series, "epub");
		}
		if (!isMeaningful(existing.seriesIndex)) {
			setField(result, sources, "seriesIndex", structuredTitle.seriesIndex, "epub");
		}
	} else if (isMeaningful(existing.title)) {
		setField(result, sources, "title", existing.title, "epub");
	}

	if (isMeaningful(existing.author)) setField(result, sources, "author", existing.author, "epub");
	if (isMeaningful(existing.description) && looksSpanishText(existing.description)) {
		setField(result, sources, "description", existing.description, "epub");
	}
	if (normalizeIsbn(existing.isbn)) {
		setField(result, sources, "isbn", normalizeIsbn(existing.isbn), "epub");
	}
	if (isMeaningful(existing.publisher)) setField(result, sources, "publisher", existing.publisher, "epub");
	if (isPlausiblePublicationDate(existing.published)) {
		setField(result, sources, "published", existing.published, "epub");
	}
	if (existing.pageCount && existing.pageCount > 0) {
		setField(result, sources, "pageCount", existing.pageCount, "epub");
	}
	if (isMeaningful(existing.series)) setField(result, sources, "series", existing.series, "epub");
	if (isMeaningful(existing.seriesIndex)) setField(result, sources, "seriesIndex", existing.seriesIndex, "epub");
	if (existing.subjects?.length) {
		const spanishSubjects = existing.subjects.filter((subject) => {
			const normalized = subject.toLowerCase().trim();
			return /[áéíóúñ]/i.test(subject) || [
				"ficción", "novela", "fantástico", "fantasía",
				"romance", "juvenil", "intriga", "terror",
				"misterio", "aventura", "aventuras",
			].includes(normalized);
		});
		if (spanishSubjects.length) setField(result, sources, "subjects", spanishSubjects, "epub");
	}
}

function applyIdentityCandidate(
	result: BookMetadata,
	sources: ResolvedMetadata["sources"],
	identity: MetadataCandidate,
): boolean {
	const metadata = identity.metadata;
	let identityChanged = false;

	if (metadata.title && shouldReplaceTitle(result.title, identity)) {
		if (result.title !== metadata.title) identityChanged = true;
		setField(result, sources, "title", metadata.title, identity.source, true);
	}
	if (metadata.author && shouldReplaceAuthor(result.author, identity)) {
		if (result.author !== metadata.author) identityChanged = true;
		setField(result, sources, "author", metadata.author, identity.source, true);
	}
	if (metadata.series) setField(result, sources, "series", metadata.series, identity.source, true);
	if (metadata.seriesIndex) setField(result, sources, "seriesIndex", metadata.seriesIndex, identity.source, true);

	if (identity.source === "lectulandia" && metadata.description) {
		setField(result, sources, "description", metadata.description, "lectulandia", true);
	} else if (metadata.description && (!result.description || identityChanged)) {
		setField(
			result,
			sources,
			"description",
			spanishSafeDescription(metadata.description, identity.source),
			identity.source,
			identityChanged,
		);
	}
	if (identity.source === "lectulandia" && metadata.subjects?.length) {
		setField(result, sources, "subjects", metadata.subjects, "lectulandia", true);
	}
	return identityChanged;
}

function enrichmentAccepted(
	candidate: MetadataCandidate | undefined,
): candidate is MetadataCandidate {
	if (!candidate) return false;
	const hypothesis = candidate.matchedHypothesis;
	if (!hypothesis) return false;
	const minimum = hypothesis.hints.author ? 78 : 92;
	return candidate.score >= minimum;
}

function applyConfirmedStructuredSeriesTitle(
	result: BookMetadata,
	sources: ResolvedMetadata["sources"],
	candidate: MetadataCandidate,
): boolean {
	const currentStructured = parseStructuredSeriesTitle(result.title);
	if (
		!currentStructured ||
		!candidate.metadata.title ||
		!candidate.metadata.series ||
		!candidate.metadata.seriesIndex
	) return false;
	if (
		titleSimilarity(currentStructured.title, candidate.metadata.title) < 0.92 ||
		titleSimilarity(currentStructured.series, candidate.metadata.series) < 0.92 ||
		currentStructured.seriesIndex !== candidate.metadata.seriesIndex
	) return false;

	setField(result, sources, "title", candidate.metadata.title, candidate.source, true);
	setField(result, sources, "series", candidate.metadata.series, candidate.source, true);
	setField(result, sources, "seriesIndex", candidate.metadata.seriesIndex, candidate.source, true);
	console.log("[Metadata] applied confirmed series:", JSON.stringify({
		title: candidate.metadata.title,
		series: candidate.metadata.series,
		seriesIndex: candidate.metadata.seriesIndex,
		source: candidate.source,
		score: candidate.score,
	}));
	return true;
}

function applyBibliographicEnrichment(
	result: BookMetadata,
	sources: ResolvedMetadata["sources"],
	candidate: MetadataCandidate,
	identityChanged: boolean,
	allowOverwrite: boolean,
): void {
	const metadata = candidate.metadata;
	applyConfirmedStructuredSeriesTitle(result, sources, candidate);
	const overwrite = identityChanged && allowOverwrite;
	setField(result, sources, "isbn", metadata.isbn, candidate.source, overwrite);
	setField(result, sources, "publisher", metadata.publisher, candidate.source, overwrite);
	setField(result, sources, "pageCount", metadata.pageCount, candidate.source, overwrite);
	if (
		metadata.published &&
		isPlausiblePublicationDate(metadata.published) &&
		(!result.published || !isPlausiblePublicationDate(result.published) || overwrite)
	) {
		setField(result, sources, "published", metadata.published, candidate.source, true);
	}
	const candidateDescription = spanishSafeDescription(metadata.description, candidate.source);
	if (!result.description && candidateDescription) {
		setField(result, sources, "description", candidateDescription, candidate.source);
	}
}

function applyGoodreadsEnrichment(
	result: BookMetadata,
	sources: ResolvedMetadata["sources"],
	candidate: MetadataCandidate,
): void {
	const metadata = candidate.metadata;
	if (metadata.subjects?.length) {
		result.subjects = mergeSubjects(metadata.subjects, result.subjects);
		sources.subjects = "goodreads";
	}
	if (metadata.series && !result.series) setField(result, sources, "series", metadata.series, "goodreads");
	if (metadata.seriesIndex && !result.seriesIndex) {
		setField(result, sources, "seriesIndex", metadata.seriesIndex, "goodreads");
	}
	const description = spanishSafeDescription(metadata.description, "goodreads");
	if (!result.description && description) setField(result, sources, "description", description, "goodreads");
}

function isbnCandidateCompatible(
	current: BookMetadata,
	candidate: MetadataCandidate,
): boolean {
	const metadata = candidate.metadata;
	if (metadata.language && !isSpanishLanguage(metadata.language)) return false;
	if (current.author && metadata.author) {
		const authorScore = authorSimilarity(current.author, metadata.author);
		if (authorScore < 0.5) return false;
	}
	if (current.title && metadata.title) {
		const titleScore = titleSimilarity(current.title, metadata.title);
		const authorScore = current.author && metadata.author
			? authorSimilarity(current.author, metadata.author)
			: 0;
		if (titleScore < 0.3 && authorScore < 0.8) return false;
	}
	return true;
}

function collectDiscoveredIsbn(
	result: BookMetadata,
	candidates: MetadataCandidate[],
): string | undefined {
	const direct = normalizeIsbn(result.isbn);
	if (direct) return direct;
	const ordered = [...candidates]
		.filter(isAcceptedCandidate)
		.sort((a, b) => b.score - a.score);
	for (const candidate of ordered) {
		const isbn = normalizeIsbn(candidate.metadata.isbn);
		if (isbn) return isbn;
	}
	return undefined;
}

function applyExactEditionCandidate(
	result: BookMetadata,
	sources: ResolvedMetadata["sources"],
	candidate: MetadataCandidate,
	primary: boolean,
): void {
	const metadata = candidate.metadata;
	if (primary) {
		if (metadata.title) setField(result, sources, "title", metadata.title, candidate.source, true);
		if (metadata.author) setField(result, sources, "author", metadata.author, candidate.source, true);
		if (metadata.isbn) {
			setField(result, sources, "isbn", normalizeIsbn(metadata.isbn), candidate.source, true);
		}
		if (metadata.publisher) setField(result, sources, "publisher", metadata.publisher, candidate.source, true);
		if (metadata.published && isPlausiblePublicationDate(metadata.published)) {
			setField(result, sources, "published", metadata.published, candidate.source, true);
		}
		if (metadata.pageCount && metadata.pageCount > 0) {
			setField(result, sources, "pageCount", metadata.pageCount, candidate.source, true);
		}
	} else {
		setField(result, sources, "isbn", normalizeIsbn(metadata.isbn), candidate.source);
		setField(result, sources, "publisher", metadata.publisher, candidate.source);
		if (metadata.published && isPlausiblePublicationDate(metadata.published)) {
			setField(result, sources, "published", metadata.published, candidate.source);
		}
		setField(result, sources, "pageCount", metadata.pageCount, candidate.source);
	}
	if (metadata.series) {
		setField(result, sources, "series", metadata.series, candidate.source, !result.series);
	}
	if (metadata.seriesIndex) {
		setField(result, sources, "seriesIndex", metadata.seriesIndex, candidate.source, !result.seriesIndex);
	}
	const exactDescription = spanishSafeDescription(metadata.description, candidate.source);
	if (
		exactDescription &&
		sources.description !== "lectulandia" &&
		(!result.description || primary)
	) {
		setField(result, sources, "description", exactDescription, candidate.source, primary);
	}
}

async function lookupExactIsbnCandidates(
	isbn: string,
	current: BookMetadata,
	options: MetadataResolverOptions,
): Promise<MetadataCandidate[]> {
	const hypothesis: SearchHypothesis = {
		kind: "isbn",
		origin: "discovered-isbn",
		confidence: 1,
		hints: { isbn, language: PREFERRED_LANGUAGE },
	};
	const [rawGoodreads, rawGoogle, rawOpenLibrary] = await Promise.all([
		lookupGoodreads(hypothesis),
		lookupGoogleBooks(hypothesis, options.googleBooksApiKey),
		lookupOpenLibrary(hypothesis),
	]);
	return [rawGoodreads, rawGoogle, rawOpenLibrary]
		.map(canonicalizeCandidate)
		.filter((candidate): candidate is MetadataCandidate =>
			!!candidate &&
			candidate.score === 100 &&
			isbnCandidateCompatible(current, candidate),
		);
}

async function lookupFinalLectulandia(
	result: BookMetadata,
	options: MetadataResolverOptions,
): Promise<MetadataCandidate | undefined> {
	if (!isMeaningful(result.title) || !isMeaningful(result.author)) return undefined;
	const hypothesis: SearchHypothesis = {
		kind: "title",
		origin: "canonical",
		confidence: 1,
		hints: {
			title: result.title,
			author: result.author,
			language: PREFERRED_LANGUAGE,
		},
	};
	const candidate = canonicalizeCandidate(
		await lookupLectulandia(hypothesis, options.lectulandiaBaseUrl),
	);
	if (!candidate || candidate.score < 85) return undefined;
	return candidate;
}

function seriesLooksSpanish(value?: string): boolean {
	if (!value) return false;
	if (/[áéíóúñ¿¡]/i.test(value)) return true;
	const normalized = ` ${value.toLowerCase()} `;
	return [
		" el ", " la ", " los ", " las ", " de ", " del ",
		" en ", " y ", " una ", " un ", " para ", " por ",
	].some((marker) => normalized.includes(marker));
}

function preferredSeriesCandidate(
	candidates: Array<MetadataCandidate | undefined>,
	seriesIndex?: string,
): MetadataCandidate | undefined {
	return candidates
		.filter((candidate): candidate is MetadataCandidate => {
			if (!candidate || !isAcceptedCandidate(candidate)) return false;
			if (!candidate.metadata.series) return false;
			if (
				seriesIndex &&
				candidate.metadata.seriesIndex &&
				candidate.metadata.seriesIndex !== seriesIndex
			) return false;
			return true;
		})
		.sort((a, b) => {
			const spanishA = seriesLooksSpanish(a.metadata.series) ? 20 : 0;
			const spanishB = seriesLooksSpanish(b.metadata.series) ? 20 : 0;
			const sourceA = a.source === "lectulandia" ? 10 : 0;
			const sourceB = b.source === "lectulandia" ? 10 : 0;
			return (spanishB + sourceB + b.score) - (spanishA + sourceA + a.score);
		})[0];
}

function reconcileSeries(
	result: BookMetadata,
	sources: ResolvedMetadata["sources"],
	candidates: Array<MetadataCandidate | undefined>,
): void {
	const preferred = preferredSeriesCandidate(candidates, result.seriesIndex);
	if (!preferred?.metadata.series) return;

	const currentSpanish = seriesLooksSpanish(result.series);
	const preferredSpanish = seriesLooksSpanish(preferred.metadata.series);
	const currentSource = sources.series;

	const shouldReplace =
		!result.series ||
		(preferredSpanish && !currentSpanish) ||
		(preferred.source === "lectulandia" && currentSource !== "lectulandia");

	if (!shouldReplace) return;

	setField(
		result,
		sources,
		"series",
		preferred.metadata.series,
		preferred.source,
		true,
	);

	if (preferred.metadata.seriesIndex) {
		setField(
			result,
			sources,
			"seriesIndex",
			preferred.metadata.seriesIndex,
			preferred.source,
			true,
		);
	}
}

export async function resolveMetadata(
	existing: BookMetadata,
	originalFileName: string,
	options: MetadataResolverOptions = {},
): Promise<ResolvedMetadata> {
	const normalizedExisting: BookMetadata = {
		...existing,
		title: stripEditionNoise(existing.title),
	};

	const hypotheses = buildIdentityHypotheses(normalizedExisting, originalFileName);
	const lectulandiaCandidates = await findLectulandiaCandidates(hypotheses, options);
	const googleCandidates = await findGoogleCandidates(hypotheses, options);
	const openLibraryCandidates = await findOpenLibraryCandidates(hypotheses);
	const identityCandidates = [
		...lectulandiaCandidates,
		...googleCandidates,
		...openLibraryCandidates,
	];
	const identity = chooseBestCandidate(identityCandidates);
	const result: BookMetadata = {};
	const sources: ResolvedMetadata["sources"] = {};
	addExistingMetadata(result, sources, normalizedExisting);

	if (!result.title) {
		const fallback = bestFilenameTitle(hypotheses);
		if (fallback?.hints.title) {
			setField(result, sources, "title", fallback.hints.title, "filename");
		}
	}

	let identityChanged = false;
	if (identity) {
		identityChanged = applyIdentityCandidate(result, sources, identity);
	}

	let goodreadsEnrichment: MetadataCandidate | undefined;
	let googleEnrichment: MetadataCandidate | undefined;
	let openLibraryEnrichment: MetadataCandidate | undefined;

	if (isMeaningful(result.title)) {
		const canonical: SearchHypothesis = {
			kind: "title",
			origin: "canonical",
			confidence: 1,
			hints: {
				title: result.title,
				author: isMeaningful(result.author) ? result.author : undefined,
				language: PREFERRED_LANGUAGE,
			},
		};
		const [rawGoodreadsEnrichment, rawGoogleEnrichment, rawOpenLibraryEnrichment] =
			await Promise.all([
				lookupGoodreads(canonical),
				lookupGoogleBooks(canonical, options.googleBooksApiKey),
				lookupOpenLibrary(canonical),
			]);
		goodreadsEnrichment = canonicalizeCandidate(rawGoodreadsEnrichment);
		googleEnrichment = canonicalizeCandidate(rawGoogleEnrichment);
		openLibraryEnrichment = canonicalizeCandidate(rawOpenLibraryEnrichment);

		if (enrichmentAccepted(goodreadsEnrichment)) {
			applyBibliographicEnrichment(
				result, sources, goodreadsEnrichment, identityChanged, false,
			);
			applyGoodreadsEnrichment(result, sources, goodreadsEnrichment);
		}
		if (enrichmentAccepted(googleEnrichment)) {
			applyBibliographicEnrichment(
				result, sources, googleEnrichment, identityChanged, true,
			);
		}
		if (enrichmentAccepted(openLibraryEnrichment)) {
			applyBibliographicEnrichment(
				result,
				sources,
				openLibraryEnrichment,
				identityChanged && !enrichmentAccepted(googleEnrichment),
				true,
			);
		}
	}

	const discoveredIsbn = collectDiscoveredIsbn(result, [
		...identityCandidates,
		...(goodreadsEnrichment ? [goodreadsEnrichment] : []),
		...(googleEnrichment ? [googleEnrichment] : []),
		...(openLibraryEnrichment ? [openLibraryEnrichment] : []),
	]);

	let exactIsbnCandidates: MetadataCandidate[] = [];
	if (discoveredIsbn) {
		exactIsbnCandidates = await lookupExactIsbnCandidates(discoveredIsbn, result, options);
		if (exactIsbnCandidates.length > 0) {
			const exactRank: Partial<Record<MetadataSource, number>> = {
				goodreads: 3,
				"google-books": 2,
				"open-library": 1,
			};
			const orderedExact = [...exactIsbnCandidates].sort(
				(a, b) => (exactRank[b.source] ?? 0) - (exactRank[a.source] ?? 0),
			);
			orderedExact.forEach((candidate, index) => {
				applyExactEditionCandidate(result, sources, candidate, index === 0);
			});
		}
	}

	let finalLectulandia: MetadataCandidate | undefined;
	const bestLectulandia = lectulandiaCandidates
		.slice()
		.sort((a, b) => b.score - a.score)[0];

	if (
		(!bestLectulandia || bestLectulandia.score < 90) &&
		(sources.description !== "lectulandia" || !result.series)
	) {
		finalLectulandia = await lookupFinalLectulandia(result, options);
		if (finalLectulandia) {
			const metadata = finalLectulandia.metadata;
			if (metadata.description) {
				setField(result, sources, "description", metadata.description, "lectulandia", true);
			}
			if (metadata.series) {
				setField(result, sources, "series", metadata.series, "lectulandia", true);
			}
			if (metadata.seriesIndex) {
				setField(result, sources, "seriesIndex", metadata.seriesIndex, "lectulandia", true);
			}
			if (metadata.subjects?.length) {
				result.subjects = mergeSubjects(metadata.subjects, result.subjects);
				sources.subjects = "lectulandia";
			}
		}
	}

	const finalGoodreads = exactIsbnCandidates.find(
		(candidate) => candidate.source === "goodreads",
	) ?? goodreadsEnrichment;
	if (finalGoodreads && enrichmentAccepted(finalGoodreads)) {
		applyGoodreadsEnrichment(result, sources, finalGoodreads);
	}

	/*
	 * Series is reconciled last. Accepted Spanish/Spanish-source metadata wins
	 * over an English series label for the same resolved work/volume.
	 */
	reconcileSeries(result, sources, [
		...identityCandidates,
		goodreadsEnrichment,
		googleEnrichment,
		openLibraryEnrichment,
		...exactIsbnCandidates,
		finalLectulandia,
	]);

	result.subjects = mergeSubjects(result.subjects);
	const cleanedResolvedTitle = stripEditionNoise(result.title);
	if (cleanedResolvedTitle) result.title = cleanedResolvedTitle;
	const finalStructuredTitle = parseStructuredSeriesTitle(result.title);
	if (finalStructuredTitle) {
		result.title = finalStructuredTitle.title;
		if (!result.series || !seriesLooksSpanish(result.series)) {
			result.series = finalStructuredTitle.series;
			sources.series = sources.title ?? "epub";
		}
		if (!result.seriesIndex) {
			result.seriesIndex = finalStructuredTitle.seriesIndex;
			sources.seriesIndex = sources.title ?? "epub";
		}
	}
	result.language = PREFERRED_LANGUAGE;

	const repairedFields: string[] = [];
	for (const field of Object.keys(result) as Array<keyof BookMetadata>) {
		if (
			JSON.stringify(existing[field] ?? null) !==
			JSON.stringify(result[field] ?? null)
		) repairedFields.push(field);
	}

	const warnings: string[] = [];
	const hasExplicitSeriesHint = hypotheses.some(
		(hypothesis) => hypothesis.origin === "filename-series-explicit",
	);
	if (hasExplicitSeriesHint && !identity) {
		warnings.push(
			"Filename looks like an explicit series volume, but no provider confirmed the real book identity",
		);
	}
	if (!result.title) warnings.push("Title is still missing");
	if (!result.description) warnings.push("Description is still missing");

	return {
		metadata: result,
		sources,
		repairedFields,
		warnings,
		matches: deduplicateMatches([
			...identityCandidates,
			...(goodreadsEnrichment ? [goodreadsEnrichment] : []),
			...(googleEnrichment ? [googleEnrichment] : []),
			...(openLibraryEnrichment ? [openLibraryEnrichment] : []),
			...exactIsbnCandidates,
			...(finalLectulandia ? [finalLectulandia] : []),
		]),
	};
}
