import { realtime, defineTransport } from "univo/realtime";

if (!process.env.ENDPOINT_URL) throw new Error("ENDPOINT_URL is not defined");
if (!process.env.TRANSPORT_URL) throw new Error("TRANSPORT_URL is not defined");

realtime({
	endpoints: [process.env.ENDPOINT_URL],
	transport: defineTransport(process.env.TRANSPORT_URL),
});
