// DDNet Web 前端控制器：下载缓存 → 后端选择 → 载入 → 服务器列表 → 游戏
import { byId, clear, el, setHidden, setText, showToast } from './src/dom.js';
import { createStorage } from './src/storage.js';
import { formatAgo, formatBytes, formatRtt, formatSpeed } from './src/format.js';
import { parseTarget } from './src/targets.js';
import {
  buildInfoHttpUrl,
  buildServersHttpUrl,
  normalizeRelayBase,
  parseConnectUrl,
  parseShareParams,
  relayAddressLabel,
} from './src/relayurl.js';
import { fetchServers } from './src/probe.js';
import {
  DEFAULT_MASTER_FILTERS,
  fetchMasterServers,
  filterOptions,
  filterServers,
  normalizeRelayServers,
  regionLabel,
} from './src/master.js';
import {
  LATENCY_METHOD_LABEL,
  fetchRelayInfo,
  measureRelayLatency,
  rankRelayEntries,
} from './src/latency.js';
import {
  BIG_FILES,
  createAssetManager,
} from './src/assets.js';
import {
  RelayStore,
  clearHiddenRelayUrls,
  defaultRelaySeeds,
  hideRelayUrl,
  defaultRelayMasterUrl,
  loadDiscovery,
  loadHiddenRelayUrls,
  loadMasterRelays,
  loadLastRelayId,
  loadNickname,
  saveLastRelayId,
  saveNickname,
  unhideRelayUrl,
} from './src/relays.js';
import { createTour, markTourDone, readTourDone } from './src/tour.js';
import { HUD_SHORTCUT_HINT, HUD_SHORTCUT_LABEL, isHudToggleShortcut } from './src/shortcuts.js';
import { applyDeviceAttributes, detectDevice, detectDeviceFromWindow, requestImmersive } from './src/device.js';
import { collectSelfChecks, checkStatusLabel, summarizeChecks } from './src/diagnostics.js';
import { HOME_PATH, buildModuleConfig, launchWithModule, parseAnsiColorRgb } from './src/launch.js';
import {
  buildConnectTarget,
  buildDefaultRelayCall,
  buildDirectConnectTarget,
  buildLaunchArgs,
  startClientSession,
} from './src/connect.js';
import { installWebSocketStats, isRelaySocketUrl } from './src/wsstats.js';
import { installAudioUnlock } from './src/audio.js';
import { installImeBridge } from './src/ime.js';
import {
  applyTheme,
  loadTheme,
  nextTheme,
  normalizeTheme,
  saveTheme,
  themeToggleIcon,
  themeToggleLabel,
} from './src/theme.js';

const PAGE_SIZE = 20;
const PROTOCOL_KEY = 'ddweb.protocol.v1';
const TOUCH_GUIDE_DISMISSED_KEY = 'ddweb.touch-guide-dismissed.v1';
const TOUCH_HINT_DISMISSED_KEY = 'ddweb.touch-hint-dismissed.v1';
const RUNTIME_READY_TIMEOUT_MS = 180000;

// 移动端触屏说明（DDNet 内置触屏控制的默认布局）
const TOUCH_GUIDE_ITEMS = [
  ['触屏控制', '已自动开启 DDNet 内置触屏控制（cl_touch_controls 1），无需手动设置；建议横屏游玩。'],
  ['左侧', '按住「←」「→」移动；拖动左侧区域也能控制移动方向。'],
  ['右侧圆形摇杆', '拖动瞄准；按住 = 开火（切换动作后为钩子）。'],
  ['跳跃 / 钩子 / 开火', '屏幕上的跳跃按钮与动作按钮直接触发。'],
  ['武器按钮', '屏幕上方「上一件 / 下一件武器」切换武器。'],
  ['左上角「＋」按钮', '展开计分板、聊天、投票、表情等附加按钮。'],
  ['屏幕上的返回按钮', '相当于 Esc，用来打开游戏菜单 / 退出；也可以使用浏览器返回键离开页面。'],
];

const REF_IDS = {
  statusPills: 'status-pills',
  btnAdvanced: 'btn-advanced',
  btnTheme: 'btn-theme',
  themeIcon: 'theme-icon',
  themeLabel: 'theme-label',
  confirmDialog: 'confirm-dialog',
  confirmTitle: 'confirm-title',
  confirmText: 'confirm-text',
  btnConfirmOk: 'btn-confirm-ok',
  btnConfirmCancel: 'btn-confirm-cancel',
  viewRelays: 'view-relays',
  viewServers: 'view-servers',
  directBanner: 'direct-banner',
  directBannerText: 'direct-banner-text',
  btnDirectEnter: 'btn-direct-enter',
  btnDirectDismiss: 'btn-direct-dismiss',
  relaySummary: 'relay-summary',
  btnRefreshLatency: 'btn-refresh-latency',
  relayGrid: 'relay-grid',
  btnAddRelay: 'btn-add-relay',
  btnRestoreRelays: 'btn-restore-relays',
  cacheBadge: 'cache-badge',
  btnBackRelays: 'btn-back-relays',
  serversTitle: 'servers-title',
  serversSubtitle: 'servers-subtitle',
  serversLatency: 'servers-latency',
  serversNotice: 'servers-notice',
  serversNoticeText: 'servers-notice-text',
  serversError: 'servers-error',
  serversErrorTitle: 'servers-error-title',
  serversErrorHint: 'servers-error-hint',
  serversErrorText: 'servers-error-text',
  btnErrorCopy: 'btn-error-copy',
  btnErrorRetry: 'btn-error-retry',
  serversContent: 'servers-content',
  serversCount: 'servers-count',
  serverFilterProtocol: 'server-filter-protocol',
  serverFilterType: 'server-filter-type',
  serverFilterRegion: 'server-filter-region',
  serverFilterSort: 'server-filter-sort',
  serverFilterHideFull: 'server-filter-hide-full',
  serverFilterHideLocked: 'server-filter-hide-locked',
  btnProtocol6: 'btn-protocol-6',
  btnProtocol7: 'btn-protocol-7',
  serverSearch: 'server-search',
  btnRefreshServers: 'btn-refresh-servers',
  serverList: 'server-list',
  serverPager: 'server-pager',
  manualTarget: 'manual-target',
  btnManualConnect: 'btn-manual-connect',
  canvas: 'canvas',
  downloadModal: 'download-modal',
  downloadFiles: 'download-files',
  downloadTotal: 'download-total',
  downloadNote: 'download-note',
  btnDownloadLater: 'btn-download-later',
  btnDownloadStart: 'btn-download-start',
  loadingView: 'loading-view',
  btnLoadingClose: 'btn-loading-close',
  loadingTitle: 'loading-title',
  loadingRelay: 'loading-relay',
  loadingProgress: 'loading-progress',
  loadingNote: 'loading-note',
  btnLoadingCancel: 'btn-loading-cancel',
  widget: 'download-widget',
  widgetTitle: 'widget-title',
  widgetOverall: 'widget-overall',
  btnWidgetMin: 'btn-widget-min',
  widgetProgress: 'widget-progress',
  widgetSpeed: 'widget-speed',
  btnWidgetRetry: 'btn-widget-retry',
  hudPanel: 'hud-panel',
  btnHudClose: 'btn-hud-close',
  hudRelayName: 'hud-relay-name',
  hudRelayAddress: 'hud-relay-address',
  hudLatency: 'hud-latency',
  hudLatencyMethod: 'hud-latency-method',
  hudTarget: 'hud-target',
  hudProtocol: 'hud-protocol',
  hudTransport: 'hud-transport',
  hudTraffic: 'hud-traffic',
  btnHudReconnect: 'btn-hud-reconnect',
  hudHint: 'hud-hint',
  touchGuide: 'touch-guide',
  touchGuideList: 'touch-guide-list',
  btnTouchGuideClose: 'btn-touch-guide-close',
  btnTouchFullscreen: 'btn-touch-fullscreen',
  touchHint: 'touch-hint',
  btnTouchHintClose: 'btn-touch-hint-close',
  btnTouchHintFullscreen: 'btn-touch-hint-fullscreen',
  btnTouchHintHud: 'btn-touch-hint-hud',
  spotlight: 'spotlight',
  spotlightHole: 'spotlight-hole',
  spotlightCard: 'spotlight-card',
  spotlightStep: 'spotlight-step',
  spotlightTitle: 'spotlight-title',
  spotlightText: 'spotlight-text',
  btnSpotlightSkip: 'btn-spotlight-skip',
  btnSpotlightNext: 'btn-spotlight-next',
  gameExit: 'game-exit',
  exitTitle: 'exit-title',
  exitText: 'exit-text',
  btnExitBack: 'btn-exit-back',
  btnExitReload: 'btn-exit-reload',
  relayDialog: 'relay-dialog',
  relayForm: 'relay-form',
  relayDialogTitle: 'relay-dialog-title',
  relayUrl: 'relay-url',
  relayName: 'relay-name',
  relayToken: 'relay-token',
  relayFormError: 'relay-form-error',
  btnRelayDelete: 'btn-relay-delete',
  btnRelayCancel: 'btn-relay-cancel',
  btnRelaySave: 'btn-relay-save',
  advancedDialog: 'advanced-dialog',
  nicknameInput: 'nickname-input',
  checkList: 'check-list',
  btnRecheck: 'btn-recheck',
  cacheInfo: 'cache-info',
  btnClearCache: 'btn-clear-cache',
  btnRedownload: 'btn-redownload',
  btnAdvancedClose: 'btn-advanced-close',
  toastHost: 'toast-host',
};

const R = {};
const S = {
  storageCheck: null,
  storage: null,
  relayStore: null,
  hiddenRelays: [],
  assets: null,
  wsStats: null,
  audio: null,
  ime: null,
  fetchImpl: null,
  measureLatency: null,
  launchSession: null,
  params: null,
  direct: null,
  view: 'boot',
  phase: 'boot',
  checks: [],
  entries: [],
  latency: new Map(),
  info: new Map(),
  selectedRelayId: '',
  servers: { status: 'idle', relayId: '', list: [], error: '', query: '', page: 0, at: 0, warnings: [], source: '', filters: { ...DEFAULT_MASTER_FILTERS } },
  download: {
    confirmed: false,
    started: false,
    done: false,
    promise: null,
    minimized: false,
    modalDismissed: false,
    hideScheduled: false,
  },
  loading: { open: false, relayId: '', closed: false, stage: 'download', note: '' },
  protocol: 6,
  theme: 'light',
  nickname: '',
  device: null,
  immersive: null,
  touch: { guideDismissed: false, hintDismissed: false },
  mouse: { clientX: 0, clientY: 0, has: false, pending: false },
  menuTimer: null,
  confirmResolve: null,
  hud: { visible: false, timer: null, busy: false, relay: null, target: null, serverName: '' },
  spot: { tour: null, started: false },
  runtime: null,
  runtimeExited: false,
  measuring: false,
  logLines: [],
  toastCount: 0,
};

// ---------------------------------------------------------------- 入口

export async function bootstrap(overrides = {}) {
  bindRefs();
  // 设备检测：<html data-device> + body.is-mobile / is-tablet / is-desktop 驱动移动端样式
  S.device = overrides.device || detectDeviceFromWindow(typeof window !== 'undefined' ? window : null);
  applyDeviceAttributes(document, S.device);
  S.storageCheck = createStorage();
  S.storage = S.storageCheck.storage;
  S.relayStore = new RelayStore({ storage: S.storage }).load();
  S.hiddenRelays = loadHiddenRelayUrls(S.storage);
  S.nickname = loadNickname(S.storage);
  S.touch.guideDismissed = loadFlag(S.storage, TOUCH_GUIDE_DISMISSED_KEY);
  S.touch.hintDismissed = loadFlag(S.storage, TOUCH_HINT_DISMISSED_KEY);
  S.protocol = loadProtocol();
  S.theme = applyTheme(document.documentElement, loadTheme(S.storage));
  S.fetchImpl = overrides.fetchImpl || globalThis.fetch;
  S.measureLatency = overrides.measureLatency || ((relay, options = {}) => measureRelayLatency(relay, Object.assign({ fetchImpl: S.fetchImpl }, options)));
  S.launchSession = overrides.launchSession || startClientSession;
  S.assets = overrides.assets || createAssetManager({
    baseUrl: new URL('./', location.href).href,
    fetchImpl: S.fetchImpl,
    cacheStorage: overrides.cacheStorage !== undefined ? overrides.cacheStorage : globalThis.caches,
    cryptoImpl: overrides.cryptoImpl || globalThis.crypto,
    createObjectURL: overrides.createObjectURL,
    onUpdate: handleAssetUpdate,
  });
  S.wsStats = installWebSocketStats();
  S.audio = installAudioUnlock();
  S.ime = installImeBridge({
    getModule: () => (S.runtime && S.runtime.Module) || globalThis.Module,
    log,
    notify: (message, kind) => toast(message, kind),
  });
  globalThis.ddwebIme = S.ime;
  S.params = parseShareParams(location.search);
  S.spot.tour = createTour([
    {
      id: 'hud',
      target: 'hud-panel',
      title: '这里是后端连接信息',
      text: '当前后端、实测延迟、服务器和会话流量都会显示在这里。按 ' + HUD_SHORTCUT_HINT + ' 可以随时显示或隐藏这个面板。',
    },
  ]);

  bindEvents();
  updateThemeButton();
  renderBootSkeleton();
  renderProtocolButtons();
  renderTouchGuide();

  await S.assets.init();
  await ensureRelays();
  selectInitialRelay();
  prepareDirect();
  renderRelayGrid();
  renderDownloadModal();
  updateCacheBadge();
  setView('relays');
  await refreshEnvironment();

  if (!S.assets.isComplete() && !S.params.autostart) {
    setHidden(R.downloadModal, false);
  }

  startLatencyMeasurement();
  exposeDebugApi();

  if (S.params.autostart) {
    void runAutostart();
  }
}

function bindRefs() {
  for (const key of Object.keys(REF_IDS)) {
    R[key] = byId(REF_IDS[key]);
  }
  R.spotlightShades = R.spotlight ? {
    top: R.spotlight.querySelector('[data-shade="top"]'),
    bottom: R.spotlight.querySelector('[data-shade="bottom"]'),
    left: R.spotlight.querySelector('[data-shade="left"]'),
    right: R.spotlight.querySelector('[data-shade="right"]'),
  } : null;
}

function bindEvents() {
  R.btnAdvanced.addEventListener('click', () => openAdvanced());
  R.btnTheme.addEventListener('click', () => setTheme(nextTheme(S.theme)));
  R.btnConfirmCancel.addEventListener('click', () => finishConfirm(false));
  R.btnConfirmOk.addEventListener('click', () => finishConfirm(true));
  R.confirmDialog.addEventListener('close', () => finishConfirm(false));
  R.btnRefreshLatency.addEventListener('click', () => measureAllLatency({ force: true }));
  R.btnAddRelay.addEventListener('click', () => openRelayDialog(''));
  R.btnRestoreRelays.addEventListener('click', () => restoreDefaultRelays());
  R.btnBackRelays.addEventListener('click', () => {
    setView('relays');
    renderRelayGrid();
  });
  R.btnProtocol6.addEventListener('click', () => setProtocol(6));
  R.btnProtocol7.addEventListener('click', () => setProtocol(7));
  R.serverSearch.addEventListener('input', () => {
    S.servers.query = R.serverSearch.value;
    S.servers.page = 0;
    renderServers();
  });
  R.btnRefreshServers.addEventListener('click', () => {
    const relay = currentServerRelay();
    if (relay) connectToRelay(relay);
  });
  const onFilterChange = (key, read) => {
    const control = R[key];
    if (!control) return;
    control.addEventListener('change', () => {
      if (!S.servers.filters) S.servers.filters = { ...DEFAULT_MASTER_FILTERS };
      S.servers.filters[read.key] = read.value(control);
      S.servers.page = 0;
      renderServers();
    });
  };
  onFilterChange('serverFilterProtocol', { key: 'protocol', value: (control) => control.value });
  onFilterChange('serverFilterType', { key: 'type', value: (control) => control.value });
  onFilterChange('serverFilterRegion', { key: 'region', value: (control) => control.value });
  onFilterChange('serverFilterSort', { key: 'sort', value: (control) => control.value });
  onFilterChange('serverFilterHideFull', { key: 'hideFull', value: (control) => control.checked });
  onFilterChange('serverFilterHideLocked', { key: 'hideLocked', value: (control) => control.checked });
  R.btnManualConnect.addEventListener('click', () => {
    const relay = currentServerRelay();
    if (!relay) {
      toast('请先选择一个后端', 'warn');
      return;
    }
    enterGame(relay, R.manualTarget.value);
  });
  R.manualTarget.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const relay = currentServerRelay();
      if (relay) enterGame(relay, R.manualTarget.value);
    }
  });
  R.btnDownloadStart.addEventListener('click', () => {
    setHidden(R.downloadModal, true);
    startDownload();
  });
  R.btnDownloadLater.addEventListener('click', () => {
    S.download.modalDismissed = true;
    setHidden(R.downloadModal, true);
    toast('已跳过下载；选择后端时会提示载入资源', 'info');
  });
  R.btnLoadingClose.addEventListener('click', () => closeLoadingView());
  R.btnLoadingCancel.addEventListener('click', () => cancelDownload());
  R.btnWidgetMin.addEventListener('click', () => {
    S.download.minimized = !S.download.minimized;
    renderWidget();
  });
  R.btnWidgetRetry.addEventListener('click', () => retryDownload());
  R.btnHudClose.addEventListener('click', () => toggleHud(false));
  R.btnHudReconnect.addEventListener('click', () => disconnectClient());
  R.btnTouchGuideClose.addEventListener('click', () => {
    S.touch.guideDismissed = true;
    saveFlag(S.storage, TOUCH_GUIDE_DISMISSED_KEY, true);
    updateTouchUi();
  });
  R.btnTouchFullscreen.addEventListener('click', () => enterFullscreenMode());
  if (R.btnTouchHintHud) R.btnTouchHintHud.addEventListener('click', () => toggleHud());
  R.btnTouchHintClose.addEventListener('click', () => {
    S.touch.hintDismissed = true;
    saveFlag(S.storage, TOUCH_HINT_DISMISSED_KEY, true);
    updateTouchUi();
  });
  R.btnTouchHintFullscreen.addEventListener('click', () => enterFullscreenMode());
  R.btnSpotlightNext.addEventListener('click', () => advanceSpotlight());
  R.btnSpotlightSkip.addEventListener('click', () => finishSpotlight());
  R.btnExitBack.addEventListener('click', () => {
    hideGameExit();
    setView('servers');
    renderServers();
    showServersNotice('客户端已退出：Emscripten 运行时不能在同一页面重启，请重新加载页面后再进入游戏。');
  });
  R.btnExitReload.addEventListener('click', () => location.reload());
  R.btnErrorCopy.addEventListener('click', () => copyText(S.servers.error || '', '错误信息已复制'));
  R.btnErrorRetry.addEventListener('click', () => {
    const relay = S.relayStore.get(S.servers.relayId) || currentServerRelay();
    if (relay) connectToRelay(relay);
  });
  R.btnDirectEnter.addEventListener('click', () => {
    if (S.direct) startDirectSession(S.direct.url);
  });
  R.btnDirectDismiss.addEventListener('click', () => {
    S.direct = null;
    setHidden(R.directBanner, true);
  });
  R.relayForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveRelayDialog();
  });
  R.btnRelayCancel.addEventListener('click', () => R.relayDialog.close());
  R.btnRelayDelete.addEventListener('click', () => {
    const id = S.dialogRelayId || '';
    R.relayDialog.close();
    if (id) deleteRelay(id);
  });
  R.btnAdvancedClose.addEventListener('click', () => R.advancedDialog.close());
  R.btnRecheck.addEventListener('click', () => refreshEnvironment());
  R.btnClearCache.addEventListener('click', async () => {
    await S.assets.clear();
    S.download.promise = null;
    S.download.started = false;
    S.download.done = false;
    S.download.hideScheduled = false;
    setHidden(R.widget, true);
    renderDownloadModal();
    updateCacheBadge();
    toast('已清除本地资源缓存', 'ok');
  });
  R.btnRedownload.addEventListener('click', async () => {
    await S.assets.clear();
    S.download.promise = null;
    S.download.started = false;
    S.download.done = false;
    S.download.hideScheduled = false;
    startDownload();
    toast('开始重新下载客户端资源', 'info');
  });
  R.nicknameInput.addEventListener('input', () => {
    S.nickname = R.nicknameInput.value;
    saveNickname(S.storage, S.nickname);
  });
  // 全局快捷键：在 document 捕获阶段监听（指针锁定 / 输入框内同样生效）。
  // 只有匹配 Ctrl+` 时才 preventDefault，其余按键原样交给页面与 wasm。
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === R.canvas;
    S.pointerLocked = locked;
    document.body.classList.toggle('is-pointer-locked', locked);
    if (S.view === 'game') {
      if (S.device && S.device.kind === 'desktop') document.body.classList.toggle('is-menu-open', !locked);
      // ESC 会由浏览器强制解除 Pointer Lock；把键盘焦点留在画布上，
      // 避免焦点落到 HUD/按钮后键盘输入与渲染节奏异常。
      try { R.canvas.focus({ preventScroll: true }); } catch (error) { /* 忽略 */ }
      setWasmAbsoluteMouse(!locked);
      if (!locked) setTimeout(() => scheduleUiMouseSync(), 30);
      log(locked ? '鼠标已捕获（游戏内光标由 DDNet 绘制）' : '鼠标已释放（ESC 菜单打开，游戏内光标接管）');
    }
  });
  document.addEventListener('pointerlockerror', () => {
    log('浏览器拒绝捕获鼠标（需要用户点击画布）', 'warn');
  });
  window.addEventListener('keydown', (event) => {
    // 按住 Tab/ESC 时浏览器会以系统重复率不断发 keydown。DDNet 的
    // +scoreboard 和菜单都不需要 repeat；重复事件还会让网页侧的
    // is-scoreboard-open/is-menu-open 反复触发布局。直接截断 repeat。
    if (S.view === 'game' && event.repeat && (event.key === 'Tab' || event.key === 'Escape')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    // 游戏中 Tab 是 DDNet 的计分板，不能被浏览器拿去做焦点切换，否则
    // canvas 失焦后键盘/渲染都可能掉到后台节奏。
    if (S.view === 'game' && event.key === 'Tab' && document.activeElement && document.activeElement.id !== 'ddweb-ime-input') {
      event.preventDefault();
      document.body.classList.add('is-scoreboard-open');
    }
    if (!isHudToggleShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (S.view === 'game') toggleHud();
  }, true);
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Tab') document.body.classList.remove('is-scoreboard-open');
  }, true);
  window.addEventListener('mousemove', (event) => {
    S.mouse.clientX = event.clientX;
    S.mouse.clientY = event.clientY;
    S.mouse.has = true;
    if (S.view === 'game' && document.pointerLockElement !== R.canvas) {
      scheduleUiMouseSync();
    }
  }, true);
  R.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  // 浏览器在 ESC 时会强制释放 Pointer Lock（无法拦截）。游戏内再次点击画布时恢复捕获；
  // 菜单/游戏内光标由 DDNet 自己绘制，因此不会出现浏览器光标。
  R.canvas.addEventListener('click', () => {
    if (S.view !== 'game' || document.pointerLockElement === R.canvas) return;
    try {
      const request = R.canvas.requestPointerLock && R.canvas.requestPointerLock();
      if (request && typeof request.catch === 'function') request.catch(() => {});
    } catch (error) {
      // 浏览器可能要求用户手势；忽略，下次点击再试
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    log('未处理的 Promise 异常：' + ((reason && (reason.stack || reason.message)) || String(reason)), 'err');
  });
  window.addEventListener('beforeunload', (event) => {
    if (S.phase === 'running') {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

// ---------------------------------------------------------------- 环境自检

async function refreshEnvironment() {
  S.checks = collectSelfChecks({
    isSecureContext: window.isSecureContext === true,
    crossOriginIsolated: window.crossOriginIsolated === true,
    hasSharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    webgl2: detectWebGL2(),
    storageOk: S.storageCheck.ok,
    storageReason: S.storageCheck.reason,
  });
  renderPills();
  renderChecks();
  updateCacheBadge();
}

function detectWebGL2() {
  try {
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    return Boolean(canvas.getContext('webgl2'));
  } catch (error) {
    return false;
  }
}

function renderPills() {
  const status = (id) => {
    const check = S.checks.find((item) => item.id === id);
    return check ? check.status : 'warn';
  };
  clear(R.statusPills);
  R.statusPills.appendChild(pill('安全上下文', status('secure-context')));
  R.statusPills.appendChild(pill('跨源隔离', status('cross-origin-isolated')));
  R.statusPills.appendChild(pill('SharedArrayBuffer', status('shared-array-buffer')));
  const snap = S.assets ? S.assets.snapshot() : null;
  R.statusPills.appendChild(pill('资源缓存', snap && snap.complete ? 'ok' : 'warn'));
}

function pill(label, status) {
  const normalized = status === 'ok' || status === 'warn' || status === 'fail' ? status : 'warn';
  return el('span', { class: 'pill is-' + normalized },
    el('span', { class: 'pill-dot' }),
    el('span', { text: label })
  );
}

function renderChecks() {
  if (!R.checkList) return;
  clear(R.checkList);
  for (const check of S.checks) {
    R.checkList.appendChild(el('li', {},
      el('span', { class: 'check-badge is-' + check.status, text: checkStatusLabel(check.status) }),
      el('div', {},
        el('div', { text: check.label }),
        el('div', { class: 'check-detail', text: check.detail })
      )
    ));
  }
}

function updateCacheBadge() {
  if (!R.cacheBadge || !S.assets) return;
  const snap = S.assets.snapshot();
  const loaded = snap.complete;
  setHidden(R.cacheBadge, false);
  R.cacheBadge.className = 'cache-badge' + (loaded ? ' is-ok' : '');
  setText(R.cacheBadge, loaded ? '客户端资源已缓存 · ' + formatBytes(snap.totalBytes) : '客户端资源未缓存');
  if (R.cacheInfo) {
    const parts = [];
    for (const item of snap.items) {
      parts.push(item.name + '：' + (item.state === 'cached' ? '已缓存' : item.state === 'error' ? '错误' : '未下载'));
    }
    parts.push('Cache Storage：' + (snap.cacheAvailable ? '可用（' + snap.cacheName + '）' : '不可用' + (snap.cacheError ? '（' + snap.cacheError + '）' : '')));
    if (snap.manifestWarning) parts.push(snap.manifestWarning);
    setText(R.cacheInfo, parts.join('；'));
  }
  renderPills();
}

// ---------------------------------------------------------------- 参数 / 后端列表

function resolveRelayParam(params) {
  if (!params) return null;
  if (params.relayParam) {
    const stored = S.relayStore.get(params.relayParam);
    if (stored) return stored;
    const norm = normalizeRelayBase(params.relayParam);
    if (norm.ok) return { name: relayAddressLabel(norm.base), url: norm.base, token: '', source: 'url' };
  }
  if (params.relayUrl) {
    const norm = normalizeRelayBase(params.relayUrl);
    if (norm.ok) return { name: relayAddressLabel(norm.base), url: norm.base, token: '', source: 'url' };
  }
  return null;
}

async function ensureRelays() {
  const hidden = new Set(S.hiddenRelays);
  const hiddenNormalized = new Set();
  for (const url of hidden) {
    const norm = normalizeRelayBase(url);
    if (norm.ok) hiddenNormalized.add(norm.base);
  }
  for (const seed of defaultRelaySeeds(window)) {
    const norm = normalizeRelayBase(seed.url);
    if (norm.ok && hiddenNormalized.has(norm.base)) continue;
    if (!S.relayStore.findByUrl(seed.url)) {
      S.relayStore.add(Object.assign({ source: 'seed' }, seed));
    }
  }
  const master = await loadMasterRelays(S.fetchImpl, defaultRelayMasterUrl(window));
  if (master.ok) {
    // Master 是节点列表的权威来源：同步移除已经不在列表里的旧 master 节点。
    const masterURLs = new Set(master.relays.map((relay) => relay.url));
    for (const relay of S.relayStore.list()) {
      if (relay.source === 'master' && !masterURLs.has(relay.url)) {
        S.relayStore.remove(relay.id);
      }
    }
    for (const relay of master.relays) {
      if (!S.relayStore.findByUrl(relay.url)) S.relayStore.add(relay);
    }
  } else {
    log('Master 节点列表获取失败：' + master.error, 'warn');
  }
  const discovery = await loadDiscovery(S.fetchImpl);
  if (discovery.ok) {
    for (const relay of discovery.relays) {
      if (!S.relayStore.findByUrl(relay.url)) S.relayStore.add(relay);
    }
  }
  const paramRelay = resolveRelayParam(S.params);
  if (paramRelay && !S.relayStore.findByUrl(paramRelay.url)) {
    S.relayStore.add(paramRelay);
  }
  S.entries = buildEntries();
}

async function restoreDefaultRelays() {
  S.hiddenRelays = clearHiddenRelayUrls(S.storage);
  const added = [];
  for (const seed of defaultRelaySeeds(window)) {
    if (!S.relayStore.findByUrl(seed.url)) {
      const result = S.relayStore.add(Object.assign({ source: 'seed' }, seed));
      if (result.ok) added.push(result.relay);
    }
  }
  renderRelayGrid();
  for (const relay of added) measureRelayOnce(relay.id);
  toast(added.length ? '已恢复默认后端' : '默认后端已存在', 'ok');
  log('恢复默认后端：新增 ' + added.length + ' 个');
}

function selectInitialRelay() {
  const paramRelay = resolveRelayParam(S.params);
  if (paramRelay) {
    const relay = S.relayStore.findByUrl(paramRelay.url);
    if (relay) S.selectedRelayId = relay.id;
  } else {
    const last = loadLastRelayId(S.storage);
    if (last && S.relayStore.get(last)) S.selectedRelayId = last;
  }
}

function prepareDirect() {
  if (!S.params.connectUrl) return;
  const info = parseConnectUrl(S.params.connectUrl);
  if (!info.ok) {
    log('直连参数无效：' + info.error, 'err');
    toast('直连参数无效：' + info.error, 'error');
    return;
  }
  S.direct = { url: S.params.connectUrl, info, autostart: S.params.autostart };
  setHidden(R.directBanner, false);
  setText(R.directBannerText, S.params.connectUrl + (info.target ? '  →  ' + info.target : '') + '（原样传给客户端）');
  log('检测到直连参数：' + S.params.connectUrl);
}

function buildEntries() {
  return S.relayStore.list().map((relay) => {
    const latency = S.latency.get(relay.id) || null;
    return {
      relay,
      info: S.info.get(relay.id) || null,
      status: latency ? latency.status : 'idle',
      latency: latency && Number.isFinite(latency.latency) ? latency.latency : null,
      method: latency ? latency.method : '',
      detail: latency ? latency.detail : '',
      error: latency ? latency.error : '',
    };
  });
}

function latencyText(latency) {
  if (!latency) return '未测速';
  if (latency.status === 'measuring') return '测速中…';
  if (latency.status === 'ok' && Number.isFinite(latency.latency)) return formatRtt(latency.latency);
  if (latency.status === 'fail') return '不可用';
  return '未测速';
}

function latencyClass(latency) {
  if (!latency) return 'is-unknown';
  if (latency.status === 'measuring') return 'is-measuring';
  if (latency.status === 'fail') return 'is-slow';
  const value = latency.latency;
  if (!Number.isFinite(value)) return 'is-unknown';
  if (value < 40) return 'is-fast';
  if (value < 90) return 'is-good';
  if (value < 160) return 'is-ok';
  return 'is-slow';
}

function latencyBadge(latency, extraClass) {
  const badge = el('span', {
    class: 'latency-badge ' + latencyClass(latency) + (extraClass ? ' ' + extraClass : ''),
    text: latencyText(latency),
  });
  if (latency && latency.error) badge.title = latency.error;
  else if (latency && latency.detail) badge.title = latency.detail;
  return badge;
}

function currentLatency(relayId) {
  return S.latency.get(relayId) || null;
}

function displayName(relay, info) {
  if (!relay) return '';
  const address = relayAddressLabel(relay.url);
  const infoName = info && typeof info.name === 'string' ? info.name : '';
  if (relay.source === 'custom' && relay.name && relay.name !== address) return relay.name;
  return infoName || relay.name || address;
}

function renderBootSkeleton() {
  clear(R.relayGrid);
  for (let i = 0; i < 3; i += 1) {
    R.relayGrid.appendChild(el('div', { class: 'relay-card is-skeleton' },
      el('div', { class: 'skeleton-line', style: 'width:45%' }),
      el('div', { class: 'skeleton-line', style: 'width:70%;margin-top:12px' }),
      el('div', { class: 'skeleton-line', style: 'width:30%;margin-top:12px' })
    ));
  }
  setText(R.relaySummary, '正在检查本地缓存与后端…');
}

async function measureAllLatency(options = {}) {
  if (S.measuring) return;
  const relays = S.relayStore.list();
  if (!relays.length) {
    renderRelayGrid();
    return;
  }
  S.measuring = true;
  const pending = relays.filter((relay) => {
    const current = S.latency.get(relay.id);
    return options.force || !current || current.status !== 'ok';
  });
  for (const relay of pending) S.latency.set(relay.id, { status: 'measuring' });
  renderRelayGrid();

  await Promise.all(relays.map(async (relay) => {
    const info = await fetchRelayInfo(relay, { fetchImpl: S.fetchImpl, timeoutMs: 4000 })
      .catch(() => ({ ok: false }));
    if (info && info.ok) S.info.set(relay.id, info.info);
  }));
  renderRelayGrid();

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(4, pending.length));
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push((async () => {
      while (cursor < pending.length) {
        const relay = pending[cursor];
        cursor += 1;
        const relayInfo = S.info.get(relay.id) || {};
        const result = await S.measureLatency(relay, { timeoutMs: 6000, iceServers: relayInfo.iceServers || [] }).catch((error) => ({ ok: false, error: error.message }));
        if (result && result.ok) {
          S.latency.set(relay.id, {
            status: 'ok',
            latency: result.latencyMs,
            method: result.method,
            detail: result.detail || '',
            error: '',
          });
        } else {
          S.latency.set(relay.id, {
            status: 'fail',
            latency: null,
            method: '',
            detail: '',
            error: (result && result.error) || '不可用',
          });
        }
        renderRelayGrid();
      }
    })());
  }
  await Promise.all(workers);
  S.measuring = false;
  renderRelayGrid();
}

function startLatencyMeasurement() {
  if (!S.relayStore.list().length) return;
  measureAllLatency({ force: true });
}

function measureRelayOnce(relayId) {
  const relay = S.relayStore.get(relayId);
  if (!relay) return;
  S.latency.set(relayId, { status: 'measuring', latency: null, method: '', detail: '', error: '' });
  renderRelayGrid();
  Promise.resolve(S.measureLatency(relay, { timeoutMs: 6000 }))
    .then((result) => {
      if (!S.relayStore.get(relayId)) return;
      if (result && result.ok) {
        S.latency.set(relayId, {
          status: 'ok',
          latency: result.latencyMs,
          method: result.method,
          detail: result.detail || '',
          error: '',
        });
      } else {
        S.latency.set(relayId, {
          status: 'fail',
          latency: null,
          method: '',
          detail: '',
          error: (result && result.error) || '不可用',
        });
      }
      renderRelayGrid();
    })
    .catch((error) => {
      S.latency.set(relayId, { status: 'fail', latency: null, method: '', detail: '', error: (error && error.message) || '不可用' });
      renderRelayGrid();
    });
}

function emptyRelayState() {
  const wrap = el('div', { class: 'relay-empty-state', id: 'relay-empty' },
    el('div', { class: 'empty-state-icon', text: '◎' }),
    el('div', { class: 'empty-state-title', text: '还没有可用的后端' }),
    el('div', { class: 'empty-state-text', text: '添加一个自定义后端，或恢复默认的本地中继。' }),
    el('div', { class: 'empty-state-actions' },
      el('button', {
        id: 'btn-empty-add',
        class: 'btn btn-primary btn-sm',
        type: 'button',
        onclick: () => openRelayDialog(''),
      }, '＋ 添加自定义后端'),
      hasRestorableDefaults() ? el('button', {
        id: 'btn-empty-restore',
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        onclick: () => restoreDefaultRelays(),
      }, '恢复默认后端') : null
    )
  );
  return wrap;
}

function hasRestorableDefaults() {
  if (S.hiddenRelays.length > 0) return true;
  return defaultRelaySeeds(window).some((seed) => !S.relayStore.findByUrl(seed.url));
}

function updateRestoreButton() {
  if (R.btnRestoreRelays) setHidden(R.btnRestoreRelays, !hasRestorableDefaults());
}

function renderRelayGrid() {
  const entries = buildEntries();
  S.entries = entries;
  clear(R.relayGrid);
  const sorted = rankRelayEntries(entries);
  if (!sorted.length) {
    R.relayGrid.appendChild(emptyRelayState());
  } else {
    for (const entry of sorted) R.relayGrid.appendChild(relayCard(entry));
    R.relayGrid.appendChild(customRelayCard());
  }
  updateRestoreButton();

  const measured = sorted.filter((entry) => entry.status === 'ok' && Number.isFinite(entry.latency));
  const measuring = sorted.filter((entry) => entry.status === 'measuring').length;
  let summary = '';
  if (!entries.length) summary = '还没有可用的后端，添加一个或恢复默认后端即可开始。';
  else if (measuring > 0) summary = '共 ' + entries.length + ' 个后端 · 正在测量延迟…';
  else if (measured.length) {
    const best = measured[0];
    summary = '共 ' + entries.length + ' 个后端 · 最快 ' + formatRtt(best.latency) +
      '（' + displayName(best.relay, best.info) + ' · ' + (LATENCY_METHOD_LABEL[best.method] || '') + '）';
  } else {
    summary = '共 ' + entries.length + ' 个后端 · 暂无可用，点「重新测速」再试';
  }
  setText(R.relaySummary, summary);
  updateCacheBadge();
}

function isBuiltinRelay(relay) {
  return Boolean(relay) && (relay.source === 'seed' || relay.source === 'discovered');
}

function canDeleteRelay(relay) {
  if (!relay) return false;
  // 本地种子允许删除（删除后写入隐藏列表，避免下次被种子逻辑加回）
  // relays.json / master 下发的节点保持只读
  return relay.source !== 'discovered' && relay.source !== 'master';
}

function cardActionTarget(event) {
  let node = event && event.target;
  while (node) {
    if (node.classList && node.classList.contains('relay-card-actions')) return true;
    node = node.parentNode;
  }
  return false;
}

function relayCard(entry) {
  const relay = entry.relay;
  const info = entry.info || {};
  const selected = relay.id === S.selectedRelayId;
  const card = el('div', {
    class: 'relay-card' + (selected ? ' is-selected' : ''),
    role: 'button',
    tabindex: '0',
    'data-relay-id': relay.id,
    'aria-label': '连接后端 ' + displayName(relay, info),
    onclick: () => selectRelay(relay),
    onkeydown: (event) => {
      if (cardActionTarget(event)) return;
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        selectRelay(relay);
      }
    },
  });

  const actions = el('div', { class: 'relay-card-actions' },
    el('button', {
      class: 'icon-btn icon-btn-sm relay-action',
      type: 'button',
      'data-action': 'edit',
      title: '编辑后端',
      'aria-label': '编辑后端 ' + displayName(relay, info),
      onclick: (event) => {
        event.stopPropagation();
        openRelayDialog(relay.id);
      },
    }, '✎'),
    canDeleteRelay(relay) ? el('button', {
      class: 'icon-btn icon-btn-sm relay-action is-delete',
      type: 'button',
      'data-action': 'delete',
      title: '删除后端',
      'aria-label': '删除后端 ' + displayName(relay, info),
      onclick: (event) => {
        event.stopPropagation();
        deleteRelay(relay.id);
      },
    }, '🗑') : null
  );

  const tags = el('div', { class: 'relay-meta' });
  if (info.region) tags.appendChild(el('span', { class: 'tag', text: info.region }));
  if (info.recommended) tags.appendChild(el('span', { class: 'tag is-accent', text: '推荐' }));
  if (info.players != null) tags.appendChild(el('span', { class: 'tag is-teal', text: info.players + ' 人在线' }));
  if (relay.token) tags.appendChild(el('span', { class: 'tag', text: '需要 Token' }));
  if (relay.source === 'seed') tags.appendChild(el('span', { class: 'tag is-builtin', text: '本地内置' }));
  if (relay.source === 'discovered') tags.appendChild(el('span', { class: 'tag is-builtin', text: '官方推荐' }));
  if (relay.source === 'master') tags.appendChild(el('span', { class: 'tag is-builtin', text: 'Master 节点' }));

  const method = entry.method ? (LATENCY_METHOD_LABEL[entry.method] || '') : '';
  const foot = el('div', { class: 'relay-card-foot' },
    el('span', { text: entry.detail || (info.note || '') }),
    el('span', { class: 'relay-card-hint', text: method ? method + ' · 点击连接 →' : '点击连接 →' })
  );

  card.appendChild(actions);
  card.appendChild(el('div', { class: 'relay-card-top' },
    el('div', {},
      el('div', { class: 'relay-name', text: displayName(relay, info) }),
      el('div', { class: 'relay-address', text: relayAddressLabel(relay.url) })
    ),
    latencyBadge({ status: entry.status, latency: entry.latency, method: entry.method, detail: entry.detail, error: entry.error })
  ));
  card.appendChild(el('div', { class: 'relay-meta' }, tags));
  card.appendChild(foot);
  return card;
}

function customRelayCard() {
  return el('button', {
    class: 'relay-card is-custom',
    type: 'button',
    onclick: () => openRelayDialog(''),
  },
    el('span', { class: 'custom-plus', text: '＋' }),
    el('span', { class: 'custom-title', text: '添加自定义后端' }),
    el('span', { class: 'custom-sub', text: '支持 ws:// 与 wss://，可附加 token，保存在本机。' })
  );
}

// ---------------------------------------------------------------- 中继增删改

function openRelayDialog(relayId) {
  S.dialogRelayId = relayId || '';
  const relay = relayId ? S.relayStore.get(relayId) : null;
  setText(R.relayDialogTitle, relay ? '编辑后端' : '添加自定义后端');
  R.relayUrl.value = relay ? relay.url : '';
  R.relayName.value = relay ? relay.name : '';
  R.relayToken.value = relay ? relay.token : '';
  R.btnRelayDelete.hidden = !relay;
  setHidden(R.relayFormError, true);
  setText(R.relayFormError, '');
  if (typeof R.relayDialog.showModal === 'function') R.relayDialog.showModal();
  else R.relayDialog.setAttribute('open', '');
  R.relayUrl.focus();
}

function saveRelayDialog() {
  const input = {
    url: R.relayUrl.value,
    name: R.relayName.value,
    token: R.relayToken.value,
  };
  const editing = Boolean(S.dialogRelayId);
  const result = editing ? S.relayStore.update(S.dialogRelayId, input) : S.relayStore.add(input);
  if (!result.ok) {
    setText(R.relayFormError, result.error);
    setHidden(R.relayFormError, false);
    return;
  }
  R.relayDialog.close();
  const relay = result.relay;
  S.hiddenRelays = unhideRelayUrl(S.storage, relay.url);
  if (!editing) {
    S.selectedRelayId = relay.id;
    saveLastRelayId(S.storage, relay.id);
  }
  S.dialogRelayId = '';
  S.latency.delete(relay.id);
  renderRelayGrid();
  measureRelayOnce(relay.id);
  toast(editing ? '后端已更新，正在重新测速' : '已添加后端：' + relay.name, 'ok');
  log((editing ? '已更新后端：' : '已添加后端：') + relay.name + ' → ' + relay.url);
}

async function deleteRelay(id) {
  const relay = S.relayStore.get(id);
  if (!relay) return;
  if (!canDeleteRelay(relay)) {
    toast('内置后端不可删除，可以编辑名称或 token', 'warn');
    return;
  }
  const info = S.info.get(id) || {};
  const ok = await confirmDialog({
    title: '删除后端',
    text: '确定删除「' + displayName(relay, info) + '」（' + relayAddressLabel(relay.url) + '）吗？删除后需要重新添加。',
    okText: '删除',
  });
  if (!ok) return;

  if (relay.source === 'seed') {
    S.hiddenRelays = hideRelayUrl(S.storage, relay.url);
  }
  S.relayStore.remove(id);
  S.latency.delete(id);
  S.info.delete(id);
  if (S.selectedRelayId === id) S.selectedRelayId = '';
  if (S.servers.relayId === id) {
    S.servers = { status: 'idle', relayId: '', list: [], error: '', query: '', page: 0, at: 0, warnings: [], source: '', filters: { ...DEFAULT_MASTER_FILTERS } };
    if (S.view === 'servers' || S.view === 'game') setView('relays');
  }
  renderRelayGrid();
  renderServers();
  toast('已删除后端：' + relay.name, 'ok');
  log('已删除后端：' + relay.name + '（' + relay.url + '）');
}

// ---------------------------------------------------------------- 选择 / 连接后端

async function selectRelay(relay) {
  if (!relay) return;
  if (S.runtimeExited) {
    showGameExit('需要重新加载页面', 'Emscripten 运行时已退出，请重新加载页面后再进入游戏。');
    return;
  }
  S.selectedRelayId = relay.id;
  saveLastRelayId(S.storage, relay.id);
  renderRelayGrid();

  if (S.assets.isComplete()) {
    await connectToRelay(relay);
    return;
  }

  const loading = showLoadingView(relay, 'download');
  const ok = await ensureAssets();
  if (!ok) return;
  if (S.loading.closed || S.loading.relayId !== relay.id) return;
  await connectToRelay(relay);
}

async function connectToRelay(relay) {
  if (!relay) return;
  S.phase = 'connecting';
  showLoadingView(relay, 'connect');
  let master;
  let relayServers;
  let info;
  try {
    master = await fetchMasterServers({ fetchImpl: S.fetchImpl, timeoutMs: 9000 });
    relayServers = await fetchServers(relay, { fetchImpl: S.fetchImpl, timeoutMs: 7000 }).catch((error) => ({ ok: false, error: (error && error.message) || String(error) }));
    info = await fetchRelayInfo(relay, { fetchImpl: S.fetchImpl, timeoutMs: 4000 }).catch(() => ({ ok: false }));
  } catch (error) {
    master = { ok: false, error: (error && error.message) || String(error), servers: [] };
    relayServers = { ok: false, error: (error && error.message) || String(error) };
    info = { ok: false };
  }
  if (!info || !info.ok) {
    // 官方 master 不依赖后端，但进服仍需要后端中转：后端不可达时直接给出错误面板。
    hideLoading();
    showServersError(relay, { error: '后端不可达或 /api/info 请求失败：' + ((info && info.error) || '未知错误') });
    return;
  }
  S.info.set(relay.id, info.info);

  let source = 'master';
  let list = master.ok ? master.servers : [];
  let warnings = [];
  if (!master.ok) {
    // 官方 master 不可达时退回后端推荐列表（旧 /api/servers），保证仍能进服。
    if (relayServers.ok && Array.isArray(relayServers.servers) && relayServers.servers.length) {
      source = 'relay';
      list = normalizeRelayServers(relayServers.servers);
      warnings = ['官方服务器列表获取失败：' + master.error];
    } else {
      hideLoading();
      showServersError(relay, {
        error: (master.error || '官方 master 获取失败') + '\n后端推荐列表' + (relayServers && relayServers.status ? ' HTTP 状态：' + relayServers.status : '') + '；错误：' + ((relayServers && relayServers.error) || '未知错误'),
      });
      return;
    }
  }
  S.servers = {
    status: 'ok',
    relayId: relay.id,
    list,
    error: '',
    query: '',
    page: 0,
    at: Date.now(),
    warnings: warnings.concat(relayServers && Array.isArray(relayServers.warnings) ? relayServers.warnings : []),
    source,
    filters: { ...DEFAULT_MASTER_FILTERS, sort: source === 'master' ? 'players' : 'none' },
  };
  hideLoading();
  setView('servers');
  renderServers();
  saveLastRelayId(S.storage, relay.id);
  log('已连接后端：' + relay.name + '（' + (source === 'master' ? 'DDNet 官方 master' : '后端推荐') + '，' + list.length + ' 台服务器）', 'ok');
}

function currentServerRelay() {
  const relayId = S.servers.relayId || S.selectedRelayId;
  return relayId ? S.relayStore.get(relayId) : null;
}

function showServersError(relay, result) {
  S.servers = {
    status: 'error',
    relayId: relay.id,
    list: [],
    error: describeServersError(relay, result),
    query: '',
    page: 0,
    at: Date.now(),
    warnings: [],
    source: '',
    filters: { ...DEFAULT_MASTER_FILTERS },
  };
  S.phase = 'error';
  setView('servers');
  renderServers();
  log('后端连接失败：' + relay.name + ' — ' + ((result && result.error) || '未知错误'), 'err');
}

function describeServersError(relay, result) {
  const lines = [];
  lines.push('后端：' + relay.name + '（' + relayAddressLabel(relay.url) + '）');
  lines.push('请求：GET ' + buildServersHttpUrl(relay.url));
  if (result && result.status) lines.push('HTTP 状态：' + result.status);
  lines.push('错误：' + ((result && result.error) || '未知错误'));
  lines.push('时间：' + new Date().toLocaleString());
  lines.push('');
  lines.push('可能原因：');
  lines.push('· 中继服务未启动，或地址 / 端口填写错误');
  lines.push('· 浏览器跨域（CORS）被拒绝：中继需要允许当前站点 Origin');
  lines.push('· 网络中断，或 wss 自签证书未被信任');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 服务器列表

function renderServers() {
  const state = S.servers;
  const relay = S.relayStore.get(state.relayId) || currentServerRelay();
  if (!relay) {
    setView('relays');
    return;
  }
  const latency = currentLatency(relay.id);
  const info = S.info.get(relay.id) || {};
  setText(R.serversTitle, displayName(relay, info));
  const sourceLabel = state.source === 'master' ? 'DDNet 官方 master' : state.source === 'relay' ? '后端推荐列表' : '';
  const updated = state.status === 'ok' && state.at ? ' · 更新于 ' + formatAgo(state.at) : '';
  const defaultProtocolText = S.protocol === 7 ? '默认协议 0.7' : '默认协议 0.6';
  setText(R.serversSubtitle, relayAddressLabel(relay.url) + ' · ' + (sourceLabel || '服务器列表') + ' · ' + defaultProtocolText + (state.status === 'ok' ? ' · 共 ' + state.list.length + ' 台' + updated : ''));
  R.serversLatency.className = 'latency-badge ' + latencyClass(latency);
  setText(R.serversLatency, latencyText(latency));
  R.serversLatency.title = (latency && (latency.detail || latency.error)) || '';
  renderProtocolButtons();
  renderServerFilters();

  const isError = state.status === 'error';
  setHidden(R.serversError, !isError);
  setHidden(R.serversContent, isError);
  if (isError) {
    setText(R.serversErrorTitle, '无法连接后端');
    setText(R.serversErrorHint, '请检查后端是否在线，或返回换一个后端。');
    setText(R.serversErrorText, state.error);
    setHidden(R.serversNotice, true);
    return;
  }
  if (S.servers.notice) {
    setHidden(R.serversNotice, false);
    setText(R.serversNoticeText, S.servers.notice);
  } else {
    setHidden(R.serversNotice, true);
  }

  const filtered = filteredServers();
  if (R.serversCount) setText(R.serversCount, '筛选后 ' + filtered.length + ' / ' + state.list.length + ' 台');
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (state.page >= pages) state.page = pages - 1;
  if (state.page < 0) state.page = 0;
  const pageItems = filtered.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

  if (R.serverSearch.value !== state.query) R.serverSearch.value = state.query;
  clear(R.serverList);
  if (!state.list.length) {
    R.serverList.appendChild(el('div', { class: 'empty-state' }, '没有获取到服务器列表。'));
  } else if (!pageItems.length) {
    R.serverList.appendChild(el('div', { class: 'empty-state' }, state.query.trim() ? '没有匹配「' + state.query.trim() + '」和当前筛选条件的服务器。' : '没有匹配当前筛选条件的服务器。'));
  } else {
    for (const server of pageItems) {
      R.serverList.appendChild(serverCard(relay, server));
    }
  }

  clear(R.serverPager);
  if (pages > 1) {
    setHidden(R.serverPager, false);
    R.serverPager.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: '上一页',
      disabled: state.page <= 0,
      onclick: () => {
        S.servers.page -= 1;
        renderServers();
      },
    }));
    R.serverPager.appendChild(el('span', { class: 'pager-label', text: '第 ' + (state.page + 1) + ' / ' + pages + ' 页 · 共 ' + filtered.length + ' 台' }));
    R.serverPager.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: '下一页',
      disabled: state.page >= pages - 1,
      onclick: () => {
        S.servers.page += 1;
        renderServers();
      },
    }));
  } else {
    setHidden(R.serverPager, true);
  }
}

function filteredServers() {
  return filterServers(S.servers.list, S.servers.filters, S.servers.query);
}

function fillSelect(select, options, value, allLabel) {
  if (!select) return;
  clear(select);
  select.appendChild(el('option', { value: '', text: allLabel }));
  for (const option of options || []) {
    select.appendChild(el('option', { value: option.value, text: option.label + (option.count != null ? ' (' + option.count + ')' : '') }));
  }
  select.value = options && options.some((option) => option.value === value) ? value : '';
}

function renderServerFilters() {
  const state = S.servers;
  const filters = state.filters || DEFAULT_MASTER_FILTERS;
  const options = filterOptions(state.list);
  fillSelect(R.serverFilterProtocol, [
    { value: '6', label: '0.6' },
    { value: '7', label: '0.7' },
  ], filters.protocol, '全部协议');
  fillSelect(R.serverFilterType, options.types, filters.type, '全部类型');
  fillSelect(R.serverFilterRegion, options.regions, filters.region, '全部地区');
  if (R.serverFilterSort) R.serverFilterSort.value = filters.sort || 'players';
  if (R.serverFilterHideFull) R.serverFilterHideFull.checked = filters.hideFull === true;
  if (R.serverFilterHideLocked) R.serverFilterHideLocked.checked = filters.hideLocked === true;
}

function serverCard(relay, server) {
  const name = server.name || (server.host + ':' + server.port);
  const address = server.target || (server.host + ':' + server.port);
  const initials = String(name).trim().slice(0, 2).toUpperCase() || 'DD';
  const detail = [address, server.map, server.gameType].filter(Boolean).join(' · ');
  const cardProtocol = server.protocol === 7 ? 7 : server.protocol === 6 ? 6 : null;
  const full = Number.isFinite(server.players) && Number.isFinite(server.maxPlayers) && server.maxPlayers > 0 && server.players >= server.maxPlayers;
  const playersText = server.players != null ? server.players + (server.maxPlayers ? '/' + server.maxPlayers : '') + ' 人' : '';
  return el('button', {
    class: 'server-card',
    type: 'button',
    onclick: () => enterGame(relay, address, { name, protocol: cardProtocol == null ? undefined : cardProtocol }),
  },
    el('span', { class: 'server-avatar', text: initials }),
    el('div', { class: 'server-main' },
      el('div', { class: 'server-name', text: name }),
      el('div', { class: 'server-address', text: detail })
    ),
    el('div', { class: 'server-side' },
      el('span', { class: 'tag', text: cardProtocol === 7 ? '0.7' : cardProtocol === 6 ? '0.6' : '自动' }),
      server.region ? el('span', { class: 'tag', text: regionLabel(server.region) }) : null,
      playersText ? el('span', { class: 'tag ' + (full ? 'is-warn' : 'is-teal'), text: playersText }) : null,
      server.passworded ? el('span', { class: 'tag is-warn', text: '密码' }) : null,
      el('span', { class: 'relay-card-hint', text: '进入 →' })
    )
  );
}

function showServersNotice(text) {
  S.servers.notice = text;
  if (S.view === 'servers') renderServers();
}

// ---------------------------------------------------------------- 进入游戏

async function enterGame(relay, targetText, meta = {}) {
  if (S.runtimeExited) {
    showGameExit('需要重新加载页面', '上一次客户端已退出，Emscripten 运行时不能在同一页面重启，请重新加载页面。');
    return;
  }
  const parsed = parseTarget(String(targetText || ''));
  if (!parsed.ok) {
    toast(parsed.error, 'error');
    return;
  }
  // 移动端：在用户手势内请求全屏（不能等到 await 之后，否则浏览器会拒绝）
  requestFullscreenForGame();
  S.selectedRelayId = relay.id;
  S.hud.relay = { relay, latency: currentLatency(relay.id), info: S.info.get(relay.id) || {} };
  S.hud.target = parsed;
  S.hud.serverName = meta.name || parsed.target;
  S.servers.notice = '';

  if (!S.assets.isComplete()) {
    showLoadingView(relay, 'download');
    const ok = await ensureAssets();
    if (!ok || S.loading.closed) return;
  }
  await startSession({ relay, target: parsed, protocol: meta.protocol });
}

async function startDirectSession(rawUrl) {
  if (S.runtimeExited) {
    showGameExit('需要重新加载页面', 'Emscripten 运行时已退出，请重新加载页面。');
    return;
  }
  const info = parseConnectUrl(rawUrl);
  if (!info.ok) {
    toast('直连地址无效：' + info.error, 'error');
    return;
  }
  requestFullscreenForGame();
  const relay = { id: 'direct', name: '直连', url: info.relayBase, token: '' };
  const target = { host: '', port: 0, target: info.target || rawUrl };
  S.hud.relay = { relay, latency: null, info: { name: '直连' } };
  S.hud.target = target;
  S.hud.serverName = info.target || '直连';

  if (!S.assets.isComplete()) {
    showLoadingView(relay, 'download');
    const ok = await ensureAssets();
    if (!ok || S.loading.closed) return;
  }
  // Direct links may point at a relay on the public internet: fetch its ICE
  // servers so the WebRTC data channel can gather server-reflexive candidates.
  const relayInfo = await fetchRelayInfo(relay, { fetchImpl: S.fetchImpl, timeoutMs: 4000 }).catch(() => null);
  const iceServers = relayInfo && relayInfo.ok ? relayInfo.info.iceServers : [];
  await startSession({ relay, target, connectUrl: rawUrl, iceServers });
}

async function startSession(options) {
  const requestedProtocol = options.protocol == null ? S.protocol : options.protocol;
  const protocol = Number(requestedProtocol) === 7 ? 7 : 6;
  const preview = options.connectUrl
    ? buildDirectConnectTarget(options.connectUrl)
    : buildConnectTarget(options.relay, options.target, { protocol });
  const touchMode = isTouchMode();
  S.lastConnectUrl = preview.ok ? preview.url : '';
  S.lastConnectProtocol = options.connectUrl ? 'direct' : protocol;
  S.sessionProtocol = protocol;
  S.lastLaunchArgs = preview.ok ? buildLaunchArgs(preview.args, { touchControls: touchMode, backButton: touchMode }) : [];
  S.phase = 'launching';
  showLoadingView(options.relay, 'launch');
  S.loading.note = '正在准备客户端资源…';
  renderLoading();
  try {
    const assetUrls = await S.assets.assetUrls();
    const locateFile = (path) => assetUrls[path] || new URL(path, location.href).href;
    await S.launchSession({
      relay: options.relay,
      target: options.target,
      connectUrl: options.connectUrl || '',
      protocol,
      iceServers: options.iceServers || (S.info.get(options.relay && options.relay.id) || {}).iceServers || [],
      // 移动端：在 connect 之前追加强制开启触屏控制 / 虚拟返回按钮的命令
      touchControls: touchMode,
      backButton: touchMode,
      canvas: R.canvas,
      assetUrls,
      homePath: HOME_PATH,
      readyTimeoutMs: RUNTIME_READY_TIMEOUT_MS,
      audioUnlock: () => S.audio.unlock(),
      createModule: (moduleOptions) => buildModuleConfig({
        canvas: moduleOptions.canvas,
        hooks: moduleOptions.hooks,
        locateFile: moduleOptions.locateFile,
        mainScriptUrlOrBlob: moduleOptions.mainScriptUrlOrBlob,
      }),
      loadScript: (src) => loadClientScript(src),
      resolveRuntime: () => ({ FS: window.FS, IDBFS: window.IDBFS }),
      launch: (launchOptions) => launchWithModule(launchOptions),
      showGame: () => setView('game'),
      onEvent: (event) => handleSessionEvent(event),
      onRuntime: (runtime) => {
        S.runtime = runtime;
        installRuntimeErrorHandlers(runtime.Module);
      },
      locateFile,
      mainScriptUrlOrBlob: assetUrls['DDNet.js'],
    });
  } catch (error) {
    S.phase = 'error';
    hideLoading();
    setView('servers');
    renderServers();
    log('启动失败：' + ((error && (error.stack || error.message)) || error), 'err');
    showGameExit('启动失败', (error && error.message) || String(error));
  }
}

function loadClientScript(src) {
  return new Promise((resolve, reject) => {
    const previous = document.querySelector('script[data-ddweb-runtime]');
    if (previous) previous.remove();
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.ddwebRuntime = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('无法加载客户端脚本（blob URL 失效或缓存损坏）'));
    document.body.appendChild(script);
  });
}

function handleSessionEvent(event) {
  if (!event) return;
  const setNote = (text) => {
    S.loading.note = text;
    if (S.loading.open && S.loading.stage === 'launch') renderLoading();
  };
  switch (event.type) {
    case 'prepare':
      log('准备启动：' + event.payload.url, 'ok');
      break;
    case 'script-loading':
      setNote('正在加载客户端脚本…');
      break;
    case 'runtime-initializing':
      setNote('正在初始化运行时…');
      break;
    case 'dependencies':
      setNote(event.payload > 0 ? '正在加载资源（剩余 ' + event.payload + ' 项）…' : '正在初始化运行时…');
      break;
    case 'runtime-ready':
      setNote('正在挂载本地文件系统…');
      break;
    case 'default-relay': {
      const applied = event.payload || {};
      if (applied.ok) {
        const address = applied.relayBase + (applied.query ? '?' + applied.query : '');
        log('游戏内服务器浏览器的地址已改走中继：' + address + '（游戏内选择服务器也会通过该中继转发）', 'ok');
      } else {
        log('未能启用游戏内服务器浏览器的中继：' + (applied.error || '未知原因'), 'warn');
      }
      break;
    }
    case 'step':
      if (event.payload === 'mount') setNote('正在挂载 IndexedDB 文件系统…');
      else if (event.payload === 'sync') setNote('正在恢复本地存档…');
      else if (event.payload === 'callMain') setNote('正在启动 DDNet…');
      break;
    case 'call-main':
      S.phase = 'running';
      hideLoading();
      setView('game');
      startHud();
      maybeStartSpotlight();
      log('客户端已启动，正在连接服务器…', 'ok');
      break;
    case 'print':
      logAnsi(event.payload);
      break;
    case 'stderr':
      log(event.payload, 'err');
      break;
    case 'exit':
      handleExit(event.payload);
      break;
    case 'error':
      log('启动错误：' + event.payload, 'err');
      break;
    default:
      break;
  }
}

function installRuntimeErrorHandlers(Module) {
  window.onerror = function (message, source, line, column, error) {
    log('运行时错误：' + message, 'err');
    stopSdlAudio(Module);
    const aborted = typeof ABORT !== 'undefined' && ABORT;
    if (!aborted && Module && typeof Module.ccall === 'function') {
      try {
        Module.ccall('EmscriptenCallbackQuitForce', null, [], []);
      } catch (quitError) {
        // 忽略
      }
    }
    return false;
  };
  R.canvas.addEventListener('webglcontextcreationerror', (event) => {
    log('无法创建 WebGL 上下文：' + (event.statusMessage || '未知错误'), 'err');
  });
  R.canvas.addEventListener('webglcontextlost', (event) => {
    log('WebGL 上下文丢失，客户端将退出：' + (event.statusMessage || '未知错误'), 'err');
    try {
      Module.ccall('EmscriptenCallbackQuit', null, [], []);
    } catch (error) {
      // 忽略
    }
  });
}

function stopSdlAudio(Module) {
  try {
    const SDL2 = Module && Module.SDL2;
    if (!SDL2) return;
    if (SDL2.audio) {
      if (SDL2.audio.scriptProcessorNode) SDL2.audio.scriptProcessorNode.disconnect();
      if (SDL2.audio.silenceTimer) clearInterval(SDL2.audio.silenceTimer);
      SDL2.audio = undefined;
    }
    if (SDL2.audioContext) {
      SDL2.audioContext.close();
      SDL2.audioContext = undefined;
    }
  } catch (error) {
    // 忽略
  }
}

function handleExit(status) {
  log('客户端已退出（退出码 ' + status + '）', 'warn');
  stopHud();
  hideLoading();
  S.phase = 'exited';
  S.runtimeExited = true;
  stopMenuPoll();
  if (S.ime) S.ime.setActive(false);
  setView('servers');
  renderServers();
  showGameExit('客户端已退出', '退出码：' + status + '。Emscripten 运行时不能在同一页面重启，请重新加载页面后再进入游戏。');
}

function showGameExit(title, text) {
  setText(R.exitTitle, title || '提示');
  setText(R.exitText, text || '');
  setHidden(R.gameExit, false);
}

function hideGameExit() {
  setHidden(R.gameExit, true);
}

// ---------------------------------------------------------------- 下载 / 载入

function handleAssetUpdate(info) {
  if (!S.assets) return;
  renderWidget();
  renderLoading();
  renderDownloadModal();
  updateCacheBadge();
  if (info && info.type === 'done') {
    S.download.done = Boolean(info.snapshot && info.snapshot.complete);
    if (S.download.done && !S.download.hideScheduled) {
      S.download.hideScheduled = true;
      setTimeout(() => {
        setHidden(R.widget, true);
      }, 3200);
    }
  }
}

function renderDownloadModal() {
  if (!R.downloadFiles || !S.assets) return;
  const snap = S.assets.snapshot();
  clear(R.downloadFiles);
  for (const name of BIG_FILES) {
    const item = snap.items.find((entry) => entry.name === name);
    if (!item) continue;
    const iconText = name === 'DDNet.wasm' ? 'WASM' : 'DATA';
    const iconClass = name === 'DDNet.wasm' ? 'file-icon' : 'file-icon is-data';
    R.downloadFiles.appendChild(el('li', { class: 'file-row' },
      el('span', { class: iconClass, text: iconText }),
      el('div', { class: 'file-info' },
        el('div', { class: 'file-name', text: item.name }),
        el('div', { class: 'file-desc', text: item.label })
      ),
      el('span', { class: 'file-size', text: formatBytes(item.size) })
    ));
  }
  setText(R.downloadTotal, '共约 ' + formatBytes(snap.totalBytes) + ' · 校验后缓存在本机');
  setText(R.downloadNote, snap.manifestWarning || (snap.cacheAvailable ? '' : '当前浏览器不支持 Cache Storage，资源只在本次会话内有效。'));
  setHidden(R.btnDownloadStart, snap.complete);
}

function renderWidget() {
  if (!R.widget || !S.assets) return;
  if (!S.download.started) {
    setHidden(R.widget, true);
    return;
  }
  const snap = S.assets.snapshot();
  const items = snap.items.filter((item) => BIG_FILES.indexOf(item.name) >= 0);
  const total = items.reduce((sum, item) => sum + (item.size || 0), 0);
  const received = items.reduce((sum, item) => sum + (item.state === 'cached' ? (item.size || item.received) : item.received), 0);
  const percent = total > 0 ? Math.round((received / total) * 100) : snap.complete ? 100 : 0;
  const errored = items.some((item) => item.state === 'error');
  const finished = snap.complete;

  setHidden(R.widget, false);
  R.widget.classList.toggle('is-error', errored);
  R.widget.classList.toggle('is-min', S.download.minimized);
  setText(R.widgetTitle, finished ? '客户端资源已就绪' : errored ? '下载失败' : '正在下载客户端资源');
  setText(R.widgetOverall, percent + '%');
  if (errored) setText(R.widgetSpeed, snap.lastError || '请重试');
  else if (finished) setText(R.widgetSpeed, '共 ' + formatBytes(total));
  else setText(R.widgetSpeed, formatBytes(received) + ' / ' + formatBytes(total));
  setHidden(R.btnWidgetRetry, !errored);
  renderProgressRows(R.widgetProgress, BIG_FILES);
}

function renderProgressRows(container, names) {
  if (!container || !S.assets) return;
  const snap = S.assets.snapshot();
  clear(container);
  for (const name of names) {
    const item = snap.items.find((entry) => entry.name === name);
    if (!item) continue;
    const percent = item.state === 'cached' ? 100 : item.percent || 0;
    let stats = '';
    const via = item.source ? ' · via ' + item.source : '';
    if (item.state === 'downloading') stats = formatBytes(item.received) + ' / ' + formatBytes(item.size) + ' · ' + formatSpeed(item.speed) + via;
    else if (item.state === 'verifying') stats = '正在校验 sha256…' + via;
    else if (item.state === 'cached') stats = formatBytes(item.size) + ' · 完成' + via;
    else if (item.state === 'error') stats = item.error || '失败';
    else stats = formatBytes(item.size) + ' · 等待';
    const fill = el('div', {
      class: 'progress-fill' + (item.state === 'cached' ? ' is-done' : item.state === 'error' ? ' is-error' : ''),
      style: 'width:' + percent.toFixed(1) + '%',
    });
    container.appendChild(el('div', { class: 'progress-row' },
      el('div', { class: 'progress-head' },
        el('span', { class: 'progress-name', text: item.label + ' · ' + item.name }),
        el('span', { class: 'progress-stats', text: percent.toFixed(0) + '% · ' + stats })
      ),
      el('div', { class: 'progress-track' }, fill)
    ));
  }
}

function startDownload() {
  if (S.download.promise) return S.download.promise;
  S.download.confirmed = true;
  S.download.started = true;
  S.download.done = false;
  S.download.hideScheduled = false;
  setHidden(R.widget, false);
  renderWidget();
  log('开始下载客户端资源…');
  S.download.promise = S.assets.download()
    .then((result) => {
      S.download.done = Boolean(result && result.ok);
      renderWidget();
      renderLoading();
      renderDownloadModal();
      updateCacheBadge();
      if (result && result.ok) {
        log('客户端资源校验通过并已缓存', 'ok');
        toast('客户端资源已就绪，可以进入游戏了', 'ok');
      } else {
        const message = S.assets.snapshot().lastError || '未知错误';
        log('资源下载失败：' + message, 'err');
        toast('资源下载失败：' + message, 'error');
      }
      return result;
    })
    .catch((error) => {
      log('资源下载异常：' + ((error && error.message) || error), 'err');
      return { ok: false, error: (error && error.message) || String(error) };
    });
  return S.download.promise;
}

function retryDownload() {
  if (S.download.promise) return S.download.promise;
  S.download.started = false;
  S.download.done = false;
  S.download.hideScheduled = false;
  renderWidget();
  return startDownload();
}

function cancelDownload() {
  S.assets.abort();
  S.download.promise = null;
  S.download.started = false;
  S.download.done = false;
  setHidden(R.widget, true);
  hideLoading();
  toast('已取消下载', 'info');
}

async function ensureAssets() {
  if (S.assets.isComplete()) return true;
  const result = await startDownload();
  return Boolean(result && result.ok);
}

function showLoadingView(relay, stage) {
  S.loading = {
    open: true,
    relayId: relay ? relay.id : '',
    closed: false,
    stage: stage || 'download',
    note: stage === 'connect' ? '正在读取服务器列表…' : stage === 'launch' ? '正在准备客户端资源…' : '',
  };
  setText(R.loadingRelay, relay ? relay.name + ' · ' + relayAddressLabel(relay.url) : '');
  setHidden(R.loadingView, false);
  renderLoading();
}

function hideLoading() {
  S.loading.open = false;
  setHidden(R.loadingView, true);
}

function closeLoadingView() {
  if (!S.loading.open) return;
  S.loading.closed = true;
  hideLoading();
  setView('relays');
  renderRelayGrid();
  toast('已收起载入页面；下载会在后台继续', 'info');
}

function renderLoading() {
  if (!S.loading.open || !R.loadingView) return;
  const stage = S.loading.stage;
  if (stage === 'download') {
    setText(R.loadingTitle, '准备客户端资源');
    setHidden(R.loadingProgress, false);
    renderProgressRows(R.loadingProgress, BIG_FILES);
    const snap = S.assets.snapshot();
    setText(R.loadingNote, snap.complete ? '资源已就绪，正在连接后端…' : '下载会在后台继续，关闭此页面不会中断。');
    setHidden(R.btnLoadingCancel, false);
  } else if (stage === 'connect') {
    setText(R.loadingTitle, '正在连接后端');
    setHidden(R.loadingProgress, true);
    setText(R.loadingNote, '正在读取后端信息与服务器列表…');
    setHidden(R.btnLoadingCancel, true);
  } else {
    setText(R.loadingTitle, '正在启动客户端');
    setHidden(R.loadingProgress, true);
    setText(R.loadingNote, S.loading.note || '正在初始化运行时…');
    setHidden(R.btnLoadingCancel, true);
  }
}

// ---------------------------------------------------------------- 设备 / 触屏

export function isTouchMode() {
  return Boolean(S.device && S.device.touchMode === true);
}

// 测试 / 调试用：手动切换设备类型（真实页面启动时只检测一次）
function setDevice(device) {
  let next = device;
  if (typeof next === 'string') {
    const kind = next === 'mobile' || next === 'tablet' ? next : 'desktop';
    next = { kind, touch: kind !== 'desktop', touchMode: kind !== 'desktop' };
  }
  if (!next || typeof next !== 'object') return S.device;
  S.device = Object.assign({ touch: false, touchMode: false, kind: 'desktop' }, S.device || {}, next);
  S.device.isMobile = S.device.kind === 'mobile';
  S.device.isTablet = S.device.kind === 'tablet';
  S.device.isDesktop = S.device.kind === 'desktop';
  S.device.touchMode = S.device.kind !== 'desktop';
  applyDeviceAttributes(document, S.device);
  updateTouchUi();
  return S.device;
}

// 移动端：服务器列表页显示触屏操作说明；游戏内显示精简提示条
function renderTouchGuide() {
  if (!R.touchGuideList) return;
  clear(R.touchGuideList);
  for (const item of TOUCH_GUIDE_ITEMS) {
    R.touchGuideList.appendChild(el('li', {}, el('b', { text: item[0] + '：' }), item[1]));
  }
}

function updateTouchUi() {
  const touchMode = isTouchMode();
  const showGuide = touchMode && S.view === 'servers' && !S.touch.guideDismissed;
  const showHint = touchMode && S.view === 'game' && !S.touch.hintDismissed;
  setHidden(R.touchGuide, !showGuide);
  setHidden(R.touchHint, !showHint);
}

// 全屏 / 横屏锁定：必须在用户手势里调用；失败时静默降级
function enterFullscreenMode() {
  const result = requestImmersive(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
  S.immersive = result;
  if (result.fullscreen || result.orientation) {
    toast('已进入全屏，建议横屏游玩', 'info');
  } else {
    toast('当前浏览器不支持自动全屏，可手动旋转屏幕或添加到主屏幕', 'warn');
  }
  return result;
}

function requestFullscreenForGame() {
  if (!isTouchMode()) return null;
  const result = requestImmersive(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
  S.immersive = result;
  return result;
}

// ---------------------------------------------------------------- 视图

function startMenuPoll() {
  if (S.menuTimer) return;
  S.menuTimer = setInterval(() => {
    if (S.view !== 'game') return;
    const Module = S.runtime && S.runtime.Module;
    if (!Module || typeof Module.ccall !== 'function') return;
    try {
      const isDesktop = S.device && S.device.kind === 'desktop';
      const open = isDesktop && Module.ccall('DDWeb_IsMenuOpen', 'number', [], []) === 1;
      document.body.classList.toggle('is-menu-open', open);
    } catch (error) {
      // 旧 wasm 没有导出
    }
  }, 200);
}

function stopMenuPoll() {
  if (S.menuTimer) {
    clearInterval(S.menuTimer);
    S.menuTimer = null;
  }
  document.body.classList.remove('is-menu-open');
}

function setWasmAbsoluteMouse(absolute) {
  const Module = S.runtime && S.runtime.Module;
  if (!Module || typeof Module.ccall !== 'function') return;
  try {
    Module.ccall('DDWeb_SetAbsoluteMouse', null, ['number'], [absolute ? 1 : 0]);
  } catch (error) {
    // 旧 wasm 没有这个导出时忽略
  }
}

function scheduleUiMouseSync() {
  if (S.mouse.pending || S.view !== 'game' || !S.mouse.has) return;
  S.mouse.pending = true;
  const run = () => {
    S.mouse.pending = false;
    if (S.view !== 'game' || document.pointerLockElement === R.canvas) return;
    const Module = S.runtime && S.runtime.Module;
    if (!Module || typeof Module.ccall !== 'function') return;
    const rect = R.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(1, Math.max(0, (S.mouse.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (S.mouse.clientY - rect.top) / rect.height));
    try {
      Module.ccall('DDWeb_SetUiMousePos', null, ['number', 'number'], [x, y]);
    } catch (error) {
      // 忽略：旧 wasm 没有这个导出
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function setView(name) {
  S.view = name;
  const inGame = name === 'game';
  if (name !== 'relays' && S.download.done) setHidden(R.widget, true);
  document.body.classList.toggle('in-game', inGame);
  if (!inGame) {
    document.body.classList.remove('is-scoreboard-open', 'is-menu-open');
  }
  if (!inGame && S.ime) S.ime.setActive(false);
  setHidden(R.viewRelays, name !== 'relays');
  setHidden(R.viewServers, name !== 'servers');
  R.canvas.style.display = inGame ? 'block' : 'none';
  if (inGame) {
    startMenuPoll();
    setWasmAbsoluteMouse(document.pointerLockElement !== R.canvas);
    try {
      R.canvas.focus();
    } catch (error) {
      // 忽略
    }
  } else {
    stopMenuPoll();
    setWasmAbsoluteMouse(false);
  }
  updateTouchUi();
}

// ---------------------------------------------------------------- HUD / 聚光灯

function startHud() {
  stopHudTimer();
  S.hud.visible = false;
  setHidden(R.hudPanel, true);
  setHidden(R.hudHint, false);
  renderHudInfo();
  updateHudTraffic();
  S.hud.timer = setInterval(() => {
    updateHudTraffic();
    refreshHudLatency();
  }, 15000);
  refreshHudLatency();
}

function stopHudTimer() {
  if (S.hud.timer) {
    clearInterval(S.hud.timer);
    S.hud.timer = null;
  }
}

function stopHud() {
  stopHudTimer();
  setHidden(R.hudPanel, true);
  setHidden(R.hudHint, true);
  S.hud.visible = false;
}

function renderHudInfo() {
  const context = S.hud.relay;
  if (!context || !context.relay) return;
  const relay = context.relay;
  const info = context.info || {};
  const latency = S.latency.get(relay.id) || context.latency || null;
  const direct = relay.id === 'direct';
  setText(R.hudRelayName, displayName(relay, info));
  setText(R.hudRelayAddress, relayAddressLabel(relay.url) || '—');
  R.hudLatency.className = 'latency-badge ' + latencyClass(latency);
  setText(R.hudLatency, latencyText(latency));
  setText(R.hudLatencyMethod, latency && latency.method ? (LATENCY_METHOD_LABEL[latency.method] || '') : '');
  const targetText = (S.hud.target && S.hud.target.target) || '—';
  setText(R.hudTarget, S.hud.serverName && S.hud.serverName !== targetText ? S.hud.serverName + '\n' + targetText : targetText);
  setText(R.hudProtocol, direct ? '直连' : ((S.sessionProtocol || S.protocol) === 7 ? '0.7' : '0.6'));
  updateHudTransport();
}

function updateHudTransport() {
  if (!R.hudTransport) return;
  const transport = globalThis.Module && globalThis.Module.DDWSTransport;
  const labels = {
    webrtc: 'WebRTC 数据通道（首选）',
    ws: 'WebSocket（回退）',
    fallback: '正在回退 WebSocket…',
  };
  setText(R.hudTransport, labels[transport] || '协商中…');
}

function updateHudTraffic() {
  updateHudTransport();
  if (!R.hudTraffic) return;
  if (!S.wsStats || !S.wsStats.supported) {
    setText(R.hudTraffic, '不可用');
    return;
  }
  // WebRTC 数据通道不经过 WebSocket，用 wasm 传输层自己的计数。
  const transportStats = globalThis.Module && globalThis.Module.DDWSStats;
  if (transportStats && (transportStats.bytesIn > 0 || transportStats.bytesOut > 0)) {
    setText(R.hudTraffic, '↑ ' + formatBytes(transportStats.bytesOut) + ' · ↓ ' + formatBytes(transportStats.bytesIn));
    return;
  }
  const totals = S.wsStats.totals(isRelaySocketUrl);
  setText(R.hudTraffic, '↑ ' + formatBytes(totals.bytesOut) + ' · ↓ ' + formatBytes(totals.bytesIn));
}

async function refreshHudLatency() {
  if (S.hud.busy) return;
  const context = S.hud.relay;
  if (!context || !context.relay || !context.relay.url) return;
  S.hud.busy = true;
  try {
    const current = S.latency.get(context.relay.id);
    const hadWebrtc = current && current.status === 'ok' && current.method === 'webrtc';
    const relayInfo = S.info.get(context.relay.id) || {};
    const result = await S.measureLatency(context.relay, { webrtc: true, timeoutMs: 5000, iceServers: relayInfo.iceServers || [] }).catch(() => ({ ok: false }));
    if (result && result.ok) {
      // WebRTC 结果优先：已有 WebRTC 测量时，不用回退测量覆盖它
      if (!(hadWebrtc && result.method !== 'webrtc')) {
        S.latency.set(context.relay.id, {
          status: 'ok',
          latency: result.latencyMs,
          method: result.method,
          detail: result.detail || '',
          error: '',
        });
      }
    } else if (!current || current.status !== 'ok') {
      S.latency.set(context.relay.id, { status: 'fail', latency: null, method: '', detail: '', error: (result && result.error) || '不可用' });
    }
    renderHudInfo();
  } finally {
    S.hud.busy = false;
  }
}

function toggleHud(force) {
  if (S.view !== 'game') return;
  const next = typeof force === 'boolean' ? force : !S.hud.visible;
  S.hud.visible = next;
  setHidden(R.hudPanel, !next);
  setHidden(R.hudHint, next);
  // 移动端触屏提示条在右上角，会盖住 HUD 的关闭按钮；打开 HUD 时暂时收起它。
  if (next) {
    setHidden(R.touchHint, true);
    renderHudInfo();
  } else {
    updateTouchUi();
  }
}

function maybeStartSpotlight() {
  if (S.spot.started) return;
  // 触屏设备上不要自动弹出 HUD：面板会挡住游戏画面，改用触屏提示条上的「信息」按钮。
  if (S.device && S.device.touchMode) return;
  if (readTourDone(S.storage)) return;
  S.spot.started = true;
  if (!S.spot.tour || !S.spot.tour.start()) return;
  setTimeout(() => {
    toggleHud(true);
    renderSpotlight();
  }, 500);
}

function renderSpotlight() {
  const tour = S.spot.tour;
  if (!tour || !tour.active) {
    setHidden(R.spotlight, true);
    return;
  }
  setHidden(R.spotlight, false);
  const step = tour.current();
  setText(R.spotlightStep, '引导 ' + (tour.index + 1) + ' / ' + tour.total);
  setText(R.spotlightTitle, step.title);
  setText(R.spotlightText, step.text);
  setText(R.btnSpotlightNext, tour.isLast() ? '开始游戏' : '下一步');
  positionSpotlight(step);
}

function positionSpotlight(step) {
  const target = step && step.target ? document.getElementById(step.target) : null;
  const rect = target && typeof target.getBoundingClientRect === 'function'
    ? target.getBoundingClientRect()
    : { left: 16, top: 16, width: 280, height: 160, right: 296, bottom: 176 };
  const width = window.innerWidth || 1280;
  const height = window.innerHeight || 800;
  const pad = 8;
  const holeLeft = Math.max(0, Math.min(width, rect.left - pad));
  const holeTop = Math.max(0, Math.min(height, rect.top - pad));
  const holeRight = Math.max(holeLeft, Math.min(width, rect.left + rect.width + pad));
  const holeBottom = Math.max(holeTop, Math.min(height, rect.top + rect.height + pad));
  R.spotlightHole.style.left = holeLeft + 'px';
  R.spotlightHole.style.top = holeTop + 'px';
  R.spotlightHole.style.width = (holeRight - holeLeft) + 'px';
  R.spotlightHole.style.height = (holeBottom - holeTop) + 'px';
  const setBox = (node, left, top, boxWidth, boxHeight) => {
    if (!node) return;
    node.style.left = Math.max(0, left) + 'px';
    node.style.top = Math.max(0, top) + 'px';
    node.style.width = Math.max(0, boxWidth) + 'px';
    node.style.height = Math.max(0, boxHeight) + 'px';
  };
  const shades = R.spotlightShades || {};
  setBox(shades.top, 0, 0, width, holeTop);
  setBox(shades.bottom, 0, holeBottom, width, height - holeBottom);
  setBox(shades.left, 0, holeTop, holeLeft, holeBottom - holeTop);
  setBox(shades.right, holeRight, holeTop, width - holeRight, holeBottom - holeTop);

  const cardWidth = 300;
  const cardHeight = 190;
  const spaceRight = width - (rect.left + rect.width + 20);
  if (spaceRight >= cardWidth + 12) {
    R.spotlightCard.style.left = (rect.left + rect.width + 20) + 'px';
    R.spotlightCard.style.top = Math.max(16, Math.min(rect.top, height - cardHeight - 16)) + 'px';
    R.spotlightCard.classList.remove('is-below');
  } else {
    R.spotlightCard.style.left = Math.max(16, Math.min(rect.left, width - cardWidth - 16)) + 'px';
    R.spotlightCard.style.top = Math.min(rect.top + rect.height + 20, height - cardHeight - 16) + 'px';
    R.spotlightCard.classList.add('is-below');
  }
}

function advanceSpotlight() {
  const tour = S.spot.tour;
  if (!tour) return;
  if (tour.next()) {
    renderSpotlight();
  } else {
    finishSpotlight();
  }
}

function finishSpotlight() {
  if (S.spot.tour) S.spot.tour.finish();
  setHidden(R.spotlight, true);
  markTourDone(S.storage);
  toast('引导已结束；按 ' + HUD_SHORTCUT_HINT + ' 可随时显示后端连接信息', 'info');
}

function disconnectClient() {
  const Module = S.runtime && S.runtime.Module;
  if (Module && typeof Module.ccall === 'function') {
    try {
      Module.ccall('EmscriptenCallbackQuit', null, [], []);
      return;
    } catch (error) {
      try {
        Module.ccall('EmscriptenCallbackQuitForce', null, [], []);
        return;
      } catch (forceError) {
        // 落到提示
      }
    }
  }
  toast('无法直接退出客户端，请刷新页面', 'warn');
}

// ---------------------------------------------------------------- 协议

function loadFlag(storage, key) {
  try {
    return Boolean(storage && storage.getItem(key) === '1');
  } catch (error) {
    return false;
  }
}

function saveFlag(storage, key, value) {
  try {
    if (storage) storage.setItem(key, value ? '1' : '0');
  } catch (error) {
    // 忽略
  }
}

function loadProtocol() {
  try {
    const value = S.storage ? S.storage.getItem(PROTOCOL_KEY) : '';
    return value === '7' ? 7 : 6;
  } catch (error) {
    return 6;
  }
}

function setProtocol(value) {
  S.protocol = Number(value) === 7 ? 7 : 6;
  try {
    if (S.storage) S.storage.setItem(PROTOCOL_KEY, String(S.protocol));
  } catch (error) {
    // 忽略
  }
  renderProtocolButtons();
  if (S.view === 'servers') renderServers();
}

function renderProtocolButtons() {
  if (!R.btnProtocol6) return;
  const active6 = S.protocol !== 7;
  R.btnProtocol6.classList.toggle('is-active', active6);
  R.btnProtocol6.setAttribute('aria-pressed', active6 ? 'true' : 'false');
  R.btnProtocol7.classList.toggle('is-active', !active6);
  R.btnProtocol7.setAttribute('aria-pressed', active6 ? 'false' : 'true');
}

// ---------------------------------------------------------------- 主题 / 确认弹层

function setTheme(theme) {
  S.theme = applyTheme(document.documentElement, normalizeTheme(theme));
  saveTheme(S.storage, S.theme);
  updateThemeButton();
  toast(S.theme === 'dark' ? '已切换到深色主题' : '已切换到亮色主题', 'info');
  log('主题切换为：' + S.theme);
}

function updateThemeButton() {
  if (!R.btnTheme) return;
  setText(R.themeIcon, themeToggleIcon(S.theme));
  setText(R.themeLabel, themeToggleLabel(S.theme));
  R.btnTheme.setAttribute('aria-pressed', S.theme === 'dark' ? 'true' : 'false');
  R.btnTheme.setAttribute('aria-label', S.theme === 'dark' ? '切换到亮色主题' : '切换到深色主题');
  R.btnTheme.setAttribute('title', S.theme === 'dark' ? '切换到亮色主题' : '切换到深色主题');
}

function confirmDialog(options = {}) {
  setText(R.confirmTitle, options.title || '确认操作');
  setText(R.confirmText, options.text || '');
  setText(R.btnConfirmOk, options.okText || '确认');
  if (typeof R.confirmDialog.showModal === 'function') R.confirmDialog.showModal();
  else R.confirmDialog.setAttribute('open', '');
  return new Promise((resolve) => {
    S.confirmResolve = resolve;
  });
}

function finishConfirm(value) {
  const resolve = S.confirmResolve;
  S.confirmResolve = null;
  const isOpen = R.confirmDialog.open || R.confirmDialog.hasAttribute('open');
  if (isOpen) {
    if (typeof R.confirmDialog.close === 'function') R.confirmDialog.close();
    else R.confirmDialog.removeAttribute('open');
  }
  if (resolve) resolve(Boolean(value));
}

// ---------------------------------------------------------------- 高级设置

function openAdvanced() {
  R.nicknameInput.value = S.nickname;
  renderChecks();
  updateCacheBadge();
  setText(R.cacheInfo, (R.cacheInfo && R.cacheInfo.textContent) || '');
  if (typeof R.advancedDialog.showModal === 'function') R.advancedDialog.showModal();
  else R.advancedDialog.setAttribute('open', '');
}

// ---------------------------------------------------------------- 自动启动

async function runAutostart() {
  log('autostart：页面加载完成，开始自动启动');
  try {
    if (S.direct) {
      await startDirectSession(S.direct.url);
      return;
    }
    const paramRelay = resolveRelayParam(S.params);
    if (paramRelay) {
      const relay = S.relayStore.findByUrl(paramRelay.url);
      if (relay) {
        await ensureAssets();
        await connectToRelay(relay);
        return;
      }
    }
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline && S.measuring) await sleep(150);
    const sorted = rankRelayEntries(buildEntries());
    const fastest = sorted.find((entry) => entry.status === 'ok' && Number.isFinite(entry.latency));
    const relay = fastest ? fastest.relay : S.relayStore.list()[0];
    if (!relay) {
      log('autostart：没有可用后端', 'warn');
      return;
    }
    await ensureAssets();
    await connectToRelay(relay);
  } catch (error) {
    log('autostart 失败：' + ((error && error.message) || error), 'err');
    toast('自动启动失败：' + ((error && error.message) || error), 'error');
  }
}

// ---------------------------------------------------------------- 工具

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(text, kind) {
  const line = String(text == null ? '' : text);
  S.logLines.push(line);
  if (S.logLines.length > 400) S.logLines.shift();
  if (typeof console !== 'undefined') {
    const method = kind === 'err' ? 'error' : kind === 'warn' ? 'warn' : 'log';
    console[method]('[ddweb]', line);
  }
}

function logAnsi(text) {
  const parsed = parseAnsiColorRgb(text);
  if (typeof console !== 'undefined') console.log('[ddnet]', parsed.message);
}

function toast(message, kind) {
  S.toastCount += 1;
  showToast(R.toastHost, message, kind || 'info');
}

async function copyText(text, message) {
  const value = String(text == null ? '' : text);
  if (!value) {
    toast('没有可复制的内容', 'warn');
    return;
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
    } else {
      fallbackCopy(value);
    }
    toast(message || '已复制', 'ok');
  } catch (error) {
    try {
      fallbackCopy(value);
      toast(message || '已复制', 'ok');
    } catch (fallbackError) {
      toast('复制失败：' + ((fallbackError && fallbackError.message) || fallbackError), 'error');
    }
  }
}

function fallbackCopy(value) {
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('浏览器拒绝了复制操作');
}

function exposeDebugApi() {
  try {
    globalThis.__ddwebDebug = {
      version: '2',
      state: S,
      refs: R,
      assets: S.assets,
      relayStore: S.relayStore,
      entries: () => buildEntries(),
      refreshEnvironment,
      filteredServers: () => filteredServers(),
      isPointerLocked: () => document.pointerLockElement === R.canvas,
      renderAll: () => {
        renderPills();
        renderChecks();
        renderRelayGrid();
        renderServers();
        updateCacheBadge();
        renderWidget();
      },
      measureAllLatency,
      selectRelay,
      connectToRelay,
      enterGame,
      startDirectSession,
      startSession,
      showLoadingView,
      hideLoading,
      closeLoadingView,
      startDownload,
      ensureAssets,
      toggleHud,
      setView,
      setProtocol,
      setTheme,
      device: () => S.device,
      setDevice,
      detectDevice,
      buildDefaultRelayCall,
      buildLaunchArgs,
      enterFullscreenMode,
      requestFullscreenForGame,
      isTouchMode,
      hudShortcutLabel: HUD_SHORTCUT_LABEL,
      deleteRelay,
      measureRelayOnce,
      canDeleteRelay,
      ensureRelays,
      restoreDefaultRelays,
      hiddenRelays: () => S.hiddenRelays.slice(),
      runAutostart,
      ranking: rankRelayEntries,
      buildConnectTarget,
      measureLatency: S.measureLatency,
      fetchServers: (relay, options) => fetchServers(relay, Object.assign({ fetchImpl: S.fetchImpl }, options || {})),
      fetchRelayInfo: (relay, options) => fetchRelayInfo(relay, Object.assign({ fetchImpl: S.fetchImpl }, options || {})),
      buildServersHttpUrl,
      buildInfoHttpUrl,
    };
  } catch (error) {
    // 忽略
  }
}

// 自动启动：真实页面（有 relay-grid 节点）才初始化，便于 Node 冒烟测试手动调用
if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('relay-grid')) {
  bootstrap().catch((error) => {
    if (typeof console !== 'undefined') console.error('[ddweb] 初始化失败', error);
    const host = document.getElementById('toast-host');
    if (host) {
      const node = document.createElement('div');
      node.className = 'toast is-error';
      node.textContent = '页面初始化失败：' + ((error && error.message) || error);
      host.appendChild(node);
    }
  });
}
