import { createLogger } from "./utils";
import type { IndexerRpc } from "./rpc";
import type { Transport } from "./transport";

/**
 * Creates a web standard HTTP request handler `(req: Request) => Promise<Response>`.
 *
 * You can use this to deploy your indexer over HTTPs using any of your favourite frameworks like
 * Next.js, Cloudflare Workers, or Bun.
 *
 * Note that we use the provided `signingKey` to prevent any unauthorized access.
 */
function http(opts: { quiet?: boolean; indexer: Transport<IndexerRpc>; signingKey: string }) {
	const log = createLogger({ quiet: opts.quiet, prefix: "[proxy]" });

	return async function proxy(req: Request): Promise<Response> {
		// Determine authentication status
		const authorization = req.headers.get("Authorization");
		const compressed = req.headers.get("Content-Encoding") === "gzip";
		const authenticated = authorization === `Bearer ${opts.signingKey}`;

		// Authenticate compressed requests before decompression
		if (compressed && (!authorization || !authenticated)) {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Invalid bearer token" } }, //
				{ status: 400 },
			);
		}

		// Parse the request body to a string
		let body_string = "";

		try {
			if (compressed) {
				if (!req.body) {
					throw new Error("Missing compressed request body");
				}

				const reader = req.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();

				try {
					while (true) {
						const { done, value } = await reader.read();

						if (done) {
							break;
						}

						body_string += value;
					}
				} finally {
					reader.releaseLock();
				}
			} else {
				body_string = await req.text();
			}
		} catch {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Invalid request body" } }, //
				{ status: 400 },
			);
		}

		// Parse string request body as json
		let json: any;

		try {
			json = JSON.parse(body_string);
		} catch {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Malformed JSON request body" } }, //
				{ status: 400 },
			);
		}

		// Authorize request for any private methods
		if (json.method.startsWith("private_") && (!authorization || !authenticated)) {
			return Response.json(
				{ jsonrpc: "2.0", id: json.id, error: { code: 0, message: "Invalid bearer token" } }, //
				{ status: 400 },
			);
		}

		// Perform RPC
		try {
			const result = await opts.indexer.request({ method: json.method, params: json.params });

			return Response.json({ jsonrpc: "2.0", id: json.id, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";

			log.error(message);

			return Response.json(
				{ jsonrpc: "2.0", id: json.id, error: { code: 0, message } }, //
				{ status: 500 },
			);
		}
	};
}

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { http };
