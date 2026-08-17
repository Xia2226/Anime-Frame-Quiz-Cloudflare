import { normalizeSearchText } from "./catalog.js";

const REQUEST_TIMEOUT_MS = 60_000;
// 视频元数据加载上限：超时视为该帧加载失败，避免卡在“正在准备题目…”
const FRAME_LOAD_TIMEOUT_MS = 20_000;
// 连续整批画面加载失败的上限，超过后放弃重试，避免无限轮询源站
const MAX_CONSECUTIVE_EMPTY_BATCHES = 3;
// 版权标签去重记录持久化到当前标签页会话：退出困难模式后重新进入仍继续去重
const EXCLUDED_TAGS_STORAGE_KEY = "anime-frame-quiz.hard-excluded-tags.v1";

// 从 sessionStorage 恢复版权标签去重记录；数据损坏或存储不可用时从空集开始
function loadExcludedTags() {
  try {
    const raw = sessionStorage.getItem(EXCLUDED_TAGS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((tag) => typeof tag === "string" && tag));
    }
  } catch {
    // 忽略损坏数据
  }
  return new Set();
}

function saveExcludedTags(tags) {
  try {
    sessionStorage.setItem(EXCLUDED_TAGS_STORAGE_KEY, JSON.stringify([...tags]));
  } catch {
    // sessionStorage 不可用时静默忽略，去重仅在本次内存会话内有效
  }
}

// 一轮困难挑战结束（答满 minRankQuestions 题结算）后调用，让新一轮重新开始去重
export function clearExcludedTags() {
  try {
    sessionStorage.removeItem(EXCLUDED_TAGS_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

export class HardQuestionProvider {
  constructor({ apiKey, catalog, batchSize = 20, onBufferChange = null }) {
    this.apiKey = apiKey;
    this.catalog = catalog;
    this.batchSize = batchSize;
    // 补货水位线：池内（含加载中）降到该值及以下才批量补货到 batchSize，
    // 避免"答一题补一题"导致 sources/resolve/DeepSeek 接口被高频调用
    this.refillThreshold = Math.max(1, Math.floor(batchSize / 2));
    this.onBufferChange = typeof onBufferChange === "function" ? onBufferChange : null;
    this.buffer = [];
    this.pendingFrames = [];
    this.excludedCopyrightTags = loadExcludedTags();
    this.blobUrls = [];
    this.emptyBatchCount = 0;
    this.fillPromise = null;
    this.stopped = false;
    this.abortController = new AbortController();
  }

  get bufferedCount() {
    return this.buffer.length + this.pendingFrames.length;
  }

  // 已就绪（可立即出题）的数量，用于池显示
  get readyCount() {
    return this.buffer.length;
  }

  async next() {
    if (this.stopped) return null;
    // 视频帧并行预加载，谁先就绪谁先展示；未就绪前不返回任何题（无占位图）
    while (this.buffer.length === 0) {
      if (this.pendingFrames.length === 0) {
        if (this.fillPromise) {
          await this.fillPromise;
        } else {
          await this.ensureFilled();
        }
        if (this.stopped) return null;
        // 整批画面均加载失败：连续多次后放弃，避免无休止地重新拉取题源
        if (this.pendingFrames.length === 0 && this.buffer.length === 0 && !this.fillPromise) {
          this.emptyBatchCount += 1;
          if (this.emptyBatchCount > MAX_CONSECUTIVE_EMPTY_BATCHES) {
            throw new Error("连续多批题目画面加载失败，请稍后重试。");
          }
        }
      } else {
        await Promise.race(this.pendingFrames.map((item) => item.ready));
      }
      if (this.stopped) return null;
    }
    const question = this.buffer.shift();
    this.emitBufferChange();
    // 池内（含加载中）降到水位线及以下才批量补货到 batchSize，
    // 一局 50 题的补货次数从约 50 次降到约 9 次，sources/resolve/DeepSeek 调用同步减少
    if (this.bufferedCount <= this.refillThreshold && !document.hidden) {
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
    this.pendingFrames = [];
    this.emitBufferChange();
  }

  // 结算回顾渲染完成后再释放抽帧 Blob；stop() 不立即释放，
  // 否则完整回顾页的截图会因 revokeObjectURL 而加载失败
  releaseBlobUrls() {
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }

  async ensureFilled() {
    if (this.stopped || this.bufferedCount >= this.batchSize) return;
    if (this.fillPromise) return this.fillPromise;
    this.fillPromise = this.fill();
    try {
      await this.fillPromise;
    } finally {
      this.fillPromise = null;
    }
  }

  async fill() {
    // 只补充到批次上限，避免与池中已有题目（含预加载中）叠加超出 batchSize；源站按需拉取
    const need = Math.max(1, this.batchSize - this.bufferedCount);
    const sourceData = await postJson("/api/hard/sources", {
      excludeCopyrightTags: [...this.excludedCopyrightTags].slice(-256),
      limit: need,
    }, {
      signal: this.abortController.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const sources = Array.isArray(sourceData?.sources) ? sourceData.sources : [];
    if (sources.length === 0) throw new Error("困难题源暂时没有返回候选");

    const entries = sources.slice(0, need).map((source) => ({ source }));
    if (entries.length === 0) throw new Error("困难题源暂时没有返回候选");

    const resolved = await postJson("/api/hard/resolve", { entries }, {
      signal: this.abortController.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: this.apiKey
        ? { "X-DeepSeek-Api-Key": this.apiKey }
        : {},
    });
    const questions = Array.isArray(resolved?.questions) ? resolved.questions : [];
    const normalizedQuestions = [];
    for (const question of questions) {
      const normalized = this.normalizeQuestion(question);
      if (!normalized) continue;
      normalizedQuestions.push(normalized);
      for (const tag of normalized.copyrightTags) this.excludedCopyrightTags.add(tag);
    }
    trimSet(this.excludedCopyrightTags, 256);
    saveExcludedTags(this.excludedCopyrightTags);
    if (normalizedQuestions.length === 0) throw new Error("本批困难题目均未通过标题翻译校验，请重试");
    // 并行预加载视频并抽帧：谁先就绪谁先展示，加载/抽帧失败的题目自动剔除
    for (const normalized of normalizedQuestions) {
      const frame = createVideoFrame(normalized.video, this.abortController.signal);
      this.pendingFrames.push({ normalized, frame, ready: frame.ready });
      void frame.ready.then(() => {
        // stop() 已清空池并释放过 Blob，此时归位只会造成泄漏
        if (this.stopped) return;
        if (frame.imageBlobUrl) this.blobUrls.push(frame.imageBlobUrl);
        this.readyFrame(normalized, frame);
      });
    }
    this.emitBufferChange();
  }

  readyFrame(normalized, frame) {
    const index = this.pendingFrames.findIndex((item) => item.normalized === normalized);
    if (index === -1) return;
    this.pendingFrames.splice(index, 1);
    if (!frame.state.error) {
      normalized._videoFrame = frame;
      this.buffer.push(normalized);
      this.emptyBatchCount = 0;
    }
    // 视频加载失败的题目剔除；其版权标签仍保留在排除集合以避免重复
    this.emitBufferChange();
  }

  emitBufferChange() {
    // 池显示只报告已就绪的数量（加载中不计入）
    this.onBufferChange?.(this.readyCount);
  }

  normalizeQuestion(question) {
    const title = typeof question?.title === "string" ? question.title.trim() : "";
    if (!title || !question?.video) return null;
    const id = String(question.id || `hard-${crypto.randomUUID()}`);
    return {
      ...question,
      id,
      answerId: id,
      title,
      options: buildHardOptions(id, title, this.catalog.anime),
      copyrightTags: Array.isArray(question?.sakugabooru?.copyrightTags)
        ? question.sakugabooru.copyrightTags.filter((tag) => typeof tag === "string" && tag)
        : [],
      source: "sakugabooru-deepseek",
    };
  }
}

// 预加载视频、随机暂停，并通过 canvas 抽帧得到 Blob 截图；ready 完成后截图 URL 已就绪
function createVideoFrame(videoUrl, signal) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  const frame = { video, state: { error: null }, imageBlobUrl: null };
  let settled = false;
  let timeoutId = null;
  const ready = new Promise((resolve) => {
    // 统一收口：无论成功、失败还是超时都只结算一次，并清除加载定时器
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (error) {
        frame.state.error = error;
        video.removeAttribute("src");
        video.load();
      }
      resolve();
    };
    const fail = (error) => finish(error);
    if (!videoUrl) {
      fail(new Error("无视频地址"));
      return;
    }
    // 走 Worker 代理注入 CORS 头，canvas 抽帧才不会被安全策略污染
    video.src = proxyVideoUrl(videoUrl);
    video.addEventListener("loadedmetadata", () => {
      if (settled) return;
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        fail(new Error("视频时长无效"));
        return;
      }
      // 避开开头结尾的淡入淡出/黑屏区段，随机取中间一段
      const start = Math.min(0.5, duration * 0.05);
      const end = Math.max(start + 1, duration * 0.9);
      video.currentTime = start + Math.random() * (end - start);
    }, { once: true });
    video.addEventListener("seeked", () => {
      captureFrame(video).then((imageBlobUrl) => {
        if (settled) return;
        frame.imageBlobUrl = imageBlobUrl;
        finish();
      }, (error) => fail(error));
    }, { once: true });
    video.addEventListener("error", () => fail(new Error("视频加载失败")), { once: true });
    signal?.addEventListener("abort", () => fail(new DOMException("已取消", "AbortError")), { once: true });
    timeoutId = setTimeout(() => fail(new Error("画面加载超时，请重试")), FRAME_LOAD_TIMEOUT_MS);
  });
  frame.ready = ready;
  return frame;
}

// 把当前视频帧绘制到 canvas 并导出为 Blob 截图（视频已通过代理同源加载，canvas 不受污染）
async function captureFrame(video) {
  if (!Number.isFinite(video.videoWidth) || !Number.isFinite(video.videoHeight)
    || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error("视频尺寸无效");
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持画面截图");
  context.drawImage(video, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("画面截图生成失败"));
    }, "image/jpeg", 0.92);
  });
  return URL.createObjectURL(blob);
}

// 视频走 Worker 代理：注入 CORS 头 + 透传 Range，且与页面同源，canvas 可安全读取像素
function proxyVideoUrl(videoUrl) {
  return `/api/hard/video-proxy?url=${encodeURIComponent(videoUrl)}`;
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
