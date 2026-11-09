// 启动自检（纯函数：输入环境快照，输出带中文说明的检查项）

export const CHECK_STATUS = { ok: 'ok', warn: 'warn', fail: 'fail' };

export function collectSelfChecks(env = {}) {
  const checks = [];

  const secure = env.isSecureContext === true;
  checks.push({
    id: 'secure-context',
    label: 'HTTPS 安全上下文',
    status: secure ? 'ok' : 'warn',
    detail: secure
      ? '当前页面处于安全上下文，可以使用 SharedArrayBuffer。'
      : '当前页面不是安全上下文（需要 HTTPS 或 http://localhost）。浏览器会禁用 SharedArrayBuffer，客户端线程池可能无法启动。',
  });

  const isolated = env.crossOriginIsolated === true;
  checks.push({
    id: 'cross-origin-isolated',
    label: '跨源隔离 (COOP/COEP)',
    status: isolated ? 'ok' : 'fail',
    detail: isolated
      ? 'crossOriginIsolated = true，SharedArrayBuffer 可用。'
      : 'crossOriginIsolated = false。需要响应头 Cross-Origin-Opener-Policy: same-origin 与 Cross-Origin-Embedder-Policy: require-corp。本地开发请用 node web/serve.mjs 启动；线上需在反向代理补上这两个头。',
  });

  const hasSab = env.hasSharedArrayBuffer === true;
  checks.push({
    id: 'shared-array-buffer',
    label: 'SharedArrayBuffer',
    status: hasSab ? 'ok' : 'fail',
    detail: hasSab
      ? 'SharedArrayBuffer 可用。'
      : 'SharedArrayBuffer 不可用，DDNet 的 pthread 线程池无法工作，客户端大概率会启动失败。',
  });

  if (env.webgl2 === true) {
    checks.push({ id: 'webgl2', label: 'WebGL2', status: 'ok', detail: 'WebGL2 上下文可用。' });
  } else if (env.webgl2 === false) {
    checks.push({
      id: 'webgl2',
      label: 'WebGL2',
      status: 'fail',
      detail: '无法创建 WebGL2 上下文，客户端无法渲染画面。请更新浏览器或开启硬件加速。',
    });
  } else {
    checks.push({ id: 'webgl2', label: 'WebGL2', status: 'warn', detail: '无法检测 WebGL2 支持情况。' });
  }

  const storageOk = env.storageOk !== false;
  checks.push({
    id: 'local-storage',
    label: 'localStorage 持久化',
    status: storageOk ? 'ok' : 'warn',
    detail: storageOk
      ? '中继与最近连接配置可以持久化到浏览器本地。'
      : 'localStorage 不可用（' + (env.storageReason || '未知原因') + '），配置只在本次会话内有效。',
  });

  return checks;
}

export function summarizeChecks(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, total: 0, blocking: false };
  for (const check of checks || []) {
    if (summary[check.status] == null) summary[check.status] = 0;
    summary[check.status] += 1;
    summary.total += 1;
  }
  summary.blocking = summary.fail > 0;
  return summary;
}

export function checkStatusLabel(status) {
  if (status === 'ok') return '通过';
  if (status === 'warn') return '警告';
  return '失败';
}
