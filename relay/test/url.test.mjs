import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRelayRequest, splitHostPort, formatTarget, extractToken } from '../src/url.mjs';
import { RelayError } from '../src/errors.mjs';

const parse = (url, headers = {}) => parseRelayRequest({ url, headers });

function rejectsWith(fn, code, status) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RelayError, 'expected RelayError');
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('parses /udp/host:port', () => {
  const { target } = parse('/udp/1.2.3.4:8303');
  assert.deepEqual({ host: target.host, port: target.port }, { host: '1.2.3.4', port: 8303 });
});

test('parses hostname target and query token', () => {
  const { target, token } = parse('/udp/ddnet.example.org:8303?token=abc123');
  assert.equal(target.host, 'ddnet.example.org');
  assert.equal(target.port, 8303);
  assert.equal(token, 'abc123');
});

test('parses bracketed IPv6 target', () => {
  const { target } = parse('/udp/[2001:db8::1]:8313');
  assert.equal(target.host, '2001:db8::1');
  assert.equal(target.port, 8313);
  assert.equal(formatTarget(target), '[2001:db8::1]:8313');
});

test('defaults the port to 8303 when omitted', () => {
  assert.equal(parse('/udp/example.org').target.port, 8303);
  assert.equal(splitHostPort('example.org').port, 8303);
  assert.equal(splitHostPort('::1').port, 8303);
  assert.equal(splitHostPort('[::1]').port, 8303);
});

test('supports ?target=host:port with /udp path', () => {
  const { target } = parse('/udp?target=5.6.7.8:8303');
  assert.equal(target.host, '5.6.7.8');
  assert.equal(target.port, 8303);
});

test('path + matching query target is accepted, conflicting is rejected', () => {
  const { target } = parse('/udp/1.2.3.4:8303?target=1.2.3.4:8303');
  assert.equal(target.port, 8303);
  rejectsWith(() => parse('/udp/1.2.3.4:8303?target=9.9.9.9:8303'), 'target_conflict', 400);
});

test('decodes percent-encoded targets', () => {
  const { target } = parse('/udp/example.org%3A8303');
  assert.equal(target.host, 'example.org');
  assert.equal(target.port, 8303);
});

test('rejects missing/empty targets', () => {
  rejectsWith(() => parse('/udp'), 'bad_target', 400);
  rejectsWith(() => parse('/udp/'), 'bad_target', 400);
  rejectsWith(() => parse('/udp?target='), 'bad_target', 400);
});

test('rejects bad ports', () => {
  for (const value of ['0', '65536', 'abc', '', '8303x']) {
    rejectsWith(() => parse('/udp/example.org:' + value), 'bad_port', 400);
  }
});

test('rejects invalid hosts and paths', () => {
  rejectsWith(() => parse('/udp/bad host:8303'), 'bad_target', 400);
  rejectsWith(() => parse('/udp/example.org:8303/extra'), 'bad_target', 400);
  rejectsWith(() => parse('/udp/example.org%2Fother:8303'), 'bad_target', 400);
  rejectsWith(() => parse('/not-udp/example.org:8303'), 'bad_path', 404);
  rejectsWith(() => parse('/udp/[example.org]:8303'), 'bad_target', 400);
});

test('extracts token from Authorization Bearer header', () => {
  const { token } = parse('/udp/1.2.3.4:8303', { authorization: 'Bearer header-token' });
  assert.equal(token, 'header-token');
});

test('extracts token from x-relay-token header', () => {
  const { token } = parse('/udp/1.2.3.4:8303', { 'x-relay-token': 'relay-header-token' });
  assert.equal(token, 'relay-header-token');
});

test('query token takes precedence over headers', () => {
  assert.equal(extractToken({
    url: new URL('http://relay.invalid/udp/1.2.3.4:8303?token=query'),
    headers: { authorization: 'Bearer header' },
  }), 'query');
});

test('formatTarget handles IPv4 and IPv6', () => {
  assert.equal(formatTarget({ host: '1.2.3.4', port: 8303 }), '1.2.3.4:8303');
  assert.equal(formatTarget({ host: '::1', port: 8303 }), '[::1]:8303');
});
