const MAX_POOL_SIZE = 15;
const MIN_READY_SIZE = 1;
const RECENT_ANSWERED_QUESTION_LIMIT = 50;
const MAX_EXCLUDED_COPYRIGHT_TAGS = 512;
const MAX_HISTORY_SIZE = 5;
const MAX_TITLE_BANK_SIZE = 200;
const QUOTA_THRESHOLD = 0;
const FETCH_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 90000;
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;
const TRACE_SEARCH_TIMEOUT_MS = 60000;
const TRACE_SEARCH_RETRY_LIMIT = 3;
const TRACE_MOE_API_URL = "https://api.trace.moe/search";
const TRACE_MOE_ACCOUNT_URL = "https://api.trace.moe/me";
const DEEPSEEK_SESSION_STORAGE_KEY = "anime-frame-quiz.deepseek-api-key";
const FILTER_STORAGE_KEY = "anime-frame-quiz.filter.v1";
const FAVORITES_STORAGE_KEY = "anime-frame-quiz.favorites.v1";
const TRANSLATION_STORAGE_KEY = "anime-frame-quiz.translations.v1";
const MAX_FAVORITES = 500;
const MAX_TRANSLATION_CACHE_SIZE = 2000;
const DEFAULT_FILTER_CONFIG = {
  startDate: "",
  endDate: "",
  minScore: null,
  maxScore: null,
  rating: "s",
};

const FALLBACK_TITLES = [
  "进击的巨人",
  "鬼灭之刃",
  "咒术回战",
  "钢之炼金术师",
  "命运石之门",
];

const state = {
  started: false,
  pool: [],
  current: null,
  fetching: false,
  answered: 0,
  correct: 0,
  locked: false,
  quotaExceeded: false,
  quotaMessage: "",
  titleBank: new Set(FALLBACK_TITLES),
  translationTitleBank: new Set(),
  translationCache: new Map(),
  recentAnsweredCopyrightTags: [],
  filterConfig: { ...DEFAULT_FILTER_CONFIG },
  favorites: [],
  history: [],
  historyIndex: -1,
  poolTimerId: null,
  nextQuestionTimerId: null,
  poolGeneration: 0,
  poolAbortController: null,
  updatingFavorite: false,
  browserDeepSeekApiKey: readStoredDeepSeekApiKey(),
  serverDeepSeekApiKeySource: null,
  deepSeekApiKeyValidationState: "unknown",
  apiKeyValidationGeneration: 0,
};

const els = {
  startScreen: document.querySelector("#startScreen"),
  gameScreen: document.querySelector("#gameScreen"),
  startButton: document.querySelector("#startButton"),
  backButton: document.querySelector("#backButton"),
  framePanel: document.querySelector(".framePanel"),
  answeredCount: document.querySelector("#answeredCount"),
  accuracyRate: document.querySelector("#accuracyRate"),
  poolCount: document.querySelector("#poolCount"),
  animeFrame: document.querySelector("#animeFrame"),
  loadingLayer: document.querySelector("#loadingLayer"),
  loadingText: document.querySelector("#loadingText"),
  statusText: document.querySelector("#statusText"),
  options: document.querySelector("#options"),
  feedback: document.querySelector("#feedback"),
  prevHistoryButton: document.querySelector("#prevHistoryButton"),
  nextHistoryButton: document.querySelector("#nextHistoryButton"),
  skipButton: document.querySelector("#skipButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsModal: document.querySelector("#settingsModal"),
  settingsCloseButton: document.querySelector("#settingsCloseButton"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsResetButton: document.querySelector("#settingsResetButton"),
  settingsSaveButton: document.querySelector("#settingsSaveButton"),
  settingsSummary: document.querySelector("#settingsSummary"),
  apiKeyForm: document.querySelector("#apiKeyForm"),
  deepSeekApiKeyInput: document.querySelector("#deepSeekApiKeyInput"),
  apiKeySaveButton: document.querySelector("#apiKeySaveButton"),
  apiKeySummary: document.querySelector("#apiKeySummary"),
  settingsEffectiveTags: document.querySelector("#settingsEffectiveTags"),
  settingsMessage: document.querySelector("#settingsMessage"),
  filterStartDate: document.querySelector("#filterStartDate"),
  filterEndDate: document.querySelector("#filterEndDate"),
  filterMinScore: document.querySelector("#filterMinScore"),
  filterMaxScore: document.querySelector("#filterMaxScore"),
  filterRating: document.querySelector("#filterRating"),
  favoritesButton: document.querySelector("#favoritesButton"),
  favoritesModal: document.querySelector("#favoritesModal"),
  favoritesCloseButton: document.querySelector("#favoritesCloseButton"),
  favoritesList: document.querySelector("#favoritesList"),
  favoriteButton: document.querySelector("#favoriteButton"),
};

start();

function start() {
  els.startButton.addEventListener("click", startGame);
  els.backButton.addEventListener("click", backToHome);
  els.skipButton.addEventListener("click", skipQuestion);
  els.settingsButton.addEventListener("click", openSettings);
  els.settingsCloseButton.addEventListener("click", closeSettings);
  els.settingsResetButton.addEventListener("click", resetSettingsForm);
  els.settingsForm.addEventListener("submit", saveSettings);
  els.settingsForm.addEventListener("input", handleSettingsInput);
  els.apiKeyForm.addEventListener("submit", saveBrowserDeepSeekApiKey);
  els.deepSeekApiKeyInput.addEventListener("input", handleBrowserDeepSeekApiKeyInput);
  els.settingsModal.addEventListener("click", (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });
  els.favoritesButton.addEventListener("click", openFavorites);
  els.favoritesCloseButton.addEventListener("click", closeFavorites);
  els.favoritesModal.addEventListener("click", (event) => {
    if (event.target === els.favoritesModal) closeFavorites();
  });
  els.favoriteButton.addEventListener("click", toggleFavorite);
  els.prevHistoryButton.addEventListener("click", showPrevHistory);
  els.nextHistoryButton.addEventListener("click", showNextHistory);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!els.settingsModal.classList.contains("hidden")) {
        closeSettings();
      }
      if (!els.favoritesModal.classList.contains("hidden")) {
        closeFavorites();
      }
      return;
    }
    if (!state.current || state.locked) return;
    const key = event.key;
    if (key === " " || key === "Spacebar") {
      event.preventDefault();
      skipQuestion();
      return;
    }
    const digit = Number(key);
    if (digit >= 1 && digit <= 4) {
      const optionButton = els.options.children[digit - 1];
      if (optionButton && !optionButton.disabled) {
        event.preventDefault();
        optionButton.click();
      }
    }
  });

  const today = getLocalDateString();
  els.filterStartDate.max = today;
  els.filterEndDate.max = today;
  els.deepSeekApiKeyInput.value = state.browserDeepSeekApiKey;
  loadSettings();
  void loadConfigStatus();
  loadFavorites();
  loadTranslationTitleBank();
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadSettings() {
  try {
    const stored = readLocalJson(FILTER_STORAGE_KEY, DEFAULT_FILTER_CONFIG);
    state.filterConfig = normalizeFilterConfig(stored);
    populateSettingsForm(state.filterConfig);
    renderSettingsSummary();
    renderEffectiveTags(buildFilterTags(state.filterConfig));
  } catch (error) {
    console.warn("加载筛选配置失败：", error);
    state.filterConfig = { ...DEFAULT_FILTER_CONFIG };
    populateSettingsForm(state.filterConfig);
    els.settingsSummary.textContent = "浏览器筛选配置读取失败，当前使用 Safe 默认设置";
    renderEffectiveTags(buildFilterTags(state.filterConfig));
  }
}

async function loadConfigStatus() {
  try {
    const data = await fetchJson("/api/config-status");
    const apiKey = data?.deepSeekApiKey;
    state.serverDeepSeekApiKeySource = apiKey?.source || null;
    if (apiKey?.source === "environment") {
      els.apiKeySummary.dataset.state = "configured";
      els.apiKeySummary.textContent = "已读取 Cloudflare Worker 环境 Secret DEEPSEEK_API_KEY，无需手动输入";
      state.deepSeekApiKeyValidationState = "valid";
      els.deepSeekApiKeyInput.disabled = true;
      els.apiKeySaveButton.disabled = true;
      return;
    }
    els.deepSeekApiKeyInput.disabled = false;
    els.apiKeySaveButton.disabled = false;
    if (state.browserDeepSeekApiKey) {
      state.deepSeekApiKeyValidationState = "valid";
      els.apiKeySummary.dataset.state = "configured";
      els.apiKeySummary.textContent = "已使用当前标签页中检测通过的 API Key";
      return;
    }
    renderMissingApiKeyStatus();
  } catch (error) {
    console.warn("读取 DeepSeek API Key 配置状态失败：", error);
    if (state.browserDeepSeekApiKey) {
      state.deepSeekApiKeyValidationState = "valid";
      els.apiKeySummary.dataset.state = "configured";
      els.apiKeySummary.textContent = "已使用当前标签页中检测通过的 API Key；无法读取环境变量状态";
    } else {
      els.apiKeySummary.dataset.state = "missing";
      els.apiKeySummary.textContent = "可在此手动输入 Key；当前无法读取服务端配置状态";
    }
  }
}

function saveBrowserDeepSeekApiKey(event) {
  event.preventDefault();
  void applyBrowserDeepSeekApiKey();
}

function handleBrowserDeepSeekApiKeyInput() {
  if (state.serverDeepSeekApiKeySource === "environment") return;

  state.apiKeyValidationGeneration += 1;
  const apiKey = els.deepSeekApiKeyInput.value.trim();
  if (apiKey && apiKey === state.browserDeepSeekApiKey) {
    state.deepSeekApiKeyValidationState = "valid";
    els.apiKeySummary.dataset.state = "configured";
    els.apiKeySummary.textContent = "当前 API Key 已检测通过并应用";
    return;
  }

  state.deepSeekApiKeyValidationState = "unknown";
  delete els.apiKeySummary.dataset.state;
  els.apiKeySummary.textContent = apiKey
    ? "API Key 尚未检测，请点击“应用并检测”"
    : "输入已清空，点击“应用并检测”后移除当前 Key";
}

async function applyBrowserDeepSeekApiKey() {
  if (state.serverDeepSeekApiKeySource === "environment") return true;

  const apiKey = els.deepSeekApiKeyInput.value.trim();
  if (!apiKey) {
    state.browserDeepSeekApiKey = "";
    state.deepSeekApiKeyValidationState = "empty";
    storeDeepSeekApiKey("");
    renderMissingApiKeyStatus("已移除页面输入的 Key。");
    return true;
  }
  if (
    state.deepSeekApiKeyValidationState === "valid"
    && apiKey === state.browserDeepSeekApiKey
  ) {
    return true;
  }

  const validationGeneration = ++state.apiKeyValidationGeneration;
  state.deepSeekApiKeyValidationState = "checking";
  els.deepSeekApiKeyInput.disabled = true;
  els.apiKeySaveButton.disabled = true;
  els.apiKeySummary.dataset.state = "checking";
  els.apiKeySummary.textContent = "正在检测 DeepSeek API Key...";

  try {
    const data = await requestDeepSeekApiKeyValidation(apiKey);
    if (
      validationGeneration !== state.apiKeyValidationGeneration
      || els.deepSeekApiKeyInput.value.trim() !== apiKey
    ) {
      return false;
    }
    if (!data?.valid) {
      state.browserDeepSeekApiKey = "";
      state.deepSeekApiKeyValidationState = "invalid";
      storeDeepSeekApiKey("");
      els.apiKeySummary.dataset.state = "missing";
      els.apiKeySummary.textContent = data?.message || "API Key 不可用";
      return false;
    }
    state.browserDeepSeekApiKey = apiKey;
    state.deepSeekApiKeyValidationState = "valid";
    storeDeepSeekApiKey(apiKey);
    els.apiKeySummary.dataset.state = "configured";
    els.apiKeySummary.textContent = `${data.message}；已应用到当前标签页`;
    return true;
  } catch (error) {
    if (validationGeneration !== state.apiKeyValidationGeneration) return false;
    state.browserDeepSeekApiKey = "";
    state.deepSeekApiKeyValidationState = "error";
    storeDeepSeekApiKey("");
    els.apiKeySummary.dataset.state = "missing";
    els.apiKeySummary.textContent = `检测失败：${error.message}`;
    return false;
  } finally {
    if (validationGeneration === state.apiKeyValidationGeneration) {
      els.deepSeekApiKeyInput.disabled = false;
      els.apiKeySaveButton.disabled = false;
    }
  }
}

async function requestDeepSeekApiKeyValidation(apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch("/api/deepseek/validate", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "X-DeepSeek-Api-Key": apiKey,
      },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("检测超时，请检查网络后重试");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function renderMissingApiKeyStatus(prefix = "") {
  els.apiKeySummary.dataset.state = "missing";
  els.apiKeySummary.textContent = `${prefix}${prefix ? " " : ""}可设置 Worker Secret DEEPSEEK_API_KEY；网页访问者也可在此输入`;
}

function readStoredDeepSeekApiKey() {
  try {
    return sessionStorage.getItem(DEEPSEEK_SESSION_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function storeDeepSeekApiKey(apiKey) {
  try {
    if (apiKey) {
      sessionStorage.setItem(DEEPSEEK_SESSION_STORAGE_KEY, apiKey);
    } else {
      sessionStorage.removeItem(DEEPSEEK_SESSION_STORAGE_KEY);
    }
  } catch {
    console.warn("浏览器不允许使用会话存储，页面输入的 Key 仅在本次打开期间有效");
  }
}

function readLocalJson(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn("浏览器本地存储写入失败：", error);
    return false;
  }
}

function loadTranslationTitleBank() {
  state.translationCache.clear();
  state.translationTitleBank.clear();
  const stored = readLocalJson(TRANSLATION_STORAGE_KEY, {});
  const entries = Array.isArray(stored?.entries) ? stored.entries : [];
  for (const entry of entries) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    const title = typeof entry?.title === "string" ? entry.title.trim() : "";
    if (!key || key.length > 1000 || !title || title.length > 200) continue;
    state.translationCache.set(key, title);
    state.translationTitleBank.add(title);
  }
  trimTranslationCache();
  console.log(`[题目选项] 已从当前浏览器加载 ${state.translationCache.size} 个翻译缓存标题`);
}

function storeTranslation(cacheKey, title) {
  if (!cacheKey || !title) return;
  state.translationCache.delete(cacheKey);
  state.translationCache.set(cacheKey, title);
  state.translationTitleBank.add(title);
  trimTranslationCache();
  writeLocalJson(TRANSLATION_STORAGE_KEY, {
    version: 1,
    entries: [...state.translationCache].map(([key, value]) => ({ key, title: value })),
  });
}

function trimTranslationCache() {
  while (state.translationCache.size > MAX_TRANSLATION_CACHE_SIZE) {
    state.translationCache.delete(state.translationCache.keys().next().value);
  }
}

function openSettings() {
  populateSettingsForm(state.filterConfig);
  setSettingsMessage("");
  els.settingsModal.classList.remove("hidden");
  els.filterStartDate.focus();
}

function closeSettings() {
  els.settingsModal.classList.add("hidden");
  els.settingsButton.focus();
}

function resetSettingsForm() {
  populateSettingsForm(DEFAULT_FILTER_CONFIG);
  setSettingsMessage("已恢复表单默认值，点击“保存设置”后生效。");
}

function handleSettingsInput() {
  setSettingsMessage("");
  renderEffectiveTags(buildFilterTags(readSettingsForm()));
}

async function saveSettings(event) {
  event.preventDefault();
  if (!els.settingsForm.reportValidity()) return;

  const config = readSettingsForm();
  if (config.startDate && config.endDate && config.startDate > config.endDate) {
    setSettingsMessage("起始日期不能晚于结束日期。", "error");
    return;
  }
  if (config.minScore !== null && config.maxScore !== null && config.minScore > config.maxScore) {
    setSettingsMessage("最低热度不能高于最高热度。", "error");
    return;
  }

  els.settingsSaveButton.disabled = true;
  setSettingsMessage("正在保存到当前浏览器...");
  try {
    state.filterConfig = normalizeFilterConfig(config);
    if (!writeLocalJson(FILTER_STORAGE_KEY, state.filterConfig)) {
      throw new Error("浏览器禁止或无法写入本地存储");
    }
    populateSettingsForm(state.filterConfig);
    renderSettingsSummary();
    renderEffectiveTags(buildFilterTags(state.filterConfig));
    state.pool = [];
    state.poolGeneration += 1;
    abortPoolRequest();
    if (state.started) void fillPoolTick();
    setSettingsMessage("设置已保存到当前浏览器，新的随机题目将使用此筛选。", "success");
  } catch (error) {
    setSettingsMessage(`保存失败：${error.message}`, "error");
  } finally {
    els.settingsSaveButton.disabled = false;
  }
}

function loadFavorites() {
  state.favorites = normalizeStoredFavorites(readLocalJson(FAVORITES_STORAGE_KEY, []));
  console.log(`[收藏] 已从当前浏览器加载 ${state.favorites.length} 个收藏动漫`);
}

function normalizeStoredFavorites(data) {
  if (!Array.isArray(data)) return [];
  const normalized = [];
  const seenTitles = new Set();
  for (const item of data) {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const tags = [...new Set((Array.isArray(item?.tags) ? item.tags : [])
      .map((tag) => typeof tag === "string" ? tag.trim() : "")
      .filter((tag) => tag && tag.length <= 128 && /^[a-zA-Z0-9_:\-.]+$/.test(tag)))]
      .slice(0, MAX_EXCLUDED_COPYRIGHT_TAGS);
    if (!title || title.length > 200 || tags.length === 0 || seenTitles.has(title)) continue;
    seenTitles.add(title);
    normalized.push({
      title,
      tags,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    });
    if (normalized.length >= MAX_FAVORITES) break;
  }
  return normalized;
}

function persistFavorites() {
  if (!writeLocalJson(FAVORITES_STORAGE_KEY, state.favorites)) {
    throw new Error("浏览器禁止或无法写入本地存储");
  }
}

function openFavorites() {
  renderFavoritesList();
  els.favoritesModal.classList.remove("hidden");
  els.favoritesCloseButton.focus();
}

function closeFavorites() {
  els.favoritesModal.classList.add("hidden");
  els.favoritesButton.focus();
}

function renderFavoritesList() {
  if (state.favorites.length === 0) {
    els.favoritesList.innerHTML = '<p class="favoritesEmpty">暂无收藏的动漫</p>';
    return;
  }

  els.favoritesList.innerHTML = "";
  for (const item of state.favorites) {
    const div = document.createElement("div");
    div.className = "favoriteItem";

    const span = document.createElement("span");
    span.className = "favoriteItemTitle";
    span.textContent = item.title;
    span.title = item.title;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "favoriteItemDelete";
    btn.textContent = "删除";
    btn.addEventListener("click", () => removeFavorite(item.title));

    div.appendChild(span);
    div.appendChild(btn);
    els.favoritesList.appendChild(div);
  }
}

function getFavoriteTarget() {
  if (state.historyIndex !== -1) {
    return state.history[state.historyIndex] || null;
  }
  return state.current;
}

function isFavorited(item = getFavoriteTarget()) {
  if (!item?.title) return false;
  return state.favorites.some((favorite) => favorite.title === item.title);
}

function updateFavoriteButton() {
  const target = getFavoriteTarget();
  const favorited = isFavorited(target);
  const unavailable = !target?.title || getCopyrightTags(target).length === 0;
  els.favoriteButton.classList.toggle("hidden", unavailable);
  els.favoriteButton.disabled = unavailable || state.updatingFavorite;
  els.favoriteButton.setAttribute("aria-label", favorited ? "取消收藏" : "收藏此动漫");
  if (favorited) {
    els.favoriteButton.classList.add("favorited");
    els.favoriteButton.title = "取消收藏";
  } else {
    els.favoriteButton.classList.remove("favorited");
    els.favoriteButton.title = "收藏此动漫";
  }
}

async function toggleFavorite() {
  const target = getFavoriteTarget();
  if (!target?.title || getCopyrightTags(target).length === 0 || state.updatingFavorite) return;

  state.updatingFavorite = true;
  updateFavoriteButton();
  try {
    if (isFavorited(target)) {
      await removeFavorite(target.title);
    } else {
      await addFavorite(target);
    }
  } finally {
    state.updatingFavorite = false;
    updateFavoriteButton();
  }
}

async function addFavorite(item) {
  const tags = getCopyrightTags(item);
  if (!item.title || tags.length === 0) {
    console.warn("[收藏] 无法收藏：缺少标题或版权标签");
    return;
  }

  try {
    if (state.favorites.length >= MAX_FAVORITES) {
      throw new Error(`收藏数量已达到 ${MAX_FAVORITES} 条上限`);
    }
    state.favorites = normalizeStoredFavorites([...state.favorites, {
      title: item.title,
      tags,
      createdAt: new Date().toISOString(),
    }]);
    persistFavorites();
    const addedTags = new Set(tags);
    state.pool = state.pool.filter((poolItem) => !hasCopyrightOverlap(poolItem, addedTags));
    console.log(`[收藏] 已添加收藏: ${item.title}`);
    if (state.started) void fillPoolTick();
  } catch (error) {
    console.warn("[收藏] 添加收藏失败:", error.message);
  }
}

async function removeFavorite(title) {
  try {
    state.favorites = state.favorites.filter((favorite) => favorite.title !== title);
    persistFavorites();
    console.log(`[收藏] 已移除收藏: ${title}`);
    renderFavoritesList();
  } catch (error) {
    console.warn("[收藏] 删除收藏失败:", error.message);
  }
}

function readSettingsForm() {
  return {
    startDate: els.filterStartDate.value,
    endDate: els.filterEndDate.value,
    minScore: els.filterMinScore.value === "" ? null : Number(els.filterMinScore.value),
    maxScore: els.filterMaxScore.value === "" ? null : Number(els.filterMaxScore.value),
    rating: els.filterRating.value,
  };
}

function normalizeFilterConfig(config = {}) {
  const normalizeDate = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
    const parsed = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return "";
    return text >= "2000-01-01" && text <= getLocalDateString() ? text : "";
  };
  const normalizeScore = (value) => (
    Number.isInteger(value) && value >= -1000 && value <= 100000 ? value : null
  );
  let startDate = normalizeDate(config.startDate);
  let endDate = normalizeDate(config.endDate);
  let minScore = normalizeScore(config.minScore);
  let maxScore = normalizeScore(config.maxScore);
  if (startDate && endDate && startDate > endDate) {
    startDate = "";
    endDate = "";
  }
  if (minScore !== null && maxScore !== null && minScore > maxScore) {
    minScore = null;
    maxScore = null;
  }
  return {
    startDate,
    endDate,
    minScore,
    maxScore,
    rating: ["", "s", "q", "e"].includes(config.rating) ? config.rating : "s",
  };
}

function populateSettingsForm(config) {
  const normalized = normalizeFilterConfig(config);
  els.filterStartDate.value = normalized.startDate;
  els.filterEndDate.value = normalized.endDate;
  els.filterMinScore.value = normalized.minScore ?? "";
  els.filterMaxScore.value = normalized.maxScore ?? "";
  els.filterRating.value = normalized.rating;
  renderEffectiveTags(buildFilterTags(normalized));
}

function buildFilterTags(config) {
  const tags = ["animated"];
  if (config.startDate && config.endDate) {
    tags.push(`date:${config.startDate}..${config.endDate}`);
  } else if (config.startDate) {
    tags.push(`date:>=${config.startDate}`);
  } else if (config.endDate) {
    tags.push(`date:<=${config.endDate}`);
  }
  if (config.minScore !== null && config.maxScore !== null) {
    tags.push(`score:${config.minScore}..${config.maxScore}`);
  } else if (config.minScore !== null) {
    tags.push(`score:>=${config.minScore}`);
  } else if (config.maxScore !== null) {
    tags.push(`score:<=${config.maxScore}`);
  }
  if (config.rating) tags.push(`rating:${config.rating}`);
  tags.push("order:random");
  return tags.join(" ");
}

function renderEffectiveTags(tags) {
  els.settingsEffectiveTags.textContent = `实际查询标签：${tags}`;
}

function renderSettingsSummary() {
  const config = state.filterConfig;
  const ratingLabels = {
    "": "全部分级",
    s: "Safe",
    q: "Questionable",
    e: "Explicit",
  };
  const dateText = config.startDate || config.endDate
    ? `${config.startDate || "不限"} 至 ${config.endDate || "今天"}`
    : "时间不限";
  const scoreText = config.minScore !== null || config.maxScore !== null
    ? `热度 ${config.minScore ?? "不限"}–${config.maxScore ?? "不限"}`
    : "热度不限";
  els.settingsSummary.textContent = `${ratingLabels[config.rating]} · ${dateText} · ${scoreText}`;
}

function setSettingsMessage(message, stateName = "") {
  els.settingsMessage.textContent = message;
  if (stateName) {
    els.settingsMessage.dataset.state = stateName;
  } else {
    delete els.settingsMessage.dataset.state;
  }
}

function backToHome() {
  state.started = false;
  stopGameTimers();
  state.poolGeneration += 1;
  abortPoolRequest();
  state.current = null;
  state.pool = [];
  state.locked = false;
  state.answered = 0;
  state.correct = 0;
  state.history = [];
  state.historyIndex = -1;
  state.updatingFavorite = false;
  els.gameScreen.classList.add("hidden");
  els.startScreen.classList.remove("hidden");
}

function startGame() {
  if (state.started) return;
  const apiKey = els.deepSeekApiKeyInput.value.trim();
  if (
    state.serverDeepSeekApiKeySource !== "environment"
    && apiKey
    && (
      state.deepSeekApiKeyValidationState !== "valid"
      || apiKey !== state.browserDeepSeekApiKey
    )
  ) {
    els.apiKeySummary.dataset.state = "missing";
    els.apiKeySummary.textContent = "请先点击“应用并检测”，确认 API Key 可用";
    els.apiKeySaveButton.focus();
    return;
  }
  state.started = true;
  state.quotaExceeded = false;
  state.quotaMessage = "";
  state.poolGeneration += 1;
  state.history = [];
  state.historyIndex = -1;
  els.startScreen.classList.add("hidden");
  els.gameScreen.classList.remove("hidden");
  stopGameTimers();
  state.poolTimerId = setInterval(fillPoolTick, FETCH_INTERVAL_MS);
  void fillPoolTick();
  updateUi();
  updateHistoryButtons();
}

function stopGameTimers() {
  if (state.poolTimerId !== null) {
    clearInterval(state.poolTimerId);
    state.poolTimerId = null;
  }
  if (state.nextQuestionTimerId !== null) {
    clearTimeout(state.nextQuestionTimerId);
    state.nextQuestionTimerId = null;
  }
}

function abortPoolRequest() {
  state.poolAbortController?.abort();
  state.poolAbortController = null;
}

async function fillPoolTick() {
  if (!state.started || state.fetching || state.pool.length >= MAX_POOL_SIZE || state.quotaExceeded) return;

  const generation = state.poolGeneration;
  const requestController = new AbortController();
  state.poolAbortController = requestController;
  state.fetching = true;
  try {
    const item = await fetchFrameQuestion(requestController.signal);
    if (!state.started || generation !== state.poolGeneration) return;
    await localizeFrameTitle(item, requestController.signal);
    if (!state.started || generation !== state.poolGeneration) return;
    if (item && !hasDuplicate(item)) {
      state.pool.push(item);
      rememberTitle(item.title);
      if (!state.current && state.pool.length >= MIN_READY_SIZE) {
        nextQuestion();
      }
    }
  } catch (error) {
    if (!state.started || generation !== state.poolGeneration) return;
    console.warn("本次补充题库失败：", error);
    if (error.code === "QUOTA_EXCEEDED") {
      state.quotaExceeded = true;
      state.quotaMessage = error.message;
    }
  } finally {
    if (state.poolAbortController === requestController) {
      state.poolAbortController = null;
    }
    state.fetching = false;
    updateUi();
  }
}

function rememberTitle(title) {
  if (!title) return;
  if (state.titleBank.has(title)) state.titleBank.delete(title);
  state.titleBank.add(title);
  while (state.titleBank.size > MAX_TITLE_BANK_SIZE) {
    state.titleBank.delete(state.titleBank.values().next().value);
  }
}

async function fetchJson(url, externalSignal = null, headers = undefined) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const handleExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", handleExternalAbort, { once: true });
  }

  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const err = new Error(data?.error || `HTTP ${response.status}`);
      err.code = data?.code || null;
      throw err;
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", handleExternalAbort);
  }
}

function buildDeepSeekRequestHeaders() {
  if (
    state.serverDeepSeekApiKeySource === "environment"
    || !state.browserDeepSeekApiKey
    || state.deepSeekApiKeyValidationState !== "valid"
  ) {
    return undefined;
  }
  return {
    "X-DeepSeek-Api-Key": state.browserDeepSeekApiKey,
  };
}

function buildFrameSourceRequestUrl() {
  const params = new URLSearchParams();
  const config = normalizeFilterConfig(state.filterConfig);
  if (config.startDate) params.set("startDate", config.startDate);
  if (config.endDate) params.set("endDate", config.endDate);
  if (config.minScore !== null) params.set("minScore", String(config.minScore));
  if (config.maxScore !== null) params.set("maxScore", String(config.maxScore));
  params.set("rating", config.rating);
  for (const tag of getExcludedCopyrightTags()) {
    params.append("excludeCopyright", tag);
  }
  const query = params.toString();
  return query ? `/api/frame-source?${query}` : "/api/frame-source";
}

async function fetchFrameQuestion(externalSignal) {
  const source = await fetchJson(buildFrameSourceRequestUrl(), externalSignal);
  const traceData = await searchTraceMoeFromBrowser(source?.traceInputUrl, externalSignal);
  const traceResult = selectBestTraceResult(traceData);
  if (!traceResult?.image) {
    throw new Error("trace.moe 未返回可展示的识别结果");
  }
  return postJson("/api/frame-resolve", { source, traceResult }, externalSignal);
}

async function searchTraceMoeFromBrowser(mediaUrl, externalSignal) {
  if (!isAllowedTraceInputUrl(mediaUrl)) {
    throw new Error("题目来源地址无效，已停止识图请求");
  }
  const traceUrl = new URL(TRACE_MOE_API_URL);
  traceUrl.searchParams.set("anilistInfo", "");
  traceUrl.searchParams.set("url", mediaUrl);
  let lastError = null;

  for (let attempt = 0; attempt < TRACE_SEARCH_RETRY_LIMIT; attempt += 1) {
    try {
      const response = await fetchWithBrowserTimeout(
        traceUrl,
        { method: "GET", mode: "cors", credentials: "omit" },
        TRACE_SEARCH_TIMEOUT_MS,
        externalSignal,
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(`trace.moe HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
        error.status = response.status;
        error.body = body;
        if (response.status === 402) await classifyBrowserTraceLimit(error, externalSignal);
        throw error;
      }
      return response.json();
    } catch (error) {
      if (externalSignal?.aborted || error.name === "AbortError") throw error;
      lastError = error;
      if (error.code === "QUOTA_EXCEEDED") throw error;
      const retryable = error.code === "TRACE_CONCURRENCY"
        || !error.status
        || error.status === 429
        || error.status >= 500;
      if (!retryable) throw error;
      if (error.status >= 500) traceUrl.searchParams.delete("anilistInfo");
      if (attempt < TRACE_SEARCH_RETRY_LIMIT - 1) {
        await delay(1000 * (2 ** attempt) + Math.round(Math.random() * 300));
      }
    }
  }

  const error = new Error(
    lastError instanceof TypeError
      ? "浏览器无法直连 trace.moe，请检查网络或其 CORS 服务状态"
      : `trace.moe 网络连接失败：${lastError?.message || "未知错误"}`,
  );
  error.code = "TRACE_NETWORK_ERROR";
  throw error;
}

async function classifyBrowserTraceLimit(error, externalSignal) {
  if (/concurrency/i.test(error.body || error.message || "")) {
    error.code = "TRACE_CONCURRENCY";
    error.message = "trace.moe 并发限制繁忙，稍后重试";
    return;
  }
  try {
    const response = await fetchWithBrowserTimeout(
      TRACE_MOE_ACCOUNT_URL,
      { method: "GET", mode: "cors", credentials: "omit" },
      10000,
      externalSignal,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const account = await response.json();
    const quota = Number(account?.quota);
    const quotaUsed = Number(account?.quotaUsed);
    const usage = Number.isFinite(quota) && Number.isFinite(quotaUsed)
      ? `${quotaUsed}/${quota}`
      : "未知";
    const depleted = Number.isFinite(quota) && Number.isFinite(quotaUsed)
      && (quota <= 0 || quotaUsed >= quota);
    error.code = depleted ? "QUOTA_EXCEEDED" : "TRACE_CONCURRENCY";
    error.message = depleted
      ? `你当前公网 IP 的 trace.moe 搜索额度已用完（${usage}）`
      : `你当前公网 IP 的 trace.moe 并发限制繁忙（额度 ${usage}），稍后重试`;
  } catch (diagnosticError) {
    error.code = "TRACE_CONCURRENCY";
    error.message = `trace.moe 返回 402，额度诊断失败：${diagnosticError.message}`;
  }
}

function selectBestTraceResult(traceData) {
  return (Array.isArray(traceData?.result) ? traceData.result : [])
    .filter((result) => result?.image)
    .filter((result) => result?.anilist?.isAdult !== true)
    .sort((left, right) => (Number(right.similarity) || 0) - (Number(left.similarity) || 0))[0] || null;
}

function isAllowedTraceInputUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (hostname === "sakugabooru.com" || hostname.endsWith(".sakugabooru.com"));
  } catch {
    return false;
  }
}

async function postJson(url, body, externalSignal) {
  const response = await fetchWithBrowserTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, REQUEST_TIMEOUT_MS, externalSignal);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.code = data?.code || null;
    throw error;
  }
  return data;
}

async function fetchWithBrowserTimeout(url, options, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function localizeFrameTitle(item, externalSignal) {
  const translation = item?.translation;
  const cacheKey = typeof translation?.cacheKey === "string" ? translation.cacheKey.trim() : "";
  const text = typeof translation?.text === "string" ? translation.text.trim() : "";
  if (!cacheKey || cacheKey.length > 1000 || !text || text.length > 500) return item;

  const cachedTitle = state.translationCache.get(cacheKey);
  if (cachedTitle) {
    state.translationCache.delete(cacheKey);
    state.translationCache.set(cacheKey, cachedTitle);
    item.title = cachedTitle;
    item.titleLanguage = "zh";
    item.titleSource = "browser-translation-cache";
    return item;
  }

  const canTranslate = state.serverDeepSeekApiKeySource === "environment"
    || (state.browserDeepSeekApiKey && state.deepSeekApiKeyValidationState === "valid");
  if (!canTranslate) return item;

  try {
    const response = await fetch("/api/deepseek/translate", {
      method: "POST",
      signal: externalSignal,
      headers: {
        "Content-Type": "application/json",
        ...buildDeepSeekRequestHeaders(),
      },
      body: JSON.stringify({
        text,
        sourceLanguage: translation.sourceLanguage,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    const translatedTitle = typeof data?.title === "string" ? data.title.trim() : "";
    if (!translatedTitle || translatedTitle.length > 200) return item;
    item.title = translatedTitle;
    item.titleLanguage = "zh";
    item.titleSource = "deepseek-translate";
    storeTranslation(cacheKey, translatedTitle);
  } catch (error) {
    if (error.name !== "AbortError") {
      console.warn(`[翻译] ${text} 翻译失败，继续使用回退标题：`, error.message);
    }
  }
  return item;
}

function getExcludedCopyrightTags() {
  const tags = new Set();

  const addItemTags = (item) => {
    for (const tag of getCopyrightTags(item)) {
      tags.add(tag);
      if (tags.size >= MAX_EXCLUDED_COPYRIGHT_TAGS) return;
    }
  };

  for (const favorite of state.favorites) {
    for (const tag of favorite.tags || []) {
      if (typeof tag !== "string" || !tag) continue;
      tags.add(tag);
      if (tags.size >= MAX_EXCLUDED_COPYRIGHT_TAGS) return [...tags];
    }
  }
  for (const answeredTags of state.recentAnsweredCopyrightTags) {
    for (const tag of answeredTags) {
      tags.add(tag);
      if (tags.size >= MAX_EXCLUDED_COPYRIGHT_TAGS) return [...tags];
    }
  }
  addItemTags(state.current);
  for (const item of state.pool) {
    addItemTags(item);
    if (tags.size >= MAX_EXCLUDED_COPYRIGHT_TAGS) break;
  }
  return [...tags];
}

function getCopyrightTags(item) {
  const tags = item?.sakugabooru?.copyrightTags || item?.copyrightTags;
  return Array.isArray(tags)
    ? tags.filter((tag) => typeof tag === "string" && tag)
    : [];
}

function hasCopyrightOverlap(item, excludedTags) {
  return getCopyrightTags(item).some((tag) => excludedTags.has(tag));
}

function hasDuplicate(item) {
  if (hasCopyrightOverlap(item, new Set(getExcludedCopyrightTags()))) {
    return true;
  }
  return state.pool.some((poolItem) => poolItem.id === item.id || poolItem.title === item.title);
}

function nextQuestion() {
  if (state.quotaExceeded && state.pool.length <= QUOTA_THRESHOLD) {
    state.current = null;
    state.locked = true;
    state.historyIndex = -1;
    updateUi();
    return;
  }

  if (!state.quotaExceeded && state.pool.length < MIN_READY_SIZE) {
    state.current = null;
    state.locked = true;
    state.historyIndex = -1;
    updateUi();
    return;
  }

  state.locked = false;
  state.historyIndex = -1;
  state.current = state.pool.shift();
  updateFavoriteButton();
  const wrongOptions = pickWrongOptions(state.current.title);
  renderQuestion(shuffle([state.current.title, ...wrongOptions]));
  updateUi();
  updateHistoryButtons();
}

function skipQuestion() {
  if (!state.current || state.locked) return;
  rememberAnsweredCopyrightTags(state.current);
  nextQuestion();
}

function pickWrongOptions(answer) {
  const answerKey = normalizeTitleForComparison(answer);
  const titlesByKey = new Map();
  const candidates = [
    ...state.pool.map((item) => item.title),
    ...state.titleBank,
    ...state.translationTitleBank,
  ];

  for (const title of candidates) {
    const titleKey = normalizeTitleForComparison(title);
    if (!titleKey || titleKey === answerKey || titlesByKey.has(titleKey)) continue;
    titlesByKey.set(titleKey, title);
  }
  return shuffle([...titlesByKey.values()]).slice(0, 3);
}

function normalizeTitleForComparison(title) {
  return typeof title === "string"
    ? title.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase()
    : "";
}

function renderQuestion(options) {
  state.current._options = [...options];
  els.feedback.textContent = "";
  els.feedback.classList.remove("correct", "wrong");
  els.options.innerHTML = "";
  els.animeFrame.src = state.current.image;
  els.animeFrame.style.display = "block";
  els.animeFrame.style.cursor = "pointer";
  els.animeFrame.onclick = () => openTraceSearch(state.current.traceImage || state.current.image);

  options.forEach((title) => {
    const button = document.createElement("button");
    button.className = "option";
    button.type = "button";
    button.textContent = title;
    button.addEventListener("click", () => answerQuestion(button, title));
    els.options.append(button);
  });
}

function answerQuestion(button, selectedTitle) {
  if (!state.current || state.locked) return;

  state.locked = true;
  const isCorrect = selectedTitle === state.current.title;
  state.answered += 1;
  if (isCorrect) state.correct += 1;
  rememberAnsweredCopyrightTags(state.current);

  const optionElements = [...els.options.children];
  optionElements.forEach((option) => {
    option.disabled = true;
    if (option.textContent === state.current.title) option.classList.add("correct");
  });

  if (!isCorrect) button.classList.add("wrong");
  els.feedback.classList.remove("correct", "wrong");
  els.feedback.classList.add(isCorrect ? "correct" : "wrong");
  els.feedback.textContent = isCorrect
    ? "回答正确，正在切换下一题..."
    : `回答错误，正确答案是：${state.current.title}`;

  saveHistory(selectedTitle, isCorrect);
  updateUi();
  updateHistoryButtons();
  state.nextQuestionTimerId = setTimeout(() => {
    state.nextQuestionTimerId = null;
    if (state.started) nextQuestion();
  }, 900);
}

function saveHistory(userAnswer, isCorrect) {
  const options = [...els.options.children].map((btn) => ({
    title: btn.textContent,
    isCorrect: btn.classList.contains("correct"),
    isUserChoice: btn.classList.contains("wrong") || (btn.classList.contains("correct") && userAnswer === btn.textContent),
  }));

  const historyItem = {
    image: state.current.image,
    traceImage: state.current.traceImage || state.current.image,
    title: state.current.title,
    copyrightTags: getCopyrightTags(state.current),
    userAnswer,
    isCorrect,
    options,
  };

  state.history.push(historyItem);
  if (state.history.length > MAX_HISTORY_SIZE) {
    state.history.shift();
  }
}

function updateHistoryButtons() {
  const isViewingHistory = state.historyIndex !== -1;
  const hasHistory = state.history.length > 0;

  const canGoPrev = hasHistory && (
    (!isViewingHistory) ||
    (isViewingHistory && state.historyIndex > 0)
  );

  const canGoNext = isViewingHistory;

  if (canGoPrev) {
    els.prevHistoryButton.classList.remove("hidden");
    els.prevHistoryButton.disabled = false;
  } else {
    els.prevHistoryButton.classList.add("hidden");
  }

  if (canGoNext) {
    els.nextHistoryButton.classList.remove("hidden");
    els.nextHistoryButton.disabled = false;
  } else {
    els.nextHistoryButton.classList.add("hidden");
  }
}

function showHistoryItem(index) {
  if (index < -1 || index >= state.history.length) return;

  state.historyIndex = index;

  if (index === -1) {
    renderCurrentQuestion();
  } else {
    const item = state.history[index];
    renderHistoryQuestion(item);
  }

  updateFavoriteButton();
  updateHistoryButtons();
}

function showPrevHistory() {
  if (state.historyIndex === -1) {
    showHistoryItem(state.history.length - 1);
  } else if (state.historyIndex > 0) {
    showHistoryItem(state.historyIndex - 1);
  }
}

function showNextHistory() {
  if (state.historyIndex === -1) return;
  if (state.historyIndex < state.history.length - 1) {
    showHistoryItem(state.historyIndex + 1);
  } else {
    showHistoryItem(-1);
  }
}

function renderHistoryQuestion(item) {
  els.animeFrame.src = item.image;
  els.animeFrame.style.display = "block";
  els.animeFrame.style.cursor = "pointer";
  els.animeFrame.onclick = () => openTraceSearch(item.traceImage);

  els.options.innerHTML = "";
  item.options.forEach((opt) => {
    const button = document.createElement("button");
    button.className = "option";
    button.type = "button";
    button.textContent = opt.title;
    button.disabled = true;
    if (opt.isCorrect) button.classList.add("correct");
    if (opt.isUserChoice && !opt.isCorrect) button.classList.add("wrong");
    els.options.append(button);
  });

  els.feedback.classList.remove("correct", "wrong");
  els.feedback.classList.add(item.isCorrect ? "correct" : "wrong");
  els.feedback.textContent = item.isCorrect
    ? "回答正确"
    : `回答错误，正确答案是：${item.title}`;
}

function renderCurrentQuestion() {
  if (!state.current) return;

  els.animeFrame.src = state.current.image;
  els.animeFrame.style.display = "block";
  els.animeFrame.style.cursor = "pointer";
  els.animeFrame.onclick = () => openTraceSearch(state.current.traceImage || state.current.image);

  els.options.innerHTML = "";
  const options = state.current._options || [];
  options.forEach((title) => {
    const button = document.createElement("button");
    button.className = "option";
    button.type = "button";
    button.textContent = title;
    button.disabled = state.locked;
    button.addEventListener("click", () => answerQuestion(button, title));
    els.options.append(button);
  });

  if (state.locked) {
    applyAnswerStateToOptions();
  } else {
    els.feedback.textContent = "";
    els.feedback.classList.remove("correct", "wrong");
  }
}

function applyAnswerStateToOptions() {
  const lastHistory = state.history[state.history.length - 1];
  if (!lastHistory) return;

  const buttons = els.options.children;
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    const opt = lastHistory.options.find((o) => o.title === btn.textContent);
    if (opt) {
      if (opt.isCorrect) btn.classList.add("correct");
      if (opt.isUserChoice && !opt.isCorrect) btn.classList.add("wrong");
    }
  }

  els.feedback.classList.remove("correct", "wrong");
  els.feedback.classList.add(lastHistory.isCorrect ? "correct" : "wrong");
  els.feedback.textContent = lastHistory.isCorrect
    ? "回答正确，正在切换下一题..."
    : `回答错误，正确答案是：${lastHistory.title}`;
}

function rememberAnsweredCopyrightTags(item) {
  state.recentAnsweredCopyrightTags.push([...new Set(getCopyrightTags(item))]);
  while (state.recentAnsweredCopyrightTags.length > RECENT_ANSWERED_QUESTION_LIMIT) {
    state.recentAnsweredCopyrightTags.shift();
  }

  const recentlyAnsweredTags = new Set(state.recentAnsweredCopyrightTags.flat());
  state.pool = state.pool.filter((poolItem) => (
    !hasCopyrightOverlap(poolItem, recentlyAnsweredTags)
  ));
}

function updateUi() {
  updateFavoriteButton();
  const ready = state.current && state.pool.length >= MIN_READY_SIZE - 1;
  const canAsk = state.current || state.pool.length >= MIN_READY_SIZE;
  const accuracy = state.answered ? Math.round((state.correct / state.answered) * 100) : 0;

  els.answeredCount.textContent = state.answered;
  els.accuracyRate.textContent = `${accuracy}%`;
  els.poolCount.textContent = `${state.pool.length}/${MAX_POOL_SIZE}`;
  els.skipButton.disabled = !state.current || state.locked;

  if (state.quotaExceeded && !state.current && state.pool.length <= QUOTA_THRESHOLD) {
    showQuotaError();
    return;
  }

  removeQuotaError();

  let statusText = "";

  if (state.quotaExceeded) {
    statusText = "API 配额已用完，继续使用剩余题库";
  }

  if (!canAsk) {
    clearQuestionDisplay();
    els.loadingLayer.classList.remove("hidden");
    els.loadingText.textContent = `正在准备题库：${state.pool.length}/${MIN_READY_SIZE}`;
    els.statusText.textContent = state.fetching ? "正在请求 API" : "等待题库";
    els.feedback.textContent = "";
    return;
  }

  els.loadingLayer.classList.toggle("hidden", Boolean(ready));
  els.loadingText.textContent = "题库不足，正在补充...";
  els.statusText.textContent = statusText || (state.fetching ? "后台补充题库中" : "请选择正确的动漫名称");
}

function showQuotaError() {
  clearQuestionDisplay();
  els.loadingLayer.classList.add("hidden");
  els.statusText.textContent = "API 配额已用完";
  els.skipButton.disabled = true;
  els.feedback.textContent = "";

  if (!document.querySelector(".quotaError")) {
    const errorEl = document.createElement("div");
    errorEl.className = "quotaError";
    errorEl.innerHTML = `
      <p class="quotaTitle">API 请求次数已达今日上限</p>
      <p class="quotaDesc"></p>
    `;
    errorEl.querySelector(".quotaDesc").textContent = state.quotaMessage
      || "你当前公网 IP 的 trace.moe 搜索额度已用完，请稍后再试。";
    els.framePanel.appendChild(errorEl);
  }
}

function clearQuestionDisplay() {
  els.options.innerHTML = "";
  els.animeFrame.removeAttribute("src");
  els.animeFrame.style.display = "none";
  els.animeFrame.style.cursor = "default";
  els.animeFrame.onclick = null;
}

function removeQuotaError() {
  const errorEl = document.querySelector(".quotaError");
  if (errorEl) errorEl.remove();
}

function openTraceSearch(imageUrl) {
  if (!imageUrl) return;
  window.open(
    `https://trace.moe/?url=${encodeURIComponent(imageUrl)}`,
    "_blank",
    "noopener,noreferrer",
  );
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
