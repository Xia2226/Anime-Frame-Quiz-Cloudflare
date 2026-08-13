# 动漫截图猜番

在线体验：<https://animeframequiz.cn>

一个部署在 Cloudflare Workers、Static Assets 和 D1 上的动漫截图问答游戏。项目包含经典模式、自由模式、困难挑战、每日排行榜、图库统计页、反馈与公告后台，并按 Cloudflare 免费版的资源边界设计。

当前可直接部署的精简题库已经提交到仓库：2,170 部番剧、141,646 张截图、3,708 个标签。运行游戏时不读取本地原始大文件，也不需要逐题请求 Worker。

## 功能概览

### 经典模式

- 每局 50 题，从已启用且有截图的番剧中无放回抽取；
- 每题 10 秒，答对按剩余时间获得 10 / 8 / 6 / 4 / 2 分；
- 前 5 题在开局前预解码，游戏中维持滑动预加载窗口；
- 完整完成后可提交当日排行榜，同一参与者只保留当天最好成绩。

### 自由模式

- 支持按首播日期、评分、排名、评分人数、完成人数、截图数和标签筛选；
- 支持 25 / 50 / 75 / 100 题以及关闭倒计时；
- 定位为练习模式，不参与排行榜。

### 困难挑战

- 从 Sakugabooru 批量获取动画视频候选，由浏览器随机抽帧；
- 使用访问者自己提供的 DeepSeek API Key 批量解析中文作品名；
- Key 只保存在当前标签页会话中，不写入源码、D1 或日志；
- 连续完成至少 50 题后，按正确率、题量、用时排名。

### 图库与管理

- `/library.html` 展示题库年代、评分、标签和新增番剧统计；
- `/admin.html` 管理排行榜、访问统计、反馈、番剧启停与公告；
- 番剧启停状态保存在 D1，不直接改写已部署的题库 JSON；
- 公告支持创建、编辑、上下架、置顶与删除。

> 安全提示：仓库代码没有内置管理员账户系统。公开部署时必须在 Cloudflare 侧保护 `/admin.html` 和 `/api/admin/*`（例如使用 Cloudflare Access），否则后台接口会暴露给公网。请按账号当前套餐核对 Access 的可用范围。

## 运行架构

```text
浏览器
├── Static Assets：HTML / CSS / JS / 图标 / 旧题库快照
├── Worker：API 路由、输入校验、安全头、第三方代理
├── D1：排行榜、反馈、统计、番剧启停、公告
└── 第三方：FanCaps 图片、Sakugabooru 视频、DeepSeek（访问者自带 Key）
```

经典模式和自由模式的抽题、干扰项、计时与计分都在浏览器完成。Worker 只处理需要服务端边界的请求，因此不会产生逐题 D1 查询。

## Cloudflare 免费版策略

项目只依赖免费版可用的基础能力：Workers、Static Assets、D1、Cron Trigger、Cache API 和低采样率 Workers Observability。没有引入 R2、Images、Queues、Workflows、Durable Objects 或其他额外产品。

- 静态 CSS、JS、页面和图片由 Static Assets 直接提供；
- `run_worker_first` 只覆盖 API、HTML 入口、SEO 文件和需要合并 D1 状态的题库路径；
- 排行榜按模式和上海自然日缓存 30 秒；
- 合并启停状态后的题库在 Worker Cache API 中缓存 1 小时，客户端响应明确禁止缓存；
- 题库缓存键包含静态文件 ETag 和 D1 启停版本：重新部署题库或后台启停番剧后，下一次请求会立即使用新版本，不受 1 小时内部缓存或域名浏览器 TTL 设置影响；
- 公告和后台接口默认 `no-store`，发布或更新公告后下一次请求直接读取最新数据；
- D1 的相关查询使用 prepared statements，互相独立的读写合并为 `batch()`；
- Cron 每天一次批量清理过期排行榜、反馈和访问统计；
- 困难模式批量获取候选和翻译标签，并限制请求体、上游响应、视频大小、超时与重试次数；
- 日志和链路追踪分别使用 5% 与 1% 的低采样率。

已经打开的浏览器页面不会被服务器主动推送刷新；后台修改后重新加载页面，或等待页面发起下一次相应请求，即可读取最新数据。

## 快速开始

前置条件：Node.js 22.19.0 或更高版本。

```powershell
npm install
npm run db:migrate:local
npm start
```

Wrangler 默认在 `http://localhost:8787` 启动。项目已经包含运行所需的题库，因此首次启动不需要生成数据。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动本地 Worker 与 Static Assets |
| `npm test` | 运行 Node 原生单元测试 |
| `npm run check:data` | 校验当前题库和旧题库快照的结构、统计与唯一性 |
| `npm run check:js` | 自动发现并检查版本库内全部 JS/MJS 源文件 |
| `npm run check:deploy` | 执行 Wrangler 部署 dry-run |
| `npm run check` | 依次运行测试、题库、JS 和部署检查 |
| `npm run db:migrate:local` | 应用本地 D1 迁移 |
| `npm run db:migrate:remote` | 应用远程 D1 迁移 |
| `npm run deploy` | 部署到 Cloudflare |

## 部署

登录并创建 D1 数据库：

```powershell
npx wrangler login
npx wrangler d1 create anime-frame-quiz-leaderboard
```

将返回的 `database_id` 写入 `wrangler.jsonc`，保持绑定名为 `DB`。首次部署或新增迁移时，先应用远程迁移，再检查和部署：

```powershell
npm run db:migrate:remote
npm run check
npm run deploy
```

如果只想在本地验证，请使用 `db:migrate:local`。不要把 `.wrangler/`、`.dev.vars`、API Key 或其他密钥提交到版本库。

## 题库文件

运行时使用两份已经提交的精简 JSON：

- `public/data/anime-library.json`：当前 v2 题库，游戏、图库页和后台番剧管理共同使用；
- `public/data/anime-library-old.json`：上一版 v1 快照，只用于图库页计算新增番剧统计，不是死文件。

截图文件本身不存放在仓库。每道题通过 `imageBase + imageId + .jpg` 指向 FanCaps CDN；本地 `covers/` 如果存在则用于图库缩略图，但不是游戏运行的必要条件。

### 可选图库构建工具

图库的完整构建、更新、原始 FanCaps 数据维护和冲突复核由独立工具仓库负责：

```text
D:\desktop\utils\AnimeShotDB-tools
```

该目录中的主要入口包括 `initial-build.cmd`、`update-library.cmd`、`update-source.cmd`、`review-source.cmd` 和 `review-quarantine.cmd`。具体参数和安全流程以该工具目录自己的 `README.md` 为准。

> `AnimeShotDB-tools` 是可选的题库维护工具，不是本项目的运行依赖。不下载、不安装或不打开该工具，本项目仍可正常安装依赖、本地运行、执行检查和部署；只有在需要重建、追加、清洗或人工复核图库数据时才需要它。

推荐的更新流程：

1. 以本项目的 `public/data/anime-library.json` 作为权威 v2 基线；
2. 在 `AnimeShotDB-tools` 中先 dry-run，再生成新文件并校验；
3. 人工核对更新报告和隔离报告；
4. 更新本项目的当前题库，需要展示“新增”统计时再同步更新旧题库快照；
5. 回到本项目运行 `npm run check`；
6. 应用新增 D1 迁移后部署。

本项目还保留 `删除番剧图片.bat` 和 `scripts/remove-anime-image.mjs` 作为单张错误截图的本地维护入口。它需要本机存在被 `.gitignore` 排除的 `resources/fancaps_anime_images.jsonl`，因此普通运行和部署不需要使用它。

## 开发者配置

游戏规则集中在 `public/js/game-config.js`，同时由浏览器与 Worker 导入，避免前后端校验漂移：

- `localQuestionCount`：经典模式题量；
- `localPreloadCount`、`answerFeedbackMs`：预加载窗口和反馈停留时间；
- `questionSeconds`、`scoreThresholds`：倒计时与计分阶梯；
- `hard.batchSize`、`hard.minRankQuestions`、`hard.sakugabooruFilter`：困难模式批量和题源条件；
- `leaderboard.timeZone`、`leaderboard.cacheSeconds`、`leaderboard.retentionDays`：榜单日期、缓存和保留期。

修改题量、计分或排行榜规则后，必须运行 `npm run check`，并确认页面文案与 Worker 提交校验仍一致。

## API

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/deepseek/validate` | POST | 校验访问者 Key、模型权限和人民币余额 |
| `/api/hard/sources` | POST | 批量获取困难模式候选题源 |
| `/api/hard/resolve` | POST | 批量解析版权标签并生成题目 |
| `/api/hard/video-proxy` | GET | 安全代理 Sakugabooru 视频并透传 Range |
| `/api/leaderboard?mode=classic\|hard` | GET / POST | 读取或提交当日排行榜 |
| `/api/feedback` | POST | 提交纠错、缺陷或建议 |
| `/api/track` | POST | 写入匿名页面访问统计 |
| `/api/announcements` | GET | 读取已上架公告 |
| `/data/anime-library.json` | GET | 返回叠加 D1 启停状态后的当前题库 |
| `/api/admin/leaderboard/days` | GET | 后台排行榜日期统计 |
| `/api/admin/leaderboard` | GET | 后台指定日期榜单详情 |
| `/api/admin/analytics` | GET | 后台 PV / UV 统计 |
| `/api/admin/feedback` | GET / DELETE | 后台反馈查询与删除 |
| `/api/admin/anime` | GET / PUT | 后台番剧查询与启停 |
| `/api/admin/announcements` | GET / POST / PUT / DELETE | 后台公告管理 |

DeepSeek Key 通过 `X-DeepSeek-Api-Key` 请求头传递。Worker 会限制请求体和上游响应大小，并对日志中的 Bearer Token 和 `sk-` Key 做脱敏。

## 目录结构

```text
├── migrations/                 # D1 迁移（排行榜、反馈、统计、启停、公告、缓存索引）
├── public/
│   ├── data/                   # 当前题库与旧题库快照
│   ├── js/                     # 游戏配置、题库、困难模式、榜单、引擎等模块
│   ├── index.html / app.js     # 首页与游戏编排
│   ├── library.html / .js      # 图库统计页
│   ├── admin.html / .js        # 管理后台
│   └── _headers                # 静态资源 CSP、安全头和缓存规则
├── scripts/
│   └── remove-anime-image.mjs  # 可选的本地单图维护脚本
├── src/
│   └── http.mjs                # Worker HTTP、流式限长、重试、安全头工具
├── test/
│   └── http.test.mjs           # HTTP 边界回归测试
├── tools/
│   ├── check-javascript.mjs    # 自动 JS 语法检查
│   └── validate-anime-library.mjs # 独立题库完整性校验
├── worker.mjs                  # 路由、D1 与业务处理入口
├── wrangler.jsonc
└── package.json
```

## 安全与第三方边界

- CSP 只允许同域脚本/接口以及所需的 FanCaps、Sakugabooru 图片和视频；
- 视频代理只接受 Sakugabooru 的 HTTPS MP4 / WebM 地址，避免通用 SSRF 代理；
- API Key 不应写入源码、URL、D1、Wrangler 配置或日志；
- 排行榜会校验题量、正确数、可达分数和用时，但公开浏览器客户端无法做到绝对防刷；
- 如果需要进一步防滥用，可在不改变核心逻辑的前提下配置 Cloudflare Access、Turnstile 或平台限流；启用前请核对账号当前免费额度与配置要求；
- 上线前请确认 FanCaps、Sakugabooru、Bangumi、AniDB 和 DeepSeek 的使用条款。

## 免责声明

本项目仅用于个人学习、娱乐和非商业用途。动画截图及番剧资料版权归原权利人所有，第三方服务由各自提供方维护。
