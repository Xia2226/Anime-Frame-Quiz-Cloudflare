# 动漫截图猜番

在线体验：<https://animeframequiz.cn>

一个部署在 Cloudflare Workers + Static Assets 上的动漫截图问答游戏。项目提供经典模式、自由模式和困难挑战，并使用 Cloudflare D1 维护每日排行榜。

经典模式与自由模式完全基于构建期生成的精简题库运行；浏览器不会在运行时读取约 1 GB 的 Bangumi 原始数据，也不会逐题请求 Worker。困难挑战从 Sakugabooru 随机取帧，把帖子的版权标签（作品名）交给 DeepSeek 翻译为简体中文标题来生成题目，并对题源和解析请求做了批处理，以尽量节省 Cloudflare 免费额度。

## 游戏模式

### 经典模式

- 每局从有截图的 AniDB 番剧中无放回随机抽取 50 部，每部随机选择一张截图。
- 每题 10 秒，选项标题都来自精简题库。
- 答错或超时为 0 分；答对按提交时的剩余时间计分：

| 剩余时间 | 得分 |
| --- | ---: |
| 8 秒及以上 | 10 |
| 6 秒及以上、少于 8 秒 | 8 |
| 4 秒及以上、少于 6 秒 | 6 |
| 2 秒及以上、少于 4 秒 | 4 |
| 少于 2 秒 | 2 |

完整完成 50 题时满分为 500 分。完成结算后可以直接开始下一局。

经典和自由模式在开局前会并行预解码前 5 道题的截图，首批全部就绪后才启动倒计时；游戏中持续维持 5 题滑动缓冲，答题反馈显示 1 秒后直接切到下一题。完整结算会列出本局全部题目、截图、番名、答题结果和最多 5 个标签。

### 自由模式

进入页面时会先打开筛选面板。可按首播日期、Bangumi 评分、排名、评分人数、完成人数、截图数量和标签组合筛选；标签输入至少两个字符后才进行模糊匹配并展示候选结果。

确认筛选后，从符合条件且有截图的番剧中生成一局题目。题目数量可在 25 / 50 / 75 / 100 题中选择，也可关闭每题 10 秒的限时倒计时；开启计时时计分规则与经典模式相同，答对按剩余时间获得 10、8、6、4 或 2 分。游戏中可从右上角重新打开筛选面板；确认新条件会结束当前进度并立即开始新一局。

自由模式的筛选条件由玩家自定义，成绩不可直接比较，因此作为练习模式，不参与每日排行榜。

### 困难挑战

困难挑战从 Sakugabooru 随机获取带版权标签（作品名）的动画视频，由浏览器端把视频随机暂停在某一帧并截取为题面，再把版权标签交给 DeepSeek 翻译为简体中文标题生成题目。点击入口后必须先在弹窗中填写 DeepSeek API Key，并点击“确认”。确认时同时校验：

- Key 可以访问所需模型；
- 人民币余额可读取且严格大于 1 元。

只有校验通过才进入游戏并开始加载题目。Key 由访问者提供，仅用于本次浏览器会话中的校验和困难模式解析请求，不写入 D1、项目文件或接口响应。题目画面在进入困难模式后由浏览器并行预加载，谁先就绪谁先展示；视频加载或截帧失败的题目会自动剔除并补充新题。

困难挑战不采用经典模式的分数排名。连续完成至少 50 题后，成绩才有资格按正确率进入排行榜；正确率相同时依次比较答题数量、用时和完成时间。

## 每日排行榜

排行榜按 `Asia/Shanghai` 自然日统计，服务器只保存每位参与者当天、每种模式最好的一次有效成绩：

- 经典模式：必须完整完成 50 题，按得分降序、用时升序排名。
- 困难挑战：必须连续完成至少 50 题，按正确率降序排名。
- 首次完成有效对局后会询问用户名。用户名可留空；留空不会提交排行榜。
- 用户名选择保存在当前标签页会话中，关闭标签页后才会再次询问；浏览器本地参与者 ID 用于让 D1 覆盖而不是追加同一天的较差成绩。
- 排行榜展示用户名、成绩或正确率、用时、题量和完成时间，并返回当日该模式全部上榜用户；页面以固定高度滚动区展示。

D1 表使用 `(day_key, mode, participant_id)` 作为主键，因此重复挑战不会无限增加行数。自由模式不提交成绩；经典和困难挑战的提交接口也会重新校验题量、得分、正确率和合理用时，不能仅依赖前端数据。

## 离线精简题库

源文件仅用于本地构建：

```text
resources/fancaps_anime_images.jsonl
resources/subject.jsonlines
```

运行 `npm run build:data` 后，`scripts/build-anime-library.mjs` 会以流式方式读取大文件，并执行以下处理：

1. 只保留状态有效且至少有一张合法截图的 Fancaps 番剧；
2. 清理重复截图、重复 AniDB ID、跨番剧共享图片和冲突的 Fancaps 页面关系；
3. 只解析题库所需的 Bangumi subject，并要求唯一匹配且 `type = 2`；
4. 拼接标题、原名、日期、评分、排名、统计值、标签等基础信息；
5. 剔除 `nsfw` 或带里番、色情、R18、工口、H、肉番、擦边等高置信成人标签的条目；仅有“卖肉/肉/福利/杀必死”时保留，并把过滤依据写入隔离报告；
6. 原子写入浏览器使用的 `public/data/anime-library.json`，并将隔离详情写入 `resources/generated/anime-library-quarantine.json`。

当前生成题库包含 2,170 部番剧、141,648 张截图和 3,708 个标签。原始 JSONL 与隔离报告均不作为静态资源发布；线上只加载约 2.21 MB、gzip 后约 745 KB 的精简 JSON。

生成或替换源文件后执行：

```powershell
npm run build:data
npm run check:data
```

`check:data` 会校验已生成题库与隔离报告的结构、排序、唯一性、关联完整性及统计值。构建脚本也支持 `--fancaps`、`--subjects`、`--output`、`--quarantine` 自定义路径。

## 请求与额度优化

项目针对 Cloudflare 免费额度做了以下处理：

- 经典模式、自由模式的题目和干扰项均在浏览器从精简题库生成，逐题不访问 Worker 或第三方 API。
- 精简题库使用长期静态缓存；同一版本通常只需下载一次。
- 排行榜只在打开或结算时读取，合格对局只提交一次；榜单 GET 在边缘缓存 30 秒。
- D1 通过主键 upsert 维护每日最好成绩，避免把每次挑战都保存为新记录。
- Cron 每天只执行一次清理，排行榜历史默认保留 7 天，不让无用旧记录持续占用 D1。
- 困难挑战一次批量获取 10 个候选题源，并批量翻译版权标签，减少 Worker 往返。
- 题目视频经 Worker 视频代理加载（注入 CORS 头并透传 Range），由浏览器抽帧展示题面。
- Sakugabooru 候选池在 Worker 实例内做有界缓存；实例回收只会丢失性能缓存，不影响用户数据。
- Static Assets 直接提供页面与题库，只有 `/api/*` 进入 Worker；日志和链路追踪采用低采样率。

## 开发者统一配置

普通访问者不再设置题量、倒计时、Sakugabooru 条件或排行榜参数。开发者可在 `public/js/game-config.js` 中统一配置：

- `localQuestionCount`：经典和自由模式题量；
- `localPreloadCount`、`answerFeedbackMs`：本地模式预加载窗口与答题反馈停留时间；
- `questionSeconds`、`scoreThresholds`：倒计时与计分阶梯；
- `hard.batchSize`、`hard.minRankQuestions`、`hard.sakugabooruFilter`：困难挑战批量与题源条件；
- `leaderboard.timeZone`、`leaderboard.cacheSeconds`、`leaderboard.retentionDays`：榜单自然日时区、缓存时间与 D1 保留天数。

该模块同时由浏览器和 Worker 导入，避免前后端校验规则漂移。修改题量或计分规则时，应同步确认 D1 提交校验和页面文案仍符合预期。

## 本地开发

前置条件：Node.js 22.19 或更高版本。

```powershell
npm install
npm run build:data
npx wrangler d1 migrations apply anime-frame-quiz-leaderboard --local
npm start
```

Wrangler 通常会在 `http://localhost:8787` 启动项目。本地 D1 数据位于 `.wrangler/`，可随时删除后重新执行本地迁移来重建开发数据库。

## Cloudflare D1 与部署

首次部署前创建 D1 数据库：

```powershell
npx wrangler login
npx wrangler d1 create anime-frame-quiz-leaderboard
```

将命令返回的数据库标识补充到 `wrangler.jsonc` 的 `d1_databases` 配置中，保持绑定名为 `DB`，然后应用远程迁移：

```powershell
npx wrangler d1 migrations apply anime-frame-quiz-leaderboard --remote
npm run check
npm run deploy
```

后续如果新增迁移，应先在本地验证，再应用远程迁移，最后部署 Worker。`npm run check` 会检查生成题库、JavaScript 语法，并执行 Wrangler dry-run。

## 主要 API

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/deepseek/validate` | POST | 校验访问者 Key、模型权限和人民币余额 |
| `/api/hard/sources` | POST | 批量获取困难挑战候选题源 |
| `/api/hard/resolve` | POST | 批量翻译版权标签并生成题目 |
| `/api/hard/video-proxy` | GET | 代理 Sakugabooru 视频并注入 CORS 头，供浏览器抽帧 |
| `/data/anime-library.json` | GET | 合并管理员启停状态后的精简题库 |
| `/api/admin/anime` | GET / PUT | 管理员查询番剧列表、启停番剧 |
| `/api/announcements` | GET | 获取当前上架的站内公告（置顶在前） |
| `/api/admin/announcements` | GET / POST / PUT / DELETE | 管理员增删改查公告、上下架与置顶 |
| `/api/leaderboard?mode=classic\|hard` | GET | 获取指定模式的当日榜单 |
| `/api/leaderboard?mode=classic\|hard` | POST | 提交一局满足条件的成绩并返回当日榜单 |

DeepSeek Key 通过 `X-DeepSeek-Api-Key` 请求头传递。Worker 对请求体大小、上游响应大小、第三方 URL、超时、用户名和成绩范围进行校验；应用日志会对敏感内容进行清理。

## 项目结构

```text
├── migrations/
│   ├── 0001_daily_best.sql       # 每日最佳成绩表与排序索引
│   ├── 0002_feedback.sql         # 问题反馈表
│   ├── 0003_analytics.sql        # 访问统计表
│   ├── 0004_anime_override.sql   # 番剧启停覆盖表
│   └── 0005_announcements.sql    # 站内公告表
├── public/
│   ├── data/anime-library.json   # 构建生成的精简题库
│   ├── data/anime-library-old.json # 上一版题库，用于统计新增数据
│   ├── js/
│   │   ├── catalog.js            # 题库加载、抽题和自由筛选
│   │   ├── game-config.js        # 开发者统一参数
│   │   ├── hard-provider.js      # 困难挑战批量题源与解析
│   │   ├── leaderboard.js        # 排行榜身份、提交与读取
│   │   └── quiz-engine.js        # 可复用计时、计分和游戏循环
│   ├── app.js                    # 页面状态和三模式编排
│   ├── index.html                # 首页与游戏页面
│   ├── library.html              # 图库资源统计页
│   ├── library.js
│   ├── library.css
│   ├── styles.css
│   └── _headers                  # CSP 与静态缓存规则
├── resources/                    # 本地原始数据，不作为线上静态资源
├── scripts/build-anime-library.mjs
├── worker.mjs                    # API、D1 与静态资源入口
├── wrangler.jsonc
└── package.json
```

首页卡片下方的“图库资源”链接会打开统计页。该页面直接使用同一份精简题库，只展示确实有截图的番剧，无需用户上传文件；年度图默认定位到最新年份一侧，明细默认按评分降序，并支持输入至少 2 个字符实时搜索标签。

首次访问首页会自动显示游戏说明，之后可通过首页右上角的“游戏说明”按钮重新打开。首页最下方提供项目的 GitHub 仓库链接。

## 安全与第三方边界

- 页面 CSP 只允许必要的同域 API、Sakugabooru 图片/视频等资源。
- Sakugabooru 素材抓取与 DeepSeek 翻译请求由 Worker 发起；题目视频经 Worker 视频代理加载后由浏览器抽帧展示题面，浏览器不直连 Sakugabooru。
- API Key 不应写入源码、URL 查询参数、D1 或 Cloudflare 配置文件。
- 当前排行榜是休闲榜：Worker 会校验题量、正确数、可达分数和用时范围，但无法证明公开浏览器客户端没有被修改。若公开站点需要对抗恶意刷榜或接口滥用，应在 Cloudflare 前置 Turnstile/Rate Limiting，并进一步采用服务端签发挑战票据；这些措施需要额外站点密钥或平台配置，当前版本未默认启用。
- 困难模式标题翻译按访问者自带的 DeepSeek Key 计费；Key 仅存于当前会话（sessionStorage），不写入服务器。
- 上线前请确认 Fancaps、Sakugabooru、Bangumi、AniDB 和 DeepSeek 的使用条款及额度限制。

## 免责声明

本项目仅用于个人学习、娱乐和非商业用途。动画截图及番剧资料版权归原权利人所有，第三方服务由各自提供方维护。
