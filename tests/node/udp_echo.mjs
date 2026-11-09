// Minimal UDP echo server used by the probe.
import dgram from "node:dgram";

const port = Number(process.argv[2] || 9001);
const sock = dgram.createSocket("udp4");
sock.on("message", (msg, rinfo) => {
	console.log(`[udp] ${rinfo.address}:${rinfo.port} -> ${msg.length} bytes: ${msg.toString("utf8").slice(0, 40)}`);
	sock.send(msg, rinfo.port, rinfo.address);
});
sock.bind(port, "127.0.0.1", () => console.log(`[udp] echo listening on 127.0.0.1:${port}`));
