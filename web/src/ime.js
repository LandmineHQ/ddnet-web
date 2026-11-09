// 浏览器 IME / 剪贴板 → wasm DDNet 文本输入桥。
//
// 背景：Emscripten 版 DDNet 的 SDL 只从 canvas 的 keypress 收字符，canvas 不是可编辑元素，
// 所以中文输入法不会弹出候选框，Ctrl+V 也没有可粘贴的目标。这里在浏览器里放一个不可见的
// textarea：引擎进入文本输入（聊天/控制台/名称输入）时聚焦它，组合结束或粘贴后把 UTF-8 文本
// 通过 Module.ccall("DDWeb_InputText") 注入 SDL_TEXTINPUT；Backspace/Enter/Esc/方向键通过
// DDWeb_InputKey 注入 SDL 键盘事件。
//
// 注意：EM_JS 侧只调用 globalThis.ddwebTextInputActive，真正的 DOM 逻辑保留在本文件，方便测试。

const KEY_CODES = Object.freeze({
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Delete: 127,
  ArrowLeft: 1073741904,
  ArrowRight: 1073741903,
  ArrowUp: 1073741906,
  ArrowDown: 1073741905,
  Home: 1073741898,
  End: 1073741901,
});

let activeBridge = null;

function utf8Chunks(text, maxBytes = 30) {
  const chunks = [];
  let chunk = '';
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  for (const char of String(text || '')) {
    const next = chunk + char;
    const size = encoder ? encoder.encode(next).length : next.length;
    if (chunk && size > maxBytes) {
      chunks.push(chunk);
      chunk = char;
    } else {
      chunk = next;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function installImeBridge(options = {}) {
  if (activeBridge) return activeBridge;
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) return null;
  const getModule = typeof options.getModule === 'function' ? options.getModule : () => (typeof Module !== 'undefined' ? Module : globalThis.Module);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const notify = typeof options.notify === 'function' ? options.notify : () => {};

  const area = doc.createElement('textarea');
  area.id = 'ddweb-ime-input';
  area.setAttribute('aria-hidden', 'true');
  area.setAttribute('autocomplete', 'off');
  area.setAttribute('autocorrect', 'off');
  area.setAttribute('autocapitalize', 'off');
  area.setAttribute('spellcheck', 'false');
  area.tabIndex = -1;
  area.style.cssText = [
    'position:fixed', 'left:50%', 'top:50%', 'width:1px', 'height:1px',
    'margin:0', 'padding:0', 'border:0', 'opacity:0', 'background:transparent',
    'color:transparent', 'caret-color:transparent', 'pointer-events:none',
    'z-index:-1', 'transform:translate(-50%,-50%)', 'resize:none', 'overflow:hidden', 'font-size:16px',
  ].join(';');
  doc.body.appendChild(area);

  let active = false;
  let composing = false;
  let justComposed = false;
  let ctrlHeld = false;

  const call = (name, types, args) => {
    const Module = getModule();
    if (!Module || typeof Module.ccall !== 'function') return false;
    try {
      Module.ccall(name, null, types, args);
      return true;
    } catch (error) {
      log('IME 注入失败：' + ((error && error.message) || error), 'warn');
      return false;
    }
  };

  const emitText = (text) => {
    const normalized = String(text || '').replace(/[\r\n]+/g, ' ');
    if (!normalized) return false;
    let sent = false;
    for (const chunk of utf8Chunks(normalized)) {
      sent = call('DDWeb_InputText', ['string'], [chunk]) || sent;
    }
    return sent;
  };

  const emitKeyState = (sym, pressed) => {
    call('DDWeb_InputKey', ['number', 'number'], [sym, pressed ? 1 : 0]);
  };
  const emitKey = (sym) => {
    emitKeyState(sym, true);
    emitKeyState(sym, false);
  };
  // 把 Ctrl+C/X/A 注入游戏：先按住 Ctrl，等游戏处理完再释放，避免
  // Input()->ModifierIsPressed() 在 lineinput 处理按键时已经变回 false。
  const emitShortcut = (sym) => {
    // Ctrl 键本身由真实 keydown Control 注入；若没收到（例如鼠标操作后直接快捷键），
    // 这里兜底按住 Ctrl 一小段时间。Ctrl 的释放跟随真实 keyup，避免 lineinput 处理
    // 按键时 ModifierIsPressed() 已经变回 false。
    if (!ctrlHeld) {
      ctrlHeld = true;
      emitKeyState(1073742048, true);
      setTimeout(() => {
        if (!ctrlHeld) emitKeyState(1073742048, false);
      }, 600);
    }
    emitKeyState(sym, true);
    setTimeout(() => emitKeyState(sym, false), 120);
  };

  const writeClipboard = async (text) => {
    const value = String(text || '');
    if (!value) return true;
    try {
      if (globalThis.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (error) {
      // 继续走 execCommand 兜底
    }
    try {
      const temp = doc.createElement('textarea');
      temp.value = value;
      temp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      doc.body.appendChild(temp);
      temp.select();
      const ok = doc.execCommand('copy');
      temp.remove();
      return ok;
    } catch (error) {
      return false;
    }
  };

  const setClipboardText = (text) => {
    writeClipboard(text).then((ok) => {
      if (!ok) {
        log('复制到系统剪贴板失败（浏览器权限或非安全上下文）', 'warn');
        notify('复制失败：浏览器拒绝剪贴板权限', 'warn');
      }
    }).catch(() => {});
  };

  const setActive = (value) => {
    const next = Boolean(value);
    if (next === active) {
      if (next) {
        try { area.focus({ preventScroll: true }); } catch (error) { /* 忽略 */ }
      }
      return;
    }
    active = next;
    composing = false;
    justComposed = false;
    if (active) {
      area.value = '';
      try { area.focus({ preventScroll: true }); } catch (error) { /* 忽略 */ }
      log('文本输入已激活：使用系统输入法输入中文/粘贴');
    } else {
      area.value = '';
      if (ctrlHeld) {
        ctrlHeld = false;
        emitKeyState(1073742048, false);
      }
      try { area.blur(); } catch (error) { /* 忽略 */ }
    }
  };

  area.addEventListener('compositionstart', () => {
    composing = true;
    justComposed = false;
  });
  area.addEventListener('compositionend', (event) => {
    composing = false;
    justComposed = true;
    const text = event && typeof event.data === 'string' && event.data ? event.data : area.value;
    area.value = '';
    emitText(text);
  });
  area.addEventListener('input', () => {
    if (!active || composing) return;
    const text = area.value;
    area.value = '';
    if (justComposed) {
      justComposed = false;
      return;
    }
    emitText(text);
  });
  area.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData;
    const text = clipboard && typeof clipboard.getData === 'function' ? clipboard.getData('text') : '';
    if (!text) return;
    event.preventDefault();
    emitText(text);
  });
  area.addEventListener('copy', (event) => event.preventDefault());
  area.addEventListener('cut', (event) => event.preventDefault());
  area.addEventListener('keydown', (event) => {
    if (!active || composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Control' || event.key === 'Meta') {
      if (!ctrlHeld) {
        ctrlHeld = true;
        emitKeyState(1073742048, true);
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = String(event.key || '').toLowerCase();
      if (key === 'v') return; // 交给 paste 事件
      if (key === 'c' || key === 'x' || key === 'a') {
        event.preventDefault();
        emitShortcut(key === 'c' ? 99 : key === 'x' ? 120 : 97);
        return;
      }
    }
    const sym = KEY_CODES[event.key];
    if (sym != null) {
      event.preventDefault();
      emitKey(sym);
      return;
    }
    // Ctrl/Cmd+V 不拦截，让浏览器在隐藏 textarea 上触发 paste 事件。
  });
  area.addEventListener('keyup', (event) => {
    if (event.key === 'Control' || event.key === 'Meta') {
      ctrlHeld = false;
      emitKeyState(1073742048, false);
    }
  });

  const canvas = doc.getElementById("canvas");
  if (canvas) {
    doc.addEventListener("pointerdown", (event) => {
      if (!active || event.target !== canvas) return;
      setTimeout(() => {
        if (active) {
          try { area.focus({ preventScroll: true }); } catch (error) { /* 忽略 */ }
        }
      }, 0);
    }, true);
  }

  const bridge = {
    area,
    isActive: () => active,
    setActive,
    emitText,
    emitKey,
    setClipboardText,
    destroy() {
      setActive(false);
      area.remove();
      activeBridge = null;
    },
  };
  activeBridge = bridge;
  globalThis.ddwebTextInputActive = (value) => bridge.setActive(value);
  globalThis.ddwebSetClipboardText = (text) => bridge.setClipboardText(text);
  return bridge;
}

export function getImeBridge() {
  return activeBridge;
}

export { utf8Chunks };
