// Emscripten 运行时宿主逻辑（与 DOM 解耦，便于 Node 单测）

export const HOME_PATH = '/home/web_user/.local/share/ddnet';

// 对应上游 other/emscripten/index.html 的 Module 配置
export function buildModuleConfig(options = {}) {
  const hooks = options.hooks || {};
  const call = (fn, arg) => {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (error) {
      // hooks 里的异常不应打断 wasm 运行时
    }
  };

  const Module = {
    noInitialRun: true,
    arguments: [],
    print(text) {
      call(hooks.onPrint, String(text));
    },
    printErr(text) {
      call(hooks.onError, String(text));
    },
    monitorRunDependencies(left) {
      call(hooks.onDependencies, left);
    },
    onRuntimeInitialized() {
      call(hooks.onRuntimeInitialized);
    },
    onExit(status) {
      call(hooks.onExit, status);
    },
  };
  if (options.canvas) Module.canvas = options.canvas;
  // 资源来自 Cache Storage 的 blob URL 时，用 locateFile 映射 wasm/data
  if (typeof options.locateFile === 'function') Module.locateFile = options.locateFile;
  // pthread worker 需要能拿到主脚本地址；blob URL 同样可用
  if (options.mainScriptUrlOrBlob) Module.mainScriptUrlOrBlob = String(options.mainScriptUrlOrBlob);
  return Module;
}

// IDBFS 挂载 + 恢复 + callMain（顺序与上游一致）
export async function launchWithModule(options = {}) {
  const Module = options.Module;
  const FS = options.FS;
  const IDBFS = options.IDBFS;
  const homePath = options.homePath || HOME_PATH;
  const args = Array.isArray(options.args) ? options.args.slice() : [];
  const onStep = typeof options.onStep === 'function' ? options.onStep : () => {};

  if (!Module || typeof Module.callMain !== 'function') {
    throw new Error('运行时未提供 callMain，DDNet.js 可能没有正确加载。');
  }
  if (!FS || typeof FS.mkdirTree !== 'function' || typeof FS.mount !== 'function' || typeof FS.syncfs !== 'function') {
    throw new Error('运行时未提供 FS/IDBFS，IndexedDB 文件系统不可用。');
  }
  if (!IDBFS) {
    throw new Error('运行时未提供 IDBFS。');
  }

  onStep('mkdir');
  FS.mkdirTree(homePath);
  onStep('mount');
  FS.mount(IDBFS, {}, homePath);
  onStep('sync');
  await new Promise((resolve, reject) => {
    FS.syncfs(true, (error) => {
      if (error) reject(new Error('无法从 IndexedDB 恢复文件系统：' + (error.message || error)));
      else resolve();
    });
  });

  onStep('callMain');
  Module.arguments = args;
  // 契约：Module.arguments = ["+connect", url]，然后 Module.callMain(Module.arguments)
  const callMain = typeof options.callMain === 'function'
    ? options.callMain
    : (module) => module.callMain(module.arguments);
  return callMain(Module);
}

// 让 Emscripten 输出里的 ANSI 真彩色转成 CSS 颜色
export function parseAnsiColorRgb(line) {
  const text = String(line == null ? '' : line);
  const match = text.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m([\s\S]*?)\x1b\[0m$/);
  if (!match) return { color: '', message: stripAnsi(text) };
  return { color: 'rgb(' + match[1] + ', ' + match[2] + ', ' + match[3] + ')', message: match[4] };
}

export function stripAnsi(line) {
  return String(line == null ? '' : line).replace(/\x1b\[[0-9;]*m/g, '');
}
