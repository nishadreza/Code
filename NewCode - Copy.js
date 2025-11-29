// ==UserScript==
// @name         APPINFO → PAYNOW (guarded, dynamic routes + live token, Turnstile in iframes)CSSS_New2  (with PayCtx persist + 5xx retry)_V4 [NO-RESOLVER] + Quick Actions
// @namespace    ivac-helper
// @version      4.1.2
// @description  App/Personal/Overview + checkout/otp/slots/pay. Application, Personal & Overview use /application server actions. Checkout/OTP/slots/pay use legacy /api/v2/* JSON routes.
// @match        https://payment.ivacbd.com/*
// @exclude-match https://payment.ivacbd.com/cdn-cgi/challenge-platform/*
// @exclude-match https://payment.ivacbd.com/*?*__cf_chl_*
// @exclude-match https://payment.ivacbd.com/*&__cf_chl_*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ---------- CONSTANTS ----------
  const API_BASE = "https://payment.ivacbd.com";
  const LS_TOKEN_KEY = "access_token";
  const TOKEN_SYNC_MS = 1000;
  const REQ_TIMEOUT_MS = 15000;

  // Pay context persistence key (so reloads don't lose selections)
  const PAY_CTX_KEY = "tm_pay_ctx_v1";
  const MIN_KEY = "tm_ivac_min";
  const IP_LS_KEY = "tm_ivac_client_ip";

  // Turnstile for payment.ivacbd.com
  const PAY_TS_SITEKEY = "0x4AAAAAABvQ3Mi6RktCuZ7P";
  const APP_TS_SITEKEY = PAY_TS_SITEKEY;
  const PAY_TS_API =
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

  // --- FIXED ROUTES + TOKEN FIELD NAMES ---
  const APP_SUBMIT_PATH = "/application"; // server actions: Application, Personal, Overview
  const APP_TOKEN_KEY = "y6e7uk_token_t6d8n3"; // Turnstile token field for Application

  // Legacy JSON pay-now endpoint
  const PAY_NOW_PATH = "/api/v2/payment/h7j3wt-now-y0k3d6";
  const PAY_TOKEN_KEY = "k5t0g8_token_y4v9f6"; // pay-now token key

  // --- Server Action IDs (from HAR) ---
  const APP_ACTION_ID_APPLICATION_INFO =
    "70377b6e06ac0b9b4ffe55dbae6a64786750c62482";
  const APP_ACTION_ID_PERSONAL_INFO =
    "706597cd5e9803020d2c67c2d54323975b19fff992";
  const APP_ACTION_ID_OVERVIEW = "609be894c11698a9fdc88b9c6f9fa821916c7fb66d";

  // Next router state tree (exactly as captured from HAR/curl)
  const APP_ROUTER_STATE_TREE_ENC =
    "%5B%22%22%2C%7B%22children%22%3A%5B%22(root)%22%2C%7B%22children%22%3A%5B%22application%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D";

  // -------------------------------------------------------------

  // Separate postMessage channels so tokens don't collide
  const CHAN_PAY = "ivac#pay#" + Math.random().toString(36).slice(2);
  const CHAN_APP = "ivac#app#" + Math.random().toString(36).slice(2);

  // ---------- CF / CSP GUARD ----------
  function isCFChallengePage() {
    try {
      if (/[?&]__cf_chl(_tk|js_[a-z]+)?=/.test(location.search)) return true;
      if (/\/cdn-cgi\/challenge-platform/.test(location.pathname)) return true;
      if (/Just a moment/i.test(document.title)) return true;
      if (document.querySelector("#challenge-form, #cf-spinner-please-wait"))
        return true;
      if (document.querySelector('iframe[src*="challenges.cloudflare.com"]'))
        return true;
    } catch {}
    return false;
  }
  function guardConnect(opLabel = "request") {
    if (!navigator.onLine)
      throw new Error("You are offline — cannot send " + opLabel);
    if (isCFChallengePage())
      throw new Error(
        "Cloudflare challenge active — wait until it completes, then try again."
      );
  }
  function setPanelEnabled(enabled) {
    try {
      document
        .querySelectorAll("#ivachp button")
        .forEach((b) => (b.disabled = !enabled));
    } catch {}
  }
  let _cfWatchTimer = null;
  function startCFWatch() {
    const tick = () => setPanelEnabled(!isCFChallengePage());
    tick();
    _cfWatchTimer = setInterval(tick, 800);
  }

  // Hard bail-out: do not mount or wire anything on CF challenge pages
  if (isCFChallengePage()) {
    console.info("[IVAC-helper] CF challenge detected — not mounting UI.");
    return;
  }

  // ---------- INITIAL isEdit FROM persist:root ----------
  let initialIsEdit = false;
  try {
    const rawPR = localStorage.getItem("persist:root");
    if (rawPR) {
      const root = JSON.parse(rawPR);
      if (root && root.application) {
        const appObj = JSON.parse(root.application);
        if (typeof appObj.isEdit === "boolean") {
          initialIsEdit = appObj.isEdit;
        }
      }
    }
  } catch {
    // ignore
  }

  // ---------- STATE ----------
  let PAY_TS_TOKEN = "";
  let APP_TS_TOKEN = "";
  let TS_IFRAME_PAY = null;
  let TS_IFRAME_APP = null;

  const state = {
    lang: localStorage.getItem("tm_ivac_lang") || "en",
    token:
      localStorage.getItem(LS_TOKEN_KEY) ||
      localStorage.getItem("tm_ivac_token") ||
      "",
    // Application Info
    app_highcom: "",
    app_webfile: "",
    app_webfile_repeat: "",
    app_ivac_id: "",
    app_visa_type: "",
    app_family_count: "",
    app_visit_purpose: "",
    app_captcha: localStorage.getItem("tm_ivac_captcha") || "",
    // Personal Info
    pi_full_name: localStorage.getItem("auth_name") || "",
    pi_email: localStorage.getItem("auth_email") || "",
    pi_phone:
      localStorage.getItem("auth_phone") ||
      localStorage.getItem("user_phone") ||
      "",
    pi_webfile: "",
    pi_family_rows: 0,
    pi_family: {},
    // Checkout → Pay
    checkout: null,
    otpSent: false,
    otpVerified: false,
    otp: "",
    slotDates: [],
    selectedDate: "",
    slotTimes: [],
    selectedTime: "",
    paymentOptions: [],
    selectedPaymentIndex: -1,
    // misc
    isEdit:
      initialIsEdit || localStorage.getItem("is_edit") === "true" || false,
    clientIp: localStorage.getItem(IP_LS_KEY) || "",
  };

  // ---------- RESOLVER BRIDGE (DISABLED / FIXED) ----------
  function getRoute(label /* 'now' | 'app' */) {
    return label === "app"
      ? APP_SUBMIT_PATH
      : label === "now"
      ? PAY_NOW_PATH
      : null;
  }
  function getTokenKey(label /* 'now' | 'app' */) {
    return label === "app"
      ? APP_TOKEN_KEY
      : label === "now"
      ? PAY_TOKEN_KEY
      : "captcha_token";
  }

  function getAppActionId(
    which /* 'app-submit' | 'personal-submit' | 'overview-submit' */
  ) {
    switch (which) {
      case "app-submit":
        return APP_ACTION_ID_APPLICATION_INFO;
      case "personal-submit":
        return APP_ACTION_ID_PERSONAL_INFO;
      case "overview-submit":
        return APP_ACTION_ID_OVERVIEW;
      default:
        return "";
    }
  }

  // ---------- TOKEN AUTOSYNC ----------
  function readAccessTokenFromLS() {
    return (
      localStorage.getItem(LS_TOKEN_KEY) ||
      localStorage.getItem("tm_ivac_token") ||
      ""
    );
  }
  function getLiveToken() {
    const ui = panel && panel.querySelector("#ivachp-token");
    return (ui && ui.value.trim()) || readAccessTokenFromLS() || "";
  }
  function applyTokenToUI(newToken) {
    if (!newToken) return;
    if (state.token !== newToken) {
      state.token = newToken;
      const inp = panel && panel.querySelector("#ivachp #ivachp-token");
      if (inp && inp.value !== newToken) inp.value = newToken;
      updateUI(false);
      log("access_token auto-fetched from localStorage");
    }
  }
  window.addEventListener("storage", (e) => {
    if (e.key === LS_TOKEN_KEY || e.key === "tm_ivac_token")
      applyTokenToUI(readAccessTokenFromLS());
  });
  (function patchLocalStorageSetItemForToken() {
    try {
      const orig = localStorage.setItem;
      localStorage.setItem = function (key, val) {
        const ret = orig.apply(this, arguments);
        if (key === LS_TOKEN_KEY || key === "tm_ivac_token") {
          try {
            window.dispatchEvent(
              new CustomEvent("ivac-ls-token-change", {
                detail: { key, value: val },
              })
            );
          } catch {}
        }
        return ret;
      };
    } catch {}
  })();
  window.addEventListener("ivac-ls-token-change", () =>
    applyTokenToUI(readAccessTokenFromLS())
  );
  let _tokenSyncTimer = null;
  function startTokenAutoSync() {
    if (_tokenSyncTimer) return;
    _tokenSyncTimer = setInterval(
      () => applyTokenToUI(readAccessTokenFromLS()),
      TOKEN_SYNC_MS
    );
  }

  // ---------- HELPERS ----------
  const savePref = () => {
    localStorage.setItem("tm_ivac_lang", state.lang);
    localStorage.setItem("tm_ivac_token", state.token);
    localStorage.setItem("tm_ivac_captcha", state.app_captcha);
  };
  const log = (...a) => {
    console.log("[IVAC-helper]", ...a);
    const pre = document.getElementById("ivachp-log");
    if (pre) {
      a.forEach(
        (x) =>
          (pre.textContent +=
            (typeof x === "string" ? x : JSON.stringify(x, null, 2)) + "\n")
      );
      pre.scrollTop = pre.scrollHeight;
    }
  };
  function headers(needsAuth, body) {
    const h = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      language: state.lang,
    };
    if (body && !(body instanceof FormData))
      h["Content-Type"] = "application/json";
    if (needsAuth) {
      const t = getLiveToken();
      if (t) h["Authorization"] = "Bearer " + t;
    }
    return h;
  }

  function isTransientStatus(s) {
    return [500, 502, 503, 504, 520, 522, 523, 524, 529].includes(s | 0);
  }
  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitReadyForSubmit(which) {
    guardConnect(`submit:${which}`);
    await Promise.resolve();
  }

  function getFreshCaptchaToken() {
    const manual =
      (panel && panel.querySelector("#ivachp-captcha")?.value.trim()) ||
      state.app_captcha ||
      "";
    return PAY_TS_TOKEN || manual || tryGetCaptchaFromPage() || "";
  }

  // JSON API helper (legacy /api/v2/* endpoints)
  async function api(
    path,
    { method = "GET", body = undefined, auth = false } = {}
  ) {
    guardConnect(`${method} ${path}`);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
    const makeReq = async () =>
      fetch(API_BASE + path, {
        method,
        headers: headers(auth, body),
        body: body
          ? body instanceof FormData
            ? body
            : JSON.stringify(body)
          : undefined,
        credentials: "include",
        signal: ac.signal,
      });

    let res;
    try {
      res = await makeReq();
    } catch (e) {
      clearTimeout(timer);
      if (isCFChallengePage())
        throw new Error(
          "Cloudflare challenge active — retry after the page finishes."
        );
      if (e?.name === "AbortError")
        throw new Error("Request timed out — try again.");
      throw e;
    }
    clearTimeout(timer);

    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    const data = isJson ? await res.json() : {};

    if (!res.ok && auth && (res.status === 401 || res.status === 403)) {
      const fresh = readAccessTokenFromLS();
      const uiToken =
        panel && panel.querySelector("#ivachp-token")?.value.trim();
      const used = (uiToken || state.token || "").trim();
      if (fresh && fresh !== used) {
        applyTokenToUI(fresh);
        const ac2 = new AbortController();
        const t2 = setTimeout(() => ac2.abort(), REQ_TIMEOUT_MS);
        try {
          const retry = await fetch(API_BASE + path, {
            method,
            headers: headers(true, body),
            body: body
              ? body instanceof FormData
                ? body
                : JSON.stringify(body)
              : undefined,
            credentials: "include",
            signal: ac2.signal,
          });
          clearTimeout(t2);
          const ct2 = retry.headers.get("content-type") || "";
          const isJson2 = ct2.includes("application/json");
          const data2 = isJson2 ? await retry.json() : {};
          if (!retry.ok) {
            const err2 = new Error(
              (data2 && data2.message) || retry.statusText || "Auth failed"
            );
            err2.status = retry.status;
            err2.data = data2;
            throw err2;
          }
          return data2;
        } catch (e2) {
          if (e2?.name === "AbortError")
            throw new Error("Request timed out — try again.");
          throw e2;
        }
      }
    }

    if (!res.ok) {
      const err = new Error(
        (data && data.message) || res.statusText || "Request failed"
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // --- ONE-TIME get-ip (memoized) ---
  // --- ONE-TIME get-ip (memoized, robust like Code B) ---
  // --- ONE-TIME get-ip (memoized, structured-first) ---
  // --- ONE-TIME get-ip (memoized, structured-first + filtered regex fallback) ---
  let _ipPromise = null;

  function isBadOrPrivateIp(ip) {
    if (!ip) return true;
    const parts = ip.split(".").map((x) => x | 0);
    if (parts.length !== 4 || parts.some((x) => x < 0 || x > 255)) return true;

    const [a, b] = parts;

    // Private / special ranges we don't want
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;

    // Explicitly ignore this bogus value if it appears
    if (ip === "1.2.1.1") return true;

    return false;
  }

  async function getClientIpOnce() {
    // If we already have an IP (state or localStorage), reuse it
    if (!state.clientIp) {
      try {
        const fromLS = localStorage.getItem(IP_LS_KEY);
        if (fromLS) state.clientIp = fromLS;
      } catch {}
    }
    if (state.clientIp) return state.clientIp;

    // If a request is already in-flight, reuse that promise
    if (_ipPromise) return _ipPromise;

    _ipPromise = (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);

      try {
        const lang = state.lang || "en";

        const resp = await fetch(API_BASE + "/api/get-ip", {
          method: "GET",
          headers: {
            accept: "application/json",
            "accept-language":
              lang === "en" ? "en-US,en;q=0.9" : `${lang},en;q=0.8`,
            language: lang,
            "x-requested-with": "XMLHttpRequest",
          },
          credentials: "include",
          signal: ac.signal,
        });

        clearTimeout(timer);

        const ct = (resp.headers.get("content-type") || "").toLowerCase();
        let ip = "";

        if (ct.includes("application/json")) {
          // ---- JSON: try structured fields first ----
          let j = null;
          try {
            j = await resp.json();
          } catch (e) {
            log("get-ip JSON parse error: " + (e?.message || e));
          }
          log("get-ip raw JSON:", j);

          if (j && typeof j === "object") {
            const r = j;
            ip =
              r.clientIp ||
              r.client_ip ||
              r.ip ||
              r.ip_address ||
              (r.data &&
                (r.data.clientIp ||
                  r.data.client_ip ||
                  r.data.ip ||
                  r.data.ip_address)) ||
              "";

            if (ip && isBadOrPrivateIp(ip)) {
              log("get-ip: structured IP looked invalid: " + ip);
              ip = "";
            }

            // ---- Fallback: scan full JSON string for a better IPv4 ----
            if (!ip) {
              try {
                const s = JSON.stringify(j);
                const all = s.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
                const good = all.find(
                  (candidate) => !isBadOrPrivateIp(candidate)
                );
                if (good) {
                  ip = good;
                  log("get-ip: picked IPv4 from JSON string: " + ip);
                } else {
                  log(
                    "get-ip: JSON had IPv4-like strings but all looked private/bad: " +
                      (all.join(", ") || "(none)")
                  );
                }
              } catch (e) {
                log("get-ip: JSON string scan error: " + (e?.message || e));
              }
            }

            if (!ip) {
              log("get-ip: JSON had no usable ip/clientIp fields");
            }
          }
        } else {
          // ---- Non-JSON: fall back to regex on plain text ----
          try {
            const txt = await resp.text();
            log("get-ip raw text:", txt.slice(0, 200));
            const all = txt.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
            const good = all.find((candidate) => !isBadOrPrivateIp(candidate));
            if (good) ip = good;
            else if (all.length) {
              log(
                "get-ip: text had IPv4-like strings but all looked private/bad: " +
                  all.join(", ")
              );
            }
          } catch (e) {
            log("get-ip text read error: " + (e?.message || e));
          }
        }

        if (ip) {
          const sIp = String(ip);
          state.clientIp = sIp;
          try {
            localStorage.setItem(IP_LS_KEY, sIp);
          } catch {}
          try {
            const ipInput = panel && panel.querySelector("#ivachp-ip");
            if (ipInput) ipInput.value = sIp;
          } catch {}
          log("get-ip → " + sIp);
          return sIp;
        } else {
          log("get-ip: could not extract IP from response");
          return state.clientIp || "";
        }
      } catch (e) {
        clearTimeout(timer);
        log("get-ip failed: " + (e && e.message ? e.message : String(e)));
        return state.clientIp || "";
      }
    })();

    return _ipPromise;
  }

  // Helper for Next.js server actions on /application (text/plain RSC-style)
  async function apiPlainArray(
    path,
    arr,
    { auth = false, opLabel = "request", actionId = "" } = {}
  ) {
    guardConnect(opLabel);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);

    const makeReq = async (tokenOverride) => {
      const h = {
        // Match server action HAR/curl
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        language: state.lang,
        "next-router-state-tree": APP_ROUTER_STATE_TREE_ENC,
      };
      if (actionId) h["next-action"] = actionId;
      if (auth) {
        const t = tokenOverride || getLiveToken();
        if (t) h["Authorization"] = "Bearer " + t;
      }
      return fetch(API_BASE + path, {
        method: "POST",
        headers: h,
        body: JSON.stringify(arr),
        credentials: "include",
        signal: ac.signal,
      });
    };

    let res;
    try {
      res = await makeReq();
    } catch (e) {
      clearTimeout(timer);
      if (isCFChallengePage())
        throw new Error(
          "Cloudflare challenge active — retry after the page finishes."
        );
      if (e?.name === "AbortError")
        throw new Error("Request timed out — try again.");
      throw e;
    }
    clearTimeout(timer);

    // auth retry (401/403)
    if (!res.ok && auth && (res.status === 401 || res.status === 403)) {
      const fresh = readAccessTokenFromLS();
      if (fresh && fresh !== getLiveToken()) {
        try {
          const retry = await makeReq(fresh);
          if (!retry.ok) {
            const err2 = new Error(retry.statusText || "Auth failed");
            err2.status = retry.status;
            throw err2;
          }
          return {};
        } catch (e2) {
          if (e2?.name === "AbortError")
            throw new Error("Request timed out — try again.");
          throw e2;
        }
      }
    }

    if (!res.ok) {
      const err = new Error(res.statusText || "Request failed");
      err.status = res.status;
      throw err;
    }

    return {};
  }

  function tryGetCaptchaFromPage() {
    try {
      const input = document.querySelector(
        'input[name="cf-turnstile-response"], #cf-chl-widget input[name="cf-turnstile-response"]'
      );
      if (input && input.value) return input.value;
      if (
        window.turnstile &&
        typeof window.turnstile.getResponse === "function"
      ) {
        const widgetIds = Array.from(document.querySelectorAll(".cf-turnstile"))
          .map((el) => el.dataset.widgetId)
          .filter(Boolean);
        if (widgetIds.length) {
          const token = window.turnstile.getResponse(widgetIds[0]);
          if (token) return token;
        } else {
          const token = window.turnstile.getResponse();
          if (token) return token;
        }
      }
    } catch {}
    return "";
  }

  // ---------- NORMALIZERS ----------
  function normalizePaymentOptions(po) {
    const out = [];
    if (!po) return out;
    const pushItem = (src, category) => {
      if (!src || typeof src !== "object") return;
      const item = {
        name: src.name || src.title || src.display_name || "Payment",
        slug: src.slug || src.code || "",
        link: src.link || src.url || src.href || "",
      };
      if (item.name || item.slug || item.link)
        out.push({ item, category: category || "" });
    };
    const take = (entries, category) => {
      if (!entries) return;
      if (Array.isArray(entries)) entries.forEach((x) => pushItem(x, category));
      else if (typeof entries === "object")
        Object.values(entries).forEach((x) => pushItem(x, category));
    };
    const root = po && typeof po === "object" && "data" in po ? po.data : po;
    if (Array.isArray(root)) take(root, "");
    else if (root && typeof root === "object")
      for (const [cat, entries] of Object.entries(root)) take(entries, cat);
    else take(po, "");
    return out;
  }
  function normalizeSlotTimes(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .map((t) => {
        if (typeof t === "string") {
          return { display: t, availableSlot: undefined };
        }
        const display =
          t.time_display || (t.hour != null ? String(t.hour) : "");
        return {
          id: t.id,
          hour: t.hour,
          date: t.date,
          availableSlot: t.availableSlot,
          display,
        };
      })
      .filter((x) => x.display);
  }

  // ---------- persist:root HELPERS ----------
  function readPersistRoot() {
    try {
      const raw = localStorage.getItem("persist:root");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function writePersistRoot(root) {
    try {
      localStorage.setItem("persist:root", JSON.stringify(root));
    } catch (e) {
      log("persist:root write err:", e?.message || e);
    }
  }
  function setPersistApplication(inner, isEditFlag) {
    const root = readPersistRoot() || {};
    root.application = JSON.stringify({
      applicationData: inner,
      isEdit: !!isEditFlag,
    });
    writePersistRoot(root);
  }
  function setPersistPersonal(inner) {
    const root = readPersistRoot() || {};
    root.personalInfo = JSON.stringify({
      personalInfo: inner,
    });
    writePersistRoot(root);
  }
  function setPersistApplicationStep(step) {
    const root = readPersistRoot() || {};
    root.applicationStep = JSON.stringify({
      step: step | 0,
    });
    writePersistRoot(root);
  }

  function setStepNoReload(step) {
    try {
      setPersistApplicationStep(step);
      log(`applicationStep set → ${step}`);
    } catch (e) {
      log("setStep err:", e?.message || e);
    }
  }

  function logResolved(label, path, key) {
    log(
      `Resolved ${label}: path="${path || "(fixed)"}", tokenKey="${
        key || "(fixed)"
      }"`
    );
  }

  // ---------- PAY CONTEXT PERSISTENCE ----------
  function savePayCtx() {
    const ctx = {
      otpSent: !!state.otpSent,
      otpVerified: !!state.otpVerified,
      slotDates: Array.isArray(state.slotDates) ? state.slotDates : [],
      selectedDate: state.selectedDate || "",
      slotTimes: Array.isArray(state.slotTimes) ? state.slotTimes : [],
      selectedTime: state.selectedTime || "",
      paymentOptions: Array.isArray(state.paymentOptions)
        ? state.paymentOptions
        : [],
      selectedPaymentIndex:
        typeof state.selectedPaymentIndex === "number"
          ? state.selectedPaymentIndex
          : -1,
    };
    try {
      localStorage.setItem(PAY_CTX_KEY, JSON.stringify(ctx));
    } catch {}
  }
  function restorePayCtx() {
    try {
      const raw = localStorage.getItem(PAY_CTX_KEY);
      if (!raw) return false;
      const c = JSON.parse(raw);
      state.otpSent = !!c.otpSent;
      state.otpVerified = !!c.otpVerified;
      state.slotDates = Array.isArray(c.slotDates) ? c.slotDates : [];
      state.selectedDate = c.selectedDate || "";
      state.slotTimes = Array.isArray(c.slotTimes) ? c.slotTimes : [];
      state.selectedTime = c.selectedTime || "";
      state.paymentOptions = Array.isArray(c.paymentOptions)
        ? c.paymentOptions
        : [];
      state.selectedPaymentIndex =
        typeof c.selectedPaymentIndex === "number"
          ? c.selectedPaymentIndex
          : -1;
      return true;
    } catch {
      return false;
    }
  }
  window.addEventListener("pagehide", savePayCtx);
  window.addEventListener("beforeunload", savePayCtx);

  // ---------- APPLICATION INFO (via /application server action) ----------
  async function submitApplicationInfo() {
    const tokenKeyApp = APP_TOKEN_KEY;
    const capToken =
      APP_TS_TOKEN || state.app_captcha || tryGetCaptchaFromPage();
    if (!capToken)
      return alert(
        "Missing captcha token. Enable Application CAPTCHA and solve it, or paste a token."
      );

    const inner = {
      highcom: state.app_highcom,
      webfile_id: state.app_webfile,
      webfile_id_repeat: state.app_webfile_repeat,
      ivac_id: state.app_ivac_id,
      visa_type: state.app_visa_type,
      family_count: state.app_family_count,
      asweoi_erilfs: state.app_visit_purpose,
      [tokenKeyApp]: capToken,
    };

    if (
      !inner.webfile_id ||
      !inner.webfile_id_repeat ||
      inner.webfile_id !== inner.webfile_id_repeat
    ) {
      return alert("Webfile ID & Repeat must be set and match.");
    }

    const isEditFlag = false;
    const ipHint = await getClientIpOnce();

    const payload = [inner, isEditFlag, ipHint];

    const appPath = APP_SUBMIT_PATH;
    logResolved("app-submit", appPath, tokenKeyApp);
    log("Submitting Application Info via /application…");

    await apiPlainArray(appPath, payload, {
      auth: false,
      opLabel: "app-submit",
      actionId: getAppActionId("app-submit"),
    });

    const cache = {
      highcom: inner.highcom,
      webfile_id: inner.webfile_id,
      webfile_id_repeat: inner.webfile_id_repeat,
      ivac_id: inner.ivac_id,
      visa_type: inner.visa_type,
      family_count: inner.family_count,
      visit_purpose: state.app_visit_purpose,
    };
    localStorage.setItem("applicant", JSON.stringify(cache));
    setPersistApplication(inner, isEditFlag);
    setStepNoReload(2);
    alert("Application info saved — step set to 2.");
  }

  // ---------- PERSONAL INFO (via /application server action) ----------
  function ensureFamilyRows(n) {
    n = Math.max(0, Math.min(20, n | 0));
    state.pi_family_rows = n;
    for (let i = 1; i <= n; i++)
      if (!state.pi_family[i])
        state.pi_family[i] = {
          name: "",
          webfile_no: "",
          again_webfile_no: "",
        };
    for (let i = n + 1; i <= 50; i++) delete state.pi_family[i];
  }

  async function submitPersonalInfo() {
    const inner = {
      full_name: state.pi_full_name,
      email_name: state.pi_email,
      phone: state.pi_phone,
      webfile_id: state.pi_webfile,
      family: state.pi_family,
    };

    if (
      !inner.full_name ||
      !inner.email_name ||
      !inner.phone ||
      !inner.webfile_id
    )
      return alert("Please fill full name, email, phone and webfile id");

    for (let i = 1; i <= state.pi_family_rows; i++) {
      const r = state.pi_family[i] || {};
      if (!r.name) return alert(`Family member ${i}: Name is required`);
      if (!r.webfile_no)
        return alert(`Family member ${i}: Web file number is required`);
      if (!r.again_webfile_no)
        return alert(`Family member ${i}: Confirm web file number is required`);
    }

    const isEditFlag = false;
    const ipHint = await getClientIpOnce();

    const payload = [inner, isEditFlag, ipHint];

    const path = APP_SUBMIT_PATH;
    logResolved("personal-submit", path, "(server action)");
    log("Submitting Personal Info via /application…");

    await apiPlainArray(path, payload, {
      auth: false,
      opLabel: "personal-submit",
      actionId: getAppActionId("personal-submit"),
    });

    localStorage.setItem("personal_info", JSON.stringify(inner));
    setPersistPersonal(inner);
    setStepNoReload(3);
    alert("Personal info saved — step set to 3.");
  }

  // ---------- OVERVIEW (via /application server action) ----------
  async function submitOverview() {
    const lang = state.lang || "en";
    const ipHint = await getClientIpOnce();
    const payload = [lang, ipHint];

    logResolved("overview-submit", APP_SUBMIT_PATH, "(server action)");
    log("Submitting Overview via /application…");

    await apiPlainArray(APP_SUBMIT_PATH, payload, {
      auth: false,
      opLabel: "overview-submit",
      actionId: getAppActionId("overview-submit"),
    });

    const applicant = localStorage.getItem("applicant");
    const personal = localStorage.getItem("personal_info");
    if (applicant) localStorage.setItem("applicant_backup", applicant);
    if (personal) localStorage.setItem("personal_info_backup", personal);
    localStorage.removeItem("applicant");
    localStorage.removeItem("personal_info");

    setStepNoReload(4);
    alert("Overview submitted — step set to 4.");
  }

  // ---------- CHECKOUT / OTP / SLOTS / PAY (JSON APIs) ----------
  async function doCheckout() {
    if (!getLiveToken()) return alert("Missing access_token");
    log("Loading checkout…");
    const data = await api("/api/v2/payment/checkout", {
      method: "GET",
      auth: true,
    });
    state.checkout = data;
    const d = data?.data || {};
    state.paymentOptions = normalizePaymentOptions(d.payment_options);
    if (!state.paymentOptions.length) {
      log("No payment options found. Raw:", d.payment_options);
    } else {
      log(
        "Payment options:",
        state.paymentOptions.map(
          (p) => `${p.category || "cat"}:${p.item?.name}`
        )
      );
      if (state.selectedPaymentIndex < 0) state.selectedPaymentIndex = 0;
    }
    savePayCtx();
    updateUI();
  }

  async function sendOtp(resend = 0) {
    if (!getLiveToken()) return alert("Missing access_token");
    await api("/api/v2/payment/pay-otp-sent", {
      method: "POST",
      auth: true,
      body: { resend },
    });
    state.otpSent = true;
    savePayCtx();
    updateUI();
  }

  async function verifyOtp() {
    if (!getLiveToken()) return alert("Missing access_token");
    if (!state.otp || state.otp.length < 6) return alert("Enter a 6-digit OTP");
    const res = await api("/api/v2/payment/pay-otp-verify", {
      method: "POST",
      auth: true,
      body: { otp: state.otp },
    });
    const d = res?.data || {};
    state.slotDates = d.slot_dates || [];
    state.otpVerified = true;
    if (state.slotDates.length) {
      state.selectedDate = state.slotDates[0];
      await loadSlotTimes(state.selectedDate);
    }
    savePayCtx();
    updateUI();
  }

  async function loadSlotTimes(dateStr) {
    if (!getLiveToken()) return alert("Missing access_token");
    if (!dateStr) return alert("Pick a date first");
    state.selectedDate = dateStr;
    log("Loading slot times for", dateStr);
    const res = await api("/api/v2/payment/pay-slot-time", {
      method: "POST",
      auth: true,
      body: { appointment_date: dateStr },
    });
    const d = res?.data || {};
    state.slotTimes = normalizeSlotTimes(d.slot_times);
    if (!state.slotTimes.find((t) => t.display === state.selectedTime)) {
      state.selectedTime = state.slotTimes[0]?.display || "";
    }
    savePayCtx();
    updateUI();
    log(
      "Slot times:",
      state.slotTimes.map(
        (x) =>
          `${x.display}${
            typeof x.availableSlot === "number"
              ? ` (${x.availableSlot} left)`
              : ""
          }`
      )
    );
  }

  async function payNow() {
    if (!getLiveToken()) return alert("Missing access_token");
    if (!state.otpVerified) return alert("Verify OTP first");
    if (!state.selectedDate || !state.selectedTime)
      return alert("Pick date & time first");
    if (
      state.selectedPaymentIndex < 0 ||
      !state.paymentOptions[state.selectedPaymentIndex]
    )
      return alert("Select a payment option");

    await waitReadyForSubmit("pay");

    const selected = state.paymentOptions[state.selectedPaymentIndex];
    const item = selected?.item || selected || {};

    const payPath = PAY_NOW_PATH;
    const tokenKeyNow = PAY_TOKEN_KEY;

    let attempt = 0;
    while (true) {
      attempt++;

      const cap = getFreshCaptchaToken();
      if (!cap || cap.length < 20)
        return alert("Solve CAPTCHA and try again (turn Payment CAPTCHA On).");

      const body = {
        appointment_date: state.selectedDate,
        appointment_time: state.selectedTime,
        [tokenKeyNow]: cap,
        selected_payment: {
          name: item.name || "",
          slug: item.slug || "",
          link: item.link || "",
        },
      };

      logResolved("pay-now", payPath, tokenKeyNow);
      log(`Paying now… (attempt ${attempt})`);

      try {
        const data = await api(payPath, { method: "POST", auth: true, body });
        PAY_TS_TOKEN = "";
        const url = data?.data?.url;
        if (url) {
          savePayCtx();
          window.open(url, "_blank");
          return;
        } else {
          throw new Error("No redirect URL returned");
        }
      } catch (e) {
        const code = e?.status | 0;
        if (isTransientStatus(code) && attempt <= 2) {
          try {
            unmountPaymentTurnstile();
            setTimeout(mountPaymentTurnstile, 0);
          } catch {}
          try {
            await doCheckout();
            if (state.selectedDate) {
              await loadSlotTimes(state.selectedDate);
              if (
                !state.slotTimes.find((t) => t.display === state.selectedTime)
              ) {
                state.selectedTime = state.slotTimes[0]?.display || "";
              }
            }
          } catch {}
          savePayCtx();
          await sleep(400 * attempt + Math.floor(Math.random() * 200));
          continue;
        }
        throw e;
      }
    }
  }

  async function notifyFeeChange() {
    if (!getLiveToken()) return alert("Missing access_token");
    const apiKey = prompt("Enter API key to notify fee change:");
    if (!apiKey) return;
    const data = await api("/api/v2/payment/notify-amount-change", {
      method: "POST",
      auth: true,
      body: { api_key: apiKey },
    });
    alert((data && data.message) || "Done");
    log("notify-amount-change:", data);
  }

  // ---------- UI ----------
  function el(html) {
    const d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const style = el(`
    <style id="ivachp-style">
    #ivachp { position:fixed; top:64px; right:24px; width:380px; max-height:88vh; z-index:2147483647;
      font-family: Inter, Segoe UI, Roboto, Arial, sans-serif; color:#2c3e50; background:#fff; border:1px solid #e0e0e0;
      border-radius:12px; box-shadow:0 10px 25px rgba(0,0,0,.1), 0 3px 6px rgba(0,0,0,.05); }
    #ivachp.min{
      height: 48px;
      overflow: hidden;
      box-shadow: 0 5px 15px rgba(0,0,0,.1);
      transition: height .2s ease-out;
    }
    #ivachp *{box-sizing:border-box}
    #ivachp header{cursor:grab; user-select:none; padding:1px 2px; background:linear-gradient(135deg,#4facfe 0%,#00f2fe 100%);
      color:#fff; border-radius:11px 11px 0 0; display:flex; align-items:center; justify-content:space-between; font-size:1em; font-weight:600; }
    #ivachp header .btns button{ background:rgba(255,255,255,.2); border:none; border-radius:50%; width:24px; height:24px; font-size:1em;color:black;
      line-height:1; cursor:pointer; margin-left:6px; transition:background .2s ease; display:flex; align-items:center; justify-content:center; }
    #ivachp header .btns button:hover{ background:rgba(255,255,255,.3); }
    #ivachp .body{ padding:15px; overflow:auto; max-height:calc(88vh - 44px); transition:max-height .2s ease-out, padding .2s ease-out; }
    #ivachp.min .body{
      max-height: 0;
      padding-top: 0;
      padding-bottom: 0;
    }

    fieldset{ border:1px solid #e7e7e7; padding:12px; margin-bottom:15px; border-radius:8px; background:#fcfcfc; }
    legend{ padding:0 8px; font-weight:700; color:#34495e; font-size:1.05em; background:#fcfcfc; }
    label{ display:block; margin:8px 0 4px; font-weight:600; color:#34495e; }
    input[type="text"], input[type="number"], select, textarea{
      width:100%; padding:9px 12px; border:1px solid #dcdcdc; border-radius:7px; outline:none; background:#fefefe; font-size:.95em;
    }
    input:focus, select:focus, textarea:focus{ border-color:#007bff; box-shadow:0 0 0 2px rgba(0,123,255,.2); }
    .row{ display:flex; gap:10px; margin-bottom:5px; align-items:center; }
    .row>*{ flex:1 }
    .radio{ display:flex; align-items:center; gap:8px; margin:8px 0; padding:10px; border:1px solid #e0e0e0; border-radius:8px; background:#f9f9f9; cursor:pointer; }
    .radio:hover{ background:#f0f8ff; border-color:#a7d9ff; }
    .radio input{ width:auto; margin-right:5px; transform:scale(1.1); }
    button.primary,button.secondary{ width:100%; margin-top:10px; padding:10px 15px; border:0; border-radius:7px; cursor:pointer; font-size:1em; font-weight:600; box-shadow:0 2px 4px rgba(0,0,0,.1); }
    button.primary{ background:linear-gradient(135deg,#28a745 0%,#218838 100%); color:#fff; }
    button.primary:hover{ background:linear-gradient(135deg,#218838 0%,#1c7430 100%); box-shadow:0 4px 8px rgba(0,0,0,.15); }
    button.secondary{ background:linear-gradient(135deg,#ffc107 0%,#e0a800 100%); color:#333; }
    button.secondary:hover{ background:linear-gradient(135deg,#e0a800 0%,#c69500 100%); box-shadow:0 4px 8px rgba(0,0,0,.15); }
    .muted{ color:#7f8c8d; font-size:.85em; }
    .note{ font-size:.8em; color:#95a5a6; margin-top:5px; line-height:1.3; }
    .minirow{ display:grid; grid-template-columns: 1fr 1fr; gap:10px; align-items:end; }
    #ivachp-log{ width:100%; height:100px; background:#2c3e50; color:#ecf0f1; border-radius:8px; padding:10px; overflow:auto; white-space:pre-wrap; font-family: Fira Code, Consolas, monospace; font-size:.85em; }

    #ivachp-capwrap, #ivachp-app-capwrap { border:1px dashed #cbd5e1; border-radius:8px; padding:12px; margin-top:12px; background:#fff; }
    #ivachp-ts-holder, #ivachp-app-ts-holder { margin-top:8px; min-height:90px; display:none; justify-content:center; align-items:center; background:#f0f0f0; border-radius:6px; }
    #ivachp-ts-iframe, #ivachp-app-ts-iframe { width:310px; height:85px; border:0; background:#f0f0f0; }

    #ivachp-cf-banner{ position:fixed; left:24px; bottom:24px; padding:8px 12px; border-radius:8px; font:12px system-ui; z-index:2147483647;
      display:none; background:#fff3cd; color:#8a6d3b; border:1px solid #ffeeba; box-shadow:0 4px 12px rgba(0,0,0,.08) }
    </style>
  `);

  const panel = el(`
    <div id="ivachp">
      <header id="ivachp-handle">
        <div class="title">IVAC Floating Panel</div>
        <div class="btns">
          <button id="ivachp-min">–</button>
          <button id="ivachp-close">×</button>
        </div>
      </header>
      <div class="body">
        <!-- Quick Actions get injected here (first child) -->
        <fieldset>
          <legend>Session</legend>
          <label>access_token</label>
          <input id="ivachp-token" type="text" placeholder="auto-reads from localStorage">
          <div class="minirow">
            <div><label>Language</label><select id="ivachp-lang"><option value="en">en</option><option value="bn">bn</option></select></div>
            <div><label>is_edit</label><select id="ivachp-isedit"><option value="false">false</option><option value="true">true</option></select></div>
          </div>
          <div class="minirow">
            <div>
              <label>Client IP</label>
              <!-- EDITED: removed readonly so user can type -->
              <input id="ivachp-ip" type="text" placeholder="not loaded yet">
            </div>
            <div>
              <label>&nbsp;</label>
              <button id="ivachp-getip" class="secondary">Get IP</button>
            </div>
          </div>
          <button id="ivachp-save" class="secondary">Save</button>
        </fieldset>
        
        

        <fieldset>
          <legend>Application Info</legend>
          <div class="minirow">
            <div><label>High Commission (highcom)</label><input id="app-highcom" type="text"></div>
            <div><label>IVAC ID (ivac_id)</label><input id="app-ivacid" type="text"></div>
          </div>
          <label>Visa Type (visa_type)</label><input id="app-visatype" type="text">
          <div class="minirow">
            <div><label>Family Count</label><input id="app-familycount" type="number" min="0"></div>
            <div><label>Visit Purpose</label><input id="app-visitpurpose" type="text" placeholder="min 15 chars"></div>
          </div>
          <div class="minirow">
            <div><label>Webfile ID</label><input id="app-webfile" type="text"></div>
            <div><label>Repeat Webfile</label><input id="app-webfile2" type="text"></div>
          </div>

          <div class="row">
            <input id="app-captcha" type="text" placeholder="captcha_token (Turnstile)">
            <button id="app-captcha-grab" class="secondary">Get from page</button>
          </div>

          <div id="ivachp-app-capwrap">
            <div class="row" style="align-items:center">
              <label style="flex:0 0 140px; margin:0"><b>Application CAPTCHA</b></label>
              <label class="radio" style="margin:0; flex:0 0 auto"><input type="radio" name="ivachp-appcap" id="ivachp-appcap-off" checked> Off</label>
              <label class="radio" style="margin:0; flex:0 0 auto"><input type="radio" name="ivachp-appcap" id="ivachp-appcap-on"> On</label>
              <button id="ivachp-appcap-refresh" class="secondary" style="flex:0 0 auto">Refresh</button>
            </div>
            <div id="ivachp-app-ts-holder" style="display:none"><iframe id="ivachp-app-ts-iframe" title="Application CAPTCHA"></iframe></div>
          </div>

          <button id="app-submit" class="primary">Application Info Submit</button>
        </fieldset>

        <fieldset>
          <legend>Personal Info</legend>
          <label>Full Name</label><input id="pi-fullname" type="text">
          <div class="minirow">
            <div><label>Email</label><input id="pi-email" type="text"></div>
            <div><label>Phone</label><input id="pi-phone" type="text"></div>
          </div>
          <label>Webfile ID</label><input id="pi-webfile" type="text">
          <div class="minirow">
            <div><label>Family Members (#)</label><input id="pi-familyrows" type="number" min="0" max="20"></div>
            <div><label>&nbsp;</label><button id="pi-buildrows" class="secondary">Build Rows</button></div>
          </div>
          <div id="pi-familywrap"></div>
          <button id="pi-submit" class="primary">Personal Info Submit</button>
        </fieldset>

        <fieldset>
          <legend>Overview</legend>
          <button id="ov-submit" class="primary">Overview Submit</button>
          <div class="note">Posts to /application with ["language","<ip>"] payload and updates applicationStep in persist:root.</div>
        </fieldset>

        <fieldset>
          <legend>Checkout → OTP → Slot → Pay</legend>
          <button id="ivachp-checkout" class="secondary">Load Checkout</button>
          <div id="ivachp-checkout-info" class="muted"></div>

          <div class="row">
            <button id="ivachp-otp-send" class="secondary">Send OTP</button>
            <button id="ivachp-otp-resend" class="secondary">Resend OTP</button>
          </div>
          <div class="row">
            <input id="ivachp-otp" type="text" placeholder="6-digit OTP" autocomplete="one-time-code" inputmode="numeric">
            <button id="ivachp-otp-verify" class="primary">Verify OTP</button>
          </div>

          <label>Appointment Date</label>
          <div class="row">
            <select id="ivachp-date"></select>
            <button id="ivachp-fetch-slots" class="secondary">Fetch Slots</button>
          </div>

          <label>Time</label>
          <select id="ivachp-time"></select>

          <label>Payment Option</label>
          <div id="ivachp-payopts"></div>
          <div id="ivachp-payopts-empty" class="note" style="display:none">No payment options received from checkout.</div>

          <div class="row" style="margin-top:6px">
            <input id="ivachp-captcha" type="text" placeholder="captcha_token (Turnstile)">
            <button id="ivachp-captcha-grab" class="secondary">Get from page</button>
          </div>
          <div class="note">Solve CAPTCHA, or enable the Payment CAPTCHA box to generate a token.</div>

          <div id="ivachp-capwrap">
            <div class="row" style="align-items:center">
              <label style="flex:0 0 140px; margin:0"><b>Payment CAPTCHA</b></label>
              <label class="radio" style="margin:0; flex:0 0 auto"><input type="radio" name="ivachp-paycap" id="ivachp-paycap-off" checked> Off</label>
              <label class="radio" style="margin:0; flex:0 0 auto"><input type="radio" name="ivachp-paycap" id="ivachp-paycap-on"> On</label>
              <button id="ivachp-paycap-refresh" class="secondary" style="flex:0 0 auto">Refresh</button>
            </div>
            <div id="ivachp-ts-holder" style="display:none"><iframe id="ivachp-ts-iframe" title="Payment CAPTCHA"></iframe></div>
          </div>

          <button id="ivachp-paynow" class="primary">Pay Now</button>
          <button id="ivachp-notify" class="secondary">Notify Fee Change</button>
        </fieldset>

        <fieldset>
          <legend>Log</legend>
          <pre id="ivachp-log"></pre>
        </fieldset>
      </div>
    </div>
  `);

  const cfBanner = el(
    `<div id="ivachp-cf-banner">Cloudflare challenge in progress… please wait.</div>`
  );

  document.documentElement.append(style);
  document.documentElement.append(panel);
  document.documentElement.append(cfBanner);
  panel.classList.add("min");

  // --- QUICK ACTIONS at the very top ---
  (function addQuickActions() {
    try {
      if (panel.querySelector("#ivachp-quick-actions")) return;
      const qa = el(`
        <fieldset id="ivachp-quick-actions">
          <legend>Quick Actions</legend>
          <div class="row">
            <button id="qa-app-submit" class="primary">Application Submit</button>
            <button id="qa-pi-submit" class="primary">Personal Submit</button>
            <button id="qa-ov-submit" class="primary">Overview Submit</button>
          </div>
        </fieldset>
      `);
      const body = panel.querySelector(".body");
      if (body) body.insertBefore(qa, body.firstChild);
      panel.querySelector("#qa-app-submit").onclick = () =>
        panel.querySelector("#app-submit")?.click();
      panel.querySelector("#qa-pi-submit").onclick = () =>
        panel.querySelector("#pi-submit")?.click();
      panel.querySelector("#qa-ov-submit").onclick = () =>
        panel.querySelector("#ov-submit")?.click();
    } catch (e) {
      console.error("[IVAC-helper] Quick Actions add failed:", e);
    }
  })();
  // -------------------------------------------------------

  // draggable panel
  (function makeDraggable(elRoot, handle) {
    let pos3 = 0,
      pos4 = 0;
    handle.onmousedown = function (e) {
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    };
    function elementDrag(e) {
      e.preventDefault();
      const dx = e.clientX - pos3,
        dy = e.clientY - pos4;
      pos3 = e.clientX;
      pos4 = e.clientY;
      const rect = elRoot.getBoundingClientRect();
      elRoot.style.top = rect.top + dy + "px";
      elRoot.style.left = rect.left + dx + "px";
      elRoot.style.right = "auto";
    }
    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  })(panel, document.getElementById("ivachp-handle"));

  const $ = (s) => panel.querySelector(s);

  // session defaults
  $("#ivachp-token").value = state.token || "";
  $("#ivachp-lang").value = state.lang;
  $("#ivachp-isedit").value = String(state.isEdit);

  // Application defaults
  $("#app-captcha").value = state.app_captcha;

  // Personal defaults
  $("#pi-fullname").value = state.pi_full_name;
  $("#pi-email").value = state.pi_email;
  $("#pi-phone").value = state.pi_phone;

  // Session save button
  $("#ivachp-save").onclick = () => {
    state.token =
      $("#ivachp-token").value.trim() || readAccessTokenFromLS() || "";
    state.lang = $("#ivachp-lang").value;
    state.isEdit = $("#ivachp-isedit").value === "true";
    state.app_captcha = $("#app-captcha").value.trim();
    // also persist IP if user typed something
    const ipVal = $("#ivachp-ip")?.value.trim() || "";
    state.clientIp = ipVal;
    try {
      localStorage.setItem(IP_LS_KEY, ipVal);
    } catch {}
    savePref();
    updateUI(false);
    log("Saved prefs");
  };

  // Manual typing in IP field → keep state + localStorage in sync
  (function wireManualIpInput() {
    const ipInput = $("#ivachp-ip");
    if (!ipInput) return;
    ipInput.oninput = (e) => {
      const v = e.target.value.trim();
      state.clientIp = v;
      try {
        localStorage.setItem(IP_LS_KEY, v);
      } catch {}
    };
  })();

  // UI events
  // Manual Get IP button
  // Manual Get IP button – force a fresh /api/get-ip call
  // Manual Get IP button – force a fresh /api/get-ip call
  $("#ivachp-getip").onclick = wrap(async () => {
    _ipPromise = null;
    state.clientIp = "";
    try {
      localStorage.removeItem(IP_LS_KEY);
    } catch {}

    const ip = await getClientIpOnce();
    if (ip) {
      state.clientIp = ip;
      try {
        localStorage.setItem(IP_LS_KEY, ip);
      } catch {}
      const ipInput = $("#ivachp-ip");
      if (ipInput) ipInput.value = ip;
      log("Client IP: " + ip);
      alert("Client IP: " + ip);
    } else {
      alert("Could not fetch IP. Check network or try again.");
    }
  });

  $("#ivachp-min").onclick = () => {
    panel.classList.toggle("min");
    try {
      localStorage.setItem(
        MIN_KEY,
        panel.classList.contains("min") ? "1" : "0"
      );
    } catch {}
  };

  document.getElementById("ivachp-handle").ondblclick = () => {
    $("#ivachp-min").click();
  };

  $("#ivachp-close").onclick = () => {
    panel.remove();
    style.remove();
    cfBanner.remove();
    if (_cfWatchTimer) clearInterval(_cfWatchTimer);
    if (_tokenSyncTimer) clearInterval(_tokenSyncTimer);
    if (_cfBannerTimer) clearInterval(_cfBannerTimer);
  };

  // Application Info bindings
  $("#app-highcom").oninput = (e) => (state.app_highcom = e.target.value);
  $("#app-ivacid").oninput = (e) => (state.app_ivac_id = e.target.value);
  $("#app-visatype").oninput = (e) => (state.app_visa_type = e.target.value);
  $("#app-familycount").oninput = (e) =>
    (state.app_family_count = e.target.value);
  $("#app-visitpurpose").oninput = (e) =>
    (state.app_visit_purpose = e.target.value);
  $("#app-webfile").oninput = (e) => (state.app_webfile = e.target.value);
  $("#app-webfile2").oninput = (e) =>
    (state.app_webfile_repeat = e.target.value);
  $("#app-captcha").oninput = (e) => {
    state.app_captcha = e.target.value;
    savePref();
    syncCaptchaInputs();
  };
  $("#app-captcha-grab").onclick = () => {
    const tok = tryGetCaptchaFromPage();
    if (tok) {
      state.app_captcha = tok;
      savePref();
      syncCaptchaInputs();
      alert("Got captcha token");
    } else alert("Could not read captcha token automatically.");
  };
  $("#app-submit").onclick = wrap(submitApplicationInfo);

  // Personal Info bindings
  $("#pi-fullname").oninput = (e) => (state.pi_full_name = e.target.value);
  $("#pi-email").oninput = (e) => (state.pi_email = e.target.value);
  $("#pi-phone").oninput = (e) => (state.pi_phone = e.target.value);
  $("#pi-webfile").oninput = (e) => (state.pi_webfile = e.target.value);
  $("#pi-buildrows").onclick = () => {
    const n = parseInt($("#pi-familyrows").value || "0", 10) || 0;
    ensureFamilyRows(n);
    renderFamilyRows();
  };
  function renderFamilyRows() {
    const wrapDiv = $("#pi-familywrap");
    wrapDiv.innerHTML = "";
    for (let i = 1; i <= state.pi_family_rows; i++) {
      const r = state.pi_family[i] || {
        name: "",
        webfile_no: "",
        again_webfile_no: "",
      };
      const row = el(`
        <div class="row" style="margin-top:6px">
          <input data-idx="${i}" data-k="name" placeholder="Family ${i} – Name" value="${esc(
        r.name || ""
      )}">
          <input data-idx="${i}" data-k="webfile_no" placeholder="Webfile" value="${esc(
        r.webfile_no || ""
      )}">
          <input data-idx="${i}" data-k="again_webfile_no" placeholder="Repeat Webfile" value="${esc(
        r.again_webfile_no || ""
      )}">
        </div>`);
      Array.from(row.querySelectorAll("input")).forEach((inp) => {
        inp.oninput = (e) => {
          const idx = +e.target.getAttribute("data-idx");
          const k = e.target.getAttribute("data-k");
          state.pi_family[idx] = state.pi_family[idx] || {
            name: "",
            webfile_no: "",
            again_webfile_no: "",
          };
          state.pi_family[idx][k] = e.target.value;
        };
      });
      wrapDiv.appendChild(row);
    }
  }
  $("#pi-submit").onclick = wrap(submitPersonalInfo);

  // Captcha sync (App <-> Pay sections)
  function syncCaptchaInputs() {
    const a = $("#app-captcha"),
      b = $("#ivachp-captcha");
    if (a && a.value !== state.app_captcha) a.value = state.app_captcha || "";
    if (b && b.value !== state.app_captcha) b.value = state.app_captcha || "";
  }
  $("#ivachp-captcha").value = state.app_captcha || "";
  $("#ivachp-captcha").oninput = (e) => {
    state.app_captcha = e.target.value.trim();
    savePref();
    syncCaptchaInputs();
  };
  $("#ivachp-captcha-grab").onclick = () => {
    const tok = tryGetCaptchaFromPage();
    if (tok) {
      state.app_captcha = tok;
      savePref();
      syncCaptchaInputs();
      alert("Got captcha token from page.");
    } else alert("Could not read captcha token automatically.");
  };

  // Overview
  $("#ov-submit").onclick = wrap(submitOverview);

  // Checkout/OTP/Slots/Pay
  $("#ivachp-checkout").onclick = wrap(doCheckout);
  $("#ivachp-otp-send").onclick = wrap(() => sendOtp(0));
  $("#ivachp-otp-resend").onclick = wrap(() => sendOtp(1));
  $("#ivachp-otp-verify").onclick = wrap(verifyOtp);
  $("#ivachp-otp").oninput = (e) =>
    (state.otp = e.target.value.replace(/\D/g, ""));
  $("#ivachp-date").onchange = wrap(async (e) => {
    await loadSlotTimes(e.target.value);
    savePayCtx();
  });
  $("#ivachp-fetch-slots").onclick = wrap(async () => {
    const d = $("#ivachp-date")?.value || "";
    if (!d) return alert("Pick a date first");
    await loadSlotTimes(d);
    savePayCtx();
  });
  $("#ivachp-time").onchange = (e) => {
    state.selectedTime = e.target.value;
    savePayCtx();
  };
  $("#ivachp-paynow").onclick = wrap(payNow);
  $("#ivachp-notify").onclick = wrap(notifyFeeChange);

  // ---------- Turnstile in iframes ----------
  function renderTurnstileInIframe(iframe, SITEKEY, CHAN) {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    const html = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' https: data:; script-src 'self' https://challenges.cloudflare.com 'unsafe-inline'; style-src 'self' 'unsafe-inline' https:; img-src https: data:; connect-src https:; frame-ancestors 'self';">
<style>html,body{margin:0;padding:0;background:#fff;font:14px system-ui}#ts-host{width:300px;height:65px;margin:10px}</style>
</head><body>
<div id="ts-host"></div>
<script>
(function(){
  var CHAN=${JSON.stringify(CHAN)};
  var SITEKEY=${JSON.stringify(SITEKEY)};
  function post(m){ try{ parent.postMessage(Object.assign({chan:CHAN, source:'ivac-bridge'}, m), parent.location.origin); }catch(e){} }
  function render(){
    try{
      window.turnstile.render(document.getElementById('ts-host'), {
        sitekey: SITEKEY,
        language: 'en',
        callback: function(token){ post({type:'ts-token', token: token||''}); },
        'error-callback': function(){ post({type:'ts-error', message:'error-callback'}); },
        'timeout-callback': function(){ post({type:'ts-error', message:'timeout'}); }
      });
      post({type:'ts-rendered'});
    }catch(e){ post({type:'ts-error', message:String(e&&e.message||e)}); }
  }
  function boot(){
    if(window.turnstile && window.turnstile.render){ render(); return; }
    var s=document.createElement('script');
    s.src=${JSON.stringify(PAY_TS_API)};
    s.async=true; s.defer=true; s.onload=render;
    s.onerror=function(){ post({type:'ts-error', message:'Turnstile script blocked'}); };
    document.head.appendChild(s);
  }
  boot();
})();
</script>
</body></html>`;
    doc.open();
    doc.write(html);
    doc.close();
  }

  function mountPaymentTurnstile() {
    const holder = document.getElementById("ivachp-ts-holder");
    if (!holder) return;
    unmountPaymentTurnstile();
    holder.style.display = "block";
    TS_IFRAME_PAY = document.getElementById("ivachp-ts-iframe");
    if (!TS_IFRAME_PAY) return;
    PAY_TS_TOKEN = "";
    renderTurnstileInIframe(TS_IFRAME_PAY, PAY_TS_SITEKEY, CHAN_PAY);
  }
  function unmountPaymentTurnstile() {
    const holder = document.getElementById("ivachp-ts-holder");
    if (holder) holder.style.display = "none";
    if (TS_IFRAME_PAY && TS_IFRAME_PAY.contentWindow) {
      try {
        TS_IFRAME_PAY.src = "about:blank";
      } catch {}
    }
    TS_IFRAME_PAY = null;
    PAY_TS_TOKEN = "";
  }

  function mountAppTurnstile() {
    const holder = document.getElementById("ivachp-app-ts-holder");
    if (!holder) return;
    unmountAppTurnstile();
    holder.style.display = "block";
    TS_IFRAME_APP = document.getElementById("ivachp-app-ts-iframe");
    if (!TS_IFRAME_APP) return;
    APP_TS_TOKEN = "";
    renderTurnstileInIframe(TS_IFRAME_APP, APP_TS_SITEKEY, CHAN_APP);
  }
  function unmountAppTurnstile() {
    const holder = document.getElementById("ivachp-app-ts-holder");
    if (holder) holder.style.display = "none";
    if (TS_IFRAME_APP && TS_IFRAME_APP.contentWindow) {
      try {
        TS_IFRAME_APP.src = "about:blank";
      } catch {}
    }
    TS_IFRAME_APP = null;
    APP_TS_TOKEN = "";
  }

  window.addEventListener("message", function (e) {
    const d = e.data || {};
    if (e.origin !== location.origin) return;
    if (d.source !== "ivac-bridge") return;

    if (d.chan === CHAN_PAY) {
      if (d.type === "ts-token") {
        PAY_TS_TOKEN = d.token || "";
        if (PAY_TS_TOKEN) {
          log("Pay CAPTCHA token: " + PAY_TS_TOKEN.slice(0, 12) + "…");
          const inp = panel && panel.querySelector("#ivachp-captcha");
          if (inp) inp.value = PAY_TS_TOKEN;
          state.app_captcha = PAY_TS_TOKEN;
        }
      } else if (d.type === "ts-rendered") {
        log("Pay Turnstile rendered (iframe).");
      } else if (d.type === "ts-error") {
        log("Pay Turnstile error: " + (d.message || "unknown"));
      }
    }

    if (d.chan === CHAN_APP) {
      if (d.type === "ts-token") {
        APP_TS_TOKEN = d.token || "";
        if (APP_TS_TOKEN) {
          log("App CAPTCHA token: " + APP_TS_TOKEN.slice(0, 12) + "…");
          const inp = panel && panel.querySelector("#app-captcha");
          if (inp) inp.value = APP_TS_TOKEN;
          state.app_captcha = APP_TS_TOKEN;
        }
      } else if (d.type === "ts-rendered") {
        log("App Turnstile rendered (iframe).");
      } else if (d.type === "ts-error") {
        log("App Turnstile error: " + (d.message || "unknown"));
      }
    }

    syncCaptchaInputs();
  });

  (function wirePayCaptchaToggles() {
    const on = panel.querySelector("#ivachp-paycap-on");
    const off = panel.querySelector("#ivachp-paycap-off");
    const ref = panel.querySelector("#ivachp-paycap-refresh");
    if (!on || !off || !ref) return;
    on.addEventListener("change", () => {
      if (on.checked) {
        log("Payment CAPTCHA enabled.");
        mountPaymentTurnstile();
      }
    });
    off.addEventListener("change", () => {
      if (off.checked) {
        log("Payment CAPTCHA disabled.");
        unmountPaymentTurnstile();
      }
    });
    ref.addEventListener("click", () => {
      log("Payment CAPTCHA refresh…");
      unmountPaymentTurnstile();
      setTimeout(mountPaymentTurnstile, 0);
    });
  })();

  (function wireAppCaptchaToggles() {
    const on = panel.querySelector("#ivachp-appcap-on");
    const off = panel.querySelector("#ivachp-appcap-off");
    const ref = panel.querySelector("#ivachp-appcap-refresh");
    if (!on || !off || !ref) return;
    on.addEventListener("change", () => {
      if (on.checked) {
        log("Application CAPTCHA enabled.");
        mountAppTurnstile();
      }
    });
    off.addEventListener("change", () => {
      if (off.checked) {
        log("Application CAPTCHA disabled.");
        unmountAppTurnstile();
      }
    });
    ref.addEventListener("click", () => {
      log("Application CAPTCHA refresh…");
      unmountAppTurnstile();
      setTimeout(mountAppTurnstile, 0);
    });
  })();

  // ---------- UTIL ----------
  function wrap(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        const s = e?.status | 0;
        if (isCFChallengePage()) {
          alert(
            "Cloudflare challenge is blocking requests. Wait until the page finishes, then try again."
          );
        } else if (s === 401 || s === 403) {
          alert(
            (e?.data?.message || e?.message || "Unauthorized") +
              "\nTip: your login may have expired. Refresh token by logging in again."
          );
        } else {
          alert(e?.message || String(e));
        }
        console.error(e);
        log("Error:", e?.status ? `[${e.status}]` : "", e?.message || e);
      }
    };
  }

  let _cfBannerTimer = null;
  function updateUI(logRoutes = true) {
    panel.querySelector("#ivachp-token").value = getLiveToken();
    panel.querySelector("#ivachp-lang").value = state.lang;
    panel.querySelector("#ivachp-isedit").value = String(state.isEdit);

    const ipInput = panel.querySelector("#ivachp-ip");
    if (ipInput) ipInput.value = state.clientIp || "";

    const c = state.checkout?.data;
    panel.querySelector("#ivachp-checkout-info").innerHTML = c
      ? `
      <div class="note">
        Phone: <b>${esc(c.mobile_no || "-")}</b><br>
        Fees: <b>${esc(c.fees || "0.00")}</b> | Conv: <b>${esc(
          c.convenience_fees || "0.00"
        )}</b> | Payable: <b>${esc(c.payable_amount || "0.00")}</b>
      </div>`
      : "";

    const payopts = panel.querySelector("#ivachp-payopts");
    payopts.innerHTML = "";
    const payEmpty = panel.querySelector("#ivachp-payopts-empty");
    if (state.paymentOptions.length === 0) {
      if (payEmpty) payEmpty.style.display = "block";
    } else {
      if (payEmpty) payEmpty.style.display = "none";
      state.paymentOptions.forEach((opt, i) => {
        const item = opt.item || opt || {};
        const category = opt.category ? String(opt.category).toUpperCase() : "";
        const isLogo =
          typeof item.link === "string" &&
          /\.(png|jpe?g|gif|svg)(\?|#|$)/i.test(item.link);
        const imgHtml = isLogo
          ? `<img src="${esc(item.link)}" alt="${esc(
              item.name || ""
            )}" onerror="this.style.display='none'">`
          : "";
        const r = el(`
          <label class="radio">
            <input type="radio" name="ivacpay" value="${i}">
            <div>
              <div>${imgHtml}<b>${esc(
          item.name || "Option " + (i + 1)
        )}</b> <span class="muted">${esc(item.slug || "")}</span></div>
              ${
                category
                  ? `<div class="muted">Category: ${esc(category)}</div>`
                  : ""
              }
              ${
                item.link
                  ? `<div class="muted" style="word-break:break-all">${esc(
                      item.link
                    )}</div>`
                  : ""
              }
            </div>
          </label>`);
        const input = r.querySelector("input");
        input.checked = i === state.selectedPaymentIndex;
        input.onchange = () => {
          state.selectedPaymentIndex = i;
          savePayCtx();
        };
        payopts.appendChild(r);
      });
    }

    const dateSel = panel.querySelector("#ivachp-date");
    dateSel.innerHTML = "";
    state.slotDates.forEach((d) => {
      const op = document.createElement("option");
      op.value = d;
      op.textContent = d;
      if (d === state.selectedDate) op.selected = true;
      dateSel.appendChild(op);
    });
    const timeSel = panel.querySelector("#ivachp-time");
    timeSel.innerHTML = "";
    state.slotTimes.forEach((t) => {
      const disp = esc(t.display);
      const left =
        typeof t.availableSlot === "number" ? ` (${t.availableSlot} left)` : "";
      const op = document.createElement("option");
      op.value = disp;
      op.textContent = disp + left;
      if (t.display === state.selectedTime) op.selected = true;
      timeSel.appendChild(op);
    });

    const payCaptcha = panel.querySelector("#ivachp-captcha");
    if (payCaptcha) payCaptcha.value = state.app_captcha || "";
    const appCaptcha = panel.querySelector("#app-captcha");
    if (appCaptcha) appCaptcha.value = state.app_captcha || "";

    if (logRoutes) {
      logResolved("app-submit", getRoute("app"), getTokenKey("app"));
      logResolved("pay-now", getRoute("now"), getTokenKey("now"));
    }
  }

  (function mountCFBanner() {
    const toggle = () => {
      cfBanner.style.display = isCFChallengePage() ? "block" : "none";
    };
    toggle();
    _cfBannerTimer = setInterval(toggle, 800);
  })();
  startCFWatch();

  // ---------- BOOTSTRAP ----------
  (function bootstrap() {
    const pageToken = readAccessTokenFromLS();
    if (pageToken && !state.token) state.token = pageToken;
    applyTokenToUI(readAccessTokenFromLS());
    startTokenAutoSync();
    const restored = restorePayCtx();
    if (restored) log("Restored Pay context from localStorage.");
    getClientIpOnce().catch(() => {});

    try {
      const shouldMin = localStorage.getItem(MIN_KEY);
      if (shouldMin === null) {
        panel.classList.add("min");
        localStorage.setItem(MIN_KEY, "1");
      } else if (shouldMin === "1") {
        panel.classList.add("min");
      } else {
        panel.classList.remove("min");
      }
    } catch {
      panel.classList.add("min");
    }

    panel.classList.add("min");

    updateUI(true);
    try {
      unmountPaymentTurnstile();
    } catch {}
    log("IVAC helper ready (guarded + persisted + server-actions).");
  })();
})();
