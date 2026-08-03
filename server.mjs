import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import jpeg from "jpeg-js";
import {
  Agent,
  ProxyAgent,
  Response as UndiciResponse,
  fetch as undiciFetch,
  setGlobalDispatcher,
} from "undici";

const startupProxy = getConfiguredUpstreamProxy();
let proxyInitPromise = null;
let configuredProxyAvailable = Boolean(startupProxy);
let traceMoeDispatcher = null;

if (startupProxy) {
  const proxyAgent = new ProxyAgent(startupProxy);
  setGlobalDispatcher(proxyAgent);
  console.log("上游 API 已启用显式 HTTP/HTTPS 代理:", startupProxy);
  // 测试代理连接并自动禁用失效的代理
  proxyInitPromise = testProxyConnection(startupProxy).then(() => {
    traceMoeDispatcher = new ProxyAgent(startupProxy);
    console.log("代理连接测试成功");
  }).catch((error) => {
    console.error("代理连接测试失败:", error.message);
    console.error("将禁用代理并使用 IPv4 直连");
    configuredProxyAvailable = false;
    // 自动禁用失效的代理
    setGlobalDispatcher(new Agent({
      connect: {
        family: 4,
      },
    }));
    traceMoeDispatcher = new Agent({
      connect: {
        family: 4,
      },
      connections: 1,
      pipelining: 1,
    });
    console.log("上游 API 已切换为 IPv4 网络路径");
  });
} else {
  // 部分 Windows VPN 只接管 IPv4；强制上游请求使用 IPv4，避免 Node 通过 IPv6 绕过 VPN。
  const ipv4Agent = new Agent({
    connect: {
      family: 4,
    },
  });
  setGlobalDispatcher(ipv4Agent);
  traceMoeDispatcher = new Agent({
    connect: {
      family: 4,
    },
    connections: 1,
    pipelining: 1,
  });
  console.log("上游 API 已启用 IPv4 网络路径，以兼容仅代理 IPv4 的 VPN");
}

async function testProxyConnection(proxyUrl) {
  try {
    const testUrl = "http://www.sakugabooru.com/post.json?limit=1";
    const response = await fetchWithTimeout(testUrl, {
      method: "HEAD",
      timeoutMs: 5000,
    });
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    const testError = new Error(`代理 ${proxyUrl} 连接测试失败: ${error.message}`);
    testError.code = error.code;
    throw testError;
  }
}

const PORT = normalizePort(process.env.PORT);
const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PUBLIC_DIR = join(process.cwd(), "public");
const REQUEST_TIMEOUT_MS = 20000;
const TRACE_SEARCH_TIMEOUT_MS = 60000;
const TRACE_SEARCH_RETRY_LIMIT = 3;
const MAX_EXCLUDED_COPYRIGHT_TAGS = 512;
const ENV_DEEPSEEK_API_KEY = normalizeDeepSeekApiKey(process.env.DEEPSEEK_API_KEY);
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODELS_API_URL = "https://api.deepseek.com/v1/models";
const DEEPSEEK_TRANS_MODEL = "deepseek-v4-flash";
const DEEPSEEK_TRANSLATION_TIMEOUT_MS = 3000;
const DEEPSEEK_TRANSLATION_RETRY_COUNT = 1;

// DeepSeek 始终使用自己的 IPv4 直连连接池，不继承全局代理配置。
const deepSeekDispatcher = new Agent({
  connect: {
    family: 4,
  },
  connections: 2,
  pipelining: 1,
  keepAliveTimeout: 10000,
  keepAliveMaxTimeout: 60000,
});
console.log(`DeepSeek API 已启用独立 IPv4 直连（不使用代理，模型 ${DEEPSEEK_TRANS_MODEL}，非思考模式）`);

if (ENV_DEEPSEEK_API_KEY) {
  console.log("DeepSeek API Key 已从环境变量 DEEPSEEK_API_KEY 读取");
} else {
  console.warn("未读取到 DEEPSEEK_API_KEY，可在首页手动输入；未输入时将回退到 trace.moe 标题");
}

function normalizeDeepSeekApiKey(value) {
  if (typeof value !== "string") return "";
  const apiKey = value.trim();
  return apiKey === "你的APIkey" || apiKey.length > 512 ? "" : apiKey;
}

function getRequestDeepSeekApiKey(req) {
  const browserApiKey = normalizeDeepSeekApiKey(req.headers["x-deepseek-api-key"]);
  return ENV_DEEPSEEK_API_KEY || browserApiKey;
}

function normalizePort(value) {
  if (value === undefined || value === "") return 5173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数");
  }
  return port;
}

const sakugabooruCandidatePools = new Map();
const sakugabooruCopyrightTagCache = new Map();
const anilistCache = new Map();
let traceSearchQueue = Promise.resolve();

const DEFAULT_SAKUGABOORU_FILTER = {
  startDate: "",
  endDate: "",
  minScore: null,
  maxScore: null,
  rating: "s",
};

function validateSakugabooruFilter(input = {}) {
  const startDate = normalizeFilterDate(input.startDate, "起始日期");
  const endDate = normalizeFilterDate(input.endDate, "结束日期");
  const minScore = normalizeFilterScore(input.minScore, "最低热度");
  const maxScore = normalizeFilterScore(input.maxScore, "最高热度");
  const rating = input.rating === "" ? "" : String(input.rating || "s");

  if (!["", "s", "q", "e"].includes(rating)) {
    throw createHttpError(400, "内容分级必须是 safe、questionable、explicit 或全部");
  }
  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, "起始日期不能晚于结束日期");
  }
  if (minScore !== null && maxScore !== null && minScore > maxScore) {
    throw createHttpError(400, "最低热度不能高于最高热度");
  }

  return { startDate, endDate, minScore, maxScore, rating };
}

function normalizeFilterDate(value, fieldName) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  const parsedDate = new Date(`${text}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text)
    || Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== text
  ) {
    throw createHttpError(400, `${fieldName}格式必须为 YYYY-MM-DD`);
  }
  if (text < "2000-01-01" || text > getLocalDateString()) {
    throw createHttpError(400, `${fieldName}必须在 2000-01-01 至今天之间`);
  }
  return text;
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeFilterScore(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < -1000 || number > 100000) {
    throw createHttpError(400, `${fieldName}必须是 -1000 到 100000 之间的整数`);
  }
  return number;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const ANILIST_API_URL = "https://graphql.anilist.co";
const SAKUGABOORU_API_URL = "https://www.sakugabooru.com/post.json";
const SAKUGABOORU_RELATED_TAG_API_URL = "https://www.sakugabooru.com/tag/related.json";
const SAKUGABOORU_RETRY_LIMIT = 3;
const OVERALL_RETRY_LIMIT = 5;
const SAKUGABOORU_COPYRIGHT_FILTER_ATTEMPTS = 24;
const SAKUGABOORU_CANDIDATE_FETCH_LIMIT = 8;
const SAKUGABOORU_CANDIDATE_POOL_LIMIT = 24;
const SAKUGABOORU_CANDIDATE_LOW_WATERMARK = 15;
const SAKUGABOORU_CANDIDATE_POOL_KEY_LIMIT = 4;
const SAKUGABOORU_RECENT_POST_LIMIT = 64;
const SAKUGABOORU_TAG_TYPE_CACHE_LIMIT = 10000;
const ANILIST_CACHE_LIMIT = 1000;
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 1024 * 1024;
const MIN_PREVIEW_WIDTH = 280;
const MIN_PREVIEW_HEIGHT = 150;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/frame") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, ["GET"]);
        return;
      }
      const excludedCopyrightTags = normalizeExcludedCopyrightTags(
        url.searchParams.getAll("excludeCopyright"),
      );
      const filterConfig = validateSakugabooruFilter({
        startDate: url.searchParams.get("startDate") || "",
        endDate: url.searchParams.get("endDate") || "",
        minScore: url.searchParams.get("minScore") || null,
        maxScore: url.searchParams.get("maxScore") || null,
        rating: url.searchParams.has("rating") ? url.searchParams.get("rating") : "s",
      });
      const frame = await createFrameQuestion(
        url.searchParams.get("tags") || "",
        excludedCopyrightTags,
        filterConfig,
      );
      sendJson(res, 200, frame);
      return;
    }

    if (url.pathname === "/api/config-status") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, ["GET"]);
        return;
      }
      sendJson(res, 200, {
        deepSeekApiKey: {
          configured: Boolean(ENV_DEEPSEEK_API_KEY),
          source: ENV_DEEPSEEK_API_KEY ? "environment" : null,
        },
      });
      return;
    }

    if (url.pathname === "/api/deepseek/validate") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, ["POST"]);
        return;
      }
      const deepSeekApiKey = getRequestDeepSeekApiKey(req);
      if (!deepSeekApiKey) {
        sendJson(res, 400, {
          valid: false,
          message: "请先输入 DeepSeek API Key",
        });
        return;
      }
      const validation = await validateDeepSeekApiKey(deepSeekApiKey);
      sendJson(res, 200, validation);
      return;
    }

    if (url.pathname === "/api/deepseek/translate") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, ["POST"]);
        return;
      }
      const deepSeekApiKey = getRequestDeepSeekApiKey(req);
      if (!deepSeekApiKey) {
        throw createHttpError(400, "请先配置或输入 DeepSeek API Key");
      }
      const body = await parseJsonBody(req, 16 * 1024);
      const text = normalizeTitleValue(body?.text);
      const sourceLanguage = ["ja", "en", "auto"].includes(body?.sourceLanguage)
        ? body.sourceLanguage
        : "auto";
      if (!text || text.length > 500) {
        throw createHttpError(400, "缺少有效的待翻译标题");
      }
      const title = await translateToChinese(text, sourceLanguage, deepSeekApiKey);
      sendJson(res, 200, { title });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API endpoint not found", code: "NOT_FOUND" });
      return;
    }

    await serveStatic(url.pathname, req, res);
  } catch (error) {
    if (error.code === "TRACE_NETWORK_ERROR") {
      console.warn(`[trace.moe] ${error.message}`);
    } else {
      console.error(error);
    }
    const statusCode = error.statusCode || (error.code === "QUOTA_EXCEEDED" ? 402 : 500);
    sendJson(res, statusCode, {
      error: error.message || "Internal server error",
      code: error.code || null,
    });
  }
});

// 等待代理初始化完成后再启动服务器
(async () => {
  if (proxyInitPromise) {
    await proxyInitPromise;
  }
  server.listen(PORT, HOST, () => {
    console.log(`Anime quiz running at http://${HOST}:${PORT}/`);
  });
})();

async function createFrameQuestion(
  customTags = "",
  excludedCopyrightTags = new Set(),
  filterConfig = DEFAULT_SAKUGABOORU_FILTER,
) {
  let lastError = null;

  for (let overallAttempt = 0; overallAttempt < OVERALL_RETRY_LIMIT; overallAttempt++) {
    const timings = {};
    const attemptStartedAt = performance.now();
    try {
      const post = await measureStage(
        timings,
        "sakugabooru",
        () => fetchRandomSakugabooruVideo(customTags, excludedCopyrightTags, filterConfig),
      );
      const traceData = await measureStage(timings, "trace.moe", () => (
        searchTraceMoeWithUrl(post.traceInputUrl || post.fileUrl)
      ));
      const frame = selectBestTraceResult(traceData);
      if (!frame || !frame.image) {
        throw new Error("trace.moe 未返回可展示的识别结果");
      }

      const titles = await measureStage(
        timings,
        "title",
        () => resolveAnimeTitles(frame),
      );
      const frameId = `${post.id}-${randomUUID()}`;
      timings.total = Math.round(performance.now() - attemptStartedAt);
      const traceInputDescription = post.traceInputType === "preview"
        ? `Sakugabooru 预览图 ${post.previewQuality.width}x${post.previewQuality.height}`
        : `视频首帧回退，视频 ${formatBytes(post.fileSize)}`;
      console.log(`随机挑战生成成功 (${traceInputDescription}): ${formatTimings(timings)}`);

      return {
        id: frameId,
        title: titles.title,
        originalTitle: titles.originalTitle,
        japaneseTitle: titles.japaneseTitle,
        englishTitle: titles.englishTitle,
        titleLanguage: titles.titleLanguage,
        titleSource: titles.titleSource,
        translation: titles.translation,
        image: frame.image,
        traceImage: frame.image,
        video: frame.video || null,
        episode: frame.episode ?? null,
        from: frame.from ?? null,
        capturedAt: 0,
        similarity: frame.similarity,
        source: "sakugabooru-tracemoe",
        sourceUrl: `https://www.sakugabooru.com/post/show/${post.id}`,
        anilistId: titles.anilist?.id || null,
        anilist: titles.anilist,
        sakugabooru: {
          id: post.id,
          tags: post.tags,
          copyrightTags: post.copyrightTags,
          score: post.score,
          source: post.source,
          traceInputType: post.traceInputType,
          previewQuality: post.previewQuality || null,
        },
      };
    } catch (error) {
      if (error.code === "QUOTA_EXCEEDED" || error.code === "TRACE_NETWORK_ERROR") {
        throw error;
      }
      lastError = error;
      timings.total = Math.round(performance.now() - attemptStartedAt);
      console.warn(`随机挑战第 ${overallAttempt + 1} 次尝试失败 (${formatTimings(timings)}):`, error.message);
    }
  }

  throw new Error(`创建题目失败，整体重试 ${OVERALL_RETRY_LIMIT} 次后仍无结果: ${lastError?.message || "未知错误"}`);
}

async function measureStage(timings, name, task) {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    timings[name] = Math.round(performance.now() - startedAt);
  }
}

function formatTimings(timings) {
  return Object.entries(timings)
    .map(([name, milliseconds]) => `${name}=${milliseconds}ms`)
    .join(", ");
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "未知";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(2)}MB`;
}

async function searchTraceMoeWithUrl(mediaUrl, options = {}) {
  return enqueueTraceMoeSearch(() => performTraceMoeSearch({
    method: "GET",
    mediaUrl,
  }, {
    ...options,
    anilistInfo: true,
  }));
}

function enqueueTraceMoeSearch(task) {
  const operation = traceSearchQueue.then(task, task);
  traceSearchQueue = operation.catch(() => {});
  return operation;
}

async function performTraceMoeSearch(request, options = {}) {
  const traceUrl = new URL("https://api.trace.moe/search");
  if (options.anilistInfo) {
    traceUrl.searchParams.set("anilistInfo", "");
  }
  if (options.cutBorders) {
    traceUrl.searchParams.set("cutBorders", "");
  }
  if (request.mediaUrl) {
    traceUrl.searchParams.set("url", request.mediaUrl);
  }

  if (!traceMoeDispatcher) {
    traceMoeDispatcher = createTraceMoeDispatcher();
  }

  let lastError = null;
  for (let attempt = 0; attempt < TRACE_SEARCH_RETRY_LIMIT; attempt++) {
    const traceDispatcher = traceMoeDispatcher;
    try {
      const response = await fetchWithRetry(traceUrl, {
        method: request.method,
        dispatcher: traceDispatcher,
        headers: request.headers,
        body: request.body,
        timeoutMs: TRACE_SEARCH_TIMEOUT_MS,
      }, {
        attempts: 1,
        label: "trace.moe",
      });
      return await response.json();
    } catch (error) {
      if (error.status === 402) {
        await classifyTraceMoeLimitError(error, traceDispatcher);
        if (error.code === "QUOTA_EXCEEDED") {
          throw error;
        }
      }

      lastError = error;
      const retryable = error.code === "TRACE_CONCURRENCY"
        || !error.status
        || error.status === 429
        || error.status >= 500;
      if (!retryable) {
        throw error;
      }

      if (!error.status) {
        console.warn(
          `[trace.moe] 第 ${attempt + 1}/${TRACE_SEARCH_RETRY_LIMIT} 次连接失败：${formatNetworkError(error)}`,
        );
        await recycleTraceMoeDispatcher(traceDispatcher);
      } else if (error.status >= 500 && traceUrl.searchParams.has("anilistInfo")) {
        // AniList 信息只是标题优化；服务端繁忙时优先保证识别本身成功。
        traceUrl.searchParams.delete("anilistInfo");
      }
    }

    if (attempt < TRACE_SEARCH_RETRY_LIMIT - 1) {
      await delay(getRetryDelayMs(attempt, 1000));
    }
  }

  const networkError = new Error(`trace.moe 网络连接失败：${formatNetworkError(lastError)}`);
  networkError.code = "TRACE_NETWORK_ERROR";
  networkError.statusCode = 502;
  networkError.cause = lastError;
  throw networkError;
}

function getConfiguredUpstreamProxy() {
  const configured = process.env.UPSTREAM_PROXY;
  if (configured === undefined) return "http://127.0.0.1:10808";
  if (/^(off|none|false)$/i.test(configured.trim())) return "";
  return configured.trim();
}

function createTraceMoeDispatcher() {
  if (configuredProxyAvailable && startupProxy) {
    return new ProxyAgent(startupProxy);
  }
  return new Agent({
    connect: {
      family: 4,
    },
    connections: 1,
    pipelining: 1,
  });
}

async function recycleTraceMoeDispatcher(failedDispatcher) {
  if (traceMoeDispatcher !== failedDispatcher) return;
  if (configuredProxyAvailable) {
    configuredProxyAvailable = false;
    setGlobalDispatcher(new Agent({
      connect: { family: 4 },
    }));
    console.warn("上游代理运行中失效，后续请求已切换为 IPv4 直连");
  }
  traceMoeDispatcher = createTraceMoeDispatcher();
  await failedDispatcher.close().catch(() => {});
}

async function fetchTraceMoeAccount(dispatcher) {
  const response = await fetchWithTimeout("https://api.trace.moe/me", {
    dispatcher,
    timeoutMs: 10000,
  });
  if (!response.ok) {
    throw new Error(`trace.moe /me HTTP ${response.status}`);
  }
  return response.json();
}

async function classifyTraceMoeLimitError(error, dispatcher) {
  if (/concurrency/i.test(error.body || error.message || "")) {
    error.code = "TRACE_CONCURRENCY";
    error.message = "trace.moe 并发限制繁忙，稍后重试";
    return;
  }

  try {
    const account = await fetchTraceMoeAccount(dispatcher);
    const quota = Number(account?.quota);
    const quotaUsed = Number(account?.quotaUsed);
    const accountId = String(account?.id || "未知出口");
    const usage = Number.isFinite(quota) && Number.isFinite(quotaUsed)
      ? `${quotaUsed}/${quota}`
      : "未知";
    const quotaDepleted = Number.isFinite(quota)
      && Number.isFinite(quotaUsed)
      && (quota <= 0 || quotaUsed >= quota);

    error.code = quotaDepleted ? "QUOTA_EXCEEDED" : "TRACE_CONCURRENCY";
    error.message = quotaDepleted
      ? `trace.moe 当前网络出口 ${accountId} 搜索额度已用完（${usage}）。若浏览器显示不同账户，请检查 VPN 是否同时代理 Node.js。`
      : `trace.moe 当前网络出口 ${accountId} 并发限制繁忙（额度 ${usage}），稍后重试`;
    error.traceAccount = {
      id: accountId,
      quota: Number.isFinite(quota) ? quota : null,
      quotaUsed: Number.isFinite(quotaUsed) ? quotaUsed : null,
    };
  } catch (diagnosticError) {
    error.code = "TRACE_CONCURRENCY";
    error.message = `trace.moe 返回 402，且配额诊断失败：${formatNetworkError(diagnosticError)}`;
  }
}

function formatNetworkError(error) {
  const cause = error?.cause || error;
  const parts = [
    cause?.code,
    cause?.message,
  ].filter(Boolean);
  return [...new Set(parts)].join(" - ") || error?.message || "未知网络错误";
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(createHttpError(413, "请求体过大"));
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let exceeded = false;
    req.on("data", (chunk) => {
      if (exceeded) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        reject(createHttpError(413, "请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) return;
      try {
        const str = Buffer.concat(chunks).toString("utf-8");
        resolve(str ? JSON.parse(str) : {});
      } catch (error) {
        reject(createHttpError(400, `JSON 格式错误: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

async function fetchRandomSakugabooruVideo(
  customTags = "",
  excludedCopyrightTags = new Set(),
  filterConfig = DEFAULT_SAKUGABOORU_FILTER,
) {
  const tags = normalizeSakugabooruTags(customTags, filterConfig);
  const pool = getSakugabooruCandidatePool(tags);
  const takeOperation = pool.takeChain.then(async () => {
    let skippedByCopyright = 0;
    for (let attempt = 0; attempt < SAKUGABOORU_COPYRIGHT_FILTER_ATTEMPTS; attempt++) {
      const post = await takeSakugabooruCandidate(pool, tags);
      post.copyrightTags = await resolveSakugabooruCopyrightTags(post.tags);
      if (post.copyrightTags.some((tag) => excludedCopyrightTags.has(tag))) {
        skippedByCopyright++;
        console.log(`[去重] 跳过已答题动漫: #${post.id}，版权标签: ${post.copyrightTags.join(', ')}`);
        continue;
      }

      const previewResult = await prepareSakugabooruTraceInput(post);
      if (previewResult === "rejected") continue;
      if (skippedByCopyright > 0) {
        console.log(`[去重] 本次跳过 ${skippedByCopyright} 个已答题动漫后找到新题目`);
      }
      return post;
    }

    throw new Error(
      `连续 ${SAKUGABOORU_COPYRIGHT_FILTER_ATTEMPTS} 个随机帖子均命中最近作品标签或预览图质量不足，稍后重试`,
    );
  });
  pool.takeChain = takeOperation.catch(() => {});
  return takeOperation;
}

async function resolveSakugabooruCopyrightTags(tagString) {
  const postTags = [...new Set(
    String(tagString || "")
      .split(/\s+/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  )];
  const unresolvedTags = postTags.filter((tag) => !sakugabooruCopyrightTagCache.has(tag));

  if (unresolvedTags.length > 0) {
    const apiUrl = new URL(SAKUGABOORU_RELATED_TAG_API_URL);
    apiUrl.searchParams.set("tags", unresolvedTags.join(" "));
    apiUrl.searchParams.set("type", "copyright");

    const response = await fetchWithRetry(apiUrl, {
      headers: {
        "Accept": "application/json",
        "Referer": "https://www.sakugabooru.com/",
      },
    }, {
      attempts: SAKUGABOORU_RETRY_LIMIT,
      label: "Sakugabooru 标签",
    });
    const data = await response.json();
    const relatedTags = data?.value && typeof data.value === "object" ? data.value : data;

    for (const tag of unresolvedTags) {
      const relations = Array.isArray(relatedTags?.[tag]) ? relatedTags[tag] : [];
      const isCopyright = relations.some((relation) => (
        Array.isArray(relation) && relation[0] === tag
      ));
      cacheSakugabooruCopyrightTag(tag, isCopyright);
    }
  }

  return postTags.filter((tag) => sakugabooruCopyrightTagCache.get(tag) === true);
}

function cacheSakugabooruCopyrightTag(tag, isCopyright) {
  if (sakugabooruCopyrightTagCache.has(tag)) {
    sakugabooruCopyrightTagCache.delete(tag);
  }
  sakugabooruCopyrightTagCache.set(tag, isCopyright);

  while (sakugabooruCopyrightTagCache.size > SAKUGABOORU_TAG_TYPE_CACHE_LIMIT) {
    const oldestTag = sakugabooruCopyrightTagCache.keys().next().value;
    sakugabooruCopyrightTagCache.delete(oldestTag);
  }
}

function normalizeExcludedCopyrightTags(values) {
  const normalized = [];
  const seen = new Set();

  for (const value of values || []) {
    const tag = String(value || "").trim();
    if (
      !tag
      || tag.length > 128
      || !/^[a-zA-Z0-9_:\-.]+$/.test(tag)
      || seen.has(tag)
    ) continue;
    seen.add(tag);
    normalized.push(tag);
    if (normalized.length >= MAX_EXCLUDED_COPYRIGHT_TAGS) break;
  }

  return new Set(normalized);
}

async function prepareSakugabooruTraceInput(post) {
  post.traceInputUrl = post.fileUrl;
  post.traceInputType = "video-fallback";
  post.previewQuality = null;

  if (!post.previewUrl) {
    console.warn(`Sakugabooru #${post.id} 没有有效预览图，回退视频首帧识别`);
    return "fallback";
  }

  try {
    const previewQuality = await inspectSakugabooruPreview(post);
    post.previewQuality = previewQuality;
    if (!previewQuality.accepted) {
      console.log(
        `跳过 Sakugabooru #${post.id} 低质量预览图: ${previewQuality.reason}`
        + `（${formatPreviewQuality(previewQuality)}）`,
      );
      return "rejected";
    }

    post.traceInputUrl = post.previewUrl;
    post.traceInputType = "preview";
    console.log(
      `Sakugabooru #${post.id} 预览图质量通过（${formatPreviewQuality(previewQuality)}）`,
    );
    return "preview";
  } catch (error) {
    console.warn(`Sakugabooru #${post.id} 预览图检查失败，回退视频首帧识别: ${error.message}`);
    return "fallback";
  }
}

async function inspectSakugabooruPreview(post) {
  if (
    Number.isFinite(post.previewWidth)
    && Number.isFinite(post.previewHeight)
    && (post.previewWidth < MIN_PREVIEW_WIDTH || post.previewHeight < MIN_PREVIEW_HEIGHT)
  ) {
    return {
      accepted: false,
      reason: `尺寸 ${post.previewWidth}x${post.previewHeight} 过小`,
      width: post.previewWidth,
      height: post.previewHeight,
      bytes: 0,
    };
  }

  const response = await fetchWithRetry(post.previewUrl, {
    headers: {
      "Accept": "image/jpeg",
      "Referer": "https://www.sakugabooru.com/",
    },
  }, {
    attempts: 2,
    label: "Sakugabooru 预览图",
  });
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/jpeg")) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`预览图类型无效: ${contentType || "缺失"}`);
  }

  const buffer = await readResponseBodyWithLimit(
    response,
    MAX_PREVIEW_IMAGE_BYTES,
    "Sakugabooru 预览图",
  );
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("预览图不是有效 JPEG");
  }

  let decoded;
  try {
    decoded = jpeg.decode(buffer, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 2,
      maxMemoryUsageInMB: 16,
    });
  } catch (error) {
    throw new Error(`JPEG 解码失败: ${error.message}`);
  }

  return analyzePreviewPixels(decoded, buffer.length);
}

function analyzePreviewPixels(image, bytes) {
  const { width, height, data } = image;
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < MIN_PREVIEW_WIDTH
    || height < MIN_PREVIEW_HEIGHT
  ) {
    return {
      accepted: false,
      reason: `实际尺寸 ${width || 0}x${height || 0} 过小`,
      width: width || 0,
      height: height || 0,
      bytes,
    };
  }

  const pixelCount = width * height;
  const channels = data.length === pixelCount * 4 ? 4 : 3;
  if (data.length < pixelCount * channels) {
    throw new Error("JPEG 像素数据长度无效");
  }

  const luminance = new Uint8Array(pixelCount);
  const histogram = new Uint32Array(16);
  let sum = 0;
  let sumSquares = 0;
  let darkPixels = 0;
  let brightPixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * channels;
    const value = Math.round(
      data[offset] * 0.2126
      + data[offset + 1] * 0.7152
      + data[offset + 2] * 0.0722,
    );
    luminance[pixel] = value;
    histogram[Math.min(15, value >> 4)] += 1;
    sum += value;
    sumSquares += value * value;
    if (value <= 10) darkPixels += 1;
    if (value >= 245) brightPixels += 1;
  }

  let edgeTotal = 0;
  let edgeCount = 0;
  for (let y = 1; y < height; y += 2) {
    for (let x = 1; x < width; x += 2) {
      const index = y * width + x;
      edgeTotal += Math.abs(luminance[index] - luminance[index - 1]);
      edgeTotal += Math.abs(luminance[index] - luminance[index - width]);
      edgeCount += 2;
    }
  }

  let entropy = 0;
  for (const count of histogram) {
    if (count === 0) continue;
    const probability = count / pixelCount;
    entropy -= probability * Math.log2(probability);
  }

  const mean = sum / pixelCount;
  const variance = Math.max(0, sumSquares / pixelCount - mean * mean);
  const standardDeviation = Math.sqrt(variance);
  const darkRatio = darkPixels / pixelCount;
  const brightRatio = brightPixels / pixelCount;
  const edgeMean = edgeCount ? edgeTotal / edgeCount : 0;

  const metrics = {
    width,
    height,
    bytes,
    mean: roundMetric(mean),
    standardDeviation: roundMetric(standardDeviation),
    entropy: roundMetric(entropy),
    edgeMean: roundMetric(edgeMean),
    darkRatio: roundMetric(darkRatio),
    brightRatio: roundMetric(brightRatio),
  };

  if (darkRatio >= 0.985 && mean <= 10) {
    return { accepted: false, reason: "画面接近全黑", ...metrics };
  }
  if (brightRatio >= 0.985 && mean >= 245) {
    return { accepted: false, reason: "画面接近全白", ...metrics };
  }
  if (standardDeviation < 8 && entropy < 1.5 && edgeMean < 2.5) {
    return { accepted: false, reason: "画面对比度和有效细节过低", ...metrics };
  }

  return { accepted: true, reason: "质量检查通过", ...metrics };
}

function roundMetric(value) {
  return Math.round(value * 1000) / 1000;
}

function formatPreviewQuality(quality) {
  return [
    `${quality.width || 0}x${quality.height || 0}`,
    formatBytes(quality.bytes || 0),
    `亮度 ${quality.mean ?? "-"}`,
    `对比度 ${quality.standardDeviation ?? "-"}`,
    `熵 ${quality.entropy ?? "-"}`,
    `边缘 ${quality.edgeMean ?? "-"}`,
  ].join(", ");
}

async function readResponseBodyWithLimit(response, maximumBytes, label) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label}超过 ${formatBytes(maximumBytes)} 限制`);
  }
  if (!response.body) {
    throw new Error(`${label}响应没有内容`);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${label}下载超过 ${formatBytes(maximumBytes)} 限制`);
    }
    chunks.push(chunk);
  }
  if (totalBytes === 0) {
    throw new Error(`${label}为空`);
  }
  return Buffer.concat(chunks, totalBytes);
}

function getSakugabooruCandidatePool(tags) {
  let pool = sakugabooruCandidatePools.get(tags);
  if (!pool) {
    pool = {
      items: [],
      recentIds: [],
      refillPromise: null,
      takeChain: Promise.resolve(),
    };
  } else {
    sakugabooruCandidatePools.delete(tags);
  }
  sakugabooruCandidatePools.set(tags, pool);

  while (sakugabooruCandidatePools.size > SAKUGABOORU_CANDIDATE_POOL_KEY_LIMIT) {
    const oldestKey = sakugabooruCandidatePools.keys().next().value;
    sakugabooruCandidatePools.delete(oldestKey);
  }
  return pool;
}

async function takeSakugabooruCandidate(pool, tags) {
  if (getSakugabooruPoolSize(pool) === 0) {
    await refillSakugabooruCandidatePool(pool, tags);
  }

  const post = pool.items.shift();
  if (!post) {
    throw new Error(`Sakugabooru 本次未返回不超过 ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB 的 mp4/webm 视频`);
  }

  pool.recentIds.push(post.id);
  while (pool.recentIds.length > SAKUGABOORU_RECENT_POST_LIMIT) {
    pool.recentIds.shift();
  }

  if (getSakugabooruPoolSize(pool) < SAKUGABOORU_CANDIDATE_LOW_WATERMARK) {
    void refillSakugabooruCandidatePool(pool, tags).catch((error) => {
      console.warn("后台补充 Sakugabooru 候选失败:", error.message);
    });
  }

  return post;
}

async function refillSakugabooruCandidatePool(pool, tags) {
  if (pool.refillPromise) {
    return pool.refillPromise;
  }

  pool.refillPromise = (async () => {
    const apiUrl = new URL(SAKUGABOORU_API_URL);
    apiUrl.searchParams.set("limit", String(SAKUGABOORU_CANDIDATE_FETCH_LIMIT));
    apiUrl.searchParams.set("tags", tags);

    const response = await fetchWithRetry(apiUrl, {
      headers: {
        "Accept": "application/json",
        "Referer": "https://www.sakugabooru.com/",
      },
    }, {
      attempts: SAKUGABOORU_RETRY_LIMIT,
      label: "Sakugabooru",
    });

    const data = await response.json();
    const posts = Array.isArray(data) ? data : data?.posts || data?.value || [];
    const normalizedPosts = posts
      .map(normalizeSakugabooruVideoPost)
      .filter(Boolean);
    const queuedIds = new Set(pool.items.map((item) => item.id));
    const recentIds = new Set(pool.recentIds);
    const unusedPosts = normalizedPosts.filter((post) => !queuedIds.has(post.id) && !recentIds.has(post.id));
    const shuffledPosts = shuffleArray(unusedPosts);

    for (const post of shuffledPosts) {
      if (pool.items.length >= SAKUGABOORU_CANDIDATE_POOL_LIMIT) break;
      pool.items.push(post);
    }
    console.log(
      `Sakugabooru 候选队列: ${getSakugabooruPoolSize(pool)}/${SAKUGABOORU_CANDIDATE_POOL_LIMIT}`
      + `（筛选键 ${tags}）`,
    );
  })();

  try {
    await pool.refillPromise;
  } finally {
    pool.refillPromise = null;
  }
}

function getSakugabooruPoolSize(pool) {
  return pool.items.length;
}

function normalizeSakugabooruVideoPost(item) {
  const id = Number(item?.id);
  const fileExtension = String(item?.file_ext || "").toLowerCase();
  const fileSize = Number(item?.file_size);
  if (
    !Number.isInteger(id)
    || id <= 0
    || !VIDEO_EXTENSIONS.has(fileExtension)
    || !Number.isFinite(fileSize)
    || fileSize <= 0
    || fileSize > MAX_VIDEO_BYTES
  ) {
    return null;
  }

  try {
    let previewUrl = null;
    try {
      previewUrl = validateSakugabooruPreviewUrl(item.preview_url);
    } catch {
      // 预览图不可用时保留视频候选，后续回退到原视频 URL。
    }
    return {
      id,
      fileUrl: validateSakugabooruVideoUrl(item.file_url),
      fileExtension,
      fileSize,
      tags: item.tags || "",
      score: item.score ?? null,
      source: item.source || "",
      previewUrl,
      previewWidth: Number(item.actual_preview_width || item.preview_width) || null,
      previewHeight: Number(item.actual_preview_height || item.preview_height) || null,
    };
  } catch {
    return null;
  }
}

function shuffleArray(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function normalizeSakugabooruTags(customTags, filterConfig = DEFAULT_SAKUGABOORU_FILTER) {
  const safeCustomTags = String(customTags || "")
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter((tag) => /^[a-zA-Z0-9_:\-.]+$/.test(tag))
    .filter((tag) => tag.replace(/^-/, "") !== "animated")
    .filter((tag) => !/^(order|rating|score|date):/i.test(tag))
    .slice(0, 4);

  const filterTags = [];
  const { startDate, endDate, minScore, maxScore, rating } = validateSakugabooruFilter(filterConfig);

  if (startDate && endDate) {
    filterTags.push(`date:${startDate}..${endDate}`);
  } else if (startDate) {
    filterTags.push(`date:>=${startDate}`);
  } else if (endDate) {
    filterTags.push(`date:<=${endDate}`);
  }

  if (minScore !== null && maxScore !== null) {
    filterTags.push(`score:${minScore}..${maxScore}`);
  } else if (minScore !== null) {
    filterTags.push(`score:>=${minScore}`);
  } else if (maxScore !== null) {
    filterTags.push(`score:<=${maxScore}`);
  }

  if (rating) {
    filterTags.push(`rating:${rating}`);
  }

  return [...safeCustomTags, "animated", ...filterTags, "order:random"].join(" ");
}

function validateSakugabooruVideoUrl(value) {
  const videoUrl = new URL(value);
  const hostname = videoUrl.hostname.toLowerCase();
  const extension = videoUrl.pathname.split(".").pop()?.toLowerCase();
  if (videoUrl.protocol !== "https:" || !isSakugabooruHostname(hostname) || !VIDEO_EXTENSIONS.has(extension)) {
    throw new Error("Sakugabooru 返回了无效的视频地址");
  }
  return videoUrl.toString();
}

function validateSakugabooruPreviewUrl(value) {
  const previewUrl = new URL(value);
  const hostname = previewUrl.hostname.toLowerCase();
  const extension = previewUrl.pathname.split(".").pop()?.toLowerCase();
  if (
    previewUrl.protocol !== "https:"
    || !isSakugabooruHostname(hostname)
    || !["jpg", "jpeg"].includes(extension)
  ) {
    throw new Error("Sakugabooru 返回了无效的预览图地址");
  }
  return previewUrl.toString();
}

function isSakugabooruHostname(hostname) {
  return hostname === "sakugabooru.com" || hostname.endsWith(".sakugabooru.com");
}

function selectBestTraceResult(traceData) {
  return (traceData?.result || [])
    .filter((result) => result?.image)
    .filter((result) => result.anilist?.isAdult !== true)
    .sort((left, right) => (Number(right.similarity) || 0) - (Number(left.similarity) || 0))[0] || null;
}

async function resolveAnimeTitles(traceResult) {
  let traceAnilist = traceResult?.anilist && typeof traceResult.anilist === "object"
    ? traceResult.anilist
    : {};
  const anilistId = Number(traceAnilist.id || traceResult?.anilist);
  const hasStructuredTitle = Object.values(traceAnilist.title || {}).some(normalizeTitleValue);

  if (Number.isInteger(anilistId) && anilistId > 0 && !hasStructuredTitle) {
    try {
      const detailed = await fetchAniListById(anilistId);
      traceAnilist = mergeAniListMedia(traceAnilist, detailed);
    } catch (error) {
      console.warn(`AniList 详情读取失败 (${anilistId}):`, error.message);
    }
  }

  if (traceAnilist.isAdult === true) {
    throw new Error("识别结果为成人内容，已跳过");
  }

  const titleObject = traceAnilist?.title || {};
  const originalTitle = titleObject.romaji
    || titleObject.english
    || titleObject.native
    || cleanFilename(traceResult?.filename);
  if (!originalTitle) {
    throw new Error("未获取到番剧名称");
  }

  const traceChineseTitle = findChineseTraceTitle(traceAnilist);
  const resolvedTitle = traceChineseTitle || originalTitle;
  const sourceText = titleObject.native
    || titleObject.english
    || titleObject.romaji
    || originalTitle;
  const sourceLanguage = titleObject.native
    ? "ja"
    : titleObject.english
      ? "en"
      : "auto";

  return {
    title: resolvedTitle,
    originalTitle,
    japaneseTitle: titleObject.native || "",
    englishTitle: titleObject.english || "",
    titleLanguage: traceChineseTitle ? "zh" : "original",
    titleSource: traceChineseTitle ? "trace-chinese-title" : "original",
    translation: {
      cacheKey: `${sourceLanguage}:${sourceText}`,
      text: sourceText,
      sourceLanguage,
    },
    anilist: Object.keys(traceAnilist || {}).length > 0 ? traceAnilist : null,
  };
}

async function fetchAniListById(id) {
  if (anilistCache.has(id)) {
    const cached = anilistCache.get(id);
    anilistCache.delete(id);
    anilistCache.set(id, cached);
    return cached;
  }

  const request = (async () => {
    const query = `
      query ($id: Int!) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          countryOfOrigin
          isAdult
          title {
            romaji
            english
            native
          }
          synonyms
        }
      }
    `;
    const response = await fetchWithRetry(ANILIST_API_URL, {
      method: "POST",
      timeoutMs: 6000,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ query, variables: { id } }),
    }, {
      attempts: 1,
      label: "AniList",
    });
    const data = await response.json();
    if (data?.errors?.length || !data?.data?.Media) {
      throw new Error(data?.errors?.[0]?.message || "未找到番剧");
    }
    return data.data.Media;
  })();

  anilistCache.set(id, request);
  trimCache(anilistCache, ANILIST_CACHE_LIMIT);
  try {
    return await request;
  } catch (error) {
    anilistCache.delete(id);
    throw error;
  }
}

function mergeAniListMedia(base, detailed) {
  return {
    ...base,
    ...detailed,
    title: {
      ...(base?.title || {}),
      ...(detailed?.title || {}),
    },
  };
}

function normalizeTitleValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function findChineseTraceTitle(anilist = {}) {
  const title = anilist?.title && typeof anilist.title === "object" ? anilist.title : {};
  const synonyms = Array.isArray(anilist?.synonyms) ? anilist.synonyms : [];
  const candidates = [
    ...synonyms,
    title.native,
    title.english,
    title.romaji,
  ];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = normalizeTitleValue(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (isLikelyChineseTitle(normalized)) return normalized;
  }
  return "";
}

function isLikelyChineseTitle(value) {
  // 简繁中文都使用 Han 字符；排除日文假名和韩文，避免把常见日/韩标题误判为中文。
  return /\p{Script=Han}/u.test(value)
    && !/[\u3040-\u30ff\u31f0-\u31ff\u1100-\u11ff\uac00-\ud7af]/u.test(value);
}

async function validateDeepSeekApiKey(deepSeekApiKey) {
  try {
    const response = await fetchWithRetry(DEEPSEEK_MODELS_API_URL, {
      method: "GET",
      dispatcher: deepSeekDispatcher,
      suppressConfiguredProxyError: true,
      timeoutMs: 10000,
      bufferResponseBody: true,
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${deepSeekApiKey}`,
      },
    }, {
      attempts: 1,
      label: "DeepSeek API Key 检测",
    });
    const data = await response.json();
    const modelIds = Array.isArray(data?.data)
      ? data.data.map((model) => normalizeTitleValue(model?.id)).filter(Boolean)
      : [];
    if (!modelIds.includes(DEEPSEEK_TRANS_MODEL)) {
      return {
        valid: false,
        message: `API Key 有效，但当前账户无法使用模型 ${DEEPSEEK_TRANS_MODEL}`,
      };
    }
    return {
      valid: true,
      message: `API Key 可用，已检测到模型 ${DEEPSEEK_TRANS_MODEL}`,
    };
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      return {
        valid: false,
        message: "API Key 无效或没有访问权限",
      };
    }
    if (error.status === 402) {
      return {
        valid: false,
        message: "API Key 有效，但账户余额或额度不足",
      };
    }
    if (error.status === 429) {
      throw createHttpError(503, "DeepSeek 请求过于频繁，请稍后再检测");
    }
    throw createHttpError(502, `暂时无法连接 DeepSeek：${formatNetworkError(error)}`);
  }
}

async function translateToChinese(text, sourceLanguage = "auto", deepSeekApiKey = "") {
  if (!text) return "";
  if (!deepSeekApiKey) {
    throw new Error("未配置 DEEPSEEK_API_KEY");
  }

  const systemPrompt = [
    "你是动漫名称翻译助手。无论输入是什么语言，你都只输出一个结果：中国大陆官方简体中文译名。",
    "",
    "规则：",
    "1. 输入可能是日文、英文、罗马音、繁体中文或简体中文，全部翻译为大陆简体中文",
    "2. 优先使用大陆官方译名或 B站/腾讯视频等主流平台通用译名",
    "3. 只输出简体中文译名本身，不加任何解释、标点或备注",
    "4. 有多个译名时只返回最通用的一个，禁止输出台译、港译",
    "5. 输入已经是简体中文时原样返回",
    "6. 无官方译名时给出最通用的民间简体译名，不备注",
  ].join("\n");

  const payload = JSON.stringify({
    model: DEEPSEEK_TRANS_MODEL,
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    temperature: 0.1,
    max_tokens: 50,
  });

  const response = await fetchWithRetry(DEEPSEEK_API_URL, {
    method: "POST",
    dispatcher: deepSeekDispatcher,
    suppressConfiguredProxyError: true,
    timeoutMs: DEEPSEEK_TRANSLATION_TIMEOUT_MS,
    bufferResponseBody: true,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${deepSeekApiKey}`,
    },
    body: payload,
  }, {
    // attempts 包含首次请求：2 次尝试 = 首次失败后仅重试 1 次。
    attempts: DEEPSEEK_TRANSLATION_RETRY_COUNT + 1,
    label: "DeepSeek 翻译",
  });
  const data = await response.json();

  if (data?.error) {
    const dsError = data.error;
    throw new Error(`${dsError.type || "DEEPSEEK_ERROR"}: ${dsError.message || "未知错误"}`);
  }

  const translatedTitle = normalizeTitleValue(data?.choices?.[0]?.message?.content);
  if (!translatedTitle) {
    throw new Error("DeepSeek 翻译未返回有效中文标题");
  }

  return translatedTitle;
}

function trimCache(cache, maximumSize) {
  while (cache.size > maximumSize) {
    cache.delete(cache.keys().next().value);
  }
}

async function fetchWithRetry(url, fetchOptions = {}, retryOptions = {}) {
  const attempts = Math.max(1, retryOptions.attempts || 1);
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchWithTimeout(url, fetchOptions);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      await delay(getRetryDelayMs(attempt));
      continue;
    }

    if (response.ok) {
      return response;
    }

    const body = await response.text().catch(() => "");
    const error = new Error(`${retryOptions.label || "上游 API"} HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    error.status = response.status;
    error.body = body;
    lastError = error;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts - 1) {
      throw error;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    await delay(retryAfterMs ?? getRetryDelayMs(attempt));
  }

  throw lastError || new Error(`${retryOptions.label || "上游 API"} 请求失败`);
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(30000, Math.max(0, seconds * 1000));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(30000, Math.max(0, timestamp - Date.now()))
    : null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getRetryDelayMs(attempt, baseMs = 500) {
  const exponential = Math.min(8000, baseMs * (2 ** attempt));
  return exponential + Math.round(Math.random() * Math.min(500, exponential * 0.25));
}

async function fetchWithTimeout(url, options = {}) {
  const {
    timeoutMs = REQUEST_TIMEOUT_MS,
    bufferResponseBody = false,
    suppressConfiguredProxyError = false,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await undiciFetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "User-Agent": "local-anime-frame-quiz/1.0",
        ...fetchOptions.headers,
      },
    });
    if (!bufferResponseBody) return response;

    // 某些 fetch 实现会在只收到响应头时就结束 await。翻译请求先在超时计时器内
    // 读完响应体，确保“单次最多 3 秒”覆盖完整请求，而不只是建立连接。
    const body = await response.arrayBuffer();
    return new UndiciResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    const errorCode = error?.cause?.code || error?.code;
    if (!suppressConfiguredProxyError && configuredProxyAvailable && startupProxy && errorCode === "ECONNREFUSED") {
      console.error(`代理连接失败：无法连接到 ${startupProxy}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanFilename(filename) {
  if (!filename) return "";
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/\[[^\]]*]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\d{1,4}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function serveStatic(pathname, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, ["GET", "HEAD"]);
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, "Invalid URL path");
    return;
  }

  const relativePath = decodedPath.replace(/^[/\\]+/, "") || "index.html";
  const filePath = resolve(PUBLIC_DIR, relativePath);
  const pathFromPublic = relative(PUBLIC_DIR, filePath);
  if (pathFromPublic.startsWith("..") || isAbsolute(pathFromPublic)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": content.length,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function sendMethodNotAllowed(res, allowedMethods) {
  res.writeHead(405, {
    "Allow": allowedMethods.join(", "),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify({
    error: "Method not allowed",
    code: "METHOD_NOT_ALLOWED",
  }));
}
