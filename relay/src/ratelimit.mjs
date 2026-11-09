/**
 * Token buckets / connection counters used by the relay. All classes accept an
 * injectable clock (milliseconds) so tests are deterministic.
 */
export class TokenBucket {
  constructor(ratePerSecond, burst, now = Date.now()) {
    if (!(ratePerSecond > 0)) throw new Error('ratePerSecond must be > 0');
    if (!(burst > 0)) throw new Error('burst must be > 0');
    this.ratePerSecond = ratePerSecond;
    this.capacity = burst;
    this.tokens = burst;
    this.lastRefill = now;
  }

  refill(now = Date.now()) {
    if (now > this.lastRefill) {
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSecond);
      this.lastRefill = now;
    }
  }

  tryRemove(amount = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }
}

export class ConnectionRateLimiter {
  constructor({ packetsPerSecond, packetBurst, bytesPerSecond, byteBurst }, now = Date.now()) {
    this.packetBucket = new TokenBucket(packetsPerSecond, packetBurst, now);
    this.byteBucket = new TokenBucket(bytesPerSecond, byteBurst, now);
  }

  /**
   * @returns {{ok: true} | {ok: false, reason: 'packet_rate'|'byte_rate'}}
   */
  allowPacket(bytes, now = Date.now()) {
    if (!(bytes > 0)) return { ok: true };
    const packetOk = this.packetBucket.tryRemove(1, now);
    const byteOk = this.byteBucket.tryRemove(bytes, now);
    if (!packetOk || !byteOk) {
      return { ok: false, reason: packetOk ? 'byte_rate' : 'packet_rate' };
    }
    return { ok: true };
  }
}

export class IpConnectionLimiter {
  constructor(maxPerIp) {
    this.maxPerIp = maxPerIp;
    this.counts = new Map();
  }

  acquire(ip) {
    const count = this.counts.get(ip) ?? 0;
    if (count >= this.maxPerIp) return false;
    this.counts.set(ip, count + 1);
    return true;
  }

  release(ip) {
    const count = this.counts.get(ip) ?? 0;
    if (count <= 1) this.counts.delete(ip);
    else this.counts.set(ip, count - 1);
  }

  count(ip) {
    return this.counts.get(ip) ?? 0;
  }

  get size() {
    return this.counts.size;
  }
}

/** Frames larger than maxFrameBytes are dropped (and counted), never forwarded. */
export class FrameGuard {
  constructor({ maxFrameBytes = 2048, hardMaxFrameBytes = 65536 } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.hardMaxFrameBytes = hardMaxFrameBytes;
  }

  check(bytes) {
    if (!Number.isInteger(bytes) || bytes < 0) return { ok: false, reason: 'invalid_size' };
    if (bytes > this.hardMaxFrameBytes) return { ok: false, reason: 'hard_limit' };
    if (bytes > this.maxFrameBytes) return { ok: false, reason: 'too_large' };
    return { ok: true };
  }
}
