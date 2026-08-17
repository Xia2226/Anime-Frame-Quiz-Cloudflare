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
    currentStatus: "",
    currentPage: 1,
    total: 0,
  };
  const feedbackEls = {
    refreshButton: document.getElementById("refreshButton"),
    typeFilter: document.getElementById("typeFilter"),
    statusFilter: document.getElementById("statusFilter"),
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

      const statusBadge = document.createElement("span");
      const isHandled = item.status === "handled";
      statusBadge.className = `feedbackStatusBadge ${isHandled ? "handled" : "unhandled"}`;
      statusBadge.textContent = isHandled ? "已处理" : "未处理";

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

      const handleBtn = document.createElement("button");
      handleBtn.type = "button";
      handleBtn.className = "handleBtn";
      handleBtn.textContent = "处理";
      handleBtn.addEventListener("click", () => void markFeedbackHandled(item.id));
      if (isHandled) handleBtn.disabled = true;

      actions.append(statusBadge, time, handleBtn, deleteBtn);
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

  async function markFeedbackHandled(id) {
    if (!window.confirm(`确定将反馈 ID ${id} 标记为已处理吗？`)) return;
    showFeedbackStatus("正在更新…", "loading");
    try {
      await fetchJson(`/api/admin/feedback?id=${id}&status=handled`, { method: "PATCH" });
      showFeedbackStatus("已标记为已处理");
      await loadFeedback();
    } catch (error) {
      showFeedbackStatus(error.message || "操作失败", "error");
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
    if (feedbackState.currentStatus) query.set("status", feedbackState.currentStatus);
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

  // ---------- 公告管理模块 ----------

  const ANNOUNCEMENT_PAGE_SIZE = 20;
  const annState = {
    status: "",
    currentPage: 1,
    total: 0,
    editingId: null,
  };
  const annEls = {
    refreshButton: document.getElementById("annRefreshButton"),
    formTitle: document.getElementById("annFormTitle"),
    form: document.getElementById("annForm"),
    title: document.getElementById("annTitle"),
    content: document.getElementById("annContent"),
    pinned: document.getElementById("annPinned"),
    message: document.getElementById("annMessage"),
    cancelEditButton: document.getElementById("annCancelEditButton"),
    resetButton: document.getElementById("annResetButton"),
    submitButton: document.getElementById("annSubmitButton"),
    statusFilter: document.getElementById("annStatusFilter"),
    totalLabel: document.getElementById("annTotalLabel"),
    status: document.getElementById("annStatus"),
    table: document.getElementById("annTable"),
    prevButton: document.getElementById("annPrevButton"),
    nextButton: document.getElementById("annNextButton"),
    pageInfo: document.getElementById("annPageInfo"),
    detailModal: document.getElementById("annDetailModal"),
    detailBody: document.getElementById("annDetailBody"),
  };

  function setAnnStatus(message, kind) {
    annEls.status.textContent = message || "";
    annEls.status.className = kind ? `status ${kind}` : "status";
  }

  function setAnnMessage(message, kind) {
    annEls.message.textContent = message || "";
    // 保留基础类，仅切换错误态，避免覆盖布局样式
    annEls.message.classList.toggle("error", kind === "error");
  }

  function setAnnSubmitBusy(busy) {
    annEls.submitButton.disabled = busy;
    annEls.cancelEditButton.disabled = busy;
    annEls.resetButton.disabled = busy;
  }

  function resetAnnForm() {
    annState.editingId = null;
    annEls.form.reset();
    annEls.formTitle.textContent = "发布公告";
    annEls.submitButton.textContent = "发布";
    annEls.cancelEditButton.classList.add("hidden");
    setAnnMessage("");
  }

  function enterAnnouncementEdit(item) {
    annState.editingId = item.id;
    annEls.title.value = item.title;
    annEls.content.value = item.content;
    annEls.pinned.checked = item.pinned;
    annEls.formTitle.textContent = `编辑公告 #${item.id}`;
    annEls.submitButton.textContent = "保存修改";
    annEls.cancelEditButton.classList.remove("hidden");
    annEls.message.textContent = "";
    annEls.form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function submitAnnouncement(event) {
    event.preventDefault();
    const title = annEls.title.value.trim();
    const content = annEls.content.value.trim();
    if (!title || !content) {
      setAnnMessage("标题和正文都不能为空", "error");
      return;
    }
    setAnnSubmitBusy(true);
    setAnnMessage("正在保存…");
    try {
      if (annState.editingId === null) {
        await fetchJson("/api/admin/announcements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content, pinned: annEls.pinned.checked }),
        });
        setAnnMessage("已发布，状态为已下架（手动上架后前台可见）");
      } else {
        // 编辑保存后统一置为下架：需手动上架才在前台展示
        await fetchJson(`/api/admin/announcements?id=${annState.editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            content,
            pinned: annEls.pinned.checked,
            active: false,
          }),
        });
        setAnnMessage("已保存修改，状态已改为下架");
      }
      resetAnnForm();
      await loadAnnouncements();
    } catch (error) {
      setAnnMessage(error.message || "保存失败", "error");
    } finally {
      setAnnSubmitBusy(false);
    }
  }

  async function toggleAnnouncement(item, button) {
    button.disabled = true;
    setAnnStatus("正在更新…", "loading");
    try {
      await fetchJson(`/api/admin/announcements?id=${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: item.title,
          content: item.content,
          pinned: item.pinned,
          active: !item.active,
        }),
      });
      // 先刷新列表再展示结果，避免 loadAnnouncements 清空本消息
      await loadAnnouncements();
      setAnnStatus(`已${item.active ? "下架" : "上架"}「${item.title}」，前台即时生效`);
    } catch (error) {
      setAnnStatus(error.message || "更新失败", "error");
    } finally {
      button.disabled = false;
    }
  }

  async function deleteAnnouncement(item) {
    if (!window.confirm(`确定删除公告「${item.title}」吗？此操作不可恢复。`)) return;
    setAnnStatus("正在删除…", "loading");
    try {
      await fetchJson(`/api/admin/announcements?id=${item.id}`, { method: "DELETE" });
      if (annState.editingId === item.id) resetAnnForm();
      await loadAnnouncements();
      setAnnStatus("已删除");
    } catch (error) {
      setAnnStatus(error.message || "删除失败", "error");
    }
  }

  function createAnnouncementActions(item) {
    const actions = document.createElement("td");
    actions.className = "annActions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "annViewBtn";
    viewBtn.textContent = "查看详情";
    viewBtn.addEventListener("click", () => openAnnouncementDetail(item));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "annEditBtn";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => enterAnnouncementEdit(item));

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "annToggleBtn";
    toggleBtn.dataset.active = item.active ? "1" : "0";
    toggleBtn.textContent = item.active ? "下架" : "上架";
    toggleBtn.addEventListener("click", () => void toggleAnnouncement(item, toggleBtn));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "deleteBtn";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", () => void deleteAnnouncement(item));

    actions.append(viewBtn, editBtn, toggleBtn, deleteBtn);
    return actions;
  }

  // 公告详情弹窗：卡片结构与首页「公告」弹窗中的详情视图一致
  function openAnnouncementDetail(item) {
    annEls.detailBody.replaceChildren();

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "announcementDetailBack";
    backButton.textContent = "← 返回";
    backButton.addEventListener("click", closeAnnouncementDetail);

    const card = document.createElement("article");
    card.className = item.pinned ? "announcementCard announcementCardPinned" : "announcementCard";

    const title = document.createElement("strong");
    title.className = "announcementTitle";
    title.append(document.createTextNode(item.title));
    if (item.pinned) {
      const badge = document.createElement("span");
      badge.className = "announcementBadge";
      badge.textContent = "置顶";
      title.append(badge);
    }

    const content = document.createElement("p");
    content.className = "announcementContent";
    content.textContent = item.content;

    const time = document.createElement("time");
    time.className = "announcementTime";
    time.dateTime = new Date(item.createdAt).toISOString();
    time.textContent = formatTime(item.createdAt);

    card.append(title, content, time);
    annEls.detailBody.append(backButton, card);
    annEls.detailModal.classList.remove("hidden");
  }

  function closeAnnouncementDetail() {
    annEls.detailModal.classList.add("hidden");
  }

  function renderAnnouncements(items) {
    const tbody = annEls.table.querySelector("tbody");
    clearTableBody(tbody);
    for (const item of items) {
      const tr = document.createElement("tr");

      const titleCell = document.createElement("td");
      titleCell.className = "annTitleCell";
      titleCell.textContent = item.title;
      titleCell.title = item.title;

      const pinnedCell = document.createElement("td");
      pinnedCell.textContent = item.pinned ? "是" : "—";

      const statusCell = document.createElement("td");
      statusCell.textContent = item.active ? "已上架" : "已下架";

      const timeCell = document.createElement("td");
      timeCell.textContent = formatTime(item.updatedAt);

      tr.append(titleCell, pinnedCell, statusCell, timeCell, createAnnouncementActions(item));
      tbody.appendChild(tr);
    }
    if (items.length === 0) {
      addEmptyRow(annEls.table, 5, "暂无公告");
    }
  }

  function renderAnnPagination() {
    const totalPages = Math.max(1, Math.ceil(annState.total / ANNOUNCEMENT_PAGE_SIZE));
    annEls.prevButton.disabled = annState.currentPage <= 1;
    annEls.nextButton.disabled = annState.currentPage >= totalPages;
    const start = annState.total === 0 ? 0 : (annState.currentPage - 1) * ANNOUNCEMENT_PAGE_SIZE + 1;
    const end = Math.min(annState.total, annState.currentPage * ANNOUNCEMENT_PAGE_SIZE);
    annEls.pageInfo.textContent = `第 ${annState.currentPage} / ${totalPages} 页 · 共 ${annState.total} 条（显示 ${start}-${end}）`;
    annEls.totalLabel.textContent = annState.total > 0 ? `共 ${annState.total} 条公告` : "暂无公告";
  }

  async function loadAnnouncements() {
    annEls.refreshButton.disabled = true;
    setAnnStatus("正在加载…", "loading");
    const query = new URLSearchParams({
      limit: String(ANNOUNCEMENT_PAGE_SIZE),
      offset: String((annState.currentPage - 1) * ANNOUNCEMENT_PAGE_SIZE),
    });
    if (annState.status) query.set("status", annState.status);
    try {
      const data = await fetchJson(`/api/admin/announcements?${query}`);
      annState.total = Number(data?.total) || 0;
      renderAnnouncements(Array.isArray(data?.items) ? data.items : []);
      renderAnnPagination();
      setAnnStatus("");
    } catch (error) {
      renderAnnouncements([]);
      renderAnnPagination();
      setAnnStatus(error.message || "加载失败", "error");
    } finally {
      annEls.refreshButton.disabled = false;
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

  const PLAY_MODE_LABELS = {
    classic: "经典模式",
    hard: "困难挑战",
    free: "自由练习",
  };

  const analyticsState = {
    playDate: "",
  };

  const analyticsEls = {
    daysSelect: document.getElementById("anaDaysSelect"),
    playModeSelect: document.getElementById("anaPlayModeSelect"),
    playReset: document.getElementById("anaPlayReset"),
    totalVisitors: document.getElementById("anaTotalVisitors"),
    totalPlays: document.getElementById("anaTotalPlays"),
    status: document.getElementById("anaStatus"),
    dailyTable: document.getElementById("anaDailyTable"),
    playLogTable: document.getElementById("anaPlayLogTable"),
    playLogCount: document.getElementById("anaPlayLogCount"),
    playsByMode: document.getElementById("anaPlaysByMode"),
  };

  function setAnalyticsStatus(message) {
    analyticsEls.status.textContent = message || "";
  }

  function renderPlayLog(items) {
    const tbody = analyticsEls.playLogTable.querySelector("tbody");
    clearTableBody(tbody);
    buildTableRows(tbody, items.map((item) => {
      const completed = item.completed === true;
      return [
        formatTime(item.startedAt),
        PLAY_MODE_LABELS[item.mode] || item.mode,
        item.username || "—",
        completed && item.mode !== "hard" ? String(item.score) : "—",
        completed ? `${item.correctCount}/${item.questionCount}` : "—",
        completed ? `${item.accuracy.toFixed(2)}%` : "—",
        completed ? formatElapsed(item.elapsedMs) : "—",
        completed ? "已完成" : "未完成",
      ];
    }));
    if (items.length === 0) {
      addEmptyRow(analyticsEls.playLogTable, 8, "暂无游玩记录");
    }
  }

  function applyPlayResetState() {
    const hasDateFilter = Boolean(analyticsState.playDate);
    const hasModeFilter = analyticsEls.playModeSelect.value !== "all";
    analyticsEls.playReset.disabled = !hasDateFilter && !hasModeFilter;
  }

  async function loadAnalytics() {
    const days = analyticsEls.daysSelect.value;
    const mode = analyticsEls.playModeSelect.value;
    const params = new URLSearchParams({ days });
    params.set("mode", mode);
    if (analyticsState.playDate) params.set("date", analyticsState.playDate);
    setAnalyticsStatus("正在加载…");
    try {
      const data = await fetchJson(`/api/admin/analytics?${params}`);
      analyticsEls.totalVisitors.textContent = String(data.totals?.visitors ?? 0);
      analyticsEls.totalPlays.textContent = String(data.totals?.plays ?? 0);
      const playsByMode = data.totals?.playsByMode || {};
      analyticsEls.playsByMode.textContent =
        `（经典 ${playsByMode.classic ?? 0} · 困难 ${playsByMode.hard ?? 0} · 自由 ${playsByMode.free ?? 0}）`;

      const dailyTbody = analyticsEls.dailyTable.querySelector("tbody");
      clearTableBody(dailyTbody);
      buildTableRows(dailyTbody, (data.days || []).map((row) => [
        row.date,
        String(row.visitors),
        String(row.plays),
      ]));
      if (!data.days || data.days.length === 0) {
        addEmptyRow(analyticsEls.dailyTable, 3, "暂无访问数据");
      } else {
        // 高亮当前筛选的日期所在行
        for (const tr of dailyTbody.querySelectorAll("tr")) {
          if (tr.cells?.[0]?.textContent === analyticsState.playDate) {
            tr.classList.add("isActive");
          }
        }
      }

      const playLog = data.playLog || {};
      const playItems = Array.isArray(playLog.items) ? playLog.items : [];
      renderPlayLog(playItems);
      const playTotal = Number(playLog.total ?? 0);
      const limit = Number(playLog.limit ?? 0);
      const datePrefix = analyticsState.playDate ? `${analyticsState.playDate} · ` : "";
      analyticsEls.playLogCount.textContent = playTotal > 0
        ? `${datePrefix}共 ${playTotal} 条游玩记录${limit > 0 && playTotal > limit ? `，仅显示最近 ${limit} 条` : ""}`
        : analyticsState.playDate ? "该日期暂无游玩记录" : "暂无游玩记录";
      applyPlayResetState();
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
    announcements: loadAnnouncements,
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
  feedbackEls.statusFilter.addEventListener("change", () => {
    feedbackState.currentStatus = feedbackEls.statusFilter.value;
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

  annEls.refreshButton.addEventListener("click", () => void loadAnnouncements());
  annEls.detailModal.addEventListener("click", (event) => {
    // 点击遮罩空白处关闭详情弹窗
    if (event.target === annEls.detailModal) closeAnnouncementDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !annEls.detailModal.classList.contains("hidden")) {
      closeAnnouncementDetail();
    }
  });
  annEls.form.addEventListener("submit", submitAnnouncement);
  annEls.cancelEditButton.addEventListener("click", () => {
    resetAnnForm();
    setAnnMessage("已取消编辑");
  });
  annEls.resetButton.addEventListener("click", resetAnnForm);
  annEls.statusFilter.addEventListener("change", () => {
    annState.status = annEls.statusFilter.value;
    annState.currentPage = 1;
    void loadAnnouncements();
  });
  annEls.prevButton.addEventListener("click", () => {
    if (annState.currentPage > 1) {
      annState.currentPage -= 1;
      void loadAnnouncements();
    }
  });
  annEls.nextButton.addEventListener("click", () => {
    if (annState.currentPage < Math.ceil(annState.total / ANNOUNCEMENT_PAGE_SIZE)) {
      annState.currentPage += 1;
      void loadAnnouncements();
    }
  });

  leaderboardEls.refreshButton.addEventListener("click", () => void loadLeaderboard());
  leaderboardEls.modeFilter.addEventListener("change", () => void loadLeaderboardDetail());
  leaderboardEls.daySelect.addEventListener("change", () => void loadLeaderboardDetail());

  analyticsEls.daysSelect.addEventListener("change", () => {
    // 切换时间范围后清除按日期筛选，避免选中日期落在此范围之外
    analyticsState.playDate = "";
    void loadAnalytics();
  });
  analyticsEls.playModeSelect.addEventListener("change", () => void loadAnalytics());
  analyticsEls.playReset.addEventListener("click", () => {
    analyticsState.playDate = "";
    analyticsEls.playModeSelect.value = "all";
    void loadAnalytics();
  });
  // 点击每日趋势中的日期，将游玩日志筛选到当天
  analyticsEls.dailyTable.querySelector("tbody").addEventListener("click", (event) => {
    const row = event.target.closest("tr");
    const date = row?.cells?.[0]?.textContent?.trim() || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    analyticsState.playDate = date;
    void loadAnalytics();
  });

  // 初始化
  populateDaySelect();
  loadedModules.add("feedback");
  void loadFeedback();
})();
