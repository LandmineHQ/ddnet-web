import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToken, checkOrigin, safeEqual, redactToken } from '../src/auth.mjs';

test('open relay accepts any token when no token list is configured', () => {
  assert.deepEqual(checkToken(null, []), { ok: true, anonymous: true });
  assert.deepEqual(checkToken('whatever', []), { ok: true, anonymous: true });
});

test('missing token is rejected when tokens are configured', () => {
  assert.deepEqual(checkToken(null, ['abc']), { ok: false, reason: 'missing_token' });
  assert.deepEqual(checkToken('', ['abc']), { ok: false, reason: 'missing_token' });
});

test('wrong token is rejected, correct token accepted', () => {
  assert.deepEqual(checkToken('nope', ['abc']), { ok: false, reason: 'invalid_token' });
  assert.deepEqual(checkToken('abc', ['abc']), { ok: true, anonymous: false });
  assert.deepEqual(checkToken('two', ['one', 'two', 'three']), { ok: true, anonymous: false });
});

test('safeEqual is length safe and compares strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcdef'), false);
  assert.equal(safeEqual(null, 'abc'), false);
});

test('origin check allows missing Origin by default', () => {
  assert.equal(checkOrigin(null, []).ok, true);
  assert.equal(checkOrigin(undefined, ['https://example.com']).ok, true);
  assert.equal(checkOrigin(null, ['https://example.com'], { allowMissing: false }).ok, false);
});

test('empty origin allowlist accepts any origin (open mode)', () => {
  assert.equal(checkOrigin('https://evil.example', []).ok, true);
  assert.equal(checkOrigin('https://evil.example', []).open, true);
});

test('origin allowlist is exact and case-insensitive', () => {
  const list = ['https://relay.example.com', 'http://localhost:5173'];
  assert.equal(checkOrigin('https://relay.example.com', list).ok, true);
  assert.equal(checkOrigin('https://RELAY.example.com', list).ok, true);
  assert.equal(checkOrigin('http://localhost:5173', list).ok, true);
  assert.equal(checkOrigin('https://other.example.com', list).ok, false);
});

test('origin allowlist supports wildcards', () => {
  const list = ['https://*.example.com'];
  assert.equal(checkOrigin('https://a.example.com', list).ok, true);
  assert.equal(checkOrigin('https://a.b.example.com', list).ok, true);
  assert.equal(checkOrigin('https://evil-example.com', list).ok, false);
});

test('redactToken never returns the full token', () => {
  assert.equal(redactToken('supersecret'), 'su***et');
  assert.equal(redactToken('abc'), '***');
  assert.equal(redactToken(null), null);
});
