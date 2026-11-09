import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, ConnectionRateLimiter, IpConnectionLimiter, FrameGuard } from '../src/ratelimit.mjs';

test('token bucket drains and refills at the configured rate', () => {
  const bucket = new TokenBucket(10, 5, 0);
  for (let i = 0; i < 5; i += 1) assert.equal(bucket.tryRemove(1, 0), true);
  assert.equal(bucket.tryRemove(1, 0), false);
  assert.equal(bucket.tryRemove(1, 500), true); // 0.5s * 10/s = 5 tokens
  assert.equal(bucket.tryRemove(1, 500), true);
});

test('token bucket caps refill at burst capacity', () => {
  const bucket = new TokenBucket(100, 5, 0);
  bucket.refill(60000);
  assert.equal(bucket.tokens, 5);
});

test('connection rate limiter enforces packet rate with burst', () => {
  const limiter = new ConnectionRateLimiter({
    packetsPerSecond: 10,
    packetBurst: 2,
    bytesPerSecond: 10000,
    byteBurst: 20000,
  }, 0);
  assert.deepEqual(limiter.allowPacket(10, 0), { ok: true });
  assert.deepEqual(limiter.allowPacket(10, 0), { ok: true });
  assert.deepEqual(limiter.allowPacket(10, 0), { ok: false, reason: 'packet_rate' });
  assert.deepEqual(limiter.allowPacket(10, 200), { ok: true });
});

test('connection rate limiter enforces byte rate', () => {
  const limiter = new ConnectionRateLimiter({
    packetsPerSecond: 100,
    packetBurst: 100,
    bytesPerSecond: 1000,
    byteBurst: 1500,
  }, 0);
  assert.deepEqual(limiter.allowPacket(1000, 0), { ok: true });
  assert.deepEqual(limiter.allowPacket(600, 0), { ok: false, reason: 'byte_rate' });
  assert.deepEqual(limiter.allowPacket(400, 0), { ok: true });
  assert.deepEqual(limiter.allowPacket(500, 500), { ok: true }); // refill 500 bytes
});

test('per-IP connection limiter counts and releases', () => {
  const limiter = new IpConnectionLimiter(2);
  assert.equal(limiter.acquire('1.2.3.4'), true);
  assert.equal(limiter.acquire('1.2.3.4'), true);
  assert.equal(limiter.acquire('1.2.3.4'), false);
  assert.equal(limiter.acquire('5.6.7.8'), true);
  assert.equal(limiter.count('1.2.3.4'), 2);
  limiter.release('1.2.3.4');
  assert.equal(limiter.acquire('1.2.3.4'), true);
  limiter.release('1.2.3.4');
  limiter.release('1.2.3.4');
  assert.equal(limiter.count('1.2.3.4'), 0);
  assert.equal(limiter.size, 1);
});

test('frame guard accepts exactly the maximum and drops larger frames', () => {
  const guard = new FrameGuard({ maxFrameBytes: 2048, hardMaxFrameBytes: 65536 });
  assert.equal(guard.check(1400).ok, true);
  assert.equal(guard.check(2048).ok, true);
  assert.deepEqual(guard.check(2049), { ok: false, reason: 'too_large' });
  assert.deepEqual(guard.check(2049).reason, 'too_large');
  assert.deepEqual(guard.check(70000), { ok: false, reason: 'hard_limit' });
});
