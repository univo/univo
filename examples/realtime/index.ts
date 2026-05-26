import { realtime } from "univo/realtime";
import { http, wss } from "univo/transport";

if (!process.env.RPC_URL) throw new Error("RPC_URL is not defined");
if (!process.env.INDEXER_URL) throw new Error("INDEXER_URL is not defined");

realtime({
	quiet: false,
	node: wss(process.env.RPC_URL),
	indexer: http(process.env.INDEXER_URL),
});
