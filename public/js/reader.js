(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const img = $("page");
  const wrap = $("page-wrap");
  const status = $("status");
  const stage = $("stage");
  const jump = $("jump");
  const prevBtn = $("prev");
  const nextBtn = $("next");

  let total = 1;
  let current = 1;
  let me = null;
  let loadToken = 0;

  // Small cache of page blobs (current +/- 1). Object URLs live only in this tab's memory.
  const cache = new Map(); // n -> objectURL
  const inflight = new Map(); // n -> Promise<objectURL>

  // --- messages -----------------------------------------------------------------

  let toastTimer = 0;
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  const BLOCKED_MSG = "Saving, copying and printing are disabled. Each page carries your name, email and order number.";

  function showStatus(message, isError) {
    status.textContent = message;
    status.className = "status" + (isError ? " error" : "");
    status.hidden = !message;
  }

  function toSignIn(reason) {
    window.location.replace("/?reason=" + encodeURIComponent(reason || "session_expired"));
  }

  // --- page loading --------------------------------------------------------------

  async function fetchPage(n) {
    if (cache.has(n)) return cache.get(n);
    if (inflight.has(n)) return inflight.get(n);

    const p = (async () => {
      const res = await fetch("/api/pages/" + n, { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        let reason = "session_expired";
        try { reason = (await res.json()).error || reason; } catch (_) { /* ignore */ }
        const err = new Error("auth"); err.reason = reason; throw err;
      }
      if (res.status === 429) { const err = new Error("slow"); err.slow = true; throw err; }
      if (!res.ok) throw new Error("load");
      const url = URL.createObjectURL(await res.blob());
      cache.set(n, url);
      return url;
    })();

    inflight.set(n, p);
    try { return await p; } finally { inflight.delete(n); }
  }

  function trimCache(keep) {
    for (const [n, url] of cache) {
      if (!keep.includes(n)) { URL.revokeObjectURL(url); cache.delete(n); }
    }
  }

  async function go(n, { fromHash } = {}) {
    n = Math.min(Math.max(parseInt(n, 10) || 1, 1), total);
    const token = ++loadToken;
    current = n;
    jump.value = String(n);
    prevBtn.disabled = n <= 1;
    nextBtn.disabled = n >= total;
    if (!fromHash) history.replaceState(null, "", "#p=" + n);

    if (!cache.has(n)) { wrap.hidden = true; showStatus("Loading page " + n + "…"); }

    try {
      const url = await fetchPage(n);
      if (token !== loadToken) return; // user already moved on
      img.src = url;
      await (img.decode ? img.decode().catch(() => {}) : Promise.resolve());
      if (token !== loadToken) return;
      showStatus("");
      wrap.hidden = false;
      stage.scrollTop = 0;
      trimCache([n - 1, n, n + 1]);
      // Warm the neighbours so turning pages feels instant.
      if (n < total) fetchPage(n + 1).catch(() => {});
      if (n > 1) fetchPage(n - 1).catch(() => {});
    } catch (err) {
      if (token !== loadToken) return;
      if (err.reason) return toSignIn(err.reason);
      wrap.hidden = true;
      showStatus(err.slow ? "You're going through pages quickly. Wait a moment, then try again." : "This page couldn't be loaded. Check your connection and try again.", true);
    }
  }

  // --- navigation ------------------------------------------------------------------

  prevBtn.addEventListener("click", () => go(current - 1));
  nextBtn.addEventListener("click", () => go(current + 1));
  jump.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(jump.value); jump.blur(); } });
  jump.addEventListener("change", () => go(jump.value));
  jump.addEventListener("focus", () => jump.select());

  window.addEventListener("hashchange", () => {
    const m = /p=(\d+)/.exec(window.location.hash);
    if (m && Number(m[1]) !== current) go(m[1], { fromHash: true });
  });

  document.addEventListener("keydown", (e) => {
    const typing = e.target === jump || (e.target && e.target.tagName === "INPUT");

    // Deterrents: save, print, view-source, select-all, copy, cut.
    if ((e.ctrlKey || e.metaKey) && /^[psuacx]$/i.test(e.key)) {
      if (!typing || /^[ps]$/i.test(e.key)) { e.preventDefault(); toast(BLOCKED_MSG); }
      return;
    }
    if (typing || e.altKey || e.ctrlKey || e.metaKey) return;

    switch (e.key) {
      case "ArrowRight": case "PageDown": case "ArrowDown":
        if (e.key === "ArrowDown" && stage.scrollTop + stage.clientHeight < stage.scrollHeight - 4) return; // let it scroll
        e.preventDefault(); go(current + 1); break;
      case "ArrowLeft": case "PageUp": case "ArrowUp":
        if (e.key === "ArrowUp" && stage.scrollTop > 4) return;
        e.preventDefault(); go(current - 1); break;
      case "Home": e.preventDefault(); go(1); break;
      case "End": e.preventDefault(); go(total); break;
      default: break;
    }
  });

  // PrintScreen can't be blocked; clearing the clipboard is a best-effort deterrent.
  document.addEventListener("keyup", (e) => {
    if (e.key === "PrintScreen") {
      try { navigator.clipboard && navigator.clipboard.writeText(""); } catch (_) { /* ignore */ }
      toast(BLOCKED_MSG);
    }
  });

  // Swipe to turn pages on touch devices (ignored while pinch-zoomed).
  let t0 = null;
  stage.addEventListener("touchstart", (e) => {
    const zoomed = window.visualViewport && window.visualViewport.scale > 1.05;
    t0 = e.touches.length === 1 && !zoomed ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (!t0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Date.now() - t0.t < 700) go(current + (dx < 0 ? 1 : -1));
    t0 = null;
  }, { passive: true });

  // --- deterrents (the watermark is the real protection) -----------------------------

  const block = (e) => {
    if (e.target && e.target.tagName === "INPUT") return;
    e.preventDefault();
    toast(BLOCKED_MSG);
  };
  document.addEventListener("contextmenu", block);
  document.addEventListener("copy", block);
  document.addEventListener("cut", block);
  document.addEventListener("dragstart", block);
  document.addEventListener("selectstart", (e) => { if (!(e.target && e.target.tagName === "INPUT")) e.preventDefault(); });
  window.addEventListener("beforeprint", () => toast(BLOCKED_MSG));

  // --- devices panel ---------------------------------------------------------------------

  const panel = $("devices-panel");

  async function api(url, body) {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* ignore */ }
    return { status: res.status, data };
  }

  function renderDevices(data) {
    const list = $("device-list");
    list.textContent = "";
    const canRemove = (data.removalsLeft ?? 0) > 0;

    for (const d of data.devices || []) {
      const li = document.createElement("li");
      const info = document.createElement("div");
      const name = document.createElement("div");
      name.className = "dev-name";
      name.textContent = d.name || "Unnamed device";
      if (d.current) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "This device";
        name.append(badge);
      }
      const meta = document.createElement("div");
      meta.className = "dev-meta";
      const dt = new Date(d.createdAt);
      meta.textContent = isNaN(dt) ? "" : "Added " + dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      info.append(name, meta);
      li.append(info);

      if (!d.current) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn small danger";
        btn.textContent = "Remove";
        btn.disabled = !canRemove;
        btn.addEventListener("click", async () => {
          if (!window.confirm('Remove "' + (d.name || "this device") + '" from your license key?')) return;
          btn.disabled = true;
          const r = await api("/api/deactivate", { instance_id: d.id });
          if (r.data.ok) return renderDevices(r.data);
          if (r.status === 429) return renderDevices({ ...data, removalsLeft: 0, supportEmail: r.data.supportEmail || data.supportEmail });
          btn.disabled = false;
          toast(r.data.message || "That device couldn't be removed.");
        });
        li.append(btn);
      }
      list.append(li);
    }

    $("devices-note").textContent = canRemove
      ? "You can remove up to " + data.maxRemovals + " devices per key every " + data.windowDays + " days (" + data.removalsLeft + " left)."
      : "";
    const support = $("devices-support");
    support.hidden = canRemove;
    if (!canRemove) support.textContent = "You've used all your device removals for this period. Please contact support" + (data.supportEmail ? " at " + data.supportEmail + "." : ".");
  }

  $("devices-btn").addEventListener("click", async () => {
    panel.hidden = false;
    $("device-list").textContent = "Loading…";
    const r = await api("/api/devices");
    if (r.status === 401) return toSignIn("session_expired");
    renderDevices(r.data);
  });
  $("devices-close").addEventListener("click", () => { panel.hidden = true; });
  panel.addEventListener("click", (e) => { if (e.target === panel) panel.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") panel.hidden = true; });

  $("logout").addEventListener("click", async () => {
    await api("/api/logout", {});
    window.location.replace("/");
  });

  // --- init -----------------------------------------------------------------------------------

  (async function init() {
    try {
      const r = await api("/api/me");
      if (r.status === 401 || r.status === 403) return toSignIn(r.data.error);
      if (!r.data.pages) throw new Error("bad");
      me = r.data;
    } catch (_) {
      return showStatus("The report couldn't be opened. Please reload the page.", true);
    }

    total = me.pages;
    $("doc-title").textContent = me.title;
    document.title = me.title;
    $("licensee").textContent = "Licensed to " + me.name;
    $("total").textContent = "/ " + total;

    const m = /p=(\d+)/.exec(window.location.hash);
    go(m ? m[1] : 1, { fromHash: true });
    stage.focus({ preventScroll: true });
  })();
})();
