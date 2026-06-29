/*
  IVS Dashboard - User Activity Heartbeat
  File: public/js/user-activity.js

  Purpose:
  - Track online users for Developer Dashboard
  - Track the current protected dashboard page
  - Track daily / monthly / yearly website usage
  - Send heartbeat to: /api/user-activity/heartbeat

  Important:
  - Safe to include on protected dashboard pages.
  - Does not show anything in the UI.
  - Silently stops on login/developer/public pages.
  - Coordinates browser tabs so one visible tab sends the recurring heartbeat.
*/

(function () {
  "use strict";

  // Prevent duplicate initialization if this file is included more than once.
  if (window.__IVS_USER_ACTIVITY_HEARTBEAT_STARTED__) {
    return;
  }

  window.__IVS_USER_ACTIVITY_HEARTBEAT_STARTED__ = true;

  const CONFIG = {
    endpoint: "/api/user-activity/heartbeat",

    // The backend considers users online for the last 2 minutes.
    intervalMs: 45 * 1000,

    // Visible tabs coordinate through a short renewable localStorage lease.
    leaderRenewMs: 15 * 1000,
    leaderLeaseMs: 70 * 1000,

    // Prevent repeated focus/visibility/manual events from creating noise.
    minManualGapMs: 8 * 1000,
    minFinalGapMs: 1500,

    // A stalled request must not block all future heartbeats.
    requestTimeoutMs: 12 * 1000,

    excludedPathPrefixes: [
      "/login",
      "/developer",
      "/external-upload",
      "/api",
      "/uploads"
    ]
  };

  const state = {
    heartbeatTimer: null,
    leaderTimer: null,
    requestController: null,
    lastSentAt: 0,
    lastFinalAt: 0,
    lastUrl: "",
    stopped: false,
    inFlight: false,
    isLeader: false,
    tabId: getOrCreateTabId(),
    leaderKey: getLeaderStorageKey()
  };

  function getOrCreateTabId() {
    try {
      const key = "ivs_activity_tab_id";
      let value = sessionStorage.getItem(key);

      if (!value) {
        value = createId("tab");
        sessionStorage.setItem(key, value);
      }

      return value;
    } catch (error) {
      return createId("tab");
    }
  }

  function createId(prefix) {
    const randomPart = Math.random().toString(16).slice(2);
    return String(prefix || "id") + "_" + Date.now() + "_" + randomPart;
  }

  function getLeaderStorageKey() {
    const currentUserId = String(window.CURRENT_USER?.id || "").trim();
    const actorKey = currentUserId || "protected_session";
    return "ivs_activity_leader_" + actorKey;
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function readLeaderLease() {
    try {
      return safeJsonParse(localStorage.getItem(state.leaderKey) || "");
    } catch (error) {
      return null;
    }
  }

  function writeLeaderLease() {
    const now = Date.now();
    const lease = {
      tabId: state.tabId,
      expiresAt: now + CONFIG.leaderLeaseMs,
      updatedAt: now,
      url: window.location.href || ""
    };

    try {
      localStorage.setItem(state.leaderKey, JSON.stringify(lease));
      const saved = readLeaderLease();
      state.isLeader = !!saved && saved.tabId === state.tabId;
      return state.isLeader;
    } catch (error) {
      // localStorage may be unavailable. In that case, allow this tab to work.
      state.isLeader = true;
      return true;
    }
  }

  function releaseLeadership() {
    const current = readLeaderLease();

    if (current && current.tabId === state.tabId) {
      try {
        localStorage.removeItem(state.leaderKey);
      } catch (error) {
        // Silent fallback.
      }
    }

    state.isLeader = false;
  }

  function tryBecomeLeader() {
    if (state.stopped || shouldSkipPage() || !isDocumentVisible()) {
      state.isLeader = false;
      return false;
    }

    const now = Date.now();
    const current = readLeaderLease();
    const leaseExpired = !current || Number(current.expiresAt || 0) <= now;
    const alreadyMine = !!current && current.tabId === state.tabId;

    if (leaseExpired || alreadyMine) {
      return writeLeaderLease();
    }

    state.isLeader = false;
    return false;
  }

  function maintainLeadership() {
    if (state.stopped || shouldSkipPage()) return;

    const wasLeader = state.isLeader;
    const isLeaderNow = tryBecomeLeader();

    if (!wasLeader && isLeaderNow) {
      sendHeartbeat("leader_acquired", {
        manual: true,
        force: true
      });
    }
  }

  function shouldSkipPage() {
    const path = window.location.pathname || "/";

    return CONFIG.excludedPathPrefixes.some(function (prefix) {
      return path === prefix || path.startsWith(prefix + "/");
    });
  }

  function isDocumentVisible() {
    return document.visibilityState !== "hidden";
  }

  function getCurrentPagePayload(eventType) {
    const url = window.location.href || "";
    const path = window.location.pathname || "/";
    const query = window.location.search || "";
    const hash = window.location.hash || "";
    const title = document.title || "";

    return {
      currentPage: url,
      pagePath: path,
      pageQuery: query,
      pageHash: hash,
      pageTitle: title,
      eventType: eventType || "heartbeat",
      visibility: document.visibilityState || "visible",
      tabId: state.tabId,
      isLeader: state.isLeader,
      screen: {
        width: window.screen?.width || null,
        height: window.screen?.height || null
      },
      viewport: {
        width: window.innerWidth || null,
        height: window.innerHeight || null
      },
      timezone: getTimezone(),
      clientTime: new Date().toISOString()
    };
  }

  function getTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (error) {
      return "";
    }
  }

  function canSendFromThisTab(options) {
    const isFinal = !!options.final;
    const allowFollower = !!options.allowFollower;

    if (allowFollower) return true;
    if (isFinal) return state.isLeader;
    return state.isLeader;
  }

  async function sendHeartbeat(eventType, options) {
    options = options || {};

    if (state.stopped) return false;
    if (shouldSkipPage()) return false;
    if (!navigator.onLine) return false;
    if (!canSendFromThisTab(options)) return false;

    const now = Date.now();
    const isManual = !!options.manual;
    const isFinal = !!options.final;
    const force = !!options.force;

    if (!isFinal && !isManual && !isDocumentVisible()) {
      return false;
    }

    if (!isFinal && state.inFlight) {
      return false;
    }

    if (
      !isFinal &&
      isManual &&
      !force &&
      now - state.lastSentAt < CONFIG.minManualGapMs
    ) {
      return false;
    }

    if (isFinal && now - state.lastFinalAt < CONFIG.minFinalGapMs) {
      return false;
    }

    const payload = getCurrentPagePayload(eventType || "heartbeat");

    if (isFinal) {
      state.lastFinalAt = now;
    } else {
      state.lastSentAt = now;
      state.lastUrl = window.location.href || "";
    }

    if (isFinal && typeof navigator.sendBeacon === "function") {
      try {
        const blob = new Blob([JSON.stringify(payload)], {
          type: "application/json"
        });

        const queued = navigator.sendBeacon(CONFIG.endpoint, blob);
        if (queued) return true;
      } catch (error) {
        // Fall through to fetch with keepalive.
      }
    }

    state.inFlight = !isFinal;

    const controller = typeof AbortController === "function"
      ? new AbortController()
      : null;

    state.requestController = controller;

    const timeoutId = controller
      ? setTimeout(function () {
          controller.abort();
        }, CONFIG.requestTimeoutMs)
      : null;

    try {
      const response = await fetch(CONFIG.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(payload),
        keepalive: true,
        signal: controller?.signal
      });

      if (
        response.status === 401 ||
        response.status === 403 ||
        (response.redirected && response.url && response.url.includes("/login"))
      ) {
        stopHeartbeat();
        return false;
      }

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        const data = await response.json().catch(function () {
          return null;
        });

        if (
          data &&
          data.success === false &&
          /not allowed|login|session|unauthorized|forbidden/i.test(
            String(data.message || "")
          )
        ) {
          stopHeartbeat();
          return false;
        }
      }

      return response.ok;
    } catch (error) {
      // Abort/network failures are retried by the next interval.
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (state.requestController === controller) {
        state.requestController = null;
      }
      if (!isFinal) {
        state.inFlight = false;
      }
    }
  }

  function startTimers() {
    clearInterval(state.heartbeatTimer);
    clearInterval(state.leaderTimer);

    state.heartbeatTimer = setInterval(function () {
      if (!state.isLeader) {
        maintainLeadership();
        return;
      }

      writeLeaderLease();
      sendHeartbeat("heartbeat");
    }, CONFIG.intervalMs);

    state.leaderTimer = setInterval(function () {
      maintainLeadership();
    }, CONFIG.leaderRenewMs);
  }

  function startHeartbeat() {
    if (shouldSkipPage()) {
      stopHeartbeat();
      return;
    }

    state.stopped = false;
    state.leaderKey = getLeaderStorageKey();

    const becameLeader = tryBecomeLeader();
    startTimers();

    if (becameLeader) {
      sendHeartbeat("page_load", {
        manual: true,
        force: true
      });
    }
  }

  function stopHeartbeat() {
    state.stopped = true;

    clearInterval(state.heartbeatTimer);
    clearInterval(state.leaderTimer);
    state.heartbeatTimer = null;
    state.leaderTimer = null;

    if (state.requestController) {
      try {
        state.requestController.abort();
      } catch (error) {
        // Silent cleanup.
      }
      state.requestController = null;
    }

    state.inFlight = false;
    releaseLeadership();
  }

  function restartHeartbeatForUrlChange() {
    if (state.stopped) return;

    const currentUrl = window.location.href || "";

    if (currentUrl !== state.lastUrl) {
      if (!state.isLeader) maintainLeadership();

      sendHeartbeat("page_change", {
        manual: true,
        force: true
      });
    }
  }

  function wrapHistoryMethod(methodName) {
    const original = window.history[methodName];

    if (typeof original !== "function") return;
    if (original.__IVS_ACTIVITY_WRAPPED__) return;

    function wrappedHistoryMethod() {
      const result = original.apply(this, arguments);

      setTimeout(function () {
        restartHeartbeatForUrlChange();
      }, 50);

      return result;
    }

    wrappedHistoryMethod.__IVS_ACTIVITY_WRAPPED__ = true;
    window.history[methodName] = wrappedHistoryMethod;
  }

  function sendFinalAndRelease(eventType) {
    if (!state.isLeader) {
      releaseLeadership();
      return;
    }

    sendHeartbeat(eventType, {
      final: true
    });

    releaseLeadership();
  }

  function setupEvents() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        const becameLeader = tryBecomeLeader();

        if (becameLeader) {
          sendHeartbeat("tab_visible", {
            manual: true,
            force: true
          });
        }
      } else {
        sendFinalAndRelease("tab_hidden");
      }
    });

    window.addEventListener("focus", function () {
      if (!state.isLeader) maintainLeadership();

      sendHeartbeat("window_focus", {
        manual: true
      });
    });

    window.addEventListener("online", function () {
      if (!state.isLeader) maintainLeadership();

      sendHeartbeat("browser_online", {
        manual: true,
        force: true
      });
    });

    window.addEventListener("popstate", function () {
      setTimeout(function () {
        restartHeartbeatForUrlChange();
      }, 50);
    });

    window.addEventListener("pageshow", function () {
      if (state.stopped && !shouldSkipPage()) {
        startHeartbeat();
        return;
      }

      maintainLeadership();
      restartHeartbeatForUrlChange();
    });

    window.addEventListener("pagehide", function () {
      sendFinalAndRelease("page_hide");
    });

    window.addEventListener("beforeunload", function () {
      sendFinalAndRelease("page_unload");
    });

    window.addEventListener("storage", function (event) {
      if (event.key !== state.leaderKey) return;
      if (state.stopped || !isDocumentVisible()) return;

      const current = readLeaderLease();

      if (!current || Number(current.expiresAt || 0) <= Date.now()) {
        maintainLeadership();
        return;
      }

      state.isLeader = current.tabId === state.tabId;
    });

    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
  }

  function init() {
    setupEvents();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startHeartbeat, {
        once: true
      });
    } else {
      startHeartbeat();
    }
  }

  init();

  // Optional browser-console control/debug object.
  window.IVSUserActivity = {
    send: function () {
      if (!state.isLeader) maintainLeadership();

      return sendHeartbeat("manual_console", {
        manual: true,
        force: true
      });
    },
    stop: stopHeartbeat,
    start: startHeartbeat,
    isLeader: function () {
      return state.isLeader;
    },
    state: state
  };
})();
