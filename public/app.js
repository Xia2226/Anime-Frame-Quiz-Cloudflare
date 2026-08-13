import { GAME_CONFIG } from './js/game-config.js';
import { createLocalQuestionProvider, filterAnime, loadCatalog, searchTags } from './js/catalog.js';
import { HardQuestionProvider, clearExcludedTags } from './js/hard-provider.js';
import { QuizEngine } from './js/quiz-engine.js';
import { getLeaderboard, normalizeUsername, readLeaderboardProfile, saveLeaderboardProfile, submitLeaderboardResult } from './js/leaderboard.js';

const HARD_KEY_STORAGE = 'anime-frame-quiz.deepseek-api-key.v2';
const GAME_GUIDE_STORAGE = 'anime-frame-quiz.game-guide-seen.v1';
const FLAG_STORAGE_KEY = 'anime-frame-quiz.flagged-questions.v1';
const ANNOUNCEMENTS_CLOSED_KEY = 'anime-frame-quiz.closed-announcements.v1';
const FLAG_CONTENT_MAX_LENGTH = 1900;
const LOCAL_COUNT = GAME_CONFIG.localQuestionCount;
// 图片加载超时与候选图之间的节流延时：避免对图源（fancaps CDN）发起过快的连续请求
const IMAGE_TIMEOUT_MS = 5000;
const IMAGE_RETRY_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOCAL_MAX_SCORE = LOCAL_COUNT * Math.max(...GAME_CONFIG.scoreThresholds.map((tier) => tier.points));
const FREE_QUESTION_OPTIONS = Object.freeze([25, 50, 75, 100]);
const DEFAULT_FREE_FILTER = Object.freeze({
  startDate: '', endDate: '', minScore: null, maxScore: null,
  maxRank: null, minRatings: null, minDone: null, minImages: 1, tags: [], tagMode: 'any',
  timed: true, questionCount: LOCAL_COUNT,
});
const MODE_META = {
  classic: { eyebrow: 'Classic Mode', title: '经典模式' },
  free: { eyebrow: 'Free Mode', title: '自由模式' },
  hard: { eyebrow: 'Hard Challenge', title: '困难挑战' },
};
const DEBUG = {
  // 调试开关：为 true 时，对应模式中会显示"一键完成 50 题"按钮，点击直接弹出结算弹窗。
  // 发布前请改为 false，按钮将不显示、也无法触发。
  classicFastFinishEnabled: false,
  freeFastFinishEnabled: false,
  hardFastFinishEnabled: false,
};
const FEEDBACK_TYPE_META = Object.freeze({
  anime_error: Object.freeze({
    label: '番剧错误',
    placeholder: '请描述图片中的番剧名称与系统给出的答案…',
  }),
  bug: Object.freeze({
    label: 'BUG反馈',
    placeholder: '请描述复现步骤与遇到的问题…',
  }),
  feature: Object.freeze({
    label: '项目功能',
    placeholder: '请描述你希望新增或改进的功能与使用场景…',
  }),
  other: Object.freeze({
    label: '其他',
    placeholder: '请在这里填写你的意见或建议…',
  }),
});
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: GAME_CONFIG.leaderboard.timeZone,
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
// 公告时间：在默认格式基础上补充年份（仅后两位，如「26/08/12 14:30」）
const announcementTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: GAME_CONFIG.leaderboard.timeZone,
  year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
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
  flaggedQuestions: readFlaggedSet(),
  flagAnchor: null, flagContextKey: null, flagSubmitting: false,
};
const ids = [
  'startScreen', 'gameScreen', 'announcementsBar', 'announcementsButton',
  'announcementsModal', 'announcementsCloseButton', 'announcementsList', 'announcementsDetail',
  'classicModeButton', 'freeModeButton', 'startButton', 'gameGuideButton', 'homeLeaderboardButton',
  'feedbackFab', 'feedbackModal', 'feedbackCloseButton', 'feedbackForm',
  'feedbackContent', 'feedbackMessage', 'feedbackSubmitButton', 'feedbackCancelButton',
  'backButton', 'gameModeLabel', 'gameTitle', 'debugFinishButton', 'freeFilterButton',
  'progressValue', 'progressLabel', 'primaryMetric', 'primaryMetricLabel',
  'secondaryMetric', 'secondaryMetricLabel', 'timerStat', 'timerValue', 'poolStat',
  'poolCount', 'hardHint', 'timerTrack', 'timerBar', 'loadingLayer', 'loadingText', 'animeFrame', 'framePanel',
  'statusText', 'skipButton', 'options', 'feedback', 'hardApiModal', 'hardApiCloseButton',
  'flagQuestionButton', 'flagPopover', 'flagContext', 'flagNote', 'flagMessage',
  'flagSubmitButton', 'flagCancelButton',
  'hardApiForm', 'deepSeekApiKeyInput', 'hardApiMessage', 'hardApiConfirmButton',
  'homeLeaderboardModal', 'homeLeaderboardCloseButton', 'homeLeaderboardClassicTab',
  'homeLeaderboardHardTab', 'homeLeaderboardDay', 'homeLeaderboardStatus', 'homeLeaderboardBody',
  'gameGuideModal', 'gameGuideCloseButton',
  'freeFilterModal', 'freeFilterCloseButton', 'freeFilterForm',
  'freeStartDate', 'freeEndDate', 'freeMinScore', 'freeMaxScore', 'freeMaxRank',
  'freeMinRatings', 'freeMinDone', 'freeMinImages', 'freeTagMode', 'freeTagSearch', 'freeTagResults',
  'freeSelectedTags', 'freeMatchCount', 'freeFilterMessage', 'freeFilterResetButton',
  'freeFilterStartButton', 'freeTimed', 'freeQuestionCount', 'profileModal', 'profileForm', 'profileUsername',
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
void loadAnnouncements();
maybeOpenGameGuide();

function renderConfiguredCopy() {
  const classicSummary = els.classicModeButton.querySelector('small');
  const hardSummary = els.startButton.querySelector('small');
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

// ---------- 站内公告 ----------

let announcementItems = [];

async function loadAnnouncements() {
  try {
    const response = await fetch('/api/announcements', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const data = await response.json();
    announcementItems = Array.isArray(data?.items) ? data.items : [];
    renderAnnouncements(announcementItems);
    // 公告弹窗打开且停留在列表视图时同步刷新，保证内容最新
    const listVisible = !els.announcementsModal.classList.contains('hidden')
      && els.announcementsDetail.classList.contains('hidden');
    if (listVisible) renderAnnouncementsList();
  } catch {
    // 公告加载失败不影响主流程，保持横幅隐藏
  }
}

// 首页公告：以独立悬浮图层展示置顶公告，其余公告通过「公告」按钮查看
// 用户叉掉的公告记录在 sessionStorage：只要不关闭网站，刷新页面后不再展示
function readClosedAnnouncements() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(ANNOUNCEMENTS_CLOSED_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeClosedAnnouncements(ids) {
  try {
    sessionStorage.setItem(ANNOUNCEMENTS_CLOSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 存储失败不影响本次关闭操作
  }
}

function renderAnnouncements(items) {
  const closedIds = readClosedAnnouncements();
  const pinnedItems = items
    .filter((item) => item.pinned)
    .filter((item) => !closedIds.has(String(item.id)));
  // 与全站约定一致：用 .hidden 类控制显隐（元素初始带该类的 HTML 标记）
  els.announcementsBar.classList.toggle('hidden', pinnedItems.length === 0);
  if (!pinnedItems.length) return;
  els.announcementsBar.replaceChildren();
  for (const item of pinnedItems) {
    const card = document.createElement('article');
    card.className = 'announcementCard announcementCardPinned';

    const title = document.createElement('strong');
    title.className = 'announcementTitle';
    title.append(document.createTextNode(item.title));
    title.title = item.title;
    const badge = document.createElement('span');
    badge.className = 'announcementBadge';
    badge.textContent = '置顶';
    title.append(badge);

    const content = document.createElement('p');
    content.className = 'announcementContent';
    content.textContent = item.content;

    const time = document.createElement('time');
    time.className = 'announcementTime';
    time.dateTime = new Date(item.createdAt).toISOString();
    time.textContent = announcementTimeFormatter.format(new Date(item.createdAt));

    // 首页悬浮卡片右上角关闭按钮：点击后仅关闭该条公告的首页展示
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'announcementCloseButton';
    closeButton.setAttribute('aria-label', `关闭公告「${item.title}」`);
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => {
      const ids = readClosedAnnouncements();
      ids.add(String(item.id));
      writeClosedAnnouncements(ids);
      card.remove();
      if (!els.announcementsBar.children.length) els.announcementsBar.classList.add('hidden');
    });

    card.append(title, content, time, closeButton);
    els.announcementsBar.append(card);
  }
}

function openAnnouncements() {
  renderAnnouncementsList();
  openModal(els.announcementsModal, els.announcementsCloseButton);
  // 打开时拉取一次最新公告
  void loadAnnouncements();
}

function closeAnnouncements() {
  closeModal(els.announcementsModal);
  if (!els.startScreen.classList.contains('hidden')) els.announcementsButton.focus();
}

function renderAnnouncementsList() {
  els.announcementsDetail.classList.add('hidden');
  els.announcementsList.classList.remove('hidden');
  els.announcementsList.replaceChildren();
  if (!announcementItems.length) {
    const empty = document.createElement('p');
    empty.className = 'announcementEmpty';
    empty.textContent = '暂无公告';
    els.announcementsList.append(empty);
    return;
  }
  for (const item of announcementItems) {
    // 列表项与首页横幅卡片同款：置顶角标 + 标题 + 时间，仅不展示正文
    const card = document.createElement('article');
    card.className = item.pinned ? 'announcementListItem announcementListItemPinned' : 'announcementListItem';
    card.setAttribute('role', 'listitem');

    const main = document.createElement('div');
    main.className = 'announcementListItemMain';

    const title = document.createElement('strong');
    title.className = 'announcementListItemTitle';
    title.append(document.createTextNode(item.title));
    if (item.pinned) {
      const badge = document.createElement('span');
      badge.className = 'announcementBadge';
      badge.textContent = '置顶';
      title.append(badge);
    }

    const time = document.createElement('time');
    time.className = 'announcementListItemTime';
    time.dateTime = new Date(item.createdAt).toISOString();
    time.textContent = announcementTimeFormatter.format(new Date(item.createdAt));

    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.className = 'announcementViewButton';
    viewButton.textContent = '查看详情';
    viewButton.addEventListener('click', () => showAnnouncementDetail(item));

    main.append(title, time);
    card.append(main, viewButton);
    els.announcementsList.append(card);
  }
}

function showAnnouncementDetail(item) {
  els.announcementsList.classList.add('hidden');
  els.announcementsDetail.classList.remove('hidden');
  els.announcementsDetail.replaceChildren();

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'announcementDetailBack';
  backButton.textContent = '← 返回列表';
  backButton.addEventListener('click', renderAnnouncementsList);

  // 与首页横幅卡片同款结构：置顶角标 + 标题 + 正文 + 时间，背景一致
  const card = document.createElement('article');
  card.className = item.pinned ? 'announcementCard announcementCardPinned' : 'announcementCard';

  const title = document.createElement('strong');
  title.className = 'announcementTitle';
  title.append(document.createTextNode(item.title));
  if (item.pinned) {
    const badge = document.createElement('span');
    badge.className = 'announcementBadge';
    badge.textContent = '置顶';
    title.append(badge);
  }

  const content = document.createElement('p');
  content.className = 'announcementContent';
  content.textContent = item.content;

  const time = document.createElement('time');
  time.className = 'announcementTime';
  time.dateTime = new Date(item.createdAt).toISOString();
  time.textContent = announcementTimeFormatter.format(new Date(item.createdAt));

  card.append(title, content, time);
  els.announcementsDetail.append(backButton, card);
}

function bindEvents() {
  els.classicModeButton.addEventListener('click', () => void beginClassic());
  els.freeModeButton.addEventListener('click', () => void beginFreeEntry());
  els.startButton.addEventListener('click', openHardModal);
  els.homeLeaderboardButton.addEventListener('click', openHomeLeaderboard);
  els.gameGuideButton.addEventListener('click', openGameGuide);
  els.announcementsButton.addEventListener('click', openAnnouncements);
  els.announcementsCloseButton.addEventListener('click', closeAnnouncements);
  els.announcementsModal.addEventListener('click', (event) => {
    if (event.target === els.announcementsModal) closeAnnouncements();
  });
  els.feedbackFab.addEventListener('click', openFeedback);
  els.feedbackCloseButton.addEventListener('click', closeFeedback);
  els.feedbackCancelButton.addEventListener('click', closeFeedback);
  els.feedbackForm.addEventListener('change', updateFeedbackPlaceholder);
  els.feedbackForm.addEventListener('submit', submitFeedback);
  els.feedbackModal.addEventListener('click', (event) => {
    if (event.target === els.feedbackModal) closeFeedback();
  });
  els.flagQuestionButton.addEventListener('click', onFlagButtonClick);
  els.flagCancelButton.addEventListener('click', closeFlagPopover);
  els.flagSubmitButton.addEventListener('click', () => void submitFlag());
  document.addEventListener('pointerdown', (event) => {
    if (els.flagPopover.classList.contains('hidden')) return;
    if (event.target.closest('#flagPopover') || event.target.closest('#flagQuestionButton')) return;
    closeFlagPopover();
  });
  els.backButton.addEventListener('click', showHome);
  els.debugFinishButton.addEventListener('click', () => void debugFastFinish());
  els.skipButton.addEventListener('click', () => state.engine?.skip());
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
  els.freeTagMode.addEventListener('change', updateFreeFilterPreview);
  els.freeFilterForm.addEventListener('submit', startFilteredGame);
  els.freeTimed.addEventListener('change', updateFreeFilterPreview);
  els.freeQuestionCount.addEventListener('click', selectFreeQuestionCount);
  els.freeTagSearch.addEventListener('focus', renderTagSearch);
  els.freeTagSearch.addEventListener('input', renderTagSearch);
  els.freeTagSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = els.freeTagResults.querySelector('button[data-tag]');
    if (first) chooseTag({ target: first });
  });
  els.freeTagResults.addEventListener('click', chooseTag);
  els.freeSelectedTags.addEventListener('click', removeTag);
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.freeTagPicker') && !els.freeTagResults.contains(event.target)) els.freeTagResults.classList.add('hidden');
  });
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
    if (!els.flagPopover.classList.contains('hidden')) closeFlagPopover();
    else if (!els.hardApiModal.classList.contains('hidden')) closeHardModal();
    else if (!els.gameGuideModal.classList.contains('hidden')) closeGameGuide();
    else if (!els.homeLeaderboardModal.classList.contains('hidden')) closeHomeLeaderboard();
    else if (!els.announcementsModal.classList.contains('hidden')) closeAnnouncements();
    else if (!els.feedbackModal.classList.contains('hidden')) closeFeedback();
    else if (!els.freeFilterModal.classList.contains('hidden')) closeFreeFilter();
    return;
  }
  if (document.querySelector('.modal:not(.hidden)') || !state.engine) return;
  // 标记弹层打开时不响应游戏快捷键，避免误触答题
  if (!els.flagPopover.classList.contains('hidden')) return;
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
  els.freeTagResults.classList.add('hidden');
  closeAllModals();
  state.mode = mode;
  els.startScreen.classList.add('hidden');
  els.gameScreen.classList.remove('hidden');
  document.body.classList.add('gameActive');
  const meta = MODE_META[mode];
  els.gameModeLabel.textContent = meta.eyebrow;
  els.gameTitle.textContent = meta.title;
  els.freeFilterButton.classList.toggle('hidden', mode !== 'free');
  els.debugFinishButton.classList.toggle('hidden', !debugFastFinishEnabled(mode));
  const debugCount = debugFastFinishCount(mode);
  els.debugFinishButton.textContent = mode === 'hard'
    ? `一键完成${debugCount}题并提交（调试）`
    : `一键完成${debugCount}题（调试）`;
  const timed = mode === 'hard' ? false : mode === 'free' ? state.freeFilter.timed !== false : true;
  els.timerStat.classList.toggle('hidden', !timed);
  els.timerTrack.classList.toggle('hidden', !timed);
  els.poolStat.classList.toggle('hidden', mode !== 'hard');
  els.hardHint.classList.toggle('hidden', mode !== 'hard');
  els.primaryMetricLabel.textContent = mode === 'hard' ? '正确率' : '得分';
  els.secondaryMetricLabel.textContent = mode === 'hard' ? '答对题数' : '正确率';
  els.progressLabel.textContent = '进度';
  resetQuestionDisplay();
  updateStats(emptySnapshot(mode));
}

function stopGame() {
  state.imageToken += 1;
  state.engine?.stop();
  state.provider?.stop?.();
  // 结算回顾已渲染完成，此时才释放抽帧 Blob（stop 不再提前 revoke）
  state.provider?.releaseBlobUrls?.();
  state.engine = null;
  state.provider = null;
  hideFlagControls();
  els.animeFrame.onload = null;
  els.animeFrame.onerror = null;
  els.framePanel.querySelectorAll('video').forEach((video) => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  });
}

function closeAllModals() {
  for (const modal of document.querySelectorAll('.modal')) modal.classList.add('hidden');
  document.body.classList.remove('modalOpen');
}

function openModal(element, focusTarget) {
  element.classList.remove('hidden');
  document.body.classList.add('modalOpen');
  // 弹窗为常驻 DOM，重开时会保留上次滚动位置；在弹窗渲染后的第一帧统一重置回顶部。
  // 需要该行为的滚动容器统一添加 .modalScrollReset 标记类即可自动生效。
  requestAnimationFrame(() => {
    for (const scroller of element.querySelectorAll('.modalScrollReset')) scroller.scrollTop = 0;
    focusTarget?.focus();
  });
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

function openFeedback() {
  els.feedbackForm.reset();
  els.feedbackContent.placeholder = FEEDBACK_TYPE_META.anime_error.placeholder;
  setFormMessage(els.feedbackMessage, '');
  els.feedbackSubmitButton.disabled = false;
  openModal(els.feedbackModal, els.feedbackContent);
}

function closeFeedback() {
  closeModal(els.feedbackModal);
  if (!els.startScreen.classList.contains('hidden')) els.feedbackFab.focus();
}

function updateFeedbackPlaceholder() {
  const type = getSelectedFeedbackType();
  const meta = FEEDBACK_TYPE_META[type];
  if (meta) els.feedbackContent.placeholder = meta.placeholder;
}

function getSelectedFeedbackType() {
  const checked = els.feedbackForm.querySelector('input[name="feedbackType"]:checked');
  return checked?.value || 'anime_error';
}

async function submitFeedback(event) {
  event.preventDefault();
  if (els.feedbackSubmitButton.disabled) return;
  const content = els.feedbackContent.value.trim();
  const type = getSelectedFeedbackType();
  if (!content) {
    setFormMessage(els.feedbackMessage, '请填写反馈内容', 'error');
    els.feedbackContent.focus();
    return;
  }
  els.feedbackSubmitButton.disabled = true;
  setFormMessage(els.feedbackMessage, '正在提交…', 'loading');
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type, content }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `提交失败（HTTP ${response.status}）`);
    setFormMessage(els.feedbackMessage, '已收到你的反馈，感谢支持！', 'success');
    window.setTimeout(closeFeedback, 900);
  } catch (error) {
    setFormMessage(els.feedbackMessage, error.message, 'error');
    els.feedbackSubmitButton.disabled = false;
  }
}

// ---- 标记题目疑似错误（复用 /api/feedback 的 anime_error 类型）----

function readFlaggedSet() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(FLAG_STORAGE_KEY) || '[]');
    if (Array.isArray(stored)) return new Set(stored.map(String).filter(Boolean));
  } catch {
    // sessionStorage 不可用时仅保留本页内存中的去重记录
  }
  return new Set();
}

function persistFlaggedSet() {
  try {
    sessionStorage.setItem(FLAG_STORAGE_KEY, JSON.stringify([...state.flaggedQuestions]));
  } catch {
    // 持久化失败不影响本次会话内的去重
  }
}

function updateFlagButtonState() {
  const question = state.engine?.current;
  if (!question) {
    hideFlagControls();
    return;
  }
  const flagged = Boolean(question.id) && state.flaggedQuestions.has(String(question.id));
  els.flagQuestionButton.classList.remove('hidden');
  els.flagQuestionButton.classList.toggle('flagged', flagged);
  const icon = els.flagQuestionButton.querySelector('.flagIcon');
  if (icon) icon.textContent = flagged ? '✓' : '⚠';
  els.flagQuestionButton.setAttribute('aria-label', flagged ? '该题已标记反馈' : '标记题目疑似错误');
  els.flagQuestionButton.title = flagged ? '该题已标记反馈' : '标记题目疑似错误';
  if (flagged) closeFlagPopover();
}

function hideFlagControls() {
  els.flagQuestionButton.classList.add('hidden');
  closeFlagPopover();
}

function onFlagButtonClick() {
  if (els.flagQuestionButton.classList.contains('flagged')) return;
  if (!els.flagPopover.classList.contains('hidden')) {
    closeFlagPopover();
    return;
  }
  const context = buildFlagContext();
  if (!context) return;
  state.flagAnchor = els.flagQuestionButton;
  openFlagPopover(els.flagQuestionButton, context, state.engine?.current?.id);
}

function openFlagPopover(anchor, context, questionId) {
  state.flagContextKey = questionId ? String(questionId) : null;
  state.flagSubmitting = false;
  els.flagContext.textContent = context || '';
  els.flagNote.value = '';
  setFormMessage(els.flagMessage, '');
  els.flagSubmitButton.disabled = false;
  els.flagPopover.classList.remove('hidden');
  requestAnimationFrame(() => els.flagNote.focus({ preventScroll: true }));
}

function closeFlagPopover() {
  if (els.flagPopover.classList.contains('hidden')) return;
  els.flagPopover.classList.add('hidden');
  state.flagAnchor = null;
  state.flagContextKey = null;
}

function buildFlagContext() {
  const engine = state.engine;
  const question = engine?.current;
  if (!question) return '';
  const modeLabel = MODE_META[state.mode]?.title || state.mode || '未知模式';
  // 当前题已作答（锁定）时，题号即已答数；否则为已答数 + 1
  const number = engine.locked ? engine.answered : engine.answered + 1;
  const options = Array.isArray(question.options)
    ? question.options.map((option) => String(option.title || '')).filter(Boolean).join(' / ')
    : '';
  const imageUrl = typeof question.imageUrl === 'string' && question.imageUrl
    ? question.imageUrl
    : Array.isArray(question.imageCandidates)
      ? question.imageCandidates.find((candidate) => typeof candidate === 'string' && candidate) || ''
      : '';
  let selected = '';
  if (engine.locked && engine.answers.length) {
    const last = engine.answers[engine.answers.length - 1];
    if (last && String(last.answerId) === String(question.answerId ?? question.id)) {
      selected = last.selectedTitle ? `｜你的答案：${last.selectedTitle}` : '';
    }
  }
  return `模式：${modeLabel}｜第 ${number} 题｜答案：${question.title || '未知'}${selected}｜选项：${options || '无'}｜截图：${imageUrl}`;
}

function buildRecordFlagContext(record) {
  const question = record?.question || {};
  const modeLabel = MODE_META[state.resultMode]?.title || state.resultMode || '未知模式';
  const resultLabel = record.isCorrect ? '答对'
    : record.reason === 'timeout' ? '超时' : record.reason === 'skip' ? '跳过' : '答错';
  const selected = record.selectedTitle ? `｜你的答案：${record.selectedTitle}` : '';
  return `模式：${modeLabel}｜结算回顾题｜答案：${question.title || '未知'}｜结果：${resultLabel}${selected}｜截图：${question.imageUrl || ''}`;
}

function showFlagForRecord(record, anchor) {
  const questionId = record?.question?.id;
  if (questionId && state.flaggedQuestions.has(String(questionId))) return;
  const context = buildRecordFlagContext(record);
  if (!context) return;
  state.flagAnchor = anchor;
  openFlagPopover(anchor, context, questionId);
}

async function submitFlag() {
  if (state.flagSubmitting || els.flagSubmitButton.disabled) return;
  const context = sanitizeFlagText(els.flagContext.textContent);
  if (!context) {
    closeFlagPopover();
    return;
  }
  const note = sanitizeFlagText(els.flagNote.value).slice(0, 400);
  const rawContent = note ? `${context}｜补充说明：${note}` : context;
  // Worker 会拒绝超过 2000 字符的 content，这里提前截断到安全长度
  const content = Array.from(rawContent).slice(0, FLAG_CONTENT_MAX_LENGTH).join('');
  const questionId = state.flagContextKey;
  const anchor = state.flagAnchor;
  state.flagSubmitting = true;
  els.flagSubmitButton.disabled = true;
  setFormMessage(els.flagMessage, '正在提交…', 'loading');
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type: 'anime_error', content }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `提交失败（HTTP ${response.status}）`);
    if (questionId) {
      state.flaggedQuestions.add(questionId);
      persistFlaggedSet();
    }
    closeFlagPopover();
    if (anchor && anchor !== els.flagQuestionButton) {
      anchor.textContent = '✓';
      anchor.disabled = true;
      anchor.title = '该题已标记反馈';
      anchor.setAttribute('aria-label', '该题已标记反馈');
    }
    updateFlagButtonState();
  } catch (error) {
    setFormMessage(els.flagMessage, error.message, 'error');
    els.flagSubmitButton.disabled = false;
  } finally {
    state.flagSubmitting = false;
  }
}

// 服务端会拒绝含控制字符（含换行）的 content，提交前统一清洗为单行文本
function sanitizeFlagText(value) {
  return String(value || '')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    startLocalEngine('classic', catalog, filterAnime(catalog, { minRatings: 1000 }));
  } catch (error) {
    if (token === state.launchToken) renderEngineError(error, () => void beginClassic());
  }
}

async function beginFreeEntry() {
  const token = ++state.launchToken;
  stopGame();
  closeAllModals();
  state.freeFilterInitial = true;
  openFreeFilter(true);
  try {
    await ensureCatalog();
    if (token !== state.launchToken) return;
    updateFreeFilterPreview();
    renderTagSearch();
  } catch (error) {
    if (token === state.launchToken) {
      els.freeMatchCount.textContent = '题库载入失败';
      setFormMessage(els.freeFilterMessage, error.message, 'error');
    }
  }
}

async function startLocalEngine(mode, catalog, eligible, options = {}) {
  const token = state.launchToken;
  stopGame();
  resetQuestionDisplay();
  const questionLimit = Number.isInteger(options.questionLimit) ? options.questionLimit : LOCAL_COUNT;
  const timed = options.timed !== false;
  let provider;
  try {
    provider = createLocalQuestionProvider(
      catalog,
      eligible,
      questionLimit,
      GAME_CONFIG.localPreloadCount,
    );
  } catch (error) {
    renderEngineError(error, () => {
      state.launchToken += 1;
      void startLocalEngine(mode, catalog, eligible, options);
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
    const engine = createEngine({ mode, provider, questionLimit, timed });
    state.engine = engine;
    await engine.start();
  } catch (error) {
    provider.stop();
    if (state.provider === provider) state.provider = null;
    if (token !== state.launchToken || state.mode !== mode || error.name === 'AbortError') return;
    renderEngineError(error, () => {
      state.launchToken += 1;
      void startLocalEngine(mode, catalog, eligible, options);
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
      // 池显示只统计已就绪的题（加载中不计入）
      onBufferChange: (readyCount) => {
        if (state.provider === provider) els.poolCount.textContent = `${readyCount} / ${GAME_CONFIG.hard.batchSize}`;
      },
    });
    state.provider = provider;
    // 答满 minRankQuestions 道题后自动结算，与经典/自由模式一致
    state.engine = createEngine({
      mode: 'hard',
      provider,
      questionLimit: GAME_CONFIG.hard.minRankQuestions,
      timed: false,
    });
    await state.engine.start();
  } catch (error) {
    if (token === state.launchToken) renderEngineError(error, () => void beginHard(apiKey));
  }
}

function debugFastFinishCount(mode) {
  if (mode === 'hard') return GAME_CONFIG.hard.minRankQuestions;
  if (mode === 'free') {
    return FREE_QUESTION_OPTIONS.includes(state.freeFilter.questionCount)
      ? state.freeFilter.questionCount
      : LOCAL_COUNT;
  }
  return LOCAL_COUNT;
}

function debugFastFinishEnabled(mode) {
  if (mode === 'classic') return DEBUG.classicFastFinishEnabled;
  if (mode === 'free') return DEBUG.freeFastFinishEnabled;
  if (mode === 'hard') return DEBUG.hardFastFinishEnabled;
  return false;
}

function debugFastFinish() {
  const mode = state.mode;
  if (!debugFastFinishEnabled(mode)) return;
  state.launchToken += 1;
  stopGame();
  const count = debugFastFinishCount(mode);
  const longTitle = (index) => `调试番剧第${index + 1}话·超长标题测试用例：这是一段很长的番剧名称，用来验证结算弹窗中标题自动换行后是否会和右上角反馈按钮发生遮挡重叠问题`;
  const answers = Array.from({ length: count }, (_, index) => ({
    selectedId: String(index + 1),
    selectedTitle: longTitle(index),
    answerId: String(index + 1),
    isCorrect: true,
    points: mode === 'hard' ? 0 : 10,
    remainingMs: 6000,
    reason: 'answer',
    question: {
      id: String(index + 1),
      title: longTitle(index),
      imageUrl: '',
      tags: ['调试'],
      copyrightTags: [],
    },
  }));
  void completeGame({
    mode,
    answered: count,
    correct: count,
    accuracy: 1,
    score: mode === 'hard' ? 0 : count * 10,
    elapsedMs: 180000,
    stopped: true,
    completedAt: new Date().toISOString(),
    answers,
  });
}

function createEngine({ mode, provider, questionLimit, timed }) {
  return new QuizEngine({
    mode, provider, questionLimit, timed,
    questionSeconds: GAME_CONFIG.questionSeconds,
    scoreTiers: GAME_CONFIG.scoreThresholds,
    untimedCorrectPoints: mode === 'free' && !timed ? 10 : 0,
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
  // 困难模式：显示已抽帧的随机帧截图（Blob URL），与普通模式共用 <img> 渲染
  if (state.mode === 'hard') {
    const frame = question?._videoFrame;
    if (!frame?.video) throw new Error('这道题没有可用画面。');
    await frame.ready;
    if (token !== state.imageToken) throw new DOMException('图片加载已取消', 'AbortError');
    if (frame.state.error) throw new Error(`画面加载失败：${frame.state.error.message}`);
    const url = frame.imageBlobUrl;
    if (!url) throw new Error('画面截图生成失败。');
    // 抽帧完成，视频资源不再需要
    frame.video.removeAttribute('src');
    frame.video.load();
    els.animeFrame.hidden = false;
    question.imageUrl = url;
    // 首题画面就绪，隐藏“首题稍慢”提示
    els.hardHint.classList.add('hidden');
    await loadAndDecodeInto(els.animeFrame, url, token);
    return url;
  }

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
      // 候选图之间稍作停顿，避免对图源发起过快的连续请求
      await delay(IMAGE_RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error('这道题没有可用截图。');
}

async function loadAndDecodeInto(image, url, token) {
  await new Promise((resolve, reject) => {
    // 单张图加载超时保护，避免连接挂起时无限等待
    const timer = window.setTimeout(() => {
      if (token !== state.imageToken) {
        // 该加载已被新一题取代（例如中途退出后重新开局），只废弃自身、不触碰共享 <img>
        reject(new DOMException('图片加载已取消', 'AbortError'));
        return;
      }
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
      reject(new Error('截图加载超时，正在轮换候选图片。'));
    }, IMAGE_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('截图加载失败，正在轮换候选图片。'));
    };
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
  window.Decor?.refreshLoadingFlavor?.();
  els.options.replaceChildren();
  els.feedback.textContent = '';
  els.feedback.className = 'feedback';
  els.statusText.textContent = '正在准备';
  els.skipButton.disabled = true;
}

function resetQuestionDisplay() {
  state.imageToken += 1;
  els.animeFrame.removeAttribute('src');
  els.animeFrame.hidden = false;
  els.framePanel.querySelectorAll('video').forEach((video) => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  });
  els.timerValue.textContent = GAME_CONFIG.questionSeconds.toFixed(1);
  els.timerBar.style.transform = 'scaleX(1)';
  els.timerTrack.classList.remove('urgent');
  setPreparing('正在准备题目…');
}

function updateStats(snapshot) {
  if (!snapshot || snapshot.mode !== state.mode) return;
  updateFlagButtonState();
  const percent = Math.round(snapshot.accuracy * 100);
  if (state.mode === 'hard') {
    const questionLimit = GAME_CONFIG.hard.minRankQuestions;
    els.progressValue.textContent = `${Math.min(snapshot.answered, questionLimit)} / ${questionLimit}`;
    els.primaryMetric.textContent = `${percent}%`;
    els.secondaryMetric.textContent = `${snapshot.correct} 题`;
    els.poolCount.textContent = `${state.provider?.readyCount ?? 0} / ${GAME_CONFIG.hard.batchSize}`;
  } else {
    const questionLimit = Number.isInteger(snapshot.questionLimit) ? snapshot.questionLimit : LOCAL_COUNT;
    els.progressValue.textContent = `${Math.min(snapshot.answered, questionLimit)} / ${questionLimit}`;
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
  return {
    mode, answered: 0, correct: 0, accuracy: 0, score: 0, bufferedCount: 0,
    loading: true, locked: true, current: null,
    questionLimit: mode === 'free'
      ? (FREE_QUESTION_OPTIONS.includes(state.freeFilter.questionCount) ? state.freeFilter.questionCount : LOCAL_COUNT)
      : LOCAL_COUNT,
  };
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
  openModal(els.freeFilterModal);
}

function restartFromFreeFilter() {
  state.launchToken += 1;
  stopGame();
  setPreparing('请确认新的筛选条件…');
  openFreeFilter(false);
}

function freeEngineOptions() {
  return {
    questionLimit: FREE_QUESTION_OPTIONS.includes(state.freeFilter.questionCount)
      ? state.freeFilter.questionCount
      : LOCAL_COUNT,
    timed: state.freeFilter.timed !== false,
  };
}

function closeFreeFilter() {
  els.freeTagResults.classList.add('hidden');
  closeModal(els.freeFilterModal);
  if (state.freeFilterInitial) {
    showHome();
    return;
  }
  state.launchToken += 1;
  startLocalEngine('free', state.catalog, filterAnime(state.catalog, state.freeFilter), freeEngineOptions());
}

function populateFreeFilter(filter) {
  els.freeStartDate.value = filter.startDate || '';
  els.freeEndDate.value = filter.endDate || '';
  writeOptionalInput(els.freeMinScore, filter.minScore);
  writeOptionalInput(els.freeMaxScore, filter.maxScore);
  writeOptionalInput(els.freeMaxRank, filter.maxRank);
  writeOptionalInput(els.freeMinRatings, filter.minRatings);
  writeOptionalInput(els.freeMinDone, filter.minDone);
  els.freeMinImages.value = String(filter.minImages || 1);
  const mode = filter.tagMode === 'all' ? 'all' : 'any';
  els.freeTagMode.value = mode;
  els.freeTimed.checked = filter.timed !== false;
  const count = FREE_QUESTION_OPTIONS.includes(filter.questionCount) ? filter.questionCount : LOCAL_COUNT;
  for (const button of els.freeQuestionCount.querySelectorAll('button')) {
    button.classList.toggle('active', Number(button.dataset.value) === count);
  }
}

function selectFreeQuestionCount(event) {
  const button = event.target.closest('button[data-value]');
  if (!button) return;
  for (const item of els.freeQuestionCount.querySelectorAll('button')) {
    item.classList.toggle('active', item === button);
  }
  updateFreeFilterPreview();
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
    startDate: els.freeStartDate.value,
    endDate: els.freeEndDate.value,
    minScore: readOptionalNumber(els.freeMinScore),
    maxScore: readOptionalNumber(els.freeMaxScore),
    maxRank: readOptionalNumber(els.freeMaxRank),
    minRatings: readOptionalNumber(els.freeMinRatings),
    minDone: readOptionalNumber(els.freeMinDone),
    minImages: readOptionalNumber(els.freeMinImages) ?? 1,
    tags: [...state.draftTags],
    tagMode: els.freeTagMode.value === 'all' ? 'all' : 'any',
    timed: els.freeTimed.checked,
    questionCount: Number(els.freeQuestionCount.querySelector('.active')?.dataset.value || LOCAL_COUNT),
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
  const questionCount = FREE_QUESTION_OPTIONS.includes(filter.questionCount) ? filter.questionCount : LOCAL_COUNT;
  const enough = state.freeEligible.length >= questionCount;
  els.freeMatchCount.textContent = `匹配 ${state.freeEligible.length} 部有截图番剧`;
  els.freeFilterStartButton.disabled = !enough;
  setFormMessage(
    els.freeFilterMessage,
    enough
      ? `将从匹配结果中无放回抽取 ${questionCount} 部番剧，${filter.timed ? `每题 ${GAME_CONFIG.questionSeconds} 秒` : '不限时'}。`
      : `至少需要 ${questionCount} 部，请放宽筛选条件。`,
    enough ? 'success' : 'error',
  );
}

function startFilteredGame(event) {
  event.preventDefault();
  updateFreeFilterPreview();
  const filter = readFreeFilter();
  const questionCount = FREE_QUESTION_OPTIONS.includes(filter.questionCount) ? filter.questionCount : LOCAL_COUNT;
  if (els.freeFilterStartButton.disabled || state.freeEligible.length < questionCount) return;
  state.freeFilter = { ...filter, tags: [...filter.tags] };
  state.freeFilterInitial = false;
  showGameShell('free');
  state.launchToken += 1;
  startLocalEngine('free', state.catalog, state.freeEligible, freeEngineOptions());
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
  showTagSearchResults();
}

function showTagSearchResults() {
  const rect = els.freeTagSearch.getBoundingClientRect();
  const style = els.freeTagResults.style;
  style.position = 'fixed';
  style.left = `${rect.left}px`;
  style.top = `${rect.bottom + 7}px`;
  style.right = 'auto';
  style.width = `${Math.max(rect.width, 260)}px`;
  style.maxHeight = `${Math.max(120, Math.min(280, window.innerHeight - rect.bottom - 18))}px`;
  style.zIndex = '200';
  if (els.freeTagResults.parentElement !== document.body) {
    document.body.appendChild(els.freeTagResults);
  }
  els.freeTagResults.classList.remove('hidden');
}

function chooseTag(event) {
  const button = event.target.closest('button[data-tag]');
  if (!button || state.draftTags.includes(button.dataset.tag)) return;
  state.draftTags.push(button.dataset.tag);
  els.freeTagSearch.value = '';
  renderSelectedTags();
  renderTagSearch();
  updateFreeFilterPreview();
  els.freeTagSearch.focus({ preventScroll: true });
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
  hideFlagControls();
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
  // 一轮困难挑战已结算：清空持久化的版权标签去重记录，让新一轮从头开始去重
  if (result.mode === 'hard') clearExcludedTags();
  els.resultTitle.textContent = result.mode === 'hard' ? '困难挑战结算' : result.mode === 'free' ? '自由练习完成' : '经典挑战完成';
  els.resultLead.textContent = result.mode === 'hard'
    ? `连续完成 ${result.answered} 道题，已满足排行榜最低题数。` : `完整完成 ${result.answered} 道题，本局成绩有效。`;
  const accuracy = Math.round(result.accuracy * 10000) / 100;
  if (result.mode === 'hard') {
    els.resultMainValue.textContent = `${accuracy}%`;
    els.resultMainLabel.textContent = '正确率';
  } else {
    const maxScore = result.answered * Math.max(...GAME_CONFIG.scoreThresholds.map((tier) => tier.points));
    els.resultMainValue.textContent = `${result.score} / ${maxScore}`;
    els.resultMainLabel.textContent = '总分';
  }
  els.resultCorrectValue.textContent = `${result.correct} / ${result.answered}`;
  els.resultElapsedValue.textContent = formatDuration(result.elapsedMs);
  renderResultReview(result.answers);
  els.resultRefilterButton.classList.toggle('hidden', result.mode !== 'free');
  els.leaderboardSection.classList.toggle('hidden', !ranked);
  openModal(els.resultModal, els.resultReplayButton);
  window.Decor?.burstConfetti?.();
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
    const imageUrl = question.imageUrl || question.imageCandidates?.[0] || '';
    let image = null;
    if (imageUrl) {
      image = document.createElement('img');
      image.className = 'reviewImage';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.alt = `第 ${index + 1} 题截图`;
      image.src = imageUrl;
    } else {
      // 困难模式无静态截图，用占位样式块模拟图片展示
      image = document.createElement('div');
      image.className = 'reviewImage reviewImagePlaceholder';
      image.setAttribute('aria-hidden', 'true');
      const icon = document.createElement('span');
      icon.className = 'reviewPlaceholderIcon';
      icon.textContent = '▶';
      const label = document.createElement('span');
      label.textContent = '视频帧';
      image.append(icon, label);
    }

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
    const resultLabel = record.reason === 'timeout' ? '超时'
      : record.reason === 'skip' ? '跳过'
        : record.isCorrect ? '答对' : '答错';
    result.textContent = `${resultLabel}${record.points ? ` +${record.points}` : ''}`;
    meta.append(number, result);

    const answer = document.createElement('p');
    answer.className = 'reviewAnswer';
    if (record.isCorrect) {
      answer.textContent = `你的答案：${record.selectedTitle || question.title || '未知番剧'}`;
    } else if (record.reason === 'timeout' || record.reason === 'skip' || !record.selectedTitle) {
      answer.textContent = `你的答案：${record.reason === 'timeout' ? '未在时限内作答' : '未作答'}`;
    } else {
      answer.textContent = `你的答案：${record.selectedTitle}`;
    }
    answer.title = answer.textContent;

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
    const flagButton = document.createElement('button');
    flagButton.type = 'button';
    flagButton.className = 'reviewFlagButton';
    const recordId = question.id;
    const alreadyFlagged = Boolean(recordId) && state.flaggedQuestions.has(String(recordId));
    flagButton.textContent = alreadyFlagged ? '✓' : '!';
    flagButton.title = alreadyFlagged ? '该题已标记反馈' : '标记题目疑似错误';
    flagButton.setAttribute('aria-label', flagButton.title);
    flagButton.disabled = alreadyFlagged;
    flagButton.addEventListener('click', () => showFlagForRecord(record, flagButton));
    copy.append(title, meta, answer, tagList);
    card.append(image, copy, flagButton);
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
    startLocalEngine('free', state.catalog, filterAnime(state.catalog, state.freeFilter), freeEngineOptions());
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
