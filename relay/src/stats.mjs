import { formatTarget } from './url.mjs';

/**
 * In-memory aggregate statistics exposed by GET /api/stats.
 * Per-connection counters are kept on the session; this class aggregates.
 */
export class RelayStats {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.startedAt = now();
    this.activeConnections = 0;
    this.totalConnections = 0;
    this.closedConnections = 0;
    this.bytesToTarget = 0;
    this.bytesFromTarget = 0;
    this.packetsToTarget = 0;
    this.packetsFromTarget = 0;
    this.droppedFrames = 0;
    this.dropsByReason = Object.create(null);
    this.closeReasons = Object.create(null);
    this.authFailures = 0;
    this.targetRejections = 0;
    this.targets = new Map();
  }

  _target(target) {
    const key = formatTarget(target);
    let entry = this.targets.get(key);
    if (!entry) {
      entry = {
        target: key,
        connections: 0,
        activeConnections: 0,
        packetsToTarget: 0,
        packetsFromTarget: 0,
        bytesToTarget: 0,
        bytesFromTarget: 0,
      };
      this.targets.set(key, entry);
    }
    return entry;
  }

  onConnectionOpen({ target, clientIp } = {}) {
    this.activeConnections += 1;
    this.totalConnections += 1;
    const entry = this._target(target);
    entry.connections += 1;
    entry.activeConnections += 1;
    if (clientIp) entry.lastClientIp = clientIp;
  }

  onConnectionClose({ target, reason = 'unknown', bytesToTarget = 0, bytesFromTarget = 0 } = {}) {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.closedConnections += 1;
    this.closeReasons[reason] = (this.closeReasons[reason] ?? 0) + 1;
    if (target) {
      const entry = this._target(target);
      entry.activeConnections = Math.max(0, entry.activeConnections - 1);
    }
  }

  onPacketToTarget(target, bytes) {
    this.packetsToTarget += 1;
    this.bytesToTarget += bytes;
    const entry = this._target(target);
    entry.packetsToTarget += 1;
    entry.bytesToTarget += bytes;
  }

  onPacketFromTarget(target, bytes) {
    this.packetsFromTarget += 1;
    this.bytesFromTarget += bytes;
    const entry = this._target(target);
    entry.packetsFromTarget += 1;
    entry.bytesFromTarget += bytes;
  }

  onDrop(reason) {
    this.droppedFrames += 1;
    this.dropsByReason[reason] = (this.dropsByReason[reason] ?? 0) + 1;
  }

  onAuthFailure(reason = 'unauthorized') {
    this.authFailures += 1;
    this.dropsByReason['auth_' + reason] = (this.dropsByReason['auth_' + reason] ?? 0) + 1;
  }

  onTargetRejected(reason = 'blocked') {
    this.targetRejections += 1;
    this.dropsByReason['target_' + reason] = (this.dropsByReason['target_' + reason] ?? 0) + 1;
  }

  snapshot(extra = {}) {
    const targets = [...this.targets.values()]
      .sort((a, b) => (b.packetsFromTarget + b.packetsToTarget) - (a.packetsFromTarget + a.packetsToTarget))
      .slice(0, 50)
      .map((entry) => ({ ...entry }));
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      activeConnections: this.activeConnections,
      totalConnections: this.totalConnections,
      closedConnections: this.closedConnections,
      bytesToTarget: this.bytesToTarget,
      bytesFromTarget: this.bytesFromTarget,
      packetsToTarget: this.packetsToTarget,
      packetsFromTarget: this.packetsFromTarget,
      droppedFrames: this.droppedFrames,
      dropsByReason: { ...this.dropsByReason },
      closeReasons: { ...this.closeReasons },
      authFailures: this.authFailures,
      targetRejections: this.targetRejections,
      targets,
      ...extra,
    };
  }
}
