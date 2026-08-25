import {
	authorSimilarity,
	isMeaningful,
	isPlausiblePublicationDate,
	mergeSubjects,
	normalizeIsbn,
	parseStructuredSeriesTitle,
	titleSimilarity,
} from "./normalize";

import {
	parseFileName,
} from "./filename";

import {
	lookupGoogleBooks,
} from "./providers/google-books";

import {
	lookupLectulandia,
} from "./providers/lectulandia";

import {
	lookupOpenLibrary,
} from "./providers/open-library";

import type {
	BookMetadata,
	MetadataCandidate,
	MetadataResolverOptions,
	MetadataSource,
	ResolvedMetadata,
	SearchHypothesis,
} from "./types";

function setField<
	K extends keyof BookMetadata,
>(
	target: BookMetadata,
	sources:
		ResolvedMetadata["sources"],
	field: K,
	value: BookMetadata[K],
	source: MetadataSource,
	overwrite = false,
): void {
	if (
		value === undefined ||
		value === null
	) {
		return;
	}

	if (
		!overwrite &&
		target[field] !== undefined
	) {
		return;
	}

	target[field] =
		value;

	sources[field] =
		source;
}

function canonicalizeCandidate(
	candidate:
		MetadataCandidate | undefined,
): MetadataCandidate | undefined {
	if (!candidate) {
		return undefined;
	}

	const metadata = {
		...candidate.metadata,
	};

	/*
	 * Some catalogues encode series + position
	 * inside their display title instead of exposing
	 * dedicated series fields, for example:
	 *
	 *   Rose Hill 01 - Wild Love
	 *
	 * Only structured, high-confidence forms are
	 * split. Plain numeric titles remain untouched.
	 */
	const structured =
		parseStructuredSeriesTitle(
			metadata.title,
		);

	if (structured) {
		console.log(
			"[Metadata] structured provider title:",
			JSON.stringify({
				original: metadata.title,
				title: structured.title,
				series: structured.series,
				seriesIndex: structured.seriesIndex,
				source: candidate.source,
			}),
		);

		metadata.title =
			structured.title;

		if (!metadata.series) {
			metadata.series =
				structured.series;
		}

		if (!metadata.seriesIndex) {
			metadata.seriesIndex =
				structured.seriesIndex;
		}
	}

	if (
		metadata.published &&
		!isPlausiblePublicationDate(
			metadata.published,
		)
	) {
		metadata.published =
			undefined;
	}

	return {
		...candidate,
		metadata,
	};
}

function deduplicateHypotheses(
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

		const key =
			JSON.stringify({
				kind:
					hypothesis.kind,
				title:
					h.title?.toLowerCase(),
				author:
					h.author?.toLowerCase(),
				series:
					h.series?.toLowerCase(),
				seriesIndex:
					h.seriesIndex,
				isbn:
					normalizeIsbn(
						h.isbn,
					),
			});

		const previous =
			map.get(key);

		if (
			!previous ||
			hypothesis.confidence >
				previous.confidence
		) {
			map.set(
				key,
				hypothesis,
			);
		}
	}

	return [...map.values()];
}

function buildIdentityHypotheses(
	existing: BookMetadata,
	originalFileName: string,
): SearchHypothesis[] {
	const parsed =
		parseFileName(
			originalFileName,
		);

	const hypotheses:
		SearchHypothesis[] =
			[];

	const isbn =
		normalizeIsbn(
			existing.isbn,
		);

	if (isbn) {
		hypotheses.push({
			kind:
				"isbn",
			origin:
				"embedded-isbn",
			confidence:
				1,
			hints: {
				isbn,
				language:
					existing.language,
			},
		});
	}

	if (
		isMeaningful(
			existing.title,
		)
	) {
		const hasAuthor =
			isMeaningful(
				existing.author,
			);

		hypotheses.push({
			kind:
				"title",
			origin:
				"embedded-title",
			confidence:
				hasAuthor
					? 0.94
					: 0.78,
			hints: {
				title:
					existing.title,
				author:
					hasAuthor
						? existing.author
						: undefined,
				language:
					existing.language,
			},
		});
	}

	for (
		const hypothesis
		of parsed.hypotheses
	) {
		hypotheses.push({
			...hypothesis,

			hints: {
				...hypothesis.hints,

				language:
					hypothesis
						.hints
						.language ??
					existing
						.language,
			},
		});
	}

	return deduplicateHypotheses(
		hypotheses,
	);
}

function minimumIdentityScore(
	hypothesis:
		SearchHypothesis,
): number {
	if (
		hypothesis.kind ===
		"isbn"
	) {
		return 99;
	}

	if (
		hypothesis.origin ===
		"filename-series-explicit"
	) {
		return 78;
	}

	if (
		hypothesis.origin ===
		"filename-series-ambiguous"
	) {
		/*
		 * "Area 51" must not become
		 * series "Area" #51 unless a
		 * provider confirms it with very
		 * strong evidence.
		 */
		return 94;
	}

	if (
		hypothesis.kind ===
		"title"
	) {
		if (
			hypothesis.hints
				.author
		) {
			return 78;
		}

		/*
		 * A title-only filename is valid
		 * and common, but naturally more
		 * ambiguous than title + author.
		 */
		return 90;
	}

	return 90;
}

function isAcceptedCandidate(
	candidate:
		MetadataCandidate,
): boolean {
	const hypothesis =
		candidate
			.matchedHypothesis;

	if (!hypothesis) {
		return false;
	}

	return (
		candidate.score >=
		minimumIdentityScore(
			hypothesis,
		)
	);
}

function providerBonus(
	source: MetadataSource,
): number {
	switch (source) {
		case "lectulandia":
			return 3;

		case "google-books":
			return 1;

		default:
			return 0;
	}
}

function chooseBestCandidate(
	candidates:
		MetadataCandidate[],
): MetadataCandidate | undefined {
	return candidates
		.filter(
			isAcceptedCandidate,
		)
		.sort(
			(a, b) =>
				(
					b.score +
					providerBonus(
						b.source,
					)
				) -
				(
					a.score +
					providerBonus(
						a.source,
					)
				),
		)[0];
}

function orderHypothesesForIdentity(
	hypotheses:
		SearchHypothesis[],
): SearchHypothesis[] {
	const originRank:
		Partial<
			Record<
				SearchHypothesis["origin"],
				number
			>
		> = {
			"embedded-isbn":
				100,

			"discovered-isbn":
				100,

			"filename-series-explicit":
				95,

			"filename-split":
				90,

			"filename-full":
				80,

			"embedded-title":
				75,

			"filename-series-ambiguous":
				50,
		};

	return [...hypotheses]
		.sort(
			(a, b) =>
				(
					originRank[
						b.origin
					] ?? 0
				) -
					(
						originRank[
							a.origin
						] ?? 0
					) ||
				b.confidence -
					a.confidence,
		);
}

async function findLectulandiaCandidates(
	hypotheses:
		SearchHypothesis[],
	options:
		MetadataResolverOptions,
): Promise<MetadataCandidate[]> {
	const results:
		MetadataCandidate[] =
			[];

	const eligible =
		orderHypothesesForIdentity(
			hypotheses,
		)
			.filter(
				(hypothesis) =>
					hypothesis.kind !==
					"isbn",
			)
			.slice(
				0,
				4,
			);

	for (
		const hypothesis
		of eligible
	) {
		const candidate =
			canonicalizeCandidate(
				await lookupLectulandia(
					hypothesis,
					options
						.lectulandiaBaseUrl,
				),
			);

		if (candidate) {
			results.push(
				candidate,
			);

			/*
			 * A very strong explicit-series
			 * or title+author match is enough
			 * to stop crawling more
			 * Lectulandia hypotheses.
			 */
			if (
				isAcceptedCandidate(
					candidate,
				) &&
				candidate.score >=
					97
			) {
				break;
			}
		}
	}

	return results;
}

async function findGoogleCandidates(
	hypotheses:
		SearchHypothesis[],
	options:
		MetadataResolverOptions,
): Promise<MetadataCandidate[]> {
	const results:
		MetadataCandidate[] =
			[];

	const eligible =
		orderHypothesesForIdentity(
			hypotheses,
		)
			.filter(
				(hypothesis) => {
					if (
						hypothesis.kind !==
						"series"
					) {
						return true;
					}

					/*
					 * For an ambiguous series
					 * hypothesis, Google must
					 * also have an author to
					 * corroborate it.
					 */
					if (
						hypothesis.origin ===
							"filename-series-ambiguous" &&
						!hypothesis.hints
							.author
					) {
						return false;
					}

					return true;
				},
			)
			.slice(
				0,
				5,
			);

	for (
		const hypothesis
		of eligible
	) {
		const candidate =
			canonicalizeCandidate(
				await lookupGoogleBooks(
					hypothesis,
					options
						.googleBooksApiKey,
				),
			);

		if (candidate) {
			results.push(
				candidate,
			);

			if (
				isAcceptedCandidate(
					candidate,
				) &&
				candidate.score >=
					99
			) {
				break;
			}
		}
	}

	return results;
}

async function findOpenLibraryCandidates(
	hypotheses:
		SearchHypothesis[],
): Promise<MetadataCandidate[]> {
	const results:
		MetadataCandidate[] =
			[];

	const eligible =
		orderHypothesesForIdentity(
			hypotheses,
		)
			.filter(
				(hypothesis) =>
					hypothesis.kind !==
					"series",
			)
			.slice(
				0,
				4,
			);

	for (
		const hypothesis
		of eligible
	) {
		const candidate =
			canonicalizeCandidate(
				await lookupOpenLibrary(
					hypothesis,
				),
			);

		if (candidate) {
			results.push(
				candidate,
			);

			if (
				isAcceptedCandidate(
					candidate,
				) &&
				candidate.score >=
					99
			) {
				break;
			}
		}
	}

	return results;
}

function bestFilenameTitle(
	hypotheses:
		SearchHypothesis[],
): SearchHypothesis | undefined {
	/*
	 * Fallback is deliberately conservative.
	 *
	 * Without external confirmation we do
	 * NOT assume that the final " - X"
	 * segment is an author. The entire
	 * filename remains the safest title
	 * fallback.
	 *
	 * Explicit-series filenames have their
	 * filename-full confidence reduced by
	 * parseFileName(), so they will not
	 * become a fake title here.
	 */
	return hypotheses
		.filter(
			(hypothesis) =>
				hypothesis.kind ===
					"title" &&
				hypothesis.origin ===
					"filename-full" &&
				hypothesis.confidence >=
					0.7,
		)
		.sort(
			(a, b) =>
				b.confidence -
				a.confidence,
		)[0];
}

function candidateStronglyBackedByFilename(
	candidate:
		MetadataCandidate,
): boolean {
	const hypothesis =
		candidate
			.matchedHypothesis;

	if (!hypothesis) {
		return false;
	}

	return (
		hypothesis.origin ===
			"filename-series-explicit" ||
		hypothesis.origin ===
			"filename-series-ambiguous" ||
		hypothesis.origin ===
			"filename-split" ||
		hypothesis.origin ===
			"filename-full"
	);
}

function shouldReplaceTitle(
	existingTitle:
		string | undefined,
	candidate:
		MetadataCandidate,
): boolean {
	const candidateTitle =
		candidate.metadata
			.title;

	if (
		!isMeaningful(
			candidateTitle,
		)
	) {
		return false;
	}

	if (
		!isMeaningful(
			existingTitle,
		)
	) {
		return true;
	}

	if (
		titleSimilarity(
			existingTitle,
			candidateTitle,
		) >= 0.8
	) {
		return true;
	}

	return (
		candidateStronglyBackedByFilename(
			candidate,
		) &&
		isAcceptedCandidate(
			candidate,
		)
	);
}

function shouldReplaceAuthor(
	existingAuthor:
		string | undefined,
	candidate:
		MetadataCandidate,
): boolean {
	const candidateAuthor =
		candidate.metadata
			.author;

	if (
		!isMeaningful(
			candidateAuthor,
		)
	) {
		return false;
	}

	if (
		!isMeaningful(
			existingAuthor,
		)
	) {
		return true;
	}

	if (
		authorSimilarity(
			existingAuthor,
			candidateAuthor,
		) >= 0.8
	) {
		return true;
	}

	const hypothesis =
		candidate
			.matchedHypothesis;

	return (
		!!hypothesis
			?.hints.author &&
		candidateStronglyBackedByFilename(
			candidate,
		) &&
		isAcceptedCandidate(
			candidate,
		)
	);
}

function deduplicateMatches(
	candidates:
		MetadataCandidate[],
): MetadataCandidate[] {
	const map =
		new Map<
			MetadataSource,
			MetadataCandidate
		>();

	for (
		const candidate
		of candidates
	) {
		const previous =
			map.get(
				candidate.source,
			);

		if (
			!previous ||
			candidate.score >
				previous.score
		) {
			map.set(
				candidate.source,
				candidate,
			);
		}
	}

	return [...map.values()]
		.sort(
			(a, b) =>
				b.score -
				a.score,
		);
}

function addExistingMetadata(
	result: BookMetadata,
	sources:
		ResolvedMetadata["sources"],
	existing: BookMetadata,
): void {
	const structuredTitle =
		parseStructuredSeriesTitle(
			existing.title,
		);

	if (structuredTitle) {
		/*
		 * Some EPUBs already contain catalogue-style
		 * display titles such as:
		 *
		 *   Rose Hill 01 - Wild Love
		 *
		 * The grammar is intentionally strict (explicit
		 * series marker or zero-padded ordinal), so this
		 * does not turn ordinary numeric titles into series.
		 */
		setField(
			result,
			sources,
			"title",
			structuredTitle.title,
			"epub",
		);

		if (!isMeaningful(existing.series)) {
			setField(
				result,
				sources,
				"series",
				structuredTitle.series,
				"epub",
			);
		}

		if (!isMeaningful(existing.seriesIndex)) {
			setField(
				result,
				sources,
				"seriesIndex",
				structuredTitle.seriesIndex,
				"epub",
			);
		}
	} else if (
		isMeaningful(
			existing.title,
		)
	) {
		setField(
			result,
			sources,
			"title",
			existing.title,
			"epub",
		);
	}

	if (
		isMeaningful(
			existing.author,
		)
	) {
		setField(
			result,
			sources,
			"author",
			existing.author,
			"epub",
		);
	}

	if (
		isMeaningful(
			existing.description,
		)
	) {
		setField(
			result,
			sources,
			"description",
			existing.description,
			"epub",
		);
	}

	if (
		isMeaningful(
			existing.language,
		)
	) {
		setField(
			result,
			sources,
			"language",
			existing.language,
			"epub",
		);
	}

	if (
		normalizeIsbn(
			existing.isbn,
		)
	) {
		setField(
			result,
			sources,
			"isbn",
			normalizeIsbn(
				existing.isbn,
			),
			"epub",
		);
	}

	if (
		isMeaningful(
			existing.publisher,
		)
	) {
		setField(
			result,
			sources,
			"publisher",
			existing.publisher,
			"epub",
		);
	}

	if (
		isPlausiblePublicationDate(
			existing.published,
		)
	) {
		setField(
			result,
			sources,
			"published",
			existing.published,
			"epub",
		);
	}

	if (
		existing.pageCount &&
		existing.pageCount > 0
	) {
		setField(
			result,
			sources,
			"pageCount",
			existing.pageCount,
			"epub",
		);
	}

	if (
		isMeaningful(
			existing.series,
		)
	) {
		setField(
			result,
			sources,
			"series",
			existing.series,
			"epub",
		);
	}

	if (
		isMeaningful(
			existing.seriesIndex,
		)
	) {
		setField(
			result,
			sources,
			"seriesIndex",
			existing.seriesIndex,
			"epub",
		);
	}

	if (
		existing.subjects
			?.length
	) {
		setField(
			result,
			sources,
			"subjects",
			existing.subjects,
			"epub",
		);
	}
}

function applyIdentityCandidate(
	result: BookMetadata,
	sources:
		ResolvedMetadata["sources"],
	identity:
		MetadataCandidate,
): boolean {
	const metadata =
		identity.metadata;

	let identityChanged =
		false;

	if (
		metadata.title &&
		shouldReplaceTitle(
			result.title,
			identity,
		)
	) {
		if (
			result.title !==
			metadata.title
		) {
			identityChanged =
				true;
		}

		setField(
			result,
			sources,
			"title",
			metadata.title,
			identity.source,
			true,
		);
	}

	if (
		metadata.author &&
		shouldReplaceAuthor(
			result.author,
			identity,
		)
	) {
		if (
			result.author !==
			metadata.author
		) {
			identityChanged =
				true;
		}

		setField(
			result,
			sources,
			"author",
			metadata.author,
			identity.source,
			true,
		);
	}

	if (metadata.series) {
		setField(
			result,
			sources,
			"series",
			metadata.series,
			identity.source,
			true,
		);
	}

	if (metadata.seriesIndex) {
		setField(
			result,
			sources,
			"seriesIndex",
			metadata.seriesIndex,
			identity.source,
			true,
		);
	}

	/*
	 * Lectulandia's description is taken
	 * strictly from #sinopsis. Once the
	 * identity match is accepted, it is
	 * preferable to arbitrary embedded
	 * descriptions.
	 */
	if (
		identity.source ===
			"lectulandia" &&
		metadata.description
	) {
		setField(
			result,
			sources,
			"description",
			metadata.description,
			"lectulandia",
			true,
		);
	} else if (
		metadata.description &&
		(
			!result.description ||
			identityChanged
		)
	) {
		setField(
			result,
			sources,
			"description",
			metadata.description,
			identity.source,
			identityChanged,
		);
	}

	if (
		identity.source ===
			"lectulandia" &&
		metadata.subjects
			?.length
	) {
		setField(
			result,
			sources,
			"subjects",
			metadata.subjects,
			"lectulandia",
			true,
		);
	}

	return identityChanged;
}

function enrichmentAccepted(
	candidate:
		MetadataCandidate | undefined,
): candidate is MetadataCandidate {
	if (!candidate) {
		return false;
	}

	const hypothesis =
		candidate
			.matchedHypothesis;

	if (!hypothesis) {
		return false;
	}

	const minimum =
		hypothesis.hints
			.author
			? 78
			: 92;

	return (
		candidate.score >=
		minimum
	);
}

function applyConfirmedStructuredSeriesTitle(
	result: BookMetadata,
	sources:
		ResolvedMetadata["sources"],
	candidate:
		MetadataCandidate,
): boolean {
	/*
	 * A catalogue may expose a display title such as:
	 *
	 *   Rose Hill 02 - Wild Eyes
	 *
	 * canonicalizeCandidate() has already converted the
	 * candidate to:
	 *
	 *   title       = Wild Eyes
	 *   series      = Rose Hill
	 *   seriesIndex = 2
	 *
	 * If our current title is still the raw display title,
	 * this is the point where a strong enrichment match is
	 * allowed to normalize the three bibliographic fields.
	 *
	 * We do NOT infer a series from a plain numeric title.
	 * The current title itself must match the strict
	 * parseStructuredSeriesTitle() grammar, and the parsed
	 * values must agree with the accepted external candidate.
	 */
	const currentStructured =
		parseStructuredSeriesTitle(
			result.title,
		);

	if (
		!currentStructured ||
		!candidate.metadata.title ||
		!candidate.metadata.series ||
		!candidate.metadata.seriesIndex
	) {
		return false;
	}

	if (
		titleSimilarity(
			currentStructured.title,
			candidate.metadata.title,
		) < 0.92 ||
		titleSimilarity(
			currentStructured.series,
			candidate.metadata.series,
		) < 0.92 ||
		currentStructured.seriesIndex !==
			candidate.metadata.seriesIndex
	) {
		return false;
	}

	setField(
		result,
		sources,
		"title",
		candidate.metadata.title,
		candidate.source,
		true,
	);

	setField(
		result,
		sources,
		"series",
		candidate.metadata.series,
		candidate.source,
		true,
	);

	setField(
		result,
		sources,
		"seriesIndex",
		candidate.metadata.seriesIndex,
		candidate.source,
		true,
	);

	console.log(
		"[Metadata] applied confirmed series:",
		JSON.stringify({
			title: candidate.metadata.title,
			series: candidate.metadata.series,
			seriesIndex: candidate.metadata.seriesIndex,
			source: candidate.source,
			score: candidate.score,
		}),
	);

	return true;
}

function applyBibliographicEnrichment(
	result: BookMetadata,
	sources:
		ResolvedMetadata["sources"],
	candidate:
		MetadataCandidate,
	identityChanged:
		boolean,
	allowOverwrite:
		boolean,
): void {
	const metadata =
		candidate.metadata;

	/*
	 * Enrichment candidates can also be the first provider
	 * that confirms a catalogue-style series display title.
	 * Normalize it before filling ISBN/publisher/etc.
	 */
	applyConfirmedStructuredSeriesTitle(
		result,
		sources,
		candidate,
	);

	const overwrite =
		identityChanged &&
		allowOverwrite;

	setField(
		result,
		sources,
		"isbn",
		metadata.isbn,
		candidate.source,
		overwrite,
	);

	setField(
		result,
		sources,
		"publisher",
		metadata.publisher,
		candidate.source,
		overwrite,
	);

	setField(
		result,
		sources,
		"pageCount",
		metadata.pageCount,
		candidate.source,
		overwrite,
	);

	if (
		metadata.published &&
		isPlausiblePublicationDate(
			metadata.published,
		) &&
		(
			!result.published ||
			!isPlausiblePublicationDate(
				result.published,
			) ||
			overwrite
		)
	) {
		setField(
			result,
			sources,
			"published",
			metadata.published,
			candidate.source,
			true,
		);
	}

	if (!result.language) {
		setField(
			result,
			sources,
			"language",
			metadata.language,
			candidate.source,
		);
	}

	if (
		!result.description &&
		metadata.description
	) {
		setField(
			result,
			sources,
			"description",
			metadata.description,
			candidate.source,
		);
	}

	if (
		!result.subjects
			?.length &&
		metadata.subjects
			?.length
	) {
		setField(
			result,
			sources,
			"subjects",
			metadata.subjects,
			candidate.source,
		);
	}
}

function isbnCandidateCompatible(
	current: BookMetadata,
	candidate: MetadataCandidate,
): boolean {
	const metadata = candidate.metadata;

	if (
		current.author &&
		metadata.author
	) {
		const authorScore =
			authorSimilarity(
				current.author,
				metadata.author,
			);

		if (authorScore < 0.5) {
			return false;
		}
	}

	if (
		current.title &&
		metadata.title
	) {
		const titleScore =
			titleSimilarity(
				current.title,
				metadata.title,
			);

		const authorScore =
			current.author &&
			metadata.author
				? authorSimilarity(
						current.author,
						metadata.author,
					)
				: 0;

		/*
		 * Translated/localised titles can differ while the
		 * author and ISBN still identify the same edition/work.
		 * Reject only when both title and author evidence are
		 * incompatible.
		 */
		if (
			titleScore < 0.3 &&
			authorScore < 0.8
		) {
			return false;
		}
	}

	return true;
}

function collectDiscoveredIsbn(
	result: BookMetadata,
	candidates: MetadataCandidate[],
): string | undefined {
	const direct = normalizeIsbn(
		result.isbn,
	);

	if (direct) {
		return direct;
	}

	const ordered = [...candidates]
		.filter(isAcceptedCandidate)
		.sort(
			(a, b) =>
				b.score - a.score,
		);

	for (const candidate of ordered) {
		const isbn = normalizeIsbn(
			candidate.metadata.isbn,
		);

		if (isbn) {
			return isbn;
		}
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

	/*
	 * Exact ISBN candidates have already been checked against
	 * the current title/author. The primary exact provider may
	 * replace edition-level fields; the secondary provider fills
	 * gaps and may still contribute confirmed series metadata.
	 */
	if (primary) {
		if (metadata.title) {
			setField(
				result,
				sources,
				"title",
				metadata.title,
				candidate.source,
				true,
			);
		}

		if (metadata.author) {
			setField(
				result,
				sources,
				"author",
				metadata.author,
				candidate.source,
				true,
			);
		}

		if (metadata.isbn) {
			setField(
				result,
				sources,
				"isbn",
				normalizeIsbn(metadata.isbn),
				candidate.source,
				true,
			);
		}

		if (metadata.publisher) {
			setField(
				result,
				sources,
				"publisher",
				metadata.publisher,
				candidate.source,
				true,
			);
		}

		if (
			metadata.published &&
			isPlausiblePublicationDate(
				metadata.published,
			)
		) {
			setField(
				result,
				sources,
				"published",
				metadata.published,
				candidate.source,
				true,
			);
		}

		if (
			metadata.pageCount &&
			metadata.pageCount > 0
		) {
			setField(
				result,
				sources,
				"pageCount",
				metadata.pageCount,
				candidate.source,
				true,
			);
		}

		if (metadata.language) {
			setField(
				result,
				sources,
				"language",
				metadata.language,
				candidate.source,
				true,
			);
		}
	} else {
		setField(
			result,
			sources,
			"isbn",
			normalizeIsbn(metadata.isbn),
			candidate.source,
		);

		setField(
			result,
			sources,
			"publisher",
			metadata.publisher,
			candidate.source,
		);

		if (
			metadata.published &&
			isPlausiblePublicationDate(
				metadata.published,
			)
		) {
			setField(
				result,
				sources,
				"published",
				metadata.published,
				candidate.source,
			);
		}

		setField(
			result,
			sources,
			"pageCount",
			metadata.pageCount,
			candidate.source,
		);

		setField(
			result,
			sources,
			"language",
			metadata.language,
			candidate.source,
		);
	}

	/*
	 * Series information is bibliographic rather than merely
	 * cosmetic, so either exact provider may fill it.
	 */
	if (metadata.series) {
		setField(
			result,
			sources,
			"series",
			metadata.series,
			candidate.source,
			!result.series,
		);
	}

	if (metadata.seriesIndex) {
		setField(
			result,
			sources,
			"seriesIndex",
			metadata.seriesIndex,
			candidate.source,
			!result.seriesIndex,
		);
	}

	if (
		metadata.description &&
		sources.description !== "lectulandia" &&
		(!result.description || primary)
	) {
		setField(
			result,
			sources,
			"description",
			metadata.description,
			candidate.source,
			primary,
		);
	}

	if (
		metadata.subjects?.length &&
		(!result.subjects?.length || primary)
	) {
		result.subjects = mergeSubjects(
			result.subjects,
			metadata.subjects,
		);

		if (!sources.subjects || primary) {
			sources.subjects = candidate.source;
		}
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
		hints: {
			isbn,
			language: current.language,
		},
	};

	const [rawGoogle, rawOpenLibrary] =
		await Promise.all([
			lookupGoogleBooks(
				hypothesis,
				options.googleBooksApiKey,
			),
			lookupOpenLibrary(
				hypothesis,
			),
		]);

	return [rawGoogle, rawOpenLibrary]
		.map(canonicalizeCandidate)
		.filter(
			(
				candidate,
			): candidate is MetadataCandidate =>
				!!candidate &&
				candidate.score === 100 &&
				isbnCandidateCompatible(
					current,
					candidate,
				),
		);
}

async function lookupFinalLectulandia(
	result: BookMetadata,
	options: MetadataResolverOptions,
): Promise<MetadataCandidate | undefined> {
	if (
		!isMeaningful(result.title) ||
		!isMeaningful(result.author)
	) {
		return undefined;
	}

	const hypothesis: SearchHypothesis = {
		kind: "title",
		origin: "canonical",
		confidence: 1,
		hints: {
			title: result.title,
			author: result.author,
			language: result.language,
		},
	};

	const candidate = canonicalizeCandidate(
		await lookupLectulandia(
			hypothesis,
			options.lectulandiaBaseUrl,
		),
	);

	if (
		!candidate ||
		candidate.score < 85
	) {
		return undefined;
	}

	return candidate;
}

export async function resolveMetadata(
	existing: BookMetadata,
	originalFileName: string,
	options:
		MetadataResolverOptions = {},
): Promise<ResolvedMetadata> {
	const hypotheses =
		buildIdentityHypotheses(
			existing,
			originalFileName,
		);

	/*
	 * PHASE 1
	 * -------
	 * Identify the actual work.
	 *
	 * Filename hypotheses are not facts:
	 * - title only
	 * - title + possible author
	 * - explicit series + position
	 * - ambiguous trailing number
	 */
	const lectulandiaCandidates =
		await findLectulandiaCandidates(
			hypotheses,
			options,
		);

	const googleCandidates =
		await findGoogleCandidates(
			hypotheses,
			options,
		);

	const openLibraryCandidates =
		await findOpenLibraryCandidates(
			hypotheses,
		);

	const identityCandidates = [
		...lectulandiaCandidates,
		...googleCandidates,
		...openLibraryCandidates,
	];

	const identity =
		chooseBestCandidate(
			identityCandidates,
		);

	const result:
		BookMetadata = {};

	const sources:
		ResolvedMetadata["sources"] =
			{};

	addExistingMetadata(
		result,
		sources,
		existing,
	);

	/*
	 * Filename fallback.
	 *
	 * We may safely use a strong normal
	 * title hypothesis if embedded title
	 * is absent.
	 *
	 * We deliberately do NOT turn an
	 * explicit/ambiguous series hypothesis
	 * into the title.
	 */
	if (!result.title) {
		const fallback =
			bestFilenameTitle(
				hypotheses,
			);

		if (
			fallback
				?.hints.title
		) {
			setField(
				result,
				sources,
				"title",
				fallback
					.hints.title,
				"filename",
			);
		}
	}

	let identityChanged =
		false;

	if (identity) {
		identityChanged =
			applyIdentityCandidate(
				result,
				sources,
				identity,
			);
	}

	/*
	 * PHASE 2
	 * -------
	 * Enrich using the canonical title we
	 * now believe to be correct.
	 *
	 * This is where:
	 *
	 * "El Reino de los Malditos Vol. 3"
	 *
	 * can first resolve to:
	 *
	 * "El ascenso de las Temidas"
	 *
	 * and only THEN be sent to Google
	 * Books / Open Library.
	 */
	let googleEnrichment:
		| MetadataCandidate
		| undefined;

	let openLibraryEnrichment:
		| MetadataCandidate
		| undefined;

	if (
		isMeaningful(
			result.title,
		)
	) {
		const canonical:
			SearchHypothesis = {
				kind:
					"title",

				origin:
					"canonical",

				confidence:
					1,

				hints: {
					title:
						result.title,

					author:
						isMeaningful(
							result.author,
						)
							? result.author
							: undefined,

					language:
						result.language,
				},
			};

		const [
			rawGoogleEnrichment,
			rawOpenLibraryEnrichment,
		] = await Promise.all([
			lookupGoogleBooks(
				canonical,
				options
					.googleBooksApiKey,
			),

			lookupOpenLibrary(
				canonical,
			),
		]);

		googleEnrichment =
			canonicalizeCandidate(
				rawGoogleEnrichment,
			);

		openLibraryEnrichment =
			canonicalizeCandidate(
				rawOpenLibraryEnrichment,
			);

		if (
			enrichmentAccepted(
				googleEnrichment,
			)
		) {
			applyBibliographicEnrichment(
				result,
				sources,
				googleEnrichment,
				identityChanged,
				true,
			);
		}

		if (
			enrichmentAccepted(
				openLibraryEnrichment,
			)
		) {
			/*
			 * Open Library is the last
			 * fallback. It fills holes but
			 * does not overwrite a confident
			 * Google Books edition.
			 */
			applyBibliographicEnrichment(
				result,
				sources,
				openLibraryEnrichment,
				identityChanged &&
					!enrichmentAccepted(
						googleEnrichment,
					),
				true,
			);
		}
	}

	/*
	 * PHASE 3
	 * -------
	 * As soon as any accepted source gives us a valid ISBN,
	 * stop guessing about the edition and perform exact ISBN
	 * lookups. This is intentionally a second pass: a title
	 * search is often how we discover the ISBN in the first
	 * place.
	 */
	const discoveredIsbn =
		collectDiscoveredIsbn(
			result,
			[
				...identityCandidates,
				...(googleEnrichment
					? [googleEnrichment]
					: []),
				...(openLibraryEnrichment
					? [openLibraryEnrichment]
					: []),
			],
		);

	let exactIsbnCandidates:
		MetadataCandidate[] = [];

	if (discoveredIsbn) {
		exactIsbnCandidates =
			await lookupExactIsbnCandidates(
				discoveredIsbn,
				result,
				options,
			);

		if (exactIsbnCandidates.length > 0) {
			/*
			 * Google Books is preferred as the primary exact
			 * edition source when both APIs confirm the ISBN;
			 * Open Library then fills remaining holes.
			 */
			const orderedExact = [
				...exactIsbnCandidates.filter(
					(candidate) =>
						candidate.source ===
						"google-books",
				),
				...exactIsbnCandidates.filter(
					(candidate) =>
						candidate.source !==
						"google-books",
				),
			];

			orderedExact.forEach(
				(candidate, index) => {
					applyExactEditionCandidate(
						result,
						sources,
						candidate,
						index === 0,
					);
				},
			);
		}
	}

	/*
	 * PHASE 4
	 * -------
	 * One final best-effort Lectulandia lookup using the now
	 * canonical title + author. It is useful for synopsis,
	 * genres and series information, but it never blocks the
	 * pipeline and never replaces exact ISBN edition fields.
	 */
	let finalLectulandia:
		| MetadataCandidate
		| undefined;

	if (
		sources.description !==
			"lectulandia" ||
		!result.series
	) {
		finalLectulandia =
			await lookupFinalLectulandia(
				result,
				options,
			);

		if (finalLectulandia) {
			const metadata =
				finalLectulandia.metadata;

			if (metadata.description) {
				setField(
					result,
					sources,
					"description",
					metadata.description,
					"lectulandia",
					true,
				);
			}

			if (metadata.series) {
				setField(
					result,
					sources,
					"series",
					metadata.series,
					"lectulandia",
					true,
				);
			}

			if (metadata.seriesIndex) {
				setField(
					result,
					sources,
					"seriesIndex",
					metadata.seriesIndex,
					"lectulandia",
					true,
				);
			}

			if (metadata.subjects?.length) {
				result.subjects =
					mergeSubjects(
						metadata.subjects,
						result.subjects,
					);
				sources.subjects =
					"lectulandia";
			}
		}
	}

	result.subjects =
		mergeSubjects(
			result.subjects,
		);

	const repairedFields:
		string[] = [];

	for (
		const field
		of Object.keys(
			result,
		) as Array<
			keyof BookMetadata
		>
	) {
		if (
			JSON.stringify(
				existing[field] ??
					null,
			) !==
			JSON.stringify(
				result[field] ??
					null,
			)
		) {
			repairedFields.push(
				field,
			);
		}
	}

	const warnings:
		string[] = [];

	const hasExplicitSeriesHint =
		hypotheses.some(
			(hypothesis) =>
				hypothesis.origin ===
					"filename-series-explicit",
		);

	if (
		hasExplicitSeriesHint &&
		!identity
	) {
		warnings.push(
			"Filename looks like an explicit series volume, but no provider confirmed the real book identity",
		);
	}

	if (!result.title) {
		warnings.push(
			"Title is still missing",
		);
	}

	if (!result.description) {
		warnings.push(
			"Description is still missing",
		);
	}

	return {
		metadata:
			result,

		sources,

		repairedFields,

		warnings,

		matches:
			deduplicateMatches([
				...identityCandidates,

				...(googleEnrichment
					? [googleEnrichment]
					: []),

				...(openLibraryEnrichment
					? [openLibraryEnrichment]
					: []),

				...exactIsbnCandidates,

				...(finalLectulandia
					? [finalLectulandia]
					: []),
			]),
	};
}
