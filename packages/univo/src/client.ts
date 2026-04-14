import type { Rpc } from ".";
import { compress, raise } from "./utils";
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

function http(url: string, opts: { signingKey?: string } = {}) {
	return {
		async request<M extends keyof Rpc>({ jsonrpc, id, method, params }: Request<M>): Promise<Response<M>> {
			try {
				let body: string | ArrayBuffer = JSON.stringify({ jsonrpc, id, method, params });

				const headers = new Headers();
				headers.set("Content-Type", "application/json");

				if (method.startsWith("private_")) {
					// Authenticate request
					if (opts.signingKey === undefined) throw new Error(ClientUnauthorizedError);
					headers.set("Authorization", `Bearer ${opts.signingKey}`);

					// Compress request
					body = await compress(body).catch((cause) => raise(ClientCompressionError, { cause }));
					headers.set("Content-Encoding", "gzip");
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
const ClientUnauthorizedError = createException("Attempted to execute a private method without providing a request signing key");

export { http };
