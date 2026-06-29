// public/sidebar-toggle.js
(function () {
  "use strict";

  // Prevent duplicate listeners if this script is included more than once.
  if (window.__IVS_SIDEBAR_TOGGLE_STARTED__) {
    return;
  }
  window.__IVS_SIDEBAR_TOGGLE_STARTED__ = true;

  const STORAGE_KEY = "ivs_sidebar_collapsed";
  const MOBILE_BREAKPOINT = 992;
  const body = document.body;
  const sidebar = document.getElementById("ivsSidebar");
  const toggleButton = document.getElementById("sidebarToggleBtn");

  if (!body) return;

  let desktopCollapsed = readDesktopPreference();

  function readDesktopPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function saveDesktopPreference(collapsed) {
    desktopCollapsed = !!collapsed;

    try {
      localStorage.setItem(STORAGE_KEY, desktopCollapsed ? "1" : "0");
    } catch (error) {
      // localStorage can be blocked; keep the current-page state working.
    }
  }

  function isMobileViewport() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function isSidebarOpen() {
    const hasStateClass = body.classList.contains("sidebar-collapsed");

    // The shared CSS intentionally uses opposite class semantics:
    // desktop: class = hidden, mobile: class = open.
    return isMobileViewport() ? hasStateClass : !hasStateClass;
  }

  function syncAccessibility() {
    const expanded = isSidebarOpen();

    if (toggleButton) {
      toggleButton.setAttribute("aria-controls", "ivsSidebar");
      toggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggleButton.setAttribute(
        "aria-label",
        expanded ? "Close sidebar" : "Open sidebar"
      );
      toggleButton.title = expanded ? "Close Sidebar" : "Open Sidebar";
    }

    if (sidebar) {
      sidebar.setAttribute("aria-hidden", expanded ? "false" : "true");
    }
  }

  function applyViewportState() {
    if (isMobileViewport()) {
      // Mobile must always start closed. Mobile opens are temporary and are
      // deliberately not saved over the desktop preference.
      body.classList.remove("sidebar-collapsed");
    } else {
      body.classList.toggle("sidebar-collapsed", desktopCollapsed);
    }

    syncAccessibility();
  }

  function openSidebar(options) {
    options = options || {};

    if (isMobileViewport()) {
      body.classList.add("sidebar-collapsed");
    } else {
      body.classList.remove("sidebar-collapsed");
      if (options.persist !== false) saveDesktopPreference(false);
    }

    syncAccessibility();
  }

  function closeSidebar(options) {
    options = options || {};

    if (isMobileViewport()) {
      body.classList.remove("sidebar-collapsed");
    } else {
      body.classList.add("sidebar-collapsed");
      if (options.persist !== false) saveDesktopPreference(true);
    }

    syncAccessibility();
  }

  function toggleSidebar() {
    if (isSidebarOpen()) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  // Correct the saved desktop state for the current viewport immediately.
  // This also fixes the opposite mobile class semantics used by the CSS.
  applyViewportState();

  if (toggleButton) {
    toggleButton.addEventListener("click", function (event) {
      event.preventDefault();
      toggleSidebar();
    });
  }

  // On mobile, close when the user clicks outside the sidebar.
  document.addEventListener("click", function (event) {
    if (!isMobileViewport() || !isSidebarOpen()) return;

    const target = event.target;
    if (sidebar && sidebar.contains(target)) return;
    if (toggleButton && toggleButton.contains(target)) return;

    closeSidebar({ persist: false });
  });

  // Escape closes the mobile drawer without changing desktop preference.
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (!isMobileViewport() || !isSidebarOpen()) return;

    closeSidebar({ persist: false });

    if (toggleButton && typeof toggleButton.focus === "function") {
      toggleButton.focus();
    }
  });

  // After selecting a navigation item on mobile, close the drawer.
  if (sidebar) {
    sidebar.addEventListener("click", function (event) {
      const link = event.target.closest("a[href]");
      if (!link || !isMobileViewport()) return;

      closeSidebar({ persist: false });
    });
  }

  // Re-apply the correct semantics when crossing the mobile breakpoint.
  let resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      applyViewportState();
    }, 120);
  });

  // Keep desktop collapse preference synchronized across browser tabs.
  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY) return;

    desktopCollapsed = event.newValue === "1";

    if (!isMobileViewport()) {
      body.classList.toggle("sidebar-collapsed", desktopCollapsed);
      syncAccessibility();
    }
  });

  // Browser back/forward cache can restore stale classes.
  window.addEventListener("pageshow", function () {
    desktopCollapsed = readDesktopPreference();
    applyViewportState();
  });

  // Optional shared controls for debugging or future UI buttons.
  window.IVSSidebar = {
    open: openSidebar,
    close: closeSidebar,
    toggle: toggleSidebar,
    isOpen: isSidebarOpen,
    sync: applyViewportState
  };
})();
