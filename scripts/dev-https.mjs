#!/usr/bin/env node
// 开发用 HTTPS 站点 + 同端口反代（HTTP + WebSocket）：
//   https://0.0.0.0:<port>/             -> dist/web 静态文件（COOP/COEP）
//   https://0.0.0.0:<port>/api/*|/healthz|/rtc/* -> http://127.0.0.1:<relayPort>/*
//   https://0.0.0.0:<port>/relay-master/*|/master-api/* -> http://127.0.0.1:<masterPort>/*
//   wss://0.0.0.0:<port>/udp/host:port  -> ws://127.0.0.1:<relayPort>/udp/host:port
//   https://0.0.0.0:<port>/relays.json  -> 动态生成（同源 wss 中继），方便首次访问
//
// 局域网只需接受一张证书、一个端口：页面与中继同源，无混合内容、无二次证书确认。
//
//   node scripts/dev-https.mjs [--port 8443] [--root dist/web] [--relay 127.0.0.1:8390]
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('../tests/node_modules/ws');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const PORT = Number(arg('port', process.env.PORT || 8443));
const ROOT = path.resolve(arg('root', 'dist/web'));
const RELAY = arg('relay', '127.0.0.1:8390');
const MASTER = arg('master', '127.0.0.1:8391');
const CERT = arg('cert', 'tests/tls/cert.pem');
const KEY = arg('key', 'tests/tls/key.pem');
const [RELAY_HOST, RELAY_PORT] = RELAY.split(':');
const [MASTER_HOST, MASTER_PORT] = MASTER.split(':');
const MASTER_PREFIXES = ['/relay-master/', '/master-api/'];

const API_PREFIXES = ['/api/', '/rtc/', '/healthz', '/ws'];

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
	'.data': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
	'.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function proxyHttp(req, res, url, host = RELAY_HOST, port = RELAY_PORT) {
	const proxyReq = http.request(
		{ host, port, path: url, method: req.method, headers: req.headers },
		(proxyRes) => {
			res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
			proxyRes.pipe(res);
		},
	);
	proxyReq.on('error', () => { res.writeHead(502); res.end('upstream unreachable'); });
	req.pipe(proxyReq);
}

function dynamicRelays(req) {
	// 用访问者的 Host 头生成同源中继地址，局域网/远端都能直接用
	const host = req.headers.host || ('localhost:' + PORT);
	return JSON.stringify({
		relays: [
			{ name: '同源中继（本机）', url: 'wss://' + host, note: 'dev-https 同端口反代' },
			{ name: '本机 8390', url: 'ws://127.0.0.1:8390', note: '仅本机浏览器可用' },
		],
	});
}

const server = https.createServer(
	{ cert: await readFile(CERT), key: await readFile(KEY) },
	async (req, res) => {
		const url = req.url || '/';
		const pathname = url.split('?')[0];
		const masterPrefix = MASTER_PREFIXES.find((prefix) => pathname.startsWith(prefix));
		if (masterPrefix) {
			const upstreamPath = url.slice(masterPrefix.length - 1);
			return proxyHttp(req, res, upstreamPath, MASTER_HOST, MASTER_PORT);
		}
		if (API_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p))) {
			return proxyHttp(req, res, url);
		}
		if (pathname === '/relays.json') {
			const body = dynamicRelays(req);
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(body);
			return;
		}
		try {
			let rel = decodeURIComponent(pathname);
			if (rel.endsWith('/')) rel += 'index.html';
			const file = path.join(ROOT, path.normalize(rel));
			if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
			const info = await stat(file);
			if (!info.isFile()) { res.writeHead(404); res.end('not found'); return; }
			const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
			res.writeHead(200, {
				'Content-Type': type,
				'Content-Length': info.size,
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Resource-Policy': 'same-origin',
				'Cache-Control': 'no-cache',
			});
			createReadStream(file).pipe(res);
		} catch {
			res.writeHead(404); res.end('not found');
		}
	},
);

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
	wss.handleUpgrade(req, socket, head, (client) => {
		const upstream = new WebSocket('ws://' + RELAY + (req.url || '/'));
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
		upstream.on('close', () => { try { client.close(); } catch {} });
		upstream.on('error', () => { try { client.close(); } catch {} });
		client.on('close', () => { try { upstream.close(); } catch {} });
		client.on('error', () => { try { upstream.close(); } catch {} });
	});
});

server.listen(PORT, '0.0.0.0', () => {
	console.log('[https] ' + ROOT + ' + api/ws proxy -> ' + RELAY + ' on :' + PORT);
});
