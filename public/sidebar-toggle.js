// public/sidebar-toggle.js
(function () {
  // ✅ Always apply saved state (even if toggle button is not present on a page)
  const saved = localStorage.getItem("ivs_sidebar_collapsed");
  if (saved === "1") {
    document.body.classList.add("sidebar-collapsed");
  } else {
    document.body.classList.remove("sidebar-collapsed");
  }

  // ✅ Attach toggle only if button exists
  const btn = document.getElementById("sidebarToggleBtn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-collapsed");

    const isCollapsed = document.body.classList.contains("sidebar-collapsed");
    localStorage.setItem("ivs_sidebar_collapsed", isCollapsed ? "1" : "0");
  });
})();
