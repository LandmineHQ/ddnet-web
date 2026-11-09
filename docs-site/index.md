---
layout: home

hero:
  name: DDNet Web
  text: Wiki
  tagline: 浏览器 DDNet 客户端、WebRTC/WS relay、relay master 与 WASM 桥接的完整说明。
  image:
    src: /logo.svg
    alt: DDNet Web
  actions:
    - theme: brand
      text: 搭建 relay 节点
      link: /guide/relay-node
    - theme: alt
      text: API 参考
      link: /api/relay

features:
  - title: Relay 节点
    details: WebRTC DataChannel 优先、WebSocket 回退，转发到任意 DDNet 0.6/0.7 服务器。
  - title: Relay Master
    details: 节点注册、WSS/WebRTC 逐项验证、15 分钟存活检查和 /v1/serverlist 下发。
  - title: WASM 桥接
    details: 启动参数、默认 relay、鼠标/IME/剪贴板和传输状态 API。
  - title: 两种部署
    details: Docker Compose 使用 GHCR 镜像，或直接运行 linux/amd64 静态二进制。
---
