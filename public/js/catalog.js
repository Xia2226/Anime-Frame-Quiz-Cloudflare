const CATALOG_URL = new URL("../data/anime-library.json", import.meta.url);

// 图片加载超时与候选图之间的节流延时：避免对图源（fancaps CDN）发起过快的连续请求
const IMAGE_TIMEOUT_MS = 5000;
const IMAGE_RETRY_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let catalogPromise = null;

export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(CATALOG_URL, {
      cache: "default",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`题库加载失败（HTTP ${response.status}）`);
        return response.json();
      })
      .then(normalizeCatalog)
      .catch((error) => {
        catalogPromise = null;
        throw error;
      });
  }
  return catalogPromise;
}

export function filterAnime(catalog, filter = {}) {
  const titleQuery = normalizeSearchText(filter.titleQuery);
  const selectedTags = Array.isArray(filter.tags)
    ? filter.tags.map(normalizeSearchText).filter(Boolean)
    : [];
  const matchAllTags = filter.tagMode !== "any";
  const startDate = normalizeDateBoundary(filter.startDate, "0000-00-00");
  const endDate = normalizeDateBoundary(filter.endDate, "9999-99-99");
  const minScore = finiteOr(filter.minScore, 0);
  const maxScore = finiteOr(filter.maxScore, 10);
  const maxRank = finiteOr(filter.maxRank, Number.POSITIVE_INFINITY);
  const minRatings = finiteOr(filter.minRatings, 0);
  const minDone = finiteOr(filter.minDone, 0);
  const minImages = finiteOr(filter.minImages, 1);

  return catalog.anime.filter((anime) => {
    if (anime.enabled === false) return false;
    if (anime.nsfw) return false;
    const date = anime.date || "0000-00-00";
    if (date < startDate || date > endDate) return false;
    if (anime.score !== null && (anime.score < minScore || anime.score > maxScore)) return false;
    if (anime.score === null && (minScore > 0 || maxScore < 10)) return false;
    if (Number.isFinite(maxRank) && (!anime.rank || anime.rank > maxRank)) return false;
    if (anime.ratingCount < minRatings || anime.doneCount < minDone || anime.imageIds.length < minImages) return false;
    if (titleQuery && !anime.searchTitle.includes(titleQuery)) return false;
    if (selectedTags.length > 0) {
      const matches = selectedTags.map((tag) => anime.searchTags.has(tag));
      if (matchAllTags ? matches.some((match) => !match) : matches.every((match) => !match)) return false;
    }
    return true;
  });
}

export function searchTags(catalog, query, limit = 12) {
  const normalized = normalizeSearchText(query);
  if ([...normalized].length < 2) return [];
  return catalog.tags
    .filter((tag) => tag.searchName.includes(normalized))
    .sort((left, right) => {
      const leftStarts = left.searchName.startsWith(normalized) ? 1 : 0;
      const rightStarts = right.searchName.startsWith(normalized) ? 1 : 0;
      return rightStarts - leftStarts || right.animeCount - left.animeCount || left.name.localeCompare(right.name, "zh-CN");
    })
    .slice(0, limit);
}

export function createLocalQuestionProvider(catalog, eligibleAnime, questionCount, preloadCount = 5) {
  if (eligibleAnime.length < questionCount) {
    throw new Error(`当前筛选仅有 ${eligibleAnime.length} 部番剧，至少需要 ${questionCount} 部`);
  }
  const selected = sampleWithoutReplacement(eligibleAnime, questionCount);
  const titlePool = eligibleAnime.length >= 4 ? eligibleAnime : catalog.anime;
  const questions = selected.map((anime) => ({
    id: `catalog-${anime.anidbId}`,
    answerId: String(anime.anidbId),
    title: anime.title,
    originalTitle: anime.originalTitle,
    imageCandidates: shuffle(anime.imageIds).map((imageId) => `${catalog.imageBase}${imageId}.jpg`),
    options: buildOptions(anime, titlePool),
    tags: [...anime.tags],
    source: "fancaps",
  }));
  const bufferSize = Math.min(
    questionCount,
    Number.isSafeInteger(preloadCount) && preloadCount > 0 ? preloadCount : 5,
  );
  const preloadTasks = new Map();
  let index = 0;
  let stopped = false;

  function preloadAt(targetIndex) {
    if (stopped || targetIndex < 0 || targetIndex >= questions.length) return Promise.resolve(null);
    const question = questions[targetIndex];
    if (question.imageUrl) return Promise.resolve(question);
    if (!preloadTasks.has(targetIndex)) {
      const task = preloadQuestionImage(question, () => stopped)
        .finally(() => preloadTasks.delete(targetIndex));
      preloadTasks.set(targetIndex, task);
    }
    return preloadTasks.get(targetIndex);
  }

  async function fillWindow() {
    if (stopped) return;
    const tasks = [];
    const end = Math.min(questions.length, index + bufferSize);
    for (let targetIndex = index; targetIndex < end; targetIndex += 1) {
      tasks.push(preloadAt(targetIndex));
    }
    await Promise.all(tasks);
    if (stopped) throw new DOMException("图片预加载已取消", "AbortError");
  }

  return {
    preloadCount: bufferSize,
    async prepare() {
      await fillWindow();
    },
    async next() {
      if (stopped) return null;
      await preloadAt(index);
      if (stopped) return null;
      const question = questions[index++] || null;
      void fillWindow().catch((error) => {
        if (!stopped && error.name !== "AbortError") {
          console.warn("后台截图预加载失败，将在出题时重试：", error.message);
        }
      });
      return question;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      preloadTasks.clear();
      for (const question of questions) question.preloadedImage = null;
    },
    get bufferedCount() {
      return questions
        .slice(index, Math.min(questions.length, index + bufferSize))
        .filter((question) => Boolean(question.imageUrl))
        .length;
    },
  };
}

async function preloadQuestionImage(question, isStopped) {
  const candidates = Array.isArray(question.imageCandidates) ? question.imageCandidates : [];
  if (candidates.length === 0) throw new Error("这道题没有可用截图。");
  if (typeof Image !== "function") {
    question.imageUrl = candidates[0];
    return question;
  }

  let lastError = null;
  for (const url of candidates) {
    if (isStopped()) throw new DOMException("图片预加载已取消", "AbortError");
    try {
      const image = await loadPreloadedImage(url);
      if (isStopped()) throw new DOMException("图片预加载已取消", "AbortError");
      question.imageUrl = url;
      question.preloadedImage = image;
      return question;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      // 候选图之间稍作停顿，避免对图源发起过快的连续请求
      await delay(IMAGE_RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error("这道题的截图均无法加载。");
}

async function loadPreloadedImage(url) {
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.decoding = "async";
  await new Promise((resolve, reject) => {
    // 单张图加载超时保护，避免连接挂起时无限等待
    const timer = window.setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      reject(new Error("截图预加载超时"));
    }, IMAGE_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("截图预加载失败"));
    };
    image.src = url;
  });
  image.onload = null;
  image.onerror = null;
  if (typeof image.decode === "function") await image.decode();
  return image;
}

export function buildOptions(answer, titlePool) {
  const answerTitleKey = normalizeSearchText(answer.title);
  const candidates = new Map();
  for (const item of shuffle(titlePool)) {
    const titleKey = normalizeSearchText(item.title);
    if (!titleKey || titleKey === answerTitleKey || String(item.anidbId) === String(answer.anidbId)) continue;
    if (!candidates.has(titleKey)) candidates.set(titleKey, item);
    if (candidates.size >= 3) break;
  }
  if (candidates.size < 3) throw new Error("题库中没有足够的唯一错误选项");
  return shuffle([
    { id: String(answer.anidbId), title: answer.title },
    ...[...candidates.values()].map((item) => ({ id: String(item.anidbId), title: item.title })),
  ]);
}

export function normalizeSearchText(value) {
  return typeof value === "string"
    ? value.trim().normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("zh-CN")
    : "";
}

function normalizeCatalog(value) {
  if (!Array.isArray(value?.anime) || typeof value?.imageBase !== "string") {
    throw new Error("精简题库格式不兼容，请重新运行 npm run build:data");
  }
  const anime = value.anime.map((item) => {
    const tags = [...new Set([...(item.tags || []), ...(item.metaTags || [])].filter((tag) => typeof tag === "string" && tag))];
    return {
      ...item,
      anidbId: String(item.anidbId),
      title: String(item.title || "").trim(),
      originalTitle: String(item.originalTitle || "").trim(),
      score: Number.isFinite(item.score) ? item.score : null,
      rank: Number.isFinite(item.rank) ? item.rank : null,
      doneCount: Number.isFinite(item.doneCount) ? item.doneCount : 0,
      ratingCount: Number.isFinite(item.ratingCount) ? item.ratingCount : 0,
      imageIds: Array.isArray(item.imageIds) ? item.imageIds.filter(Number.isFinite) : [],
      tags,
      searchTitle: normalizeSearchText(`${item.title || ""} ${item.originalTitle || ""}`),
      searchTags: new Set(tags.map(normalizeSearchText)),
    };
  }).filter((item) => item.title && item.imageIds.length > 0);
  const tags = Array.isArray(value.tags)
    ? value.tags.map((tag) => typeof tag === "string" ? { name: tag, animeCount: 0 } : tag)
      .filter((tag) => tag && typeof tag.name === "string")
      .map((tag) => ({ ...tag, searchName: normalizeSearchText(tag.name) }))
    : [];
  if (anime.length < 50) throw new Error("精简题库少于 50 部有截图番剧，无法开始游戏");
  return { ...value, anime, tags };
}

function sampleWithoutReplacement(items, count) {
  const copy = [...items];
  for (let index = 0; index < count; index += 1) {
    const swapIndex = index + Math.floor(Math.random() * (copy.length - index));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, count);
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function finiteOr(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDateBoundary(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : fallback;
}
