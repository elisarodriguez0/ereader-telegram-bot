import type {
	Env,
} from "./env";

import {
	prepareAndStoreEpub,
} from "./epub-service";

import {
	handleLibraryRoute,
} from "./library-service";

import {
	handleStatsRoute,
} from "./stats-service";

import {
	answerCallbackQuery,
	downloadTelegramFile,
	isAllowedTelegramUser,
	sendTelegramMessage,
} from "./telegram";

import type {
	TelegramCallbackQuery,
	TelegramMessage,
	TelegramUpdate,
} from "./telegram";

import {
	prepareKindleWallpaper,
	prepareXteinkWallpaper,
	storeWallpaperOriginal,
} from "./wallpaper-service";

interface ExecutionContextLike {
	waitUntil(
		promise: Promise<unknown>,
	): void;
}

function looksLikeEpub(
	fileName?: string,
	mimeType?: string,
): boolean {
	return (
		!!fileName
			?.toLowerCase()
			.endsWith(".epub") ||
		mimeType ===
			"application/epub+zip"
	);
}

function looksLikeImage(
	mimeType?: string,
	fileName?: string,
): boolean {
	if (
		mimeType
			?.toLowerCase()
			.startsWith("image/")
	) {
		return true;
	}

	return !!fileName?.match(
		/\.(?:jpe?g|png|webp)$/i,
	);
}

async function handleEpubMessage(
	env: Env,
	message: TelegramMessage,
): Promise<void> {
	const document = message.document;

	if (!document) {
		return;
	}

	const fileName =
		document.file_name ??
		"book.epub";

	await sendTelegramMessage(
		env,
		message.chat.id,
		`☁️ Preparando ${fileName}...`,
	);

	try {
		const downloaded =
			await downloadTelegramFile(
				env,
				document.file_id,
				document.file_size,
			);
		const stored =
			await prepareAndStoreEpub(
				env,
				downloaded.bytes,
				fileName,
			);

		await sendTelegramMessage(
			env,
			message.chat.id,
			stored.message,
		);
	} catch (error) {
		console.error(
			"[EPUB] upload failed",
			error,
		);

		const detail =
			error instanceof Error
				? error.message
				: String(error);

		await sendTelegramMessage(
			env,
			message.chat.id,
			`❌ No pude preparar el EPUB.\n\n${detail}`,
		);
	}
}

async function handleImageMessage(
	env: Env,
	message: TelegramMessage,
): Promise<void> {
	const document = message.document;
	const photo = message.photo?.[
		(message.photo?.length ?? 1) - 1
	];

	const fileId =
		document?.file_id ??
		photo?.file_id;
	const fileSize =
		document?.file_size ??
		photo?.file_size;

	if (!fileId) {
		return;
	}

	await sendTelegramMessage(
		env,
		message.chat.id,
		"☁️ Guardando imagen...",
	);

	try {
		const downloaded =
			await downloadTelegramFile(
				env,
				fileId,
				fileSize,
			);

		const stored =
			await storeWallpaperOriginal(
				env,
				downloaded.bytes,
				{
					fileName:
						document?.file_name,
					filePath:
						downloaded.filePath,
					mimeType:
						document?.mime_type,
				},
			);

		await sendTelegramMessage(
			env,
			message.chat.id,
			`🖼️ ${stored.fileName}\n\n¿Para qué dispositivo?`,
			{
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: "Kindle PW5",
								callback_data:
									`wp:k:${stored.fileName}`,
							},
							{
								text: "Xteink X4",
								callback_data:
									`wp:x:${stored.fileName}`,
							},
						],
					],
				},
			},
		);
	} catch (error) {
		console.error(
			"[Wallpaper] upload failed",
			error,
		);

		const detail =
			error instanceof Error
				? error.message
				: String(error);

		await sendTelegramMessage(
			env,
			message.chat.id,
			`❌ No pude guardar la imagen.\n\n${detail}`,
		);
	}
}

async function handleWallpaperCallback(
	env: Env,
	callback: TelegramCallbackQuery,
): Promise<void> {
	const data = callback.data ?? "";
	const match = data.match(
		/^wp:([kx]):(wallpaper_\d+\.(?:jpe?g|png|webp))$/i,
	);

	if (!match) {
		await answerCallbackQuery(
			env,
			callback.id,
			"Acción no válida",
		);
		return;
	}

	const chatId =
		callback.message?.chat.id;

	if (!chatId) {
		await answerCallbackQuery(
			env,
			callback.id,
			"No encuentro el chat",
		);
		return;
	}

	const target =
		match[1].toLowerCase();
	const fileName = match[2];

	await answerCallbackQuery(
		env,
		callback.id,
		"Preparando...",
	);

	try {
		if (target === "k") {
			const key =
				await prepareKindleWallpaper(
					env,
					fileName,
				);

			await sendTelegramMessage(
				env,
				chatId,
				`✅ Wallpaper preparado para Kindle PW5.\n\n☁️ ${key}`,
			);
			return;
		}

		const key =
			await prepareXteinkWallpaper(
				env,
				fileName,
			);

		await sendTelegramMessage(
			env,
			chatId,
			`✅ Wallpaper preparado para Xteink X4.\n\n☁️ ${key}`,
		);
	} catch (error) {
		console.error(
			"[Wallpaper] processing failed",
			error,
		);

		const detail =
			error instanceof Error
				? error.message
				: String(error);

		await sendTelegramMessage(
			env,
			chatId,
			`❌ No pude preparar el wallpaper.\n\n${detail}`,
		);
	}
}

async function handleTelegramMessage(
	env: Env,
	message: TelegramMessage,
): Promise<void> {
	if (
		!isAllowedTelegramUser(
			env,
			message.from?.id,
		)
	) {
		return;
	}

	if (
		message.text?.trim()
			.toLowerCase()
			.startsWith("/start")
	) {
		await sendTelegramMessage(
			env,
			message.chat.id,
			[
				"📚 e-reader sync",
				"",
				"Mándame un EPUB y lo prepararé para sincronizar.",
				"Mándame una foto y te preguntaré si es para Kindle PW5 o Xteink X4.",
			].join("\n"),
		);
		return;
	}

	if (message.photo?.length) {
		await handleImageMessage(
			env,
			message,
		);
		return;
	}

	if (message.document) {
		if (
			looksLikeEpub(
				message.document.file_name,
				message.document.mime_type,
			)
		) {
			await handleEpubMessage(
				env,
				message,
			);
			return;
		}

		if (
			looksLikeImage(
				message.document.mime_type,
				message.document.file_name,
			)
		) {
			await handleImageMessage(
				env,
				message,
			);
			return;
		}

		await sendTelegramMessage(
			env,
			message.chat.id,
			"Ese archivo no parece ser un EPUB ni una imagen compatible.",
		);
	}
}

async function handleTelegramUpdate(
	env: Env,
	update: TelegramUpdate,
): Promise<void> {
	try {
		if (update.callback_query) {
			if (
				!isAllowedTelegramUser(
					env,
					update.callback_query.from.id,
				)
			) {
				return;
			}

			await handleWallpaperCallback(
				env,
				update.callback_query,
			);
			return;
		}

		if (update.message) {
			await handleTelegramMessage(
				env,
				update.message,
			);
		}
	} catch (error) {
		console.error(
			"[Telegram] update failed",
			update.update_id,
			error,
		);
	}
}

async function fetchHandler(
	request: Request,
	env: Env,
	ctx: ExecutionContextLike,
): Promise<Response> {
	const url = new URL(request.url);

	const statsResponse =
		await handleStatsRoute(
			request,
			env,
		);

	if (statsResponse) {
		return statsResponse;
	}

	const libraryResponse =
		await handleLibraryRoute(
			request,
			env,
		);

	if (libraryResponse) {
		return libraryResponse;
	}

	const isWebhookPath =
		url.pathname === "/" ||
		url.pathname === "/telegram" ||
		url.pathname === "/webhook";

	if (
		request.method === "POST" &&
		isWebhookPath
	) {
		let update: TelegramUpdate;

		try {
			update =
				(await request.json()) as
					TelegramUpdate;
		} catch {
			return new Response(
				"Bad Request",
				{ status: 400 },
			);
		}

		ctx.waitUntil(
			handleTelegramUpdate(
				env,
				update,
			),
		);

		return new Response("OK");
	}

	if (
		request.method === "GET" &&
		(url.pathname === "/" ||
			url.pathname === "/health")
	) {
		return Response.json({
			ok: true,
			service:
				"ereader-telegram-sync",
			time:
				new Date().toISOString(),
		});
	}

	return new Response(
		"Not found",
		{ status: 404 },
	);
}

export default {
	fetch: fetchHandler,
};
