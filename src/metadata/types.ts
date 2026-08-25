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

export interface MetadataCandidate {
	source: MetadataSource;

	metadata: BookMetadata;

	score: number;

	url?: string;
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

export interface FilenameMetadata {
	title?: string;
	author?: string;
}

export interface MetadataResolverOptions {
	googleBooksApiKey?: string;

	lectulandiaBaseUrl?: string;
}