import crypto from 'node:crypto';
import { RelayError, ErrorCodes } from './errors.mjs';
import { TokenBucket } from './ratelimit.mjs';
import { serializeError } from './log.mjs';

/**
 * WebRTC latency-probe endpoints.
 *
 * The browser creates an RTCPeerConnection + data channel, POSTs its offer to
 * /rtc/offer, receives a non-trickle answer, and then uses the data channel to
 * measure RTT. The relay echoes every data channel message (text or binary)
 * unchanged. Each accepted offer owns one server-side libdatachannel
 * PeerConnection; the relay never stores media or inspects message contents.
 */

const MAX_TRACKED_RATE_BUCKETS = 4096;
const RATE_BUCKET_TTL_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBinaryBuffer(message) {
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  if (ArrayBuffer.isView(message)) {
    return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}

export function createRtcManager({ config, logger, clock = Date.now, loadModule }) {
  const peers = new Map();
  const offerBuckets = new Map();
  const counters = {
    totalOffers: 0,
    answersCreated: 0,
    rejectedOffers: 0,
    rateLimited: 0,
    busyRejections: 0,
    disabledRejections: 0,
    peersClosed: 0,
    channelsOpened: 0,
    messagesEchoed: 0,
    bytesEchoed: 0,
    errors: 0,
  };
  let moduleRef = null;
  let available = false;
  let initPromise = null;
  let closing = false;
  let lastError = null;

  function allowOfferFromIp(clientIp) {
    const now = clock();
    let bucket = offerBuckets.get(clientIp);
    if (!bucket) {
      bucket = new TokenBucket(config.maxOffersPerIpPerMinute / 60, config.offerBurst, now);
      offerBuckets.set(clientIp, bucket);
      if (offerBuckets.size > MAX_TRACKED_RATE_BUCKETS) {
        for (const [ip, candidate] of offerBuckets) {
          if (now - candidate.lastRefill > RATE_BUCKET_TTL_MS) offerBuckets.delete(ip);
        }
      }
    }
    return bucket.tryRemove(1, now);
  }

  async function init() {
    if (!config.enabled) return false;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const loader = loadModule ?? (() => import('node-datachannel'));
        moduleRef = await loader();
        if (!moduleRef?.PeerConnection) throw new Error('node-datachannel does not export PeerConnection');
        available = true;
        logger.info('rtc_ready', {
          libdatachannel: moduleRef.getLibraryVersion?.() ?? null,
          maxPeers: config.maxPeers,
          maxLifetimeMs: config.maxLifetimeMs,
          iceServers: [...config.iceServers],
        });
      } catch (error) {
        available = false;
        lastError = error;
        logger.warn('rtc_unavailable', {
          message: error.message,
          hint: 'install the node-datachannel dependency or set rtc.enabled=false',
        });
      }
      return available;
    })();
    return initPromise;
  }

  function snapshot() {
    return {
      enabled: config.enabled,
      available,
      activePeers: peers.size,
      maxPeers: config.maxPeers,
      maxLifetimeMs: config.maxLifetimeMs,
      maxOfferBytes: config.maxOfferBytes,
      maxOffersPerIpPerMinute: config.maxOffersPerIpPerMinute,
      ...counters,
      lastError: lastError ? lastError.message : null,
    };
  }

  function closePeer(peerId, reason) {
    const session = peers.get(peerId);
    if (!session || session.closed) return;
    session.closed = true;
    peers.delete(peerId);
    counters.peersClosed += 1;
    if (session.timer) clearTimeout(session.timer);
    session.onAnswerReject?.(new Error('peer closed'));
    for (const channel of session.channels) {
      try {
        channel.dc.close();
      } catch {
        /* already closed */
      }
    }
    try {
      session.pc.close();
    } catch {
      /* already closed */
    }
    logger.info('rtc_peer_closed', {
      peerId,
      clientIp: session.clientIp,
      reason,
      ageMs: Math.max(0, clock() - session.createdAt),
      channels: session.channels.length,
      messages: session.messages,
      bytes: session.bytes,
    });
  }

  function attachDataChannel(session, dc) {
    const record = { dc, label: 'unknown', open: false };
    try {
      record.label = dc.getLabel?.() ?? 'unknown';
    } catch {
      /* ignore */
    }
    session.channels.push(record);
    counters.channelsOpened += 1;
    try {
      dc.onOpen(() => {
        record.open = true;
        logger.debug('rtc_channel_open', { peerId: session.peerId, label: record.label });
      });
      dc.onClosed(() => {
        record.open = false;
        logger.debug('rtc_channel_closed', { peerId: session.peerId, label: record.label });
      });
      dc.onError((error) => {
        counters.errors += 1;
        logger.warn('rtc_channel_error', { peerId: session.peerId, error: String(error) });
      });
      dc.onMessage((message) => {
        if (session.closed || closing) return;
        try {
          const binary = toBinaryBuffer(message);
          if (binary) {
            // Binary messages must stay binary; never stringify them.
            dc.sendMessageBinary(binary);
            session.bytes += binary.length;
            counters.bytesEchoed += binary.length;
          } else {
            const text = String(message);
            dc.sendMessage(text);
            const bytes = Buffer.byteLength(text);
            session.bytes += bytes;
            counters.bytesEchoed += bytes;
          }
          session.messages += 1;
          counters.messagesEchoed += 1;
        } catch (error) {
          counters.errors += 1;
          logger.warn('rtc_echo_error', { peerId: session.peerId, error: serializeError(error) });
        }
      });
    } catch (error) {
      counters.errors += 1;
      logger.warn('rtc_channel_setup_error', { peerId: session.peerId, error: serializeError(error) });
    }
  }

  function waitForAnswer(session, timeoutMs) {
    if (session.answerSdp) return Promise.resolve(session.answerSdp);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('timeout waiting for WebRTC answer')), timeoutMs);
      timer.unref?.();
      function finish(error, sdp) {
        clearTimeout(timer);
        session.onAnswerResolve = null;
        session.onAnswerReject = null;
        if (error) reject(error);
        else resolve(sdp);
      }
      session.onAnswerResolve = (sdp) => finish(null, sdp);
      session.onAnswerReject = (error) => finish(error);
    });
  }

  async function waitForLocalCandidates(pc, session, timeoutMs) {
    const started = clock();
    let partial = null;
    while (clock() - started <= timeoutMs) {
      if (session.closed) throw new Error('peer closed before ICE gathering');
      let description = null;
      let state = 'unknown';
      try {
        description = pc.localDescription();
        state = pc.gatheringState();
      } catch {
        /* native object may be gone */
      }
      const sdp = description?.sdp;
      if (sdp && /a=candidate/.test(sdp)) {
        partial = sdp;
        if (state === 'complete' || state === 'failed') return sdp;
      }
      await sleep(20);
    }
    if (partial) {
      logger.warn('rtc_gather_partial', { peerId: session.peerId, note: 'returning answer without complete ICE gathering' });
      return partial;
    }
    throw new RelayError(ErrorCodes.RTC_GATHER_TIMEOUT, 'ICE candidate gathering timed out (relay may have no usable network interface)', 504);
  }

  async function handleOffer({ sdp, clientIp }) {
    counters.totalOffers += 1;
    if (closing) {
      counters.rejectedOffers += 1;
      throw new RelayError(ErrorCodes.RTC_DISABLED, 'Relay is shutting down', 503);
    }
    if (!config.enabled) {
      counters.disabledRejections += 1;
      counters.rejectedOffers += 1;
      throw new RelayError(ErrorCodes.RTC_DISABLED, 'WebRTC endpoint is disabled', 503);
    }
    if (!available || !moduleRef) {
      counters.rejectedOffers += 1;
      throw new RelayError(ErrorCodes.RTC_UNAVAILABLE, 'WebRTC support is not available on this relay', 503);
    }
    if (!allowOfferFromIp(clientIp)) {
      counters.rateLimited += 1;
      counters.rejectedOffers += 1;
      throw new RelayError(ErrorCodes.RTC_RATE_LIMITED, 'Too many WebRTC offers from this IP', 429);
    }
    if (peers.size >= config.maxPeers) {
      counters.busyRejections += 1;
      counters.rejectedOffers += 1;
      throw new RelayError(ErrorCodes.RTC_BUSY, `Relay has reached its WebRTC peer limit (${config.maxPeers})`, 503);
    }

    const peerId = 'rtc-' + crypto.randomBytes(4).toString('hex');
    let pc;
    try {
      pc = new moduleRef.PeerConnection(peerId, { iceServers: [...config.iceServers] });
    } catch (error) {
      counters.errors += 1;
      counters.rejectedOffers += 1;
      logger.warn('rtc_peer_create_failed', { peerId, clientIp, error: serializeError(error) });
      throw new RelayError(ErrorCodes.RTC_UNAVAILABLE, 'Failed to create WebRTC peer', 503);
    }

    const session = {
      peerId,
      pc,
      clientIp,
      createdAt: clock(),
      closed: false,
      answerSdp: null,
      onAnswerResolve: null,
      onAnswerReject: null,
      channels: [],
      messages: 0,
      bytes: 0,
      timer: null,
    };
    peers.set(peerId, session);
    session.timer = setTimeout(() => closePeer(peerId, 'max_lifetime'), config.maxLifetimeMs);
    session.timer.unref?.();
    logger.info('rtc_offer_received', { peerId, clientIp, offerBytes: Buffer.byteLength(sdp), activePeers: peers.size });

    try {
      pc.onLocalDescription((answerSdp, type) => {
        if (session.closed || type !== 'answer') return;
        session.answerSdp = answerSdp;
        session.onAnswerResolve?.(answerSdp);
      });
      pc.onDataChannel((dc) => attachDataChannel(session, dc));
      pc.onStateChange((state) => {
        logger.debug('rtc_peer_state', { peerId, state });
        if (state === 'failed' || state === 'closed') closePeer(peerId, state === 'failed' ? 'connection_failed' : 'closed');
      });
    } catch (error) {
      counters.errors += 1;
      closePeer(peerId, 'handler_setup_failed');
      throw new RelayError(ErrorCodes.RTC_UNAVAILABLE, 'Failed to configure WebRTC peer', 503);
    }

    try {
      pc.setRemoteDescription(sdp, 'offer');
    } catch (error) {
      counters.errors += 1;
      closePeer(peerId, 'invalid_offer');
      throw new RelayError(ErrorCodes.RTC_INVALID_OFFER, `Invalid WebRTC offer: ${error.message}`, 400);
    }

    try {
      await waitForAnswer(session, config.gatherTimeoutMs);
      const answerSdp = await waitForLocalCandidates(pc, session, config.gatherTimeoutMs);
      counters.answersCreated += 1;
      logger.info('rtc_answer_created', {
        peerId,
        clientIp,
        answerBytes: Buffer.byteLength(answerSdp),
        elapsedMs: Math.max(0, clock() - session.createdAt),
      });
      return { type: 'answer', sdp: answerSdp };
    } catch (error) {
      counters.errors += 1;
      counters.rejectedOffers += 1;
      closePeer(peerId, 'answer_failed');
      if (error instanceof RelayError) throw error;
      throw new RelayError(ErrorCodes.RTC_ANSWER_FAILED, `Failed to create WebRTC answer: ${error.message}`, 504);
    }
  }

  async function close() {
    closing = true;
    for (const peerId of [...peers.keys()]) closePeer(peerId, 'server_shutdown');
    offerBuckets.clear();
  }

  return {
    init,
    handleOffer,
    close,
    snapshot,
    get enabled() {
      return config.enabled;
    },
    get available() {
      return available;
    },
    get activePeers() {
      return peers.size;
    },
  };
}
