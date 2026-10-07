(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const stepKey = $("step-key");
  const stepName = $("step-name");
  const stepLimit = $("step-limit");
  const banner = $("banner");
  const keyInput = $("key");
  const deviceInput = $("device");

  let licenseKey = "";
  let supportEmail = "";

  // --- helpers ---------------------------------------------------------------

  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
      return { status: res.status, data };
    } catch (_) {
      return { status: 0, data: { error: "network", message: "Can't reach the server. Check your connection and try again." } };
    }
  }

  function show(step) {
    for (const el of [stepKey, stepName, stepLimit]) el.hidden = el !== step;
  }

  function say(message, kind) {
    banner.textContent = message || "";
    banner.className = "banner" + (kind === "info" ? " info" : "");
    banner.hidden = !message;
  }

  function busy(button, on, label) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = on;
    button.textContent = on ? label || "Working…" : button.dataset.label;
  }

  /** "Chrome on Mac" style default name for this browser. */
  function guessDeviceName() {
    const ua = navigator.userAgent || "";
    const uaData = navigator.userAgentData;
    let browser = "Browser";
    if (/Edg(e|A|iOS)?\//.test(ua)) browser = "Edge";
    else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
    else if (/Firefox\/|FxiOS\//.test(ua)) browser = "Firefox";
    else if (/CriOS\/|Chrome\//.test(ua)) browser = "Chrome";
    else if (/Safari\//.test(ua)) browser = "Safari";

    let os = "";
    if (/iPhone/.test(ua)) os = "iPhone";
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) os = "iPad";
    else if (/Android/.test(ua)) os = "Android";
    else if (/CrOS/.test(ua)) os = "Chromebook";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Mac OS X|Macintosh/.test(ua)) os = "Mac";
    else if (/Linux/.test(ua)) os = "Linux";
    else if (uaData && uaData.platform) os = uaData.platform;

    return os ? `${browser} on ${os}` : browser;
  }

  const REASONS = {
    session_expired: "Your session has ended. Please enter your license key again.",
    no_session: "",
    revoked: "Access to this report has been removed for this license key.",
    disabled: "This license key has been disabled. Please contact support.",
    expired: "This license key has expired.",
    refunded: "This order was refunded, so access has been removed.",
    device_removed: "This device was removed from your license key. Enter your key to add it again.",
    validation_unavailable: "We couldn't verify your license just now. Please try again in a moment.",
    wrong_product: "That license key isn't for this report.",
    invalid_key: "That license key wasn't recognised.",
  };

  // --- device list (limit screen) --------------------------------------------

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function renderLimit(data) {
    const list = $("device-list");
    list.textContent = "";
    const canRemove = (data.removalsLeft ?? 0) > 0;
    supportEmail = data.supportEmail || supportEmail;

    $("limit-message").textContent =
      data.message || "This license key is already active on the maximum number of devices.";

    for (const d of data.devices || []) {
      const li = document.createElement("li");
      const info = document.createElement("div");
      const name = document.createElement("div");
      name.className = "dev-name";
      name.textContent = d.name || "Unnamed device";
      const meta = document.createElement("div");
      meta.className = "dev-meta";
      meta.textContent = d.createdAt ? `Added ${fmtDate(d.createdAt)}` : "";
      info.append(name, meta);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small danger";
      btn.textContent = "Remove";
      btn.setAttribute("aria-label", `Remove device ${d.name || ""}`.trim());
      btn.disabled = !canRemove;
      btn.addEventListener("click", () => removeDevice(d, btn));

      li.append(info, btn);
      list.append(li);
    }

    const note = $("removal-note");
    const support = $("support-note");
    if (canRemove) {
      note.textContent = `Remove a device to free up a slot. You can remove up to ${data.maxRemovals} devices per key every ${data.windowDays} days (${data.removalsLeft} left).`;
      support.hidden = true;
    } else {
      note.textContent = "";
      support.hidden = false;
      support.textContent = "You've used all your device removals for this period. Please contact support" + (supportEmail ? ` at ${supportEmail}.` : ".");
    }

    // A slot is free once the list is shorter than the limit.
    const hasRoom = typeof data.limit === "number" ? (data.devices || []).length < data.limit : false;
    $("limit-activate").hidden = !hasRoom;
    show(stepLimit);
  }

  let lastLimit = null;

  async function removeDevice(device, btn) {
    if (!window.confirm(`Remove "${device.name || "this device"}" from your license key?`)) return;
    btn.disabled = true;
    say("");
    const { status, data } = await post("/api/deactivate", { instance_id: device.id });
    if (data.ok) {
      lastLimit = { ...lastLimit, devices: data.devices, removalsLeft: data.removalsLeft, maxRemovals: data.maxRemovals, windowDays: data.windowDays, supportEmail: data.supportEmail, message: "Device removed. You can now activate this device." };
      renderLimit(lastLimit);
      return;
    }
    if (status === 429 && data.error === "removal_limit") {
      lastLimit = { ...lastLimit, removalsLeft: 0, supportEmail: data.supportEmail || supportEmail };
      renderLimit(lastLimit);
      say(data.message);
      return;
    }
    btn.disabled = false;
    say(data.message || "That device couldn't be removed.");
  }

  // --- flow --------------------------------------------------------------------

  async function activate(button, labelWhileBusy) {
    busy(button, true, labelWhileBusy);
    say("");
    const body = { license_key: licenseKey, instance_name: deviceInput.value };
    const { status, data } = await post("/api/activate", body);
    busy(button, false);

    if (data.ok) {
      window.location.assign("/read");
      return;
    }
    if (status === 409 && data.error === "device_limit") {
      lastLimit = data;
      renderLimit(data);
      return;
    }
    if (data.error === "name_required") {
      deviceInput.value = deviceInput.value || guessDeviceName();
      show(stepName);
      say(data.message);
      return;
    }
    say(data.message || "Something went wrong. Please try again.");
  }

  stepKey.addEventListener("submit", async (e) => {
    e.preventDefault();
    licenseKey = keyInput.value.trim();
    if (!licenseKey) {
      say("Please paste your license key.");
      keyInput.focus();
      return;
    }
    const btn = $("key-submit");
    busy(btn, true, "Checking…");
    say("");
    const { data } = await post("/api/license/check", { license_key: licenseKey });
    busy(btn, false);

    if (!data.ok) {
      say(data.message || "That license key couldn't be checked.");
      return;
    }
    if (data.knownDevice) {
      // This browser already has an activation for this key: no name needed.
      await activate(btn, "Opening…");
      return;
    }
    deviceInput.value = guessDeviceName();
    show(stepName);
    deviceInput.focus();
    deviceInput.select();
  });

  stepName.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!deviceInput.value.trim()) {
      say("Please give this device a name.");
      deviceInput.focus();
      return;
    }
    activate($("name-submit"), "Activating…");
  });

  function restart() {
    licenseKey = "";
    keyInput.value = "";
    say("");
    show(stepKey);
    keyInput.focus();
  }
  $("name-back").addEventListener("click", restart);
  $("limit-back").addEventListener("click", restart);
  $("limit-activate").addEventListener("click", () => activate($("limit-activate"), "Activating…"));

  // --- init --------------------------------------------------------------------

  (async function init() {
    // A key can arrive from checkout / the receipt email as #key=... (never sent to servers)
    // or ?key=... ; use it to prefill, then scrub it from the address bar.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    const incoming = hash.get("key") || query.get("key");
    const reason = query.get("reason");
    if (incoming) keyInput.value = incoming.trim();
    if (incoming || reason) history.replaceState(null, "", window.location.pathname);

    if (reason && REASONS[reason]) say(REASONS[reason], reason === "session_expired" ? "info" : undefined);

    try {
      const res = await fetch("/api/config", { credentials: "same-origin" });
      const cfg = await res.json();
      if (cfg.title) {
        $("title").textContent = cfg.title;
        document.title = `${cfg.title} - Sign in`;
      }
      supportEmail = cfg.supportEmail || "";
    } catch (_) { /* cosmetic only */ }

    keyInput.focus();
  })();
})();
