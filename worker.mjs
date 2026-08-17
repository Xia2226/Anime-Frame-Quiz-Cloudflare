import { GAME_CONFIG } from "./public/js/game-config.js";
import {
  fetchWithRetry,
  httpError,
  json,
  readJsonBody,
  readJsonResponse,
  redactLogMessage,
  requireMethod,
  withSecurityHeaders,
} from "./src/http.mjs";

const SAKUGABOORU_API_URL = "https://www.sakugabooru.com/post.json";
const SAKUGABOORU_RELATED_TAG_API_URL = "https://www.sakugabooru.com/tag/related.json";
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODELS_API_URL = "https://api.deepseek.com/v1/models";
const DEEPSEEK_BALANCE_API_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_TRANS_MODEL = "deepseek-v4-flash";
const DEEPSEEK_API_KEY_MODES = new Set(["user", "site"]);
const DEFAULT_DEEPSEEK_API_KEY_MODE = "user";

const MAX_UPSTREAM_JSON_BYTES = 1024 * 1024;
const USERNAME_MAX_LENGTH = 24;
const MAX_HARD_QUESTION_COUNT = 10000;
const MAX_HARD_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000;
const LEADERBOARD_MODES = new Set(["classic", "hard"]);
const FEEDBACK_TYPES = new Set(["anime_error", "bug", "feature", "other"]);
const FEEDBACK_CONTENT_MAX_LENGTH = 2000;
const FEEDBACK_CONTACT_MAX_LENGTH = 128;
const ANNOUNCEMENT_TITLE_MAX_LENGTH = 80;
const ANNOUNCEMENT_CONTENT_MAX_LENGTH = 2000;
const ANNOUNCEMENT_DISPLAY_LIMIT = 20;
const ANIME_LIBRARY_CACHE_SECONDS = 60 * 60;
const ANIME_LIBRARY_CLIENT_CACHE_CONTROL = "private, no-store, max-age=0, must-revalidate";
const FEEDBACK_RETENTION_DAYS = 30;
const ANALYTICS_RETENTION_DAYS = 90;
const ANALYTICS_PATH_MAX_LENGTH = 200;
const LOCAL_SCORE_POINTS = [...new Set(GAME_CONFIG.scoreThresholds.map((tier) => Number(tier.points)))];
const LOCAL_MAX_POINTS = Math.max(...LOCAL_SCORE_POINTS);
const LOCAL_REACHABLE_SCORES = buildReachableScoreSets(
  GAME_CONFIG.localQuestionCount,
  LOCAL_SCORE_POINTS,
);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEADERBOARD_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: GAME_CONFIG.leaderboard.timeZone,
  year: "numeric", month: "2-digit", day: "2-digit",
});
const MAX_EXCLUDED_COPYRIGHT_TAGS = 512;
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
const CANDIDATE_FETCH_LIMIT = 8;
const CANDIDATE_POOL_LIMIT = 24;
const CANDIDATE_POOL_KEY_LIMIT = 4;
const RECENT_POST_LIMIT = 64;
const COPYRIGHT_CACHE_LIMIT = 10000;
const SOURCE_ATTEMPTS = 24;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

// 规范域名：www 子域名统一 301 跳转到裸域，避免搜索引擎重复收录
const CANONICAL_HOSTNAME = "animeframequiz.cn";
const WWW_HOSTNAME = `www.${CANONICAL_HOSTNAME}`;

const DEFAULT_FILTER = {
  startDate: "",
  endDate: "",
  minScore: null,
  maxScore: null,
  rating: "s",
};

// These caches are operational only. Cloudflare may discard them whenever an isolate restarts.
const candidatePools = new Map();
const copyrightTagCache = new Map();

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    // www 子域名 301 跳转到裸域，保留路径与查询参数
    if (url.hostname === WWW_HOSTNAME) {
      url.hostname = CANONICAL_HOSTNAME;
      return Response.redirect(url.toString(), 301);
    }
    try {
      if (url.pathname === "/robots.txt") {
        requireMethod(request, "GET");
        return createRobotsResponse(url);
      }

      if (url.pathname === "/sitemap.xml") {
        requireMethod(request, "GET");
        return createSitemapResponse(url);
      }

      if (url.pathname === "/api/hard/sources") {
        requireMethod(request, "POST");
        const body = await readJsonBody(request, 64 * 1024);
        return json({ sources: await createHardSources(body) });
      }

      if (url.pathname === "/api/hard/config") {
        requireMethod(request, "GET");
        return json({
          apiKeyMode: getDeepSeekApiKeyMode(env),
        }, 200, { "Cache-Control": "no-store" });
      }

      if (url.pathname === "/api/hard/resolve") {
        requireMethod(request, "POST");
        const apiKey = getEffectiveDeepSeekApiKey(request, env);
        if (!apiKey) throw httpError(400, "请先输入并确认 DeepSeek API Key");
        const body = await readJsonBody(request, 128 * 1024);
        return json({ questions: await resolveHardQuestions(body, apiKey) });
      }

      if (url.pathname === "/api/hard/video-proxy") {
        // 浏览器 <video> 加载跨域视频不触发预检；此处防御性处理前端 fetch 视频字节的预检
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Headers": "Range",
              "Access-Control-Max-Age": "86400",
            },
          });
        }
        requireMethod(request, "GET");
        return await handleHardVideoProxy(request, url);
      }

      if (url.pathname === "/api/leaderboard") {
        if (request.method === "GET") {
          return await handleLeaderboardGet(request, url, env, context);
        }
        if (request.method === "POST") {
          return await handleLeaderboardPost(request, url, env);
        }
        requireMethod(request, "GET or POST");
      }

      if (url.pathname === "/api/deepseek/validate") {
        requireMethod(request, "POST");
        const apiKey = getRequestDeepSeekApiKey(request);
        if (!apiKey) {
          return json({ valid: false, message: "请先输入 DeepSeek API Key" }, 400);
        }
        return json(await validateDeepSeekApiKey(apiKey));
      }

      if (url.pathname === "/api/track") {
        requireMethod(request, "POST");
        return await handleTrackView(request, env);
      }

      if (url.pathname === "/api/feedback") {
        requireMethod(request, "POST");
        return await handleFeedbackPost(request, env);
      }

      if (url.pathname === "/api/announcements") {
        requireMethod(request, "GET");
        return await handleAnnouncements(env);
      }

      if (url.pathname === "/api/admin/leaderboard/days") {
        requireMethod(request, "GET");
        return await handleAdminLeaderboardDays(url, env);
      }

      if (url.pathname === "/api/admin/leaderboard") {
        requireMethod(request, "GET");
        return await handleAdminLeaderboardDetail(url, env);
      }

      if (url.pathname === "/api/admin/analytics") {
        requireMethod(request, "GET");
        return await handleAdminAnalytics(url, env);
      }

      if (url.pathname === "/api/admin/feedback") {
        if (request.method === "DELETE") {
          return await handleAdminFeedbackDelete(url, env);
        }
        requireMethod(request, "GET");
        return await handleAdminFeedbackList(url, env);
      }

      if (url.pathname === "/api/admin/anime") {
        if (request.method === "GET") {
          return await handleAdminAnimeList(request, url, env);
        }
        if (request.method === "PUT") {
          return await handleAdminAnimeToggle(request, env);
        }
        requireMethod(request, "GET or PUT");
      }

      if (url.pathname === "/api/admin/announcements") {
        if (request.method === "GET") {
          return await handleAdminAnnouncementsList(url, env);
        }
        if (request.method === "POST") {
          return await handleAdminAnnouncementsCreate(request, env);
        }
        if (request.method === "PUT") {
          return await handleAdminAnnouncementsUpdate(request, url, env);
        }
        if (request.method === "DELETE") {
          return await handleAdminAnnouncementsDelete(url, env);
        }
        requireMethod(request, "GET, POST, PUT or DELETE");
      }

      // 图库资源文件由 Worker 合并管理员启停状态后返回，前台无需改动
      if (url.pathname === "/data/anime-library.json") {
        requireMethod(request, "GET");
        return await handleAnimeLibrary(request, env, context);
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "API endpoint not found", code: "NOT_FOUND" }, 404);
      }

      if (!env.ASSETS) throw httpError(500, "静态资源绑定不可用");
      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse);
    } catch (error) {
      const statusCode = error?.statusCode || 500;
      console.error(JSON.stringify({
        level: "error",
        event: "request_failed",
        method: request.method,
        path: url.pathname,
        statusCode,
        code: error?.code || null,
        error: redactLogMessage(error?.message || error),
      }));
      return json({
        error: error?.message || "Internal server error",
        code: error?.code || null,
      }, statusCode);
    }
  },

  async scheduled(controller, env) {
    requireLeaderboardDatabase(env);
    const cutoffDate = new Date(
      controller.scheduledTime
        - (GAME_CONFIG.leaderboard.retentionDays - 1) * 24 * 60 * 60 * 1000,
    );
    const cutoffDay = getLeaderboardDayKey(cutoffDate);
    const feedbackCutoffMs = controller.scheduledTime
      - FEEDBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const analyticsCutoffMs = controller.scheduledTime
      - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const [leaderboardResult, feedbackResult, analyticsResult] = await env.DB.batch([
      env.DB.prepare("DELETE FROM daily_best WHERE day_key < ?").bind(cutoffDay),
      env.DB.prepare("DELETE FROM feedback WHERE created_at < ?").bind(feedbackCutoffMs),
      env.DB.prepare("DELETE FROM page_view WHERE created_at < ?").bind(analyticsCutoffMs),
    ]);
    console.log(JSON.stringify({
      level: "info",
      event: "retention_cleanup",
      leaderboard: {
        cutoffDay,
        rowsDeleted: leaderboardResult.meta?.changes ?? null,
      },
      feedback: {
        cutoffBefore: new Date(feedbackCutoffMs).toISOString(),
        rowsDeleted: feedbackResult.meta?.changes ?? null,
      },
      analytics: {
        cutoffBefore: new Date(analyticsCutoffMs).toISOString(),
        rowsDeleted: analyticsResult.meta?.changes ?? null,
      },
    }));
  },
};

function createRobotsResponse(url) {
  const sitemapUrl = new URL("/sitemap.xml", url).href;
  return withSecurityHeaders(new Response([
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /admin",
    `Sitemap: ${sitemapUrl}`,
    "",
  ].join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  }));
}

function createSitemapResponse(url) {
  const homeUrl = new URL("/", url).href;
  const libraryUrl = new URL("/library.html", url).href;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${homeUrl}</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${libraryUrl}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
</urlset>`;
  return withSecurityHeaders(new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  }));
}
async function createHardSources(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "请求体必须是对象");
  }
  const limit = input.limit ?? GAME_CONFIG.hard.batchSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > GAME_CONFIG.hard.batchSize) {
    throw httpError(400, `limit 必须在 1 到 ${GAME_CONFIG.hard.batchSize} 之间`);
  }
  const rawExclusions = input.excludeCopyrightTags ?? [];
  if (!Array.isArray(rawExclusions)) {
    throw httpError(400, "excludeCopyrightTags 必须是数组");
  }
  const excludedCopyrightTags = normalizeExcludedCopyrightTags(rawExclusions);
  const configuredFilter = GAME_CONFIG.hard.sakugabooruFilter;
  const sources = [];
  for (let index = 0; index < limit; index += 1) {
    const source = await createFrameSource(
      configuredFilter.tags,
      excludedCopyrightTags,
      configuredFilter,
    );
    sources.push(source);
    for (const tag of source.sakugabooru.copyrightTags) excludedCopyrightTags.add(tag);
  }
  return sources;
}

async function resolveHardQuestions(input, apiKey) {
  if (!input || typeof input !== "object" || !Array.isArray(input.entries)) {
    throw httpError(400, "entries 必须是数组");
  }
  if (input.entries.length < 1 || input.entries.length > GAME_CONFIG.hard.batchSize) {
    throw httpError(400, `entries 数量必须在 1 到 ${GAME_CONFIG.hard.batchSize} 之间`);
  }
  for (const entry of input.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw httpError(400, "entries 中存在无效题目");
    }
  }

  const questions = await Promise.all(input.entries.map((entry) => (
    resolveFrameQuestion(entry.source)
  )));

  // 把版权标签（罗马音作品名）批量交给 DeepSeek 翻译成简体中文官方译名
  const translationTargets = questions
    .map((question, questionIndex) => ({
      questionIndex,
      text: question.copyrightTag,
      needsTranslation: !isLikelyChineseTitle(question.copyrightTag),
    }))
    .filter((item) => item.needsTranslation && item.text);

  if (translationTargets.length > 0) {
    const translatedTitles = await translateCopyrightTagsToChineseBatch(translationTargets, apiKey);
    for (const target of translationTargets) {
      const translatedTitle = translatedTitles.get(target.questionIndex);
      if (translatedTitle) questions[target.questionIndex].title = translatedTitle;
    }
  }

  // 无版权标签或 DeepSeek 翻译失败的题目直接丢弃
  return questions.filter((question) => {
    if (!question.copyrightTag) return false;
    return isLikelyChineseTitle(question.copyrightTag)
      || question.title !== question.copyrightTag;
  });
}

async function translateCopyrightTagsToChineseBatch(items, apiKey) {
  const systemPrompt = [
    "你是动漫名称翻译助手。把输入数组中的每个罗马音作品标签转换为中国大陆最常用的简体中文官方动漫译名。",
    "输入是下划线分隔的罗马音标签，例如 bocchi_the_rock 或 kaguya_sama_love_is_war。",
    "只输出 JSON 数组，不要 Markdown、解释或额外字段。",
    "每项格式必须是 {\"index\":数字,\"title\":\"译名\"}，index 必须与输入一致。",
    "无法将标签识别为任何动漫作品时，title 返回 null。",
  ].join("\n");
  let response;
  try {
    response = await fetchWithRetry(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_TRANS_MODEL,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(items.map((item) => ({
            index: item.questionIndex,
            text: item.text,
          }))) },
        ],
        temperature: 0.1,
        max_tokens: Math.max(100, items.length * 80),
      }),
    }, { attempts: 2, label: "DeepSeek 批量翻译", timeoutMs: 6000 });
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw httpError(401, "DeepSeek API Key 无效或没有访问权限");
    if (error.status === 402) throw httpError(400, "DeepSeek 余额或额度不足");
    if (error.status === 429) throw httpError(503, "DeepSeek 请求过于频繁，请稍后重试");
    throw error;
  }
  const data = await readJsonResponse(response, 128 * 1024, "DeepSeek 批量翻译");
  const content = normalizeTitle(data?.choices?.[0]?.message?.content);
  const parsed = parseJsonArrayFromModel(content);
  const expectedIndexes = new Set(items.map((item) => item.questionIndex));
  const result = new Map();
  for (const item of parsed) {
    const index = Number(item?.index);
    const title = normalizeTitle(item?.title);
    if (!Number.isInteger(index) || !expectedIndexes.has(index) || !title || title.length > 200) continue;
    result.set(index, title);
  }
  // 允许部分条目识别失败（缺失即视为翻译失败，由调用方丢弃对应题目）
  return result;
}

function parseJsonArrayFromModel(content) {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start < 0 || end < start) throw httpError(502, "DeepSeek 批量翻译未返回 JSON 数组");
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    if (!Array.isArray(parsed)) throw new Error("不是数组");
    return parsed;
  } catch (error) {
    throw httpError(502, `DeepSeek 批量翻译 JSON 无效: ${error.message}`);
  }
}

async function handleLeaderboardGet(request, url, env, context) {
  const mode = normalizeLeaderboardMode(url.searchParams.get("mode"));
  const dayKey = getLeaderboardDayKey();
  requireLeaderboardDatabase(env);
  const cacheUrl = new URL("/api/leaderboard", request.url);
  cacheUrl.searchParams.set("mode", mode);
  cacheUrl.searchParams.set("dayKey", dayKey);
  const cacheRequest = new Request(cacheUrl, { method: "GET" });
  const cached = await caches.default.match(cacheRequest);
  if (cached) return cached;

  const queryResult = await createLeaderboardSelectStatement(env.DB, mode, dayKey).all();
  const entries = formatLeaderboardEntries(queryResult.results || []);
  const response = json({ dayKey, mode, entries }, 200, {
    "Cache-Control": `public, max-age=${GAME_CONFIG.leaderboard.cacheSeconds}`,
  });
  putCacheInBackground(context, cacheRequest, response, "leaderboard");
  return response;
}

async function handleLeaderboardPost(request, url, env) {
  const mode = normalizeLeaderboardMode(url.searchParams.get("mode"));
  requireLeaderboardDatabase(env);
  const body = await readJsonBody(request, 16 * 1024);
  const submission = normalizeLeaderboardSubmission(mode, body);
  const dayKey = getLeaderboardDayKey();
  const completedAt = Date.now();
  const upsert = createLeaderboardUpsertStatement(env.DB, dayKey, mode, submission, completedAt);
  const top = createLeaderboardSelectStatement(env.DB, mode, dayKey);
  const personal = env.DB.prepare(`
    SELECT participant_id, username, score, correct_count, question_count,
           accuracy_ppm, elapsed_ms, completed_at
    FROM daily_best
    WHERE day_key = ? AND mode = ? AND participant_id = ?
    LIMIT 1
  `).bind(dayKey, mode, submission.participantId);
  const [, topResult, personalResult] = await env.DB.batch([upsert, top, personal]);
  const rows = topResult.results || [];
  const entries = formatLeaderboardEntries(rows);
  const personalRow = personalResult.results?.[0] || null;
  const personalRankIndex = rows.findIndex((row) => row.participant_id === submission.participantId);
  const personalBest = personalRow
    ? formatLeaderboardEntry(personalRow, personalRankIndex >= 0 ? personalRankIndex + 1 : null)
    : null;
  return json({ dayKey, mode, entries, personalBest });
}

async function handleFeedbackPost(request, env) {
  requireLeaderboardDatabase(env);
  const body = await readJsonBody(request, 16 * 1024);
  const feedback = normalizeFeedbackSubmission(body);
  const createdAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO feedback (type, content, contact, created_at) VALUES (?, ?, ?, ?)",
  ).bind(
    feedback.type,
    feedback.content,
    feedback.contact,
    createdAt,
  ).run();
  return json({ ok: true, createdAt });
}

async function handleAdminFeedbackList(url, env) {
  requireLeaderboardDatabase(env);
  const typeFilter = parseAdminFeedbackTypeFilter(url.searchParams.get("type"));
  const limit = parsePageLimit(url.searchParams.get("limit"));
  const offset = parsePageOffset(url.searchParams.get("offset"));
  const conditions = typeFilter ? "WHERE type = ?" : "";
  const bindArgs = typeFilter ? [typeFilter] : [];
  const [countResult, listResult] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM feedback ${conditions}`).bind(...bindArgs),
    env.DB.prepare(
      `SELECT id, type, content, contact, created_at FROM feedback ${conditions}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(...bindArgs, limit, offset),
  ]);
  const items = (listResult.results || []).map((row) => ({
    id: row.id,
    type: row.type,
    content: row.content,
    contact: row.contact,
    createdAt: row.created_at,
  }));
  return json({ total: countResult.results?.[0]?.total ?? 0, limit, offset, items });
}

async function handleAdminFeedbackDelete(url, env) {
  requireLeaderboardDatabase(env);
  const id = parsePositiveId(url.searchParams.get("id"));
  const result = await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
  if (!(result.meta?.changes > 0)) throw httpError(404, "反馈记录不存在");
  return json({ ok: true });
}

function parsePositiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, "id 无效");
  return id;
}

function parseAdminFeedbackTypeFilter(value) {
  const type = String(value || "").trim();
  if (!type) return "";
  if (!FEEDBACK_TYPES.has(type)) {
    throw httpError(400, "type 必须是 anime_error、bug、feature 或 other");
  }
  return type;
}

function parsePageLimit(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 20;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw httpError(400, "limit 必须是 1 到 100 之间的整数");
  }
  return limit;
}

function parsePageOffset(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0) {
    throw httpError(400, "offset 必须是非负整数");
  }
  return offset;
}

async function handleAnimeLibrary(request, env, context) {
  const [assetResponse, overrideVersion] = await Promise.all([
    fetchAnimeLibraryAssetResponse(request, env),
    loadAnimeOverrideVersionSafely(env.DB),
  ]);
  const assetVersion = assetResponse.headers.get("etag");
  const cacheRequest = assetVersion && overrideVersion !== null
    ? createAnimeLibraryCacheRequest(request, assetVersion, overrideVersion)
    : null;
  if (cacheRequest) {
    const cached = await caches.default.match(cacheRequest);
    if (cached) {
      if (assetResponse.body) await assetResponse.body.cancel().catch(() => {});
      return createAnimeLibraryClientResponse(cached);
    }
  }

  const data = await mergeAnimeLibrary(await parseAnimeLibraryAsset(assetResponse), env);
  // 内部结果缓存一小时，但发给客户端的响应始终禁止缓存。这样每次请求都会进入 Worker，
  // 再按题库 ETag 和 D1 启停版本选择缓存；后台启停或重新部署后可立即切换到新版本。
  // D1 或缓存版本表异常时仍返回静态题库，但不缓存降级结果，避免故障恢复后继续命中旧状态。
  const cacheableResponse = cacheRequest
    ? json(data, 200, {
      "Cache-Control": `public, max-age=${ANIME_LIBRARY_CACHE_SECONDS}`,
    })
    : json(data);
  if (cacheRequest) putCacheInBackground(context, cacheRequest, cacheableResponse, "anime_library");
  return createAnimeLibraryClientResponse(cacheableResponse);
}

function createAnimeLibraryClientResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", ANIME_LIBRARY_CLIENT_CACHE_CONTROL);
  headers.delete("CDN-Cache-Control");
  headers.delete("Cloudflare-CDN-Cache-Control");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createAnimeLibraryCacheRequest(request, assetVersion, overrideVersion) {
  const cacheUrl = new URL("/data/anime-library.json", request.url);
  cacheUrl.search = "";
  cacheUrl.searchParams.set("asset", assetVersion);
  cacheUrl.searchParams.set("overrides", overrideVersion);
  return new Request(cacheUrl, { method: "GET" });
}

function putCacheInBackground(context, request, response, cacheName) {
  context.waitUntil(caches.default.put(request, response.clone()).catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "cache_put_failed",
      cache: cacheName,
      error: redactLogMessage(error?.message || error),
    }));
  }));
}

async function handleAdminAnimeList(request, url, env) {
  requireLeaderboardDatabase(env);
  const data = await loadMergedAnimeLibrary(request, env);
  const anime = Array.isArray(data?.anime) ? data.anime : [];
  const query = String(url.searchParams.get("query") || "").trim().toLocaleLowerCase("zh-CN");
  const status = String(url.searchParams.get("status") || "").trim();
  if (!["", "enabled", "disabled"].includes(status)) {
    throw httpError(400, "status 必须是 enabled 或 disabled");
  }
  const limit = parsePageLimit(url.searchParams.get("limit"));
  const offset = parsePageOffset(url.searchParams.get("offset"));
  const items = anime
    .filter((item) => {
      if (!item || typeof item !== "object") return false;
      const enabled = item.enabled !== false;
      if (status === "enabled" && !enabled) return false;
      if (status === "disabled" && enabled) return false;
      if (query) {
        const title = String(item.title || "").toLocaleLowerCase("zh-CN");
        const originalTitle = String(item.originalTitle || "").toLocaleLowerCase("zh-CN");
        const anidbId = String(item.anidbId ?? "");
        const bgmId = String(item.bgmId ?? "");
        if (![title, originalTitle, anidbId, bgmId].some((value) => value.includes(query))) return false;
      }
      return true;
    })
    // 默认按图库顺序倒序显示：图库中靠后的番剧排在最上面
    .reverse()
    .map((item) => ({
      anidbId: String(item.anidbId ?? ""),
      bgmId: String(item.bgmId ?? ""),
      title: String(item.title || ""),
      originalTitle: String(item.originalTitle || ""),
      date: String(item.date || ""),
      score: item.score ?? null,
      imageCount: Array.isArray(item.imageIds) ? item.imageIds.length : 0,
      cover: String(item.cover || ""),
      enabled: item.enabled !== false,
    }));
  return json({
    total: items.length,
    limit,
    offset,
    items: items.slice(offset, offset + limit),
  });
}

async function handleAdminAnimeToggle(request, env) {
  requireLeaderboardDatabase(env);
  const body = await readJsonBody(request, 16 * 1024);
  const anidbId = String(body?.anidbId ?? "").trim();
  if (!anidbId) throw httpError(400, "anidbId 不能为空");
  const enabled = Boolean(body?.enabled);
  const data = await loadMergedAnimeLibrary(request, env);
  const exists = (Array.isArray(data?.anime) ? data.anime : [])
    .some((item) => String(item?.anidbId ?? "") === anidbId);
  if (!exists) throw httpError(404, "图库中不存在该番剧");
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO anime_override (anidb_id, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(anidb_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).bind(anidbId, enabled ? 1 : 0, Date.now()),
    env.DB.prepare(
      "UPDATE anime_library_cache_version SET version = version + 1 WHERE id = 1",
    ),
  ]);
  return json({ ok: true, anidbId, enabled });
}

async function handleAnnouncements(env) {
  requireLeaderboardDatabase(env);
  const result = await env.DB.prepare(
    "SELECT id, title, content, pinned, created_at FROM announcements"
    + " WHERE active = 1 ORDER BY pinned DESC, created_at DESC LIMIT ?",
  ).bind(ANNOUNCEMENT_DISPLAY_LIMIT).all();
  const items = (result.results || []).map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
  }));
  // 不做缓存：公告数据量小且变更需即时可见，json() 默认 no-store 即可
  return json({ items });
}

async function handleAdminAnnouncementsList(url, env) {
  requireLeaderboardDatabase(env);
  const status = String(url.searchParams.get("status") || "").trim();
  if (!["", "active", "inactive"].includes(status)) {
    throw httpError(400, "status 必须是 active 或 inactive");
  }
  const limit = parsePageLimit(url.searchParams.get("limit"));
  const offset = parsePageOffset(url.searchParams.get("offset"));
  const conditions = status ? "WHERE active = ?" : "";
  const bindArgs = status ? [status === "active" ? 1 : 0] : [];
  const [countResult, listResult] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM announcements ${conditions}`).bind(...bindArgs),
    env.DB.prepare(
      `SELECT id, title, content, pinned, active, created_at, updated_at FROM announcements ${conditions}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(...bindArgs, limit, offset),
  ]);
  const items = (listResult.results || []).map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    pinned: row.pinned === 1,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return json({ total: countResult.results?.[0]?.total ?? 0, limit, offset, items });
}

async function handleAdminAnnouncementsCreate(request, env) {
  requireLeaderboardDatabase(env);
  const body = await readJsonBody(request, 16 * 1024);
  const announcement = normalizeAnnouncementSubmission(body);
  const now = Date.now();
  // 新公告默认「已下架」：需管理员手动上架后才会在前台展示
  const result = await env.DB.prepare(
    "INSERT INTO announcements (title, content, pinned, active, created_at, updated_at)"
    + " VALUES (?, ?, ?, 0, ?, ?)",
  ).bind(
    announcement.title,
    announcement.content,
    announcement.pinned ? 1 : 0,
    now,
    now,
  ).run();
  return json({ ok: true, id: result.meta?.last_row_id });
}

async function handleAdminAnnouncementsUpdate(request, url, env) {
  requireLeaderboardDatabase(env);
  const id = parsePositiveId(url.searchParams.get("id"));
  const body = await readJsonBody(request, 16 * 1024);
  // 更新接口必须显式指定 active，避免缺省置为上架而回滚管理员的上下架操作
  if (!body || typeof body.active !== "boolean") {
    throw httpError(400, "active 必须是布尔值");
  }
  const announcement = normalizeAnnouncementSubmission(body);
  const result = await env.DB.prepare(
    "UPDATE announcements SET title = ?, content = ?, pinned = ?, active = ?, updated_at = ? WHERE id = ?",
  ).bind(
    announcement.title,
    announcement.content,
    announcement.pinned ? 1 : 0,
    announcement.active ? 1 : 0,
    Date.now(),
    id,
  ).run();
  if (!(result.meta?.changes > 0)) throw httpError(404, "公告不存在");
  return json({ ok: true, id });
}

async function handleAdminAnnouncementsDelete(url, env) {
  requireLeaderboardDatabase(env);
  const id = parsePositiveId(url.searchParams.get("id"));
  const result = await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(id).run();
  if (!(result.meta?.changes > 0)) throw httpError(404, "公告不存在");
  return json({ ok: true });
}

function normalizeAnnouncementSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是对象");
  }
  const title = normalizeFeedbackText(body.title, "title", ANNOUNCEMENT_TITLE_MAX_LENGTH, true);
  const content = normalizeAnnouncementContent(body.content, "content", ANNOUNCEMENT_CONTENT_MAX_LENGTH);
  // 更新接口通过 active 控制上下架；创建接口忽略 active，一律默认下架
  const pinned = body.pinned === true;
  const active = body.active === true;
  return { title, content, pinned, active };
}

// 公告正文允许换行：统一换行符、静默移除零宽空格等不可见格式符，
// 其余控制字符（含孤立代理项）仍然拒绝
function normalizeAnnouncementContent(value, fieldName, maximumLength) {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw httpError(400, `${fieldName} 必须是字符串`);
  let text = value.normalize("NFKC").replace(/\r\n?/g, "\n");
  // 粘贴自网页/文档常带入零宽空格（U+200B）、方向标记等格式符，直接移除
  text = text.replace(/[\p{Cf}]/gu, "").trim();
  if (!text) throw httpError(400, `${fieldName} 不能为空`);
  if (Array.from(text).length > maximumLength) {
    throw httpError(400, `${fieldName} 长度不能超过 ${maximumLength} 个字符`);
  }
  if (/(?![\t\n\r])[\p{Cc}\p{Cs}]/u.test(text)) {
    throw httpError(400, `${fieldName} 包含不允许的控制字符`);
  }
  return text;
}

async function loadMergedAnimeLibrary(request, env) {
  const assetResponse = await fetchAnimeLibraryAssetResponse(request, env);
  return mergeAnimeLibrary(await parseAnimeLibraryAsset(assetResponse), env);
}

async function mergeAnimeLibrary(data, env) {
  if (!data || typeof data !== "object" || !Array.isArray(data.anime)) {
    throw httpError(502, "图库资源文件格式无效");
  }
  let overrides = new Map();
  if (env.DB) {
    try {
      overrides = await loadAnimeOverrides(env.DB);
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn",
        event: "anime_override_load_failed",
        error: redactLogMessage(error?.message || error),
      }));
    }
  }
  if (overrides.size > 0) {
    for (const anime of data.anime) {
      if (!anime || typeof anime !== "object") continue;
      const override = overrides.get(String(anime.anidbId ?? anime.bgmId ?? ""));
      if (override !== undefined) anime.enabled = override;
    }
  }
  return data;
}

async function fetchAnimeLibraryAssetResponse(request, env) {
  if (!env.ASSETS) throw httpError(500, "静态资源绑定不可用");
  const assetUrl = new URL("/data/anime-library.json", request.url);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
  }));
  if (!assetResponse.ok) {
    throw httpError(
      assetResponse.status === 404 ? 404 : 502,
      assetResponse.status === 404 ? "图库资源文件不存在" : "图库资源读取失败",
    );
  }
  return assetResponse;
}

async function parseAnimeLibraryAsset(response) {
  try {
    return await response.json();
  } catch {
    throw httpError(502, "图库资源文件不是有效 JSON");
  }
}

async function loadAnimeOverrides(db) {
  const result = await db.prepare("SELECT anidb_id, enabled FROM anime_override").all();
  const overrides = new Map();
  for (const row of result.results || []) {
    overrides.set(String(row.anidb_id), Number(row.enabled) === 1);
  }
  return overrides;
}

async function loadAnimeOverrideVersion(db) {
  if (!db) return "no-database";
  const row = await db.prepare(`
    SELECT
      (SELECT version FROM anime_library_cache_version WHERE id = 1) AS version,
      (SELECT updated_at FROM anime_override ORDER BY updated_at DESC LIMIT 1) AS updated_at
  `).first();
  return [
    String(Number(row?.version) || 0),
    String(Number(row?.updated_at) || 0),
  ].join("-");
}

async function loadAnimeOverrideVersionSafely(db) {
  try {
    return await loadAnimeOverrideVersion(db);
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      event: "anime_override_version_load_failed",
      error: redactLogMessage(error?.message || error),
    }));
    return null;
  }
}

async function handleTrackView(request, env) {
  requireLeaderboardDatabase(env);
  const body = await readJsonBody(request, 4 * 1024);
  const rawPath = body?.path;
  const path = typeof rawPath === "string" && rawPath.startsWith("/")
    ? rawPath.slice(0, ANALYTICS_PATH_MAX_LENGTH)
    : "/";
  const dayKey = getLeaderboardDayKey();
  const ipHash = hashClientIp(request);
  await env.DB.prepare(
    "INSERT INTO page_view (date, path, ip_hash, created_at) VALUES (?, ?, ?, ?)",
  ).bind(dayKey, path, ipHash, Date.now()).run();
  return json({ ok: true });
}

function hashClientIp(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // FNV-1a 32 位哈希：只存哈希值，不保存明文 IP
  let hash = 2166136261;
  for (let index = 0; index < ip.length; index += 1) {
    hash ^= ip.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function handleAdminLeaderboardDays(url, env) {
  requireLeaderboardDatabase(env);
  const days = parseAdminDays(url.searchParams.get("days"), 14, 1, 90);
  const todayKey = getLeaderboardDayKey();
  const cutoff = subtractDaysFromDayKey(todayKey, days - 1);
  const result = await env.DB.prepare(`
    SELECT day_key, mode, COUNT(*) AS count
    FROM daily_best
    WHERE day_key >= ?
    GROUP BY day_key, mode
    ORDER BY day_key ASC, mode ASC
  `).bind(cutoff).all();
  const byDay = new Map();
  for (const row of result.results || []) {
    let entry = byDay.get(row.day_key);
    if (!entry) {
      entry = { dayKey: row.day_key, classic: 0, hard: 0 };
      byDay.set(row.day_key, entry);
    }
    if (row.mode === "classic") entry.classic = Number(row.count);
    if (row.mode === "hard") entry.hard = Number(row.count);
  }
  const daysList = [];
  const startDate = dayKeyToDate(cutoff);
  const endDate = dayKeyToDate(todayKey);
  for (let cursor = new Date(startDate); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = formatDayKey(cursor);
    daysList.push(byDay.get(key) || { dayKey: key, classic: 0, hard: 0 });
  }
  return json({ days: daysList });
}

async function handleAdminLeaderboardDetail(url, env) {
  requireLeaderboardDatabase(env);
  const mode = normalizeLeaderboardMode(url.searchParams.get("mode"));
  const dayKey = parseAdminDayKey(url.searchParams.get("dayKey")) || getLeaderboardDayKey();
  const [countResult, listResult] = await env.DB.batch([
    env.DB.prepare(
      "SELECT COUNT(*) AS total FROM daily_best WHERE day_key = ? AND mode = ?",
    ).bind(dayKey, mode),
    createLeaderboardSelectStatement(env.DB, mode, dayKey),
  ]);
  const entries = formatLeaderboardEntries(listResult.results || []);
  return json({ dayKey, mode, total: countResult.results?.[0]?.total ?? 0, entries });
}

async function handleAdminAnalytics(url, env) {
  requireLeaderboardDatabase(env);
  const days = parseAdminDays(url.searchParams.get("days"), 30, 1, 90);
  const cutoff = subtractDaysFromDayKey(getLeaderboardDayKey(), days - 1);
  const [dailyResult, totalResult] = await env.DB.batch([
    env.DB.prepare(`
      SELECT date, COUNT(*) AS pv, COUNT(DISTINCT ip_hash) AS uv
      FROM page_view
      WHERE date >= ?
      GROUP BY date
      ORDER BY date ASC
    `).bind(cutoff),
    env.DB.prepare(`
      SELECT COUNT(*) AS pv, COUNT(DISTINCT ip_hash) AS uv
      FROM page_view
      WHERE date >= ?
    `).bind(cutoff),
  ]);
  const totals = totalResult.results?.[0];
  return json({
    days: (dailyResult.results || []).map((row) => ({
      date: row.date,
      pv: Number(row.pv),
      uv: Number(row.uv),
    })),
    totals: {
      pv: Number(totals?.pv) || 0,
      uv: Number(totals?.uv) || 0,
    },
  });
}

function parseAdminDays(value, fallback, min, max) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < min || days > max) {
    throw httpError(400, `days 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return days;
}

function parseAdminDayKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw httpError(400, "dayKey 格式必须是 YYYY-MM-DD");
  }
  return raw;
}

function dayKeyToDate(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDayKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function subtractDaysFromDayKey(dayKey, count) {
  const date = dayKeyToDate(dayKey);
  date.setUTCDate(date.getUTCDate() - count);
  return formatDayKey(date);
}

function normalizeFeedbackSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是对象");
  }
  const type = String(body.type || "").trim();
  if (!FEEDBACK_TYPES.has(type)) {
    throw httpError(400, "type 必须是 anime_error、bug、feature 或 other");
  }
  const content = normalizeFeedbackText(body.content, "content", FEEDBACK_CONTENT_MAX_LENGTH, true);
  const contact = normalizeFeedbackText(body.contact, "contact", FEEDBACK_CONTACT_MAX_LENGTH, false);
  return { type, content, contact };
}

function normalizeFeedbackText(value, fieldName, maximumLength, required) {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw httpError(400, `${fieldName} 必须是字符串`);
  const text = value.trim().normalize("NFKC");
  if (required && !text) throw httpError(400, `${fieldName} 不能为空`);
  if (!required && !text) return "";
  if (Array.from(text).length > maximumLength) {
    throw httpError(400, `${fieldName} 长度不能超过 ${maximumLength} 个字符`);
  }
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)) {
    throw httpError(400, `${fieldName} 包含不允许的控制字符`);
  }
  return text;
}

function normalizeLeaderboardMode(value) {
  const mode = String(value || "").trim();
  if (!LEADERBOARD_MODES.has(mode)) {
    throw httpError(400, "mode 必须是 classic 或 hard");
  }
  return mode;
}

function normalizeLeaderboardSubmission(mode, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "请求体必须是对象");
  }
  const participantId = String(body.participantId || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(participantId)) throw httpError(400, "participantId 必须是标准 UUID");
  const username = normalizeLeaderboardUsername(body.username);
  const questionCount = requireInteger(body.questionCount, "questionCount", 1, MAX_HARD_QUESTION_COUNT);
  if (mode === "classic" && questionCount !== GAME_CONFIG.localQuestionCount) {
    throw httpError(400, `classic 模式必须完整完成 ${GAME_CONFIG.localQuestionCount} 题`);
  }
  if (mode === "hard" && questionCount < GAME_CONFIG.hard.minRankQuestions) {
    throw httpError(400, `困难模式至少连续完成 ${GAME_CONFIG.hard.minRankQuestions} 题才能上榜`);
  }
  const correctCount = requireInteger(body.correctCount, "correctCount", 0, questionCount);
  const scoreMaximum = mode === "hard" ? 0 : questionCount * LOCAL_MAX_POINTS;
  const score = requireInteger(body.score, "score", 0, scoreMaximum);
  if (mode === "hard") {
    if (score !== 0) throw httpError(400, "困难模式排行榜不记录分数，score 必须为 0");
  } else {
    if (!LOCAL_REACHABLE_SCORES[correctCount]?.has(score)) {
      throw httpError(
        400,
        `经典模式答对 ${correctCount} 题时，score 不是当前计分配置下的可达分数`,
      );
    }
  }
  const maximumElapsedMs = mode === "hard"
    ? MAX_HARD_ELAPSED_MS
    : questionCount * GAME_CONFIG.questionSeconds * 1000;
  const elapsedMs = requireInteger(body.elapsedMs, "elapsedMs", 0, maximumElapsedMs);
  return {
    participantId,
    username,
    score,
    correctCount,
    questionCount,
    accuracyPpm: Math.round((correctCount * 1_000_000) / questionCount),
    elapsedMs,
  };
}

function normalizeLeaderboardUsername(value) {
  if (typeof value !== "string") throw httpError(400, "username 必须是字符串");
  const username = value.trim().normalize("NFKC");
  if (!username || Array.from(username).length > USERNAME_MAX_LENGTH) {
    throw httpError(400, `username 长度必须为 1 到 ${USERNAME_MAX_LENGTH} 个字符`);
  }
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(username)) {
    throw httpError(400, "username 包含不允许的控制字符");
  }
  return username;
}

function requireInteger(value, fieldName, minimum, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw httpError(400, `${fieldName} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function buildReachableScoreSets(questionCount, points) {
  const sets = [new Set([0])];
  for (let count = 1; count <= questionCount; count += 1) {
    const next = new Set();
    for (const subtotal of sets[count - 1]) {
      for (const point of points) next.add(subtotal + point);
    }
    sets.push(next);
  }
  return sets;
}

function requireLeaderboardDatabase(env) {
  if (!env.DB) throw httpError(503, "排行榜数据库暂不可用");
}

function getLeaderboardDayKey(date = new Date()) {
  const parts = Object.fromEntries(
    LEADERBOARD_DATE_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function createLeaderboardUpsertStatement(db, dayKey, mode, value, completedAt) {
  const commonSql = `
    INSERT INTO daily_best (
      day_key, mode, participant_id, username, score, correct_count,
      question_count, accuracy_ppm, elapsed_ms, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day_key, mode, participant_id) DO UPDATE SET
      username = excluded.username,
      score = excluded.score,
      correct_count = excluded.correct_count,
      question_count = excluded.question_count,
      accuracy_ppm = excluded.accuracy_ppm,
      elapsed_ms = excluded.elapsed_ms,
      completed_at = excluded.completed_at
  `;
  const bestCondition = mode === "hard"
    ? `WHERE excluded.accuracy_ppm > daily_best.accuracy_ppm
       OR (excluded.accuracy_ppm = daily_best.accuracy_ppm
           AND excluded.question_count > daily_best.question_count)
       OR (excluded.accuracy_ppm = daily_best.accuracy_ppm
           AND excluded.question_count = daily_best.question_count
           AND excluded.elapsed_ms < daily_best.elapsed_ms)`
    : `WHERE excluded.score > daily_best.score
       OR (excluded.score = daily_best.score
           AND excluded.elapsed_ms < daily_best.elapsed_ms)`;
  return db.prepare(`${commonSql} ${bestCondition}`).bind(
    dayKey,
    mode,
    value.participantId,
    value.username,
    value.score,
    value.correctCount,
    value.questionCount,
    value.accuracyPpm,
    value.elapsedMs,
    completedAt,
  );
}

function createLeaderboardSelectStatement(db, mode, dayKey) {
  const orderBy = mode === "hard"
    ? "accuracy_ppm DESC, question_count DESC, elapsed_ms ASC, completed_at ASC"
    : "score DESC, elapsed_ms ASC, completed_at ASC";
  return db.prepare(`
    SELECT participant_id, username, score, correct_count, question_count,
           accuracy_ppm, elapsed_ms, completed_at
    FROM daily_best
    WHERE day_key = ? AND mode = ?
    ORDER BY ${orderBy}
  `).bind(dayKey, mode);
}

function formatLeaderboardEntries(rows) {
  return rows.map((row, index) => formatLeaderboardEntry(row, index + 1));
}

function formatLeaderboardEntry(row, rank) {
  const completedAtMs = Number(row.completed_at);
  return {
    rank,
    username: String(row.username),
    score: Number(row.score),
    correctCount: Number(row.correct_count),
    questionCount: Number(row.question_count),
    accuracyPpm: Number(row.accuracy_ppm),
    accuracy: Number((Number(row.accuracy_ppm) / 10000).toFixed(2)),
    elapsedMs: Number(row.elapsed_ms),
    completedAt: new Date(completedAtMs).toISOString(),
  };
}

async function createFrameSource(customTags, excludedCopyrightTags, filterConfig) {
  const tags = normalizeSakugabooruTags(customTags, filterConfig);
  const pool = getCandidatePool(tags);
  let skipped = 0;

  for (let attempt = 0; attempt < SOURCE_ATTEMPTS; attempt += 1) {
    const post = await takeCandidate(pool, tags);
    post.copyrightTags = await resolveCopyrightTags(post.tags);
    if (post.copyrightTags.length === 0) {
      // 没有版权标签的帖子（如原创动画）无法确定作品名
      skipped += 1;
      continue;
    }
    if (post.copyrightTags.some((tag) => excludedCopyrightTags.has(tag))) {
      skipped += 1;
      continue;
    }

    return {
      id: String(post.id),
      // 题面由浏览器端经 /api/hard/video-proxy 代理加载视频（注入 CORS 头），随机暂停后用 canvas 抽帧
      videoUrl: post.fileUrl,
      sakugabooru: {
        id: post.id,
        tags: post.tags,
        copyrightTags: post.copyrightTags,
        score: post.score,
        source: post.source,
        fileSize: post.fileSize,
      },
      sourceUrl: `https://www.sakugabooru.com/post/show/${post.id}`,
      skippedCopyrightCandidates: skipped,
    };
  }
  throw httpError(503, `连续 ${SOURCE_ATTEMPTS} 个候选均不符合题目要求，请稍后重试`);
}

async function resolveFrameQuestion(source) {
  const sourceId = Number(source?.sakugabooru?.id || source?.id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) throw httpError(400, "题目来源无效");
  // 本接口只负责标题解析；题面由浏览器端经代理加载该视频并抽帧展示
  const video = validateSakugabooruVideo(source?.videoUrl, "题目视频");
  const copyrightTag = String(source?.sakugabooru?.copyrightTags?.[0] || "").trim();
  return {
    id: `${sourceId}-${crypto.randomUUID()}`,
    title: copyrightTag, // 先用罗马音标签占位，翻译阶段替换为简体中文官方译名
    video,
    copyrightTag,
    source: "sakugabooru-deepseek",
    sourceUrl: `https://www.sakugabooru.com/post/show/${sourceId}`,
    sakugabooru: {
      id: sourceId,
      tags: String(source?.sakugabooru?.tags || "").slice(0, 10000),
      copyrightTags: [...normalizeExcludedCopyrightTags(source?.sakugabooru?.copyrightTags)],
      score: source?.sakugabooru?.score ?? null,
      source: String(source?.sakugabooru?.source || "").slice(0, 2000),
    },
  };
}

// 视频代理：注入 CORS 头并透传 Range，使浏览器端 <video> 加载后能用 canvas 抽帧
async function handleHardVideoProxy(request, url) {
  const target = url.searchParams.get("url");
  const videoUrl = validateSakugabooruVideo(target, "代理视频地址");
  const range = request.headers.get("Range");
  const upstream = new Request(videoUrl, {
    method: "GET",
    headers: range ? { Range: range } : {},
    redirect: "follow",
  });
  const response = await fetch(upstream);
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function validateSakugabooruVideo(value, label) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const extension = url.pathname.split(".").pop()?.toLowerCase();
    if (
      url.protocol !== "https:"
      || (hostname !== "sakugabooru.com" && !hostname.endsWith(".sakugabooru.com"))
      || !["mp4", "webm"].includes(extension)
    ) throw new Error();
    return url.toString();
  } catch {
    throw httpError(400, `${label}地址无效`);
  }
}

function getCandidatePool(tags) {
  let pool = candidatePools.get(tags);
  if (!pool) {
    pool = { items: [], recentIds: [] };
  } else {
    candidatePools.delete(tags);
  }
  candidatePools.set(tags, pool);
  while (candidatePools.size > CANDIDATE_POOL_KEY_LIMIT) {
    candidatePools.delete(candidatePools.keys().next().value);
  }
  return pool;
}

async function takeCandidate(pool, tags) {
  if (pool.items.length === 0) await refillCandidatePool(pool, tags);
  const post = pool.items.shift();
  if (!post) throw httpError(503, "Sakugabooru 未返回可用动画视频");
  pool.recentIds.push(post.id);
  while (pool.recentIds.length > RECENT_POST_LIMIT) pool.recentIds.shift();
  return post;
}

async function refillCandidatePool(pool, tags) {
  const apiUrl = new URL(SAKUGABOORU_API_URL);
  apiUrl.searchParams.set("limit", String(CANDIDATE_FETCH_LIMIT));
  apiUrl.searchParams.set("tags", tags);
  const response = await fetchWithRetry(apiUrl, {
    headers: { Accept: "application/json", Referer: "https://www.sakugabooru.com/" },
  }, { attempts: 3, label: "Sakugabooru" });
  const data = await readJsonResponse(response, MAX_UPSTREAM_JSON_BYTES, "Sakugabooru");
  const posts = (Array.isArray(data) ? data : data?.posts || data?.value || [])
    .map(normalizeVideoPost)
    .filter(Boolean);
  const knownIds = new Set([...pool.items.map((item) => item.id), ...pool.recentIds]);
  for (const post of shuffle(posts.filter((item) => !knownIds.has(item.id)))) {
    if (pool.items.length >= CANDIDATE_POOL_LIMIT) break;
    pool.items.push(post);
  }
}

function normalizeVideoPost(item) {
  const id = Number(item?.id);
  const extension = String(item?.file_ext || "").toLowerCase();
  const fileSize = Number(item?.file_size);
  if (!Number.isInteger(id) || id <= 0 || !VIDEO_EXTENSIONS.has(extension)) return null;
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_VIDEO_BYTES) return null;
  try {
    return {
      id,
      fileUrl: validateSakugabooruUrl(item.file_url, VIDEO_EXTENSIONS),
      fileSize,
      tags: String(item.tags || ""),
      score: item.score ?? null,
      source: String(item.source || ""),
    };
  } catch {
    return null;
  }
}

function validateSakugabooruUrl(value, extensions) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const extension = url.pathname.split(".").pop()?.toLowerCase();
  if (
    url.protocol !== "https:"
    || (hostname !== "sakugabooru.com" && !hostname.endsWith(".sakugabooru.com"))
    || !extensions.has(extension)
  ) throw new Error("Sakugabooru URL 无效");
  return url.toString();
}

async function resolveCopyrightTags(tagString) {
  const postTags = [...new Set(String(tagString || "").split(/\s+/).filter(Boolean))];
  const unresolved = postTags.filter((tag) => !copyrightTagCache.has(tag));
  if (unresolved.length > 0) {
    const url = new URL(SAKUGABOORU_RELATED_TAG_API_URL);
    url.searchParams.set("tags", unresolved.join(" "));
    url.searchParams.set("type", "copyright");
    const response = await fetchWithRetry(url, {
      headers: { Accept: "application/json", Referer: "https://www.sakugabooru.com/" },
    }, { attempts: 3, label: "Sakugabooru 标签" });
    const data = await readJsonResponse(response, MAX_UPSTREAM_JSON_BYTES, "Sakugabooru 标签");
    const related = data?.value && typeof data.value === "object" ? data.value : data;
    for (const tag of unresolved) {
      const relations = Array.isArray(related?.[tag]) ? related[tag] : [];
      cacheCopyrightTag(tag, relations.some((relation) => Array.isArray(relation) && relation[0] === tag));
    }
  }
  return postTags.filter((tag) => copyrightTagCache.get(tag) === true);
}

function cacheCopyrightTag(tag, isCopyright) {
  if (copyrightTagCache.has(tag)) copyrightTagCache.delete(tag);
  copyrightTagCache.set(tag, isCopyright);
  while (copyrightTagCache.size > COPYRIGHT_CACHE_LIMIT) {
    copyrightTagCache.delete(copyrightTagCache.keys().next().value);
  }
}

function normalizeExcludedCopyrightTags(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const tag = String(value || "").trim();
    if (!tag || tag.length > 128 || !/^[a-zA-Z0-9_:\-.]+$/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_EXCLUDED_COPYRIGHT_TAGS) break;
  }
  return new Set(result);
}

function validateFilter(input = {}) {
  const startDate = normalizeDate(input.startDate, "起始日期");
  const endDate = normalizeDate(input.endDate, "结束日期");
  const minScore = normalizeScore(input.minScore, "最低热度");
  const maxScore = normalizeScore(input.maxScore, "最高热度");
  const rating = input.rating === "" ? "" : String(input.rating || "s");
  if (!["", "s", "q", "e"].includes(rating)) throw httpError(400, "内容分级无效");
  if (startDate && endDate && startDate > endDate) throw httpError(400, "起始日期不能晚于结束日期");
  if (minScore !== null && maxScore !== null && minScore > maxScore) {
    throw httpError(400, "最低热度不能高于最高热度");
  }
  return { startDate, endDate, minScore, maxScore, rating };
}

function normalizeDate(value, fieldName) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime())) {
    throw httpError(400, `${fieldName}格式必须为 YYYY-MM-DD`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (parsed.toISOString().slice(0, 10) !== text || text < "2000-01-01" || text > today) {
    throw httpError(400, `${fieldName}必须在 2000-01-01 至今天之间`);
  }
  return text;
}

function normalizeScore(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < -1000 || number > 100000) {
    throw httpError(400, `${fieldName}必须是 -1000 到 100000 之间的整数`);
  }
  return number;
}

function normalizeSakugabooruTags(customTags, filterConfig = DEFAULT_FILTER) {
  const custom = String(customTags || "").split(/\s+/)
    .map((tag) => tag.trim())
    .filter((tag) => /^[a-zA-Z0-9_:\-.]+$/.test(tag))
    .filter((tag) => tag.replace(/^-/, "") !== "animated")
    .filter((tag) => !/^(order|rating|score|date):/i.test(tag))
    .slice(0, 8);
  const { startDate, endDate, minScore, maxScore, rating } = validateFilter(filterConfig);
  const filters = [];
  if (startDate && endDate) filters.push(`date:${startDate}..${endDate}`);
  else if (startDate) filters.push(`date:>=${startDate}`);
  else if (endDate) filters.push(`date:<=${endDate}`);
  if (minScore !== null && maxScore !== null) filters.push(`score:${minScore}..${maxScore}`);
  else if (minScore !== null) filters.push(`score:>=${minScore}`);
  else if (maxScore !== null) filters.push(`score:<=${maxScore}`);
  if (rating) filters.push(`rating:${rating}`);
  return [...custom, "animated", ...filters, "order:random"].join(" ");
}

function isLikelyChineseTitle(value) {
  return /\p{Script=Han}/u.test(value)
    && !/[\u3040-\u30ff\u31f0-\u31ff\u1100-\u11ff\uac00-\ud7af]/u.test(value);
}

function normalizeDeepSeekApiKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  return key === "你的APIkey" || key.length > 512 ? "" : key;
}

function getRequestDeepSeekApiKey(request) {
  return normalizeDeepSeekApiKey(request.headers.get("x-deepseek-api-key"));
}

function getDeepSeekApiKeyMode(env) {
  const configured = typeof env?.DEEPSEEK_API_KEY_MODE === "string"
    ? env.DEEPSEEK_API_KEY_MODE.trim().toLowerCase()
    : "";
  return DEEPSEEK_API_KEY_MODES.has(configured)
    ? configured
    : DEFAULT_DEEPSEEK_API_KEY_MODE;
}

function getEffectiveDeepSeekApiKey(request, env) {
  if (getDeepSeekApiKeyMode(env) === "site") {
    const apiKey = normalizeDeepSeekApiKey(env?.DEEPSEEK_API_KEY);
    if (!apiKey) {
      throw httpError(503, "\u7f51\u7ad9 DeepSeek API Key \u5c1a\u672a\u914d\u7f6e\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458");
    }
    return apiKey;
  }

  const apiKey = getRequestDeepSeekApiKey(request);
  if (!apiKey) throw httpError(400, "\u8bf7\u5148\u8f93\u5165\u5e76\u786e\u8ba4 DeepSeek API Key");
  return apiKey;
}

async function validateDeepSeekApiKey(apiKey) {
  try {
    const authorization = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
    const [modelsResponse, balanceResponse] = await Promise.all([
      fetchWithRetry(DEEPSEEK_MODELS_API_URL, {
        headers: authorization,
      }, { attempts: 1, label: "DeepSeek 模型检测", timeoutMs: 10000 }),
      fetchWithRetry(DEEPSEEK_BALANCE_API_URL, {
        headers: authorization,
      }, { attempts: 1, label: "DeepSeek 余额检测", timeoutMs: 10000 }),
    ]);
    const [modelsData, balanceData] = await Promise.all([
      readJsonResponse(modelsResponse, 256 * 1024, "DeepSeek 模型检测"),
      readJsonResponse(balanceResponse, 256 * 1024, "DeepSeek 余额检测"),
    ]);
    const models = Array.isArray(modelsData?.data)
      ? modelsData.data.map((item) => normalizeTitle(item?.id)).filter(Boolean)
      : [];
    const cnyInfo = Array.isArray(balanceData?.balance_infos)
      ? balanceData.balance_infos.find((item) => String(item?.currency || "").toUpperCase() === "CNY")
      : null;
    const balance = Number(cnyInfo?.total_balance);
    if (!Number.isFinite(balance) || balance < 0) {
      return { valid: false, message: "API Key 有效，但未读取到人民币余额", balance: null, currency: "CNY" };
    }
    if (!models.includes(DEEPSEEK_TRANS_MODEL)) {
      return {
        valid: false,
        message: `API Key 有效，但当前账户无法使用模型 ${DEEPSEEK_TRANS_MODEL}`,
        balance,
        currency: "CNY",
      };
    }
    if (balanceData?.is_available === false || balance <= 1) {
      return { valid: false, message: "DeepSeek 人民币可用余额必须严格大于 1 元", balance, currency: "CNY" };
    }
    return {
      valid: true,
      message: `API Key 可用，人民币余额 ${balance.toFixed(2)} 元`,
      balance,
      currency: "CNY",
    };
  } catch (error) {
    if (error.status === 401 || error.status === 403) return { valid: false, message: "API Key 无效或没有访问权限", balance: null };
    if (error.status === 402) return { valid: false, message: "API Key 有效，但账户余额或额度不足", balance: null };
    if (error.status === 429) throw httpError(503, "DeepSeek 请求过于频繁，请稍后再检测");
    throw httpError(502, `暂时无法连接 DeepSeek：${error.message}`);
  }
}

function normalizeTitle(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
