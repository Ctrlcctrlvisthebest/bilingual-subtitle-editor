# 字幕组协作

## 成员操作

1. 打开 [GitHub Pages 双语字幕编辑器](https://ctrlcctrlvisthebest.github.io/bilingual-subtitle-editor/)，展开 **字幕组 · 多人在线校对**。网页自动连接协作服务，成员在这里完成校对，不需要填写后端地址。
2. 组长填写昵称和组名，直接创建字幕组，无需管理员建组密码。创建成功后复制并保存以 `sg1_` 开头的 **组长密钥**，也可以 **下载成员备份**。换设备时粘贴密钥连接，或恢复备份 JSON，即可回到同一个组长身份。密钥和备份都是登录凭证，不是字幕工程。
3. 在编辑器导入已有工程 JSON，点击 **发布当前工程到字幕组**。组内可以保留多个视频工程，发布会建立一个共享副本。
4. 组长生成邀请链接，通过自己常用的方式分享给其他成员。邀请有效期 7 天，可设置加入人数和编辑/只读权限。链接里只有邀请凭证；打开后会从地址栏移除。普通组员通过邀请加入，不使用组长密钥。
5. 成员打开邀请，填写不同的昵称，加入后下载自己的成员备份，选择并打开共享工程。每个人载入自己的同一份本地视频进行听校。
6. 修改自动同步；**立即同步** 可以手动保存。**认领本条** 和 **下一条我认领的待校对字幕** 用于分工，认领是标记，不是独占锁。
7. 收到同条字幕冲突时，比较两份内容，逐项选择 **保留我的修改** 或 **使用组内版本**。解决前不会自动覆盖云端。拆分/合并及顺序冲突同样需要选择。
8. **本条修改记录** 显示作者、时间和前后内容，支持把修改前版本载入为一次新的修订。JSON、ASS、SRT 和带字幕视频导出继续可用。

建议开始工作时先连接、打开共享工程，再编辑。关闭前检查“已保存到字幕组”，也可下载工程 JSON 备份。断网或断开时保留本机草稿；恢复连接并打开同一工程会合入，冲突仍需确认。不能把浏览器暂存当作永久备份。组长换设备可以粘贴组长密钥，普通成员恢复自己的成员备份；旧版 JSON 备份保持兼容。普通成员丢失凭证后可请组长移出旧成员并重新邀请。

组长密钥只交给实际管理这个组的人，不要公开或发给普通组员。持有者会以同一个组长身份进入，并可管理成员、邀请和工程；它不是创建其他组的通用密码。请至少保留一份密钥或成员备份，当前没有邮箱、密码或 GitHub 登录及找回服务。

只读成员可以看字幕、播放视频和导出，不能修改组内工程。组长可以降为只读或移出成员，撤销所有尚未使用的邀请。没有共享视频上传。

## 部署 Cloudflare 协作后端

网页前端部署在 GitHub Pages；Cloudflare 仅负责协作后端。后端采用 Workers 和 SQLite Durable Objects，每个字幕组独立存储成员、邀请、工程和修改历史。前端发布方式见 [README 的 GitHub Pages 部署说明](README.md#部署到-github-pages)。

默认后端为 `https://bilingual-subtitle-editor.zoeli2010xl.workers.dev`。部署者换用其他后端时，需要同步更新前端的后端配置，重新构建并发布 `index.html`；成员无需填写连接地址。

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run types
npm run check
npm run build
npm test
npx wrangler login
```

首次部署需要设置内部签名密钥。使用密码管理器产生至少 32 字节随机值，输入官方 CLI 的交互提示：

```sh
npx wrangler secret put GROUP_SIGNING_KEY
npm run deploy
```

`GROUP_SIGNING_KEY` 仅用于后端内部管理，只保存在 Cloudflare，**已有部署保留原值，不要随意更换**，已有字幕组编号依赖它。`CREATE_GROUP_KEY` 已弃用，无需设置或分发给组长；已有部署中的旧值不会作为网页建组条件。网页向组长提供的 `sg1_` 密钥是该组的登录凭证，与后端签名密钥不同。部署密钥不要写入公开源代码、命令参数、README 或聊天邀请。

`wrangler.jsonc` 已绑定 SQLite Durable Object，无需手动建立 D1 或 R2。默认允许当前 Worker 域名和 `https://ctrlcctrlvisthebest.github.io`，因此 GitHub Pages 网页可以跨域连接后端。如需另一个前端域名，修改 `ALLOWED_ORIGINS`（逗号分隔）后重新部署。构建目录 `dist/` 仅有通用编辑器和响应头，不包含本地工程、音视频、成员备份或开发密钥；GitHub Pages 使用仓库根目录的 `index.html`。

本地开发用 `npm run dev`；`.dev.vars.example` 的测试值只用于 localhost，不能用于线上。`npm test` 会启动隔离的本地 Cloudflare 运行时，测试结束关闭并移除测试数据库。Wrangler 登录状态不会用于上传真实字幕测试数据。

## 同步和数据边界

- 按字幕编号逐条版本校验，不同条目的修改可同时保存。每个批次原子提交；有冲突则整个批次保持未提交。
- 工程属性、颜色/样式和字幕顺序各有版本，批量偏移、拆分、合并和撤销也经过校验。
- 每个工程保存最近 2,000 条变更事件，界面一次显示最近 30 条。导入的初始工程是底稿，不为每条自动产生事件。修订记录不是无限历史或永久备份。
- 字幕最多 20,000 条；工程 JSON 最多 12 MB，单次请求最多 16 MB，均按实际 UTF-8 字节数计算（1 MB = 1,000,000 字节）。单条字幕最多 64 KB，工程属性最多 1 MB。发布和修改使用同一工程容量检查，超过限制的批次不会部分保存。组最多 50 个工程、100 个成员；视频与本机烧录继续在成员电脑上处理。
- 自动保存合并连续输入；在线同步每 5 秒检查，页面隐藏时暂停轮询。它不是逐字同时输入的实时文档。
- 后端只存成员凭证摘要；请求用 HTTPS 和 Bearer 凭证。组长密钥和成员备份持有人拥有对应成员权限，请妥善保存。只读/移出权限由后端校验，不能靠修改网页绕过。
- Cloudflare 资源使用以账号套餐和当前定价为准；不会自动升级套餐。使用量可在 Cloudflare 控制台查看。

实现依据：[Durable Objects SQLite 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Workers 静态资源](https://developers.cloudflare.com/workers/static-assets/)、[Workers 开发规范](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
