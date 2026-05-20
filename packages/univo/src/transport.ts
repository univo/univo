import type { Rpc } from ".";
import { compress, raise } from "./utils";
import { createException } from "./exceptions";

function http(url: string, opts: { signingKey?: string } = {}) {
	let id = 0;

	async function request<M extends keyof Rpc>(options: { method: M; params: Parameters<Rpc[M]> }): Promise<Awaited<ReturnType<Rpc[M]>>> {
		let body: string | ArrayBuffer = JSON.stringify({
			id: id++,
			jsonrpc: "2.0",
			method: options.method,
			params: options.params,
		});

		const headers = new Headers();
		headers.set("Content-Type", "application/json");

		if (options.method.startsWith("private_")) {
			// Authenticate request
			if (opts.signingKey === undefined) {
				throw new Error(ClientUnauthorizedError);
			}

			// Compress request
			body = await compress(body).catch((cause) => raise(ClientCompressionError, { cause }));

			// Set headers
			headers.set("Content-Encoding", "gzip");
			headers.set("Authorization", `Bearer ${opts.signingKey}`);
		}

		const res = await fetch(url, { headers, body, method: "POST" }).catch((cause) => {
			throw new Error(ClientConnectionError, { cause });
		});

		const json = await res.json().catch((cause) => {
			throw new Error(ClientResponseError, { cause });
		});

		if (json.error) {
			throw new Error(json.error.message);
		}

		return json.result;
	}

	return { request };
}

const ClientCompressionError = createException("An error occurred when compressing the request");
const ClientConnectionError = createException("An errored occurred when connecting to the server");
const ClientResponseError = createException("An error occurred when reading the servers response");
const ClientUnauthorizedError = createException("Attempted to execute a private method without providing a request signing key");

export { http };
