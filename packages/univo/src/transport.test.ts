import { expect, test } from "vitest";

import { local } from "./transport";

test.concurrent("local transport aborts requests", async () => {
	const transport = local({
		subscribe: {},

		request: {
			delayed: () => new Promise<string>(() => {}),
		},
	});

	const controller = new AbortController();

	const request = transport.request({ method: "delayed", params: [], signal: controller.signal });

	const reason = new Error("Request aborted");

	controller.abort(reason);

	await expect(request).rejects.toBe(reason);
});
