// Minimal TLS terminator for local testing: wss://127.0.0.1:8443 -> ws://127.0.0.1:8390
// (in production this job is done by Caddy / nginx, see docker-compose.yml)
import https from "node:https";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

const cert = fs.readFileSync("/root/test/tests/tls/cert.pem");
const key = fs.readFileSync("/root/test/tests/tls/key.pem");
const server = https.createServer({ cert, key });
const wss = new WebSocketServer({ server });

wss.on("connection", (client, req) => {
	const upstream = new WebSocket("ws://127.0.0.1:8390" + (req.url || "/"));
	upstream.binaryType = "arraybuffer";
	const pending = [];
	client.on("message", (data, isBinary) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		if (upstream.readyState === WebSocket.OPEN) upstream.send(buf, { binary: isBinary });
		else pending.push([buf, isBinary]);
	});
	upstream.on("open", () => {
		for (const [buf, isBinary] of pending.splice(0)) upstream.send(buf, { binary: isBinary });
	});
	upstream.on("message", (data, isBinary) => {
		if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
	});
	upstream.on("close", () => client.close());
	upstream.on("error", (e) => { console.log("[tls-proxy] upstream error", e.message); client.close(); });
	client.on("close", () => upstream.close());
	client.on("error", () => upstream.close());
});

server.listen(8443, "127.0.0.1", () => console.log("[tls-proxy] wss://127.0.0.1:8443 -> ws://127.0.0.1:8390"));
