export interface Env {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_ALLOWED_USER_ID: string;
	LIBRARY_TOKEN: string;

	GOOGLE_BOOKS_API_KEY?: string;
	LECTULANDIA_BASE_URL?: string;

	/*
	 * Kept as structural runtime bindings instead of importing
	 * generated Wrangler types, so src stays self-contained.
	 */
	EREADER_BUCKET: any;
	IMAGES: any;
}
