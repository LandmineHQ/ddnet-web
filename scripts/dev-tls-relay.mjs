#!/usr/bin/env node
// 开发用 TLS 终结：wss://0.0.0.0:<port> -> ws://127.0.0.1:<relayPort>
// 生产环境请用 nginx 做同样的事（见 deploy/nginx.conf）。
//
//   node scripts/dev-tls-relay.mjs [--port 8444] [--relay 127.0.0.1:8390]
import https from 'node:https';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// ws 依赖装在 relay/ 下，脚本本身不额外装包。
const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('../tests/node_modules/ws');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const PORT = Number(arg('port', process.env.PORT || 8444));
const RELAY = arg('relay', '127.0.0.1:8390');
const CERT = arg('cert', 'tests/tls/cert.pem');
const KEY = arg('key', 'tests/tls/key.pem');
const UPSTREAM = 'ws://' + RELAY;

const server = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) });
const wss = new WebSocketServer({ server });

wss.on('connection', (client, req) => {
	const upstream = new WebSocket(UPSTREAM + (req.url || '/'));
	const pending = [];
	client.on('message', (data, isBinary) => {
		const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		if (upstream.readyState === WebSocket.OPEN) upstream.send(buf, { binary: isBinary });
		else pending.push([buf, isBinary]);
	});
	upstream.on('open', () => { for (const [buf, isBinary] of pending.splice(0)) upstream.send(buf, { binary: isBinary }); });
	upstream.on('message', (data, isBinary) => {
		if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
	});
	upstream.on('close', () => client.close());
	upstream.on('error', () => client.close());
	client.on('close', () => upstream.close());
	client.on('error', () => upstream.close());
});

server.listen(PORT, '0.0.0.0', () => {
	console.log('[wss] ' + UPSTREAM + ' exposed as wss://0.0.0.0:' + PORT);
});
