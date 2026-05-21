import ws from "ws";
import { WebSocket } from "partysocket";
import type { ErrorEvent } from "partysocket/ws";

import type { Rpc } from "./rpc";
import { createException } from "./exceptions";
import { compress, createLogger, raise } from "./utils";

type Transport<R extends Rpc> = {
	/**
	 * Performs a JSON RPC request
	 * @returns The RPC response
	 */
	request: <M extends keyof R["request"]>(opts: { method: M; params: Parameters<R["request"][M]> }) => Promise<Awaited<ReturnType<R["request"][M]>>>;
	/**
	 * Subscribes to specific event to receive and invoke a callback for a stream of values
	 * @returns An async function to unsubscribe from the stream
	 */
	subscribe: <M extends keyof R["subscribe"]>(param: M, handler: (message: R["subscribe"][M]) => void) => Promise<() => Promise<void>>;
};

/**
 * WSS -----------------------------------------------------------------------------------------------------------------------------------
 */

type SocketOptions = {
	/**
	 * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
	 * this indicates that the connection is ready to send and receive data. Note that this function
	 * can be called multiple times over the lifetime of a socket as dropped connections are initialised
	 */
	onOpen?: () => Promise<void> | void;
	/**
	 * An event listener to be called when the WebSocket connection's readyState changes to CLOSED.
	 */
	onClose?: () => Promise<void> | void;
	/**
	 * An event listener to be called when an error occurs
	 */
	onError?: (event: ErrorEvent) => Promise<void> | void;
	/**
	 * An event listener to be called when a message is received from the server
	 */
	onMessage?: (event: MessageEvent) => Promise<void> | void;
};

function createSocket(url: `wss://${string}`, opts: SocketOptions) {
	const socket = new WebSocket(url, [], { WebSocket: ws });

	// No support for `binaryType` of "blob" in Bun yet so we set it to "arraybuffer" https://github.com/partykit/partykit/issues/774
	socket.binaryType = "arraybuffer";

	if (opts.onOpen) socket.onopen = opts.onOpen;
	if (opts.onError) socket.onerror = opts.onError;
	if (opts.onClose) socket.onclose = opts.onClose;
	if (opts.onMessage) socket.onmessage = opts.onMessage;

	return socket;
}

function wss<R extends Rpc>(url: string, opts: { quiet?: boolean } = {}): Transport<R> {
	if (!url.startsWith("wss://")) {
		throw new Error("Websocket connections must start with `wss://`");
	}

	const logger = createLogger({ quiet: opts.quiet ?? false });

	let id = 0;

	// Every request gets an identifier based on `id` above. This map represents that request in-flight
	// and it's corresponding callback handler to invoke when a response is received on the connection.
	const requests = new Map<number, (data: any) => void>();

	// This is a key value store for a given subscription id to a given param
	const subscriptions = new Map<string, { param: string; latest: number }>();

	// For each param we keep a set of handlers to notify when we receive a response
	const params = new Map<string, Set<(data: any) => void>>();

	const socket = createSocket(url as "wss://", {
		async onError(cause) {
			logger.error(new Error("Socket error", { cause }));
		},

		async onOpen() {
			if (subscriptions.size === 0) return;

			// If the socket connection is reinitalised this function will be called multiple times. When that
			// happens we need to re-initialise all underlying subscriptions on the new connection.

			const params: string[] = [];

			for (const [id, subscription] of subscriptions) {
				params.push(subscription.param);

				// This isn't strictly needed for correctness. The fact that the websocket connection was dropped
				// likely means the node automatically dropped our subscriptions. So we can fire-and-forget this.

				request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
					logger.warn("Failed to cancel old susbcription");
				});

				subscriptions.delete(id);
			}

			for (const param of params) {
				request({ method: "eth_subscribe", params: [param] }).then((id) => {
					subscriptions.set(id, { param, latest: Date.now() });
				});
			}
		},

		async onMessage(event) {
			const data = JSON.parse(event.data);

			if (data.method === "eth_subscription") {
				const subscription = subscriptions.get(data.params.subscription);

				if (subscription === undefined) {
					return await request({ method: "eth_unsubscribe", params: [data.params.subscription] }).catch(() => {
						logger.warn("Failed to unsubscribe stale subscription");
					});
				}

				const handlers = params.get(subscription.param);

				if (handlers === undefined) {
					return await request({ method: "eth_unsubscribe", params: [data.params.subscription] }).catch(() => {
						logger.warn("Failed to unsubscribe stale subscription");
					});
				}

				for (const handler of handlers) {
					try {
						handler(data.params.result);
					} catch (cause) {
						logger.error(new Error("Handler error", { cause }));
					}
				}

				subscription.latest = Date.now();

				return;
			}

			const handler = requests.get(data.id);

			if (handler === undefined) {
				return logger.warn(`Received unknown response for request id ${data.id}...`);
			}

			return handler(data.result);
		},
	});

	const request: Transport<Rpc>["request"] = async (opts: { method: string; params: any[] }) => {
		return await new Promise<any>((resolve) => {
			const body = Object.assign({ id: id++ }, opts);

			requests.set(body.id, (data) => {
				// TODO: Could set a timeout to clean up the request to mitigate memory leaks
				requests.delete(body.id);
				resolve(data);
			});

			socket.send(JSON.stringify(body));
		});
	};

	const subscribe: Transport<Rpc>["subscribe"] = async (param: string, handler: (messsage: any) => void) => {
		const handlers = params.get(param);

		if (handlers === undefined) {
			const handlers = new Set<(data: any) => void>().add(handler);

			params.set(param, handlers);

			const id = await request({ method: "eth_subscribe", params: [param] }).catch((cause) => {
				throw new Error(`Failed to initialise subscription for param ${param}`, { cause });
			});

			subscriptions.set(id, { param, latest: Date.now() });
		} else {
			handlers.add(handler);
		}

		return async function unsubscribe() {
			const handlers = params.get(param);

			if (handlers === undefined) {
				return logger.warn("Param already unsubscribed...");
			}

			handlers.delete(handler);

			if (handlers.size === 0) {
				await request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
					logger.warn("Failed to unsubscribe unused subscription");
				});
			}
		};
	};

	function healthcheck() {
		const params: string[] = [];

		for (const [id, subscription] of subscriptions) {
			if (Date.now() - subscription.latest > 60 * 1000) {
				params.push(subscription.param);

				request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
					logger.warn("Failed to cancel old susbcription");
				});

				subscriptions.delete(id);

				logger.warn(`Subscription ${id} failed health check, reinitialising..`);
			}
		}

		for (const param of params) {
			request({ method: "eth_subscribe", params: [param] }).then((id) => {
				subscriptions.set(id, { param, latest: Date.now() });
			});
		}
	}

	setInterval(healthcheck, 60 * 1000);

	return { request, subscribe };
}

/**
 * HTTP -----------------------------------------------------------------------------------------------------------------------------------
 */

function http<R extends Rpc>(url: string, opts: { signingKey?: string } = {}): Transport<R> {
	let id = 0;

	const request: Transport<Rpc>["request"] = async (options) => {
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
	};

	const subscribe: Transport<Rpc>["subscribe"] = async () => {
		throw new Error("Unable to `subscribe` on `http` transport");
	};

	return { request, subscribe };
}

const ClientCompressionError = createException("An error occurred when compressing the request");
const ClientConnectionError = createException("An errored occurred when connecting to the server");
const ClientResponseError = createException("An error occurred when reading the servers response");
const ClientUnauthorizedError = createException("Attempted to execute a private method without providing a request signing key");

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { http, wss };
export type { Transport };
