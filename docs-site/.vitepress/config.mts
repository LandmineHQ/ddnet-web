import { defineConfig } from 'vitepress';

const base = process.env.VITEPRESS_BASE || '/wiki/';

export default defineConfig({
  lang: 'zh-CN',
  title: 'DDNet Web Wiki',
  description: 'DDNet Web 客户端、relay、relay master 的使用与 API 文档',
  base,
  srcExclude: [],
  cleanUrls: false,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#ffa500' }],
    ['link', { rel: 'icon', href: `${base}logo.svg` }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'DDNet Web Wiki',
    nav: [
      { text: '指南', link: '/guide/relay-node' },
      { text: 'API', link: '/api/relay' },
      { text: '返回客户端', link: '/../' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '部署指南',
          items: [
            { text: '搭建 relay 节点', link: '/guide/relay-node' },
            { text: '使用 Docker Compose', link: '/guide/compose' },
            { text: '使用二进制文件', link: '/guide/binary' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API 参考',
          items: [
            { text: 'Relay API', link: '/api/relay' },
            { text: 'Relay Master API', link: '/api/master' },
            { text: 'WASM / 前端桥接 API', link: '/api/wasm' },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: '本页目录' },
    search: { provider: 'local' },
    docFooter: { prev: '上一页', next: '下一页' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到亮色',
    darkModeSwitchTitle: '切换到深色',
    footer: {
      message: 'DDNet Web — 浏览器 DDNet 客户端与 relay 节点',
      copyright: '请遵守 DDNet 与游戏服务器规则',
    },
  },
});
