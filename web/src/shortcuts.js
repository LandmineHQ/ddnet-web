// 快捷键（纯函数）：Ctrl+`（Backquote / ~ 键）显示 / 隐藏「后端连接信息」面板。
// 注意：Esc 组合键被 Windows 系统保留（开始菜单），不能用作 HUD 开关。

export const HUD_SHORTCUT_LABEL = 'Ctrl+`';
export const HUD_SHORTCUT_HINT = 'Ctrl+`（~ 键）';

// 反引号键：优先认 event.code（与键盘布局无关），再回退到 event.key（'`' / '~'）。
export function isBackquoteKeyEvent(event) {
  if (!event) return false;
  const key = typeof event.key === 'string' ? event.key : '';
  const code = typeof event.code === 'string' ? event.code : '';
  if (code === 'Backquote') return true;
  if (key === '`' || key === '~') return true;
  // 兼容极老的浏览器 / 合成事件（CDP 的 rawKeyDown 可能只带 keyCode）
  return Number(event.keyCode) === 192 || Number(event.which) === 192;
}

export function isHudToggleShortcut(event) {
  if (!event) return false;
  if (event.ctrlKey !== true) return false;
  return isBackquoteKeyEvent(event);
}

export function toggleHudVisibility(visible) {
  return !visible;
}

// Ctrl+` 是全局快捷键：输入框 / 对话框内也应生效（由调用方 preventDefault）。
export function shouldIgnoreHudShortcut(event) {
  return false;
}
