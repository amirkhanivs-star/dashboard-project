(function () {
  "use strict";

  // Same file accidental duplicate load ho to
  // second socket connection create na ho.
  if (window.__USER_PERMS_LIVE_INITIALIZED__) {
    return;
  }

  window.__USER_PERMS_LIVE_INITIALIZED__ = true;

  let reloadStarted = false;

  function reloadDashboard() {
    if (reloadStarted) {
      return;
    }

    reloadStarted = true;

    document.documentElement.classList.add(
      "ivs-loading"
    );

    if (
      typeof window.smoothDashboardReload ===
      "function"
    ) {
      window.smoothDashboardReload(500);
      return;
    }

    window.location.reload();
  }

  async function getCurrentUserId() {
    const pageUserId = Number(
      window.CURRENT_USER?.id || 0
    );

    if (pageUserId) {
      return pageUserId;
    }

    const response = await fetch("/api/me", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return 0;
    }

    const result = await response
      .json()
      .catch(() => ({}));

    return Number(result?.user?.id || 0);
  }

  function handleUserUpdate(myUserId, payload) {
    const targetUserId = Number(
      payload?.userId || 0
    );

    if (!targetUserId) {
      return;
    }

    if (targetUserId !== myUserId) {
      return;
    }

    reloadDashboard();
  }

  let permissionInitRetryTimer = null;
  let permissionSocketStarted = false;

  function schedulePermissionInitRetry() {
    if (
      permissionSocketStarted ||
      permissionInitRetryTimer
    ) {
      return;
    }

    permissionInitRetryTimer =
      window.setTimeout(
        function () {
          permissionInitRetryTimer = null;
          startPermissionUpdates();
        },
        1500
      );
  }

  async function initializePermissionUpdates() {
    if (permissionSocketStarted) {
      return true;
    }

    /*
     * Socket.IO script kabhi kabhi is file ke
     * baad load hoti hai. Is case mein permanently
     * stop hone ke bajaye retry karenge.
     */
    if (typeof window.io !== "function") {
      return false;
    }

    const myUserId =
      await getCurrentUserId();

    /*
     * /api/me temporary fail ho to live updates
     * permanently disable nahi honi chahiye.
     */
    if (!myUserId) {
      return false;
    }

    const socket = window.io();

    permissionSocketStarted = true;

    window.__USER_PERMS_LIVE_SOCKET__ =
      socket;

    socket.on(
      "user:updated",
      function (payload) {
        handleUserUpdate(
          myUserId,
          payload
        );
      }
    );

    socket.on(
      "user:permissions-updated",
      function (payload) {
        handleUserUpdate(
          myUserId,
          payload
        );
      }
    );

    return true;
  }

  function startPermissionUpdates() {
    initializePermissionUpdates()
      .then(function (started) {
        if (!started) {
          schedulePermissionInitRetry();
        }
      })
      .catch(function (error) {
        console.error(
          "Live permission update error:",
          error
        );

        schedulePermissionInitRetry();
      });
  }

  startPermissionUpdates();
})();
