// 主题（默认亮色，可切换深色）——纯函数，便于单测
export const THEME_KEY = 'ddweb.theme.v1';
export const THEME_LIGHT = 'light';
export const THEME_DARK = 'dark';

export function normalizeTheme(value) {
  return String(value) === THEME_DARK ? THEME_DARK : THEME_LIGHT;
}

export function loadTheme(storage) {
  try {
    return normalizeTheme(storage && storage.getItem(THEME_KEY));
  } catch (error) {
    return THEME_LIGHT;
  }
}

export function saveTheme(storage, theme) {
  try {
    if (storage) storage.setItem(THEME_KEY, normalizeTheme(theme));
    return true;
  } catch (error) {
    return false;
  }
}

export function nextTheme(theme) {
  return normalizeTheme(theme) === THEME_DARK ? THEME_LIGHT : THEME_DARK;
}

export function applyTheme(element, theme) {
  const normalized = normalizeTheme(theme);
  try {
    if (element && typeof element.setAttribute === 'function') {
      element.setAttribute('data-theme', normalized);
    }
  } catch (error) {
    // 忽略
  }
  return normalized;
}

// 切换按钮文案：亮色时提示「深色」，深色时提示「亮色」
export function themeToggleLabel(theme) {
  return normalizeTheme(theme) === THEME_DARK ? '亮色' : '深色';
}

export function themeToggleIcon(theme) {
  return normalizeTheme(theme) === THEME_DARK ? '☀' : '☾';
}
