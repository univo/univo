import { realtime } from "univo/realtime";
import { http, wss } from "univo/transport";

if (!process.env.NODE_URL) throw new Error("NODE_URL is not defined");
if (!process.env.INDEXER_URL) throw new Error("INDEXER_URL is not defined");

realtime({
	quiet: false,
	node: wss(process.env.NODE_URL),
	indexer: http(process.env.INDEXER_URL),
});
