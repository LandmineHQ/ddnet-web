// 设备 / 触屏检测（纯函数 + 少量可在 Node 里安全调用的 DOM 辅助）
//
// 检测信号（任一即可判定为触屏设备）：
//   - 主指针为 coarse（matchMedia('(pointer: coarse)')）
//   - navigator.maxTouchPoints > 0
//   - UA-CH navigator.userAgentData.mobile === true
//   - UA 字符串里出现手机 / 平板标识
//   - 小屏 + 触摸（短边 <= SMALL_SCREEN_MAX）
// 细分：
//   - phone / 小屏触摸 / UA 手机 → mobile
//   - 平板 UA / 大屏触摸 / coarse 指针 → tablet
//   - 没有任何触摸 / 手机 / 平板信号的设备 → desktop
// 所有入参都可缺省：jsdom 里没有 matchMedia / screen / 触摸点时退化为 desktop。

export const DEVICE_KIND = Object.freeze({
  mobile: 'mobile',
  tablet: 'tablet',
  desktop: 'desktop',
});

// 短边 <= 700 CSS px 视为小屏（手机横屏 844x390 命中；1366x768 触屏笔记本不命中）
export const SMALL_SCREEN_MAX = 700;

const UA_TABLET_RE = /(?:iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile))/i;
const UA_MOBILE_RE = /(?:Mobi|iPhone|iPod|Windows Phone|IEMobile|Opera Mini)/i;
// 桌面操作系统：即使带触摸屏/触控显示器，只要不是移动 UA，也按桌面处理。
const UA_DESKTOP_OS_RE = /(?:Windows NT|X11; Linux|Macintosh|CrOS)/i;

export function normalizeDeviceKind(value) {
  return value === DEVICE_KIND.mobile || value === DEVICE_KIND.tablet ? value : DEVICE_KIND.desktop;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function detectDevice(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const userAgent = typeof source.userAgent === 'string' ? source.userAgent : '';
  const maxTouchPoints = Math.floor(positiveNumber(source.maxTouchPoints));
  const media = source.media && typeof source.media === 'object' ? source.media : null;
  const coarse = Boolean(media && (media.coarse === true || media.anyCoarse === true));
  const fine = Boolean(media && media.fine === true);
  const screen = source.screen && typeof source.screen === 'object' ? source.screen : null;
  const width = positiveNumber(screen && screen.width);
  const height = positiveNumber(screen && screen.height);
  const smallScreen = width > 0 && height > 0 && Math.min(width, height) <= SMALL_SCREEN_MAX;
  const uaChMobile = source.uaMobile === true;
  const uaMobileRegex = UA_MOBILE_RE.test(userAgent);
  const uaTabletRegex = UA_TABLET_RE.test(userAgent);
  const uaMobile = uaChMobile || uaMobileRegex;
  const uaTablet = uaTabletRegex;
  const uaDesktopOS = UA_DESKTOP_OS_RE.test(userAgent) && !uaMobile && !uaTablet;
  const touchPoints = maxTouchPoints > 0;
  const touch = touchPoints || coarse || uaMobile || uaTablet;

  let kind = DEVICE_KIND.desktop;
  let reason = 'no-touch-signal';
  if (uaTabletRegex && !uaChMobile) {
    kind = DEVICE_KIND.tablet;
    reason = 'ua-tablet';
  } else if (uaChMobile) {
    // UA-CH 的 mobile 标记优先级最高；平板按屏幕大小区分
    kind = smallScreen ? DEVICE_KIND.mobile : DEVICE_KIND.tablet;
    reason = 'ua-ch-mobile';
  } else if (uaMobileRegex && maxTouchPoints > 1 && !smallScreen) {
    // iPadOS 13+ 默认伪装成桌面 Safari，UA 里有 Mobile 但屏幕很大、多点触控 → 平板
    kind = DEVICE_KIND.tablet;
    reason = 'ua-mobile-large-touch';
  } else if (uaMobileRegex) {
    kind = DEVICE_KIND.mobile;
    reason = 'ua-mobile';
  } else if (touchPoints && fine && !coarse) {
    // 触屏笔记本：主指针仍是精确鼠标 → 桌面模式。
    kind = DEVICE_KIND.desktop;
    reason = 'touch-fine-desktop';
  } else if (uaDesktopOS && !smallScreen) {
    // Windows/Linux/macOS/ChromeOS 桌面（含触屏一体机、触控显示器）：
    // 只要不是移动 UA 且屏幕不小，就按桌面处理，不显示触控 UI。
    kind = DEVICE_KIND.desktop;
    reason = 'desktop-os-large-screen';
  } else if (touch && smallScreen) {
    kind = DEVICE_KIND.mobile;
    reason = 'small-screen-touch';
  } else if (coarse) {
    kind = smallScreen ? DEVICE_KIND.mobile : DEVICE_KIND.tablet;
    reason = 'coarse-pointer';
  } else if (touchPoints) {
    kind = smallScreen ? DEVICE_KIND.mobile : DEVICE_KIND.tablet;
    reason = 'touch-points';
  }

  return {
    kind,
    reason,
    touch,
    touchPoints: maxTouchPoints,
    coarse,
    fine,
    smallScreen,
    uaMobile,
    uaTablet,
    uaDesktopOS,
    width,
    height,
    isMobile: kind === DEVICE_KIND.mobile,
    isTablet: kind === DEVICE_KIND.tablet,
    isDesktop: kind === DEVICE_KIND.desktop,
    // 是否使用 DDNet 内置触屏控制（mobile / tablet）
    touchMode: kind !== DEVICE_KIND.desktop,
  };
}

// 从 window / navigator / screen 读取环境，任何一步失败都不抛异常。
export function detectDeviceFromWindow(win) {
  const nav = (win && win.navigator) || {};
  let media = null;
  try {
    if (win && typeof win.matchMedia === 'function') {
      const query = (text) => {
        try {
          const result = win.matchMedia(text);
          return Boolean(result && result.matches);
        } catch (error) {
          return false;
        }
      };
      media = {
        coarse: query('(pointer: coarse)'),
        fine: query('(pointer: fine)'),
        anyCoarse: query('(any-pointer: coarse)'),
      };
    }
  } catch (error) {
    media = null;
  }

  let uaMobile = false;
  try {
    uaMobile = Boolean(nav.userAgentData && nav.userAgentData.mobile === true);
  } catch (error) {
    uaMobile = false;
  }

  let width = 0;
  let height = 0;
  try {
    const screenInfo = win && win.screen;
    width = positiveNumber(screenInfo && screenInfo.width);
    height = positiveNumber(screenInfo && screenInfo.height);
  } catch (error) {
    width = 0;
    height = 0;
  }
  if (!width || !height) {
    width = positiveNumber(win && win.innerWidth);
    height = positiveNumber(win && win.innerHeight);
  }

  return detectDevice({
    userAgent: typeof nav.userAgent === 'string' ? nav.userAgent : '',
    maxTouchPoints: nav.maxTouchPoints,
    media,
    screen: { width, height },
    uaMobile,
  });
}

// <html data-device="mobile|tablet|desktop"> + <body class="is-mobile|is-tablet|is-desktop [has-touch]">
export function applyDeviceAttributes(doc, device) {
  const kind = normalizeDeviceKind(device && device.kind);
  try {
    const root = doc && doc.documentElement;
    if (root) {
      if (root.dataset && typeof root.dataset === 'object') root.dataset.device = kind;
      if (typeof root.setAttribute === 'function') root.setAttribute('data-device', kind);
    }
  } catch (error) {
    // 忽略
  }
  try {
    const body = doc && doc.body;
    if (body && body.classList) {
      for (const name of ['is-mobile', 'is-tablet', 'is-desktop', 'has-touch']) body.classList.remove(name);
      body.classList.add('is-' + kind);
      if (device && device.touch) body.classList.add('has-touch');
    }
  } catch (error) {
    // 忽略
  }
  return kind;
}

// 用户手势内请求全屏 + 横屏锁定；失败（无权限 / 浏览器不支持 / 自动化环境）静默忽略。
export function requestImmersive(win, doc) {
  const result = { fullscreen: false, orientation: false, error: '' };
  const element = doc && (doc.documentElement || doc.body);
  let orientation = null;
  try {
    orientation = win && win.screen && win.screen.orientation;
  } catch (error) {
    orientation = null;
  }
  // 横屏锁定通常要求页面已进入全屏，所以优先在全屏 promise 完成后调用。
  const lockLandscape = () => {
    if (!orientation || typeof orientation.lock !== 'function') return;
    try {
      const pending = orientation.lock('landscape');
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      result.orientation = true;
    } catch (error) {
      // 忽略：iOS Safari 等不支持锁定横屏
    }
  };
  try {
    const alreadyFullscreen = Boolean(doc && doc.fullscreenElement);
    if (!alreadyFullscreen && element && typeof element.requestFullscreen === 'function') {
      const pending = element.requestFullscreen({ navigationUI: 'hide' });
      result.fullscreen = true;
      if (pending && typeof pending.then === 'function') {
        pending.then(() => lockLandscape(), () => {});
      } else {
        lockLandscape();
      }
    } else {
      lockLandscape();
    }
  } catch (error) {
    result.error = (error && error.message) || String(error);
    lockLandscape();
  }
  return result;
}
