// 通用格式化工具（纯函数，可在 Node 中直接测试）

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value = value / 1024;
    i += 1;
  }
  return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
}

export function formatRtt(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 10 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms';
}

export function formatAgo(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return '从未';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s';
  return formatBytes(bytesPerSecond) + '/s';
}

export function truncate(text, max = 80) {
  const value = String(text == null ? '' : text);
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

export function pluralCount(count, unit) {
  return count + ' ' + unit;
}
