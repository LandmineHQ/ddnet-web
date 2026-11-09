#!/usr/bin/env node
// DDNet Web 本地开发服务器（零依赖）
// - 静态文件 + 正确的 MIME（.wasm -> application/wasm）
// - 强制发送 COOP/COEP，让 SharedArrayBuffer 可用
// - 默认根目录 dist/web，缺失时退化为 web/；同时把 web/ 作为前端源码回退根
// 用法：node web/serve.mjs [--port 8392] [--host 0.0.0.0] [--root dist/web]

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(WEB_DIR);
const DEFAULT_ROOT = path.join(REPO_ROOT, 'dist', 'web');
const BUILD_ARTIFACTS = ['DDNet.js', 'DDNet.wasm', 'DDNet.data'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const BASE_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function log(...args) {
  console.log('[ddweb]', ...args);
}

function parseArgs(argv) {
  const result = { port: null, host: null, master: null, roots: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--port' || arg === '-p') {
      result.port = argv[i + 1];
      i += 1;
    } else if (arg.indexOf('--port=') === 0) {
      result.port = arg.slice('--port='.length);
    } else if (arg === '--host') {
      result.host = argv[i + 1];
      i += 1;
    } else if (arg.indexOf('--host=') === 0) {
      result.host = arg.slice('--host='.length);
    } else if (arg === '--master') {
      result.master = argv[i + 1];
      i += 1;
    } else if (arg.indexOf('--master=') === 0) {
      result.master = arg.slice('--master='.length);
    } else if (arg === '--root' || arg === '-r') {
      if (argv[i + 1]) result.roots.push(argv[i + 1]);
      i += 1;
    } else if (arg.indexOf('--root=') === 0) {
      result.roots.push(arg.slice('--root='.length));
    } else {
      console.warn('[ddweb] 忽略未知参数：' + arg);
    }
  }
  return result;
}

function printHelp() {
  console.log([
    'DDNet Web 静态开发服务器',
    '',
    '用法：node web/serve.mjs [选项]',
    '',
    '选项：',
    '  -p, --port <端口>   监听端口（默认 8392，也可用环境变量 PORT）',
    '      --host <地址>   监听地址（默认 0.0.0.0，也可用环境变量 HOST）',
    '      --master <host:port>  relay master 上游（默认 127.0.0.1:8391）',
    '  -r, --root <目录>   静态根目录，可重复指定（优先级从左到右；默认 <repo>/dist/web）',
    '  -h, --help          显示帮助',
    '',
    '说明：',
    '  * 根目录缺失时自动退化为 web/ 目录，页面会提示“客户端构建产物缺失”。',
    '  * 始终把 web/ 作为回退根目录，方便在 dist/web 尚未包含前端文件时直接调试。',
    '  * 所有响应都带 COOP: same-origin / COEP: require-corp，保证 SharedArrayBuffer 可用。',
    '  * GET /__ddweb/info 可查看解析后的根目录与构建产物状态。',
  ].join('\n'));
}

async function pathInfo(target) {
  try {
    return await stat(target);
  } catch (error) {
    return null;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return first !== '..';
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendBody(res, status, headers, body) {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const merged = Object.assign({}, BASE_HEADERS, headers || {});
  if (payload) merged['Content-Length'] = String(payload.length);
  res.writeHead(status, merged);
  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return;
  }
  if (payload) res.end(payload);
  else res.end();
}

function sendText(res, status, text, extraHeaders) {
  sendBody(res, status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, extraHeaders || {}), text);
}

function sendHtml(res, status, html) {
  sendBody(res, status, { 'Content-Type': 'text/html; charset=utf-8' }, html);
}

function notFoundResponse(res, pathname) {
  if (pathname.indexOf('/DDNet.') >= 0) {
    sendText(res, 404, [
      '404 构建产物缺失：' + pathname,
      '',
      '这个静态服务器没有找到 DDNet 的 Emscripten 构建产物。',
      '预期位置：dist/web/DDNet.js 与 dist/web/DDNet.wasm（可选 dist/web/DDNet.data）。',
      '本地开发：先按 docs/PLAN.md 的 M0 完成 wasm 构建，或用 --root 指向包含产物的目录。',
      '没有构建产物时，前端页面仍然可用，并会显示“客户端构建产物缺失”的提示。',
    ].join('\n'));
    return;
  }
  if (pathname === '/favicon.ico') {
    sendBody(res, 204, {}, null);
    return;
  }
  const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>404 - DDNet Web</title>' +
    '<style>body{background:#0a0c12;color:#e9ecf3;font-family:system-ui,sans-serif;padding:40px;line-height:1.6}' +
    'h1{color:#ffa500}a{color:#3ad1c4}code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:5px}</style></head><body>' +
    '<h1>404 找不到资源</h1><p>路径：<code>' + escapeHtml(pathname) + '</code></p>' +
    '<p><a href="/">返回首页</a></p>' +
    '<p>如果你在部署前端，请确认客户端构建产物（<code>DDNet.js</code>、<code>DDNet.wasm</code>、<code>DDNet.data</code>）' +
    '与 <code>index.html</code> 位于同一目录。</p>' +
    '</body></html>';
  sendHtml(res, 404, html);
}

function proxyMaster(req, res, pathname, master) {
  const prefixes = ['/relay-master', '/master-api'];
  const prefix = prefixes.find((value) => pathname === value || pathname.startsWith(value + '/'));
  if (!prefix) return false;
  const [host, port] = master.split(':');
  const rawURL = req.url || '/';
  const upstreamPath = rawURL.slice(prefix.length) || '/';
  const proxyReq = http.request(
    { host, port: Number(port), path: upstreamPath, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => { res.writeHead(502); res.end('relay master unreachable'); });
  req.pipe(proxyReq);
  return true;
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function createRequestHandler(context) {
  return async function handleRequest(req, res) {
    const startedAt = process.hrtime.bigint();
    const method = req.method || 'GET';
    res.on('finish', () => {
      const time = elapsedMs(startedAt).toFixed(1);
      log(method + ' ' + (req.url || '/') + ' -> ' + res.statusCode + ' (' + time + ' ms)');
    });

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, '405 只支持 GET / HEAD', { Allow: 'GET, HEAD' });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch (error) {
      sendText(res, 400, '400 无法解析请求路径');
      return;
    }

    if (pathname.startsWith('/relay-master') || pathname.startsWith('/master-api')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, '405 只支持 GET / HEAD', { Allow: 'GET, HEAD' });
        return;
      }
      if (proxyMaster(req, res, pathname, context.master)) return;
    }

    if (pathname === '/__ddweb/info') {
      const info = {
        server: 'ddweb-serve',
        version: 1,
        port: context.port,
        host: context.host,
        primaryRoot: context.primaryRoot,
        roots: context.roots,
        buildArtifacts: context.artifacts,
        headers: {
          'Cross-Origin-Opener-Policy': BASE_HEADERS['Cross-Origin-Opener-Policy'],
          'Cross-Origin-Embedder-Policy': BASE_HEADERS['Cross-Origin-Embedder-Policy'],
        },
      };
      sendBody(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(info, null, 2));
      return;
    }

    if (pathname.split('/').indexOf('..') >= 0) {
      sendText(res, 403, '403 禁止的路径');
      return;
    }

    let relativePath = pathname.replace(/^\/+/, '');
    if (relativePath === '' || relativePath.endsWith('/')) relativePath += 'index.html';

    let resolved = null;
    for (const root of context.roots) {
      const candidate = path.resolve(root, relativePath);
      if (!isInside(root, candidate)) continue;
      const info = await pathInfo(candidate);
      if (info && info.isFile()) {
        resolved = { filePath: candidate, root, size: info.size };
        break;
      }
      if (info && info.isDirectory()) {
        const indexPath = path.join(candidate, 'index.html');
        const indexInfo = await pathInfo(indexPath);
        if (indexInfo && indexInfo.isFile()) {
          resolved = { filePath: indexPath, root, size: indexInfo.size };
          break;
        }
      }
    }

    if (!resolved) {
      notFoundResponse(res, pathname);
      return;
    }

    const headers = {
      'Content-Type': mimeTypeFor(resolved.filePath),
      'Content-Length': String(resolved.size),
    };
    res.writeHead(200, Object.assign({}, BASE_HEADERS, headers));
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(resolved.filePath);
    stream.on('error', (error) => {
      log('读取文件失败：' + resolved.filePath + ' — ' + error.message);
      if (!res.headersSent) sendText(res, 500, '500 读取文件失败');
      else res.destroy();
    });
    stream.pipe(res);
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const port = Number(args.port != null ? args.port : process.env.PORT || 8392);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('[ddweb] 端口无效：' + (args.port != null ? args.port : process.env.PORT));
    process.exitCode = 1;
    return;
  }
  const host = args.host || process.env.HOST || '0.0.0.0';

  const candidates = [];
  if (args.roots.length) {
    for (const root of args.roots) candidates.push(path.resolve(process.cwd(), root));
  } else if (process.env.DDWEB_ROOT) {
    for (const root of String(process.env.DDWEB_ROOT).split(path.delimiter)) {
      if (root) candidates.push(path.resolve(root));
    }
  } else {
    candidates.push(DEFAULT_ROOT);
  }

  const roots = [];
  for (const candidate of candidates) {
    const info = await pathInfo(candidate);
    if (info && info.isDirectory() && roots.indexOf(candidate) < 0) roots.push(candidate);
  }
  const primaryRoot = roots.length ? roots[0] : null;
  if (!primaryRoot) {
    log('未找到静态根目录 ' + candidates.join(' 或 ') + '，退化为前端源码目录。');
  }
  const webInfo = await pathInfo(WEB_DIR);
  if (webInfo && webInfo.isDirectory() && roots.indexOf(WEB_DIR) < 0) roots.push(WEB_DIR);
  if (!roots.length) {
    console.error('[ddweb] 没有可用的静态根目录。');
    process.exitCode = 1;
    return;
  }

  const artifacts = {};
  for (const name of BUILD_ARTIFACTS) {
    let found = null;
    for (const root of roots) {
      const info = await pathInfo(path.join(root, name));
      if (info && info.isFile()) {
        found = path.join(root, name);
        break;
      }
    }
    artifacts[name] = found;
  }

  const master = args.master || process.env.DDWEB_MASTER || '127.0.0.1:8391';
  const context = { port, host, roots, primaryRoot, artifacts, master };
  const server = http.createServer(createRequestHandler(context));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }).catch((error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error('[ddweb] 端口 ' + port + ' 已被占用，请使用 --port 指定其他端口。');
    } else {
      console.error('[ddweb] 启动失败：', error);
    }
    process.exitCode = 1;
    server.close();
  });
  if (process.exitCode) return;

  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  log('静态服务器已启动：http://' + displayHost + ':' + port + '/');
  log('监听地址：' + host + ':' + port);
  for (const root of roots) log('静态根目录：' + root);
  for (const name of BUILD_ARTIFACTS) {
    const found = artifacts[name];
    log('  ' + name + '：' + (found ? found : '缺失'));
  }
  const hasRuntime = Boolean(artifacts['DDNet.js'] && artifacts['DDNet.wasm']);
  log('构建产物状态：' + (hasRuntime ? '已就绪，可以启动客户端。' : '缺失，页面会显示“客户端构建产物缺失”的提示（其余功能可用）。'));
  log('响应头：Cross-Origin-Opener-Policy: same-origin / Cross-Origin-Embedder-Policy: require-corp');
  log('环境自检：GET /__ddweb/info');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('收到 ' + signal + '，正在关闭服务器…');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
}

main().catch((error) => {
  console.error('[ddweb] 未处理的错误：', error);
  process.exitCode = 1;
});
