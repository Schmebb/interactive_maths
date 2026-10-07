// Anonymous visit counter for the admin page (/Interactive/Admin/).
// Sends: which page, the referring site, screen width, a random browser id, and
// how long the tab was visible + how many clicks/key presses happened. Nothing else.
(() => {
  if (navigator.webdriver) return;
  const rand = () =>
    crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  let vid;
  try {
    vid = localStorage.getItem("mam103x_vid");
    if (!vid) localStorage.setItem("mam103x_vid", (vid = rand()));
  } catch {
    vid = rand();
  }
  const id = rand();
  const send = (url, data) => {
    const body = JSON.stringify(data);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
    } catch {}
    fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
  };

  send("/Interactive/api/hit", { id, vid, path: location.pathname, ref: document.referrer, w: innerWidth });

  let visibleSince = document.visibilityState === "visible" ? performance.now() : null;
  let visible = 0, acts = 0;
  addEventListener("pointerdown", () => acts++, { capture: true, passive: true });
  addEventListener("keydown", () => acts++, { capture: true, passive: true });

  const report = () => {
    if (visibleSince !== null) { visible += performance.now() - visibleSince; visibleSince = null; }
    send("/Interactive/api/leave", { id, dur: Math.round(visible / 1000), act: acts });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") report();
    else visibleSince = performance.now();
  });
  addEventListener("pagehide", report);
})();
