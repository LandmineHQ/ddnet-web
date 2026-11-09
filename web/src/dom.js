// 极简 DOM 构建工具（用 textContent 写入用户数据，避免 XSS）

const BOOLEAN_PROPS = new Set(['disabled', 'checked', 'readOnly', 'multiple', 'selected', 'hidden', 'required']);

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  const attributes = props || {};
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (value == null || value === false) continue;
    if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (BOOLEAN_PROPS.has(key)) {
      node[key] = Boolean(value);
    } else if (key === 'value') {
      node.value = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(node, children) {
  for (const child of children || []) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
}

export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function byId(id) {
  return document.getElementById(id);
}

export function setText(node, text) {
  if (node) node.textContent = text == null ? '' : String(text);
}

export function setHidden(node, hidden) {
  if (node) node.hidden = Boolean(hidden);
}

export function showToast(host, message, kind = 'info', durationMs = 2800) {
  if (!host) return;
  const toast = el('div', { class: 'toast toast-' + kind, role: 'status', text: String(message) });
  host.appendChild(toast);
  // 最多保留 3 条，避免堆叠遮挡页面
  while (host.childNodes.length > 3) {
    if (host.firstChild && host.firstChild.parentNode === host) host.removeChild(host.firstChild);
    else break;
  }
  const remove = () => {
    toast.classList.add('toast-leave');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 220);
  };
  setTimeout(remove, durationMs);
  return toast;
}
