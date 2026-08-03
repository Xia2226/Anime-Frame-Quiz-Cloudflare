# 动漫截图猜番

部署在 Cloudflare Workers + Static Assets 上的匿名小游戏。Worker 从 Sakugabooru 获取候选动画帧，访问者的浏览器直接调用 trace.moe 完成识图，再由 Worker 整理 AniList 标题并按需调用 DeepSeek 翻译。

## 为什么让浏览器直连 trace.moe

trace.moe 的匿名额度按请求出口公网 IP 计算。如果由统一后端代为请求，所有访问者会共享后端 IP 的每日额度。本项目让浏览器直接请求 trace.moe，因此额度按访问者当前公网 IP 计算。

这仍然是按公网 IP，不是按网站账号：同一家庭、公司或学校网络中的用户可能共享一个公网 IP；使用 VPN 时按 VPN 出口 IP 计算。

## CORS 边界

项目只让浏览器跨域访问已经验证支持 CORS 的 trace.moe：

| 服务 | 调用位置 | CORS 处理 |
| --- | --- | --- |
| trace.moe `/search`、`/me` | 浏览器直接调用 | 实测预检及实际响应允许页面 Origin |
| Sakugabooru | Cloudflare Worker | 实际 GET 响应没有 CORS 许可，因此不让浏览器直连 |
| AniList | Cloudflare Worker | 统一通过同域 API，浏览器不发生跨域 |
| DeepSeek | Cloudflare Worker | 统一通过同域 API，页面 Key 仅随检测和翻译请求传入 Worker |

静态资源响应设置了 CSP，只允许页面连接同域 API 和 `api.trace.moe`，并只允许加载 trace.moe 的图片和视频。

## 本地运行

前置条件：Node.js 22.19 或更高版本。

```powershell
npm install
npm start
```

Wrangler 会输出本地访问地址，通常为 `http://localhost:8787`。

## DeepSeek API Key

有两种使用方式：

1. 访问者在首页填写 Key，再点击“应用并检测”。输入过程中不会自动检测。
2. 部署者为 Worker 配置可选的 `DEEPSEEK_API_KEY` Secret。

页面填写的 Key：

- 只保存在当前标签页的 `sessionStorage` 中；
- 只随 `/api/deepseek/validate` 和 `/api/deepseek/translate` 请求发送；
- 不写入项目文件、Worker 数据库或接口响应；
- 环境 Secret 存在时优先使用环境 Secret，页面会禁用手动输入。

本地需要测试环境变量时，将 `.dev.vars.example` 复制为 `.dev.vars`，再填写：

```text
DEEPSEEK_API_KEY=你的APIkey
```

`.dev.vars` 已被 Git 忽略，不要提交真实 Key。

## 浏览器本地数据

项目不需要数据库。以下数据保存在每位访问者浏览器的 `localStorage` 中：

- Sakugabooru 筛选设置；
- 收藏列表；
- DeepSeek 标题翻译缓存。

不同浏览器和设备互相隔离。清除网站数据、使用无痕模式或更换设备会丢失这些数据；如果以后需要登录、跨设备同步或排行榜，才需要增加数据库。

## Cloudflare 部署

首次部署：

```powershell
npm install
npx wrangler login
npm run check
npm run deploy
```

如果希望部署者统一提供 DeepSeek Key：

```powershell
npx wrangler secret put DEEPSEEK_API_KEY
```

如果希望每位访问者使用自己的 Key，则不要设置这个 Secret。

`wrangler.jsonc` 已配置：

- Worker 入口：`worker.mjs`；
- 静态页面目录：`public/`；
- Worker 优先处理 API 和安全响应头；
- 不使用 D1、KV 或 R2。

部署完成后，可以在 Cloudflare Dashboard 的 Workers & Pages 中为 Worker 添加自定义域名。Cloudflare 自动提供 HTTPS，不需要购买 VPS、配置 Nginx 或申请独立公网 IPv4。

## 游戏流程

1. 浏览器向同域 `/api/frame-source` 请求候选来源和筛选参数。
2. Worker 请求 Sakugabooru，过滤近期作品、收藏作品、视频类型、大小及预览图尺寸。
3. 浏览器使用候选公开 URL 直接请求 `https://api.trace.moe/search`。
4. 浏览器把识别结果发送到同域 `/api/frame-resolve`。
5. Worker 校验 trace.moe 媒体 URL，并按需查询 AniList。
6. 浏览器先查本地翻译缓存；未命中时调用同域 DeepSeek 翻译接口。
7. 页面生成正确答案和三个干扰项。

## API 端点

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/config-status` | GET | 返回环境 Secret 是否配置，不返回 Key |
| `/api/frame-source` | GET | 从 Sakugabooru 获取并筛选一个候选来源 |
| `/api/frame-resolve` | POST | 校验浏览器取得的 trace.moe 结果并整理题目 |
| `/api/deepseek/validate` | POST | 检测环境或页面 DeepSeek Key |
| `/api/deepseek/translate` | POST | 翻译单条标题，不在 Worker 持久化缓存 |

## 项目结构

```text
├── worker.mjs          # Cloudflare Worker API 和静态资源入口
├── wrangler.jsonc      # Cloudflare 部署配置
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server.mjs          # 旧 Node/VPS 实现，仅保留作迁移参考，不参与部署
└── package.json
```

## 注意事项

- trace.moe CORS 是第三方行为，未来如果它取消浏览器跨域许可，浏览器直连会失败。把请求改回 Worker 代理虽然能恢复功能，但所有用户将重新共享 Cloudflare 出口额度。
- Worker 的内存候选池和 AniList 缓存可能随实例回收而消失，它们只是性能缓存，不是用户数据。
- Cloudflare 并不为该方案提供独立出口 IPv4；本项目不需要它，因为 trace.moe 请求直接从访问者浏览器发出。
- 上线前应再次确认第三方 API 的使用条款、额度和商业使用限制。

## 免责声明

本项目仅用于个人学习、娱乐和非商业用途。动画截图版权归原制作方所有；Sakugabooru、trace.moe、AniList 和 DeepSeek 均为第三方服务，请遵守各自条款。
