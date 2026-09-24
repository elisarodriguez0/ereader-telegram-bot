import {
	SELF,
} from "cloudflare:test";

import {
	describe,
	expect,
	it,
} from "vitest";

describe(
	"e-reader Telegram worker",
	() => {
		it(
			"returns health status",
			async () => {
				const response =
					await SELF.fetch(
						"https://example.com/",
					);

				expect(
					response.status,
				).toBe(200);

				const body =
					(await response.json()) as {
						ok: boolean;
						service: string;
						time: string;
					};

				expect(
					body,
				).toMatchObject({
					ok: true,
					service:
						"ereader-telegram-sync",
				});

				expect(
					Number.isNaN(
						Date.parse(
							body.time,
						),
					),
				).toBe(false);
			},
		);
	},
);
