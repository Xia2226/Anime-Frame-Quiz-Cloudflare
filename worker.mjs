import { GAME_CONFIG } from "./public/js/game-config.js";

const SAKUGABOORU_API_URL = "https://www.sakugabooru.com/post.json";
const SAKUGABOORU_RELATED_TAG_API_URL = "https://www.sakugabooru.com/tag/related.json";
const ANILIST_API_URL = "https://graphql.anilist.co";
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODELS_API_URL = "https://api.deepseek.com/v1/models";
const DEEPSEEK_BALANCE_API_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_TRANS_MODEL = "deepseek-v4-flash";

const REQUEST_TIMEOUT_MS = 20000;
const MAX_UPSTREAM_JSON_BYTES = 1024 * 1024;
const MAX_UPSTREAM_ERROR_BYTES = 8 * 1024;
const USERNAME_MAX_LENGTH = 24;
const MAX_HARD_QUESTION_COUNT = 10000;
const MAX_HARD_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000;
const LEADERBOARD_MODES = new Set(["classic", "hard"]);
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
const MIN_PREVIEW_WIDTH = 280;
const MIN_PREVIEW_HEIGHT = 150;
const CANDIDATE_FETCH_LIMIT = 8;
const CANDIDATE_POOL_LIMIT = 24;
const CANDIDATE_POOL_KEY_LIMIT = 4;
const RECENT_POST_LIMIT = 64;
const COPYRIGHT_CACHE_LIMIT = 10000;
const ANILIST_CACHE_LIMIT = 1000;
const SOURCE_ATTEMPTS = 24;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

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
const anilistCache = new Map();

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
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

      if (url.pathname === "/api/hard/resolve") {
        requireMethod(request, "POST");
        const apiKey = getRequestDeepSeekApiKey(request);
        if (!apiKey) throw httpError(400, "请先输入并确认 DeepSeek API Key");
        const body = await readJsonBody(request, 128 * 1024);
        return json({ questions: await resolveHardQuestions(body, apiKey) });
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
    const result = await env.DB.prepare("DELETE FROM daily_best WHERE day_key < ?")
      .bind(cutoffDay)
      .run();
    console.log(JSON.stringify({
      level: "info",
      event: "leaderboard_retention_cleanup",
      cutoffDay,
      rowsDeleted: result.meta?.changes ?? null,
    }));
  },
};

function createRobotsResponse(url) {
  const sitemapUrl = new URL("/sitemap.xml", url).href;
  return withSecurityHeaders(new Response([
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
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
function requireMethod(request, expected) {
  if (request.method !== expected) {
    const error = httpError(405, `仅支持 ${expected} 请求`);
    error.code = "METHOD_NOT_ALLOWED";
    throw error;
  }
}

async function readJsonBody(request, maximumBytes) {
  const text = await readBodyTextWithLimit(request, maximumBytes, () => httpError(413, "请求体过大"));
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw httpError(400, `JSON 格式错误: ${error.message}`);
  }
}

async function readBodyTextWithLimit(message, maximumBytes, tooLargeErrorFactory) {
  const declaredLength = Number(message.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw tooLargeErrorFactory();
  }
  if (!message.body) return "";

  const reader = message.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw tooLargeErrorFactory();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatenateBytes(chunks, totalBytes));
}

async function readJsonResponse(response, maximumBytes, label) {
  const text = await readBodyTextWithLimit(
    response,
    maximumBytes,
    () => httpError(502, `${label}响应过大`),
  );
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw httpError(502, `${label}返回了无效 JSON: ${error.message}`);
  }
}

async function readResponseSnippet(response, maximumBytes = MAX_UPSTREAM_ERROR_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = maximumBytes - totalBytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.slice(0, remaining));
        totalBytes = maximumBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (totalBytes === maximumBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(concatenateBytes(chunks, totalBytes));
  return truncated ? `${text}…` : text;
}

function concatenateBytes(chunks, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function createHardSources(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "请求体必须是对象");
  }
  const rawExclusions = input.excludeCopyrightTags ?? [];
  if (!Array.isArray(rawExclusions)) {
    throw httpError(400, "excludeCopyrightTags 必须是数组");
  }
  const excludedCopyrightTags = normalizeExcludedCopyrightTags(rawExclusions);
  const configuredFilter = GAME_CONFIG.hard.sakugabooruFilter;
  const sources = [];
  for (let index = 0; index < GAME_CONFIG.hard.batchSize; index += 1) {
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
    resolveFrameQuestion(entry.source, entry.traceResult)
  )));
  const translationTargets = questions
    .map((question, questionIndex) => ({
      questionIndex,
      text: normalizeTitle(question.translation?.text) || normalizeTitle(question.title),
      sourceLanguage: question.translation?.sourceLanguage || "auto",
      needsTranslation: question.titleLanguage !== "zh" && !isLikelyChineseTitle(question.title),
    }))
    .filter((item) => item.needsTranslation && item.text);

  if (translationTargets.length > 0) {
    const translatedTitles = await translateTitlesToChineseBatch(translationTargets, apiKey);
    for (const target of translationTargets) {
      const translatedTitle = translatedTitles.get(target.questionIndex);
      const question = questions[target.questionIndex];
      question.title = translatedTitle;
      question.titleLanguage = "zh";
      question.titleSource = "deepseek-batch";
      question.translation = {
        ...question.translation,
        translatedTitle,
      };
    }
  }
  return questions;
}

async function translateTitlesToChineseBatch(items, apiKey) {
  const systemPrompt = [
    "你是动漫名称翻译助手。把输入数组中的每个标题转换为中国大陆最常用的简体中文译名。",
    "只输出 JSON 数组，不要 Markdown、解释或额外字段。",
    "每项格式必须是 {\"index\":数字,\"title\":\"译名\"}，index 必须与输入一致。",
    "已经是简体中文的标题原样返回；没有官方译名时使用最常见的简体中文民间译名。",
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
            sourceLanguage: item.sourceLanguage,
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
  if (result.size !== expectedIndexes.size) {
    throw httpError(502, "DeepSeek 批量翻译结果不完整");
  }
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
  context.waitUntil(caches.default.put(cacheRequest, response.clone()).catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "leaderboard_cache_put_failed",
      error: redactLogMessage(error?.message || error),
    }));
  }));
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
    if (post.copyrightTags.some((tag) => excludedCopyrightTags.has(tag))) {
      skipped += 1;
      continue;
    }

    const previewUsable = post.previewUrl
      && (!post.previewWidth || post.previewWidth >= MIN_PREVIEW_WIDTH)
      && (!post.previewHeight || post.previewHeight >= MIN_PREVIEW_HEIGHT);
    return {
      id: String(post.id),
      traceInputUrl: previewUsable ? post.previewUrl : post.fileUrl,
      traceInputType: previewUsable ? "preview" : "video-fallback",
      previewQuality: previewUsable ? {
        accepted: true,
        width: post.previewWidth,
        height: post.previewHeight,
        reason: "元数据尺寸检查通过",
      } : null,
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
  throw httpError(503, `连续 ${SOURCE_ATTEMPTS} 个候选均与近期作品重复，请稍后重试`);
}

async function resolveFrameQuestion(source, traceResult) {
  const sourceId = Number(source?.sakugabooru?.id || source?.id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) throw httpError(400, "题目来源无效");
  const image = validateTraceMediaUrl(traceResult?.image, "识别图片");
  const video = traceResult?.video ? validateTraceMediaUrl(traceResult.video, "识别视频") : null;
  const titles = await resolveAnimeTitles(traceResult);
  return {
    id: `${sourceId}-${crypto.randomUUID()}`,
    title: titles.title,
    originalTitle: titles.originalTitle,
    japaneseTitle: titles.japaneseTitle,
    englishTitle: titles.englishTitle,
    titleLanguage: titles.titleLanguage,
    titleSource: titles.titleSource,
    translation: titles.translation,
    image,
    traceImage: image,
    video,
    episode: traceResult?.episode ?? null,
    from: traceResult?.from ?? null,
    capturedAt: 0,
    similarity: Number(traceResult?.similarity) || 0,
    source: "sakugabooru-tracemoe-browser",
    sourceUrl: `https://www.sakugabooru.com/post/show/${sourceId}`,
    anilistId: titles.anilist?.id || null,
    anilist: titles.anilist,
    sakugabooru: {
      id: sourceId,
      tags: String(source?.sakugabooru?.tags || "").slice(0, 10000),
      copyrightTags: [...normalizeExcludedCopyrightTags(source?.sakugabooru?.copyrightTags)],
      score: source?.sakugabooru?.score ?? null,
      source: String(source?.sakugabooru?.source || "").slice(0, 2000),
      traceInputType: source?.traceInputType === "preview" ? "preview" : "video-fallback",
      previewQuality: source?.previewQuality || null,
    },
  };
}

function validateTraceMediaUrl(value, label) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (hostname !== "trace.moe" && !hostname.endsWith(".trace.moe"))) {
      throw new Error();
    }
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
    let previewUrl = null;
    try {
      previewUrl = validateSakugabooruUrl(item.preview_url, new Set(["jpg", "jpeg"]));
    } catch {}
    return {
      id,
      fileUrl: validateSakugabooruUrl(item.file_url, VIDEO_EXTENSIONS),
      fileSize,
      tags: String(item.tags || ""),
      score: item.score ?? null,
      source: String(item.source || ""),
      previewUrl,
      previewWidth: Number(item.actual_preview_width || item.preview_width) || null,
      previewHeight: Number(item.actual_preview_height || item.preview_height) || null,
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
    .slice(0, 4);
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

async function resolveAnimeTitles(traceResult) {
  let media = traceResult?.anilist && typeof traceResult.anilist === "object" ? traceResult.anilist : {};
  const id = Number(media.id || traceResult?.anilist);
  if (Number.isInteger(id) && id > 0 && !Object.values(media.title || {}).some(normalizeTitle)) {
    try {
      const detailed = await fetchAniListById(id);
      media = { ...media, ...detailed, title: { ...(media.title || {}), ...(detailed.title || {}) } };
    } catch (error) {
      console.warn(`AniList 详情读取失败 (${id}): ${error.message}`);
    }
  }
  if (media.isAdult === true) throw httpError(400, "识别结果为成人内容，已跳过");
  const title = media.title || {};
  const originalTitle = normalizeTitle(title.romaji)
    || normalizeTitle(title.english)
    || normalizeTitle(title.native)
    || cleanFilename(traceResult?.filename);
  if (!originalTitle) throw httpError(400, "未获取到番剧名称");
  const chineseTitle = findChineseTitle(media);
  const sourceText = normalizeTitle(title.native)
    || normalizeTitle(title.english)
    || normalizeTitle(title.romaji)
    || originalTitle;
  const sourceLanguage = title.native ? "ja" : title.english ? "en" : "auto";
  return {
    title: chineseTitle || originalTitle,
    originalTitle,
    japaneseTitle: normalizeTitle(title.native),
    englishTitle: normalizeTitle(title.english),
    titleLanguage: chineseTitle ? "zh" : "original",
    titleSource: chineseTitle ? "trace-chinese-title" : "original",
    translation: { cacheKey: `${sourceLanguage}:${sourceText}`, text: sourceText, sourceLanguage },
    anilist: Object.keys(media).length ? media : null,
  };
}

async function fetchAniListById(id) {
  if (anilistCache.has(id)) {
    const cached = anilistCache.get(id);
    anilistCache.delete(id);
    anilistCache.set(id, cached);
    return cached;
  }
  const query = `query ($id: Int!) { Media(id: $id, type: ANIME) { id idMal countryOfOrigin isAdult title { romaji english native } synonyms } }`;
  const response = await fetchWithRetry(ANILIST_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { id } }),
  }, { attempts: 1, label: "AniList", timeoutMs: 6000 });
  const data = await readJsonResponse(response, 256 * 1024, "AniList");
  if (data?.errors?.length || !data?.data?.Media) {
    throw new Error(data?.errors?.[0]?.message || "未找到番剧");
  }
  anilistCache.set(id, data.data.Media);
  trimCache(anilistCache, ANILIST_CACHE_LIMIT);
  return data.data.Media;
}

function findChineseTitle(media = {}) {
  const title = media.title && typeof media.title === "object" ? media.title : {};
  for (const candidate of [...(Array.isArray(media.synonyms) ? media.synonyms : []), title.native, title.english, title.romaji]) {
    const normalized = normalizeTitle(candidate);
    if (/\p{Script=Han}/u.test(normalized) && !/[\u3040-\u30ff\u31f0-\u31ff\u1100-\u11ff\uac00-\ud7af]/u.test(normalized)) {
      return normalized;
    }
  }
  return "";
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

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = Math.max(1, retryOptions.attempts || 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, retryOptions.timeoutMs || REQUEST_TIMEOUT_MS);
      if (response.ok) return response;
      const body = await readResponseSnippet(response).catch(() => "");
      const error = new Error(`${retryOptions.label || "上游 API"} HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
      error.status = response.status;
      lastError = error;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) throw error;
    } catch (error) {
      lastError = error;
      if (error.status || attempt === attempts - 1) throw error;
    }
    await delay(500 * (2 ** attempt) + Math.round(Math.random() * 200));
  }
  throw lastError || new Error(`${retryOptions.label || "上游 API"} 请求失败`);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: https://cdni.fancaps.net https://trace.moe https://*.trace.moe",
    "media-src 'self' https://trace.moe https://*.trace.moe",
    "connect-src 'self' https://api.trace.moe",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...additionalHeaders,
    },
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function redactLogMessage(value) {
  return String(value || "Unknown error")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

function normalizeTitle(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanFilename(value) {
  return normalizeTitle(value)
    .replace(/\.[^.]+$/, "")
    .replace(/\[[^\]]*]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\d{1,4}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function trimCache(cache, maximumSize) {
  while (cache.size > maximumSize) cache.delete(cache.keys().next().value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
