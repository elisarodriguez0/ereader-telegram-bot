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
 * Xteink X4 / VCodex
 *
 * VCodex's own documentation recommends custom sleep images as:
 *
 * - 480 x 800 pixels on X4
 * - uncompressed BMP
 * - 24-bit color depth
 *
 * Do not pre-quantize or dither the image here. VCodex already knows how
 * to render a 24-bit BMP to the X4's native grayscale when the sleep screen
 * is displayed. The Worker only prepares the pixels and wraps them in a
 * standard 24-bit BI_RGB BMP.
 */
function makeBmp24(
	rgb: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const sourceRowBytes =
		width * 3;

	const bmpRowBytes =
		Math.ceil(
			sourceRowBytes / 4,
		) * 4;

	const pixelBytes =
		bmpRowBytes * height;

	const headerBytes = 54;
	const fileBytes =
		headerBytes + pixelBytes;

	if (
		rgb.byteLength !==
		sourceRowBytes * height
	) {
		throw new Error(
			`Unexpected RGB output size: ${rgb.byteLength} bytes`,
		);
	}

	const bmp =
		new Uint8Array(
			fileBytes,
		);

	const view =
		new DataView(
			bmp.buffer,
		);

	// BITMAPFILEHEADER
	bmp[0] = 0x42; // B
	bmp[1] = 0x4d; // M
	view.setUint32(
		2,
		fileBytes,
		true,
	);
	view.setUint32(
		10,
		headerBytes,
		true,
	);

	// BITMAPINFOHEADER
	view.setUint32(
		14,
		40,
		true,
	);
	view.setInt32(
		18,
		width,
		true,
	);

	// Negative height means top-down row order. Cloudflare's raw RGB output
	// is top-down, and VCodex's Bitmap reader explicitly supports this form.
	view.setInt32(
		22,
		-height,
		true,
	);
	view.setUint16(
		26,
		1,
		true,
	); // planes
	view.setUint16(
		28,
		24,
		true,
	); // bits per pixel
	view.setUint32(
		30,
		0,
		true,
	); // BI_RGB = uncompressed
	view.setUint32(
		34,
		pixelBytes,
		true,
	);

	for (
		let y = 0;
		y < height;
		y++
	) {
		const sourceRow =
			y * sourceRowBytes;

		const targetRow =
			headerBytes +
			y * bmpRowBytes;

		for (
			let x = 0;
			x < width;
			x++
		) {
			const source =
				sourceRow + x * 3;

			const target =
				targetRow + x * 3;

			// Cloudflare outputs RGB. BMP stores 24-bit pixels as BGR.
			bmp[target] =
				rgb[source + 2];
			bmp[target + 1] =
				rgb[source + 1];
			bmp[target + 2] =
				rgb[source];
		}
	}

	return bmp;
}

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
					"rgb",
			});

	const response =
		output.response();

	if (!response.ok) {
		throw new Error(
			`Cloudflare Images failed with HTTP ${response.status}`,
		);
	}

	const rgb =
		new Uint8Array(
			await response
				.arrayBuffer(),
		);

	const bmp =
		makeBmp24(
			rgb,
			XTEINK_WIDTH,
			XTEINK_HEIGHT,
		);

	const stem =
		fileName.replace(
			/\.[^.]+$/,
			"",
		);

	const outputName =
		`${stem}.bmp`;

	const key =
		`${XTEINK_PREFIX}${outputName}`;

	await env
		.EREADER_BUCKET
		.put(
			key,
			bmp,
			{
				httpMetadata: {
					contentType:
						"image/bmp",
				},

				customMetadata: {
					kind:
						"wallpaper-xteink-x4",

					width:
						String(
							XTEINK_WIDTH,
						),

					height:
						String(
							XTEINK_HEIGHT,
						),

					format:
						"bmp24-uncompressed",

					finalFormat:
						"bmp24-uncompressed",

					finalDirectory:
						"/.sleep/",

					source:
						`${ORIGINAL_PREFIX}${fileName}`,
				},
			},
		);

	// Clean up the old per-wallpaper JPEG output from the previous pipeline.
	// The original image remains untouched in wallpapers/original/.
	await Promise.all([
		env.EREADER_BUCKET.delete(
			`${XTEINK_PREFIX}${stem}.jpg`,
		),
		env.EREADER_BUCKET.delete(
			`${XTEINK_PREFIX}${stem}.jpeg`,
		),
	]);

	return key;
}