interface Env {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_ALLOWED_USER_ID?: string;
	LIBRARY_TOKEN: string;
	EREADER_BUCKET: R2Bucket;
	IMAGES: ImagesBinding;
}

interface TelegramDocument {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

interface TelegramMessage {
	chat: {
		id: number;
	};
	from?: {
		id: number;
		first_name?: string;
		username?: string;
	};
	text?: string;
	document?: TelegramDocument;
	photo?: TelegramPhotoSize[];

}

interface TelegramUpdate {
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface TelegramFileResponse {
	ok: boolean;
	result?: {
		file_id: string;
		file_unique_id: string;
		file_size?: number;
		file_path?: string;
	};
	description?: string;
}

interface TelegramCallbackQuery {
	id: string;

	from: {
		id: number;
		first_name?: string;
		username?: string;
	};

	message?: {
		chat: {
			id: number;
		};
		message_id: number;
	};

	data?: string;
}

async function sendTelegramMessage(
	token: string,
	chatId: number,
	text: string,
): Promise<void> {
	const response = await fetch(
		`https://api.telegram.org/bot${token}/sendMessage`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				chat_id: chatId,
				text,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Telegram sendMessage failed: ${error}`);
	}
}

function formatBytes(bytes?: number): string {
	if (bytes === undefined) {
		return "Unknown";
	}

	if (bytes < 1024) {
		return `${bytes} B`;
	}

	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}

	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isEpub(document: TelegramDocument): boolean {
	const fileName = document.file_name?.toLowerCase() ?? "";
	const mimeType = document.mime_type?.toLowerCase() ?? "";

	return (
		fileName.endsWith(".epub") ||
		mimeType === "application/epub+zip"
	);
}

function isImageDocument(document: TelegramDocument): boolean {
	const fileName = document.file_name?.toLowerCase() ?? "";
	const mimeType = document.mime_type?.toLowerCase() ?? "";

	return (
		fileName.endsWith(".jpg") ||
		fileName.endsWith(".jpeg") ||
		fileName.endsWith(".png") ||
		mimeType === "image/jpeg" ||
		mimeType === "image/png"
	);
}

function getImageExtension(
	mimeType?: string,
	fileName?: string,
): string {
	const lowerName = fileName?.toLowerCase() ?? "";

	if (lowerName.endsWith(".png")) {
		return ".png";
	}

	if (
		lowerName.endsWith(".jpg") ||
		lowerName.endsWith(".jpeg")
	) {
		return ".jpg";
	}

	if (mimeType === "image/png") {
		return ".png";
	}

	return ".jpg";
}

function sanitizeFileName(fileName: string): string {
	return fileName
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
		.trim();
}

async function getTelegramFilePath(
	token: string,
	fileId: string,
): Promise<string> {
	const response = await fetch(
		`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
	);

	if (!response.ok) {
		throw new Error(
			`Telegram getFile failed with HTTP ${response.status}`,
		);
	}

	const data = (await response.json()) as TelegramFileResponse;

	if (!data.ok || !data.result?.file_path) {
		throw new Error(
			`Telegram getFile failed: ${data.description ?? "Unknown error"}`,
		);
	}

	return data.result.file_path;
}

async function downloadTelegramFile(
	token: string,
	filePath: string,
): Promise<Response> {
	const response = await fetch(
		`https://api.telegram.org/file/bot${token}/${filePath}`,
	);

	if (!response.ok) {
		throw new Error(
			`Telegram file download failed with HTTP ${response.status}`,
		);
	}

	return response;
}

async function askWallpaperDestination(
	token: string,
	chatId: number,
	r2Key: string,
): Promise<void> {
	const response = await fetch(
		`https://api.telegram.org/bot${token}/sendMessage`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				chat_id: chatId,
				text: [
					"🖼️ Wallpaper recibido",
					"",
					"¿Para qué dispositivo?",
				].join("\n"),

				reply_markup: {
					inline_keyboard: [
						[
							{
								text: "Kindle PW5",
								callback_data:
									`wp:k:${r2Key.replace(
										"wallpapers/original/",
										"",
									)}`,
							},
							{
								text: "Xteink X4",
								callback_data:
									`wp:x:${r2Key.replace(
										"wallpapers/original/",
										"",
									)}`,
							},
						],
					],
				},
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();

		throw new Error(
			`Telegram sendMessage failed: ${error}`,
		);
	}
}

async function saveEpubToR2(
	env: Env,
	document: TelegramDocument,
): Promise<string> {
	const filePath = await getTelegramFilePath(
		env.TELEGRAM_BOT_TOKEN,
		document.file_id,
	);

	const downloadResponse = await downloadTelegramFile(
		env.TELEGRAM_BOT_TOKEN,
		filePath,
	);

	const originalFileName =
		document.file_name ?? `${document.file_unique_id}.epub`;

	const safeFileName = sanitizeFileName(originalFileName);

	const r2Key = `books/${safeFileName}`;

	await env.EREADER_BUCKET.put(
		r2Key,
		downloadResponse.body,
		{
			httpMetadata: {
				contentType:
					document.mime_type ?? "application/epub+zip",
			},
			customMetadata: {
				telegramFileId: document.file_id,
				telegramFileUniqueId: document.file_unique_id,
				originalFileName,
			},
		},
	);

	return r2Key;
}

async function getNextWallpaperName(
	env: Env,
	extension: string,
): Promise<string> {
	const result = await env.EREADER_BUCKET.list({
		prefix: "wallpapers/original/wallpaper_",
	});

	let highestNumber = 0;

	for (const object of result.objects) {
		const fileName = object.key.replace(
			"wallpapers/original/",
			"",
		);

		const match = fileName.match(
			/^wallpaper_(\d+)\.(jpg|jpeg|png)$/i,
		);

		if (!match) {
			continue;
		}

		const number = Number.parseInt(match[1], 10);

		if (number > highestNumber) {
			highestNumber = number;
		}
	}

	const nextNumber = highestNumber + 1;

	return `wallpaper_${String(nextNumber).padStart(3, "0")}${extension}`;
}

async function saveImageDocumentToR2(
	env: Env,
	document: TelegramDocument,
): Promise<string> {
	const filePath = await getTelegramFilePath(
		env.TELEGRAM_BOT_TOKEN,
		document.file_id,
	);

	const downloadResponse = await downloadTelegramFile(
		env.TELEGRAM_BOT_TOKEN,
		filePath,
	);

	const extension = getImageExtension(
		document.mime_type,
		document.file_name,
	);
	const originalFileName =
		document.file_name ??
		`${document.file_unique_id}${extension}`;

	const wallpaperFileName = await getNextWallpaperName(env, extension,);

	const r2Key = `wallpapers/original/${wallpaperFileName}`;

	await env.EREADER_BUCKET.put(
		r2Key,
		downloadResponse.body,
		{
			httpMetadata: {
				contentType:
					document.mime_type ??
					(extension === ".png"
						? "image/png"
						: "image/jpeg"),
			},
			customMetadata: {
				telegramFileId: document.file_id,
				telegramFileUniqueId:
					document.file_unique_id,
				originalFileName,
				source: "telegram-document",
			},
		},
	);

	return r2Key;
}

async function saveTelegramPhotoToR2(
	env: Env,
	photo: TelegramPhotoSize,
): Promise<string> {
	const filePath = await getTelegramFilePath(
		env.TELEGRAM_BOT_TOKEN,
		photo.file_id,
	);

	const downloadResponse = await downloadTelegramFile(
		env.TELEGRAM_BOT_TOKEN,
		filePath,
	);

	const wallpaperFileName =
		await getNextWallpaperName(
			env,
			".jpg",
		);

	const r2Key =
		`wallpapers/original/${wallpaperFileName}`;

	await env.EREADER_BUCKET.put(
		r2Key,
		downloadResponse.body,
		{
			httpMetadata: {
				contentType: "image/jpeg",
			},
			customMetadata: {
				telegramFileId: photo.file_id,
				telegramFileUniqueId:
					photo.file_unique_id,
				source: "telegram-photo",
				width: String(photo.width),
				height: String(photo.height),
			},
		},
	);

	return r2Key;
}

async function listBooks(env: Env): Promise<Response> {
	const result = await env.EREADER_BUCKET.list({
		prefix: "books/",
	});

	const books = result.objects
		.filter((object) => object.key.toLowerCase().endsWith(".epub"))
		.map((object) => ({
			name: object.key.replace(/^books\//, ""),
			key: object.key,
			size: object.size,
			uploaded: object.uploaded.toISOString(),
		}));

	return Response.json({
		count: books.length,
		books,
	});
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function isLibraryAuthorized(url: URL, env: Env): boolean {
	const token = url.searchParams.get("token");

	return token === env.LIBRARY_TOKEN;
}

async function generateOpdsFeed(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);

	if (!isLibraryAuthorized(url, env)) {
		return new Response("Unauthorized", {
			status: 401,
		});
	}

	const result = await env.EREADER_BUCKET.list({
		prefix: "books/",
	});

	const books = result.objects.filter((object) =>
		object.key.toLowerCase().endsWith(".epub"),
	);

	const latestUpdated =
		books.length > 0
			? books
					.reduce((latest, book) =>
						book.uploaded > latest.uploaded
							? book
							: latest,
					)
					.uploaded.toISOString()
			: new Date().toISOString();

	const entries = books
		.map((book) => {
			const fileName = book.key.replace(/^books\//, "");

			const downloadUrl =
				`${url.origin}/download` +
				`?key=${encodeURIComponent(book.key)}` +
				`&token=${encodeURIComponent(env.LIBRARY_TOKEN)}`;

			return `
	<entry>
		<title>${escapeXml(fileName.replace(/\.epub$/i, ""))}</title>

		<id>urn:ereader:${escapeXml(book.key)}</id>

		<updated>${book.uploaded.toISOString()}</updated>

		<content type="text">
			${escapeXml(fileName)}
		</content>

		<link
			rel="http://opds-spec.org/acquisition"
			href="${escapeXml(downloadUrl)}"
			type="application/epub+zip"
		/>
	</entry>`;
		})
		.join("\n");

	const selfUrl =
		`${url.origin}/opds` +
		`?token=${encodeURIComponent(env.LIBRARY_TOKEN)}`;

	const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed
	xmlns="http://www.w3.org/2005/Atom"
	xmlns:opds="http://opds-spec.org/2010/catalog"
>
	<title>Ereader Library</title>

	<id>urn:ereader:library</id>

	<updated>${latestUpdated}</updated>

	<link
		rel="self"
		href="${escapeXml(selfUrl)}"
		type="application/atom+xml;profile=opds-catalog;kind=acquisition"
	/>

	<author>
		<name>Ereader Sync</name>
	</author>

${entries}

</feed>`;

	return new Response(feed, {
		headers: {
			"Content-Type":
				"application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

async function downloadBook(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);

	if (!isLibraryAuthorized(url, env)) {
		return new Response("Unauthorized", {
			status: 401,
		});
	}

	const key = url.searchParams.get("key");

	if (!key || !key.startsWith("books/")) {
		return new Response("Invalid book", {
			status: 400,
		});
	}

	const object = await env.EREADER_BUCKET.get(key);

	if (!object) {
		return new Response("Book not found", {
			status: 404,
		});
	}

	const fileName = key.replace(/^books\//, "");

	const headers = new Headers();

	object.writeHttpMetadata(headers);

	headers.set(
		"Content-Type",
		"application/epub+zip",
	);

	headers.set(
		"Content-Disposition",
		`attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
	);

	headers.set("ETag", object.httpEtag);

	return new Response(object.body, {
		headers,
	});
}

async function downloadWallpaper(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);

	if (!isLibraryAuthorized(url, env)) {
		return new Response("Unauthorized", {
			status: 401,
		});
	}

	const key = url.searchParams.get("key");

	if (
		!key ||
		!key.startsWith("wallpapers/kindle/")
	) {
		return new Response("Invalid wallpaper", {
			status: 400,
		});
	}

	const object = await env.EREADER_BUCKET.get(key);

	if (!object || !object.body) {
		return new Response("Wallpaper not found", {
			status: 404,
		});
	}

	const fileName = key.replace(
		/^wallpapers\/kindle\//,
		"",
	);

	const headers = new Headers();

	object.writeHttpMetadata(headers);

	if (!headers.has("Content-Type")) {
		if (fileName.toLowerCase().endsWith(".png")) {
			headers.set("Content-Type", "image/png");
		} else {
			headers.set("Content-Type", "image/jpeg");
		}
	}

	headers.set(
		"Content-Disposition",
		`attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
	);

	headers.set("ETag", object.httpEtag);

	return new Response(object.body, {
		headers,
	});
}

function buildProtectedDownloadUrl(
	origin: string,
	path: string,
	key: string,
	token: string,
): string {
	return (
		`${origin}${path}` +
		`?key=${encodeURIComponent(key)}` +
		`&token=${encodeURIComponent(token)}`
	);
}

async function generateManifest(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);

	if (!isLibraryAuthorized(url, env)) {
		return new Response("Unauthorized", {
			status: 401,
		});
	}

	const [bookResult, wallpaperResult] = await Promise.all([
		env.EREADER_BUCKET.list({
			prefix: "books/",
		}),
		env.EREADER_BUCKET.list({
			prefix: "wallpapers/kindle/",
		}),
	]);

	const books = bookResult.objects
		.filter((object) =>
			object.key.toLowerCase().endsWith(".epub"),
		)
		.map((object) => ({
			name: object.key.replace(/^books\//, ""),
			key: object.key,
			size: object.size,
			updated: object.uploaded.toISOString(),
			etag: object.etag,
			download_url: buildProtectedDownloadUrl(
				url.origin,
				"/download",
				object.key,
				env.LIBRARY_TOKEN,
			),
		}));

	const wallpapers = wallpaperResult.objects
		.filter((object) => {
			const key = object.key.toLowerCase();

			return (
				key.endsWith(".jpg") ||
				key.endsWith(".jpeg") ||
				key.endsWith(".png")
			);
		})
		.map((object) => ({
			name: object.key.replace(
				/^wallpapers\/kindle\//,
				"",
			),
			key: object.key,
			size: object.size,
			updated: object.uploaded.toISOString(),
			etag: object.etag,
			download_url: buildProtectedDownloadUrl(
				url.origin,
				"/wallpaper/download",
				object.key,
				env.LIBRARY_TOKEN,
			),
		}));

	return Response.json(
		{
			version: 1,

			generated_at: new Date().toISOString(),

			books,

			wallpapers,
		},
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}

async function createKindleWallpaper(
	env: Env,
	sourceKey: string,
): Promise<string> {
	const source = await env.EREADER_BUCKET.get(sourceKey);

	if (!source || !source.body) {
		throw new Error(
			`No encuentro el wallpaper original: ${sourceKey}`,
		);
	}

	const sourceFileName = sourceKey.replace(
		"wallpapers/original/",
		"",
	);

	const baseName = sourceFileName.replace(
		/\.(jpg|jpeg|png)$/i,
		"",
	);

	const kindleFileName = `${baseName}.jpg`;

	const kindleKey =
		`wallpapers/kindle/${kindleFileName}`;

	const transformed = await env.IMAGES
		.input(source.body)
		.transform({
			width: 1236,
			height: 1648,
			fit: "pad",
			background: "white",
			saturation: 0,
		})
		.output({
			format: "image/jpeg",
			quality: 90,
		});

	const response = transformed.response();

	if (!response.body) {
		throw new Error(
			"Cloudflare Images no devolvió una imagen.",
		);
	}

	await env.EREADER_BUCKET.put(
		kindleKey,
		response.body,
		{
			httpMetadata: {
				contentType: "image/jpeg",
			},
			customMetadata: {
				sourceKey,
				device: "kindle-pw5",
				width: "1236",
				height: "1648",
			},
		},
	);

	return kindleKey;
}

async function answerCallbackQuery(
	token: string,
	callbackQueryId: string,
	text?: string,
): Promise<void> {
	await fetch(
		`https://api.telegram.org/bot${token}/answerCallbackQuery`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				callback_query_id:
					callbackQueryId,
				text,
			}),
		},
	);
}

async function handleWallpaperCallback(
	callback: TelegramCallbackQuery,
	env: Env,
): Promise<Response> {
	const userId = callback.from.id;

	if (
		env.TELEGRAM_ALLOWED_USER_ID &&
		String(userId) !==
			env.TELEGRAM_ALLOWED_USER_ID
	) {
		return new Response("OK");
	}

	const data = callback.data;

	if (!data) {
		return new Response("OK");
	}

	const parts = data.split(":");

	if (
		parts.length !== 3 ||
		parts[0] !== "wp"
	) {
		return new Response("OK");
	}

	const deviceCode = parts[1];
	const fileName = parts[2];

	const sourceKey =
		`wallpapers/original/${fileName}`;

	if (deviceCode === "k") {
		await answerCallbackQuery(
			env.TELEGRAM_BOT_TOKEN,
			callback.id,
			"Preparando para Kindle...",
		);

		try {
			const kindleKey =
				await createKindleWallpaper(
					env,
					sourceKey,
				);

			if (callback.message) {
				await sendTelegramMessage(
					env.TELEGRAM_BOT_TOKEN,
					callback.message.chat.id,
					[
						"📖 Wallpaper preparado para Kindle PW5",
						"",
						`☁️ ${kindleKey}`,
						"",
						"1236 × 1648",
						"Escala de grises",
						"Sin recorte",
						"",
						"✅ Listo para sincronizar.",
					].join("\n"),
				);
			}
		} catch (error) {
			console.error(error);

			if (callback.message) {
				await sendTelegramMessage(
					env.TELEGRAM_BOT_TOKEN,
					callback.message.chat.id,
					[
						"❌ No he podido preparar el wallpaper para Kindle.",
						"",
						error instanceof Error
							? error.message
							: "Error desconocido",
					].join("\n"),
				);
			}
		}

		return new Response("OK");
	}
	if (deviceCode === "x") {
		await answerCallbackQuery(
			env.TELEGRAM_BOT_TOKEN,
			callback.id,
			"Xteink X4 seleccionado",
		);

		if (callback.message) {
			await sendTelegramMessage(
				env.TELEGRAM_BOT_TOKEN,
				callback.message.chat.id,
				[
					"📟 Xteink X4",
					"",
					`${fileName} se preparará para el Xteink.`,
				].join("\n"),
			);
		}

		return new Response("OK");
	}

	return new Response("OK");
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(
				"Ereader Telegram Sync is running",
			);
		}

		if (request.method === "GET" && url.pathname === "/books") {
			return listBooks(env);
		}

		if (request.method === "GET" && url.pathname === "/opds") {
			return generateOpdsFeed(request, env);
		}

		if (request.method === "GET" && url.pathname === "/manifest") {
			return generateManifest(request, env);
		}

		if (request.method === "GET" && url.pathname === "/download") {
			return downloadBook(request, env);
		}

		if (request.method === "GET" && url.pathname === "/wallpaper/download") {
			return downloadWallpaper(request, env);
		}

		if (
			request.method === "POST" &&
			url.pathname === "/telegram"
		) {
			const update =
	(await request.json()) as TelegramUpdate;

			if (update.callback_query) {
				return handleWallpaperCallback(
					update.callback_query,
					env,
				);
			}

			const message = update.message;

			if (!message) {
				return new Response("OK");
			}

			const chatId = message.chat.id;
			const userId = message.from?.id;
			const text = message.text ?? "";

			if (text === "/id") {
				await sendTelegramMessage(
					env.TELEGRAM_BOT_TOKEN,
					chatId,
					`Tu Telegram User ID es:\n${userId ?? "No disponible"}`,
				);

				return new Response("OK");
			}

			if (
				env.TELEGRAM_ALLOWED_USER_ID &&
				String(userId) !==
					env.TELEGRAM_ALLOWED_USER_ID
			) {
				console.log(
					`Unauthorized Telegram user: ${userId}`,
				);

				return new Response("OK");
			}

			if (text === "/start") {
				await sendTelegramMessage(
					env.TELEGRAM_BOT_TOKEN,
					chatId,
					[
						"📚 Ereader Sync",
						"",
						"Mándame:",
						"",
						"📚 EPUB → biblioteca",
						"🖼️ JPG/PNG → wallpapers",
					].join("\n"),
				);

				return new Response("OK");
			}

			if (message.document) {
				const document = message.document;

				// EPUB
				if (isEpub(document)) {
					if (
						document.file_size &&
						document.file_size > 20 * 1024 * 1024
					) {
						await sendTelegramMessage(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							[
								"❌ El EPUB es demasiado grande.",
								"",
								`Tamaño: ${formatBytes(
									document.file_size,
								)}`,
							].join("\n"),
						);

						return new Response("OK");
					}

					try {
						await sendTelegramMessage(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							`☁️ Guardando ${document.file_name ?? "EPUB"}...`,
						);

						const r2Key = await saveEpubToR2(
							env,
							document,
						);

						await sendTelegramMessage(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							[
								"📚 EPUB guardado",
								"",
								`Archivo: ${
									document.file_name ??
									"Sin nombre"
								}`,
								`Tamaño: ${formatBytes(
									document.file_size,
								)}`,
								"",
								`☁️ ${r2Key}`,
								"",
								"✅ Ya está en tu biblioteca.",
							].join("\n"),
						);
					} catch (error) {
						console.error(error);

						await sendTelegramMessage(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							[
								"❌ No he podido guardar el EPUB.",
								"",
								error instanceof Error
									? error.message
									: "Error desconocido",
							].join("\n"),
						);
					}

					return new Response("OK");
				}

				// IMAGEN ENVIADA COMO ARCHIVO
				if (isImageDocument(document)) {
					if (
						document.file_size &&
						document.file_size > 20 * 1024 * 1024
					) {
						await sendTelegramMessage(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							[
								"❌ La imagen es demasiado grande.",
								"",
								`Tamaño: ${formatBytes(
									document.file_size,
								)}`,
							].join("\n"),
						);

						return new Response("OK");
					}

					try {
						await sendTelegramMessage(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							`🖼️ Guardando ${document.file_name ?? "imagen"}...`,
						);

						const r2Key =
							await saveImageDocumentToR2(
								env,
								document,
							);

						await askWallpaperDestination(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							r2Key,
						);
					} catch (error) {
						console.error(error);

						await sendTelegramMessage(
							env.TELEGRAM_BOT_TOKEN,
							chatId,
							[
								"❌ No he podido guardar la imagen.",
								"",
								error instanceof Error
									? error.message
									: "Error desconocido",
							].join("\n"),
						);
					}

					return new Response("OK");
				}

				// OTROS ARCHIVOS
				await sendTelegramMessage(
					env.TELEGRAM_BOT_TOKEN,
					chatId,
					[
						"❌ No reconozco ese archivo.",
						"",
						`Archivo: ${
							document.file_name ?? "Sin nombre"
						}`,
						"",
						"Ahora mismo acepto EPUB, JPG y PNG.",
					].join("\n"),
				);

				return new Response("OK");
			}

			if (message.photo && message.photo.length > 0) {
				const largestPhoto =
					message.photo[message.photo.length - 1];

				try {
					await sendTelegramMessage(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						"🖼️ Guardando foto...",
					);

					const r2Key =
						await saveTelegramPhotoToR2(
							env,
							largestPhoto,
						);

					await askWallpaperDestination(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						r2Key,
					);
				} catch (error) {
					console.error(error);

					await sendTelegramMessage(
						env.TELEGRAM_BOT_TOKEN,
						chatId,
						[
							"❌ No he podido guardar la foto.",
							"",
							error instanceof Error
								? error.message
								: "Error desconocido",
						].join("\n"),
					);
				}

				return new Response("OK");
			}

			await sendTelegramMessage(
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				[
					"Envíame:",
					"",
					"📚 un EPUB",
					"🖼️ una foto",
					"📎 un JPG o PNG",
				].join("\n"),
			);

			return new Response("OK");
		}

		return new Response("Not found", {
			status: 404,
		});
	},
};