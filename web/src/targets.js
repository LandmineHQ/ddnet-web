// 目标服务器地址解析与校验（纯函数）

export const DEFAULT_PORT = 8303;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const IPV6_RE = /^\[[0-9A-Fa-f:.]+\]$/;

export function parseTarget(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return { ok: false, error: '请输入目标服务器，格式为 host:port，例如 ddnet.example.org:8303' };
  }
  if (/\s/.test(raw)) {
    return { ok: false, error: '目标地址不能包含空格' };
  }

  const fromRelayUrl = raw.match(/\/udp\/([^/?#]+)/i);
  if (fromRelayUrl) {
    return parseTarget(decodeURIComponent(fromRelayUrl[1]));
  }

  let text = raw;
  const scheme = text.match(/^(?:ddnet|ddweb|wss?|https?):\/\//i);
  if (scheme) text = text.slice(scheme[0].length);
  const slash = text.indexOf('/');
  if (slash >= 0) text = text.slice(0, slash);

  let host;
  let port;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return { ok: false, error: 'IPv6 地址缺少 "]"' };
    host = text.slice(0, close + 1);
    const rest = text.slice(close + 1);
    if (!rest.startsWith(':')) return { ok: false, error: 'IPv6 地址后需要用 ":" 指定端口，例如 [::1]:8303' };
    port = rest.slice(1);
  } else {
    const colon = text.lastIndexOf(':');
    if (colon <= 0) {
      return { ok: false, error: '缺少端口号，格式应为 host:port（例如 ddnet.example.org:8303）' };
    }
    host = text.slice(0, colon);
    port = text.slice(colon + 1);
    if (host.indexOf(':') >= 0) {
      return { ok: false, error: 'IPv6 地址请写成 [::1]:8303 的形式' };
    }
  }

  if (!IPV6_RE.test(host) && !IPV4_RE.test(host) && !HOSTNAME_RE.test(host)) {
    return { ok: false, error: '主机名无效：' + host };
  }
  if (IPV6_RE.test(host)) {
    host = host.toLowerCase();
  } else {
    host = host.toLowerCase();
  }
  if (host.length > 255) return { ok: false, error: '主机名过长' };

  if (!/^\d{1,5}$/.test(port)) {
    return { ok: false, error: '端口必须是 1-65535 之间的整数' };
  }
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < MIN_PORT || portNumber > MAX_PORT) {
    return { ok: false, error: '端口必须是 1-65535 之间的整数' };
  }

  return { ok: true, host, port: portNumber, target: host + ':' + portNumber, input: raw };
}

export function isValidTarget(input) {
  return parseTarget(input).ok;
}
