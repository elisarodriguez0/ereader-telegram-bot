const EPUBKIT_BASE_URL =
	"https://epubkit.ink";

interface EpubKitUploadResponse {
	files?: Array<{
		filename?: string;
		task_id?: string | null;
		file_size?: number;
		error?: string | null;
	}>;
}

interface EpubKitReport {
	success?: boolean;
	error?: string | null;
	original_size?: number;
	optimized_size?: number;
	output_filename?: string;
	images_converted?: number;
	images_total?: number;
	svg_covers_fixed?: number;
}

interface EpubKitProgressEvent {
	percent?: number;
	message?: string;
	status?: "done" | "error";
	report?: EpubKitReport;
}

export interface EpubKitOptimizationResult {
	bytes: Uint8Array;
	originalSize: number;
	optimizedSize: number;
	optimizedImages: number;
	totalImages: number;
	svgFixes: number;
}

function safeUploadFileName(
	fileName: string,
): string {
	const clean =
		fileName
			.replace(
				/[\r\n"]/g,
				"_",
			)
			.trim();

	if (!clean) {
		return "book.epub";
	}

	return clean
		.toLowerCase()
		.endsWith(".epub")
		? clean
		: `${clean}.epub`;
}

async function uploadEpub(
	bytes: Uint8Array,
	fileName: string,
): Promise<string> {
	const form =
		new FormData();

	form.append(
		"files",
		new Blob(
			[bytes],
			{
				type:
					"application/epub+zip",
			},
		),
		safeUploadFileName(
			fileName,
		),
	);

	const response =
		await fetch(
			`${EPUBKIT_BASE_URL}/upload`,
			{
				method: "POST",
				body: form,
				signal:
					AbortSignal.timeout(
						60_000,
					),
			},
		);

	if (!response.ok) {
		throw new Error(
			`EPUBKit upload failed with HTTP ${response.status}`,
		);
	}

	const data =
		(await response.json()) as EpubKitUploadResponse;

	const uploaded =
		data.files?.[0];

	if (
		!uploaded ||
		uploaded.error ||
		!uploaded.task_id
	) {
		throw new Error(
			uploaded?.error ||
				"EPUBKit did not return a task id",
		);
	}

	return uploaded.task_id;
}

function parseFinalEvent(
	body: string,
): EpubKitProgressEvent | undefined {
	let final:
		| EpubKitProgressEvent
		| undefined;

	for (
		const line
		of body.split(/\r?\n/)
	) {
		if (
			!line.startsWith(
				"data:",
			)
		) {
			continue;
		}

		const payload =
			line
				.slice(5)
				.trim();

		if (!payload) {
			continue;
		}

		try {
			const event =
				JSON.parse(
					payload,
				) as EpubKitProgressEvent;

			if (
				event.status ===
					"done" ||
				event.status ===
					"error"
			) {
				final =
					event;
			}
		} catch {
			// Ignore malformed/non-final SSE messages.
		}
	}

	return final;
}

async function processEpub(
	taskId: string,
): Promise<EpubKitReport> {
	const params =
		new URLSearchParams({
			device:
				"x4",
			grayscale:
				"true",
			contrast:
				"true",
			quality:
				"85",
			remove_fonts:
				"false",
			remove_css:
				"false",
			light_novel:
				"false",
			generate_cover:
				"false",
			clean_metadata:
				"false",
			text_cleanup:
				"false",
			filename_format:
				"original",
		});

	const response =
		await fetch(
			`${EPUBKIT_BASE_URL}/process/${encodeURIComponent(taskId)}?${params.toString()}`,
			{
				headers: {
					Accept:
						"text/event-stream",
				},
				signal:
					AbortSignal.timeout(
						10 * 60_000,
					),
			},
		);

	if (!response.ok) {
		throw new Error(
			`EPUBKit processing failed with HTTP ${response.status}`,
		);
	}

	/*
	 * Reading the complete SSE body keeps this integration deliberately
	 * simple: the request resolves only after EPUBKit finishes processing.
	 * We do not need intermediate progress events in Telegram.
	 */
	const body =
		await response.text();

	const final =
		parseFinalEvent(
			body,
		);

	if (
		!final ||
		final.status !==
			"done" ||
		final.report?.success !==
			true
	) {
		throw new Error(
			final?.report?.error ||
				final?.message ||
				"EPUBKit processing did not complete successfully",
		);
	}

	return final.report;
}

async function downloadEpub(
	taskId: string,
): Promise<Uint8Array> {
	const response =
		await fetch(
			`${EPUBKIT_BASE_URL}/download/${encodeURIComponent(taskId)}`,
			{
				headers: {
					Accept:
						"application/epub+zip",
				},
				signal:
					AbortSignal.timeout(
						60_000,
					),
			},
		);

	if (!response.ok) {
		throw new Error(
			`EPUBKit download failed with HTTP ${response.status}`,
		);
	}

	return new Uint8Array(
		await response.arrayBuffer(),
	);
}

export async function optimizeEpubWithEpubKit(
	inputBytes: Uint8Array,
	fileName: string,
): Promise<EpubKitOptimizationResult> {
	console.log(
		"[EPUBKit] uploading",
		fileName,
		`${inputBytes.byteLength} bytes`,
	);

	const taskId =
		await uploadEpub(
			inputBytes,
			fileName,
		);

	console.log(
		"[EPUBKit] processing task",
		taskId,
	);

	const report =
		await processEpub(
			taskId,
		);

	const bytes =
		await downloadEpub(
			taskId,
		);

	console.log(
		"[EPUBKit] complete",
		JSON.stringify({
			taskId,
			originalSize:
				report.original_size,
			optimizedSize:
				report.optimized_size ??
				bytes.byteLength,
			imagesConverted:
				report.images_converted,
			imagesTotal:
				report.images_total,
			svgFixes:
				report.svg_covers_fixed,
		}),
	);

	return {
		bytes,
		originalSize:
			report.original_size ??
			inputBytes.byteLength,
		optimizedSize:
			report.optimized_size ??
			bytes.byteLength,
		optimizedImages:
			report.images_converted ??
			0,
		totalImages:
			report.images_total ??
			0,
		svgFixes:
			report.svg_covers_fixed ??
			0,
	};
}
