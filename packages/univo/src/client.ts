import type { Rpc } from ".";
import { compress, getSignature } from "./utils";
import { createException, getException } from "./exceptions";

type Request<M extends keyof Rpc> = {
	jsonrpc: "2.0";
	id: number;
	method: M;
	params: Parameters<Rpc[M]>;
};

type Response<M extends keyof Rpc> = {
	jsonrpc: "2.0";
	id: number;
	result?: Awaited<ReturnType<Rpc[M]>>;
	error?: { code: number; message: string };
};

// Chosen based on limited testing. May need tuning.
const MIN_GZIP_SIZE = 1024;

function http(url: string, opts: { signingKey?: string } = {}) {
	return {
		async request<M extends keyof Rpc>({ jsonrpc, id, method, params }: Request<M>): Promise<Response<M>> {
			try {
				let body: string | Uint8Array<ArrayBuffer> = JSON.stringify({ jsonrpc, id, method, params });

				const headers = new Headers();
				headers.set("Content-Type", "application/json");

				if (method.startsWith("private_")) {
					if (opts.signingKey === undefined) throw new Error(ClientUnauthorizedError);

					// Compress large requests
					if (body.length > MIN_GZIP_SIZE) {
						body = await compress(body).catch((cause) => {
							throw new Error(ClientCompressionError, { cause });
						});

						headers.set("Content-Encoding", "gzip");
					}

					// Attach signature for compressed body
					const signature = await getSignature({ key: opts.signingKey, body }).catch((cause) => {
						throw new Error(ClientSignatureError, { cause });
					});

					headers.set("X-Univo-Signature", signature);
				}

				const res = await fetch(url, { headers, body, method: "POST" }).catch((cause) => {
					throw new Error(ClientConnectionError, { cause });
				});

				return await res.json().catch((cause) => {
					throw new Error(ClientResponseError, { cause });
				});
			} catch (error) {
				const message = getException(error) || "Unknown RPC error";
				return { jsonrpc, id, error: { code: 0, message } };
			}
		},
	};
}

const ClientCompressionError = createException("An error occurred when compressing the request");
const ClientConnectionError = createException("An errored occurred when connecting to the server");
const ClientResponseError = createException("An error occurred when reading the servers response");
const ClientSignatureError = createException("An error occurred with the outgoing request signature");
const ClientUnauthorizedError = createException("Attempted to execute a private method without providing a request signing key");

export { http };
