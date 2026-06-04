import { config } from "dotenv";
import { setupServer } from "msw/node";
import { http, passthrough } from "msw";
import { promises as fs } from "node:fs";

config({ quiet: true });

if (process.env.TEST_ETHEREUM_RPC_URL === undefined) {
	throw new Error("Set a TEST_ETHEREUM_RPC_URL environment variable");
}

declare global {
	namespace NodeJS {
		interface ProcessEnv {
			TEST_ETHEREUM_RPC_URL: string;
		}
	}
}

export const server = setupServer(
	http.all(process.env.TEST_ETHEREUM_RPC_URL, passthrough), //
);

beforeAll(() => {
	server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
	server.resetHandlers();
});

afterAll(async () => {
	// Close the mocking server
	server.close();

	// Clear the `.storage` directory which houses our metadata storage
	await fs.rm("./.storage", { recursive: true, force: true });
});
