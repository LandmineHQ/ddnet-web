import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAddress,
  normalizeAddress,
  createAddressPolicy,
  evaluateAddress,
  resolveTarget,
} from '../src/ssrf.mjs';
import { RelayError } from '../src/errors.mjs';

const cases = [
  ['10.1.2.3', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.254', 'private'],
  ['192.168.1.1', 'private'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['169.254.10.20', 'link_local'],
  ['100.64.0.1', 'cgnat'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.250', 'multicast'],
  ['0.0.0.0', 'unspecified'],
  ['255.255.255.255', 'broadcast'],
  ['198.51.100.7', 'reserved'],
  ['::1', 'loopback'],
  ['fe80::1', 'link_local'],
  ['fc00::1', 'private'],
  ['fd12:3456::1', 'private'],
  ['ff02::1', 'multicast'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:7f00:1', 'ipv4_mapped'],
];

for (const [ip, category] of cases) {
  test(`blocks ${ip} as ${category}`, () => {
    const result = classifyAddress(ip);
    assert.equal(result.valid, true);
    assert.equal(result.forbidden, true);
    assert.equal(result.category, category);
  });
}

const publicAddresses = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:80f::200e'];
for (const ip of publicAddresses) {
  test(`allows public address ${ip}`, () => {
    const result = classifyAddress(ip);
    assert.equal(result.forbidden, false);
    assert.equal(result.category, 'public');
  });
}

test('normalizes IPv4-mapped IPv6 and zones', () => {
  assert.deepEqual(normalizeAddress('::ffff:10.0.0.1'), { address: '10.0.0.1', family: 4, mapped: true });
  assert.deepEqual(normalizeAddress('fe80::1%eth0'), { address: 'fe80::1', family: 6, mapped: false });
  assert.equal(normalizeAddress('not-an-ip'), null);
});

test('allowPrivate bypasses classification', () => {
  const policy = createAddressPolicy({ allowPrivate: true });
  const result = evaluateAddress('127.0.0.1', '127.0.0.1', policy);
  assert.equal(result.normalized, '127.0.0.1');
});

test('private targets are rejected by default', () => {
  const policy = createAddressPolicy();
  assert.throws(() => evaluateAddress('10.0.0.5', 'server.internal', policy), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, 'target_not_allowed');
    assert.equal(error.status, 403);
    return true;
  });
});

test('allowlist accepts exact IP, CIDR and hostname', () => {
  const policy = createAddressPolicy({ allowlist: ['10.0.0.5', '192.168.0.0/16', 'internal.example.com'] });
  assert.doesNotThrow(() => evaluateAddress('10.0.0.5', '10.0.0.5', policy));
  assert.doesNotThrow(() => evaluateAddress('192.168.42.42', '192.168.42.42', policy));
  assert.doesNotThrow(() => evaluateAddress('10.9.9.9', 'internal.example.com', policy));
  assert.throws(() => evaluateAddress('10.9.9.9', 'other.example.com', policy));
});

test('resolveTarget pins literal public addresses', async () => {
  const policy = createAddressPolicy();
  const result = await resolveTarget('1.1.1.1', { policy });
  assert.equal(result.address, '1.1.1.1');
  assert.equal(result.family, 4);
});

test('resolveTarget rejects literal private addresses', async () => {
  const policy = createAddressPolicy();
  await assert.rejects(resolveTarget('127.0.0.1', { policy }), { code: 'target_not_allowed' });
});

test('resolveTarget rejects a hostname resolving to private IPs', async () => {
  const policy = createAddressPolicy();
  const lookup = async () => [{ address: '10.1.2.3', family: 4 }];
  await assert.rejects(
    resolveTarget('evil.example.com', { policy, lookup }),
    { code: 'target_not_allowed' },
  );
});

test('resolveTarget rejects mixed public/private DNS answers (rebinding)', async () => {
  const policy = createAddressPolicy();
  const lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(resolveTarget('rebind.example.com', { policy, lookup }), { code: 'target_not_allowed' });
});

test('resolveTarget accepts public DNS answers and pins one address', async () => {
  const policy = createAddressPolicy();
  let calls = 0;
  const lookup = async (host) => {
    calls += 1;
    assert.equal(host, 'ddnet.example.com');
    return [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ];
  };
  const result = await resolveTarget('ddnet.example.com', { policy, lookup });
  assert.equal(calls, 1);
  assert.equal(result.address, '93.184.216.34');
  assert.deepEqual(result.addresses, ['2606:4700:4700::1111', '93.184.216.34']);
});

test('hostname allowlist permits private DNS answers', async () => {
  const policy = createAddressPolicy({ allowlist: ['my-lan-server.local'] });
  const lookup = async () => [{ address: '192.168.1.50', family: 4 }];
  const result = await resolveTarget('my-lan-server.local', { policy, lookup });
  assert.equal(result.address, '192.168.1.50');
});

test('resolveTarget maps DNS failures to dns_failed (no crash)', async () => {
  const policy = createAddressPolicy();
  const lookup = async () => {
    const error = new Error('getaddrinfo ENOTFOUND');
    error.code = 'ENOTFOUND';
    throw error;
  };
  await assert.rejects(resolveTarget('nope.example.com', { policy, lookup }), { code: 'dns_failed' });
});

test('resolveTarget handles empty DNS answers', async () => {
  const policy = createAddressPolicy();
  const lookup = async () => [];
  await assert.rejects(resolveTarget('empty.example.com', { policy, lookup }), { code: 'dns_failed' });
});

test('invalid allowlist entries are rejected at startup', () => {
  assert.throws(() => createAddressPolicy({ allowlist: ['999.999.999.999/24'] }), /Invalid allowlist CIDR/);
});
