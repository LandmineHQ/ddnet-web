import DefaultTheme from 'vitepress/theme';
import { defineComponent, h } from 'vue';
import { useData } from 'vitepress';
import './custom.css';

const BackToClient = defineComponent({
  name: 'BackToClient',
  setup() {
    const { site } = useData();
    const home = () => {
      const base = site.value.base || '/wiki/';
      return base.endsWith('wiki/') ? base.slice(0, -'wiki/'.length) : '/';
    };
    return () =>
      h(
        'a',
        {
          class: 'VPNavBarMenuLink back-to-client',
          href: home(),
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            window.location.assign(home());
          },
        },
        '返回客户端'
      );
  },
});

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(BackToClient),
    });
  },
};
