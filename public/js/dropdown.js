"use strict";

/*
 * 自定义下拉框组件：
 * 把带 data-afq-select 的原生 <select> 包装成与页面风格一致的自定义下拉。
 * 原生 select 仍保留在 DOM 中（display:none）作为数据源与表单状态，
 * 因此现有代码读取 .value、监听 change、动态增删 option 都无需改动。
 */
(function () {
  const CHEVRON_SVG =
    '<svg class="afq-select__chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let activeSelect = null;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    const selects = document.querySelectorAll("select[data-afq-select]");
    if (!selects.length) return;
    selects.forEach(enhanceSelect);
    document.addEventListener("pointerdown", (event) => {
      if (
        activeSelect
        && !activeSelect.wrapper.contains(event.target)
        && !activeSelect.panel.contains(event.target)
      ) {
        closeSelect();
      }
    }, true);
    window.addEventListener("blur", closeSelect);
    // 面板脱离滚动容器后，滚动/缩放时保持与触发器对齐
    document.addEventListener("scroll", repositionActive, true);
    window.addEventListener("resize", repositionActive);
  }

  function enhanceSelect(select) {
    const wrapper = document.createElement("span");
    wrapper.className = "afq-select";
    select.classList.add("afq-select__native");
    select.setAttribute("aria-hidden", "true");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "afq-select__trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const valueEl = document.createElement("span");
    valueEl.className = "afq-select__value";
    trigger.append(valueEl);
    trigger.insertAdjacentHTML("beforeend", CHEVRON_SVG);

    const panel = document.createElement("div");
    panel.className = "afq-select__panel";
    panel.setAttribute("role", "listbox");
    panel.tabIndex = -1;
    panel.hidden = true;

    select.parentNode.insertBefore(wrapper, select);
    wrapper.append(trigger, panel, select);

    const label = deriveLabel(select);
    renderOptions(select, panel);
    syncTrigger(select, trigger, valueEl, label);

    // 拦截程序化的 .value 写入，保证触发器文本始终与原生值同步
    const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        return valueDescriptor.get.call(this);
      },
      set(nextValue) {
        valueDescriptor.set.call(this, nextValue);
        syncTrigger(select, trigger, valueEl, label);
      },
    });

    // 脚本动态增删 option（如图库年份选项）时自动重建列表
    const observer = new MutationObserver(() => {
      renderOptions(select, panel);
      syncTrigger(select, trigger, valueEl, label);
    });
    observer.observe(select, { childList: true });

    trigger.addEventListener("click", () => {
      if (activeSelect && activeSelect.wrapper === wrapper) {
        closeSelect();
      } else {
        openSelect({ wrapper, trigger, panel, select, valueEl, label });
      }
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openSelect({ wrapper, trigger, panel, select, valueEl, label });
        focusOption(panel, select, event.key === "ArrowUp" ? "last" : "selected");
      }
    });

    panel.addEventListener("pointerdown", (event) => {
      const option = event.target.closest(".afq-select__option");
      if (!option) return;
      event.preventDefault();
      chooseValue(select, panel, option.dataset.value);
    });

    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSelect(trigger);
        return;
      }
      if (event.key === "Tab") {
        closeSelect();
        return;
      }
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        const options = panel.querySelectorAll(".afq-select__option");
        if (!options.length) return;
        let index = Array.prototype.indexOf.call(options, document.activeElement);
        if (event.key === "ArrowDown") index = Math.min(index + 1, options.length - 1);
        else if (event.key === "ArrowUp") index = Math.max(index - 1, 0);
        else if (event.key === "Home") index = 0;
        else if (event.key === "End") index = options.length - 1;
        else {
          if (index >= 0) chooseValue(select, panel, options[index].dataset.value);
          return;
        }
        options[index]?.focus();
      }
    });
  }

  function openSelect(state) {
    closeSelect();
    activeSelect = state;
    state.trigger.setAttribute("aria-expanded", "true");
    state.wrapper.classList.add("is-open");
    // 面板挂到 body 并固定定位，避免被滚动容器裁剪或带起滚动造成抖动
    if (state.panel.parentElement !== document.body) {
      document.body.appendChild(state.panel);
    }
    positionPanel(state);
    state.panel.hidden = false;
  }

  function positionPanel(state) {
    const rect = state.trigger.getBoundingClientRect();
    const style = state.panel.style;
    style.position = "fixed";
    style.left = "auto";
    // 用不含滚动条的视口宽度计算，与 getBoundingClientRect 坐标系一致，避免右对齐时整体左移
    style.right = `${Math.max(0, document.documentElement.clientWidth - rect.right)}px`;
    style.top = `${rect.bottom + 6}px`;
    style.minWidth = `${rect.width}px`;
    style.width = "max-content";
    style.maxWidth = "280px";
    style.maxHeight = `${Math.max(120, Math.min(248, window.innerHeight - rect.bottom - 18))}px`;
    style.zIndex = "200";
  }

  function repositionActive() {
    if (activeSelect) positionPanel(activeSelect);
  }

  function closeSelect(returnFocusTo) {
    if (!activeSelect) return;
    activeSelect.trigger.setAttribute("aria-expanded", "false");
    activeSelect.wrapper.classList.remove("is-open");
    activeSelect.panel.hidden = true;
    if (returnFocusTo) returnFocusTo.focus({ preventScroll: true });
    activeSelect = null;
  }

  function chooseValue(select, panel, value) {
    select.value = value;
    markSelected(select, panel);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    closeSelect();
  }

  function renderOptions(select, panel) {
    const fragment = document.createDocumentFragment();
    for (const option of select.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "afq-select__option";
      button.dataset.value = option.value;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", option.selected ? "true" : "false");
      button.textContent = option.textContent;
      if (option.selected) button.classList.add("is-selected");
      fragment.append(button);
    }
    panel.replaceChildren(fragment);
  }

  function markSelected(select, panel) {
    const currentValue = String(select.value);
    panel.querySelectorAll(".afq-select__option").forEach((button) => {
      const isSelected = button.dataset.value === currentValue;
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-selected", isSelected ? "true" : "false");
    });
  }

  function syncTrigger(select, trigger, valueEl, label) {
    const option = select.options[select.selectedIndex];
    const text = option ? option.textContent : select.value || "";
    valueEl.textContent = text;
    if (label) trigger.setAttribute("aria-label", `${label}：${text}`);
  }

  function focusOption(panel, select, position) {
    const options = panel.querySelectorAll(".afq-select__option");
    if (!options.length) return;
    let index = position === "last" ? options.length - 1 : select.selectedIndex;
    if (index < 0 || index >= options.length) index = 0;
    options[index]?.focus();
  }

  function deriveLabel(select) {
    if (select.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
      if (forLabel) return forLabel.textContent.trim();
    }
    const wrappingLabel = select.closest("label");
    if (wrappingLabel) {
      const directSpan = wrappingLabel.querySelector(":scope > span");
      if (directSpan) return directSpan.textContent.trim();
    }
    return select.getAttribute("aria-label") || "";
  }
})();
