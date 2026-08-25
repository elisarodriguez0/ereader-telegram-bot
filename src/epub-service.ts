import {
	repairEpub,
} from "./metadata/epub";

import type {
	BookMetadata,
	MetadataSource,
} from "./metadata/types";

export interface TelegramEpubDocument {
	file_id: string;

	file_unique_id: string;

	file_name?: string;

	mime_type?: string;

	file_size?: number;
}

export interface EpubUploadResult {
	r2Key: string;

	metadata:
		BookMetadata;

	sources:
		Partial<
			Record<
				keyof BookMetadata,
				MetadataSource
			>
		>;

	repairedFields:
		string[];

	warnings:
		string[];

	matches:
		Array<{
			source:
				string;

			score:
				number;

			url?: string;
		}>;
}

async function getTelegramFilePath(
	token: string,
	fileId: string,
): Promise<string> {
	const response =
		await fetch(
			`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
		);

	if (!response.ok) {
		throw new Error(
			`Telegram getFile failed: HTTP ${response.status}`,
		);
	}

	const data =
		(await response.json()) as {
			ok: boolean;

			result?: {
				file_path?: string;
			};

			description?: string;
		};

	if (
		!data.ok ||
		!data.result?.file_path
	) {
		throw new Error(
			data.description ??
				"Telegram did not return file_path",
		);
	}

	return data.result.file_path;
}

function sanitizeFileName(
	fileName: string,
): string {
	return fileName
		.replace(
			/[<>:"/\\|?*\x00-\x1F]/g,
			"_",
		)
		.trim();
}

export async function processEpubUpload(
	options: {
		telegramToken: string;

		bucket: R2Bucket;

		document:
			TelegramEpubDocument;

		googleBooksApiKey?: string;

		lectulandiaBaseUrl?: string;
	},
): Promise<EpubUploadResult> {
	const {
		telegramToken,
		bucket,
		document,
		googleBooksApiKey,
		lectulandiaBaseUrl,
	} = options;

	const filePath =
		await getTelegramFilePath(
			telegramToken,
			document.file_id,
		);

	const download =
		await fetch(
			`https://api.telegram.org/file/bot${telegramToken}/${filePath}`,
		);

	if (!download.ok) {
		throw new Error(
			`Telegram download failed: HTTP ${download.status}`,
		);
	}

	const originalFileName =
		document.file_name ??
		`${document.file_unique_id}.epub`;

	const originalBytes =
		new Uint8Array(
			await download.arrayBuffer(),
		);

	const repaired =
		await repairEpub(
			originalBytes,
			originalFileName,
			{
				googleBooksApiKey,

				lectulandiaBaseUrl:
					lectulandiaBaseUrl ??
					"https://ww3.lectulandia.com",
			},
		);

	const safeFileName =
		sanitizeFileName(
			originalFileName,
		);

	const r2Key =
		`books/${safeFileName}`;

	const metadata =
		repaired.resolved.metadata;

	const customMetadata:
		Record<string, string> =
			{
				telegramFileUniqueId:
					document.file_unique_id,

				originalFileName,

				repairedFields:
					repaired.resolved
						.repairedFields
						.join(","),

				warnings:
					repaired.resolved
						.warnings
						.join(" | ")
						.slice(0, 1500),
			};

	function set(
		key: string,
		value:
			| string
			| number
			| undefined,
	): void {
		if (
			value !== undefined &&
			value !== ""
		) {
			customMetadata[key] =
				String(value);
		}
	}

	set(
		"title",
		metadata.title,
	);

	set(
		"author",
		metadata.author,
	);

	set(
		"language",
		metadata.language,
	);

	set(
		"isbn",
		metadata.isbn,
	);

	set(
		"publisher",
		metadata.publisher,
	);

	set(
		"published",
		metadata.published,
	);

	set(
		"pageCount",
		metadata.pageCount,
	);

	set(
		"series",
		metadata.series,
	);

	set(
		"seriesIndex",
		metadata.seriesIndex,
	);

	set(
		"subjects",
		metadata.subjects
			?.join(", ")
			.slice(0, 500),
	);

	set(
		"metadataSources",
		Object.entries(
			repaired.resolved
				.sources,
		)
			.map(
				([field, source]) =>
					`${field}:${source}`,
			)
			.join(","),
	);

	await bucket.put(
		r2Key,
		repaired.bytes,
		{
			httpMetadata: {
				contentType:
					"application/epub+zip",
			},

			customMetadata,
		},
	);

	return {
		r2Key,

		metadata,

		sources:
			repaired.resolved.sources,

		repairedFields:
			repaired.resolved
				.repairedFields,

		warnings:
			repaired.resolved
				.warnings,

		matches:
			repaired.resolved.matches
				.map(
					(match) => ({
						source:
							match.source,

						score:
							match.score,

						url:
							match.url,
					}),
				),
	};
}