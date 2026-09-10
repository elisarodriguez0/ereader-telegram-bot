import {
	strToU8,
	unzipSync,
	zipSync,
} from "fflate";

import type {
	Env,
} from "./env";

export interface XteinkEpubOptimizationResult {
	bytes: Uint8Array;
	originalSize: number;
	optimizedSize: number;
	optimizedImages: number;
	skippedImages: number;
	svgFixes: number;
}

const MAX_WIDTH = 480;
const MAX_HEIGHT = 800;
const JPEG_QUALITY = 85;

const DEFENSIVE_STYLE =
	'<style type="text/css">img,svg{max-width:100%;height:auto}body{overflow-wrap:break-word}table{max-width:100%;table-layout:fixed}pre,code{white-space:pre-wrap;word-wrap:break-word}*{box-sizing:border-box}</style>';

const RASTER_IMAGE_PATTERN =
	/\.(?:png|gif|webp|bmp|jpe?g)$/i;

const TEXT_DOCUMENT_PATTERN =
	/\.(?:xhtml|html|htm)$/i;

function findOpfPath(
	files: Record<string, Uint8Array>,
): string {
	const containerKey = Object.keys(files)
		.find((name) =>
			name.toLowerCase() ===
			"meta-inf/container.xml",
		);

	if (containerKey) {
		const container = readText(
			files[containerKey],
		);
		const match = container.match(
			/<rootfile\b[^>]*\bfull-path=["']([^"']+)["'][^>]*>/i,
		);

		if (
			match?.[1] &&
			files[match[1]]
		) {
			return match[1];
		}
	}

	const fallback = Object.keys(files)
		.find((name) =>
			name.toLowerCase().endsWith(".opf"),
		);

	if (!fallback) {
		throw new Error(
			"Could not locate EPUB OPF package document",
		);
	}

	return fallback;
}

function decodeHref(
	value: string,
): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function normalizePath(
	value: string,
): string {
	const parts: string[] = [];

	for (const part of value
		.replace(/^\/+/, "")
		.split("/")) {
		if (!part || part === ".") {
			continue;
		}

		if (part === "..") {
			parts.pop();
			continue;
		}

		parts.push(part);
	}

	return parts.join("/");
}

function resolvePath(
	basePath: string,
	href: string,
): string {
	const decoded = decodeHref(href);

	if (decoded.startsWith("/")) {
		return normalizePath(decoded);
	}

	const lastSlash = basePath.lastIndexOf("/");
	const baseDirectory =
		lastSlash >= 0
			? basePath.slice(0, lastSlash + 1)
			: "";

	return normalizePath(
		`${baseDirectory}${decoded}`,
	);
}

function splitReference(
	value: string,
): {
	path: string;
	suffix: string;
} {
	const hash = value.indexOf("#");
	const query = value.indexOf("?");
	const positions = [hash, query]
		.filter((position) => position >= 0);

	if (!positions.length) {
		return {
			path: value,
			suffix: "",
		};
	}

	const splitAt = Math.min(...positions);

	return {
		path: value.slice(0, splitAt),
		suffix: value.slice(splitAt),
	};
}

function replaceReferenceExtension(
	value: string,
): string {
	const {
		path,
		suffix,
	} = splitReference(value);

	return (
		path.replace(
			/\.[^./?#]+$/,
			".jpg",
		) + suffix
	);
}

function mappedReference(
	documentPath: string,
	value: string,
	renamed: Map<string, string>,
): string {
	if (
		/^(?:data:|https?:|mailto:|javascript:)/i.test(
			value,
		)
	) {
		return value;
	}

	const {
		path,
	} = splitReference(value);

	if (!path) {
		return value;
	}

	const resolved = resolvePath(
		documentPath,
		path,
	);

	if (!renamed.has(resolved)) {
		return value;
	}

	/*
	 * Converted images stay in the same EPUB directory and retain their stem,
	 * so replacing only the extension preserves ../ segments and URI encoding.
	 */
	return replaceReferenceExtension(value);
}

function rewriteAttributeReferences(
	content: string,
	documentPath: string,
	renamed: Map<string, string>,
): string {
	return content.replace(
		/(\b(?:src|href|xlink:href)\s*=\s*["'])([^"']+)(["'])/gi,
		(_match, before: string, value: string, after: string) =>
			`${before}${mappedReference(documentPath, value, renamed)}${after}`,
	);
}

function rewriteCssReferences(
	content: string,
	documentPath: string,
	renamed: Map<string, string>,
): string {
	return content.replace(
		/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
		(_match, quote: string, value: string) => {
			const rewritten = mappedReference(
				documentPath,
				value,
				renamed,
			);
			return `url(${quote}${rewritten}${quote})`;
		},
	);
}

function removeImgDimensions(
	content: string,
): string {
	return content.replace(
		/<img\b[^>]*>/gi,
		(tag) =>
			tag
				.replace(
					/\s+(?:width|height)\s*=\s*(?:["'][^"']*["']|[^\s>]+)/gi,
					"",
				),
	);
}

function fixSvgWrappedImages(
	content: string,
): {
	content: string;
	count: number;
} {
	let count = 0;

	const rewritten = content.replace(
		/<(?:svg:)?svg\b[^>]*>[\s\S]*?<(?:svg:)?image\b[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*\/?>(?:[\s\S]*?<\/(?:svg:)?image\s*>)?[\s\S]*?<\/(?:svg:)?svg\s*>/gi,
		(_match, href: string) => {
			count++;
			return `<img style="max-width:100%;height:auto" src="${href}" alt="" />`;
		},
	);

	return {
		content: rewritten,
		count,
	};
}

function injectDefensiveStyle(
	content: string,
): string {
	if (
		content.includes(
			"img,svg{max-width:100%;height:auto}",
		)
	) {
		return content;
	}

	if (/<\/head\s*>/i.test(content)) {
		return content.replace(
			/<\/head\s*>/i,
			`${DEFENSIVE_STYLE}</head>`,
		);
	}

	return content;
}

function normalizeTextEncodingDeclaration(
	content: string,
): string {
	return content
		.replace(
			/(<\?xml\b[^>]*\bencoding\s*=\s*["'])[^"']+(["'][^>]*\?>)/i,
			"$1utf-8$2",
		)
		.replace(
			/(<meta\b[^>]*\bcharset\s*=\s*["']?)[^"'\s/>]+/i,
			"$1utf-8",
		)
		.replace(
			/(charset\s*=\s*)[^;"'\s]+/i,
			"$1UTF-8",
		)
		.replace(
			/^\s*@charset\s+["'][^"']+["'];?/i,
			'@charset "UTF-8";',
		);
}

function readText(
	bytes: Uint8Array,
): string {
	let offset = 0;

	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	) {
		offset = 3;
	}

	const data = bytes.subarray(offset);

	try {
		return new TextDecoder(
			"utf-8",
			{ fatal: true, ignoreBOM: false },
		).decode(data);
	} catch {
		/* Continue with the declared charset. */
	}

	const header = new TextDecoder(
		"windows-1252",
	).decode(
		data.subarray(
			0,
			Math.min(1024, data.length),
		),
	);

	const declared =
		header.match(
			/encoding=["']([^"']+)["']/i,
		)?.[1] ??
		header.match(
			/charset=["']?([^"'\s;/>]+)/i,
		)?.[1] ??
		"windows-1252";

	try {
		return normalizeTextEncodingDeclaration(
			new TextDecoder(
				declared,
				{ fatal: false, ignoreBOM: false },
			).decode(data),
		);
	} catch {
		return normalizeTextEncodingDeclaration(
			new TextDecoder(
				"windows-1252",
				{ fatal: false, ignoreBOM: false },
			).decode(data),
		);
	}
}

function rewriteOpf(
	content: string,
	opfPath: string,
	renamed: Map<string, string>,
	svgFixedDocuments: Set<string>,
): string {
	let output = content.replace(
		/<(?:[\w.-]+:)?item\b[^>]*\/?\s*>/gi,
		(tag) => {
			const hrefMatch = tag.match(
				/\bhref\s*=\s*(["'])([^"']+)\1/i,
			);

			if (!hrefMatch) {
				return tag;
			}

			const href = hrefMatch[2];
			const {
				path,
			} = splitReference(href);
			const resolved = resolvePath(
				opfPath,
				path,
			);
			let rewritten = tag;

			if (renamed.has(resolved)) {
				const newHref =
					replaceReferenceExtension(href);

				rewritten = rewritten.replace(
					/(\bhref\s*=\s*["'])[^"']+(["'])/i,
					`$1${newHref}$2`,
				);

				if (/\bmedia-type\s*=/i.test(rewritten)) {
					rewritten = rewritten.replace(
						/(\bmedia-type\s*=\s*["'])image\/(?:png|gif|webp|bmp|jpe?g)(["'])/i,
						"$1image/jpeg$2",
					);
				} else {
					rewritten = rewritten.replace(
						/\s*\/?>$/,
						(match) =>
							` media-type="image/jpeg"${match}`,
					);
				}
			}

			if (svgFixedDocuments.has(resolved)) {
				const propertiesMatch = rewritten.match(
					/\bproperties\s*=\s*(["'])([^"']*)\1/i,
				);

				if (propertiesMatch) {
					const remaining = propertiesMatch[2]
						.split(/\s+/)
						.filter(
							(value) =>
								value &&
								value !== "svg",
						)
						.join(" ");

					if (remaining) {
						rewritten = rewritten.replace(
							/\bproperties\s*=\s*(["'])[^"']*\1/i,
							`properties="${remaining}"`,
						);
					} else {
						rewritten = rewritten.replace(
							/\s+properties\s*=\s*(["'])[^"']*\1/i,
							"",
						);
					}
				}
			}

			return rewritten;
		},
	);

	output = ensureCoverMeta(output);

	return output;
}

function ensureCoverMeta(
	opf: string,
): string {
	let coverId: string | undefined;
	const itemTags =
		opf.match(
			/<(?:[\w.-]+:)?item\b[^>]*\/?\s*>/gi,
		) ?? [];

	for (const tag of itemTags) {
		const type = tag.match(
			/\bmedia-type\s*=\s*["']([^"']+)["']/i,
		)?.[1];
		const properties = tag.match(
			/\bproperties\s*=\s*["']([^"']+)["']/i,
		)?.[1];
		const id = tag.match(
			/\bid\s*=\s*["']([^"']+)["']/i,
		)?.[1];

		if (
			type?.startsWith("image/") &&
			properties
				?.split(/\s+/)
				.includes("cover-image") &&
			id
		) {
			coverId = id;
			break;
		}
	}

	if (!coverId) {
		for (const tag of itemTags) {
			const type = tag.match(
				/\bmedia-type\s*=\s*["']([^"']+)["']/i,
			)?.[1];
			const id = tag.match(
				/\bid\s*=\s*["']([^"']+)["']/i,
			)?.[1];
			const href = tag.match(
				/\bhref\s*=\s*["']([^"']+)["']/i,
			)?.[1];

			if (
				type?.startsWith("image/") &&
				id &&
				(
					id.toLowerCase().includes("cover") ||
					href?.toLowerCase().includes("cover")
				)
			) {
				coverId = id;
				break;
			}
		}
	}

	if (!coverId) {
		return opf;
	}

	const coverMeta =
		/<(?:[\w.-]+:)?meta\b(?=[^>]*\bname\s*=\s*["']cover["'])[^>]*\/?>/i;

	if (coverMeta.test(opf)) {
		return opf.replace(
			coverMeta,
			(tag) => {
				if (/\bcontent\s*=/i.test(tag)) {
					return tag.replace(
						/(\bcontent\s*=\s*["'])[^"']*(["'])/i,
						`$1${coverId}$2`,
					);
				}

				return tag.replace(
					/\s*\/?>$/,
					(match) =>
						` content="${coverId}"${match}`,
				);
			},
		);
	}

	return opf.replace(
		/<\/(?:[\w.-]+:)?metadata\s*>/i,
		`    <meta name="cover" content="${coverId}"/>\n  </metadata>`,
	);
}

async function convertImage(
	env: Env,
	bytes: Uint8Array,
): Promise<Uint8Array> {
	const stream = new Response(bytes).body;

	if (!stream) {
		throw new Error(
			"Could not create image stream",
		);
	}

	const result = await env.IMAGES
		.input(stream)
		.transform({
			width: MAX_WIDTH,
			height: MAX_HEIGHT,
			fit: "scale-down",
			saturation: 0,
			background: "#FFFFFF",
			metadata: "none",
		})
		.output({
			format: "image/jpeg",
			quality: JPEG_QUALITY,
			anim: false,
		});

	const response = result.response();

	if (!response.ok) {
		throw new Error(
			`Cloudflare Images failed with HTTP ${response.status}`,
		);
	}

	return new Uint8Array(
		await response.arrayBuffer(),
	);
}

export async function optimizeEpubForXteink(
	env: Env,
	inputBytes: Uint8Array,
): Promise<XteinkEpubOptimizationResult> {
	const files = unzipSync(inputBytes);
	const opfPath = findOpfPath(files);
	const renamed = new Map<string, string>();
	const processedImages = new Map<string, Uint8Array>();
	let optimizedImages = 0;
	let skippedImages = 0;
	let svgFixes = 0;

	/*
	 * Image conversion is intentionally sequential. EPUBs can contain many
	 * large images and the X4 pipeline values predictable Worker memory more
	 * than throughput for a single Telegram upload.
	 */
	for (const [path, bytes] of Object.entries(files)) {
		if (!RASTER_IMAGE_PATTERN.test(path)) {
			continue;
		}

		const targetPath = path.replace(
			/\.[^.]+$/,
			".jpg",
		);

		/*
		 * Do not overwrite a different existing asset with the same .jpg stem.
		 * Keeping this one untouched is safer than inventing new internal names.
		 */
		if (
			targetPath !== path &&
			files[targetPath]
		) {
			processedImages.set(
				path,
				bytes,
			);
			skippedImages++;
			continue;
		}

		try {
			const converted = await convertImage(
				env,
				bytes,
			);

			processedImages.set(
				targetPath,
				converted,
			);

			if (targetPath !== path) {
				renamed.set(
					normalizePath(path),
					normalizePath(targetPath),
				);
			}

			optimizedImages++;
		} catch (error) {
			console.warn(
				`[EPUB X4] image optimization failed for ${path}; keeping original`,
				error,
			);
			processedImages.set(
				path,
				bytes,
			);
			skippedImages++;
		}
	}

	const outputFiles: Record<string, Uint8Array> = {};
	const svgFixedDocuments = new Set<string>();

	for (const [path, bytes] of Object.entries(files)) {
		if (
			path === "mimetype" ||
			RASTER_IMAGE_PATTERN.test(path)
		) {
			continue;
		}

		const lower = path.toLowerCase();

		if (TEXT_DOCUMENT_PATTERN.test(lower)) {
			let content = readText(bytes);
			const fixedSvg =
				fixSvgWrappedImages(content);

			content = fixedSvg.content;
			if (fixedSvg.count > 0) {
				svgFixes += fixedSvg.count;
				svgFixedDocuments.add(
					normalizePath(path),
				);
			}

			content = removeImgDimensions(content);
			content = rewriteAttributeReferences(
				content,
				path,
				renamed,
			);
			content = rewriteCssReferences(
				content,
				path,
				renamed,
			);
			content = injectDefensiveStyle(content);
			outputFiles[path] = strToU8(content);
			continue;
		}

		if (path === opfPath) {
			/* OPF is rewritten after SVG-fixed XHTML files are known. */
			continue;
		}

		if (lower.endsWith(".css")) {
			outputFiles[path] = strToU8(
				rewriteCssReferences(
					readText(bytes),
					path,
					renamed,
				),
			);
			continue;
		}

		if (
			lower.endsWith(".ncx") ||
			lower.endsWith(".xml") ||
			lower.endsWith(".svg")
		) {
			outputFiles[path] = strToU8(
				rewriteAttributeReferences(
					readText(bytes),
					path,
					renamed,
				),
			);
			continue;
		}

		outputFiles[path] = bytes;
	}

	outputFiles[opfPath] = strToU8(
		rewriteOpf(
			readText(files[opfPath]),
			opfPath,
			renamed,
			svgFixedDocuments,
		),
	);

	for (const [path, bytes] of processedImages) {
		outputFiles[path] = bytes;
	}

	const ordered: Record<
		string,
		Uint8Array | [Uint8Array, { level: 0 }]
	> = {};

	ordered.mimetype = [
		files.mimetype ??
			strToU8("application/epub+zip"),
		{ level: 0 },
	];

	for (const [path, bytes] of Object.entries(outputFiles)) {
		if (path === "mimetype") {
			continue;
		}

		ordered[path] =
			RASTER_IMAGE_PATTERN.test(path)
				? [bytes, { level: 0 }]
				: bytes;
	}

	const optimizedBytes = zipSync(
		ordered,
		{ level: 8 },
	);

	/* Basic structural validation before R2 receives the X4 variant. */
	const validationFiles = unzipSync(optimizedBytes);
	findOpfPath(validationFiles);

	return {
		bytes: optimizedBytes,
		originalSize: inputBytes.byteLength,
		optimizedSize:
			optimizedBytes.byteLength,
		optimizedImages,
		skippedImages,
		svgFixes,
	};
}
