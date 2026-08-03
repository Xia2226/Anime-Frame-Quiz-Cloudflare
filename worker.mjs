const SAKUGABOORU_API_URL = "https://www.sakugabooru.com/post.json";
const SAKUGABOORU_RELATED_TAG_API_URL = "https://www.sakugabooru.com/tag/related.json";
const ANILIST_API_URL = "https://graphql.anilist.co";
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODELS_API_URL = "https://api.deepseek.com/v1/models";
const DEEPSEEK_TRANS_MODEL = "deepseek-v4-flash";

const REQUEST_TIMEOUT_MS = 20000;
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
      if (url.pathname === "/api/config-status") {
        requireMethod(request, "GET");
        return json({
          deepSeekApiKey: {
            configured: Boolean(normalizeDeepSeekApiKey(env.DEEPSEEK_API_KEY)),
            source: normalizeDeepSeekApiKey(env.DEEPSEEK_API_KEY) ? "environment" : null,
          },
          traceMoe: {
            requestSource: "browser",
            quotaScope: "visitor-public-ip",
          },
        });
      }

      if (url.pathname === "/api/frame-source") {
        requireMethod(request, "GET");
        const excludedCopyrightTags = normalizeExcludedCopyrightTags(
          url.searchParams.getAll("excludeCopyright"),
        );
        const filterConfig = validateFilter({
          startDate: url.searchParams.get("startDate") || "",
          endDate: url.searchParams.get("endDate") || "",
          minScore: url.searchParams.get("minScore") || null,
          maxScore: url.searchParams.get("maxScore") || null,
          rating: url.searchParams.has("rating") ? url.searchParams.get("rating") : "s",
        });
        const source = await createFrameSource(
          url.searchParams.get("tags") || "",
          excludedCopyrightTags,
          filterConfig,
        );
        return json(source);
      }

      if (url.pathname === "/api/frame-resolve") {
        requireMethod(request, "POST");
        const body = await readJsonBody(request, 64 * 1024);
        const frame = await resolveFrameQuestion(body?.source, body?.traceResult);
        return json(frame);
      }

      if (url.pathname === "/api/deepseek/validate") {
        requireMethod(request, "POST");
        const apiKey = getRequestDeepSeekApiKey(request, env);
        if (!apiKey) {
          return json({ valid: false, message: "请先输入 DeepSeek API Key" }, 400);
        }
        return json(await validateDeepSeekApiKey(apiKey));
      }

      if (url.pathname === "/api/deepseek/translate") {
        requireMethod(request, "POST");
        const apiKey = getRequestDeepSeekApiKey(request, env);
        if (!apiKey) throw httpError(400, "请先配置或输入 DeepSeek API Key");
        const body = await readJsonBody(request, 16 * 1024);
        const text = normalizeTitle(body?.text);
        const sourceLanguage = ["ja", "en", "auto"].includes(body?.sourceLanguage)
          ? body.sourceLanguage
          : "auto";
        if (!text || text.length > 500) throw httpError(400, "缺少有效的待翻译标题");
        return json({ title: await translateToChinese(text, sourceLanguage, apiKey) });
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "API endpoint not found", code: "NOT_FOUND" }, 404);
      }

      if (!env.ASSETS) throw httpError(500, "静态资源绑定不可用");
      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse);
    } catch (error) {
      console.error(error?.message || error);
      return json({
        error: error?.message || "Internal server error",
        code: error?.code || null,
      }, error?.statusCode || 500);
    }
  },
};

function requireMethod(request, expected) {
  if (request.method !== expected) {
    const error = httpError(405, `仅支持 ${expected} 请求`);
    error.code = "METHOD_NOT_ALLOWED";
    throw error;
  }
}

async function readJsonBody(request, maximumBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw httpError(413, "请求体过大");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw httpError(413, "请求体过大");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw httpError(400, `JSON 格式错误: ${error.message}`);
  }
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
  throw httpError(503, `连续 ${SOURCE_ATTEMPTS} 个候选均与近期作品或收藏重复，请稍后重试`);
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
    pool = { items: [], recentIds: [], refillPromise: null };
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
  if (pool.refillPromise) return pool.refillPromise;
  pool.refillPromise = (async () => {
    const apiUrl = new URL(SAKUGABOORU_API_URL);
    apiUrl.searchParams.set("limit", String(CANDIDATE_FETCH_LIMIT));
    apiUrl.searchParams.set("tags", tags);
    const response = await fetchWithRetry(apiUrl, {
      headers: { Accept: "application/json", Referer: "https://www.sakugabooru.com/" },
    }, { attempts: 3, label: "Sakugabooru" });
    const data = await response.json();
    const posts = (Array.isArray(data) ? data : data?.posts || data?.value || [])
      .map(normalizeVideoPost)
      .filter(Boolean);
    const knownIds = new Set([...pool.items.map((item) => item.id), ...pool.recentIds]);
    for (const post of shuffle(posts.filter((item) => !knownIds.has(item.id)))) {
      if (pool.items.length >= CANDIDATE_POOL_LIMIT) break;
      pool.items.push(post);
    }
  })();
  try {
    await pool.refillPromise;
  } finally {
    pool.refillPromise = null;
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
    const data = await response.json();
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
  if (anilistCache.has(id)) return anilistCache.get(id);
  const promise = (async () => {
    const query = `query ($id: Int!) { Media(id: $id, type: ANIME) { id idMal countryOfOrigin isAdult title { romaji english native } synonyms } }`;
    const response = await fetchWithRetry(ANILIST_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { id } }),
    }, { attempts: 1, label: "AniList", timeoutMs: 6000 });
    const data = await response.json();
    if (data?.errors?.length || !data?.data?.Media) {
      throw new Error(data?.errors?.[0]?.message || "未找到番剧");
    }
    return data.data.Media;
  })();
  anilistCache.set(id, promise);
  trimCache(anilistCache, ANILIST_CACHE_LIMIT);
  try {
    return await promise;
  } catch (error) {
    anilistCache.delete(id);
    throw error;
  }
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

function normalizeDeepSeekApiKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  return key === "你的APIkey" || key.length > 512 ? "" : key;
}

function getRequestDeepSeekApiKey(request, env) {
  return normalizeDeepSeekApiKey(env.DEEPSEEK_API_KEY)
    || normalizeDeepSeekApiKey(request.headers.get("x-deepseek-api-key"));
}

async function validateDeepSeekApiKey(apiKey) {
  try {
    const response = await fetchWithRetry(DEEPSEEK_MODELS_API_URL, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    }, { attempts: 1, label: "DeepSeek API Key 检测", timeoutMs: 10000 });
    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data.map((item) => normalizeTitle(item?.id)) : [];
    return models.includes(DEEPSEEK_TRANS_MODEL)
      ? { valid: true, message: `API Key 可用，已检测到模型 ${DEEPSEEK_TRANS_MODEL}` }
      : { valid: false, message: `API Key 有效，但当前账户无法使用模型 ${DEEPSEEK_TRANS_MODEL}` };
  } catch (error) {
    if (error.status === 401 || error.status === 403) return { valid: false, message: "API Key 无效或没有访问权限" };
    if (error.status === 402) return { valid: false, message: "API Key 有效，但账户余额或额度不足" };
    if (error.status === 429) throw httpError(503, "DeepSeek 请求过于频繁，请稍后再检测");
    throw httpError(502, `暂时无法连接 DeepSeek：${error.message}`);
  }
}

async function translateToChinese(text, sourceLanguage, apiKey) {
  const systemPrompt = [
    "你是动漫名称翻译助手。无论输入是什么语言，你都只输出一个结果：中国大陆官方简体中文译名。",
    "规则：",
    "1. 输入可能是日文、英文、罗马音、繁体中文或简体中文，全部翻译为大陆简体中文",
    "2. 优先使用大陆官方译名或 B站/腾讯视频等主流平台通用译名",
    "3. 只输出简体中文译名本身，不加任何解释、标点或备注",
    "4. 有多个译名时只返回最通用的一个，禁止输出台译、港译",
    "5. 输入已经是简体中文时原样返回",
    "6. 无官方译名时给出最通用的民间简体译名，不备注",
  ].join("\n");
  const response = await fetchWithRetry(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_TRANS_MODEL,
      thinking: { type: "disabled" },
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
      temperature: 0.1,
      max_tokens: 50,
    }),
  }, { attempts: 2, label: "DeepSeek 翻译", timeoutMs: 3000 });
  const data = await response.json();
  const title = normalizeTitle(data?.choices?.[0]?.message?.content);
  if (!title) throw httpError(502, "DeepSeek 翻译未返回有效中文标题");
  return title;
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const attempts = Math.max(1, retryOptions.attempts || 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, retryOptions.timeoutMs || REQUEST_TIMEOUT_MS);
      if (response.ok) return response;
      const body = await response.text().catch(() => "");
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
    "img-src 'self' data: https://trace.moe https://*.trace.moe",
    "media-src 'self' https://trace.moe https://*.trace.moe",
    "connect-src 'self' https://api.trace.moe",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
