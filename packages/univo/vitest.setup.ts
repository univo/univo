import { config } from "dotenv";
import { setupServer } from "msw/node";

// Environment variables

config({ quiet: true });

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

export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
