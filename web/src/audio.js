// 用户手势解锁音频：包装 AudioContext，启动时 resume 并播放静音缓冲

export function installAudioUnlock(win = globalThis) {
  const OriginalCtor = win && (win.AudioContext || win.webkitAudioContext);
  const contexts = [];
  if (typeof OriginalCtor !== 'function') {
    return { supported: false, contexts, unlock: async () => false };
  }

  let Patched = null;
  try {
    Patched = class UnlockedAudioContext extends OriginalCtor {
      constructor(...args) {
        super(...args);
        contexts.push(this);
      }
    };
    win.AudioContext = Patched;
    if (win.webkitAudioContext) win.webkitAudioContext = Patched;
  } catch (error) {
    Patched = null;
  }

  async function unlock() {
    const created = [];
    for (const context of contexts) {
      try {
        if (context.state === 'suspended') await context.resume();
      } catch (error) {
        // 忽略单个上下文失败
      }
    }
    try {
      let context = contexts[0];
      if (!context) {
        context = new (Patched || OriginalCtor)();
        if (Patched) contexts.push(context);
        created.push(context);
      }
      const sampleRate = context.sampleRate || 44100;
      const buffer = context.createBuffer(1, 1, sampleRate);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0);
      if (context.state === 'suspended') await context.resume();
      return context.state === 'running' || context.state === 'suspended';
    } catch (error) {
      return false;
    }
  }

  function resumeAll() {
    for (const context of contexts) {
      if (context.state === 'suspended') {
        try {
          const result = context.resume();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (error) {
          // 忽略
        }
      }
    }
  }

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('pointerdown', resumeAll, true);
    win.addEventListener('keydown', resumeAll, true);
  }

  return { supported: Boolean(Patched || OriginalCtor), contexts, unlock, resumeAll };
}
