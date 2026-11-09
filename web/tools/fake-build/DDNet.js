// 测试/演示用的假 DDNet Emscripten 构建产物（不是真正的客户端）
// 提供与上游启动器一致的 FS / IDBFS / Module 接口，用于本地验证启动流程。
(function () {
  'use strict';
  var root = typeof globalThis !== 'undefined' ? globalThis : this;
  var stats = {
    mkdirTree: 0,
    mkdirTreePath: null,
    mount: null,
    syncfs: [],
    callMain: [],
    prints: [],
    exits: [],
  };

  var FS = {
    mkdirTree: function (target) {
      stats.mkdirTree += 1;
      stats.mkdirTreePath = target;
    },
    mount: function (type, options, mountpoint) {
      stats.mount = { type: type, options: options, mountpoint: mountpoint };
    },
    syncfs: function (populate, callback) {
      stats.syncfs.push(Boolean(populate));
      setTimeout(function () {
        callback(null);
      }, 5);
    },
  };
  var IDBFS = { database: 'ddweb-fake-idbfs' };

  root.FS = FS;
  root.IDBFS = IDBFS;

  var Module = typeof root.Module !== 'undefined' && root.Module ? root.Module : {};
  root.Module = Module;

  Module.SDL2 = Module.SDL2 || {};

  Module.callMain = function (args) {
    stats.callMain.push(Array.isArray(args) ? args.slice() : []);
    if (typeof Module.print === 'function') {
      Module.print('[fake-build] callMain ' + JSON.stringify(args));
    }
    setTimeout(function () {
      stats.exits.push(0);
      if (typeof Module.onExit === 'function') Module.onExit(0);
    }, 10);
    return 0;
  };

  setTimeout(function () {
    if (typeof Module.onRuntimeInitialized === 'function') Module.onRuntimeInitialized();
  }, 5);

  root.__ddwebFakeBuildStats = stats;
})();
