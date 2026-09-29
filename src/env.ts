import type {
	EpubQueueJob,
} from "./jobs";

export interface Env {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_ALLOWED_USER_ID: string;
	LIBRARY_TOKEN: string;

	GOOGLE_BOOKS_API_KEY?: string;
	LECTULANDIA_BASE_URL?: string;

	/*
	 * Structural runtime bindings.
	 * EPUB optimization uses external EPUBKit.
	 * Cloudflare Images remains required by wallpaper-service.ts.
	 */
	EREADER_BUCKET: R2Bucket;
	EPUB_QUEUE: Queue<EpubQueueJob>;
	IMAGES: ImagesBinding;
}
