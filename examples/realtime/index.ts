import { realtime } from "univo/realtime";
import { http, wss } from "univo/transport";

if (!process.env.ENDPOINT_URL) throw new Error("ENDPOINT_URL is not defined");
if (!process.env.TRANSPORT_URL) throw new Error("TRANSPORT_URL is not defined");

realtime({
	quiet: false,
	node: wss(process.env.TRANSPORT_URL),
	indexer: http(process.env.ENDPOINT_URL),
});
