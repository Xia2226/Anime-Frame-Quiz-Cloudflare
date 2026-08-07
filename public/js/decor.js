/*
  页面装饰脚本：飘落花瓣/星尘粒子、结算撒花、滚动进度条、
  回到顶部、中二加载文案。纯原生实现，不依赖第三方库，
  并通过 window.Decor 暴露接口供页面模块调用。
*/
(function () {
  "use strict";

  const REDUCED_MOTION = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const LOADING_FLAVORS = [
    "正在唤醒沉睡的二次元之门…",
    "正在把截图从异世界拉回来…",
    "正在与次元之壁建立连接…",
    "正在召唤番剧精灵…",
    "灵力注入中，请稍候…",
    "正在解码命运的截图…",
    "正在穿过次元裂缝…",
    "正在翻找次元仓库…",
    "屏幕前的你，准备好战斗了吗…",
    "正在加载今日份的二次元能量…",
  ];

  /* ========== 滚动进度条 + 回到顶部 ========== */

  function setupScrollDecor() {
    const bar = document.createElement("div");
    bar.className = "decorProgressBar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    bar.appendChild(fill);
    document.body.appendChild(bar);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "decorTopButton";
    button.setAttribute("aria-label", "回到顶部");
    button.title = "回到顶部";
    button.textContent = "↑";
    button.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? "auto" : "smooth" });
    });
    document.body.appendChild(button);

    let ticking = false;
    function update() {
      ticking = false;
      const maximum = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const ratio = Math.min(1, window.scrollY / maximum);
      fill.style.width = `${Math.round(ratio * 100)}%`;
      button.classList.toggle("visible", window.scrollY > 360);
    }
    function requestUpdate() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate, { passive: true });
    requestUpdate();
  }

  /* ========== 中二加载文案 ========== */

  let lastFlavorIndex = -1;
  function refreshLoadingFlavor() {
    const element = document.getElementById("loadingFlavor");
    if (!element) return;
    let index;
    do {
      index = Math.floor(Math.random() * LOADING_FLAVORS.length);
    } while (index === lastFlavorIndex && LOADING_FLAVORS.length > 1);
    lastFlavorIndex = index;
    element.textContent = LOADING_FLAVORS[index];
  }

  /* ========== 飘落花瓣 / 星尘粒子（仅首页） ========== */

  const PETAL_COLORS = [
    "rgba(244,143,177,0.85)",
    "rgba(255,183,197,0.8)",
    "rgba(230,200,255,0.8)",
    "rgba(255,214,165,0.8)",
  ];
  const DUST_COLORS = [
    "rgba(255,255,255,0.9)",
    "rgba(173,216,255,0.85)",
    "rgba(255,231,186,0.9)",
  ];

  let petalsState = null;

  function setupPetals() {
    if (REDUCED_MOTION || petalsState) return;
    if (!document.body.classList.contains("decor-petals")) return;
    const canvas = document.createElement("canvas");
    canvas.className = "decorPetalsCanvas";
    canvas.setAttribute("aria-hidden", "true");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    document.body.appendChild(canvas);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const particles = [];
    let width = 0;
    let height = 0;
    let targetCount = 24;
    let raf = null;
    let running = false;
    let last = 0;

    function pick(items) {
      return items[Math.floor(Math.random() * items.length)];
    }

    function spawn(initial) {
      const isDust = Math.random() < 0.35;
      particles.push({
        type: isDust ? "dust" : "petal",
        x: Math.random() * width,
        y: initial ? Math.random() * height : -20 - Math.random() * 60,
        size: isDust ? 1.5 + Math.random() * 2.5 : 4 + Math.random() * 5,
        speedY: isDust ? 0.15 + Math.random() * 0.35 : 0.35 + Math.random() * 0.65,
        drift: isDust ? 0 : (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.5),
        phase: Math.random() * Math.PI * 2,
        phaseSpeed: 0.01 + Math.random() * 0.02,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.03,
        opacity: isDust ? 0.35 + Math.random() * 0.5 : 0.4 + Math.random() * 0.45,
        color: isDust ? pick(DUST_COLORS) : pick(PETAL_COLORS),
      });
    }

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      targetCount = Math.min(60, Math.max(18, Math.round((width * height) / 26000)));
      if (particles.length > targetCount) particles.length = targetCount;
      while (particles.length < targetCount) spawn(true);
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min(3, Math.max(0.5, (now - last) / 16.7));
      last = now;
      ctx.clearRect(0, 0, width, height);
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.phase += particle.phaseSpeed * dt;
        particle.x += particle.drift * dt + Math.sin(particle.phase) * 0.4 * dt;
        particle.y += particle.speedY * dt;
        particle.rotation += particle.spin * dt;
        if (particle.type === "petal") {
          ctx.save();
          ctx.translate(particle.x, particle.y);
          ctx.rotate(particle.rotation);
          ctx.globalAlpha = particle.opacity;
          ctx.fillStyle = particle.color;
          ctx.beginPath();
          ctx.ellipse(0, 0, particle.size, particle.size * 0.62, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          ctx.globalAlpha = particle.opacity * (0.5 + 0.5 * Math.sin(particle.phase * 2));
          ctx.fillStyle = particle.color;
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          ctx.fill();
        }
        if (particle.y > height + 30) particles.splice(index, 1);
      }
      while (particles.length < targetCount) spawn(false);
      raf = window.requestAnimationFrame(frame);
    }

    function start() {
      if (running) return;
      running = true;
      last = performance.now();
      raf = window.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (raf !== null) {
        window.cancelAnimationFrame(raf);
        raf = null;
      }
      ctx.clearRect(0, 0, width, height);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stop();
      else if (running === false) start();
    }, { passive: true });

    window.addEventListener("resize", resize, { passive: true });
    resize();
    start();

    petalsState = { stop, canvas };
  }

  /* ========== 结算撒花 ========== */

  const CONFETTI_COLORS = [
    "#4f6df5", "#8b5cf6", "#f43f5e", "#f59e0b",
    "#10b981", "#0891b2", "#f472b6", "#facc15",
  ];
  let confettiLayer = null;

  function burstConfetti() {
    if (REDUCED_MOTION) return;
    let canvas = null;
    if (!confettiLayer) {
      const created = document.createElement("canvas");
      created.className = "decorConfettiCanvas";
      created.setAttribute("aria-hidden", "true");
      const createdCtx = created.getContext("2d");
      if (!createdCtx) return;
      created.__afqCtx = createdCtx;
      document.body.appendChild(created);
      confettiLayer = created;
    }
    canvas = confettiLayer;
    const ctx = canvas.__afqCtx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const count = Math.min(140, Math.max(70, Math.round(width / 10)));
    const originX = width / 2 + (Math.random() - 0.5) * width * 0.3;
    const pieces = [];
    for (let index = 0; index < count; index += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 7 + Math.random() * 11;
      pieces.push({
        x: originX + (Math.random() - 0.5) * 60,
        y: height + 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 5 + Math.random() * 7,
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.4,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        life: 0,
        maxLife: 120 + Math.random() * 90,
        wobble: Math.random() * Math.PI * 2,
      });
    }

    let raf = null;
    let last = performance.now();
    function step(now) {
      const dt = Math.min(3, Math.max(0.5, (now - last) / 16.7));
      last = now;
      ctx.clearRect(0, 0, width, height);
      let alive = 0;
      for (const piece of pieces) {
        piece.life += dt;
        if (piece.life >= piece.maxLife) continue;
        alive += 1;
        piece.wobble += 0.08 * dt;
        piece.vx *= 0.985;
        piece.vy += 0.25 * dt;
        piece.x += piece.vx * dt;
        piece.y += piece.vy * dt + Math.sin(piece.wobble) * 1.2;
        piece.rotation += piece.spin * dt;
        const alpha = Math.max(0, 1 - piece.life / piece.maxLife);
        ctx.save();
        ctx.translate(piece.x, piece.y);
        ctx.rotate(piece.rotation);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = piece.color;
        ctx.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
        ctx.restore();
      }
      if (alive > 0) {
        raf = window.requestAnimationFrame(step);
      } else {
        ctx.clearRect(0, 0, width, height);
        raf = null;
      }
    }
    if (raf !== null) window.cancelAnimationFrame(raf);
    raf = window.requestAnimationFrame(step);
  }

  /* ========== 初始化 ========== */

  window.Decor = Object.freeze({
    burstConfetti,
    refreshLoadingFlavor,
  });

  function init() {
    setupScrollDecor();
    setupPetals();
    refreshLoadingFlavor();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
