// Package relayerr defines the stable error codes and the typed error used by
// the relay. Codes are exposed verbatim in JSON error responses, in WebSocket
// close reasons and in the stats drop counters, so they are part of the public
// contract (they mirror the legacy Node relay's errors.mjs).
package relayerr

import "errors"

// Stable error codes.
const (
	BadPath            = "bad_path"
	BadTarget          = "bad_target"
	BadPort            = "bad_port"
	TargetConflict     = "target_conflict"
	TargetNotAllowed   = "target_not_allowed"
	DNSFailed          = "dns_failed"
	Unauthorized       = "unauthorized"
	OriginDenied       = "origin_denied"
	TooManyConnections = "too_many_connections"
	ServerBusy         = "server_busy"
	NotFound           = "not_found"
	PayloadTooLarge    = "payload_too_large"
	Unsupported        = "unsupported"
	Internal           = "internal_error"
	RTCDisabled        = "rtc_disabled"
	RTCUnavailable     = "rtc_unavailable"
	RTCBusy            = "rtc_busy"
	RTCRateLimited     = "rtc_rate_limited"
	RTCInvalidOffer    = "invalid_offer"
	RTCOfferTooLarge   = "offer_too_large"
	RTCGatherTimeout   = "rtc_gather_timeout"
	RTCAnswerFailed    = "rtc_answer_failed"
	RequestTimeout     = "request_timeout"
	MethodNotAllowed   = "method_not_allowed"
	BadHandshake       = "bad_handshake"
)

// Error is a relay error with an HTTP status that is used before the WebSocket
// upgrade (or for the HTTP API).
type Error struct {
	Code    string
	Message string
	Status  int
	Details map[string]any
}

// New returns a new relay error. A status <= 0 defaults to 400.
func New(code, message string, status int) *Error {
	if status <= 0 {
		status = 400
	}
	return &Error{Code: code, Message: message, Status: status}
}

// WithDetails attaches structured details (never serialized to clients).
func (e *Error) WithDetails(details map[string]any) *Error {
	e.Details = details
	return e
}

func (e *Error) Error() string { return e.Message }

// Status extracts the HTTP status/code/message from err. Unknown errors map to
// a generic 500 internal error, matching the relay's last-resort handler.
func Status(err error) (status int, code string, message string) {
	var relayError *Error
	if errors.As(err, &relayError) {
		return relayError.Status, relayError.Code, relayError.Message
	}
	return 500, Internal, "Internal relay error"
}

// CodeOf returns the relay error code, or fallback for unknown errors.
func CodeOf(err error, fallback string) string {
	var relayError *Error
	if errors.As(err, &relayError) {
		return relayError.Code
	}
	return fallback
}
