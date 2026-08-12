"use strict";

const DATA_URL = "./data/anime-library.json";
// 旧版数据只在首次访问时下载一次作为新增统计基准，之后用 Cache API 保存上一版数据
const PREVIOUS_DATA_URL = "./data/anime-library-old.json";
const CACHE_NAME = "anime-library-cache-v1";
const CACHE_CURRENT_URL = new URL("./data/anime-library.json", location.href).href;
const CACHE_PREVIOUS_URL = new URL("./data/anime-library.previous.json", location.href).href;
const SEARCH_DELAY_MS = 120;
const MAX_TOP_TAGS = 18;
const MAX_ROW_TAGS = 4;
const MAX_TAG_SEARCH_RESULTS = 16;
const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);

const integerFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});
const titleCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

const state = {
  anime: [],
  filtered: [],
  overview: null,
  delta: null,
  yearStats: [],
  tags: [],
  selectedTags: [],
  page: 1,
  pageSize: 50,
  requestController: null,
  searchTimerId: null,
  chartFrameId: null,
  chartPositioned: false,
  chartHitAreas: [],
  dataVersion: "",
};

const els = {
  pageStatus: document.querySelector("#pageStatus"),
  loadStateTitle: document.querySelector("#loadStateTitle"),
  loadStateDetail: document.querySelector("#loadStateDetail"),
  retryButton: document.querySelector("#retryButton"),
  libraryContent: document.querySelector("#libraryContent"),
  datasetBadge: document.querySelector("#datasetBadge"),
  datasetVersion: document.querySelector("#datasetVersion"),
  animeTotal: document.querySelector("#animeTotal"),
  animeTotalDelta: document.querySelector("#animeTotalDelta"),
  imageTotal: document.querySelector("#imageTotal"),
  imageTotalDelta: document.querySelector("#imageTotalDelta"),
  doneTotal: document.querySelector("#doneTotal"),
  doneTotalDelta: document.querySelector("#doneTotalDelta"),
  ratingsTotal: document.querySelector("#ratingsTotal"),
  ratingsTotalDelta: document.querySelector("#ratingsTotalDelta"),
  scoreAverage: document.querySelector("#scoreAverage"),
  scoreAverageHint: document.querySelector("#scoreAverageHint"),
  tagTotal: document.querySelector("#tagTotal"),
  tagTotalDelta: document.querySelector("#tagTotalDelta"),
  chartViewport: document.querySelector("#chartViewport"),
  annualChart: document.querySelector("#annualChart"),
  chartTooltip: document.querySelector("#chartTooltip"),
  chartSummary: document.querySelector("#chartSummary"),
  topTags: document.querySelector("#topTags"),
  filterForm: document.querySelector("#filterForm"),
  titleSearch: document.querySelector("#titleSearch"),
  tagSearch: document.querySelector("#tagSearch"),
  tagSearchResults: document.querySelector("#tagSearchResults"),
  selectedCatalogTags: document.querySelector("#selectedCatalogTags"),
  tagModeFilter: document.querySelector("#tagModeFilter"),
  yearFilter: document.querySelector("#yearFilter"),
  scoreMin: document.querySelector("#scoreMin"),
  scoreMax: document.querySelector("#scoreMax"),
  scoreError: document.querySelector("#scoreError"),
  sortOrder: document.querySelector("#sortOrder"),
  pageSize: document.querySelector("#pageSize"),
  resetFilters: document.querySelector("#resetFilters"),
  resultSummary: document.querySelector("#resultSummary"),
  catalogBody: document.querySelector("#catalogBody"),
  previousPage: document.querySelector("#previousPage"),
  nextPage: document.querySelector("#nextPage"),
  pageNumbers: document.querySelector("#pageNumbers"),
};

initialize();

function initialize() {
  els.retryButton.addEventListener("click", loadLibrary);
  els.filterForm.addEventListener("submit", (event) => event.preventDefault());
  els.titleSearch.addEventListener("input", scheduleFilterUpdate);
  els.tagSearch.addEventListener("focus", renderTagSearchResults);
  els.tagSearch.addEventListener("input", renderTagSearchResults);
  els.tagSearchResults.addEventListener("click", chooseCatalogTag);
  els.selectedCatalogTags.addEventListener("click", removeCatalogTag);
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".tagSearchControl")) els.tagSearchResults.hidden = true;
  });
  els.tagModeFilter.addEventListener("click", toggleTagMode);
  els.scoreMin.addEventListener("input", scheduleFilterUpdate);
  els.scoreMax.addEventListener("input", scheduleFilterUpdate);
  els.yearFilter.addEventListener("change", updateFiltersImmediately);
  els.sortOrder.addEventListener("change", updateFiltersImmediately);
  els.pageSize.addEventListener("change", () => {
    const requestedSize = Number(els.pageSize.value);
    state.pageSize = ALLOWED_PAGE_SIZES.has(requestedSize) ? requestedSize : 50;
    state.page = 1;
    renderCatalogPage();
  });
  els.previousPage.addEventListener("click", () => goToPage(state.page - 1));
  els.nextPage.addEventListener("click", () => goToPage(state.page + 1));
  els.resetFilters.addEventListener("click", resetFilters);
  els.annualChart.addEventListener("pointermove", showChartTooltip);
  els.annualChart.addEventListener("pointerleave", hideChartTooltip);
  els.chartViewport.addEventListener("scroll", hideChartTooltip, { passive: true });

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleChartDraw);
    observer.observe(els.chartViewport);
  } else {
    window.addEventListener("resize", scheduleChartDraw, { passive: true });
  }

  void loadLibrary();
}

async function loadLibrary() {
  state.requestController?.abort();
  const controller = new AbortController();
  state.requestController = controller;

  // 先读 Cache API：命中则立即用缓存渲染，避免每次打开都等待网络
  const cached = await readCachedLibrary();
  if (cached.currentJson) {
    try {
      renderLibrary(cached.currentJson, cached.previousJson);
      els.pageStatus.hidden = true;
      els.libraryContent.hidden = false;
      requestAnimationFrame(scheduleChartDraw);
    } catch (error) {
      // 缓存数据异常（如损坏）时回退到网络加载，避免页面卡死且无兜底
      console.warn("缓存数据渲染失败，回退到网络加载：", error);
      cached.currentJson = null;
      cached.currentResponse = null;
      showLoadingState();
    }
  } else {
    showLoadingState();
  }

  try {
    const requestOptions = {
      signal: controller.signal,
      cache: "default",
      headers: { Accept: "application/json" },
    };

    // 首次访问（无缓存基准）时并行下载旧版数据作为新增统计基准，之后不再重复下载
    const firstVisit = !cached.currentJson;
    const oldFetch = firstVisit
      ? fetch(PREVIOUS_DATA_URL, requestOptions).catch(() => null)
      : Promise.resolve(null);

    const [response, oldResponse] = await Promise.all([
      fetch(DATA_URL, requestOptions),
      oldFetch,
    ]);
    if (controller.signal.aborted) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const [currentRaw, oldRaw] = await Promise.all([
      response.clone().json(),
      oldResponse?.ok ? oldResponse.clone().json().catch(() => null) : Promise.resolve(null),
    ]);
    if (controller.signal.aborted) return;

    // 写入缓存的上一版基准：首次访问用旧版数据，其余情况沿用上次访问缓存的版本
    let previousResponse = cached.currentResponse;
    if (firstVisit && oldRaw) previousResponse = oldResponse;

    // 后台刷新始终重新渲染以保持数据最新（含管理员启停变更），但保留用户筛选与页码；
    // 版本未变化时沿用缓存渲染的基准，避免新增角标在刷新后消失
    const version = normalizeVersion(currentRaw.version);
    const displayPreviousRaw = version !== state.dataVersion
      ? (cached.currentJson || oldRaw)
      : (cached.previousJson || oldRaw);

    renderLibrary(currentRaw, displayPreviousRaw, !firstVisit);

    await writeCachedLibrary(response, previousResponse);

    els.pageStatus.hidden = true;
    els.libraryContent.hidden = false;
    requestAnimationFrame(scheduleChartDraw);
  } catch (error) {
    if (error.name === "AbortError") return;
    if (cached.currentJson) {
      // 已有缓存内容时降级为后台刷新失败，不打断浏览
      console.warn("图库资源后台刷新失败，继续使用缓存数据：", error);
    } else {
      console.error("图库资源加载失败：", error);
      showErrorState(error);
    }
  } finally {
    if (state.requestController === controller) {
      state.requestController = null;
    }
  }
}

function renderLibrary(currentRaw, previousRaw, preserveView = false) {
  const library = normalizeLibrary(currentRaw);
  const previous = previousRaw ? normalizePreviousLibrary(previousRaw) : null;

  state.anime = library.anime;
  state.overview = calculateOverview(library.anime);
  state.delta = previous ? calculateDelta(library, previous) : null;
  state.yearStats = state.overview.yearStats;
  state.tags = state.overview.topTags.map(([name, animeCount]) => ({
    name,
    animeCount,
    searchName: normalizeSearchText(name),
  }));
  if (!preserveView) {
    state.selectedTags = [];
    state.chartPositioned = false;
    state.page = 1;
  }
  state.dataVersion = library.version;

  renderDatasetVersion(library.version);
  renderOverview();
  populateYearOptions();
  renderTopTags();
  renderSelectedCatalogTags();
  renderTagSearchResults();
  applyCatalogFilters(preserveView);
}

async function readCachedLibrary() {
  if (typeof caches === "undefined") {
    return { currentResponse: null, currentJson: null, previousJson: null };
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    const [currentResponse, previousResponse] = await Promise.all([
      cache.match(CACHE_CURRENT_URL),
      cache.match(CACHE_PREVIOUS_URL),
    ]);
    return {
      currentResponse,
      currentJson: currentResponse ? await currentResponse.clone().json() : null,
      previousJson: previousResponse ? await previousResponse.clone().json() : null,
    };
  } catch (error) {
    console.warn("图库缓存读取失败：", error);
    return { currentResponse: null, currentJson: null, previousJson: null };
  }
}

async function writeCachedLibrary(response, previousResponse) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    // 保存上一版数据，用于下次打开时计算新增统计
    if (previousResponse) await cache.put(CACHE_PREVIOUS_URL, previousResponse);
    await cache.put(CACHE_CURRENT_URL, response);
  } catch (error) {
    console.warn("图库缓存写入失败：", error);
  }
}

function showLoadingState() {
  els.libraryContent.hidden = true;
  els.datasetBadge.hidden = true;
  els.pageStatus.hidden = false;
  els.pageStatus.classList.remove("loadStateError");
  els.loadStateTitle.textContent = "正在加载图库统计";
  els.loadStateDetail.textContent = "首次访问需下载图库数据，之后打开将直接使用缓存，请稍候…";
  els.retryButton.hidden = true;
}

function showErrorState(error) {
  const missingFile = /HTTP 404/i.test(error.message);
  const invalidJson = error instanceof SyntaxError;
  els.libraryContent.hidden = true;
  els.datasetBadge.hidden = true;
  els.pageStatus.hidden = false;
  els.pageStatus.classList.add("loadStateError");
  els.loadStateTitle.textContent = "图库资源加载失败";
  if (missingFile) {
    els.loadStateDetail.textContent = "未找到 ./data/anime-library.json，请先运行资源精简脚本生成图库数据。";
  } else if (invalidJson) {
    els.loadStateDetail.textContent = "图库资源文件不是有效的 JSON，请重新生成后再试。";
  } else {
    els.loadStateDetail.textContent = `无法读取图库资源（${error.message || "未知错误"}），请检查文件后重试。`;
  }
  els.retryButton.hidden = false;
}

function normalizeLibrary(rawData) {
  if (!rawData || typeof rawData !== "object" || !Array.isArray(rawData.anime)) {
    throw new Error("数据结构无效：缺少 anime 数组");
  }

  const anime = rawData.anime
    .map((item, index) => normalizeAnime(item, index))
    .filter((item) => item !== null);
  if (anime.length === 0) {
    throw new Error("资源文件中没有包含截图的有效番剧");
  }

  return {
    version: normalizeVersion(rawData.version),
    imageBase: readText(rawData.imageBase, 1000),
    declaredTags: normalizeDeclaredTags(rawData.tags),
    anime,
  };
}

function normalizePreviousLibrary(rawData) {
  try {
    return normalizeLibrary(rawData);
  } catch (error) {
    console.warn("旧题库解析失败，跳过新增统计：", error);
    return null;
  }
}

function calculateDelta(current, previous) {
  if (!previous) return null;

  const previousAnimeByBgmId = new Map();
  const previousImageIds = new Set();
  const previousTagNames = new Set();
  for (const item of previous.anime) {
    previousAnimeByBgmId.set(item.bgmId, item);
    for (const imageId of item.imageIds) previousImageIds.add(imageId);
    for (const tag of item.allTags) previousTagNames.add(tag);
  }
  for (const tag of previous.declaredTags.keys()) previousTagNames.add(tag);

  const currentTagNames = new Set();
  let anime = 0;
  let image = 0;
  let done = 0;
  let rating = 0;

  for (const item of current.anime) {
    for (const tag of item.allTags) currentTagNames.add(tag);
    const previousItem = previousAnimeByBgmId.get(item.bgmId);
    if (!previousItem) {
      anime += 1;
      image += item.imageIds.length;
      done += item.doneCount;
      rating += item.ratingCount;
      continue;
    }
    for (const imageId of item.imageIds) {
      if (!previousImageIds.has(imageId)) image += 1;
    }
    done += Math.max(0, item.doneCount - previousItem.doneCount);
    rating += Math.max(0, item.ratingCount - previousItem.ratingCount);
  }
  for (const tag of current.declaredTags.keys()) currentTagNames.add(tag);

  let tag = 0;
  for (const name of currentTagNames) {
    if (!previousTagNames.has(name)) tag += 1;
  }

  return { anime, image, done, rating, tag };
}

function normalizeAnime(item, index) {
  if (!item || typeof item !== "object" || !Array.isArray(item.imageIds)) return null;
  // 管理员停用的番剧不参与图库展示与统计（enabled 缺失时视为启用，兼容旧数据）
  if (item.enabled === false) return null;

  const imageIds = new Set();
  for (const imageId of item.imageIds) {
    const normalizedId = readIdentifier(imageId);
    if (normalizedId) imageIds.add(normalizedId);
  }
  if (imageIds.size === 0) return null;

  const bgmId = readIdentifier(item.bgmId);
  const anidbId = readIdentifier(item.anidbId);
  const originalTitle = readText(item.originalTitle, 300);
  const title = readText(item.title, 300)
    || originalTitle
    || `未命名番剧 ${bgmId || anidbId || index + 1}`;
  const date = normalizeDate(item.date);
  const year = date ? date.slice(0, 4) : "";
  const tags = normalizeTagArray(item.tags);
  const metaTags = normalizeTagArray(item.metaTags);
  const allTags = [...new Set([...tags, ...metaTags])];
  const score = readNumber(item.score, 0, 10);
  const rank = readPositiveInteger(item.rank);
  const doneCount = readNonNegativeInteger(item.doneCount);
  const ratingCount = readNonNegativeInteger(item.ratingCount);
  const cover = normalizeCoverUrl(item.cover);

  return {
    _index: index,
    bgmId,
    anidbId,
    title,
    originalTitle: originalTitle === title ? "" : originalTitle,
    date,
    year,
    score,
    rank,
    doneCount,
    ratingCount,
    tags,
    metaTags,
    allTags,
    searchTags: new Set(allTags.map(normalizeSearchText)),
    imageIds: [...imageIds],
    imageCount: imageIds.size,
    cover,
    searchKey: normalizeSearchText([title, originalTitle, bgmId, anidbId].filter(Boolean).join(" ")),
  };
}

function normalizeCoverUrl(value) {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (/^\/data\/covers\/\d+\.(?:jpe?g|png|webp)$/i.test(url)) return url;
  return /^https:\/\/lain\.bgm\.tv\//i.test(url) ? url.slice(0, 500) : "";
}

function normalizeVersion(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return readText(value, 80) || "未标注";
}

function readText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function readIdentifier(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.trim().slice(0, 100);
  return "";
}

function readNumber(value, minimum, maximum) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function readPositiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function readNonNegativeInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function normalizeDate(value) {
  const text = readText(value, 40);
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(text);
  if (!match) return "";
  const year = Number(match[1]);
  if (year < 1900 || year > new Date().getFullYear() + 2) return "";
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;
  if (month !== null && (month < 1 || month > 12)) return String(year);
  if (day !== null && (day < 1 || day > 31)) return `${year}-${match[2]}`;
  return [match[1], match[2], match[3]].filter(Boolean).join("-");
}

function normalizeTagArray(value) {
  if (!Array.isArray(value)) return [];
  const result = new Set();
  for (const item of value) {
    const name = readTagName(item);
    if (name) result.add(name);
  }
  return [...result];
}

function normalizeDeclaredTags(value) {
  const tags = new Map();
  if (!Array.isArray(value)) return tags;
  for (const item of value) {
    const name = readTagName(item);
    if (!name) continue;
    const rawCount = item && typeof item === "object"
      ? (item.count ?? item.animeCount ?? item.total)
      : 0;
    const count = readNonNegativeInteger(rawCount);
    tags.set(name, Math.max(tags.get(name) || 0, count));
  }
  return tags;
}

function readTagName(value) {
  if (typeof value === "string") return readText(value, 100);
  if (!value || typeof value !== "object") return "";
  return readText(value.name ?? value.tag ?? value.title, 100);
}

function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function calculateOverview(anime) {
  let imageTotal = 0;
  let doneTotal = 0;
  let ratingsTotal = 0;
  let weightedScoreTotal = 0;
  let weightedScoreCount = 0;
  let unweightedScoreTotal = 0;
  let unweightedScoreCount = 0;
  const tagFrequency = new Map();
  const years = new Map();

  for (const item of anime) {
    imageTotal += item.imageCount;
    doneTotal += item.doneCount;
    ratingsTotal += item.ratingCount;

    if (item.score !== null) {
      unweightedScoreTotal += item.score;
      unweightedScoreCount += 1;
      if (item.ratingCount > 0) {
        weightedScoreTotal += item.score * item.ratingCount;
        weightedScoreCount += item.ratingCount;
      }
    }

    for (const tag of item.allTags) {
      tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
    }

    if (item.year) {
      const year = years.get(item.year) || { year: item.year, animeCount: 0, imageCount: 0 };
      year.animeCount += 1;
      year.imageCount += item.imageCount;
      years.set(item.year, year);
    }
  }

  const usesWeightedAverage = weightedScoreCount > 0;
  const averageScore = usesWeightedAverage
    ? weightedScoreTotal / weightedScoreCount
    : (unweightedScoreCount > 0 ? unweightedScoreTotal / unweightedScoreCount : null);
  const topTags = [...tagFrequency]
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || titleCollator.compare(left[0], right[0]));
  const yearStats = [...years.values()].sort((left, right) => Number(left.year) - Number(right.year));

  return {
    animeTotal: anime.length,
    imageTotal,
    doneTotal,
    ratingsTotal,
    averageScore,
    usesWeightedAverage,
    tagTotal: tagFrequency.size,
    topTags,
    yearStats,
  };
}

function renderDatasetVersion(version) {
  els.datasetVersion.textContent = version;
  els.datasetBadge.hidden = false;
}

function renderOverview() {
  const overview = state.overview;
  setMetric(els.animeTotal, overview.animeTotal);
  setMetric(els.imageTotal, overview.imageTotal);
  setMetric(els.doneTotal, overview.doneTotal);
  setMetric(els.ratingsTotal, overview.ratingsTotal);
  setMetric(els.tagTotal, overview.tagTotal);
  renderOverviewDelta();
  if (overview.averageScore === null) {
    els.scoreAverage.textContent = "—";
    els.scoreAverage.title = "没有可计算平均分的条目";
    els.scoreAverageHint.textContent = "暂无有效评分";
  } else {
    const score = overview.averageScore.toFixed(2);
    els.scoreAverage.textContent = score;
    els.scoreAverage.title = score;
    els.scoreAverageHint.textContent = overview.usesWeightedAverage ? "按评分人数加权" : "按有评分番剧平均";
  }
}

function renderOverviewDelta() {
  const delta = state.delta;
  setMetricDelta(els.animeTotalDelta, delta?.anime);
  setMetricDelta(els.imageTotalDelta, delta?.image);
  setMetricDelta(els.doneTotalDelta, delta?.done);
  setMetricDelta(els.ratingsTotalDelta, delta?.rating);
  setMetricDelta(els.tagTotalDelta, delta?.tag);
}

function setMetricDelta(element, value) {
  if (!element) return;
  if (value === null || value === undefined || value <= 0) {
    element.hidden = true;
    return;
  }
  const text = `+新增${integerFormatter.format(value)}`;
  element.textContent = text;
  element.title = text;
  element.hidden = false;
}

function setMetric(element, value) {
  const text = integerFormatter.format(value);
  element.textContent = text;
  element.title = text;
}

function populateYearOptions() {
  const options = document.createDocumentFragment();
  for (const item of [...state.yearStats].reverse()) {
    const option = document.createElement("option");
    option.value = item.year;
    option.textContent = `${item.year} 年（${integerFormatter.format(item.animeCount)} 部）`;
    options.append(option);
  }
  els.yearFilter.querySelectorAll("option:not(:first-child)").forEach((option) => option.remove());
  els.yearFilter.append(options);
}

function renderTopTags() {
  const fragment = document.createDocumentFragment();
  const tags = state.overview.topTags.slice(0, MAX_TOP_TAGS);
  if (tags.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tagsHint";
    empty.textContent = "资源文件中没有可展示的标签。";
    fragment.append(empty);
  } else {
    for (const [name, count] of tags) {
      const chip = document.createElement("span");
      chip.className = "tagChip";
      chip.tabIndex = 0;
      chip.setAttribute("role", "listitem");
      chip.title = `${name}：${integerFormatter.format(count)} 部番剧`;
      chip.setAttribute("aria-label", chip.title);
      const label = document.createElement("span");
      label.textContent = name;
      const value = document.createElement("strong");
      value.textContent = integerFormatter.format(count);
      chip.append(label, value);
      fragment.append(chip);
    }
  }
  els.topTags.replaceChildren(fragment);
}

function scheduleChartDraw() {
  if (state.chartFrameId !== null) cancelAnimationFrame(state.chartFrameId);
  state.chartFrameId = requestAnimationFrame(() => {
    state.chartFrameId = null;
    drawAnnualChart();
  });
}

function drawAnnualChart() {
  hideChartTooltip();
  state.chartHitAreas = [];
  if (els.libraryContent.hidden || !state.yearStats.length) {
    if (!state.yearStats.length && state.overview) {
      els.chartSummary.textContent = "没有包含有效首播年份的番剧，无法生成年度图表。";
      els.annualChart.setAttribute("aria-label", "没有可用于绘图的年度数据");
    }
    return;
  }

  const canvas = els.annualChart;
  const context = canvas.getContext("2d");
  if (!context) {
    els.chartSummary.textContent = "当前浏览器不支持 Canvas，无法绘制年度图表。";
    return;
  }

  const compact = window.matchMedia("(max-width: 640px)").matches;
  const cssHeight = compact ? 270 : 300;
  const viewportWidth = Math.max(280, els.chartViewport.clientWidth || 280);
  const cssWidth = Math.max(viewportWidth, state.yearStats.length * 48 + 108);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * pixelRatio);
  canvas.height = Math.round(cssHeight * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const colors = getComputedStyle(document.documentElement);
  const animeColor = colors.getPropertyValue("--accent").trim() || "#2477f2";
  const imageColor = colors.getPropertyValue("--violet").trim() || "#8b5cf6";
  const mutedColor = colors.getPropertyValue("--muted").trim() || "#667085";
  const lineColor = colors.getPropertyValue("--line").trim() || "#d9e0ea";
  const padding = { top: 18, right: 54, bottom: 56, left: 50 };
  const plotWidth = cssWidth - padding.left - padding.right;
  const plotHeight = cssHeight - padding.top - padding.bottom;
  const bottom = padding.top + plotHeight;
  const animeMax = niceCeiling(Math.max(...state.yearStats.map((item) => item.animeCount)));
  const imageMax = niceCeiling(Math.max(...state.yearStats.map((item) => item.imageCount)));
  const tickCount = 4;

  context.font = "10px Inter, system-ui, sans-serif";
  context.textBaseline = "middle";
  for (let tick = 0; tick <= tickCount; tick += 1) {
    const ratio = tick / tickCount;
    const y = bottom - ratio * plotHeight;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(cssWidth - padding.right, y);
    context.strokeStyle = tick === 0 ? "#cbd5e1" : lineColor;
    context.lineWidth = 1;
    context.stroke();

    context.fillStyle = mutedColor;
    context.textAlign = "right";
    context.fillText(integerFormatter.format(Math.round(animeMax * ratio)), padding.left - 8, y);
    context.textAlign = "left";
    context.fillText(integerFormatter.format(Math.round(imageMax * ratio)), cssWidth - padding.right + 8, y);
  }

  const step = plotWidth / state.yearStats.length;
  const barWidth = Math.max(9, Math.min(24, step * 0.48));
  for (let index = 0; index < state.yearStats.length; index += 1) {
    const item = state.yearStats[index];
    const x = padding.left + step * index + step / 2;
    const barHeight = (item.imageCount / imageMax) * plotHeight;
    context.globalAlpha = 0.28;
    context.fillStyle = imageColor;
    context.fillRect(x - barWidth / 2, bottom - barHeight, barWidth, barHeight);
    context.globalAlpha = 1;

    context.save();
    context.translate(x - 2, bottom + 10);
    context.rotate(-Math.PI / 4);
    context.fillStyle = mutedColor;
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(item.year, 0, 0);
    context.restore();
  }

  context.beginPath();
  for (let index = 0; index < state.yearStats.length; index += 1) {
    const item = state.yearStats[index];
    const x = padding.left + step * index + step / 2;
    const y = bottom - (item.animeCount / animeMax) * plotHeight;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.strokeStyle = animeColor;
  context.lineWidth = 2.2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  for (let index = 0; index < state.yearStats.length; index += 1) {
    const item = state.yearStats[index];
    const x = padding.left + step * index + step / 2;
    const y = bottom - (item.animeCount / animeMax) * plotHeight;
    state.chartHitAreas.push({ index, x, y, step });
    context.beginPath();
    context.arc(x, y, 4, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.lineWidth = 2.5;
    context.strokeStyle = animeColor;
    context.stroke();
  }

  const firstYear = state.yearStats[0].year;
  const lastYear = state.yearStats[state.yearStats.length - 1].year;
  const peakAnime = state.yearStats.reduce((best, item) => item.animeCount > best.animeCount ? item : best);
  const peakImages = state.yearStats.reduce((best, item) => item.imageCount > best.imageCount ? item : best);
  els.chartSummary.textContent = `${firstYear}–${lastYear} · 番剧收录峰值 ${peakAnime.year} 年（${integerFormatter.format(peakAnime.animeCount)} 部）· 截图峰值 ${peakImages.year} 年（${integerFormatter.format(peakImages.imageCount)} 张）`;
  canvas.setAttribute(
    "aria-label",
    `${firstYear} 至 ${lastYear} 年度资源图。蓝线为番剧数，紫色柱为截图数；番剧峰值为 ${peakAnime.year} 年 ${peakAnime.animeCount} 部，截图峰值为 ${peakImages.year} 年 ${peakImages.imageCount} 张。`,
  );
  if (!state.chartPositioned) {
    state.chartPositioned = true;
    requestAnimationFrame(() => {
      els.chartViewport.scrollLeft = Math.max(0, els.chartViewport.scrollWidth - els.chartViewport.clientWidth);
    });
  }
}

function showChartTooltip(event) {
  if (!state.chartHitAreas.length) return;
  const rect = els.annualChart.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  if (pointerY < 8 || pointerY > rect.height - 35) {
    hideChartTooltip();
    return;
  }
  const hit = state.chartHitAreas.reduce((nearest, candidate) => {
    const distance = Math.abs(pointerX - candidate.x);
    return !nearest || distance < nearest.distance ? { ...candidate, distance } : nearest;
  }, null);
  if (!hit || hit.distance > Math.max(18, hit.step / 2)) {
    hideChartTooltip();
    return;
  }
  const item = state.yearStats[hit.index];
  if (!item) return;
  els.chartTooltip.textContent = `${item.year} 年\n${integerFormatter.format(item.animeCount)} 部番剧 · ${integerFormatter.format(item.imageCount)} 张截图`;
  els.chartTooltip.style.left = `${hit.x}px`;
  els.chartTooltip.style.top = `${Math.max(76, hit.y)}px`;
  els.chartTooltip.hidden = false;
}

function hideChartTooltip() {
  els.chartTooltip.hidden = true;
}
function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * exponent;
}

function scheduleFilterUpdate() {
  if (state.searchTimerId !== null) clearTimeout(state.searchTimerId);
  state.searchTimerId = setTimeout(() => {
    state.searchTimerId = null;
    applyCatalogFilters();
  }, SEARCH_DELAY_MS);
}

function updateFiltersImmediately() {
  if (state.searchTimerId !== null) {
    clearTimeout(state.searchTimerId);
    state.searchTimerId = null;
  }
  applyCatalogFilters();
}

function toggleTagMode() {
  const nextMode = els.tagModeFilter.dataset.mode === "all" ? "any" : "all";
  els.tagModeFilter.dataset.mode = nextMode;
  els.tagModeFilter.textContent = nextMode === "all" ? "匹配全部" : "匹配任一";
  els.tagModeFilter.setAttribute("aria-pressed", String(nextMode === "all"));
  updateFiltersImmediately();
}

function resetFilters() {
  els.titleSearch.value = "";
  els.tagSearch.value = "";
  state.selectedTags = [];
  state.page = 1;
  state.pageSize = 50;
  els.tagModeFilter.dataset.mode = "any";
  els.tagModeFilter.textContent = "匹配任一";
  els.tagModeFilter.setAttribute("aria-pressed", "false");
  els.yearFilter.value = "";
  els.scoreMin.value = "";
  els.scoreMax.value = "";
  els.scoreError.textContent = "";
  els.sortOrder.value = "score-desc";
  els.pageSize.value = "50";
  els.tagSearchResults.hidden = true;
  renderSelectedCatalogTags();
  renderTagSearchResults();
  updateFiltersImmediately();
}

function renderTagSearchResults() {
  els.tagSearchResults.replaceChildren();
  const query = normalizeSearchText(els.tagSearch.value);
  if (Array.from(query).length < 2 || !state.tags.length) {
    els.tagSearchResults.hidden = true;
    return;
  }
  const selected = new Set(state.selectedTags);
  const matches = state.tags
    .filter((tag) => tag.searchName.includes(query) && !selected.has(tag.name))
    .sort((left, right) => {
      const leftStarts = left.searchName.startsWith(query) ? 1 : 0;
      const rightStarts = right.searchName.startsWith(query) ? 1 : 0;
      return rightStarts - leftStarts || right.animeCount - left.animeCount || titleCollator.compare(left.name, right.name);
    })
    .slice(0, MAX_TAG_SEARCH_RESULTS);
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.textContent = "没有匹配标签";
    els.tagSearchResults.append(empty);
  } else {
    for (const tag of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tag = tag.name;
      button.textContent = `${tag.name}（${integerFormatter.format(tag.animeCount)} 部）`;
      els.tagSearchResults.append(button);
    }
  }
  els.tagSearchResults.hidden = false;
}

function chooseCatalogTag(event) {
  const button = event.target.closest("button[data-tag]");
  if (!button || state.selectedTags.includes(button.dataset.tag)) return;
  state.selectedTags.push(button.dataset.tag);
  els.tagSearch.value = "";
  renderSelectedCatalogTags();
  renderTagSearchResults();
  updateFiltersImmediately();
  els.tagSearch.focus({ preventScroll: true });
}

function removeCatalogTag(event) {
  const button = event.target.closest("button[data-tag]");
  if (!button) return;
  state.selectedTags = state.selectedTags.filter((tag) => tag !== button.dataset.tag);
  renderSelectedCatalogTags();
  renderTagSearchResults();
  updateFiltersImmediately();
}

function renderSelectedCatalogTags() {
  els.selectedCatalogTags.replaceChildren();
  els.selectedCatalogTags.classList.toggle("isEmpty", !state.selectedTags.length);
  if (!state.selectedTags.length) {
    const empty = document.createElement("span");
    empty.textContent = "尚未选择标签";
    els.selectedCatalogTags.append(empty);
    return;
  }
  for (const tag of state.selectedTags) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tag = tag;
    button.textContent = `${tag} ×`;
    els.selectedCatalogTags.append(button);
  }
}

function applyCatalogFilters(preservePage = false) {
  const scoreRange = readScoreRange();
  if (!preservePage) state.page = 1;
  if (!scoreRange.valid) {
    state.filtered = [];
    renderCatalogPage("请先修正评分范围后查看结果。");
    return;
  }

  const searchTerm = normalizeSearchText(els.titleSearch.value);
  const year = els.yearFilter.value;
  const selectedTags = state.selectedTags.map(normalizeSearchText);
  const matchAllTags = els.tagModeFilter.dataset.mode === "all";
  const filtered = state.anime.filter((item) => {
    if (searchTerm && !item.searchKey.includes(searchTerm)) return false;
    if (year && item.year !== year) return false;
    if (scoreRange.minimum !== null && (item.score === null || item.score < scoreRange.minimum)) return false;
    if (scoreRange.maximum !== null && (item.score === null || item.score > scoreRange.maximum)) return false;
    if (selectedTags.length) {
      const matches = selectedTags.map((tag) => item.searchTags.has(tag));
      if (matchAllTags ? matches.some((match) => !match) : matches.every((match) => !match)) return false;
    }
    return true;
  });

  filtered.sort(getSortComparator(els.sortOrder.value));
  state.filtered = filtered;
  renderCatalogPage();
}

function readScoreRange() {
  const minimum = els.scoreMin.value === "" ? null : els.scoreMin.valueAsNumber;
  const maximum = els.scoreMax.value === "" ? null : els.scoreMax.valueAsNumber;
  let message = "";
  if ((minimum !== null && (!Number.isFinite(minimum) || minimum < 0 || minimum > 10))
    || (maximum !== null && (!Number.isFinite(maximum) || maximum < 0 || maximum > 10))) {
    message = "评分范围应在 0–10 之间。";
  } else if (minimum !== null && maximum !== null && minimum > maximum) {
    message = "最低评分不能高于最高评分。";
  }

  const valid = !message;
  els.scoreError.textContent = message;
  els.scoreMin.setAttribute("aria-invalid", String(!valid));
  els.scoreMax.setAttribute("aria-invalid", String(!valid));
  return { minimum, maximum, valid };
}

function getSortComparator(sortOrder) {
  switch (sortOrder) {
    case "score-desc":
      return (left, right) => compareOptional(left.score, right.score, -1) || compareDefault(left, right);
    case "done-desc":
      return (left, right) => right.doneCount - left.doneCount || compareDefault(left, right);
    case "ratings-desc":
      return (left, right) => right.ratingCount - left.ratingCount || compareDefault(left, right);
    case "date-desc":
      return (left, right) => compareOptional(left.date || null, right.date || null, -1) || compareDefault(left, right);
    case "date-asc":
      return (left, right) => compareOptional(left.date || null, right.date || null, 1) || compareDefault(left, right);
    case "rank-asc":
      return (left, right) => compareOptional(left.rank, right.rank, 1) || compareDefault(left, right);
    case "title-asc":
      return (left, right) => titleCollator.compare(left.title, right.title) || left._index - right._index;
    case "images-desc":
    default:
      return (left, right) => right.imageCount - left.imageCount || compareDefault(left, right);
  }
}

function compareOptional(left, right, direction) {
  const leftMissing = left === null || left === undefined || left === "";
  const rightMissing = right === null || right === undefined || right === "";
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right) * direction;
  }
  return (left - right) * direction;
}

function compareDefault(left, right) {
  return titleCollator.compare(left.title, right.title) || left._index - right._index;
}

function renderCatalogPage(emptyMessage = "") {
  const totalItems = state.filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageItems = state.filtered.slice(start, start + state.pageSize);
  renderCatalogRows(pageItems, emptyMessage);
  renderResultSummary(totalItems, totalPages);
  renderPagination(totalItems, totalPages);
}

function renderCatalogRows(items, emptyMessage) {
  const fragment = document.createDocumentFragment();
  if (items.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "emptyCell";
    cell.textContent = emptyMessage || "没有符合当前筛选条件的番剧。";
    row.append(cell);
    fragment.append(row);
    els.catalogBody.replaceChildren(fragment);
    return;
  }

  for (const item of items) {
    const row = document.createElement("tr");
    row.append(
      createTitleCell(item),
      createTextCell("首播", item.date || "—"),
      createValueCell("评分", item.score === null ? "—" : item.score.toFixed(1), "scoreValue"),
      createTextCell("排名", item.rank === null ? "—" : `#${integerFormatter.format(item.rank)}`),
      createTextCell("观看", integerFormatter.format(item.doneCount)),
      createTextCell("评分人数", integerFormatter.format(item.ratingCount)),
      createValueCell("截图", integerFormatter.format(item.imageCount), "imageValue"),
      createTagsCell(item.allTags),
    );
    fragment.append(row);
  }
  els.catalogBody.replaceChildren(fragment);
}

function createTitleCell(item) {
  const cell = document.createElement("td");
  cell.className = "titleCell";
  cell.dataset.label = "番剧";

  const layout = document.createElement("div");
  layout.className = "titleCellLayout";

  if (item.cover) {
    const thumb = document.createElement("img");
    thumb.className = "coverThumb";
    thumb.src = item.cover;
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.decoding = "async";
    thumb.referrerPolicy = "no-referrer";
    thumb.addEventListener("error", () => thumb.remove());
    layout.append(thumb);
  }

  const texts = document.createElement("div");
  texts.className = "titleCellTexts";

  const title = document.createElement("strong");
  title.textContent = item.title;
  title.title = item.title;
  texts.append(title);
  if (item.originalTitle) {
    const original = document.createElement("span");
    original.textContent = item.originalTitle;
    original.title = item.originalTitle;
    texts.append(original);
  }
  const ids = document.createElement("small");
  ids.textContent = `Bangumi ${item.bgmId || "—"} · AniDB ${item.anidbId || "—"}`;
  texts.append(ids);

  layout.append(texts);
  cell.append(layout);
  return cell;
}

function createTextCell(label, value) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  cell.textContent = value;
  return cell;
}

function createValueCell(label, value, className) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  const content = document.createElement("span");
  content.className = className;
  content.textContent = value;
  cell.append(content);
  return cell;
}

function createTagsCell(tags) {
  const cell = document.createElement("td");
  cell.className = "tagsCell";
  cell.dataset.label = "标签";
  if (!tags.length) {
    cell.textContent = "—";
    return cell;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "rowTags";
  for (const tag of tags.slice(0, MAX_ROW_TAGS)) {
    const chip = document.createElement("span");
    chip.className = "rowTag";
    chip.textContent = tag;
    chip.title = tag;
    wrapper.append(chip);
  }
  if (tags.length > MAX_ROW_TAGS) {
    const more = document.createElement("span");
    more.className = "rowTag rowTagMore";
    more.textContent = `+${tags.length - MAX_ROW_TAGS}`;
    more.title = tags.slice(MAX_ROW_TAGS).join("、");
    wrapper.append(more);
  }
  cell.append(wrapper);
  return cell;
}

function renderResultSummary(totalItems, totalPages) {
  const imageCount = state.filtered.reduce((total, item) => total + item.imageCount, 0);
  els.resultSummary.textContent = `符合条件 ${integerFormatter.format(totalItems)} 部 · ${integerFormatter.format(imageCount)} 张截图 · 第 ${state.page}/${totalPages} 页`;
}

function renderPagination(totalItems, totalPages) {
  els.previousPage.disabled = state.page <= 1 || totalItems === 0;
  els.nextPage.disabled = state.page >= totalPages || totalItems === 0;
  const fragment = document.createDocumentFragment();
  for (const token of buildPageTokens(state.page, totalPages)) {
    if (token === null) {
      const ellipsis = document.createElement("span");
      ellipsis.textContent = "…";
      ellipsis.setAttribute("aria-hidden", "true");
      fragment.append(ellipsis);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(token);
    button.setAttribute("aria-label", `第 ${token} 页`);
    if (token === state.page) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => goToPage(token));
    fragment.append(button);
  }
  els.pageNumbers.replaceChildren(fragment);
}

function buildPageTokens(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const pages = new Set([1, totalPages]);
  for (let page = currentPage - 2; page <= currentPage + 2; page += 1) {
    if (page > 1 && page < totalPages) pages.add(page);
  }
  const sorted = [...pages].sort((left, right) => left - right);
  const tokens = [];
  for (let index = 0; index < sorted.length; index += 1) {
    if (index > 0 && sorted[index] - sorted[index - 1] > 1) tokens.push(null);
    tokens.push(sorted[index]);
  }
  return tokens;
}

function goToPage(page) {
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  const nextPage = Math.min(Math.max(1, page), totalPages);
  if (nextPage === state.page) return;
  state.page = nextPage;
  renderCatalogPage();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelector("#catalogTitle").scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start",
  });
}
