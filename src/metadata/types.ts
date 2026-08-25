export type MetadataSource =
	| "epub"
	| "filename"
	| "lectulandia"
	| "google-books"
	| "open-library";

export interface BookMetadata {
	title?: string;
	author?: string;
	description?: string;
	language?: string;
	isbn?: string;
	publisher?: string;
	published?: string;
	pageCount?: number;
	series?: string;
	seriesIndex?: string;
	subjects?: string[];
}

export interface BookSearchHints {
	title?: string;
	author?: string;
	series?: string;
	seriesIndex?: string;
	isbn?: string;
	language?: string;
}

export type SearchHypothesisKind =
	| "title"
	| "series"
	| "isbn";

export type SearchHypothesisOrigin =
	| "embedded-isbn"
	| "discovered-isbn"
	| "embedded-title"
	| "filename-full"
	| "filename-split"
	| "filename-series-explicit"
	| "filename-series-ambiguous"
	| "canonical";

export interface SearchHypothesis {
	kind: SearchHypothesisKind;
	origin: SearchHypothesisOrigin;
	confidence: number;
	hints: BookSearchHints;
}

export interface ParsedFileName {
	baseName: string;
	hypotheses: SearchHypothesis[];
}

export interface MetadataCandidate {
	source: MetadataSource;
	metadata: BookMetadata;
	score: number;
	url?: string;
	matchedHypothesis?: SearchHypothesis;
}

export interface ResolvedMetadata {
	metadata: BookMetadata;

	sources: Partial<
		Record<
			keyof BookMetadata,
			MetadataSource
		>
	>;

	repairedFields: string[];
	warnings: string[];
	matches: MetadataCandidate[];
}

export interface MetadataResolverOptions {
	googleBooksApiKey?: string;
	lectulandiaBaseUrl?: string;
}
