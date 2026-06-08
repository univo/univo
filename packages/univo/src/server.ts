import type { Rpc } from "./rpc";
import { getException } from "./exceptions";
import type { Transport } from "./transport";
import { createLogger, decoder, decompress } from "./utils";

/**
 * Accepts an RPC transport and creates a server responsible for transforming and processing HTTP and WSS RPC requests
 */
function createServer(opts: { quiet: boolean; signingKey: string; transport: Transport<Rpc> }) {
	const log = createLogger({ quiet: opts.quiet, prefix: "[server]" });

	const http = async (req: Request): Promise<Response> => {
		// Parse request body
		let body_buffer: ArrayBuffer;

		try {
			body_buffer = await req.arrayBuffer();
		} catch {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Invalid request body" } }, //
				{ status: 400 },
			);
		}

		// Determine authentication status
		const authorization = req.headers.get("Authorization");
		const authenticated = authorization === `Bearer ${opts.signingKey}`;

		// Decode request body
		let body_string: string;

		if (req.headers.get("Content-Encoding") === "gzip") {
			// Compressed requests should be authenticated before decompression. This prevents unauthenticated clients
			// from sending ZIP bombs that force the server to spend CPU and memory before rejecting the request.

			if (!authorization) {
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: 0, message: "No bearer token provided" } }, //
					{ status: 400 },
				);
			}

			if (!authenticated) {
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Invalid bearer token" } }, //
					{ status: 400 },
				);
			}

			body_string = await decompress(body_buffer);
		} else {
			body_string = decoder.decode(body_buffer);
		}

		// Parse request as JSON
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
		if (json.method.startsWith("private_")) {
			if (!authorization) {
				return Response.json(
					{ jsonrpc: "2.0", id: json.id, error: { code: 0, message: "No bearer token provided" } }, //
					{ status: 400 },
				);
			}

			if (authorization !== `Bearer ${opts.signingKey}`) {
				return Response.json(
					{ jsonrpc: "2.0", id: json.id, error: { code: 0, message: "Invalid bearer token" } }, //
					{ status: 400 },
				);
			}
		}

		// Perform RPC
		try {
			const result = await opts.transport.request({ method: json.method, params: json.params });

			return Response.json({ jsonrpc: "2.0", id: json.id, result });
		} catch (error) {
			const message = getException(error);

			if (message) {
				log.error(message);

				return Response.json(
					{ jsonrpc: "2.0", id: json.id, error: { code: 0, message } }, //
					{ status: 400 },
				);
			}

			// Unknown exception
			if (error instanceof Error) {
				log.error(error.message);
			}

			return Response.json(
				{ jsonrpc: "2.0", id: json.id, error: { code: 0, message: "Internal server error" } }, //
				{ status: 500 },
			);
		}
	};

	return {
		http,
	};
}

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { createServer };
