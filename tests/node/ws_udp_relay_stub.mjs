// Minimal stand-in for the real relay: forwards WebSocket binary frames to the
// UDP target given in the URL path (/udp/<host>:<port>) and back.
import { WebSocketServer } from "ws";
import dgram from "node:dgram";

const port = Number(process.env.WS_PORT || 8390);
const wss = new WebSocketServer({ port, host: "127.0.0.1" });

wss.on("listening", () => console.log(`[ws] stub relay listening on ws://127.0.0.1:${port}`));

wss.on("connection", (ws, req) => {
	const m = /^\/udp\/([^:/]+):(\d+)/.exec(req.url || "");
	if (!m) {
		console.log(`[ws] bad path ${req.url}`);
		ws.close(1008, "bad path");
		return;
	}
	const host = m[1];
	const targetPort = Number(m[2]);
	console.log(`[ws] connection ${req.socket.remoteAddress} -> ${host}:${targetPort}`);

	const udp = dgram.createSocket("udp4");
	udp.on("message", (msg) => {
		if (ws.readyState === ws.OPEN) ws.send(msg);
	});
	udp.connect(targetPort, host);

	ws.on("message", (data) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		try { udp.send(buf); } catch (e) { console.log(`[ws] udp send failed: ${e.message}`); }
	});
	ws.on("close", () => { console.log("[ws] closed"); udp.close(); });
	ws.on("error", (e) => { console.log(`[ws] error ${e.message}`); udp.close(); });
});
