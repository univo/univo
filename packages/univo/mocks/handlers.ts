import { config } from "dotenv";
import { http, passthrough } from "msw";

config(); // Ensure the env variables are correctly loaded

export const handlers = [
	http.all("http://localhost:3000/:key", passthrough), //
	http.all(process.env.TEST_ETHEREUM_RPC_URL, passthrough),
];
