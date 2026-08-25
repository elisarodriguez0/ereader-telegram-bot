import {
	inferFromFileName,
	isMeaningful,
	mergeSubjects,
	normalizeText,
} from "./normalize";

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
} from "./types";

function setField(
	target: BookMetadata,

	sources:
		ResolvedMetadata["sources"],

	field: keyof BookMetadata,

	value:
		| string
		| number
		| string[]
		| undefined,

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

	(target as Record<
		string,
		unknown
	>)[field] = value;

	sources[field] = source;
}

function identityLooksBroken(
	existing: BookMetadata,
	filename: {
		title?: string;
		author?: string;
	},
): boolean {
	if (
		!isMeaningful(
			existing.title,
		) ||
		!isMeaningful(
			existing.author,
		)
	) {
		return true;
	}

	/*
	 * If filename contains a credible
	 * author but EPUB says Unknown etc.,
	 * handled above.
	 *
	 * Don't declare a mismatch just
	 * because translated titles differ.
	 */
	if (
		filename.author &&
		existing.author &&
		normalizeText(
			existing.author,
		) ===
			"desconocido"
	) {
		return true;
	}

	return false;
}

export async function resolveMetadata(
	existing: BookMetadata,
	originalFileName: string,
	options:
		MetadataResolverOptions,
): Promise<ResolvedMetadata> {
	const filename =
		inferFromFileName(
			originalFileName,
		);

	const searchIdentity = {
		title:
			filename.title ??
			(
				isMeaningful(
					existing.title,
				)
					? existing.title
					: undefined
			),

		author:
			filename.author ??
			(
				isMeaningful(
					existing.author,
				)
					? existing.author
					: undefined
			),

		isbn:
			existing.isbn,
	};

	const [
		lectulandia,
		googleBooks,
		openLibrary,
	] = await Promise.all([
		lookupLectulandia(
			searchIdentity,
			options
				.lectulandiaBaseUrl,
		),

		lookupGoogleBooks(
			searchIdentity,
			options
				.googleBooksApiKey,
		),

		lookupOpenLibrary(
			searchIdentity,
		),
	]);

	const matches =
		[
			lectulandia,
			googleBooks,
			openLibrary,
		].filter(
			(
				value,
			): value is MetadataCandidate =>
				!!value,
		);

	const identityBroken =
		identityLooksBroken(
			existing,
			filename,
		);

	const result:
		BookMetadata = {};

	const sources:
		ResolvedMetadata["sources"] =
			{};

	/*
	 * Start with existing metadata,
	 * but discard obvious garbage.
	 */
	if (
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

	if (existing.isbn) {
		setField(
			result,
			sources,
			"isbn",
			existing.isbn,
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
		isMeaningful(
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
		existing.subjects?.length
	) {
		setField(
			result,
			sources,
			"subjects",
			existing.subjects,
			"epub",
		);
	}

	/*
	 * Filename is better than
	 * "Desconocido"/missing metadata.
	 */
	if (!result.title) {
		setField(
			result,
			sources,
			"title",
			filename.title,
			"filename",
		);
	}

	if (!result.author) {
		setField(
			result,
			sources,
			"author",
			filename.author,
			"filename",
		);
	}

	/*
	 * Lectulandia has priority for
	 * Spanish-facing identity fields.
	 */
	if (
		lectulandia &&
		lectulandia.score >= 65
	) {
		const m =
			lectulandia.metadata;

		setField(
			result,
			sources,
			"title",
			m.title,
			"lectulandia",
			true,
		);

		setField(
			result,
			sources,
			"author",
			m.author,
			"lectulandia",
			true,
		);

		setField(
			result,
			sources,
			"description",
			m.description,
			"lectulandia",
			true,
		);

		setField(
			result,
			sources,
			"series",
			m.series,
			"lectulandia",
			true,
		);

		setField(
			result,
			sources,
			"seriesIndex",
			m.seriesIndex,
			"lectulandia",
			true,
		);

		if (
			m.subjects?.length
		) {
			setField(
				result,
				sources,
				"subjects",
				m.subjects,
				"lectulandia",
				true,
			);
		}
	}

	/*
	 * Google Books supplies
	 * bibliographic/edition information.
	 *
	 * It can replace title/author only
	 * when the embedded identity was
	 * clearly broken and Lectulandia
	 * didn't resolve it.
	 */
	if (
		googleBooks &&
		googleBooks.score >= 65
	) {
		const m =
			googleBooks.metadata;

		if (
			identityBroken &&
			!lectulandia
		) {
			setField(
				result,
				sources,
				"title",
				m.title,
				"google-books",
				true,
			);

			setField(
				result,
				sources,
				"author",
				m.author,
				"google-books",
				true,
			);
		}

		if (!result.description) {
			setField(
				result,
				sources,
				"description",
				m.description,
				"google-books",
			);
		}

		if (!result.isbn) {
			setField(
				result,
				sources,
				"isbn",
				m.isbn,
				"google-books",
			);
		}

		/*
		 * Prefer high-confidence Google
		 * edition data over suspicious
		 * generator timestamps.
		 */
		if (m.publisher) {
			setField(
				result,
				sources,
				"publisher",
				m.publisher,
				"google-books",
				true,
			);
		}

		if (m.published) {
			setField(
				result,
				sources,
				"published",
				m.published,
				"google-books",
				true,
			);
		}

		if (m.pageCount) {
			setField(
				result,
				sources,
				"pageCount",
				m.pageCount,
				"google-books",
				true,
			);
		}

		if (!result.language) {
			setField(
				result,
				sources,
				"language",
				m.language,
				"google-books",
			);
		}

		if (
			!result.seriesIndex &&
			m.seriesIndex
		) {
			setField(
				result,
				sources,
				"seriesIndex",
				m.seriesIndex,
				"google-books",
			);
		}

		if (
			!result.subjects?.length &&
			m.subjects?.length
		) {
			setField(
				result,
				sources,
				"subjects",
				m.subjects,
				"google-books",
			);
		}
	}

	/*
	 * Open Library is last resort.
	 * It never overrides a good
	 * Lectulandia/Google result.
	 */
	if (
		openLibrary &&
		openLibrary.score >= 70
	) {
		const m =
			openLibrary.metadata;

		if (
			identityBroken &&
			!lectulandia &&
			!googleBooks
		) {
			setField(
				result,
				sources,
				"title",
				m.title,
				"open-library",
				true,
			);

			setField(
				result,
				sources,
				"author",
				m.author,
				"open-library",
				true,
			);
		}

		setField(
			result,
			sources,
			"description",
			m.description,
			"open-library",
		);

		setField(
			result,
			sources,
			"isbn",
			m.isbn,
			"open-library",
		);

		setField(
			result,
			sources,
			"publisher",
			m.publisher,
			"open-library",
		);

		setField(
			result,
			sources,
			"published",
			m.published,
			"open-library",
		);

		setField(
			result,
			sources,
			"language",
			m.language,
			"open-library",
		);

		setField(
			result,
			sources,
			"series",
			m.series,
			"open-library",
		);

		if (
			!result.subjects?.length
		) {
			setField(
				result,
				sources,
				"subjects",
				m.subjects,
				"open-library",
			);
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
		const oldValue =
			existing[field];

		const newValue =
			result[field];

		if (
			JSON.stringify(
				oldValue ??
					null,
			) !==
			JSON.stringify(
				newValue ??
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

	if (!lectulandia) {
		warnings.push(
			"Lectulandia unavailable or no confident match",
		);
	}

	if (
		options.googleBooksApiKey &&
		!googleBooks
	) {
		warnings.push(
			"Google Books returned no confident match",
		);
	}

	if (!result.description) {
		warnings.push(
			"Description is still missing",
		);
	}

	if (!result.series) {
		warnings.push(
			"Series is unknown",
		);
	}

	if (!result.title) {
		warnings.push(
			"Title is missing",
		);
	}

	if (!result.author) {
		warnings.push(
			"Author is missing",
		);
	}

	return {
		metadata:
			result,

		sources,

		repairedFields,

		warnings,

		matches,
	};
}