import type {
	Env,
} from "./env";

export interface TelegramUser {
	id: number;
	username?: string;
	first_name?: string;
}

export interface TelegramChat {
	id: number;
	type?: string;
}

export interface TelegramDocument {
	file_id: string;
	file_unique_id?: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id?: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	text?: string;
	document?: TelegramDocument;
	photo?: TelegramPhotoSize[];
	caption?: string;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

export interface DownloadedTelegramFile {
	bytes: Uint8Array;
	filePath: string;
	fileSize: number;
}

const TELEGRAM_DOWNLOAD_LIMIT =
	20 * 1024 * 1024;

export function isAllowedTelegramUser(
	env: Env,
	userId?: number,
): boolean {
	if (userId === undefined) {
		return false;
	}

	return (
		String(userId) ===
		String(
			env.TELEGRAM_ALLOWED_USER_ID,
		)
	);
}

export async function telegramApi<T>(
	env: Env,
	method: string,
	payload: Record<string, unknown>,
): Promise<T> {
	const response = await fetch(
		`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
		{
			method: "POST",
			headers: {
				"Content-Type":
					"application/json",
			},
			body: JSON.stringify(payload),
		},
	);

	const body =
		(await response.json()) as
			TelegramApiResponse<T>;

	if (
		!response.ok ||
		!body.ok ||
		body.result === undefined
	) {
		throw new Error(
			body.description ??
				`Telegram API ${method} failed with HTTP ${response.status}`,
		);
	}

	return body.result;
}

export async function sendTelegramMessage(
	env: Env,
	chatId: number,
	text: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await telegramApi(
		env,
		"sendMessage",
		{
			chat_id: chatId,
			text,
			disable_web_page_preview:
				true,
			...extra,
		},
	);
}

export async function answerCallbackQuery(
	env: Env,
	callbackQueryId: string,
	text?: string,
): Promise<void> {
	await telegramApi(
		env,
		"answerCallbackQuery",
		{
			callback_query_id:
				callbackQueryId,
			...(text
				? { text }
				: {}),
		},
	);
}

export async function downloadTelegramFile(
	env: Env,
	fileId: string,
	knownSize?: number,
): Promise<DownloadedTelegramFile> {
	if (
		knownSize &&
		knownSize >
			TELEGRAM_DOWNLOAD_LIMIT
	) {
		throw new Error(
			"Telegram file is larger than the 20 MB bot download limit",
		);
	}

	const file =
		await telegramApi<TelegramFile>(
			env,
			"getFile",
			{
				file_id: fileId,
			},
		);

	if (
		file.file_size &&
		file.file_size >
			TELEGRAM_DOWNLOAD_LIMIT
	) {
		throw new Error(
			"Telegram file is larger than the 20 MB bot download limit",
		);
	}

	if (!file.file_path) {
		throw new Error(
			"Telegram did not return a file path",
		);
	}

	const response = await fetch(
		`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
	);

	if (!response.ok) {
		throw new Error(
			`Telegram file download failed with HTTP ${response.status}`,
		);
	}

	const buffer =
		await response.arrayBuffer();

	if (
		buffer.byteLength >
			TELEGRAM_DOWNLOAD_LIMIT
	) {
		throw new Error(
			"Telegram file is larger than the 20 MB bot download limit",
		);
	}

	return {
		bytes: new Uint8Array(buffer),
		filePath: file.file_path,
		fileSize: buffer.byteLength,
	};
}
