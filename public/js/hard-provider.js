import { normalizeSearchText } from "./catalog.js";

const TRACE_SEARCH_URL = "https://api.trace.moe/search";
const TRACE_ACCOUNT_URL = "https://api.trace.moe/me";
const REQUEST_TIMEOUT_MS = 60_000;

export class HardQuestionProvider {
  constructor({ apiKey, catalog, batchSize = 3, onBufferChange = null }) {
    this.apiKey = apiKey;
    this.catalog = catalog;
    this.batchSize = batchSize;
    this.onBufferChange = typeof onBufferChange === "function" ? onBufferChange : null;
    this.buffer = [];
    this.excludedCopyrightTags = new Set();
    this.usedQuestionIds = new Set();
    this.fillPromise = null;
    this.stopped = false;
    this.abortController = new AbortController();
  }

  get bufferedCount() {
    return this.buffer.length;
  }

  async next() {
    if (this.stopped) return null;
    if (this.buffer.length === 0) await this.ensureFilled();
    const question = this.buffer.shift() || null;
    this.emitBufferChange();
    if (question && this.buffer.length <= 1 && !document.hidden) {
      void this.ensureFilled().catch((error) => {
        if (!this.stopped && error.name !== "AbortError") {
          console.warn("困难题库后台补充失败：", error.message);
        }
      });
    }
    return question;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    this.buffer = [];
    this.emitBufferChange();
  }

  async ensureFilled() {
    if (this.stopped || this.buffer.length >= this.batchSize) return;
    if (this.fillPromise) return this.fillPromise;
    this.fillPromise = this.fill();
    try {
      await this.fillPromise;
    } finally {
      this.fillPromise = null;
    }
  }

  async fill() {
    const sourceData = await postJson("/api/hard/sources", {
      excludeCopyrightTags: [...this.excludedCopyrightTags].slice(-256),
    }, {
      signal: this.abortController.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const sources = Array.isArray(sourceData?.sources) ? sourceData.sources : [];
    if (sources.length === 0) throw new Error("困难题源暂时没有返回候选");

    const entries = [];
    for (const source of sources.slice(0, this.batchSize)) {
      if (this.stopped) return;
      try {
        const traceData = await searchTraceMoe(source?.traceInputUrl, this.abortController.signal);
        const traceResult = selectBestTraceResult(traceData);
        if (traceResult?.image) entries.push({ source, traceResult });
      } catch (error) {
        if (error.name === "AbortError" || error.code === "QUOTA_EXCEEDED") throw error;
        console.warn("困难题目识图失败，已跳过本候选：", error.message);
      }
    }
    if (entries.length === 0) throw new Error("trace.moe 未识别出可用的动画截图");

    const resolved = await postJson("/api/hard/resolve", { entries }, {
      signal: this.abortController.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: { "X-DeepSeek-Api-Key": this.apiKey },
    });
    const questions = Array.isArray(resolved?.questions) ? resolved.questions : [];
    for (const question of questions) {
      const normalized = this.normalizeQuestion(question);
      if (!normalized || this.usedQuestionIds.has(normalized.id)) continue;
      this.usedQuestionIds.add(normalized.id);
      this.buffer.push(normalized);
      for (const tag of normalized.copyrightTags) this.excludedCopyrightTags.add(tag);
    }
    trimSet(this.excludedCopyrightTags, 256);
    trimSet(this.usedQuestionIds, 512);
    this.emitBufferChange();
    if (this.buffer.length === 0) throw new Error("本批困难题目均与近期题目重复，请重试");
  }

  emitBufferChange() {
    this.onBufferChange?.(this.buffer.length);
  }

  normalizeQuestion(question) {
    const title = typeof question?.title === "string" ? question.title.trim() : "";
    const image = validateTraceImage(question?.image);
    if (!title || !image) return null;
    const id = String(question.id || `hard-${crypto.randomUUID()}`);
    return {
      ...question,
      id,
      answerId: id,
      title,
      imageCandidates: [image],
      options: buildHardOptions(id, title, this.catalog.anime),
      copyrightTags: Array.isArray(question?.sakugabooru?.copyrightTags)
        ? question.sakugabooru.copyrightTags.filter((tag) => typeof tag === "string" && tag)
        : [],
      source: "sakugabooru-tracemoe",
    };
  }
}

async function searchTraceMoe(mediaUrl, externalSignal) {
  if (!isAllowedSourceUrl(mediaUrl)) throw new Error("困难题目来源地址无效");
  const traceUrl = new URL(TRACE_SEARCH_URL);
  traceUrl.searchParams.set("anilistInfo", "");
  traceUrl.searchParams.set("url", mediaUrl);
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(traceUrl, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
      }, REQUEST_TIMEOUT_MS, externalSignal);
      if (response.ok) return response.json();
      const body = await readSmallText(response, 600);
      const error = new Error(`trace.moe HTTP ${response.status}${body ? `：${body}` : ""}`);
      error.status = response.status;
      if (response.status === 402) await classifyTraceLimit(error, externalSignal);
      throw error;
    } catch (error) {
      if (externalSignal?.aborted || error.name === "AbortError" || error.code === "QUOTA_EXCEEDED") throw error;
      lastError = error;
      const retryable = !error.status || error.status === 429 || error.status >= 500 || error.code === "TRACE_CONCURRENCY";
      if (!retryable || attempt === 2) break;
      await delay(700 * (2 ** attempt));
    }
  }
  throw lastError || new Error("trace.moe 暂时不可用");
}

async function classifyTraceLimit(error, externalSignal) {
  try {
    const response = await fetchWithTimeout(TRACE_ACCOUNT_URL, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
    }, 10_000, externalSignal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const account = await response.json();
    const quota = Number(account?.quota);
    const used = Number(account?.quotaUsed);
    if (Number.isFinite(quota) && Number.isFinite(used) && (quota <= 0 || used >= quota)) {
      error.code = "QUOTA_EXCEEDED";
      error.message = `当前公网 IP 的 trace.moe 搜索额度已用完（${used}/${quota}）`;
      return;
    }
  } catch {
    // A failed diagnostic is treated as a temporary concurrency response.
  }
  error.code = "TRACE_CONCURRENCY";
  error.message = "trace.moe 当前并发繁忙，请稍后重试";
}

function selectBestTraceResult(traceData) {
  return (Array.isArray(traceData?.result) ? traceData.result : [])
    .filter((result) => result?.image && result?.anilist?.isAdult !== true)
    .sort((left, right) => (Number(right.similarity) || 0) - (Number(left.similarity) || 0))[0] || null;
}

function buildHardOptions(answerId, answerTitle, titlePool) {
  const answerKey = normalizeSearchText(answerTitle);
  const wrong = new Map();
  const shuffled = shuffle(titlePool);
  for (const anime of shuffled) {
    const key = normalizeSearchText(anime.title);
    if (!key || key === answerKey || wrong.has(key)) continue;
    wrong.set(key, { id: `catalog-${anime.anidbId}`, title: anime.title });
    if (wrong.size === 3) break;
  }
  return shuffle([{ id: answerId, title: answerTitle }, ...wrong.values()]);
}

async function postJson(url, body, options = {}) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
    body: JSON.stringify(body),
  }, options.timeoutMs || 20_000, options.signal);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
    error.code = data?.code || null;
    throw error;
  }
  return data;
}

async function fetchWithTimeout(url, options, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const abortError = new DOMException("请求已取消或超时", "AbortError");
      throw abortError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

function isAllowedSourceUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (hostname === "sakugabooru.com" || hostname.endsWith(".sakugabooru.com"));
  } catch {
    return false;
  }
}

function validateTraceImage(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (hostname === "trace.moe" || hostname.endsWith(".trace.moe"))
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

async function readSmallText(response, maximumCharacters) {
  const text = await response.text().catch(() => "");
  return text.slice(0, maximumCharacters);
}

function trimSet(set, maximumSize) {
  while (set.size > maximumSize) set.delete(set.values().next().value);
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
