import {
	authorSimilarity,
	cleanText,
	normalizeIsbn,
	normalizePublicationDate,
	scoreSeriesMatch,
	scoreTitleMatch,
	stripEditionNoise,
} from "../normalize";

import type {
	BookMetadata,
	MetadataCandidate,
	SearchHypothesis,
} from "../types";

type JsonObject = Record<string, unknown>;

interface GoodreadsAutocompleteItem {
	bookId?: number | string;
	workId?: number | string;
	bookUrl?: string;
	title?: string;
	bookTitleBare?: string;
	numPages?: number;
	author?: {
		id?: number | string;
		name?: string;
	};
	description?: {
		html?: string;
		truncated?: boolean;
		fullContentUrl?: string;
	};
}

const GOODREADS_BASE_URL = "https://www.goodreads.com";
const MAX_DETAIL_CANDIDATES = 4;

const NON_GENRE_SHELVES = new Set([
	"audio",
	"audiobook",
	"audiobooks",
	"ebook",
	"ebooks",
	"e-book",
	"kindle",
	"owned",
	"owned-books",
	"to-read",
	"currently-reading",
	"favorites",
	"favourites",
]);


const TROPE_LABELS: Record<string, string> = {
	"age gap": "Age Gap",
	"best friends to lovers": "Best Friends To Lovers",
	"brother's best friend": "Brother's Best Friend",
	"childhood friends to lovers": "Childhood Friends To Lovers",
	"enemies to lovers": "Enemies To Lovers",
	"fake dating": "Fake Dating",
	"forbidden romance": "Forbidden Romance",
	"forced proximity": "Forced Proximity",
	"friends to lovers": "Friends To Lovers",
	"friends with benefits": "Friends With Benefits",
	"found family": "Found Family",
	"grumpy sunshine": "Grumpy Sunshine",
	"love triangle": "Love Triangle",
	"marriage of convenience": "Marriage Of Convenience",
	"one bed": "One Bed",
	"reverse harem": "Reverse Harem",
	"rivals to lovers": "Rivals To Lovers",
	"second chance": "Second Chance",
	"second chance romance": "Second Chance Romance",
	"slow burn": "Slow Burn",
	"small town romance": "Small Town Romance",
	"workplace romance": "Workplace Romance",
};

const GENRE_TRANSLATIONS: Record<string, string> = {
	"adult": "Adulto",
	"adventure": "Aventuras",
	"contemporary": "Contemporánea",
	"crime": "Crimen",
	"dark fantasy": "Fantasía oscura",
	"dragons": "Dragones",
	"dystopia": "Distopía",
	"epic fantasy": "Fantasía épica",
	"fantasy": "Fantasía",
	"fantasy romance": "Romance fantástico",
	"fiction": "Ficción",
	"historical": "Histórica",
	"historical fiction": "Ficción histórica",
	"high fantasy": "Alta fantasía",
	"horror": "Terror",
	"lgbt": "LGBT",
	"lgbtq": "LGBTQ+",
	"magic": "Magia",
	"mystery": "Misterio",
	"mythology": "Mitología",
	"new adult": "New Adult",
	"paranormal": "Paranormal",
	"romance": "Romance",
	"romantasy": "Romantasy",
	"science fiction": "Ciencia ficción",
	"thriller": "Thriller",
	"urban fantasy": "Fantasía urbana",
	"vampires": "Vampiros",
	"witches": "Brujas",
	"young adult": "Juvenil",
};

function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

function getString(value: unknown): string | undefined {
	return typeof value === "string"
		? cleanText(value)
		: undefined;
}

function getNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");
}

function stripHtml(value?: string): string | undefined {
	if (!value) {
		return undefined;
	}

	return cleanText(
		decodeHtmlEntities(
			value.replace(/<[^>]+>/g, " "),
		),
	);
}

function normalizeGoodreadsLanguage(value?: string): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();

	if (["spanish", "espanol", "es", "es-es", "spa"].includes(normalized)) {
		return "es";
	}

	if (["english", "ingles", "en", "en-us", "en-gb", "eng"].includes(normalized)) {
		return "en";
	}

	return normalized.slice(0, 2) || undefined;
}

function translateGenre(value?: string): string | undefined {
	const clean = cleanText(value);
	if (!clean) {
		return undefined;
	}

	const normalized = clean
		.toLowerCase()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (NON_GENRE_SHELVES.has(normalized)) {
		return undefined;
	}

	/*
	 * Keep romance/story tropes in their usual English form.
	 * They are community labels rather than genres to localize, and
	 * translating them makes the metadata less useful for filtering.
	 */
	const trope = TROPE_LABELS[normalized];
	if (trope) {
		return trope;
	}

	return GENRE_TRANSLATIONS[normalized] ?? clean;
}

function parsePublicationTime(value: unknown): string | undefined {
	const timestamp = getNumber(value);
	if (timestamp === undefined) {
		return normalizePublicationDate(getString(value));
	}

	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) {
		return undefined;
	}

	return normalizePublicationDate(date.toISOString().slice(0, 10));
}

function findMainBook(
	apolloState: JsonObject,
	bookId: string,
): JsonObject | undefined {
	const root = asObject(apolloState.ROOT_QUERY);
	if (root) {
		for (const [key, value] of Object.entries(root)) {
			if (!key.startsWith("getBookByLegacyId")) {
				continue;
			}

			const ref = getString(asObject(value)?.__ref);
			const referenced = ref ? asObject(apolloState[ref]) : undefined;
			if (referenced) {
				return referenced;
			}
		}
	}

	for (const [key, value] of Object.entries(apolloState)) {
		if (!key.startsWith("Book:")) {
			continue;
		}

		const book = asObject(value);
		if (!book) {
			continue;
		}

		const legacyId = book.legacyId;
		if (legacyId !== undefined && String(legacyId) === bookId) {
			return book;
		}
	}

	return Object.entries(apolloState)
		.filter(([key]) => key.startsWith("Book:"))
		.map(([, value]) => asObject(value))
		.find((value): value is JsonObject => !!value);
}

function contributorName(
	apolloState: JsonObject,
	book: JsonObject,
): string | undefined {
	const edges: JsonObject[] = [];
	const primary = asObject(book.primaryContributorEdge);
	if (primary) {
		edges.push(primary);
	}

	for (const edge of Array.isArray(book.secondaryContributorEdges)
		? book.secondaryContributorEdges
		: []) {
		const object = asObject(edge);
		if (object) {
			edges.push(object);
		}
	}

	const authorEdges = edges.filter(
		(edge) => !getString(edge.role) || getString(edge.role)?.toLowerCase() === "author",
	);

	for (const edge of [...authorEdges, ...edges]) {
		const node = asObject(edge.node);
		const ref = getString(node?.__ref);
		const contributor = ref ? asObject(apolloState[ref]) : undefined;
		const name = getString(contributor?.name);
		if (name) {
			return name;
		}
	}

	return undefined;
}

function seriesMetadata(
	apolloState: JsonObject,
	book: JsonObject,
): Pick<BookMetadata, "series" | "seriesIndex"> {
	const entries = Array.isArray(book.bookSeries)
		? book.bookSeries
		: [];

	for (const entry of entries) {
		const object = asObject(entry);
		if (!object) {
			continue;
		}

		const seriesRef = getString(asObject(object.series)?.__ref);
		const series = seriesRef ? asObject(apolloState[seriesRef]) : undefined;
		const title = getString(series?.title) ?? getString(series?.name);
		const position = getString(object.userPosition) ??
			(object.userPosition !== undefined ? String(object.userPosition) : undefined);

		if (title) {
			return {
				series: title,
				seriesIndex: position,
			};
		}
	}

	return {};
}

function genreMetadata(book: JsonObject): string[] | undefined {
	const values: string[] = [];

	for (const entry of Array.isArray(book.bookGenres) ? book.bookGenres : []) {
		const object = asObject(entry);
		const genre = asObject(object?.genre);
		const translated = translateGenre(getString(genre?.name));
		if (translated) {
			values.push(translated);
		}
	}

	return values.length ? [...new Set(values)] : undefined;
}

function metadataFromApollo(
	apolloState: JsonObject,
	bookId: string,
	fallback: GoodreadsAutocompleteItem,
): BookMetadata | undefined {
	const book = findMainBook(apolloState, bookId);
	if (!book) {
		return undefined;
	}

	const details = asObject(book.details) ?? {};
	const languageObject = asObject(details.language);
	const series = seriesMetadata(apolloState, book);
	const rawDescription =
		getString(book['description({"stripped":true})']) ??
		getString(book.description) ??
		stripHtml(fallback.description?.html);

	return {
		title: stripEditionNoise(
			getString(book.title) ??
			fallback.bookTitleBare ??
			fallback.title,
		),
		author:
			contributorName(apolloState, book) ??
			cleanText(fallback.author?.name),
		description: stripHtml(rawDescription) ?? rawDescription,
		language: normalizeGoodreadsLanguage(
			getString(languageObject?.name) ?? getString(details.language),
		),
		isbn:
			normalizeIsbn(getString(details.isbn13)) ??
			normalizeIsbn(getString(details.isbn)),
		publisher: getString(details.publisher),
		published: parsePublicationTime(details.publicationTime),
		pageCount:
			getNumber(details.numPages) ??
			fallback.numPages,
		series: series.series,
		seriesIndex: series.seriesIndex,
		subjects: genreMetadata(book),
	};
}

function metadataFromJsonLd(
	html: string,
	fallback: GoodreadsAutocompleteItem,
): BookMetadata | undefined {
	const scripts = [
		...html.matchAll(
			/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
		),
	];

	for (const match of scripts) {
		try {
			const raw = JSON.parse(match[1]) as unknown;
			const candidates = Array.isArray(raw) ? raw : [raw];

			for (const item of candidates) {
				const object = asObject(item);
				if (!object || getString(object["@type"]) !== "Book") {
					continue;
				}

				const authors = Array.isArray(object.author) ? object.author : [object.author];
				const firstAuthor = authors
					.map(asObject)
					.find((author): author is JsonObject => !!author);

				return {
					title: stripEditionNoise(
						getString(object.name) ?? fallback.bookTitleBare ?? fallback.title,
					),
					author: getString(firstAuthor?.name) ?? cleanText(fallback.author?.name),
					description: stripHtml(getString(object.description)),
					language: normalizeGoodreadsLanguage(getString(object.inLanguage)),
					isbn: normalizeIsbn(getString(object.isbn)),
					pageCount: getNumber(object.numberOfPages) ?? fallback.numPages,
				};
			}
		} catch {
			// Try the next JSON-LD block.
		}
	}

	return undefined;
}

function parseBookPage(
	html: string,
	bookId: string,
	fallback: GoodreadsAutocompleteItem,
): BookMetadata | undefined {
	const nextData = html.match(
		/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
	)?.[1];

	if (nextData) {
		try {
			const parsed = asObject(JSON.parse(nextData));
			const props = asObject(parsed?.props);
			const pageProps = asObject(props?.pageProps);
			const apolloState = asObject(pageProps?.apolloState);
			if (apolloState) {
				const metadata = metadataFromApollo(apolloState, bookId, fallback);
				if (metadata) {
					return metadata;
				}
			}
		} catch (error) {
			console.log("[Goodreads] could not parse __NEXT_DATA__", String(error));
		}
	}

	return metadataFromJsonLd(html, fallback);
}

function workOnlyMetadata(metadata: BookMetadata): BookMetadata {
	/*
	 * A non-Spanish Goodreads edition may still describe the same abstract
	 * work. Its edition-specific fields and synopsis must never leak into this
	 * Spanish-only library, but series + Goodreads shelves remain useful.
	 */
	return {
		title: metadata.title,
		author: metadata.author,
		series: metadata.series,
		seriesIndex: metadata.seriesIndex,
		subjects: metadata.subjects,
	};
}

function scoreCandidate(
	hypothesis: SearchHypothesis,
	metadata: BookMetadata,
): number {
	if (hypothesis.kind === "isbn") {
		const expected = normalizeIsbn(hypothesis.hints.isbn);
		const actual = normalizeIsbn(metadata.isbn);
		return expected && actual === expected ? 100 : 0;
	}

	if (hypothesis.kind === "series") {
		return scoreSeriesMatch(hypothesis.hints, metadata);
	}

	return scoreTitleMatch(hypothesis.hints, metadata);
}

function buildQuery(hypothesis: SearchHypothesis): string | undefined {
	const hints = hypothesis.hints;

	if (hints.isbn) {
		return normalizeIsbn(hints.isbn) ?? hints.isbn;
	}

	if (hypothesis.kind === "series" && hints.series) {
		return [hints.series, hints.seriesIndex, hints.author]
			.filter(Boolean)
			.join(" ");
	}

	if (hints.title) {
		return [stripEditionNoise(hints.title) ?? hints.title, hints.author]
			.filter(Boolean)
			.join(" ");
	}

	return undefined;
}

async function fetchAutocomplete(query: string): Promise<GoodreadsAutocompleteItem[]> {
	const url = `${GOODREADS_BASE_URL}/book/auto_complete?format=json&q=${encodeURIComponent(query)}`;
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			"User-Agent": "ereader-sync/1.0 metadata lookup",
		},
		signal: AbortSignal.timeout(5000),
	});

	if (!response.ok) {
		throw new Error(`autocomplete HTTP ${response.status}`);
	}

	const data = await response.json() as unknown;
	return Array.isArray(data) ? data as GoodreadsAutocompleteItem[] : [];
}

async function fetchBookMetadata(
	item: GoodreadsAutocompleteItem,
): Promise<{ metadata: BookMetadata; url: string } | undefined> {
	const bookId = item.bookId === undefined ? undefined : String(item.bookId);
	if (!bookId || !/^\d+$/.test(bookId)) {
		return undefined;
	}

	const url = `${GOODREADS_BASE_URL}/book/show/${bookId}`;
	const response = await fetch(url, {
		headers: {
			Accept: "text/html,application/xhtml+xml",
			"User-Agent": "Mozilla/5.0 (compatible; ereader-sync/1.0; metadata lookup)",
		},
		redirect: "follow",
		signal: AbortSignal.timeout(6000),
	});

	if (!response.ok) {
		return undefined;
	}

	const html = await response.text();
	const metadata = parseBookPage(html, bookId, item);
	return metadata ? { metadata, url } : undefined;
}

export async function lookupGoodreads(
	hypothesis: SearchHypothesis,
): Promise<MetadataCandidate | undefined> {
	const query = buildQuery(hypothesis);
	if (!query) {
		return undefined;
	}

	try {
		const autocomplete = await fetchAutocomplete(query);
		if (autocomplete.length === 0) {
			return undefined;
		}

		const details = await Promise.all(
			autocomplete
				.slice(0, MAX_DETAIL_CANDIDATES)
				.map((item) => fetchBookMetadata(item)),
		);

		let bestSpanish: MetadataCandidate | undefined;
		let bestWorkOnly: MetadataCandidate | undefined;

		for (const detail of details) {
			if (!detail) {
				continue;
			}

			const spanishEdition =
				detail.metadata.language === "es";

			/*
			 * Edition-level fields are accepted only when Goodreads explicitly
			 * marks the edition as Spanish. Missing language is treated as unknown,
			 * not as permission to import English publisher/ISBN/description data.
			 */
			const metadata = spanishEdition
				? detail.metadata
				: workOnlyMetadata(detail.metadata);

			const score = scoreCandidate(hypothesis, metadata);
			if (score <= 0) {
				continue;
			}

			const candidate: MetadataCandidate = {
				source: "goodreads",
				metadata,
				score,
				url: detail.url,
				matchedHypothesis: hypothesis,
			};

			if (spanishEdition) {
				if (!bestSpanish || candidate.score > bestSpanish.score) {
					bestSpanish = candidate;
				}
			} else if (
				(metadata.subjects?.length || metadata.series) &&
				(!bestWorkOnly || candidate.score > bestWorkOnly.score)
			) {
				bestWorkOnly = candidate;
			}
		}

		return bestSpanish ?? bestWorkOnly;
	} catch (error) {
		/*
		 * Goodreads has no supported public API anymore. Treat its public page
		 * data as best-effort enrichment and never block an EPUB upload if the
		 * site changes, challenges the Worker, or times out.
		 */
		console.log("[Goodreads] lookup failed", String(error));
		return undefined;
	}
}
