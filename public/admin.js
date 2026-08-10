(() => {
  "use strict";

  const PAGE_SIZE = 20;
  const TYPE_LABELS = {
    anime_error: "番剧错误",
    bug: "BUG 反馈",
    feature: "项目功能",
    other: "其他",
  };

  // ---------- 通用工具 ----------

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    }
    return data;
  }

  function formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return String(timestamp);
    }
  }

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  const integerFormatter = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  });

  function getShanghaiDayKey() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    return parts.filter((part) => part.type !== "literal").map((part) => part.value).join("-");
  }

  function formatShanghaiDayKey(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    return parts.filter((part) => part.type !== "literal").map((part) => part.value).join("-");
  }

  function subtractDaysFromKey(key, days) {
    const [year, month, day] = key.split("-").map(Number);
    return formatShanghaiDayKey(new Date(Date.UTC(year, month - 1, day - days)));
  }

  function clearTableBody(tbody) {
    tbody.replaceChildren();
  }

  function countVisibleTableColumns(table) {
    const headers = table.querySelectorAll("thead th");
    let count = 0;
    for (const th of headers) {
      if (getComputedStyle(th).display !== "none") count += 1;
    }
    return count;
  }

  function addEmptyRow(table, columns, message) {
    const tbody = table.querySelector("tbody");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    // 移动端会隐藏部分列，colspan 需按实际可见列数计算，否则空行无法撑满表格宽度
    const visible = countVisibleTableColumns(table);
    td.colSpan = visible > 0 ? visible : columns;
    td.textContent = message;
    td.style.textAlign = "center";
    td.style.padding = "24px 12px";
    td.style.color = "var(--muted)";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function buildTableRows(tbody, rows) {
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const text of row) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  // ---------- 问题反馈模块 ----------

  const feedbackState = {
    currentType: "",
    currentPage: 1,
    total: 0,
  };
  const feedbackEls = {
    refreshButton: document.getElementById("refreshButton"),
    typeFilter: document.getElementById("typeFilter"),
    totalLabel: document.getElementById("totalLabel"),
    statusMessage: document.getElementById("statusMessage"),
    listSection: document.getElementById("listSection"),
    prevButton: document.getElementById("prevButton"),
    nextButton: document.getElementById("nextButton"),
    pageInfo: document.getElementById("pageInfo"),
  };

  function showFeedbackStatus(message, kind) {
    feedbackEls.statusMessage.textContent = message || "";
    feedbackEls.statusMessage.className = kind ? `status ${kind}` : "status";
  }

  function renderFeedbackList(items) {
    feedbackEls.listSection.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "emptyState";
      empty.textContent = "暂无反馈记录";
      feedbackEls.listSection.appendChild(empty);
      return;
    }
    for (const item of items) {
      const card = document.createElement("article");
      card.className = "feedbackCard";

      const meta = document.createElement("div");
      meta.className = "feedbackCardMeta";

      const badge = document.createElement("span");
      badge.className = `typeBadge ${item.type}`;
      badge.textContent = TYPE_LABELS[item.type] || item.type;

      const actions = document.createElement("div");
      actions.className = "feedbackCardActions";

      const time = document.createElement("span");
      time.className = "feedbackTime";
      time.textContent = formatTime(item.createdAt);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "deleteBtn";
      deleteBtn.textContent = "删除";
      deleteBtn.addEventListener("click", () => void deleteFeedback(item.id));

      actions.append(time, deleteBtn);
      meta.append(badge, actions);

      // 标记类反馈的字段以「|」分隔（入库前经 NFKC 规范化，全角｜会变为半角|）
      // 展示规则：答案/选项/截图/补充说明单独成行，其余字段（模式、结果、你的答案等）合并为第一行
      const content = document.createElement("div");
      content.className = "feedbackContent";
      const parts = String(item.content || "").split(/[|｜]/).map((p) => p.trim()).filter(Boolean);
      const firstLine = [];
      const ownLines = [];
      for (const part of parts) {
        if (/^(答案|选项|截图|补充说明):/.test(part)) ownLines.push(part);
        else firstLine.push(part);
      }
      const appendFeedbackLine = (text) => {
        const line = document.createElement("div");
        line.className = "feedbackContentLine";
        line.textContent = text;
        content.appendChild(line);
      };
      if (firstLine.length) appendFeedbackLine(firstLine.join(" "));
      for (const part of ownLines) appendFeedbackLine(part);

      const id = document.createElement("p");
      id.className = "feedbackId";
      id.textContent = `ID: ${item.id}`;

      card.append(meta, content, id);
      feedbackEls.listSection.appendChild(card);
    }
  }

  async function deleteFeedback(id) {
    if (!window.confirm(`确定删除反馈 ID ${id} 吗？此操作不可恢复。`)) return;
    showFeedbackStatus("正在删除…", "loading");
    try {
      await fetchJson(`/api/admin/feedback?id=${id}`, { method: "DELETE" });
      showFeedbackStatus("已删除");
      await loadFeedback();
    } catch (error) {
      showFeedbackStatus(error.message || "删除失败", "error");
    }
  }

  function renderFeedbackPagination() {
    const totalPages = Math.max(1, Math.ceil(feedbackState.total / PAGE_SIZE));
    feedbackEls.prevButton.disabled = feedbackState.currentPage <= 1;
    feedbackEls.nextButton.disabled = feedbackState.currentPage >= totalPages;
    const start = feedbackState.total === 0 ? 0 : (feedbackState.currentPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(feedbackState.total, feedbackState.currentPage * PAGE_SIZE);
    feedbackEls.pageInfo.textContent = `第 ${feedbackState.currentPage} / ${totalPages} 页 · 共 ${feedbackState.total} 条（显示 ${start}-${end}）`;
    feedbackEls.totalLabel.textContent = feedbackState.total > 0 ? `共 ${feedbackState.total} 条反馈` : "暂无反馈";
  }

  async function loadFeedback() {
    feedbackEls.refreshButton.disabled = true;
    showFeedbackStatus("正在加载…", "loading");
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((feedbackState.currentPage - 1) * PAGE_SIZE),
    });
    if (feedbackState.currentType) query.set("type", feedbackState.currentType);
    try {
      const data = await fetchJson(`/api/admin/feedback?${query}`);
      feedbackState.total = Number(data?.total) || 0;
      renderFeedbackList(Array.isArray(data?.items) ? data.items : []);
      renderFeedbackPagination();
      showFeedbackStatus("");
    } catch (error) {
      renderFeedbackList([]);
      renderFeedbackPagination();
      showFeedbackStatus(error.message || "加载失败", "error");
    } finally {
      feedbackEls.refreshButton.disabled = false;
    }
  }

  // ---------- 动漫管理模块 ----------

  const ANIME_PAGE_SIZE = 20;
  const animeState = {
    query: "",
    status: "",
    currentPage: 1,
    total: 0,
  };
  let animeSearchTimerId = null;
  const animeEls = {
    refreshButton: document.getElementById("animeRefreshButton"),
    search: document.getElementById("animeSearch"),
    statusFilter: document.getElementById("animeStatusFilter"),
    resetButton: document.getElementById("animeResetButton"),
    totalLabel: document.getElementById("animeTotalLabel"),
    status: document.getElementById("animeStatus"),
    table: document.getElementById("animeTable"),
    prevButton: document.getElementById("animePrevButton"),
    nextButton: document.getElementById("animeNextButton"),
    pageInfo: document.getElementById("animePageInfo"),
  };

  function setAnimeStatus(message, kind) {
    animeEls.status.textContent = message || "";
    animeEls.status.className = kind ? `status ${kind}` : "status";
  }

  function renderAnimeSwitchState(button, item) {
    button.setAttribute("aria-checked", String(item.enabled));
    button.setAttribute("aria-label", `${item.enabled ? "停用" : "启用"}番剧「${item.title}」`);
    const text = button.querySelector(".switchText");
    if (text) text.textContent = item.enabled ? "已启用" : "已停用";
  }

  function createStatusSwitch(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "statusSwitch";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(item.enabled));
    button.setAttribute("aria-label", `${item.enabled ? "停用" : "启用"}番剧「${item.title}」`);

    const track = document.createElement("span");
    track.className = "track";
    track.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "switchText";
    text.textContent = item.enabled ? "已启用" : "已停用";

    button.append(track, text);
    button.addEventListener("click", () => void toggleAnime(item, button));
    return button;
  }

  async function toggleAnime(item, button) {
    button.disabled = true;
    setAnimeStatus("正在更新…", "loading");
    try {
      const data = await fetchJson("/api/admin/anime", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anidbId: item.anidbId, enabled: !item.enabled }),
      });
      item.enabled = Boolean(data.enabled);
      renderAnimeSwitchState(button, item);
      setAnimeStatus(`已${item.enabled ? "启用" : "停用"}「${item.title}」，题库约 1 分钟后生效`);
    } catch (error) {
      setAnimeStatus(error.message || "更新失败", "error");
    } finally {
      button.disabled = false;
    }
  }

  function buildAnimeRows(items) {
    const tbody = animeEls.table.querySelector("tbody");
    clearTableBody(tbody);
    for (const item of items) {
      const tr = document.createElement("tr");

      const titleCell = document.createElement("td");
      titleCell.className = "animeTitleCell";
      const layout = document.createElement("div");
      layout.className = "animeTitleLayout";
      if (item.cover) {
        const thumb = document.createElement("img");
        thumb.src = item.cover;
        thumb.alt = "";
        thumb.loading = "lazy";
        thumb.decoding = "async";
        thumb.referrerPolicy = "no-referrer";
        thumb.addEventListener("error", () => thumb.remove());
        layout.append(thumb);
      }
      const texts = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = item.title;
      strong.title = item.title;
      texts.append(strong);
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
      titleCell.append(layout);

      const dateCell = document.createElement("td");
      dateCell.dataset.label = "首播";
      dateCell.textContent = item.date || "—";
      const scoreCell = document.createElement("td");
      scoreCell.dataset.label = "评分";
      scoreCell.textContent = item.score === null || item.score === undefined ? "—" : item.score.toFixed(1);
      const imageCell = document.createElement("td");
      imageCell.dataset.label = "截图";
      imageCell.textContent = integerFormatter.format(item.imageCount || 0);
      const statusCell = document.createElement("td");
      statusCell.dataset.label = "状态";
      statusCell.append(createStatusSwitch(item));

      tr.append(titleCell, dateCell, scoreCell, imageCell, statusCell);
      tbody.appendChild(tr);
    }
  }

  function renderAnimePagination() {
    const totalPages = Math.max(1, Math.ceil(animeState.total / ANIME_PAGE_SIZE));
    animeEls.prevButton.disabled = animeState.currentPage <= 1;
    animeEls.nextButton.disabled = animeState.currentPage >= totalPages;
    const start = animeState.total === 0 ? 0 : (animeState.currentPage - 1) * ANIME_PAGE_SIZE + 1;
    const end = Math.min(animeState.total, animeState.currentPage * ANIME_PAGE_SIZE);
    animeEls.pageInfo.textContent = `第 ${animeState.currentPage} / ${totalPages} 页 · 共 ${animeState.total} 部（显示 ${start}-${end}）`;
    animeEls.totalLabel.textContent = animeState.total > 0 ? `共 ${animeState.total} 部番剧` : "暂无番剧";
  }

  async function loadAnime() {
    animeEls.refreshButton.disabled = true;
    setAnimeStatus("正在加载…", "loading");
    const query = new URLSearchParams({
      limit: String(ANIME_PAGE_SIZE),
      offset: String((animeState.currentPage - 1) * ANIME_PAGE_SIZE),
    });
    if (animeState.query) query.set("query", animeState.query);
    if (animeState.status) query.set("status", animeState.status);
    try {
      const data = await fetchJson(`/api/admin/anime?${query}`);
      animeState.total = Number(data?.total) || 0;
      buildAnimeRows(Array.isArray(data?.items) ? data.items : []);
      if (!data?.items?.length) {
        addEmptyRow(
          animeEls.table,
          5,
          animeState.query || animeState.status ? "没有符合条件的番剧" : "图库为空",
        );
      }
      renderAnimePagination();
      setAnimeStatus("");
    } catch (error) {
      buildAnimeRows([]);
      addEmptyRow(animeEls.table, 5, "加载失败");
      renderAnimePagination();
      setAnimeStatus(error.message || "加载失败", "error");
    } finally {
      animeEls.refreshButton.disabled = false;
    }
  }

  function scheduleAnimeSearch() {
    if (animeSearchTimerId !== null) clearTimeout(animeSearchTimerId);
    animeSearchTimerId = setTimeout(() => {
      animeSearchTimerId = null;
      animeState.query = animeEls.search.value.trim();
      animeState.currentPage = 1;
      void loadAnime();
    }, 300);
  }

  // ---------- 排行榜模块 ----------

  const leaderboardEls = {
    refreshButton: document.getElementById("lbRefreshButton"),
    modeFilter: document.getElementById("lbModeFilter"),
    daySelect: document.getElementById("lbDaySelect"),
    status: document.getElementById("lbStatus"),
    daysTable: document.getElementById("lbDaysTable"),
    detailTitle: document.getElementById("lbDetailTitle"),
    detailTable: document.getElementById("lbDetailTable"),
  };

  function setLeaderboardStatus(message) {
    leaderboardEls.status.textContent = message || "";
  }

  function populateDaySelect() {
    const todayKey = getShanghaiDayKey();
    const options = [];
    for (let offset = 0; offset < 14; offset += 1) {
      options.push(subtractDaysFromKey(todayKey, offset));
    }
    leaderboardEls.daySelect.replaceChildren(...options.map((key) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = key;
      return option;
    }));
    leaderboardEls.daySelect.value = todayKey;
  }

  async function loadLeaderboardDays() {
    const data = await fetchJson("/api/admin/leaderboard/days?days=14");
    const tbody = leaderboardEls.daysTable.querySelector("tbody");
    clearTableBody(tbody);
    const days = [...(data.days || [])].sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1));
    for (const day of days) {
      const tr = document.createElement("tr");
      const tdDay = document.createElement("td");
      tdDay.textContent = day.dayKey;
      const tdClassic = document.createElement("td");
      tdClassic.textContent = String(day.classic);
      const tdHard = document.createElement("td");
      tdHard.textContent = String(day.hard);
      tr.append(tdDay, tdClassic, tdHard);
      tbody.appendChild(tr);
    }
    if (days.length === 0) {
      addEmptyRow(leaderboardEls.daysTable, 3, "暂无数据");
    }
  }

  async function loadLeaderboardDetail() {
    const mode = leaderboardEls.modeFilter.value;
    const dayKey = leaderboardEls.daySelect.value || getShanghaiDayKey();
    const modeLabel = mode === "classic" ? "经典模式" : "困难挑战";
    const data = await fetchJson(
      `/api/admin/leaderboard?mode=${encodeURIComponent(mode)}&dayKey=${encodeURIComponent(dayKey)}`,
    );
    leaderboardEls.detailTitle.textContent = `榜单明细 · ${dayKey} · ${modeLabel}（共 ${data.total} 人）`;
    const tbody = leaderboardEls.detailTable.querySelector("tbody");
    clearTableBody(tbody);
    buildTableRows(tbody, (data.entries || []).map((entry) => [
      String(entry.rank),
      entry.username,
      String(entry.score),
      `${entry.correctCount}/${entry.questionCount}`,
      `${entry.accuracy.toFixed(2)}%`,
      formatElapsed(entry.elapsedMs),
      formatTime(entry.completedAt),
    ]));
    if (!data.entries || data.entries.length === 0) {
      addEmptyRow(leaderboardEls.detailTable, 7, "当天暂无榜单记录");
    }
  }

  async function loadLeaderboard() {
    setLeaderboardStatus("正在加载…");
    try {
      await loadLeaderboardDays();
      await loadLeaderboardDetail();
      setLeaderboardStatus("");
    } catch (error) {
      setLeaderboardStatus(error.message || "加载失败");
    }
  }

  // ---------- 访问统计模块 ----------

  const analyticsEls = {
    daysSelect: document.getElementById("anaDaysSelect"),
    totalPv: document.getElementById("anaTotalPv"),
    totalUv: document.getElementById("anaTotalUv"),
    status: document.getElementById("anaStatus"),
    dailyTable: document.getElementById("anaDailyTable"),
  };

  function setAnalyticsStatus(message) {
    analyticsEls.status.textContent = message || "";
  }

  async function loadAnalytics() {
    const days = analyticsEls.daysSelect.value;
    setAnalyticsStatus("正在加载…");
    try {
      const data = await fetchJson(`/api/admin/analytics?days=${encodeURIComponent(days)}`);
      analyticsEls.totalPv.textContent = String(data.totals?.pv ?? 0);
      analyticsEls.totalUv.textContent = String(data.totals?.uv ?? 0);

      const dailyTbody = analyticsEls.dailyTable.querySelector("tbody");
      clearTableBody(dailyTbody);
      buildTableRows(dailyTbody, (data.days || []).map((row) => [
        row.date,
        String(row.pv),
        String(row.uv),
      ]));
      if (!data.days || data.days.length === 0) {
        addEmptyRow(analyticsEls.dailyTable, 3, "暂无访问数据");
      }
      setAnalyticsStatus("");
    } catch (error) {
      setAnalyticsStatus(error.message || "加载失败");
    }
  }

  // ---------- 模块切换与事件绑定 ----------

  const loadedModules = new Set();
  const moduleLoaders = {
    feedback: loadFeedback,
    anime: loadAnime,
    leaderboard: loadLeaderboard,
    analytics: loadAnalytics,
  };

  const navItems = document.querySelectorAll(".navItem");
  for (const item of navItems) {
    item.addEventListener("click", () => {
      const module = item.dataset.module;
      for (const other of navItems) other.classList.toggle("active", other === item);
      for (const panel of document.querySelectorAll(".modulePanel")) {
        panel.classList.toggle("hidden", panel.id !== `module-${module}`);
      }
      if (!loadedModules.has(module)) {
        loadedModules.add(module);
        const loader = moduleLoaders[module];
        if (loader) void loader();
      }
    });
  }

  feedbackEls.refreshButton.addEventListener("click", () => void loadFeedback());
  feedbackEls.typeFilter.addEventListener("change", () => {
    feedbackState.currentType = feedbackEls.typeFilter.value;
    feedbackState.currentPage = 1;
    void loadFeedback();
  });
  feedbackEls.prevButton.addEventListener("click", () => {
    if (feedbackState.currentPage > 1) {
      feedbackState.currentPage -= 1;
      void loadFeedback();
    }
  });
  feedbackEls.nextButton.addEventListener("click", () => {
    if (feedbackState.currentPage < Math.ceil(feedbackState.total / PAGE_SIZE)) {
      feedbackState.currentPage += 1;
      void loadFeedback();
    }
  });

  animeEls.refreshButton.addEventListener("click", () => void loadAnime());
  animeEls.search.addEventListener("input", scheduleAnimeSearch);
  animeEls.statusFilter.addEventListener("change", () => {
    animeState.status = animeEls.statusFilter.value;
    animeState.currentPage = 1;
    void loadAnime();
  });
  animeEls.resetButton.addEventListener("click", () => {
    // 取消尚未触发的搜索防抖，避免清空后又触发一次加载
    if (animeSearchTimerId !== null) {
      clearTimeout(animeSearchTimerId);
      animeSearchTimerId = null;
    }
    animeEls.search.value = "";
    animeState.query = "";
    animeState.currentPage = 1;
    void loadAnime();
  });
  animeEls.prevButton.addEventListener("click", () => {
    if (animeState.currentPage > 1) {
      animeState.currentPage -= 1;
      void loadAnime();
    }
  });
  animeEls.nextButton.addEventListener("click", () => {
    if (animeState.currentPage < Math.ceil(animeState.total / ANIME_PAGE_SIZE)) {
      animeState.currentPage += 1;
      void loadAnime();
    }
  });

  leaderboardEls.refreshButton.addEventListener("click", () => void loadLeaderboard());
  leaderboardEls.modeFilter.addEventListener("change", () => void loadLeaderboardDetail());
  leaderboardEls.daySelect.addEventListener("change", () => void loadLeaderboardDetail());

  analyticsEls.daysSelect.addEventListener("change", () => void loadAnalytics());

  // 初始化
  populateDaySelect();
  loadedModules.add("feedback");
  void loadFeedback();
})();
