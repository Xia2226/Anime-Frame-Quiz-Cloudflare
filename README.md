# 看图猜番 · Anime Frame Quiz

<p align="center">
  <a href="https://animeframequiz.cn"><img src="https://img.shields.io/badge/在线体验-animeframequiz.cn-4f6df5?style=for-the-badge" alt="在线体验" /></a>
  <a href="https://github.com/Xia2226/Anime-Frame-Quiz-Cloudflare"><img src="https://img.shields.io/badge/运行环境-Cloudflare%20Workers-f38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/许可证-MIT-2ea44f?style=for-the-badge" alt="MIT License" /></a>
</p>

<p align="center">从一帧动画画面，认出一部番剧。</p>

一个面向动画爱好者的在线看图猜番游戏。它将题库筛选、答题节奏、每日排行榜、反馈闭环和题库运营整合在一个轻量 Web 应用中，并部署在 Cloudflare Workers、Static Assets 与 D1 上。

**[立即开始游戏](https://animeframequiz.cn)** · **[查看题库工具](https://github.com/Xia2226/AnimeShotDB-tools)** · **[报告问题](https://github.com/Xia2226/Anime-Frame-Quiz-Cloudflare/issues)**

## 目录

- [玩法与功能](#玩法与功能)
- [运行架构](#运行架构)
- [快速开始](#快速开始)
- [部署到 Cloudflare](#部署到-cloudflare)
- [题库与维护工具](#题库与维护工具)
- [项目结构](#项目结构)
- [API 一览](#api-一览)
- [安全、数据与版权](#安全数据与版权)
- [开发与贡献](#开发与贡献)

## 玩法与功能

| 模式 | 适合谁 | 规则与特点 |
| --- | --- | --- |
| **经典模式** | 想快速挑战的玩家 | 随机抽取 50 部番剧；每题 10 秒；根据剩余时间获得 10 / 8 / 6 / 4 / 2 分；完成后可参与每日榜单。 |
| **自由模式** | 想针对练习的玩家 | 可按首播日期、评分、排名、评分人数、完成人数、截图数及 Bangumi 标签组合筛选；支持 25 / 50 / 75 / 100 题与关闭倒计时；不参与排行榜。 |
| **困难挑战** | 想测试阅片量的玩家 | 从 Sakugabooru 在线获取动画视频候选，在浏览器中随机抽帧；答满至少 50 题后按正确率参与每日榜单。 |

此外还包括：

- **每日排行榜**：经典模式按得分排序；困难挑战按正确率、题量和用时排序；同一参与者只保留当天最佳成绩。
- **图库统计**：展示题库的年代、评分、标签与新增番剧情况，入口为 `/library.html`。
- **反馈闭环**：玩家可以提交番剧错误、缺陷或功能建议；后台可统一查看和处理。
- **运营后台**：支持管理榜单、访问数据、反馈、番剧启停与站内公告，入口为 `/admin.html`。
- **顺滑答题体验**：经典与自由模式在开局预解码 5 道题，并持续预加载后续画面，避免逐题请求服务端。

> 困难挑战需要玩家自行提供 DeepSeek API Key，用于批量解析作品名。Key 仅保存在当前浏览器会话，通过请求头使用；不会写入源码、D1 或日志。

## 运行架构

~~~mermaid
flowchart LR
    U["浏览器"] --> S["Cloudflare Static Assets<br/>页面、样式、脚本与题库"]
    U --> W["Cloudflare Worker<br/>API、校验、安全边界与代理"]
    W <--> D["Cloudflare D1<br/>榜单、反馈、统计、启停状态与公告"]
    W --> F["第三方服务<br/>FanCaps · Sakugabooru · DeepSeek"]
~~~

浏览器负责抽题、干扰项、计时、计分和图片预加载；Worker 只承担服务端必须处理的 API、输入校验、第三方代理和安全响应头。因此经典和自由模式不会为每一道题发起 Worker 或 D1 请求。

项目针对 Cloudflare 免费版资源边界设计：静态文件由 CDN 直接提供，排行榜短缓存，题库合并结果在 Worker Cache API 缓存一小时。题库 ETag 与 D1 启停版本共同参与缓存键，因此重新部署题库或在后台启停番剧后，下一次请求会读取新版本。

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/) **22.19.0 或更高版本**
- npm（随 Node.js 安装）
- 仅本地运行时无需 Cloudflare 账号；部署时需要 Cloudflare 账号与 Wrangler 登录状态

~~~powershell
git clone https://github.com/Xia2226/Anime-Frame-Quiz-Cloudflare.git
cd Anime-Frame-Quiz-Cloudflare
npm install
npm run db:migrate:local
npm start
~~~

Wrangler 默认会在 <http://localhost:8787> 启动本地 Worker 和静态资源。仓库已经包含可运行的精简题库，首次启动不需要下载图片原始文件或生成题目。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动本地 Worker 与 Static Assets。 |
| `npm test` | 运行 Node 原生单元测试。 |
| `npm run check:data` | 校验当前题库和旧题库快照的结构、统计及唯一性。 |
| `npm run check:js` | 自动发现并检查版本库中的 JS / MJS 源文件。 |
| `npm run check:deploy` | 执行 Wrangler 部署 dry-run。 |
| `npm run check` | 依次运行测试、题库校验、JS 检查和部署检查。 |
| `npm run db:migrate:local` | 应用本地 D1 迁移。 |
| `npm run db:migrate:remote` | 应用远程 D1 迁移。 |
| `npm run deploy` | 部署到 Cloudflare。 |

## 部署到 Cloudflare

1. 登录 Wrangler，并创建 D1 数据库。

   ~~~powershell
   npx wrangler login
   npx wrangler d1 create anime-frame-quiz-leaderboard
   ~~~

2. 将命令输出的 `database_id` 写入 [wrangler.jsonc](./wrangler.jsonc)，并保持 D1 绑定名为 `DB`。

3. 应用生产迁移、完成检查并部署。

   ~~~powershell
   npm run db:migrate:remote
   npm run check
   npm run deploy
   ~~~

如需绑定自定义域名，请在 Cloudflare Dashboard 中为该 Worker 配置路由或自定义域。正式上线前，请务必为 `/admin.html` 与 `/api/admin/*` 配置 [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) 或等效的访问控制；项目不内置管理员登录系统，直接公开这些接口会使后台暴露在公网。

## 题库与维护工具

项目运行时使用两份已提交的精简 JSON：

- [public/data/anime-library.json](./public/data/anime-library.json)：当前 v2 题库，供游戏、图库和后台共同使用。
- [public/data/anime-library-old.json](./public/data/anime-library-old.json)：上一版 v1 快照，仅用于图库的“新增番剧”统计。

当前题库收录 **2,170 部番剧、141,646 张截图与 3,708 个标签**。截图文件本身不在仓库中；题目图片由 `imageBase + imageId + .jpg` 指向 FanCaps CDN。本地 `covers/` 若存在，仅用于图库缩略图，不是运行游戏的必要条件。

维护工具所需的原始 FanCaps 截图索引 `resources/fancaps_anime_images.jsonl` 也随仓库提交，供删除错误截图等维护脚本使用；`resources/` 下其余大文件仍不纳入版本库。

### AnimeShotDB-tools

完整的题库构建、更新、原始 FanCaps 数据维护和冲突复核由独立仓库 **[Xia2226/AnimeShotDB-tools](https://github.com/Xia2226/AnimeShotDB-tools)** 负责。

~~~text
https://github.com/Xia2226/AnimeShotDB-tools
~~~

这是可选的维护工具，**不是本项目的运行依赖**：不下载该仓库，仍可安装、运行、检查和部署本项目。仅在需要重建、追加、清洗或人工复核图库数据时使用它；其中的参数与安全流程以该仓库自身的 README 为准。

推荐更新流程：

1. 以本项目的 `public/data/anime-library.json` 作为权威 v2 基线。
2. 在 [AnimeShotDB-tools](https://github.com/Xia2226/AnimeShotDB-tools) 中先执行 dry-run，再生成并校验新数据。
3. 人工核对更新报告与隔离报告。
4. 更新当前题库；如需展示“新增”统计，再同步更新旧题库快照。
5. 回到本项目执行 `npm run check`；若有新迁移，先应用迁移后再部署。

仓库还保留 [scripts/remove-anime-image.mjs](./scripts/remove-anime-image.mjs) 与 `删除番剧图片.bat`，用于删除单张错误截图。这一维护入口使用仓库内已提交的原始数据文件 `resources/fancaps_anime_images.jsonl`（FanCaps 截图索引），普通运行和部署无需使用。

## 项目结构

~~~text
├── migrations/                       # D1：榜单、反馈、统计、启停、公告与缓存版本
├── public/
│   ├── data/                         # 当前题库与旧题库快照
│   ├── js/                           # 游戏配置、题库、困难模式、榜单与游戏引擎
│   ├── index.html / app.js           # 首页与游戏编排
│   ├── library.html / library.js     # 图库统计页
│   ├── admin.html / admin.js         # 管理后台
│   └── _headers                      # 静态资源安全头与缓存规则
├── scripts/                          # 可选的本地题库维护脚本
├── src/http.mjs                      # HTTP、重试、流式限长与安全头工具
├── test/                             # 回归测试
├── tools/                            # 题库与 JavaScript 校验工具
├── worker.mjs                        # Worker 路由、D1 与业务入口
├── wrangler.jsonc                    # Cloudflare 配置
└── package.json                      # 脚本与依赖
~~~

游戏规则集中于 [public/js/game-config.js](./public/js/game-config.js)，浏览器与 Worker 共享同一份配置，避免题量、计分和排行榜校验产生漂移。修改规则后请运行 `npm run check`，并同步核对页面文案与服务端校验。

## API 一览

| 分类 | 端点 | 方法 | 说明 |
| --- | --- | --- | --- |
| 困难挑战 | `/api/deepseek/validate` | `POST` | 校验访问者的 DeepSeek Key、模型权限与余额。 |
| 困难挑战 | `/api/hard/sources`、`/api/hard/resolve` | `POST` | 获取候选题源并批量解析题目。 |
| 困难挑战 | `/api/hard/video-proxy` | `GET` | 安全代理 Sakugabooru 视频，支持 Range 请求。 |
| 对局 | `/api/leaderboard?mode=classic或hard` | `GET` / `POST` | 读取或提交当日排行榜。 |
| 站点 | `/api/feedback`、`/api/track` | `POST` | 提交反馈与匿名页面访问统计。 |
| 站点 | `/api/announcements` | `GET` | 读取已上架公告。 |
| 题库 | `/data/anime-library.json` | `GET` | 返回叠加 D1 番剧启停状态后的当前题库。 |
| 后台 | `/api/admin/leaderboard/*`、`/api/admin/analytics` | `GET` | 查询榜单日期、榜单详情和 PV / UV。 |
| 后台 | `/api/admin/feedback` | `GET` / `DELETE` | 查询或删除反馈。 |
| 后台 | `/api/admin/anime` | `GET` / `PUT` | 查询与启停番剧。 |
| 后台 | `/api/admin/announcements` | `GET` / `POST` / `PUT` / `DELETE` | 管理公告。 |

DeepSeek Key 使用 `X-DeepSeek-Api-Key` 请求头传递。Worker 会限制请求体和上游响应大小，并对日志里的 Bearer Token 与 `sk-` Key 脱敏。

## 安全、数据与版权

- CSP 仅允许同域脚本和接口，以及所需的 FanCaps、Sakugabooru 图片与视频资源。
- 视频代理只接受 Sakugabooru 的 HTTPS MP4 / WebM 地址，避免形成通用 SSRF 代理。
- 排行榜会校验题量、正确数、可达分数与用时；公开浏览器客户端无法做到绝对防刷。如需进一步限制滥用，可按实际套餐配置 Cloudflare Access、Turnstile 或平台限流。
- 请勿把 API Key、`.dev.vars`、`.wrangler/` 或其他密钥提交到版本库。
- 使用或部署前，请自行核对 [FanCaps](https://fancaps.net/)、[Sakugabooru](https://www.sakugabooru.com/)、[Bangumi](https://bangumi.tv/)、[AniDB](https://anidb.net/) 与 [DeepSeek](https://www.deepseek.com/) 的使用条款。

本项目仅用于个人学习、娱乐和非商业用途。动画截图及番剧资料的版权归原权利人所有，第三方服务由各自提供方维护。

## 开发与贡献

欢迎通过 [Issues](https://github.com/Xia2226/Anime-Frame-Quiz-Cloudflare/issues) 提交缺陷、题库勘误或功能建议。提交代码前，请执行：

~~~powershell
npm run check
~~~

项目采用 [MIT License](./LICENSE) 发布。
