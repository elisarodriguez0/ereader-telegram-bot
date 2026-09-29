import type {
	TelegramDocument,
} from "./telegram";

export interface EpubQueueJob {
	chatId: number;
	statusMessageId: number;
	document: TelegramDocument;
}