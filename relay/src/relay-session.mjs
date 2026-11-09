import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { ConnectionRateLimiter, FrameGuard } from './ratelimit.mjs';
import { formatTarget } from './url.mjs';
import { serializeError } from './log.mjs';

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'ENOTFOUND']);

/**
 * One WebSocket client <-> one connected UDP socket to the pinned target
 * address. Every binary WS message is sent as one UDP datagram; every UDP
 * datagram received is sent back as one binary WS message.
 */
export class RelaySession {
  constructor({ ws, req, target, resolved, clientIp, config, logger, stats, clock = Date.now, socketFactory }) {
    this.id = 'c-' + crypto.randomBytes(4).toString('hex');
    this.ws = ws;
    this.req = req;
    this.target = target;
    this.resolved = resolved;
    this.clientIp = clientIp;
    this.config = config;
    this.stats = stats;
    this.clock = clock;
    this.log = logger.child({ connId: this.id, target: formatTarget(target), clientIp });
    this.socketFactory = socketFactory ?? ((type) => dgram.createSocket({
      type,
      recvBufferSize: 1 << 20,
      sendBufferSize: 1 << 20,
    }));

    this.dgramType = resolved.family === 6 ? 'udp6' : 'udp4';
    this.startedAt = clock();
    this.lastActivityAt = this.startedAt;
    this.lastPingAt = this.startedAt;
    this.bytesToTarget = 0;
    this.bytesFromTarget = 0;
    this.packetsToTarget = 0;
    this.packetsFromTarget = 0;
    this.dropped = Object.create(null);
    this.pendingPackets = [];
    this.connected = false;
    this.closed = false;
    this.closeReason = null;
    this.socket = null;
    this.watchdog = null;
    this.terminateTimer = null;
    this._lastWarnAt = Object.create(null);
    this.rateLimiter = new ConnectionRateLimiter({
      packetsPerSecond: config.limits.maxPacketsPerSecond,
      packetBurst: config.limits.packetBurst,
      bytesPerSecond: config.limits.maxBytesPerSecond,
      byteBurst: config.limits.byteBurst,
    }, this.startedAt);
    this.frameGuard = new FrameGuard(config.limits);

    this.stats.onConnectionOpen({ target, clientIp });
    this.editWsHandlers();
    this.log.info('connection_open', {
      family: resolved.family,
      address: resolved.address,
      port: target.port,
      origin: req?.headers?.origin ?? null,
    });
  }

  editWsHandlers() {
    this.ws.on('message', (data, isBinary) => this.onWsMessage(data, isBinary));
    this.ws.on('close', () => {
      if (!this.closed) this.close('client_closed', 1000);
    });
    this.ws.on('error', (error) => {
      this.log.warn('ws_error', { error: serializeError(error) });
      if (!this.closed) this.close('ws_error', 1011);
    });
    this.ws.on('pong', () => {
      this.lastPongAt = this.clock();
    });
  }

  start() {
    const socket = this.socketFactory(this.dgramType);
    this.socket = socket;
    socket.on('message', (message) => this.onDatagram(message));
    socket.on('error', (error) => this.onSocketError(error));
    socket.once('close', () => {
      this.socket = null;
    });
    socket.connect(this.target.port, this.resolved.address, () => {
      if (this.closed) return;
      this.connected = true;
      this.log.info('udp_connected', { address: this.resolved.address, port: this.target.port });
      const pending = this.pendingPackets;
      this.pendingPackets = [];
      for (const packet of pending) this.sendUdp(packet);
    });

    const idle = this.config.limits.idleTimeoutMs || 1000;
    const interval = Math.max(25, Math.min(1000, Math.floor(idle / 4)));
    this.watchdog = setInterval(() => this.tick(), interval);
    this.watchdog.unref?.();
    return this;
  }

  tick() {
    if (this.closed) return;
    const now = this.clock();
    const { limits } = this.config;
    if (limits.idleTimeoutMs > 0 && now - this.lastActivityAt >= limits.idleTimeoutMs) {
      this.close('idle_timeout', 1001);
      return;
    }
    if (limits.maxConnectionMs > 0 && now - this.startedAt >= limits.maxConnectionMs) {
      this.close('max_duration', 1001);
      return;
    }
    if (limits.pingIntervalMs > 0 && now - this.lastPingAt >= limits.pingIntervalMs) {
      this.lastPingAt = now;
      try {
        this.ws.ping();
      } catch {
        /* socket already gone; close handler will fire */
      }
    }
  }

  onWsMessage(data, isBinary) {
    if (this.closed) return;
    this.lastActivityAt = this.clock();
    if (!isBinary) {
      // Text frames are not part of the data protocol; ignore them (and count).
      this.drop('text_frame');
      return;
    }
    let buffer;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (Array.isArray(data)) buffer = Buffer.concat(data);
    else buffer = Buffer.from(data);
    if (buffer.length === 0) {
      this.drop('empty_frame');
      return;
    }
    const guard = this.frameGuard.check(buffer.length);
    if (!guard.ok) {
      this.drop('frame_' + guard.reason);
      this.warnRateLimited('frame_dropped', { size: buffer.length, reason: guard.reason });
      return;
    }
    const allowed = this.rateLimiter.allowPacket(buffer.length, this.clock());
    if (!allowed.ok) {
      this.drop(allowed.reason);
      this.warnRateLimited('rate_limited', { size: buffer.length, reason: allowed.reason });
      return;
    }
    if (!this.connected) {
      // Packets that arrive while the connected UDP socket is still being set
      // up are buffered briefly instead of being lost.
      if (this.pendingPackets.length >= this.config.limits.maxPendingPackets) {
        this.drop('pending_overflow');
        return;
      }
      this.pendingPackets.push(buffer);
      return;
    }
    this.sendUdp(buffer);
  }

  sendUdp(buffer) {
    if (this.closed || !this.socket) return;
    this.socket.send(buffer, (error) => {
      if (error) {
        this.drop('udp_send_error');
        this.log.warn('udp_send_error', { error: serializeError(error) });
        return;
      }
      if (this.closed) return;
      this.packetsToTarget += 1;
      this.bytesToTarget += buffer.length;
      this.stats.onPacketToTarget(this.target, buffer.length);
    });
  }

  onDatagram(message) {
    if (this.closed) return;
    this.lastActivityAt = this.clock();
    this.packetsFromTarget += 1;
    this.bytesFromTarget += message.length;
    this.stats.onPacketFromTarget(this.target, message.length);
    if (this.ws.readyState !== this.ws.OPEN) {
      this.drop('ws_not_open');
      return;
    }
    if (this.ws.bufferedAmount > this.config.limits.maxBufferedBytes) {
      this.drop('backpressure');
      this.warnRateLimited('backpressure_drop', { bufferedAmount: this.ws.bufferedAmount });
      return;
    }
    this.ws.send(message, { binary: true }, (error) => {
      if (error) this.log.debug('ws_send_error', { error: serializeError(error) });
    });
  }

  onSocketError(error) {
    this.log.warn('udp_error', { code: error?.code, message: error?.message });
    if (this.closed) return;
    if (UNREACHABLE_CODES.has(error?.code)) this.close('target_unreachable', 1011);
    else this.close('udp_error', 1011);
  }

  drop(reason) {
    this.dropped[reason] = (this.dropped[reason] ?? 0) + 1;
    this.stats.onDrop(reason);
  }

  warnRateLimited(event, fields) {
    const now = this.clock();
    if (now - (this._lastWarnAt[event] ?? 0) < 5000) return;
    this._lastWarnAt[event] = now;
    this.log.warn(event, fields);
  }

  /**
   * Idempotent close: stops timers, closes the UDP socket, records stats and
   * closes the WebSocket with a descriptive close reason.
   */
  close(reason = 'closed', code = 1000) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
    const durationMs = this.clock() - this.startedAt;
    this.stats.onConnectionClose({
      target: this.target,
      reason,
      durationMs,
      bytesToTarget: this.bytesToTarget,
      bytesFromTarget: this.bytesFromTarget,
    });
    this.log.info('connection_closed', {
      reason,
      durationMs,
      bytesToTarget: this.bytesToTarget,
      bytesFromTarget: this.bytesFromTarget,
      packetsToTarget: this.packetsToTarget,
      packetsFromTarget: this.packetsFromTarget,
      dropped: { ...this.dropped },
    });
    try {
      if (this.ws.readyState === this.ws.OPEN) this.ws.close(code, String(reason).slice(0, 123));
    } catch {
      /* ignore */
    }
    this.terminateTimer = setTimeout(() => {
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
    }, 250);
    this.terminateTimer.unref?.();
  }

  forceTerminate() {
    if (this.terminateTimer) clearTimeout(this.terminateTimer);
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}
