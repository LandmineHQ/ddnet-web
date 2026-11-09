// 极简 DOM 垫片：仅用于 Node 下冒烟测试 app.js 的初始化/渲染路径（不是浏览器实现）

// 极简选择器引擎（tag / .class / #id / [attr] / [attr="value"] / :not(简单选择器) / 后代组合）
function matchesSimple(node, part) {
  if (!node || node.nodeType !== 1) return false;
  let index = 0;
  const tagMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(part);
  if (tagMatch) {
    if (String(node.tagName || '').toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    index = tagMatch[0].length;
  }
  while (index < part.length) {
    const rest = part.slice(index);
    if (rest[0] === '.') {
      const match = /^\.([A-Za-z0-9_-]+)/.exec(rest);
      if (!match) return false;
      if (!node.classList || !node.classList.contains(match[1])) return false;
      index += match[0].length;
    } else if (rest[0] === '#') {
      const match = /^#([A-Za-z0-9_-]+)/.exec(rest);
      if (!match) return false;
      if (node.getAttribute('id') !== match[1]) return false;
      index += match[0].length;
    } else if (rest[0] === '[') {
      const end = rest.indexOf(']');
      if (end < 0) return false;
      const body = rest.slice(1, end);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        const name = body.slice(0, eq).trim();
        const value = body.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (node.getAttribute(name) !== value) return false;
      } else if (node.getAttribute(body.trim()) == null) {
        return false;
      }
      index += end + 1;
    } else if (rest.indexOf(':not(') === 0) {
      const end = rest.indexOf(')');
      if (end < 0) return false;
      const inner = rest.slice(5, end);
      if (matchesSimple(node, inner)) return false;
      index += end + 1;
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelector(node, selector) {
  const text = String(selector || '').trim();
  if (!text) return false;
  const parts = text.split(/\s+/);
  if (parts.length === 1) return matchesSimple(node, parts[0]);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentNode;
  while (ancestor) {
    if (ancestor.nodeType === 1 && matchesSelector(ancestor, parts.slice(0, -1).join(' '))) return true;
    ancestor = ancestor.parentNode;
  }
  return false;
}

export function createDomShim() {
  const ids = new Map();

  class FakeClassList {
    constructor(node) {
      this.node = node;
      this.set = new Set();
    }
    add(...names) {
      for (const name of names) if (name) this.set.add(name);
    }
    remove(...names) {
      for (const name of names) this.set.delete(name);
    }
    contains(name) {
      return this.set.has(name);
    }
    toggle(name, force) {
      const on = force === undefined ? !this.set.has(name) : Boolean(force);
      if (on) this.set.add(name);
      else this.set.delete(name);
      return on;
    }
  }

  class FakeText {
    constructor(text) {
      this.nodeType = 3;
      this._text = String(text);
    }
    get textContent() {
      return this._text;
    }
    set textContent(value) {
      this._text = String(value);
    }
  }

  class FakeNode {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = {};
      this.style = {};
      this.dataset = {};
      this.classList = new FakeClassList(this);
      this.listeners = {};
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.files = [];
      this.open = false;
      this.title = '';
      this._text = '';
    }

    get className() {
      return Array.from(this.classList.set).join(' ');
    }

    set className(value) {
      this.classList.set = new Set(String(value == null ? '' : value).split(/\s+/).filter(Boolean));
    }

    get textContent() {
      if (this.childNodes.length) return this.childNodes.map((child) => child.textContent).join('');
      return this._text;
    }

    set textContent(value) {
      this.childNodes = [];
      this._text = value == null ? '' : String(value);
    }

    get firstChild() {
      return this.childNodes[0] || null;
    }

    appendChild(node) {
      if (!node) return node;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }

    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index >= 0) this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    }

    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') ids.set(String(value), this);
      if (name === 'open') this.open = true;
      if (name === 'hidden') this.hidden = true;
    }

    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }

    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'open') this.open = false;
      if (name === 'hidden') this.hidden = false;
    }

    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    }

    addEventListener(type, handler) {
      if (typeof handler !== 'function') return;
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    }

    removeEventListener(type, handler) {
      const list = this.listeners[type];
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    }

    dispatchEvent(event) {
      const payload = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, event || {});
      const list = this.listeners[payload.type] || [];
      for (const handler of list.slice()) handler(payload);
      const inline = this['on' + payload.type];
      if (typeof inline === 'function') inline(payload);
      return true;
    }

    click() {
      return this.dispatchEvent({ type: 'click' });
    }

    focus() {}
    blur() {}
    select() {}
    scrollIntoView() {}
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 };
    }
    getContext(type) {
      return type === 'webgl2' ? { name: 'webgl2' } : null;
    }
    showModal() {
      this.open = true;
    }
    close() {
      const wasOpen = this.open;
      this.open = false;
      if (wasOpen) this.dispatchEvent({ type: 'close' });
    }
    matches(selector) {
      return matchesSelector(this, selector);
    }
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (matchesSelector(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const progressNode = new FakeNode('div');
  progressNode.setAttribute('aria-label', '资源加载进度');
  const heroNode = new FakeNode('section');

  const body = new FakeNode('body');
  const documentElement = new FakeNode('html');
  documentElement.requestFullscreen = () => Promise.resolve();

  const documentEvents = {};
  const document = {
    body,
    documentElement,
    fullscreenElement: null,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(text),
    getElementById: (id) => ids.get(String(id)) || null,
    querySelector: (selector) => {
      if (selector === '.progress') return progressNode;
      if (selector === '.panel-hero') return heroNode;
      return document.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll: (selector) => {
      if (selector === '.progress') return [progressNode];
      if (selector === '.panel-hero') return [heroNode];
      const found = [];
      const seen = new Set();
      const walk = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (node.nodeType === 1 && matchesSelector(node, selector)) found.push(node);
        for (const child of node.childNodes) if (child.nodeType === 1) walk(child);
      };
      walk(body);
      for (const node of ids.values()) walk(node);
      return found;
    },
    addEventListener: (type, handler) => {
      if (!documentEvents[type]) documentEvents[type] = [];
      documentEvents[type].push(handler);
    },
    removeEventListener: (type, handler) => {
      const list = documentEvents[type] || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent: (event) => {
      for (const handler of (documentEvents[event.type] || []).slice()) handler(event);
      return true;
    },
    execCommand: () => true,
    exitFullscreen: () => {
      document.fullscreenElement = null;
      return Promise.resolve();
    },
  };

  function loadIndexHtml(html) {
    ids.clear();
    ids.set('__progress__', progressNode);
    // 逐个解析带 id 的开始标签，保留 hidden / open / disabled 等初始属性
    const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let match;
    while ((match = tagRe.exec(html))) {
      const tag = match[1].toLowerCase();
      const attrs = match[2] || '';
      const idMatch = attrs.match(/\bid="([^"]+)"/);
      if (!idMatch) continue;
      const node = new FakeNode(tag);
      node.setAttribute('id', idMatch[1]);
      if (/\shidden(?:\s|$|=)/.test(attrs)) node.hidden = true;
      if (tag === 'dialog' && /\sopen(?:\s|$|=)/.test(attrs)) node.open = true;
      if (/\sdisabled(?:\s|$|=)/.test(attrs)) node.disabled = true;
      ids.set(idMatch[1], node);
    }
    return ids;
  }

  return { FakeNode, FakeText, document, body, documentElement, ids, loadIndexHtml, progressNode, heroNode };
}
