import { config } from "dotenv";
import { setupServer } from "msw/node";
import { http, passthrough } from "msw";

// Environment variables

config();

if (process.env.TEST_ETHEREUM_RPC_WSS === undefined) {
	throw new Error("Set a TEST_ETHEREUM_RPC_WSS environment variable");
}

if (process.env.TEST_ETHEREUM_RPC_URL === undefined) {
	throw new Error("Set a TEST_ETHEREUM_RPC_URL environment variable");
}

declare global {
	namespace NodeJS {
		interface ProcessEnv {
			TEST_ETHEREUM_RPC_WSS: string;
			TEST_ETHEREUM_RPC_URL: string;
		}
	}
}

// Mock service worker

export const server = setupServer(
	http.all("http://localhost:7483/:key", passthrough), //
	http.all(process.env.TEST_ETHEREUM_RPC_URL, passthrough),
);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
