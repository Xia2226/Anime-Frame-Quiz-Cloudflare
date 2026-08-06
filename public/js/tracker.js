(() => {
  "use strict";
  // 访问统计埋点：页面加载时上报一次，失败不影响页面功能
  const payload = JSON.stringify({ path: location.pathname });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/track",
        new Blob([payload], { type: "application/json" }),
      );
    } else {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // 忽略埋点错误
  }
})();
