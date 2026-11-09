import http from 'node:http';
import { WebSocketServer } from 'ws';
import { checkOrigin, checkToken } from './auth.mjs';
import { loadConfig, printableConfig, RELAY_PROTOCOL, VERSION } from './config.mjs';
import { createLogger, serializeError } from './log.mjs';
import { RelayStats } from './stats.mjs';
import { RelaySession } from './relay-session.mjs';
import { parseRelayRequest, extractToken, extractOrigin, formatTarget } from './url.mjs';
import { normalizeAddress } from './ssrf.mjs';
import { createAddressPolicy, resolveTarget } from './ssrf.mjs';
import { IpConnectionLimiter } from './ratelimit.mjs';
import { createRtcManager } from './rtc.mjs';
import { RelayError, ErrorCodes } from './errors.mjs';

function headerValue(headers, name) {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Resolve the client IP, honouring X-Forwarded-For only when trustProxy is enabled. */
export function getClientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = headerValue(req.headers, 'x-forwarded-for');
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      const normalized = normalizeAddress(first);
      if (normalized) return normalized.address;
    }
  }
  const remote = req.socket?.remoteAddress ?? 'unknown';
  return normalizeAddress(remote)?.address ?? remote;
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function rejectUpgrade(socket, status, code, message, extraHeaders = []) {
  const body = JSON.stringify({ error: message, code });
  const lines = [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}`,
    'content-type: application/json; charset=utf-8',
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
    'cache-control: no-store',
    ...extraHeaders,
    '',
    body,
  ];
  try {
    socket.write(lines.join('\r\n'));
  } catch {
    /* socket already gone */
  }
  socket.end();
  const timer = setTimeout(() => socket.destroy(), 1000);
  timer.unref?.();
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Read a JSON request body with a hard byte limit and timeout. */
function readJsonBody(req, maxBytes, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => {
      fail(new RelayError(ErrorCodes.REQUEST_TIMEOUT, 'Timed out reading request body', 408));
      try {
        req.resume();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref?.();

    function cleanup() {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        fail(new RelayError(ErrorCodes.RTC_OFFER_TOO_LARGE, `Offer body exceeds ${maxBytes} bytes`, 413));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        reject(new RelayError(ErrorCodes.RTC_INVALID_OFFER, 'Request body is empty', 400));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new RelayError(ErrorCodes.RTC_INVALID_OFFER, 'Request body must be valid JSON', 400));
      }
    }

    function onError(error) {
      fail(new RelayError(ErrorCodes.REQUEST_TIMEOUT, `Failed to read request body: ${error.message}`, 408));
    }

    function onAborted() {
      fail(new RelayError(ErrorCodes.REQUEST_TIMEOUT, 'Request body was aborted', 408));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function validateRtcOffer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RelayError(ErrorCodes.RTC_INVALID_OFFER, 'Request body must be a JSON object', 400);
  }
  const type = String(body.type ?? 'offer').toLowerCase();
  if (type !== 'offer') {
    throw new RelayError(ErrorCodes.RTC_INVALID_OFFER, 'Expected a WebRTC "offer" payload', 400);
  }
  const { sdp } = body;
  if (typeof sdp !== 'string' || sdp.length < 20) {
    throw new RelayError(ErrorCodes.RTC_INVALID_OFFER, 'Offer "sdp" must be a non-empty string', 400);
  }
  if (!sdp.trimStart().startsWith('v=0')) {
    throw new RelayError(ErrorCodes.RTC_INVALID_OFFER, 'Offer "sdp" is not a valid SDP description', 400);
  }
  if (!/^m=application\b/m.test(sdp)) {
    throw new RelayError(ErrorCodes.RTC_INVALID_OFFER, 'Offer SDP has no application m-line (data channel expected)', 400);
  }
  return sdp;
}

/**
 * Create a relay server (HTTP API + WebSocket endpoint). Call listen() to bind.
 */
export function createRelayServer(config, options = {}) {
  if (!config) throw new Error('createRelayServer requires a config object');
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const stats = options.stats ?? new RelayStats({ now: options.clock });
  const policy = createAddressPolicy(config.security);
  const ipLimiter = options.ipLimiter ?? new IpConnectionLimiter(config.limits.maxConnectionsPerIp);
  const lookup = options.lookup;
  const clock = options.clock ?? Date.now;
  const rtc = options.rtc ?? createRtcManager({
    config: config.rtc,
    logger,
    clock,
    loadModule: options.loadRtcModule,
  });
  const sessions = new Set();
  let closing = null;

  if (config.auth.tokens.length === 0) {
    logger.warn('auth_disabled', { message: 'No relay tokens configured; all clients are accepted' });
  }
  if (config.auth.originAllowlist.length === 0) {
    logger.warn('origin_allowlist_empty', { message: 'No Origin allowlist configured; browser Origins are not restricted' });
  }
  if (config.security.allowPrivate) {
    logger.warn('private_targets_allowed', { message: 'ALLOW_PRIVATE is enabled; private/loopback targets are permitted' });
  }

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: config.limits.hardMaxFrameBytes,
    clientTracking: false,
  });

  function corsHeaders(req) {
    const allowed = config.api.corsOrigins ?? [];
    const origin = headerValue(req.headers, 'origin');
    if (allowed.includes('*')) {
      return {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
        'access-control-allow-headers': 'authorization, x-relay-token, content-type',
      };
    }
    if (origin && allowed.some((entry) => entry.toLowerCase() === String(origin).toLowerCase())) {
      return {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
        'access-control-allow-headers': 'authorization, x-relay-token, content-type',
        vary: 'Origin',
      };
    }
    return {};
  }

  async function handleHttp(req, res) {
    let requestUrl;
    let pathname;
    try {
      requestUrl = new URL(req.url, 'http://relay.invalid');
      pathname = requestUrl.pathname;
    } catch {
      sendJson(res, 400, { error: 'Malformed request URL', code: ErrorCodes.BAD_TARGET });
      return;
    }
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-max-age': '600' });
      res.end();
      return;
    }

    if (pathname === '/rtc/offer') {
      await handleRtcOffer(req, res, requestUrl, cors);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed', code: ErrorCodes.METHOD_NOT_ALLOWED }, { ...cors, allow: 'GET, HEAD, OPTIONS' });
      return;
    }

    if (pathname === '/healthz') {
      const address = httpServer.address();
      sendJson(res, 200, {
        status: 'ok',
        service: 'ddnet-ws-relay',
        version: VERSION,
        activeConnections: sessions.size,
        rtc: rtc.available,
        uptimeSec: stats.snapshot().uptimeSec,
        time: new Date().toISOString(),
        address: address && typeof address === 'object' ? { host: address.address, port: address.port } : null,
      }, cors);
      return;
    }

    if (pathname === '/api/info') {
      sendJson(res, 200, {
        name: config.name,
        version: VERSION,
        protocol: RELAY_PROTOCOL,
        region: config.region,
        rtc: rtc.available,
        uptimeSec: stats.snapshot().uptimeSec,
        activeConnections: sessions.size,
        time: new Date().toISOString(),
      }, cors);
      return;
    }

    if (pathname === '/api/stats' && config.api.statsEnabled) {
      sendJson(res, 200, stats.snapshot({
        service: 'ddnet-ws-relay',
        version: VERSION,
        limits: {
          maxConnectionsPerIp: config.limits.maxConnectionsPerIp,
          maxConnectionsTotal: config.limits.maxConnectionsTotal,
          maxFrameBytes: config.limits.maxFrameBytes,
          maxPacketsPerSecond: config.limits.maxPacketsPerSecond,
          maxBytesPerSecond: config.limits.maxBytesPerSecond,
          idleTimeoutMs: config.limits.idleTimeoutMs,
          maxConnectionMs: config.limits.maxConnectionMs,
        },
        security: {
          allowPrivate: config.security.allowPrivate,
          tokensConfigured: config.auth.tokens.length,
          originsConfigured: config.auth.originAllowlist.length,
        },
        // Effective config for troubleshooting; token values are never exposed.
        config: printableConfig(config),
        rtc: rtc.snapshot(),
      }), cors);
      return;
    }

    if (pathname === '/api/servers' && config.api.serversEnabled) {
      sendJson(res, 200, {
        servers: config.servers,
        count: config.servers.length,
        generatedAt: new Date().toISOString(),
      }, cors);
      return;
    }

    sendJson(res, 404, { error: 'Not found', code: ErrorCodes.NOT_FOUND }, cors);
  }

  async function handleRtcOffer(req, res, requestUrl, cors) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed', code: ErrorCodes.METHOD_NOT_ALLOWED }, { ...cors, allow: 'POST, OPTIONS' });
      return;
    }

    const origin = extractOrigin(req.headers);
    const originResult = checkOrigin(origin, config.auth.originAllowlist, { allowMissing: config.auth.allowNoOrigin });
    if (!originResult.ok) {
      stats.onAuthFailure('origin');
      logger.warn('rtc_origin_rejected', { origin, reason: originResult.reason });
      sendJson(res, 403, { error: `Origin not allowed: ${origin}`, code: ErrorCodes.ORIGIN_DENIED }, cors);
      return;
    }

    const token = extractToken({ url: requestUrl, headers: req.headers, tokenHeader: config.auth.tokenHeader });
    const tokenResult = checkToken(token, config.auth.tokens);
    if (!tokenResult.ok) {
      stats.onAuthFailure(tokenResult.reason);
      logger.warn('rtc_auth_rejected', { reason: tokenResult.reason, remote: getClientIp(req, config.trustProxy) });
      sendJson(res, 401, { error: 'Invalid or missing relay token', code: ErrorCodes.UNAUTHORIZED }, {
        ...cors,
        'www-authenticate': 'Bearer realm="ddnet-relay"',
      });
      return;
    }

    if (!config.rtc.enabled) {
      sendJson(res, 503, { error: 'WebRTC endpoint is disabled', code: ErrorCodes.RTC_DISABLED }, cors);
      return;
    }
    if (!rtc.available) {
      sendJson(res, 503, { error: 'WebRTC support is not available on this relay', code: ErrorCodes.RTC_UNAVAILABLE }, cors);
      return;
    }

    const declaredLength = Number(headerValue(req.headers, 'content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > config.rtc.maxOfferBytes) {
      req.resume();
      sendJson(res, 413, { error: `Offer body exceeds ${config.rtc.maxOfferBytes} bytes`, code: ErrorCodes.RTC_OFFER_TOO_LARGE }, cors);
      return;
    }

    const clientIp = getClientIp(req, config.trustProxy);
    let body;
    try {
      body = await readJsonBody(req, config.rtc.maxOfferBytes);
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 400;
      const code = error instanceof RelayError ? error.code : ErrorCodes.RTC_INVALID_OFFER;
      sendJson(res, status, { error: error.message, code }, cors);
      return;
    }

    let sdp;
    try {
      sdp = validateRtcOffer(body);
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 400;
      const code = error instanceof RelayError ? error.code : ErrorCodes.RTC_INVALID_OFFER;
      sendJson(res, status, { error: error.message, code }, cors);
      return;
    }

    try {
      const answer = await rtc.handleOffer({ sdp, clientIp });
      sendJson(res, 200, answer, cors);
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 500;
      const code = error instanceof RelayError ? error.code : ErrorCodes.INTERNAL;
      logger.warn('rtc_offer_rejected', { clientIp, code, message: error.message });
      sendJson(res, status, { error: error.message, code }, cors);
    }
  }

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      logger.error('http_handler_error', { error: serializeError(error) });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal relay error', code: ErrorCodes.INTERNAL });
      } else {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    });
  });
  httpServer.on('connection', (socket) => {
    try {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);
    } catch {
      /* ignore */
    }
  });

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', (error) => {
      logger.debug('upgrade_socket_error', { error: serializeError(error) });
    });
    handleUpgrade(req, socket, head).catch((error) => {
      logger.error('upgrade_failed', { error: serializeError(error) });
      try {
        rejectUpgrade(socket, 500, ErrorCodes.INTERNAL, 'Internal relay error');
      } catch {
        /* ignore */
      }
    });
  });

  async function handleUpgrade(req, socket, head) {
    let parsed;
    try {
      parsed = parseRelayRequest({
        url: req.url,
        headers: req.headers,
        udpPath: config.udpPath,
        tokenHeader: config.auth.tokenHeader,
      });
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 400;
      const code = error instanceof RelayError ? error.code : ErrorCodes.BAD_TARGET;
      logger.warn('request_rejected', { reason: code, remote: getClientIp(req, config.trustProxy) });
      rejectUpgrade(socket, status, code, error.message);
      return;
    }

    const origin = extractOrigin(req.headers);
    const originResult = checkOrigin(origin, config.auth.originAllowlist, { allowMissing: config.auth.allowNoOrigin });
    if (!originResult.ok) {
      stats.onAuthFailure('origin');
      logger.warn('origin_rejected', { origin, reason: originResult.reason });
      rejectUpgrade(socket, 403, ErrorCodes.ORIGIN_DENIED, `Origin not allowed: ${origin}`);
      return;
    }
    if (!parsed.token) parsed.token = extractToken({ url: parsed.url, headers: req.headers, tokenHeader: config.auth.tokenHeader });
    const tokenResult = checkToken(parsed.token, config.auth.tokens);
    if (!tokenResult.ok) {
      stats.onAuthFailure(tokenResult.reason);
      logger.warn('auth_rejected', { reason: tokenResult.reason, remote: getClientIp(req, config.trustProxy) });
      rejectUpgrade(socket, 401, ErrorCodes.UNAUTHORIZED, 'Invalid or missing relay token', ['www-authenticate: Bearer realm="ddnet-relay"']);
      return;
    }

    if (sessions.size >= config.limits.maxConnectionsTotal) {
      stats.onTargetRejected('server_busy');
      rejectUpgrade(socket, 503, ErrorCodes.SERVER_BUSY, 'Relay is at capacity');
      return;
    }

    const clientIp = getClientIp(req, config.trustProxy);
    if (!ipLimiter.acquire(clientIp)) {
      stats.onTargetRejected('ip_limit');
      logger.warn('ip_limit_rejected', { clientIp, active: ipLimiter.count(clientIp) });
      rejectUpgrade(socket, 429, ErrorCodes.TOO_MANY_CONNECTIONS, `Too many connections from ${clientIp}`);
      return;
    }

    let resolved;
    try {
      resolved = await resolveTarget(parsed.target.host, {
        policy,
        lookup,
        timeoutMs: config.security.dnsTimeoutMs,
      });
    } catch (error) {
      ipLimiter.release(clientIp);
      const code = error instanceof RelayError ? error.code : ErrorCodes.TARGET_NOT_ALLOWED;
      stats.onTargetRejected(code);
      logger.warn('target_rejected', {
        target: formatTarget(parsed.target),
        clientIp,
        code,
        message: error.message,
      });
      const status = error instanceof RelayError ? error.status : 403;
      rejectUpgrade(socket, status, code, error.message);
      return;
    }

    if (socket.destroyed) {
      ipLimiter.release(clientIp);
      return;
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws._socket?.setNoDelay?.(true);
        ws._socket?.setKeepAlive?.(true, 30000);
        let session;
        try {
          session = new RelaySession({
            ws,
            req,
            target: parsed.target,
            resolved,
            clientIp,
            config,
            logger,
            stats,
            clock,
            socketFactory: options.socketFactory,
          });
        } catch (error) {
          logger.error('session_create_failed', { error: serializeError(error) });
          ipLimiter.release(clientIp);
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          return;
        }
        sessions.add(session);
        ws.once('close', () => {
          sessions.delete(session);
          ipLimiter.release(clientIp);
          if (!session.closed) session.close('client_closed', 1000);
        });
        try {
          session.start();
        } catch (error) {
          logger.error('session_start_failed', {
            connId: session.id,
            error: serializeError(error),
          });
          session.close('start_failed', 1011);
        }
      });
    } catch (error) {
      ipLimiter.release(clientIp);
      logger.error('upgrade_handshake_failed', { error: serializeError(error) });
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  async function listen(port = config.port, host = config.host) {
    // Load the optional WebRTC stack before serving so /api/info reports the
    // real capability. A missing/broken native module only disables /rtc/*;
    // the UDP relay keeps working.
    await rtc.init();
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });
    const address = httpServer.address();
    logger.info('relay_listening', {
      host: address.address,
      port: address.port,
      udpPath: config.udpPath,
      version: VERSION,
    });
    return address;
  }

  async function close({ timeoutMs = 2000 } = {}) {
    if (closing) return closing;
    closing = (async () => {
      logger.info('shutdown_start', { activeConnections: sessions.size, activeRtcPeers: rtc.activePeers });
      await rtc.close();
      const stopped = new Promise((resolve) => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
      });
      for (const session of [...sessions]) session.close('server_shutdown', 1001);
      const deadline = Date.now() + Math.min(timeoutMs, 1500);
      while (sessions.size > 0 && Date.now() < deadline) await delay(20);
      for (const session of [...sessions]) session.forceTerminate();
      await Promise.race([stopped, delay(timeoutMs)]);
      await new Promise((resolve) => {
        wss.close(() => resolve());
        setTimeout(resolve, 250).unref?.();
      });
      logger.info('shutdown_complete', { closedConnections: stats.snapshot().closedConnections });
    })();
    return closing;
  }

  return {
    config,
    logger,
    stats,
    sessions,
    wss,
    httpServer,
    rtc,
    listen,
    close,
    get address() {
      return httpServer.address();
    },
    url() {
      const address = httpServer.address();
      if (!address || typeof address !== 'object') return null;
      return `ws://${address.address}:${address.port}${config.udpPath}`;
    },
  };
}

export { loadConfig };
