/**
 * Typed errors for the relay. The `code` is stable and exposed in JSON error
 * responses / close reasons; `status` maps to the HTTP status used before the
 * WebSocket upgrade.
 */
export class RelayError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const ErrorCodes = Object.freeze({
  BAD_PATH: 'bad_path',
  BAD_TARGET: 'bad_target',
  BAD_PORT: 'bad_port',
  TARGET_CONFLICT: 'target_conflict',
  TARGET_NOT_ALLOWED: 'target_not_allowed',
  DNS_FAILED: 'dns_failed',
  UNAUTHORIZED: 'unauthorized',
  ORIGIN_DENIED: 'origin_denied',
  TOO_MANY_CONNECTIONS: 'too_many_connections',
  SERVER_BUSY: 'server_busy',
  NOT_FOUND: 'not_found',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSUPPORTED: 'unsupported',
  INTERNAL: 'internal_error',
  RTC_DISABLED: 'rtc_disabled',
  RTC_UNAVAILABLE: 'rtc_unavailable',
  RTC_BUSY: 'rtc_busy',
  RTC_RATE_LIMITED: 'rtc_rate_limited',
  RTC_INVALID_OFFER: 'invalid_offer',
  RTC_OFFER_TOO_LARGE: 'offer_too_large',
  RTC_GATHER_TIMEOUT: 'rtc_gather_timeout',
  RTC_ANSWER_FAILED: 'rtc_answer_failed',
  REQUEST_TIMEOUT: 'request_timeout',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
});
