import type {
	Env,
} from "./env";

const ORIGINAL_PREFIX =
	"wallpapers/original/";

const KINDLE_PREFIX =
	"wallpapers/kindle/";

const XTEINK_PREFIX =
	"wallpapers/xteink/";

const KINDLE_WIDTH = 1236;
const KINDLE_HEIGHT = 1648;

const XTEINK_WIDTH = 480;
const XTEINK_HEIGHT = 800;

export interface StoredWallpaperOriginal {
	fileName: string;
	key: string;
	mimeType: string;
}

function normalizeExtension(
	value?: string,
): string {
	const clean =
		value
			?.toLowerCase()
			.replace(
				/[^a-z0-9]/g,
				"",
			);

	if (
		clean === "jpg" ||
		clean === "jpeg"
	) {
		return "jpg";
	}

	if (
		clean === "png" ||
		clean === "webp"
	) {
		return clean;
	}

	return "jpg";
}

function extensionFrom(
	fileName?: string,
	filePath?: string,
	mimeType?: string,
): string {
	const fromName =
		fileName?.match(
			/\.([a-z0-9]+)$/i,
		)?.[1];

	const fromPath =
		filePath?.match(
			/\.([a-z0-9]+)$/i,
		)?.[1];

	if (fromName) {
		return normalizeExtension(
			fromName,
		);
	}

	if (fromPath) {
		return normalizeExtension(
			fromPath,
		);
	}

	switch (
		mimeType?.toLowerCase()
	) {
		case "image/png":
			return "png";

		case "image/webp":
			return "webp";

		default:
			return "jpg";
	}
}

function mimeFromExtension(
	extension: string,
): string {
	switch (extension) {
		case "png":
			return "image/png";

		case "webp":
			return "image/webp";

		default:
			return "image/jpeg";
	}
}

async function listAllObjects(
	env: Env,
	prefix: string,
): Promise<any[]> {
	const objects: any[] = [];

	let cursor:
		| string
		| undefined;

	do {
		const page =
			await env
				.EREADER_BUCKET
				.list({
					prefix,

					limit:
						1000,

					...(cursor
						? {
								cursor,
						  }
						: {}),
				});

		objects.push(
			...(
				page.objects ??
				[]
			),
		);

		cursor =
			page.truncated
				? page.cursor
				: undefined;

	} while (cursor);

	return objects;
}

async function nextWallpaperNumber(
	env: Env,
): Promise<number> {
	const objects =
		await listAllObjects(
			env,
			ORIGINAL_PREFIX,
		);

	let max = 0;

	for (
		const object
		of objects
	) {
		const match =
			String(
				object.key,
			).match(
				/wallpaper_(\d+)/i,
			);

		if (!match) {
			continue;
		}

		max =
			Math.max(
				max,
				Number(
					match[1],
				) || 0,
			);
	}

	return max + 1;
}

export async function storeWallpaperOriginal(
	env: Env,

	bytes:
		Uint8Array,

	options: {
		fileName?: string;
		filePath?: string;
		mimeType?: string;
	},
): Promise<
	StoredWallpaperOriginal
> {
	const number =
		await nextWallpaperNumber(
			env,
		);

	const extension =
		extensionFrom(
			options.fileName,
			options.filePath,
			options.mimeType,
		);

	const fileName =
		`wallpaper_${String(
			number,
		).padStart(
			3,
			"0",
		)}.${extension}`;

	const key =
		`${ORIGINAL_PREFIX}${fileName}`;

	const mimeType =
		mimeFromExtension(
			extension,
		);

	await env
		.EREADER_BUCKET
		.put(
			key,
			bytes,
			{
				httpMetadata: {
					contentType:
						mimeType,
				},

				customMetadata: {
					kind:
						"wallpaper-original",
				},
			},
		);

	return {
		fileName,
		key,
		mimeType,
	};
}

async function getOriginal(
	env: Env,
	fileName: string,
): Promise<any> {
	if (
		!/^wallpaper_\d+\.(?:jpe?g|png|webp)$/i.test(
			fileName,
		)
	) {
		throw new Error(
			"Invalid wallpaper filename",
		);
	}

	const object =
		await env
			.EREADER_BUCKET
			.get(
				`${ORIGINAL_PREFIX}${fileName}`,
			);

	if (!object) {
		throw new Error(
			"Wallpaper original not found",
		);
	}

	return object;
}

/*
 * Kindle Paperwhite 5
 *
 * Final format is already usable directly by
 * the Kindle screensaver directory.
 */
export async function prepareKindleWallpaper(
	env: Env,
	fileName: string,
): Promise<string> {
	const original =
		await getOriginal(
			env,
			fileName,
		);

	const output =
		await env.IMAGES
			.input(
				original.body,
			)
			.transform({
				width:
					KINDLE_WIDTH,

				height:
					KINDLE_HEIGHT,

				fit:
					"cover",

				gravity:
					"auto",

				saturation:
					0,
			})
			.output({
				format:
					"image/jpeg",

				quality:
					90,
			});

	const response =
		output.response();

	if (!response.ok) {
		throw new Error(
			`Cloudflare Images failed with HTTP ${response.status}`,
		);
	}

	const bytes =
		await response
			.arrayBuffer();

	const stem =
		fileName.replace(
			/\.[^.]+$/,
			"",
		);

	const outputName =
		`${stem}.jpg`;

	const key =
		`${KINDLE_PREFIX}${outputName}`;

	await env
		.EREADER_BUCKET
		.put(
			key,
			bytes,
			{
				httpMetadata: {
					contentType:
						"image/jpeg",
				},

				customMetadata: {
					kind:
						"wallpaper-kindle-pw5",

					width:
						String(
							KINDLE_WIDTH,
						),

					height:
						String(
							KINDLE_HEIGHT,
						),

					source:
						`${ORIGINAL_PREFIX}${fileName}`,
				},
			},
		);

	return key;
}

/*
 * Xteink X4 / CrossInk
 *
 * IMPORTANT:
 *
 * We deliberately DO NOT create the BMP inside
 * the Cloudflare Worker.
 *
 * The Worker only performs the expensive parts
 * Cloudflare Images is good at:
 *
 * - EXIF orientation
 * - resize
 * - aspect ratio
 * - white padding
 * - grayscale
 *
 * CrossInk will convert this prepared 480x800 JPEG
 * into its final uncompressed BMP when syncing it
 * into /.sleep/.
 *
 * This avoids expensive PNG decoding + dithering +
 * BMP encoding inside the Worker.
 */
export async function prepareXteinkWallpaper(
	env: Env,
	fileName: string,
): Promise<string> {
	const original =
		await getOriginal(
			env,
			fileName,
		);

	const output =
		await env.IMAGES
			.input(
				original.body,
			)
			.transform({
				width:
					XTEINK_WIDTH,

				height:
					XTEINK_HEIGHT,

				fit:
				"cover",

				gravity:
				"auto",

				saturation:
					0,
			})
			.output({
				format:
					"image/jpeg",

				quality:
					90,
			});

	const response =
		output.response();

	if (!response.ok) {
		throw new Error(
			`Cloudflare Images failed with HTTP ${response.status}`,
		);
	}

	const bytes =
		await response
			.arrayBuffer();

	const stem =
		fileName.replace(
			/\.[^.]+$/,
			"",
		);

	const outputName =
		`${stem}.jpg`;

	const key =
		`${XTEINK_PREFIX}${outputName}`;

	await env
		.EREADER_BUCKET
		.put(
			key,
			bytes,
			{
				httpMetadata: {
					contentType:
						"image/jpeg",
				},

				customMetadata: {
					kind:
						"wallpaper-xteink-x4-source",

					width:
						String(
							XTEINK_WIDTH,
						),

					height:
						String(
							XTEINK_HEIGHT,
						),

					format:
						"jpeg-grayscale-source",

					finalFormat:
						"bmp24-uncompressed",

					finalDirectory:
						"/.sleep/",

					source:
						`${ORIGINAL_PREFIX}${fileName}`,
				},
			},
		);

	return key;
}