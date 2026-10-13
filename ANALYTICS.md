# 网站访问统计

GitHub Pages 版本已接入免费的 [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/about/)。登录 Cloudflare 后，进入 **Observability → Analytics → Web analytics**，选择 `ctrlcctrlvisthebest.github.io`；可按路径 `/bilingual-subtitle-editor/` 筛选字幕编辑器。

可以查看访问次数、页面浏览量、来源、国家地区、设备、浏览器和页面性能，按日期观察变化。Visits 是外部来源或直接进入网站的访问次数，不代表独立用户数；本方案不统计日活、个人留存、当前在线人数或自定义操作次数。

只有 `https://ctrlcctrlvisthebest.github.io/bilingual-subtitle-editor/` 下的网页加载官方统计脚本。本地打开 `index.html`、localhost 预览、离线分享版和小红书版不加载。统计脚本独立于编辑器运行，字幕、音视频和本机文件名不作为统计事件发送，也未添加自定义事件埋点。

站点标识来自 Cloudflare 控制台安装片段，它是可公开放入网页的 beacon token，不是后台 API 密钥。配置在 `web-analytics.js`，由 `web-entry.js` 引用，运行 `npm run build` 后包含在发布页面中。

数据从接入后开始积累，控制台显示可能延迟几分钟。广告拦截或网络问题可能造成漏计。官方目前保留最近六个月的数据；Visits 和 Page Views 应按[官方指标定义](https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/)解释。
