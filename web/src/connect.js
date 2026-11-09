// 启动会话编排：所有外部接口可注入（createModule / loadScript / launch / resolveRuntime / showGame），
// 便于 Node 单测与 puppeteer E2E 替换断言。

import {
  MAX_CONNECT_URL_LENGTH,
  buildConnectArgs,
  buildUdpWsUrl,
  normalizeRelayBase,
  parseConnectUrl,
} from './relayurl.js';
import { buildModuleConfig, launchWithModule } from './launch.js';

export const SESSION_EVENT = {
  prepare: 'prepare',
  moduleCreated: 'module-created',
  scriptLoading: 'script-loading',
  runtimeInitializing: 'runtime-initializing',
  dependencies: 'dependencies',
  runtimeReady: 'runtime-ready',
  defaultRelay: 'default-relay',
  step: 'step',
  callMain: 'call-main',
  running: 'running',
  print: 'print',
  stderr: 'stderr',
  exit: 'exit',
  error: 'error',
};

// 移动端启动时追加的控制台命令（每个 argv 是一条完整命令，见 AGENTS 7.1）。
// cl_touch_controls 1：DDNet 内置触屏控制（默认只在 Android/iOS 原生构建里开启）
// cl_back_button 1：屏幕上的虚拟返回按钮（发送 ESC；默认只在 iOS 开启）
export const TOUCH_CONTROLS_ARG = 'cl_touch_controls 1';
export const TOUCH_BACK_BUTTON_ARG = 'cl_back_button 1';
// 桌面端显式关闭，避免同一浏览器 IndexedDB 里残留移动端保存的 cl_touch_controls 1。
export const TOUCH_CONTROLS_OFF_ARG = 'cl_touch_controls 0';
export const TOUCH_BACK_BUTTON_OFF_ARG = 'cl_back_button 0';

// 在 connect 命令前插入触屏相关命令：触屏设备显式开启，桌面端显式关闭。
// 显式关闭是必要的：DDNet 配置会保存在 IndexedDB，同一浏览器可能残留移动端的
// cl_touch_controls=1，桌面端不应因此显示触控控件。
export function buildLaunchArgs(baseArgs, options = {}) {
  const args = Array.isArray(baseArgs) ? baseArgs.map((arg) => String(arg)) : [];
  const touchControls = Boolean(options && options.touchControls === true);
  const backButton = Boolean(options && options.backButton === true);
  return [
    touchControls ? TOUCH_CONTROLS_ARG : TOUCH_CONTROLS_OFF_ARG,
    backButton ? TOUCH_BACK_BUTTON_ARG : TOUCH_BACK_BUTTON_OFF_ARG,
  ].concat(args);
}

// 直连：原样使用完整 ws(s) URL（?connect= 参数），不做规范化/改写
export function buildDirectConnectTarget(rawUrl) {
  const text = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!text) return { ok: false, error: '连接地址为空' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    return { ok: false, error: '不是有效的 URL：' + text };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'ws:' && scheme !== 'wss:') {
    return { ok: false, error: '直连地址必须是 ws:// 或 wss://' };
  }
  if (text.length > MAX_CONNECT_URL_LENGTH) {
    return {
      ok: false,
      url: text,
      error: '连接地址过长（' + text.length + ' 字符，上限 ' + MAX_CONNECT_URL_LENGTH + '）',
    };
  }
  // 契约：Module.arguments = ['connect <wsUrl>']（单个字符串）
  return { ok: true, url: text, args: buildConnectArgs(text), direct: true };
}

// 组装 "<relayBase>/udp/<host>:<port>[?token=...]" 与 connect 参数
export function buildConnectTarget(relay, target, options = {}) {
  if (!relay || !relay.url) return { ok: false, error: '没有可用的后端' };
  if (!target || !target.host || !target.port) return { ok: false, error: '目标服务器无效' };
  const built = buildUdpWsUrl({
    relayBase: relay.url,
    host: target.host,
    port: target.port,
    token: relay.token,
    protocol: options.protocol || relay.protocol,
  });
  if (!built.ok) return built;
  if (built.url.length > MAX_CONNECT_URL_LENGTH) {
    return {
      ok: false,
      url: built.url,
      error: '连接地址过长（' + built.url.length + ' 字符，上限 ' + MAX_CONNECT_URL_LENGTH + '），请缩短后端地址、路径或 token',
    };
  }
  return {
    ok: true,
    url: built.url,
    args: buildConnectArgs(built.url),
    relay,
    target,
    protocol: Number(options.protocol || relay.protocol) === 7 ? 7 : 6,
  };
}

// 直连 URL 里的 token（?connect=...&token=...）
export function readConnectToken(connectUrl) {
  const text = typeof connectUrl === 'string' ? connectUrl.trim() : '';
  if (!text) return '';
  try {
    return (new URL(text).searchParams.get('token') || '').trim();
  } catch (error) {
    return '';
  }
}

// C++ 侧 DDWeb_SetDefaultRelay(base, query) 的 query 参数（已 URL 编码，不含前导 ?）
export function buildDefaultRelayQuery(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  return token ? 'token=' + encodeURIComponent(token) : '';
}

// 游戏内服务器浏览器（DDNet master list）拿到的仍是纯 UDP 地址，
// 需要让客户端把 host:port 改写成 <relayBase>/udp/<host>:<port>?<query>&protocol=7。
// 纯函数，返回可直接交给 Module.ccall('DDWeb_SetDefaultRelay', ...) 的两个字符串参数。
export function buildDefaultRelayCall(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const relay = source.relay && typeof source.relay === 'object' ? source.relay : null;
  let relayBase = typeof source.relayBase === 'string' ? source.relayBase.trim() : '';
  if (!relayBase && relay && typeof relay.url === 'string') relayBase = relay.url.trim();
  let token = typeof source.token === 'string' ? source.token.trim() : '';
  if (!token && relay && typeof relay.token === 'string') token = relay.token.trim();
  if (!relayBase && source.connectUrl) {
    const parsed = parseConnectUrl(source.connectUrl);
    if (!parsed.ok) return { ok: false, error: parsed.error, relayBase: '', query: '', token: '' };
    relayBase = parsed.relayBase;
  }
  if (!token && source.connectUrl) token = readConnectToken(source.connectUrl);
  const normalized = normalizeRelayBase(relayBase);
  if (!normalized.ok) {
    return { ok: false, error: '中继地址无效：' + normalized.error, relayBase: '', query: '', token };
  }
  const query = buildDefaultRelayQuery({ token });
  return { ok: true, relayBase: normalized.url, query, token, args: [normalized.url, query] };
}

// 运行时 ready 之后、callMain 之前调用；Module.ccall 不存在（Node 假运行时）时安全跳过。
export function applyDefaultRelay(Module, call) {
  if (!call || call.ok !== true) {
    return { ok: false, called: false, relayBase: '', query: '', error: (call && call.error) || '没有可用的中继地址' };
  }
  if (!Module || typeof Module.ccall !== 'function') {
    return { ok: false, called: false, relayBase: call.relayBase, query: call.query, error: '运行时未提供 ccall' };
  }
  try {
    Module.ccall('DDWeb_SetDefaultRelay', null, ['string', 'string'], [call.relayBase, call.query]);
    return { ok: true, called: true, relayBase: call.relayBase, query: call.query, error: '' };
  } catch (error) {
    return {
      ok: false,
      called: false,
      relayBase: call.relayBase,
      query: call.query,
      error: (error && error.message) || String(error),
    };
  }
}

export async function startClientSession(options = {}) {
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const emit = (type, payload) => {
    try {
      onEvent({ type, at: Date.now(), payload: payload === undefined ? null : payload });
    } catch (error) {
      // 事件回调异常不应打断启动流程
    }
  };

  const built = options.connectUrl
    ? buildDirectConnectTarget(options.connectUrl)
    : buildConnectTarget(options.relay, options.target, { protocol: options.protocol });
  if (!built.ok) {
    const error = new Error(built.error);
    emit(SESSION_EVENT.error, error.message);
    throw error;
  }

  const touchControls = options.touchControls === true;
  const backButton = options.backButton === true;
  const launchArgs = buildLaunchArgs(
    Array.isArray(options.args) ? options.args : built.args,
    { touchControls, backButton }
  );
  const defaultRelay = options.defaultRelayCall !== undefined
    ? options.defaultRelayCall
    : buildDefaultRelayCall(
      options.connectUrl
        ? { connectUrl: options.connectUrl }
        : { relay: options.relay, relayBase: options.relay && options.relay.url, token: options.relay && options.relay.token }
    );

  const assetUrls = options.assetUrls || {};
  const createModule = typeof options.createModule === 'function' ? options.createModule : buildModuleConfig;
  const assignModule = typeof options.assignModule === 'function'
    ? options.assignModule
    : (Module) => {
      globalThis.Module = Module;
    };
  const loadScript = options.loadScript;
  if (typeof loadScript !== 'function') throw new Error('缺少 loadScript 实现');
  const resolveRuntime = typeof options.resolveRuntime === 'function'
    ? options.resolveRuntime
    : () => ({ FS: globalThis.FS, IDBFS: globalThis.IDBFS });
  const launch = typeof options.launch === 'function' ? options.launch : launchWithModule;
  const audioUnlock = typeof options.audioUnlock === 'function' ? options.audioUnlock : async () => true;
  const showGame = typeof options.showGame === 'function' ? options.showGame : () => {};
  const readyTimeoutMs = Number.isFinite(options.readyTimeoutMs) ? options.readyTimeoutMs : 180000;
  const locateFile = typeof options.locateFile === 'function'
    ? options.locateFile
    : (path) => assetUrls[path] || path;
  const mainScriptUrlOrBlob = options.mainScriptUrlOrBlob || assetUrls['DDNet.js'] || '';

  const runtime = {
    Module: null,
    args: launchArgs,
    url: built.url,
    relay: options.relay || built.relay || null,
    target: options.target || built.target || null,
    assetUrls,
    homePath: options.homePath || null,
    touchControls,
    backButton,
    defaultRelay,
    phase: 'prepare',
    exitStatus: null,
    resolveReady: null,
    rejectReady: null,
    ready: null,
    readyTimer: null,
  };

  runtime.ready = new Promise((resolve, reject) => {
    runtime.resolveReady = resolve;
    runtime.rejectReady = reject;
  });

  emit(SESSION_EVENT.prepare, { url: built.url, args: launchArgs, touchControls, backButton });

  const Module = createModule({
    canvas: options.canvas,
    locateFile,
    mainScriptUrlOrBlob,
    hooks: {
      onPrint: (text) => emit(SESSION_EVENT.print, String(text)),
      onError: (text) => emit(SESSION_EVENT.stderr, String(text)),
      onDependencies: (left) => emit(SESSION_EVENT.dependencies, Number(left) || 0),
      onRuntimeInitialized: () => {
        if (runtime.phase !== 'exit') runtime.resolveReady();
      },
      onExit: (status) => {
        runtime.exitStatus = status;
        runtime.phase = 'exit';
        emit(SESSION_EVENT.exit, status);
      },
    },
  });

  runtime.Module = Module;
  assignModule(Module);
  // Read by websockets_emscripten.cpp's JS transport when it creates the
  // RTCPeerConnection (game transport and latency probes share the same list).
  try {
    globalThis.DDWebIceServers = Array.isArray(options.iceServers)
      ? options.iceServers.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 8)
      : [];
  } catch (error) {
    // 忽略：没有 ICE 服务器时仍可用 host candidates
  }
  emit(SESSION_EVENT.moduleCreated, { arguments: Module.arguments });
  if (typeof options.onRuntime === 'function') {
    try {
      options.onRuntime(runtime);
    } catch (error) {
      // 忽略
    }
  }

  try {
    await audioUnlock();

    runtime.phase = 'script-loading';
    emit(SESSION_EVENT.scriptLoading);
    await loadScript(assetUrls['DDNet.js'] || options.jsUrl || 'DDNet.js');

    runtime.phase = 'initializing';
    emit(SESSION_EVENT.runtimeInitializing);
    runtime.readyTimer = setTimeout(() => {
      if (runtime.phase !== 'exit') {
        runtime.rejectReady(new Error('Emscripten 运行时初始化超时（' + Math.round(readyTimeoutMs / 1000) + ' 秒）'));
      }
    }, readyTimeoutMs);
    await runtime.ready;
    clearTimeout(runtime.readyTimer);

    runtime.phase = 'launching';
    emit(SESSION_EVENT.runtimeReady);

    // 运行时已就绪、callMain 之前：让游戏内服务器浏览器（纯 UDP 地址）改走中继。
    const relayApplied = applyDefaultRelay(Module, defaultRelay);
    runtime.defaultRelayApplied = relayApplied;
    emit(SESSION_EVENT.defaultRelay, relayApplied);

    showGame();
    const resolved = resolveRuntime() || {};
    // 启动契约：Module.arguments = ['connect <wsUrl>']，移动端前面允许追加触屏命令
    Module.arguments = launchArgs.slice();
    emit(SESSION_EVENT.callMain, { url: built.url, args: launchArgs });

    await launch({
      Module,
      FS: resolved.FS,
      IDBFS: resolved.IDBFS,
      homePath: runtime.homePath,
      args: launchArgs,
      onStep: (step) => emit(SESSION_EVENT.step, step),
      callMain: options.callMain,
    });

    if (runtime.phase !== 'exit') {
      runtime.phase = 'running';
      emit(SESSION_EVENT.running);
    }
    return runtime;
  } catch (error) {
    clearTimeout(runtime.readyTimer);
    runtime.phase = 'error';
    emit(SESSION_EVENT.error, (error && error.message) || String(error));
    throw error;
  }
}
