# WASM / 前端桥接 API

这些接口用于 DDNet Web 的 Web Shell 与 Emscripten 客户端通信；不是稳定的第三方 SDK，但可以用于自动化、嵌入和调试。

## 启动契约

`Module.arguments` 每个元素都是一整条控制台命令，最后执行 `connect`：

```js
Module.arguments = [
  'cl_touch_controls 0',
  'cl_back_button 0',
  'connect wss://relay.example.com/udp/74.91.126.203:8300?protocol=7',
];
Module.callMain(Module.arguments);
```

不要写成 `['+connect', url]`。

## DDWeb_SetDefaultRelay

在 `callMain` 之前注入默认 relay，让游戏内服务器浏览器拿到的纯 UDP 地址自动改写：

```js
Module.ccall(
  'DDWeb_SetDefaultRelay',
  null,
  ['string', 'string'],
  ['wss://relay.example.com', 'token=secret']
);
```

- 第一个参数：relay base，不带尾斜杠，可含路径
- 第二个参数：已 URL 编码的 query，不带 `?`；没有时传 `''`
- 游戏地址 `host:port` / `tw-0.7+udp://host:port` 会变成
  `<base>/udp/host:port[?query&protocol=7]`

## 鼠标 / 菜单桥接

| 导出 | 说明 |
| --- | --- |
| `DDWeb_SetUiMousePos(x, y)` | 归一化坐标 `0..1`，设置菜单光标目标；`CUi::Update` 会 lerp |
| `DDWeb_SetAbsoluteMouse(0\|1)` | 解锁鼠标时设为 1，禁用相对鼠标增量 |
| `DDWeb_GetUiMouseX()` / `DDWeb_GetUiMouseY()` | 读取当前 UI 光标像素坐标 |
| `DDWeb_IsMenuOpen()` | 返回 1 表示 DDNet 菜单打开 |

示例：

```js
Module.ccall('DDWeb_SetAbsoluteMouse', null, ['number'], [1]);
Module.ccall('DDWeb_SetUiMousePos', null, ['number', 'number'], [0.5, 0.5]);
const menuOpen = Module.ccall('DDWeb_IsMenuOpen', 'number', [], []) === 1;
```

## 文本 / IME / 剪贴板

| 导出 | 说明 |
| --- | --- |
| `DDWeb_InputText(utf8)` | 注入 `SDL_TEXTINPUT`，UTF-8 文本会分块 |
| `DDWeb_InputKey(keysym, pressed)` | 注入 SDL 键盘事件，用于 Backspace/Enter/Esc/方向键 |
| `DDWeb_SetTextInputActive(0\|1)` | 通知网页显示/隐藏 IME 输入桥 |
| `DDWeb_SetClipboardText(text)` | 由 C++ 复制/剪切时调用，写入浏览器剪贴板 |

前端隐藏 textarea 的输入桥位于 `web/src/ime.js`。

## 传输状态

| 全局 | 值 |
| --- | --- |
| `Module.DDWSTransport` | `webrtc` / `ws` / `fallback` |
| `Module.DDWSTransportTarget` | 当前 WebRTC 目标 `host:port` |
| `Module.DDWSStats` | `{ bytesIn, bytesOut }` |
| `globalThis.DDWebIceServers` | 前端传给 wasm 的 STUN/TURN 列表 |

示例：

```js
const transport = globalThis.Module?.DDWSTransport; // 'webrtc' | 'ws' | 'fallback'
const stats = globalThis.Module?.DDWSStats;         // { bytesIn, bytesOut }
```

## WebRTC 优先 / WS 回退

连接 URL：

```text
wss://relay.example.com/udp/host:port?protocol=7
```

- 浏览器先尝试 RTCPeerConnection + DataChannel
- 约 6 秒未建立或信令失败则回退 WebSocket
- `?transport=ws` 强制 WebSocket
- `?transport=webrtc` 用于 WebRTC-only relay：失败也不会回退 WebSocket

## 资源与缓存

前端加载：

```text
DDNet.js
DDNet.wasm
DDNet.data
manifest.json
```

`manifest.json` 包含三个 wasm 资源的 sha256 和大小；前端校验后写入 Cache Storage。

## 构建产物

```text
dist/web/
  DDNet.js
  DDNet.wasm
  DDNet.data
  index.html
  app.js
  style.css
  src/
  wiki/
```

`wiki/` 由 `docs-site/` 的 VitePress 构建后复制。

## 资源并行下载

资源下载器优先使用 HTTP Range 分块：从 1 个并发 worker 快速提升到 8 个，之后只有总吞吐继续提升才逐个增加（默认最多 16 个），
服务器不支持 Range 时回退单流。所有块最终都通过 `manifest.json` 的 size + sha256 校验后才写入
Cache Storage。
