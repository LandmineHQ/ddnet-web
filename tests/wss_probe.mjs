import { createRequire } from "node:module";
const require = createRequire("/root/test/relay/");
const WebSocket = require("ws");
const url = process.argv[2] || "wss://192.168.31.31:8444/udp/127.0.0.1:8313";
const ws = new WebSocket(url, { rejectUnauthorized: false });
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 10000);
ws.on("open", () => {
	// DDNet 0.6 connless info 包（与中继 e2e 相同的 15 字节探测包）
	const buf = Buffer.concat([Buffer.alloc(10, 0xff), Buffer.from("gie3"), Buffer.from([0xff,0xff,0xff,0xff,0xff])]);
	ws.send(buf);
	console.log("[wss] connected, sent info probe");
});
ws.on("message", (data) => {
	clearTimeout(timer);
	console.log("[wss] reply " + data.length + " bytes: " + Buffer.from(data).toString("latin1").slice(0, 40).replace(/[\x00-\x1f]/g, "."));
	ws.close();
	process.exit(0);
});
ws.on("error", (e) => { clearTimeout(timer); console.log("ERROR " + e.message); process.exit(1); });
