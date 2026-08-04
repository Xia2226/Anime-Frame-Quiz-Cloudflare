import { GAME_CONFIG } from './js/game-config.js';
import { createLocalQuestionProvider, filterAnime, loadCatalog, searchTags } from './js/catalog.js';
import { HardQuestionProvider } from './js/hard-provider.js';
import { QuizEngine } from './js/quiz-engine.js';
import { getLeaderboard, normalizeUsername, readLeaderboardProfile, saveLeaderboardProfile, submitLeaderboardResult } from './js/leaderboard.js';

const HARD_KEY_STORAGE = 'anime-frame-quiz.deepseek-api-key.v2';
const GAME_GUIDE_STORAGE = 'anime-frame-quiz.game-guide-seen.v1';
const LOCAL_COUNT = GAME_CONFIG.localQuestionCount;
const LOCAL_MAX_SCORE = LOCAL_COUNT * Math.max(...GAME_CONFIG.scoreThresholds.map((tier) => tier.points));
const DEFAULT_FREE_FILTER = Object.freeze({
  titleQuery: '', startDate: '', endDate: '', minScore: null, maxScore: null,
  maxRank: null, minRatings: null, minDone: null, minImages: 1, tags: [], tagMode: 'any',
});
const MODE_META = {
  classic: { eyebrow: 'Classic Mode', title: '经典模式' },
  free: { eyebrow: 'Free Mode', title: '自由模式' },
  hard: { eyebrow: 'Hard Challenge', title: '困难挑战' },
};
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: GAME_CONFIG.leaderboard.timeZone,
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const state = {
  catalog: null, engine: null, provider: null, mode: null,
  launchToken: 0, imageToken: 0, hardValidationToken: 0,
  hardValidationController: null,
  leaderboardController: null, pendingResult: null, resultMode: null,
  homeLeaderboardController: null, homeLeaderboardMode: 'classic', homeLeaderboardCache: new Map(),
  gameGuideAutoShown: false,
  freeFilter: { ...DEFAULT_FREE_FILTER, tags: [] },
  draftTags: [], freeFilterInitial: false, freeEligible: [],
};
const ids = [
  'startScreen', 'gameScreen', 'classicModeButton', 'freeModeButton', 'startButton', 'gameGuideButton', 'homeLeaderboardButton',
  'backButton', 'gameModeLabel', 'gameTitle', 'freeFilterButton', 'finishHardButton',
  'progressValue', 'progressLabel', 'primaryMetric', 'primaryMetricLabel',
  'secondaryMetric', 'secondaryMetricLabel', 'timerStat', 'timerValue', 'poolStat',
  'poolCount', 'timerTrack', 'timerBar', 'loadingLayer', 'loadingText', 'animeFrame',
  'statusText', 'skipButton', 'options', 'feedback', 'hardApiModal', 'hardApiCloseButton',
  'hardApiForm', 'deepSeekApiKeyInput', 'hardApiMessage', 'hardApiConfirmButton',
  'homeLeaderboardModal', 'homeLeaderboardCloseButton', 'homeLeaderboardClassicTab',
  'homeLeaderboardHardTab', 'homeLeaderboardDay', 'homeLeaderboardStatus', 'homeLeaderboardBody',
  'gameGuideModal', 'gameGuideCloseButton',
  'freeFilterModal', 'freeFilterCloseButton', 'freeFilterForm', 'freeTitleQuery',
  'freeStartDate', 'freeEndDate', 'freeMinScore', 'freeMaxScore', 'freeMaxRank',
  'freeMinRatings', 'freeMinDone', 'freeMinImages', 'freeTagSearch', 'freeTagResults',
  'freeSelectedTags', 'freeMatchCount', 'freeFilterMessage', 'freeFilterResetButton',
  'freeFilterStartButton', 'profileModal', 'profileForm', 'profileUsername',
  'profileMessage', 'profileSkipButton', 'resultModal', 'resultTitle', 'resultLead',
  'resultMainValue', 'resultMainLabel', 'resultCorrectValue', 'resultElapsedValue',
  'leaderboardSection', 'leaderboardDay', 'leaderboardStatus', 'leaderboardBody',
  'resultReviewSection', 'resultReviewSummary', 'resultReviewList',
  'resultHomeButton', 'resultRefilterButton', 'resultReplayButton',
];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const missingIds = ids.filter((id) => !els[id]);
if (missingIds.length) throw new Error(`页面缺少必要元素：${missingIds.join(', ')}`);

bindEvents();
renderConfiguredCopy();
showHome();
maybeOpenGameGuide();

function renderConfiguredCopy() {
  const classicSummary = els.classicModeButton.querySelector('small');
  const hardSummary = els.startButton.querySelector('small');
  const classicIcon = els.classicModeButton.querySelector('.modeIcon');
  if (classicIcon) classicIcon.textContent = String(LOCAL_COUNT);
  if (classicSummary) {
    classicSummary.textContent = `随机 ${LOCAL_COUNT} 部番剧 · 每题 ${GAME_CONFIG.questionSeconds} 秒 · 满分 ${LOCAL_MAX_SCORE}`;
  }
  if (hardSummary) {
    hardSummary.textContent = `在线随机题源 · 不限时 · ${GAME_CONFIG.hard.minRankQuestions} 题后可结算`;
  }
  els.progressValue.textContent = `0 / ${LOCAL_COUNT}`;
  els.timerValue.textContent = GAME_CONFIG.questionSeconds.toFixed(1);
  els.poolCount.textContent = `0 / ${GAME_CONFIG.hard.batchSize}`;
  els.resultCorrectValue.textContent = `0 / ${LOCAL_COUNT}`;
}

function bindEvents() {
  els.classicModeButton.addEventListener('click', () => void beginClassic());
  els.freeModeButton.addEventListener('click', () => void beginFreeEntry());
  els.startButton.addEventListener('click', openHardModal);
  els.homeLeaderboardButton.addEventListener('click', openHomeLeaderboard);
  els.gameGuideButton.addEventListener('click', openGameGuide);
  els.backButton.addEventListener('click', showHome);
  els.skipButton.addEventListener('click', () => state.engine?.skip());
  els.finishHardButton.addEventListener('click', finishHardGame);
  els.freeFilterButton.addEventListener('click', restartFromFreeFilter);
  els.hardApiCloseButton.addEventListener('click', closeHardModal);
  els.hardApiForm.addEventListener('submit', validateAndBeginHard);
  els.hardApiModal.addEventListener('click', (event) => {
    if (event.target === els.hardApiModal) closeHardModal();
  });
  els.homeLeaderboardCloseButton.addEventListener('click', closeHomeLeaderboard);
  els.homeLeaderboardClassicTab.addEventListener('click', () => void selectHomeLeaderboardMode('classic'));
  els.homeLeaderboardHardTab.addEventListener('click', () => void selectHomeLeaderboardMode('hard'));
  els.homeLeaderboardModal.addEventListener('click', (event) => {
    if (event.target === els.homeLeaderboardModal) closeHomeLeaderboard();
  });
  els.gameGuideCloseButton.addEventListener('click', closeGameGuide);
  els.gameGuideModal.addEventListener('click', (event) => {
    if (event.target === els.gameGuideModal) closeGameGuide();
  });

  els.freeFilterCloseButton.addEventListener('click', closeFreeFilter);
  els.freeFilterResetButton.addEventListener('click', resetFreeFilter);
  els.freeFilterForm.addEventListener('input', updateFreeFilterPreview);
  els.freeFilterForm.addEventListener('submit', startFilteredGame);
  els.freeTagSearch.addEventListener('input', renderTagSearch);
  els.freeTagResults.addEventListener('click', chooseTag);
  els.freeSelectedTags.addEventListener('click', removeTag);
  els.freeFilterModal.addEventListener('click', (event) => {
    if (event.target === els.freeFilterModal) closeFreeFilter();
  });
  els.profileForm.addEventListener('submit', resolveProfile);
  els.profileSkipButton.addEventListener('click', skipProfile);
  els.resultHomeButton.addEventListener('click', showHome);
  els.resultReplayButton.addEventListener('click', replayResultMode);
  els.resultRefilterButton.addEventListener('click', () => void beginFreeEntry());
  document.addEventListener('keydown', handleKeyboard);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.engine?.syncTimer();
      if (state.mode === 'hard') void state.provider?.ensureFilled?.().catch(() => {});
    }
  });
}

function handleKeyboard(event) {
  if (event.key === 'Escape') {
    if (!els.hardApiModal.classList.contains('hidden')) closeHardModal();
    else if (!els.gameGuideModal.classList.contains('hidden')) closeGameGuide();
    else if (!els.homeLeaderboardModal.classList.contains('hidden')) closeHomeLeaderboard();
    else if (!els.freeFilterModal.classList.contains('hidden')) closeFreeFilter();
    return;
  }
  if (document.querySelector('.modal:not(.hidden)') || !state.engine) return;
  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    state.engine.skip();
    return;
  }
  const number = Number(event.key);
  if (number >= 1 && number <= 4) {
    const button = els.options.querySelectorAll('.optionButton')[number - 1];
    if (button && !button.disabled) {
      event.preventDefault();
      button.click();
    }
  }
}

function showHome() {
  state.launchToken += 1;
  stopGame();
  abortLeaderboard();
  abortHomeLeaderboard();
  state.mode = null;
  state.pendingResult = null;
  closeAllModals();
  els.gameScreen.classList.add('hidden');
  els.startScreen.classList.remove('hidden');
  document.body.classList.remove('gameActive', 'modalOpen');
}

function showGameShell(mode) {
  closeAllModals();
  state.mode = mode;
  els.startScreen.classList.add('hidden');
  els.gameScreen.classList.remove('hidden');
  document.body.classList.add('gameActive');
  const meta = MODE_META[mode];
  els.gameModeLabel.textContent = meta.eyebrow;
  els.gameTitle.textContent = meta.title;
  els.freeFilterButton.classList.toggle('hidden', mode !== 'free');
  els.finishHardButton.classList.toggle('hidden', mode !== 'hard');
  els.timerStat.classList.toggle('hidden', mode === 'hard');
  els.timerTrack.classList.toggle('hidden', mode === 'hard');
  els.poolStat.classList.toggle('hidden', mode !== 'hard');
  els.primaryMetricLabel.textContent = mode === 'hard' ? '正确率' : '得分';
  els.secondaryMetricLabel.textContent = mode === 'hard' ? '答对题数' : '正确率';
  els.progressLabel.textContent = mode === 'hard' ? '连续作答' : '进度';
  resetQuestionDisplay();
  updateStats(emptySnapshot(mode));
}

function stopGame() {
  state.imageToken += 1;
  state.engine?.stop();
  state.provider?.stop?.();
  state.engine = null;
  state.provider = null;
  els.animeFrame.onload = null;
  els.animeFrame.onerror = null;
}

function closeAllModals() {
  for (const modal of document.querySelectorAll('.modal')) modal.classList.add('hidden');
  document.body.classList.remove('modalOpen');
}

function openModal(element, focusTarget) {
  element.classList.remove('hidden');
  document.body.classList.add('modalOpen');
  window.setTimeout(() => focusTarget?.focus(), 0);
}

function closeModal(element) {
  element.classList.add('hidden');
  if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modalOpen');
}
function maybeOpenGameGuide() {
  if (state.gameGuideAutoShown) return;
  let alreadySeen = false;
  try {
    alreadySeen = localStorage.getItem(GAME_GUIDE_STORAGE) === '1';
  } catch {
    // Storage may be unavailable in privacy mode; the in-memory flag still prevents repeats.
  }
  if (alreadySeen) return;
  state.gameGuideAutoShown = true;
  try {
    localStorage.setItem(GAME_GUIDE_STORAGE, '1');
  } catch {
    // The guide can still be used without persistent storage.
  }
  openGameGuide();
}

function openGameGuide() {
  openModal(els.gameGuideModal, els.gameGuideCloseButton);
}

function closeGameGuide() {
  closeModal(els.gameGuideModal);
  if (!els.startScreen.classList.contains('hidden')) els.gameGuideButton.focus();
}



function openHomeLeaderboard() {
  state.homeLeaderboardCache.clear();
  openModal(els.homeLeaderboardModal, els.homeLeaderboardClassicTab);
  void selectHomeLeaderboardMode('classic');
}

function closeHomeLeaderboard() {
  abortHomeLeaderboard();
  closeModal(els.homeLeaderboardModal);
  els.homeLeaderboardButton.focus();
}

async function selectHomeLeaderboardMode(mode) {
  if (mode !== 'classic' && mode !== 'hard') return;
  state.homeLeaderboardMode = mode;
  for (const [button, buttonMode] of [
    [els.homeLeaderboardClassicTab, 'classic'],
    [els.homeLeaderboardHardTab, 'hard'],
  ]) {
    const active = buttonMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }

  abortHomeLeaderboard();
  els.homeLeaderboardBody.replaceChildren();
  els.homeLeaderboardDay.textContent = '';
  setFormMessage(els.homeLeaderboardStatus, '正在载入今日完整榜单…', 'loading');
  let requestController = null;
  try {
    let data = state.homeLeaderboardCache.get(mode);
    if (!data) {
      requestController = new AbortController();
      state.homeLeaderboardController = requestController;
      data = await getLeaderboard(mode, requestController.signal);
      state.homeLeaderboardCache.set(mode, data);
    }
    if (state.homeLeaderboardMode !== mode || els.homeLeaderboardModal.classList.contains('hidden')) return;
    els.homeLeaderboardDay.textContent = data.dayKey ? `${data.dayKey}（北京时间）` : '';
    renderLeaderboardRows(els.homeLeaderboardBody, data.entries, mode);
    setFormMessage(els.homeLeaderboardStatus, `共 ${data.entries.length} 位上榜用户`, 'success');
  } catch (error) {
    if (error.name !== 'AbortError' && state.homeLeaderboardMode === mode) {
      setFormMessage(els.homeLeaderboardStatus, error.message, 'error');
    }
  } finally {
    if (state.homeLeaderboardController === requestController) state.homeLeaderboardController = null;
  }
}

async function ensureCatalog() {
  if (!state.catalog) state.catalog = await loadCatalog();
  return state.catalog;
}

async function beginClassic() {
  const token = ++state.launchToken;
  stopGame();
  showGameShell('classic');
  setPreparing('正在载入精简题库…');
  try {
    const catalog = await ensureCatalog();
    if (token !== state.launchToken || state.mode !== 'classic') return;
    startLocalEngine('classic', catalog, filterAnime(catalog, {}));
  } catch (error) {
    if (token === state.launchToken) renderEngineError(error, () => void beginClassic());
  }
}

async function beginFreeEntry() {
  const token = ++state.launchToken;
  stopGame();
  showGameShell('free');
  state.freeFilterInitial = true;
  openFreeFilter(true);
  try {
    await ensureCatalog();
    if (token !== state.launchToken || state.mode !== 'free') return;
    updateFreeFilterPreview();
    renderTagSearch();
  } catch (error) {
    if (token === state.launchToken) {
      els.freeMatchCount.textContent = '题库载入失败';
      setFormMessage(els.freeFilterMessage, error.message, 'error');
    }
  }
}

async function startLocalEngine(mode, catalog, eligible) {
  const token = state.launchToken;
  stopGame();
  resetQuestionDisplay();
  let provider;
  try {
    provider = createLocalQuestionProvider(
      catalog,
      eligible,
      LOCAL_COUNT,
      GAME_CONFIG.localPreloadCount,
    );
  } catch (error) {
    renderEngineError(error, () => {
      state.launchToken += 1;
      void startLocalEngine(mode, catalog, eligible);
    });
    return;
  }

  state.provider = provider;
  setPreparing(`正在预加载前 ${provider.preloadCount} 道题截图…`);
  try {
    await provider.prepare();
    if (token !== state.launchToken || state.mode !== mode || state.provider !== provider) {
      provider.stop();
      return;
    }
    const engine = createEngine({ mode, provider, questionLimit: LOCAL_COUNT, timed: true });
    state.engine = engine;
    await engine.start();
  } catch (error) {
    provider.stop();
    if (state.provider === provider) state.provider = null;
    if (token !== state.launchToken || state.mode !== mode || error.name === 'AbortError') return;
    renderEngineError(error, () => {
      state.launchToken += 1;
      void startLocalEngine(mode, catalog, eligible);
    });
  }
}

function openHardModal() {
  state.hardValidationToken += 1;
  els.deepSeekApiKeyInput.value = readHardKey();
  els.deepSeekApiKeyInput.disabled = false;
  els.hardApiConfirmButton.disabled = false;
  setFormMessage(els.hardApiMessage, '需验证模型权限，余额须大于 ¥1。', '');
  openModal(els.hardApiModal, els.deepSeekApiKeyInput);
}

function closeHardModal() {
  state.hardValidationToken += 1;
  state.hardValidationController?.abort();
  state.hardValidationController = null;
  closeModal(els.hardApiModal);
  els.startButton.focus();
}

async function validateAndBeginHard(event) {
  event.preventDefault();
  const apiKey = els.deepSeekApiKeyInput.value.trim();
  if (!apiKey) {
    setFormMessage(els.hardApiMessage, 'API Key 为必填项。', 'error');
    els.deepSeekApiKeyInput.focus();
    return;
  }
  const validationToken = ++state.hardValidationToken;
  els.deepSeekApiKeyInput.disabled = true;
  els.hardApiConfirmButton.disabled = true;
  setFormMessage(els.hardApiMessage, '正在校验模型权限与人民币余额…', 'loading');
  try {
    const data = await validateHardKey(apiKey);
    if (validationToken !== state.hardValidationToken) return;
    const balance = Number(data?.balance);
    if (data?.valid !== true || !Number.isFinite(balance) || balance <= 1) {
      throw new Error(data?.message || '人民币余额必须严格大于 1 元。');
    }
    writeHardKey(apiKey);
    closeModal(els.hardApiModal);
    await beginHard(apiKey);
  } catch (error) {
    if (validationToken !== state.hardValidationToken) return;
    setFormMessage(els.hardApiMessage, error.message, 'error');
  } finally {
    if (validationToken === state.hardValidationToken) {
      els.deepSeekApiKeyInput.disabled = false;
      els.hardApiConfirmButton.disabled = false;
    }
  }
}

async function validateHardKey(apiKey) {
  const controller = new AbortController();
  state.hardValidationController = controller;
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/deepseek/validate', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'X-DeepSeek-Api-Key': apiKey, Accept: 'application/json' },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || data?.message || `校验失败（HTTP ${response.status}）`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('校验超时，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
    if (state.hardValidationController === controller) state.hardValidationController = null;
  }
}

async function beginHard(apiKey) {
  const token = ++state.launchToken;
  stopGame();
  showGameShell('hard');
  setPreparing('正在载入精简标题库…');
  try {
    const catalog = await ensureCatalog();
    if (token !== state.launchToken || state.mode !== 'hard') return;
    const provider = new HardQuestionProvider({
      apiKey, catalog, batchSize: GAME_CONFIG.hard.batchSize,
      onBufferChange: (count) => {
        if (state.provider === provider) els.poolCount.textContent = `${count} / ${GAME_CONFIG.hard.batchSize}`;
      },
    });
    state.provider = provider;
    state.engine = createEngine({ mode: 'hard', provider, questionLimit: null, timed: false });
    await state.engine.start();
  } catch (error) {
    if (token === state.launchToken) renderEngineError(error, () => void beginHard(apiKey));
  }
}

function finishHardGame() {
  const snapshot = state.engine?.snapshot();
  if (state.mode === 'hard' && snapshot?.answered >= GAME_CONFIG.hard.minRankQuestions) state.engine.finish();
}

function createEngine({ mode, provider, questionLimit, timed }) {
  return new QuizEngine({
    mode, provider, questionLimit, timed,
    questionSeconds: GAME_CONFIG.questionSeconds,
    scoreTiers: GAME_CONFIG.scoreThresholds,
    feedbackMs: GAME_CONFIG.answerFeedbackMs,
    callbacks: {
      onLoading: (snapshot) => {
        if (mode === 'hard' || !els.animeFrame.currentSrc) {
          setPreparing(mode === 'hard' ? '正在准备在线题目…' : '正在显示首题…');
        }
        updateStats(snapshot);
      },
      onQuestion: async (question, snapshot) => {
        await showDecodedQuestionImage(question);
        renderOptions(question);
        els.loadingLayer.classList.add('hidden');
        els.statusText.textContent = `第 ${snapshot.answered + 1} 题`;
        els.feedback.textContent = '';
      },
      onState: updateStats,
      onTimer: updateTimer,
      onFeedback: renderFeedback,
      onComplete: (result) => void completeGame(result),
      onError: renderEngineError,
    },
  });
}

async function showDecodedQuestionImage(question) {
  const token = ++state.imageToken;
  const candidates = [...new Set([
    question.imageUrl,
    ...(Array.isArray(question.imageCandidates) ? question.imageCandidates : []),
  ].filter((url) => typeof url === 'string' && url))];
  let lastError = null;
  for (const url of candidates) {
    if (token !== state.imageToken) throw new DOMException('图片加载已取消', 'AbortError');
    try {
      await loadAndDecodeInto(els.animeFrame, url, token);
      question.imageUrl = url;
      question.preloadedImage = null;
      return url;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('这道题没有可用截图。');
}

async function loadAndDecodeInto(image, url, token) {
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('截图加载失败，正在轮换候选图片。'));
    image.src = url;
  });
  if (token !== state.imageToken) throw new DOMException('图片加载已取消', 'AbortError');
  if (typeof image.decode === 'function') {
    try {
      await image.decode();
    } catch {
      throw new Error('截图解码失败，正在轮换候选图片。');
    }
  }
  if (token !== state.imageToken) throw new DOMException('图片加载已取消', 'AbortError');
  image.onload = null;
  image.onerror = null;
}

function renderOptions(question) {
  els.options.replaceChildren();
  question.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'optionButton';
    button.dataset.optionId = String(option.id);
    const key = document.createElement('span');
    key.className = 'optionKey';
    key.textContent = String(index + 1);
    const title = document.createElement('span');
    title.textContent = option.title;
    button.append(key, title);
    button.disabled = true;
    button.addEventListener('click', () => state.engine?.answer(option.id));
    els.options.append(button);
  });
}

function renderFeedback(answer) {
  for (const button of els.options.querySelectorAll('.optionButton')) {
    button.disabled = true;
    if (button.dataset.optionId === answer.answerId) button.classList.add('correct');
    if (answer.selectedId && button.dataset.optionId === answer.selectedId && !answer.isCorrect) button.classList.add('wrong');
  }
  if (answer.isCorrect) {
    els.feedback.className = 'feedback success';
    els.feedback.textContent = state.mode === 'hard' ? '回答正确' : `回答正确，+${answer.points} 分`;
  } else {
    const prefix = answer.reason === 'timeout' ? '时间到' : answer.reason === 'skip' ? '已跳过' : '回答错误';
    els.feedback.className = 'feedback error';
    els.feedback.textContent = `${prefix}，正确答案：${answer.question.title}`;
  }
}

function renderEngineError(error, retryAction = null) {
  if (error?.name === 'AbortError') return;
  els.loadingLayer.classList.remove('hidden');
  els.loadingText.textContent = error?.message || '题目加载失败';
  els.statusText.textContent = '暂时无法载入题目';
  els.feedback.className = 'feedback error';
  els.feedback.textContent = '可重试；返回首页不会提交本局记录。';
  els.options.replaceChildren();
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'primaryButton fullWidth';
  retry.textContent = '重试加载';
  retry.addEventListener('click', () => {
    if (typeof retryAction === 'function') retryAction();
    else void state.engine?.retry();
  });
  els.options.append(retry);
  els.skipButton.disabled = true;
}

function setPreparing(message) {
  els.loadingLayer.classList.remove('hidden');
  els.loadingText.textContent = message;
  els.options.replaceChildren();
  els.feedback.textContent = '';
  els.feedback.className = 'feedback';
  els.statusText.textContent = '正在准备';
  els.skipButton.disabled = true;
}

function resetQuestionDisplay() {
  state.imageToken += 1;
  els.animeFrame.removeAttribute('src');
  els.timerValue.textContent = GAME_CONFIG.questionSeconds.toFixed(1);
  els.timerBar.style.transform = 'scaleX(1)';
  els.timerTrack.classList.remove('urgent');
  setPreparing('正在准备题目…');
}

function updateStats(snapshot) {
  if (!snapshot || snapshot.mode !== state.mode) return;
  const percent = Math.round(snapshot.accuracy * 100);
  if (state.mode === 'hard') {
    els.progressValue.textContent = `${snapshot.answered} 题`;
    els.primaryMetric.textContent = `${percent}%`;
    els.secondaryMetric.textContent = `${snapshot.correct} 题`;
    els.poolCount.textContent = `${snapshot.bufferedCount} / ${GAME_CONFIG.hard.batchSize}`;
    els.finishHardButton.disabled = snapshot.answered < GAME_CONFIG.hard.minRankQuestions;
    els.finishHardButton.textContent = snapshot.answered < GAME_CONFIG.hard.minRankQuestions
      ? `答满 ${GAME_CONFIG.hard.minRankQuestions} 题后结算` : '结束并结算';
  } else {
    els.progressValue.textContent = `${Math.min(snapshot.answered, LOCAL_COUNT)} / ${LOCAL_COUNT}`;
    els.primaryMetric.textContent = String(snapshot.score);
    els.secondaryMetric.textContent = `${percent}%`;
  }
  const canAnswer = !snapshot.loading && !snapshot.locked && Boolean(snapshot.current);
  els.skipButton.disabled = !canAnswer;
  for (const button of els.options.querySelectorAll('.optionButton')) button.disabled = !canAnswer;
}

function updateTimer(remainingMs, ratio) {
  els.timerValue.textContent = (remainingMs / 1000).toFixed(1);
  els.timerBar.style.transform = `scaleX(${Math.max(0, ratio)})`;
  els.timerTrack.classList.toggle('urgent', remainingMs <= 2000);
}

function emptySnapshot(mode) {
  return { mode, answered: 0, correct: 0, accuracy: 0, score: 0, bufferedCount: 0, loading: true, locked: true, current: null };
}

function openFreeFilter(initial) {
  state.freeFilterInitial = initial;
  state.draftTags = [...state.freeFilter.tags];
  populateFreeFilter(state.freeFilter);
  renderSelectedTags();
  els.freeTagSearch.value = '';
  els.freeTagResults.replaceChildren();
  els.freeTagResults.classList.add('hidden');
  updateFreeFilterPreview();
  openModal(els.freeFilterModal, els.freeTitleQuery);
}

function restartFromFreeFilter() {
  state.launchToken += 1;
  stopGame();
  setPreparing('请确认新的筛选条件…');
  openFreeFilter(false);
}

function closeFreeFilter() {
  closeModal(els.freeFilterModal);
  if (state.freeFilterInitial) {
    showHome();
    return;
  }
  state.launchToken += 1;
  startLocalEngine('free', state.catalog, filterAnime(state.catalog, state.freeFilter));
}

function populateFreeFilter(filter) {
  els.freeTitleQuery.value = filter.titleQuery || '';
  els.freeStartDate.value = filter.startDate || '';
  els.freeEndDate.value = filter.endDate || '';
  writeOptionalInput(els.freeMinScore, filter.minScore);
  writeOptionalInput(els.freeMaxScore, filter.maxScore);
  writeOptionalInput(els.freeMaxRank, filter.maxRank);
  writeOptionalInput(els.freeMinRatings, filter.minRatings);
  writeOptionalInput(els.freeMinDone, filter.minDone);
  els.freeMinImages.value = String(filter.minImages || 1);
  const mode = filter.tagMode === 'all' ? 'all' : 'any';
  const radio = els.freeFilterForm.querySelector(`input[name='freeTagMode'][value='${mode}']`);
  if (radio) radio.checked = true;
}

function resetFreeFilter() {
  state.draftTags = [];
  populateFreeFilter(DEFAULT_FREE_FILTER);
  els.freeTagSearch.value = '';
  renderSelectedTags();
  renderTagSearch();
  updateFreeFilterPreview();
}

function readFreeFilter() {
  return {
    titleQuery: els.freeTitleQuery.value.trim(),
    startDate: els.freeStartDate.value,
    endDate: els.freeEndDate.value,
    minScore: readOptionalNumber(els.freeMinScore),
    maxScore: readOptionalNumber(els.freeMaxScore),
    maxRank: readOptionalNumber(els.freeMaxRank),
    minRatings: readOptionalNumber(els.freeMinRatings),
    minDone: readOptionalNumber(els.freeMinDone),
    minImages: readOptionalNumber(els.freeMinImages) ?? 1,
    tags: [...state.draftTags],
    tagMode: els.freeFilterForm.querySelector(`input[name='freeTagMode']:checked`)?.value || 'any',
  };
}

function validateFreeFilter(filter) {
  if (!els.freeFilterForm.checkValidity()) return '请检查数字范围与必填项。';
  if (filter.startDate && filter.endDate && filter.startDate > filter.endDate) return '起始日期不能晚于结束日期。';
  if (filter.minScore !== null && filter.maxScore !== null && filter.minScore > filter.maxScore) return '最低评分不能高于最高评分。';
  return '';
}

function updateFreeFilterPreview() {
  if (!state.catalog) {
    els.freeMatchCount.textContent = '正在载入精简题库…';
    els.freeFilterStartButton.disabled = true;
    return;
  }
  const filter = readFreeFilter();
  const error = validateFreeFilter(filter);
  if (error) {
    state.freeEligible = [];
    els.freeMatchCount.textContent = '当前条件无效';
    els.freeFilterStartButton.disabled = true;
    setFormMessage(els.freeFilterMessage, error, 'error');
    return;
  }
  state.freeEligible = filterAnime(state.catalog, filter);
  const enough = state.freeEligible.length >= LOCAL_COUNT;
  els.freeMatchCount.textContent = `匹配 ${state.freeEligible.length} 部有截图番剧`;
  els.freeFilterStartButton.disabled = !enough;
  setFormMessage(
    els.freeFilterMessage,
    enough ? `将从匹配结果中无放回抽取 ${LOCAL_COUNT} 部番剧。` : `至少需要 ${LOCAL_COUNT} 部，请放宽筛选条件。`,
    enough ? 'success' : 'error',
  );
}

function startFilteredGame(event) {
  event.preventDefault();
  updateFreeFilterPreview();
  if (els.freeFilterStartButton.disabled || state.freeEligible.length < LOCAL_COUNT) return;
  const filter = readFreeFilter();
  state.freeFilter = { ...filter, tags: [...filter.tags] };
  state.freeFilterInitial = false;
  closeModal(els.freeFilterModal);
  state.launchToken += 1;
  startLocalEngine('free', state.catalog, state.freeEligible);
}

function renderTagSearch() {
  els.freeTagResults.replaceChildren();
  if (!state.catalog || Array.from(els.freeTagSearch.value.trim()).length < 2) {
    els.freeTagResults.classList.add('hidden');
    return;
  }
  const selected = new Set(state.draftTags);
  const matches = searchTags(state.catalog, els.freeTagSearch.value, 16).filter((item) => !selected.has(item.name));
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.textContent = '没有匹配标签';
    els.freeTagResults.append(empty);
  } else {
    for (const item of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tag = item.name;
      button.textContent = `${item.name}（${item.animeCount} 部）`;
      els.freeTagResults.append(button);
    }
  }
  els.freeTagResults.classList.remove('hidden');
}

function chooseTag(event) {
  const button = event.target.closest('button[data-tag]');
  if (!button || state.draftTags.includes(button.dataset.tag)) return;
  state.draftTags.push(button.dataset.tag);
  renderSelectedTags();
  renderTagSearch();
  updateFreeFilterPreview();
}

function removeTag(event) {
  const button = event.target.closest('button[data-tag]');
  if (!button) return;
  state.draftTags = state.draftTags.filter((tag) => tag !== button.dataset.tag);
  renderSelectedTags();
  renderTagSearch();
  updateFreeFilterPreview();
}

function renderSelectedTags() {
  els.freeSelectedTags.replaceChildren();
  if (!state.draftTags.length) {
    const empty = document.createElement('span');
    empty.className = 'emptyTags';
    empty.textContent = '尚未选择标签';
    els.freeSelectedTags.append(empty);
    return;
  }
  for (const tag of state.draftTags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.dataset.tag = tag;
    chip.textContent = `${tag} ×`;
    els.freeSelectedTags.append(chip);
  }
}

async function completeGame(result) {
  if (result.mode !== state.mode) return;
  state.pendingResult = result;
  state.resultMode = result.mode;
  const ranked = result.mode === 'classic'
    || (result.mode === 'hard' && result.answered >= GAME_CONFIG.hard.minRankQuestions);
  if (ranked && !readLeaderboardProfile().resolved) {
    els.profileUsername.value = '';
    els.profileMessage.textContent = '';
    openModal(els.profileModal, els.profileUsername);
    return;
  }
  await finalizeResult(result, ranked);
}

function resolveProfile(event) {
  event.preventDefault();
  saveLeaderboardProfile(normalizeUsername(els.profileUsername.value));
  closeModal(els.profileModal);
  if (state.pendingResult) void finalizeResult(state.pendingResult, true);
}

function skipProfile() {
  saveLeaderboardProfile('');
  closeModal(els.profileModal);
  if (state.pendingResult) void finalizeResult(state.pendingResult, true);
}

async function finalizeResult(result, ranked) {
  state.pendingResult = null;
  els.resultTitle.textContent = result.mode === 'hard' ? '困难挑战结算' : result.mode === 'free' ? '自由练习完成' : '经典挑战完成';
  els.resultLead.textContent = result.mode === 'hard'
    ? `连续完成 ${result.answered} 道题，已满足排行榜最低题数。` : `完整完成 ${LOCAL_COUNT} 道题，本局成绩有效。`;
  const accuracy = Math.round(result.accuracy * 10000) / 100;
  els.resultMainValue.textContent = result.mode === 'hard' ? `${accuracy}%` : `${result.score} / ${LOCAL_MAX_SCORE}`;
  els.resultMainLabel.textContent = result.mode === 'hard' ? '正确率' : '总分';
  els.resultCorrectValue.textContent = `${result.correct} / ${result.answered}`;
  els.resultElapsedValue.textContent = formatDuration(result.elapsedMs);
  renderResultReview(result.answers);
  els.resultRefilterButton.classList.toggle('hidden', result.mode !== 'free');
  els.leaderboardSection.classList.toggle('hidden', !ranked);
  openModal(els.resultModal, els.resultReplayButton);
  if (!ranked) return;

  abortLeaderboard();
  state.leaderboardController = new AbortController();
  els.leaderboardBody.replaceChildren();
  els.leaderboardDay.textContent = '';
  setFormMessage(els.leaderboardStatus, '正在同步今日最佳成绩…', 'loading');
  try {
    const profile = readLeaderboardProfile();
    const data = profile.username
      ? await submitLeaderboardResult(result, state.leaderboardController.signal)
      : await getLeaderboard(result.mode, state.leaderboardController.signal);
    renderLeaderboard(data, result.mode);
    const status = profile.username
      ? data.personalBest?.rank
        ? `你的今日最佳排名：#${data.personalBest.rank}`
        : '成绩已记录；服务器仅保留你今天最好的一局。'
      : '本会话未填写用户名，仅查看榜单。';
    setFormMessage(els.leaderboardStatus, status, 'success');
  } catch (error) {
    if (error.name !== 'AbortError') setFormMessage(els.leaderboardStatus, error.message, 'error');
  }
}

function renderLeaderboard(data, mode) {
  els.leaderboardDay.textContent = data.dayKey ? `${data.dayKey}（北京时间）` : '';
  renderLeaderboardRows(els.leaderboardBody, data.entries, mode);
}

function renderLeaderboardRows(body, entries, mode) {
  body.replaceChildren();
  if (!entries.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = '今天还没有上榜记录';
    row.append(cell);
    body.append(row);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('tr');
    const accuracy = Number.isFinite(Number(entry.accuracy))
      ? Number(entry.accuracy) : Number(entry.accuracyPpm || 0) / 10000;
    const values = [
      entry.rank ? `#${entry.rank}` : '—',
      entry.username || '—',
      mode === 'hard' ? `${accuracy.toFixed(2)}%` : `${entry.score} 分`,
      `${entry.correctCount} / ${entry.questionCount}`,
      formatDuration(entry.elapsedMs),
      formatCompletedAt(entry.completedAt),
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}

function renderResultReview(answers) {
  const records = Array.isArray(answers) ? answers : [];
  els.resultReviewSection.classList.toggle('hidden', records.length === 0);
  els.resultReviewList.replaceChildren();
  els.resultReviewSummary.textContent = records.length ? `共 ${records.length} 道，标签最多展示 5 个` : '';
  if (!records.length) return;

  const fragment = document.createDocumentFragment();
  records.forEach((record, index) => {
    const question = record?.question || {};
    const card = document.createElement('article');
    card.className = 'reviewCard';
    const image = document.createElement('img');
    image.className = 'reviewImage';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.alt = `第 ${index + 1} 题截图`;
    const imageUrl = question.imageUrl || question.imageCandidates?.[0] || '';
    if (imageUrl) image.src = imageUrl;

    const copy = document.createElement('div');
    copy.className = 'reviewCopy';
    const title = document.createElement('strong');
    title.textContent = question.title || '未知番剧';
    title.title = title.textContent;
    const meta = document.createElement('div');
    meta.className = 'reviewMeta';
    const number = document.createElement('span');
    number.textContent = `第 ${index + 1} 题`;
    const result = document.createElement('span');
    result.className = `reviewResult ${record.isCorrect ? 'correct' : 'wrong'}`;
    result.textContent = record.isCorrect ? `答对${record.points ? ` +${record.points}` : ''}` : '答错';
    meta.append(number, result);

    const tags = [...new Set([
      ...(Array.isArray(question.tags) ? question.tags : []),
      ...(Array.isArray(question.copyrightTags) ? question.copyrightTags : []),
    ])].slice(0, 5);
    const tagList = document.createElement('div');
    tagList.className = 'reviewTags';
    if (!tags.length) {
      const empty = document.createElement('span');
      empty.className = 'emptyReviewTag';
      empty.textContent = '暂无标签';
      tagList.append(empty);
    } else {
      for (const tag of tags) {
        const chip = document.createElement('span');
        chip.textContent = tag;
        tagList.append(chip);
      }
    }
    copy.append(title, meta, tagList);
    card.append(image, copy);
    fragment.append(card);
  });
  els.resultReviewList.append(fragment);
}

function replayResultMode() {
  const mode = state.resultMode;
  closeModal(els.resultModal);
  if (mode === 'classic') void beginClassic();
  else if (mode === 'free') {
    state.launchToken += 1;
    startLocalEngine('free', state.catalog, filterAnime(state.catalog, state.freeFilter));
  } else {
    showHome();
    openHardModal();
  }
}

function abortLeaderboard() {
  state.leaderboardController?.abort();
  state.leaderboardController = null;
}

function abortHomeLeaderboard() {
  state.homeLeaderboardController?.abort();
  state.homeLeaderboardController = null;
}

function setFormMessage(element, message, kind) {
  element.textContent = message;
  if (kind) element.dataset.state = kind;
  else delete element.dataset.state;
}

function readOptionalNumber(input) {
  return input.value === '' || !Number.isFinite(input.valueAsNumber) ? null : input.valueAsNumber;
}

function writeOptionalInput(input, value) {
  input.value = Number.isFinite(value) ? String(value) : '';
}

function readHardKey() {
  try {
    return sessionStorage.getItem(HARD_KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

function writeHardKey(value) {
  try {
    sessionStorage.setItem(HARD_KEY_STORAGE, value);
  } catch {
    // The validated key remains available in the form for this page lifetime.
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatCompletedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date);
}
