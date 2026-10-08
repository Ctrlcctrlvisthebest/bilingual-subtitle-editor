# 字幕组协作

## 成员操作

1. 打开 [GitHub Pages 双语字幕编辑器](https://ctrlcctrlvisthebest.github.io/bilingual-subtitle-editor/)，展开 **字幕组 · 多人在线校对**。网页会自动填入 `https://bilingual-subtitle-editor.zoeli2010xl.workers.dev`；这是 Cloudflare 协作后端，成员在 GitHub Pages 网页中完成校对。使用自行部署的后端时，可在此修改地址。
2. 组主填写昵称、组名和建组密钥，创建字幕组。随后 **下载成员备份**，私下保存。这个 JSON 是成员登录凭证，不是字幕工程。
3. 在编辑器导入已有工程 JSON，点击 **发布当前工程到字幕组**。组内可以保留多个视频工程，发布会建立一个共享副本。
4. 组主生成邀请链接，通过自己常用的方式分享给其他成员。邀请有效期 7 天，可设置加入人数和编辑/只读权限。链接里只有邀请凭证；打开后会从地址栏移除。
5. 成员打开邀请，填写不同的昵称，加入后下载自己的成员备份，选择并打开共享工程。每个人载入自己的同一份本地视频进行听校。
6. 修改自动同步；**立即同步** 可以手动保存。**认领本条** 和 **下一条我认领的待校对字幕** 用于分工，认领是标记，不是独占锁。
7. 收到同条字幕冲突时，比较两份内容，逐项选择 **保留我的修改** 或 **使用组内版本**。解决前不会自动覆盖云端。拆分/合并及顺序冲突同样需要选择。
8. **本条修改记录** 显示作者、时间和前后内容，支持把修改前版本载入为一次新的修订。JSON、ASS、SRT 和带字幕视频导出继续可用。

建议开始工作时先连接、打开共享工程，再编辑。关闭前检查“已保存到字幕组”，也可下载工程 JSON 备份。断网或断开时保留本机草稿；恢复连接并打开同一工程会合入，冲突仍需确认。不能把浏览器暂存当作永久备份。换设备需恢复成员备份；丢失凭证后可请组主移出旧成员并重新邀请。

只读成员可以看字幕、播放视频和导出，不能修改组内工程。组主可以降为只读或移出成员，撤销所有尚未使用的邀请。当前没有邮箱、密码或 GitHub 登录系统，也没有共享视频上传。

## 部署 Cloudflare 协作后端

网页前端部署在 GitHub Pages；Cloudflare 仅负责协作后端。后端采用 Workers 和 SQLite Durable Objects，每个字幕组独立存储成员、邀请、工程和修改历史。前端发布方式见 [README 的 GitHub Pages 部署说明](README.md#部署到-github-pages)。

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run types
npm run check
npm run build
npm test
npx wrangler login
```

首次部署需要设置两个不同的随机密钥。使用密码管理器产生至少 32 字节随机值，分别输入官方 CLI 的交互提示：

```sh
npx wrangler secret put CREATE_GROUP_KEY
npx wrangler secret put GROUP_SIGNING_KEY
npm run deploy
```

`CREATE_GROUP_KEY` 只提供给需要建组的负责人；普通成员不需要。`GROUP_SIGNING_KEY` 只保存在 Cloudflare，**不要随意更换**，已有字幕组编号依赖它。密钥不要写入公开源代码、命令参数、README 或聊天邀请。

`wrangler.jsonc` 已绑定 SQLite Durable Object，无需手动建立 D1 或 R2。默认允许当前 Worker 域名和 `https://ctrlcctrlvisthebest.github.io`，因此 GitHub Pages 网页可以跨域连接后端。如需另一个前端域名，修改 `ALLOWED_ORIGINS`（逗号分隔）后重新部署。构建目录 `dist/` 仅有通用编辑器和响应头，不包含本地工程、音视频、成员备份或开发密钥；GitHub Pages 使用仓库根目录的 `index.html`。

本地开发用 `npm run dev`；`.dev.vars.example` 的测试值只用于 localhost，不能用于线上。`npm test` 会启动隔离的本地 Cloudflare 运行时，测试结束关闭并移除测试数据库。Wrangler 登录状态不会用于上传真实字幕测试数据。

## 同步和数据边界

- 按字幕编号逐条版本校验，不同条目的修改可同时保存。每个批次原子提交；有冲突则整个批次保持未提交。
- 工程属性、颜色/样式和字幕顺序各有版本，批量偏移、拆分、合并和撤销也经过校验。
- 每个工程保存最近 2,000 条变更事件，界面一次显示最近 30 条。导入的初始工程是底稿，不为每条自动产生事件。修订记录不是无限历史或永久备份。
- 字幕最大 20,000 条、工程约 8 MB；组最多 50 个工程、100 个成员。大参考资料可先从 JSON 中移除。视频与本机烧录继续在成员电脑上处理。
- 自动保存合并连续输入；在线同步每 5 秒检查，页面隐藏时暂停轮询。它不是逐字同时输入的实时文档。
- 后端只存成员凭证摘要；请求用 HTTPS 和 Bearer 凭证。成员备份持有人拥有该成员权限，请妥善保存。只读/移出权限由后端校验，不能靠修改网页绕过。
- Cloudflare 资源使用以账号套餐和当前定价为准；不会自动升级套餐。使用量可在 Cloudflare 控制台查看。

实现依据：[Durable Objects SQLite 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Workers 静态资源](https://developers.cloudflare.com/workers/static-assets/)、[Workers 开发规范](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
