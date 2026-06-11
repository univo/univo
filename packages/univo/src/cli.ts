#!/usr/bin/env node

import WS from "ws";
import open from "open";
import { config } from "dotenv";
import { WebSocket } from "partysocket";
import { defineCommand, runMain } from "citty";

import { http } from "./transport";
import type { IndexerRpc } from "./rpc";
import { createLogger } from "./utils.js";
import { name, version } from "../package.json";

const log = createLogger({ quiet: false });

/**
 * Dev -------------------------------------------------------------------------------------------------------------------------------------------
 */

const dev = defineCommand({
	args: {
		url: {
			required: true,
			type: "positional",
			description: "Endpoint url like http://localhost:3000",
		},
	},
	async run(ctx) {
		try {
			if (!ctx.args.url.startsWith("http://")) {
				throw new Error("`url` must start with http://");
			}

			// Get signing key from environment variable
			config({ quiet: true });

			const localSigningKey = process.env.UNIVO_SIGNING_KEY;

			if (localSigningKey === undefined) {
				throw new Error("Please provide a UNIVO_SIGNING_KEY environment variable");
			}

			// Create a client
			const client = http<IndexerRpc>(ctx.args.url, { signingKey: localSigningKey });

			// Validate client exists
			await client.request({ method: "private_getMetadata", params: [] }).catch(() => {
				throw new Error(`Failed to connect to ${ctx.args.url}. Check that your server is running on the correct port.`);
			});

			// Generate a random tunnel id
			const remoteSigningKey = crypto.randomUUID();
			const url = `https://tunnel-univo.app/v1/${crypto.randomUUID()}`;

			const endpoint = {
				url,
				signing_key: remoteSigningKey,
			};

			// Open users browser to authenticate and create endpoint
			const data = btoa(JSON.stringify(endpoint));
			await open(`https://univo.app/dev/${data}`);

			// Initialise ws connection to tunnel
			const ws = new WebSocket(url, [], { WebSocket: WS });

			// No support for `binaryType` on Bun https://github.com/partykit/partykit/issues/774
			ws.binaryType = "arraybuffer";

			ws.onerror = (event) => {
				log.error(event.message);
			};

			ws.onopen = () => {
				log.info(`Dev server started for ${ctx.args.url}`);
			};

			ws.onclose = () => {
				log.info(`Dev server closed for ${ctx.args.url}`);
			};

			ws.onmessage = async (event) => {
				try {
					const json = JSON.parse(event.data);
					log.debug(`Received request (${json.id}) for method '${json.method}'`);
					const result = await client.request({ method: json.method, params: json.params });
					ws.send(JSON.stringify({ jsonrpc: "2.0", id: json.id, result }));
				} catch {
					ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 0, message: "Invalid request" } }));
				}
			};
		} catch (error) {
			if (error instanceof Error) {
				return log.error(error.message);
			}

			throw error;
		}
	},
});

/**
 * Main -------------------------------------------------------------------------------------------------------------------------------------------
 */

const main = defineCommand({
	subCommands: { dev },
	meta: { name, version },
});

runMain(main).catch((error) => {
	if (error instanceof Error) log.error(error.message);
	process.exit(1); // These are actual panics so we abort with a non-zero code
});
