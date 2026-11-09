// 仅用于本地测试的最小 WebSocket 中继（零依赖，不是生产实现）
// 用法：node web/tools/fake-relay.mjs [port]
// 提供 GET /healthz、/api/servers、/api/stats，并接受任意路径的 ws 升级（记录 path，回显二进制/文本帧）。

import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload == null ? '' : String(payload), 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const total = headerLength + maskLength + length;
    if (offset + total > buffer.length) break;
    let payload = buffer.subarray(offset + headerLength + maskLength, offset + total);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      const copy = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ mask[i % 4];
      payload = copy;
    }
    frames.push({ fin, opcode, payload });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function startFakeRelay(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : 0;
  const servers = options.servers || [
    { name: '测试服务器一号', host: 'ddnet.example.org', port: 8303, region: 'EU', players: 12 },
    { name: '测试服务器二号', host: '127.0.0.1', port: 8303, region: 'CN', players: { online: 3, max: 25 } },
  ];
  const stats = { upgrades: [], frames: [], rtcRequests: [], connections: 0, bytesIn: 0 };
  const relayInfo = options.info || {
    name: '测试中继',
    version: '1.0.0',
    protocol: 'ws-udp-datagram/1',
    region: 'LOCAL',
    rtc: true,
    players: 3,
    recommended: true,
  };
  const log = options.log || (() => {});

  const httpServer = http.createServer((req, res) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch (error) {
      pathname = '/';
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, service: 'ddweb-fake-relay', time: Date.now() }));
      return;
    }
    if (pathname === '/api/servers') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ servers }));
      return;
    }
    if (pathname === '/api/stats') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        connections: stats.connections,
        active: stats.upgrades.filter((item) => !item.closed).length,
        frames: stats.frames.length,
        bytesIn: stats.bytesIn,
        uptime: Math.round(process.uptime()),
      }));
      return;
    }
    if (pathname === '/api/info') {
      res.writeHead(200, headers);
      res.end(JSON.stringify(relayInfo));
      return;
    }
    if (pathname === '/rtc/offer') {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
        if (body.length > 100000) req.destroy();
      });
      req.on('end', () => {
        stats.rtcRequests.push({ url: req.url, body, at: Date.now() });
        if (options.rtc === false) {
          res.writeHead(501, headers);
          res.end(JSON.stringify({ error: 'rtc not supported' }));
          return;
        }
        // 假中继不做真实 WebRTC，只验证请求（含 token）已经到达
        res.writeHead(501, headers);
        res.end(JSON.stringify({ error: 'fake relay does not implement webrtc' }));
      });
      return;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'not found', path: pathname }));
  });

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const connection = { url: req.url || '/', startedAt: Date.now(), framesIn: 0, bytesIn: 0, closed: false };
    stats.upgrades.push(connection);
    stats.connections += 1;
    log('[fake-relay] upgrade ' + connection.url);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        connection.framesIn += 1;
        connection.bytesIn += frame.payload.length;
        stats.bytesIn += frame.payload.length;
        stats.frames.push({ url: connection.url, opcode: frame.opcode, length: frame.payload.length, at: Date.now() });
        if (frame.opcode === 0x8) {
          try {
            socket.write(encodeFrame(0x8, frame.payload));
          } catch (error) {
            // 忽略
          }
          socket.end();
          connection.closed = true;
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0xa) continue;
        if (frame.opcode === 0x1) {
          const text = frame.payload.toString('utf8');
          if (text === 'ping') {
            socket.write(encodeFrame(0x1, 'pong'));
            continue;
          }
          let handled = false;
          try {
            const data = JSON.parse(text);
            if (data && data.type === 'ping') {
              socket.write(encodeFrame(0x1, JSON.stringify({ type: 'pong', id: data.id, t: data.t })));
              handled = true;
            }
          } catch (error) {
            handled = false;
          }
          if (!handled) socket.write(encodeFrame(0x1, text));
          continue;
        }
        if (frame.opcode === 0x2) {
          socket.write(encodeFrame(0x2, frame.payload));
          continue;
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      connection.closed = true;
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const actualPort = httpServer.address().port;
      resolve({
        host,
        port: actualPort,
        url: 'ws://' + host + ':' + actualPort,
        httpUrl: 'http://' + host + ':' + actualPort,
        servers,
        stats,
        close() {
          return new Promise((done) => httpServer.close(() => done()));
        },
      });
    });
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith('fake-relay.mjs');
if (isMain) {
  const port = Number(process.argv[2] || 8399);
  startFakeRelay({ port, log: console.log })
    .then((relay) => {
      console.log('[fake-relay] ws  ' + relay.url);
      console.log('[fake-relay] http ' + relay.httpUrl + '  (/healthz /api/servers /api/stats)');
      console.log('[fake-relay] 任意 ws 路径都会握手成功，升级路径会被打印出来。');
    })
    .catch((error) => {
      console.error('[fake-relay] 启动失败', error);
      process.exit(1);
    });
}
