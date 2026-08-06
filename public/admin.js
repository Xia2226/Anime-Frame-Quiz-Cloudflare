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

  function addEmptyRow(table, columns, message) {
    const tbody = table.querySelector("tbody");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns;
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

      const content = document.createElement("p");
      content.className = "feedbackContent";
      content.textContent = item.content;

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

  leaderboardEls.refreshButton.addEventListener("click", () => void loadLeaderboard());
  leaderboardEls.modeFilter.addEventListener("change", () => void loadLeaderboardDetail());
  leaderboardEls.daySelect.addEventListener("change", () => void loadLeaderboardDetail());

  analyticsEls.daysSelect.addEventListener("change", () => void loadAnalytics());

  // 初始化
  populateDaySelect();
  loadedModules.add("feedback");
  void loadFeedback();
})();
