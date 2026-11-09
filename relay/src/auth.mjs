import crypto from 'node:crypto';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

/** Constant-time-ish comparison: hash both values first so lengths never leak. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = sha256(a);
  const right = sha256(b);
  return crypto.timingSafeEqual(left, right) && a.length === b.length;
}

/**
 * Validate a provided token against the configured token list.
 * An empty list means the relay is open (anonymous access), which the server
 * logs as a warning at startup.
 */
export function checkToken(provided, tokens = []) {
  const list = Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string' && t.length > 0) : [];
  if (list.length === 0) return { ok: true, anonymous: true };
  if (typeof provided !== 'string' || provided.length === 0) {
    return { ok: false, reason: 'missing_token' };
  }
  // Do not early-exit: evaluate every configured token.
  let matched = false;
  for (const token of list) {
    if (safeEqual(provided, token)) matched = true;
  }
  return matched ? { ok: true, anonymous: false } : { ok: false, reason: 'invalid_token' };
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * Origin allowlist check. Missing Origin (non-browser client / same-origin
 * WebSocket from some contexts) is handled separately; browsers always send it.
 */
export function checkOrigin(origin, allowlist = [], { allowMissing = true } = {}) {
  if (!origin) return { ok: allowMissing, reason: allowMissing ? 'no_origin' : 'missing_origin' };
  const list = Array.isArray(allowlist) ? allowlist.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
  if (list.length === 0) return { ok: true, open: true };
  const value = origin.trim().toLowerCase();
  for (const entry of list) {
    const allowed = entry.trim().toLowerCase();
    if (allowed === '*') return { ok: true };
    if (allowed === value) return { ok: true };
    if (allowed.includes('*') && wildcardToRegExp(allowed).test(value)) return { ok: true };
  }
  return { ok: false, reason: 'origin_not_allowed' };
}

export function redactToken(token) {
  if (!token) return null;
  const value = String(token);
  if (value.length <= 4) return '***';
  return value.slice(0, 2) + '***' + value.slice(-2);
}
