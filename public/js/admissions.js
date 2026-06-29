const API_URL = "/api/admissions";

let CURRENT_USER = null;
let USER_PERMS = null;
let DIRTY_ROW_FORM_ID = null;
let DIRTY_ROW_ADMISSION_ID = null;
let ROW_SAVING_IN_PROGRESS = false;
let LAST_VIEW_STATE_KEY = "ivs_pipeline_view_state";

document.addEventListener("DOMContentLoaded", () => {
  boot();
});

async function boot() {
  if (window.CURRENT_USER || window.USER_PERMS) {
    CURRENT_USER = window.CURRENT_USER || null;
    USER_PERMS = window.USER_PERMS || null;
  } else {
    await loadMe();
  }

  applyUiPermissions();

  initWhatsAppModal();
  initBillingModal();
  initUnsavedRowGuard();
  initUploadFlashActionBridge();
  initRowUpdateOverlayBridge();

  restoreViewportState();

  window.addEventListener("pageshow", function () {
    hideRowSavingOverlay();
    restoreViewportState();
  });
}

function getCurrentMonthKey() {
  // january..december (same keys as billing object)
  return new Date().toLocaleString("en-US", { month: "long" }).toLowerCase();
}


async function loadMe() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) return;

    CURRENT_USER = data.user || null;
    USER_PERMS = data.perms || null;

    window.CURRENT_USER = CURRENT_USER;
    window.USER_PERMS = USER_PERMS;
  } catch (e) {
    console.error("loadMe error:", e);
  }
}

/**
 * ✅ NEW: strict permission check
 * - super_admin => always true
 * - if perms missing => fallback (default false)
 */
function getNested(obj, path) {
  try {
    const parts = String(path || "").split(".");
    let cur = obj;
    for (const p of parts) {
      if (!cur || typeof cur !== "object" || !(p in cur)) return undefined;
      cur = cur[p];
    }
    return cur;
  } catch {
    return undefined;
  }
}

function isSuperUser() {
  if (window.IS_SUPER === true) return true;
  const u = CURRENT_USER || {};
  return !!(
    u.role === "superadmin" ||
    u.role === "super_admin" ||
    u.agentType === "superadmin" ||
    u.agentType === "super_admin" ||
    u.isSuperAdmin === true ||
    u.is_super_admin === true
  );
}

function pFlag(key, fallback = false) {
  if (isSuperUser()) return true;

  let perms = USER_PERMS;
  if (!perms) return fallback;

  // if perms stored as JSON string
  try {
    if (typeof perms === "string") perms = JSON.parse(perms);
  } catch {}

  // wildcard
  if (perms === true) return true;

  // array format
  if (Array.isArray(perms)) {
    return perms.includes(key) || perms.includes("*") || perms.includes("all");
  }

  // object format
  if (typeof perms === "object") {
    if (key in perms) return !!perms[key];

    const nested = getNested(perms, key);
    if (typeof nested !== "undefined") return !!nested;

    const alt = key.replace(/\./g, "_");
    if (alt in perms) return !!perms[alt];

    return fallback;
  }

  return fallback;
}
function pAny(keys = [], fallback = false) {
  for (const k of keys) {
    if (pFlag(k, false)) return true;
  }
  return fallback;
}


/**
 * ✅ Button + Column visibility
 */
function applyUiPermissions() {
  // Buttons (classes should exist in your EJS)
  toggleByPerm(".btn-whatsapp", "btnWhatsApp");
  toggleByPerm(".btn-billing", "btnBilling");
  toggleByPerm(".action-pdf, .mini-pdf", "btnPdf");
  toggleByPerm(".action-upload", "btnUpload");

  toggleByPerm(".btn-row-edit", "btnEditRow");
  toggleByPerm(".action-update", "btnUpdateRow");
  toggleBulkChallanByPerm();
  toggleByAnyPerm(".btn-file-delete", [
  "btnDeleteFile",
  "btnFilesDelete",
  "btnDeleteFiles",
  "deleteFile",
  "canDeleteFiles"
]);
  // Columns
  applyColumnVisibility();
}

function toggleByPerm(selector, permKey) {
  const allowed = pFlag(permKey, false);
  document.querySelectorAll(selector).forEach((b) => {
    if (!allowed) {
      b.classList.add("d-none");
      b.setAttribute("disabled", "disabled");
    }
  });
}
function toggleByAnyPerm(selector, permKeys) {
  const allowed = pAny(permKeys, false);
  document.querySelectorAll(selector).forEach((b) => {
    if (!allowed) {
      b.classList.add("d-none");
      b.setAttribute("disabled", "disabled");
    }
  });
}
function toggleBulkChallanByPerm() {
  const canCreate = pFlag("btnUpdateRow", false);
  const canSend = pFlag("btnWhatsApp", false);
  const allowed = canCreate || canSend;

  document.querySelectorAll(".bulk-challan-open-btn").forEach((btn) => {
    if (!allowed) {
      btn.classList.add("d-none");
      btn.setAttribute("disabled", "disabled");
    }
  });
}
/**
 * ✅ Column visibility supports 2 approaches:
 * 1) Recommended: <th data-perm="colPhone">Phone</th>
 * 2) Backward:    <th data-col="phone">Phone</th>  (mapped below)
 */
function applyColumnVisibility() {
  const table =
    document.getElementById("superAdmissionsTable") ||
    document.getElementById("adminAdmissionsTable") ||
    document.getElementById("agentAccountsTable");
  if (!table) return;

  const colKeys = new Set();
  table.querySelectorAll("thead th[data-col], tbody td[data-col]").forEach((el) => {
    const k = el.getAttribute("data-col");
    if (k) colKeys.add(k);
  });

  colKeys.forEach((colKey) => {
    const permKey = mapColToPerm(colKey);
    const visible = permKey ? pFlag(permKey, false) : true;

    table.querySelectorAll(`[data-col="${colKey}"]`).forEach((el) => {
      el.style.display = visible ? "" : "none";
    });
  });
}


function mapColToPerm(colKey) {
  const k = String(colKey || "").trim();

  const map = {
    status: "colStatus",
    feeStatus: "colFeeStatus",
    dept: "colDept",
    student: "colStudentName",
    father: "colFatherName",
    fatherEmail: "colFatherEmail",
    grade: "colGrade",
    tuitionGrade: "colTuitionGrade",
    phone: "colPhone",
    processedBy: "colProcessedBy",

    paymentStatus: "colPaymentStatus",
    paidUpto: "colPaidUpto",
    verificationNumber: "colVerificationNumber",
    registrationNumber: "colRegistrationNumber",
    familyNumber: "colFamilyNumber",

    registrationFee: "colRegistrationFee",
    fees: "colFees",
    currency: "colCurrency",
    bank: "colBank",
    month: "colMonth",
    totalFees: "colTotalFees",
    pendingDues: "colPendingDues",
    receivedPayment: "colReceivedPayment",

    invoiceStatus: "colInvoiceStatus",
    invoiceStatusTimestamp: "colInvoiceStatusTimestamp",
    paidInvoiceStatus: "colPaidInvoiceStatus",
    paidInvoiceStatusTimestamp: "colPaidInvoiceStatusTimestamp",

    actions: "colActionButtons",
    actionButtons: "colActionButtons",
  };

  return map[k] || null;
}

function getRowFormIdFromElement(el) {
  const formId = el?.getAttribute?.("form");
  if (formId) return formId;

  const row = el?.closest?.("tr");
  if (!row) return null;

  const form = row.querySelector('form[id^="rowForm_"]');
  return form ? form.id : null;
}

function getAdmissionIdFromFormId(formId) {
  if (!formId) return null;
  const m = String(formId).match(/^rowForm_(\d+)$/);
  return m ? m[1] : null;
}

function markRowDirty(formId) {
  if (!formId) return;
  DIRTY_ROW_FORM_ID = formId;
  DIRTY_ROW_ADMISSION_ID = getAdmissionIdFromFormId(formId);
}

function clearDirtyRow(formId = null) {
  if (!formId || DIRTY_ROW_FORM_ID === formId) {
    DIRTY_ROW_FORM_ID = null;
    DIRTY_ROW_ADMISSION_ID = null;
  }
}

function showUnsavedRowWarning() {
  const msg = "You have unsaved changes in the previous row. Please update that row first.";

  if (window.showUploadFlash) {
    showUploadFlashWithAction("danger", "Unsaved row", msg, {
      buttonText: "Update",
      mode: "dirty-update"
    });
  } else {
    alert(msg);
  }
}

window.clearDirtyPipelineRow = clearDirtyRow;
window.markDirtyPipelineRow = markRowDirty;
function finishRowSaveFlow() {
  setTimeout(() => {
    hideRowSavingOverlay();
    restoreViewportState();
  }, 2000);
}

function refreshWorkflowCardFromResponse(admissionId, admission = {}) {
  const cleanId = String(
    admissionId || admission?.id || ""
  ).trim();

  if (!cleanId) return;

  const card = document.querySelector(
    `.admission-card[data-admission-id="${CSS.escape(cleanId)}"]`
  );

  if (!card) return;

  if (
    typeof window.updateAdmissionWorkflowCard ===
    "function"
  ) {
    window.updateAdmissionWorkflowCard(card, {
      ...(admission || {}),
      id: admission?.id || cleanId,
    });
  }

  if (
    typeof window.updateSchoolForwardCounts ===
    "function"
  ) {
    window.updateSchoolForwardCounts();
  }
}

async function submitRowFormAjax(form, formIdOverride = "") {
  if (!form) return;

  const formId = formIdOverride || form.id || "";
  const active = document.activeElement;
  const fieldName =
    active?.getAttribute?.("name") ||
    active?.getAttribute?.("data-field") ||
    "";

  beginRowSaveFlow(formId, fieldName, "Updating row...");

  try {
    const formData = new FormData(form);
const body = new URLSearchParams();

for (const [key, value] of formData.entries()) {
  body.append(key, value == null ? "" : String(value));
}

const res = await fetch(form.action, {
  method: (form.method || "POST").toUpperCase(),
  body,
  headers: {
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
  }
});

    let data = {};
    let parsedJson = false;

    try {
      data = await res.json();
      parsedJson = true;
    } catch (_) {
      parsedJson = false;
    }

    if (parsedJson) {
      if (!res.ok || data.success === false) {
        throw new Error(data.message || "Row update failed");
      }
    } else if (!res.ok) {
      throw new Error("Row update failed");
    }

    const savedAdmissionId =
      data.admissionId ||
      getAdmissionIdFromFormId(formId) ||
      "";

    const savedAdmission =
      data.admission ||
      data.updatedAdmission ||
      data.updatedFields ||
      data;

    refreshWorkflowCardFromResponse(
      savedAdmissionId,
      savedAdmission
    );

    clearDirtyRow(formId);
finishRowSaveFlow();

setTimeout(() => {
  if (typeof saveViewportState === "function") {
    saveViewportState(formId, fieldName);
  }

  if (window.showUploadFlash) {
    window.showUploadFlash(
      "success",
      "Updated",
      "Row updated successfully."
    );
  }
}, 300);

  } catch (err) {
    console.error("Row update error:", err);
    hideRowSavingOverlay();

    if (window.showUploadFlash) {
      window.showUploadFlash(
        "danger",
        "Update Failed",
        err.message || "Record update failed."
      );
    } else {
      alert(err.message || "Record update failed.");
    }
  }
}

function submitRowFormExactlyLikeUpdateButton(formId) {
  if (!formId) return;

  const form = document.getElementById(formId);
  if (!form) return;

  submitRowFormAjax(form, formId);
}

function showUploadFlashWithAction(type, title, message, opts = {}) {
  const {
    buttonText = "Okay",
    mode = ""
  } = opts;

  if (window.showUploadFlash) {
    window.showUploadFlash(type, title, message);
  } else {
    alert(message || title || "Notification");
    return;
  }

  const btn = document.getElementById("upload-flash-close-btn");
  const xBtn = document.getElementById("upload-flash-x-btn");

  if (btn) {
    btn.textContent = buttonText;
    if (mode) {
      btn.setAttribute("data-flash-mode", mode);
    } else {
      btn.removeAttribute("data-flash-mode");
    }
  }

  if (xBtn) {
    if (mode) {
      xBtn.setAttribute("data-flash-mode", mode);
    } else {
      xBtn.removeAttribute("data-flash-mode");
    }
  }
}

function getPipelineScroller() {
  return document.querySelector(".pipeline-scroll");
}

function showRowSavingOverlay(message = "Updating row...") {
  const overlay = document.getElementById("row-saving-overlay");
  if (!overlay) return;

  const textEl = document.getElementById("row-saving-text");
  if (textEl) textEl.textContent = message;

  overlay.classList.remove("d-none");
  document.body.classList.add("row-saving-active");
  ROW_SAVING_IN_PROGRESS = true;
}

function hideRowSavingOverlay() {
  const overlay = document.getElementById("row-saving-overlay");
  if (overlay) overlay.classList.add("d-none");
  document.body.classList.remove("row-saving-active");
  ROW_SAVING_IN_PROGRESS = false;
}

function saveViewportState(formId = null, fieldName = null) {
  try {
    const scroller = getPipelineScroller();
    const active = document.activeElement;

    const payload = {
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
      tableScrollLeft: scroller ? scroller.scrollLeft : 0,
      formId: formId || getRowFormIdFromElement(active),
      fieldName:
        fieldName ||
        active?.getAttribute?.("name") ||
        active?.getAttribute?.("data-field") ||
        "",
      ts: Date.now()
    };

    sessionStorage.setItem(LAST_VIEW_STATE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("saveViewportState error:", e);
  }
}

function restoreViewportState() {
  try {
    const raw = sessionStorage.getItem(LAST_VIEW_STATE_KEY);
    if (!raw) return;

    const state = JSON.parse(raw || "{}");
    const scroller = getPipelineScroller();

    window.scrollTo(state.scrollX || 0, state.scrollY || 0);

    if (scroller && typeof state.tableScrollLeft === "number") {
      scroller.scrollLeft = state.tableScrollLeft;
    }

    if (state.formId) {
      const form = document.getElementById(state.formId);
      if (form) {
        const row = form.closest("tr");
        if (row) {
          row.scrollIntoView({ block: "nearest", inline: "nearest" });
        }

        if (state.fieldName) {
          const field =
            form.querySelector(`[name="${CSS.escape(state.fieldName)}"]`) ||
            document.querySelector(`[form="${state.formId}"][name="${CSS.escape(state.fieldName)}"]`);

          if (field) {
            setTimeout(() => {
              try {
                field.focus({ preventScroll: true });
              } catch (_) {
                field.focus();
              }
            }, 80);
          }
        }
      }
    }

    setTimeout(() => {
      sessionStorage.removeItem(LAST_VIEW_STATE_KEY);
    }, 1200);
  } catch (e) {
    console.warn("restoreViewportState error:", e);
  }
}

function beginRowSaveFlow(formId = null, fieldName = null, message = "Updating row...") {
  saveViewportState(formId, fieldName);
  showRowSavingOverlay(message);
}

function initUploadFlashActionBridge() {
  const btn = document.getElementById("upload-flash-close-btn");
  const xBtn = document.getElementById("upload-flash-x-btn");
  const overlay = document.getElementById("upload-flash-overlay");

  if (!btn || !overlay) return;

  const defaultText = "Okay";

  function closeFlashOnly() {
    btn.textContent = defaultText;
    btn.removeAttribute("data-flash-mode");
    if (xBtn) xBtn.removeAttribute("data-flash-mode");

    overlay.classList.add("fade-out");
    setTimeout(() => {
      overlay.classList.add("d-none");
      overlay.classList.remove("fade-out");
    }, 260);
  }

  document.addEventListener("click", function (e) {
    const actionBtn = e.target.closest("#upload-flash-close-btn");
    const crossBtn = e.target.closest("#upload-flash-x-btn");

    if (!actionBtn && !crossBtn) return;

    if (crossBtn) {
      closeFlashOnly();
      return;
    }

    const mode = actionBtn.getAttribute("data-flash-mode") || "";

    if (mode !== "dirty-update") {
      closeFlashOnly();
      return;
    }

    actionBtn.textContent = defaultText;
    actionBtn.removeAttribute("data-flash-mode");
    if (xBtn) xBtn.removeAttribute("data-flash-mode");

    if (DIRTY_ROW_FORM_ID) {
      submitRowFormExactlyLikeUpdateButton(DIRTY_ROW_FORM_ID);
    }
  });
}

function initUnsavedRowGuard() {
  const table =
    document.getElementById("superAdmissionsTable") ||
    document.getElementById("adminAdmissionsTable") ||
    document.getElementById("agentAccountsTable");

  if (!table) return;

  // 1) mark row dirty when user changes anything
    
    
   table.addEventListener("input", function (e) {
  const target = e.target;
  if (!target) return;

  if (!target.matches("input[form], select[form], textarea[form]")) return;

  const formId = getRowFormIdFromElement(target);
  if (!formId) return;

  markRowDirty(formId);
});

  table.addEventListener("change", function (e) {
    const target = e.target;
    if (!target) return;

    if (!target.matches("input[form], select[form], textarea[form]")) return;

    const formId = getRowFormIdFromElement(target);
    if (!formId) return;

    markRowDirty(formId);
  });

  // 2) block editing another row if previous row dirty
  table.addEventListener(
    "focusin",
    function (e) {
      const target = e.target;
      if (!target) return;

      if (!target.matches("input[form], select[form], textarea[form]")) return;

      const currentFormId = getRowFormIdFromElement(target);
      if (!currentFormId) return;

      if (
        DIRTY_ROW_FORM_ID &&
        DIRTY_ROW_FORM_ID !== currentFormId
      ) {
        showUnsavedRowWarning();

        const dirtyBtn = document.querySelector(
          `button[form="${DIRTY_ROW_FORM_ID}"][type="submit"]`
        );
        if (dirtyBtn) {
          dirtyBtn.focus();
        } else {
          target.blur();
        }
      }
    },
    true
  );
    // 3) when row form submits, clear dirty state
  table.addEventListener("submit", function (e) {
  const form = e.target;
  if (!form || !form.id || !form.id.startsWith("rowForm_")) return;

  e.preventDefault();
  submitRowFormAjax(form, form.id);
});
}
function initRowUpdateOverlayBridge() {
  // no-op
}
async function loadAdmissions() {
  try {
    const res = await fetch(API_URL, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.success === false) {
      throw new Error(data?.message || "Admissions load failed");
    }

    const rows = Array.isArray(data)
      ? data
      : (
          Array.isArray(data?.admissions)
            ? data.admissions
            : (
                Array.isArray(data?.rows)
                  ? data.rows
                  : (
                      Array.isArray(data?.data)
                        ? data.data
                        : []
                    )
              )
        );

    renderAdmissions(rows);
  } catch (err) {
    console.error("Error loading admissions:", err);
  }
}

function renderAdmissions(rows) {
  const tbody = document.getElementById("admissions-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const safeRows = Array.isArray(rows) ? rows : [];

  safeRows.forEach((row, i) => {
    const tr = document.createElement("tr");

    // NOTE: Ye render aapke current table structure par depend karta hai.
    // Is ko aap jab admissions.ejs bhejoge, main exact columns ke saath align kar dunga.
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${row.student_name || ""}</td>
      <td>${row.grade || ""}</td>
      <td>${row.father_name || ""}</td>
      <td>${row.currency || row.currency_code || ""}</td>
      <td>${row.bank_name || row.bankName || ""}</td>
    `;

    tbody.appendChild(tr);
  });

  // after render, apply hide columns (if data-perm/data-col exists)
  applyColumnVisibility();
}

/* =========================
   ✅ Confirm Modal helper
========================= */
function openConfirmModal({
  title = "Confirm",
  message = "Are you sure?",
  confirmText = "Delete",
  cancelText = "Cancel",
} = {}) {
  return new Promise((resolve) => {
    const modalEl = document.getElementById("confirmModal");

    if (!modalEl || typeof bootstrap === "undefined" || !bootstrap.Modal) {
      resolve(!!window.confirm(message));
      return;
    }

    const titleEl = document.getElementById("confirmModalTitle");
    const bodyEl = document.getElementById("confirmModalBody");
    const okBtn = document.getElementById("confirmModalOk");
    const cancelBtn = document.getElementById("confirmModalCancel");

    if (!titleEl || !bodyEl || !okBtn || !cancelBtn) {
      resolve(!!window.confirm(message));
      return;
    }

    titleEl.textContent = title;
    bodyEl.textContent = message;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

    let done = false;

    const cleanup = () => {
      okBtn.removeEventListener("click", onOk);
      modalEl.removeEventListener("hidden.bs.modal", onHidden);
    };

    const finish = (val) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(val);
    };

    const onOk = () => {
      modal.hide();
      finish(true);
    };

    const onHidden = () => finish(false);

    okBtn.addEventListener("click", onOk);
    modalEl.addEventListener("hidden.bs.modal", onHidden);

    modal.show();
  });
}
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-file-delete");
  if (!btn) return;

  // ✅ permission gate
  const allowed = pAny([
    "btnDeleteFile",
    "btnFilesDelete",
    "btnDeleteFiles",
    "deleteFile",
    "canDeleteFiles"
  ], false);

  if (!allowed) {
    alert("You do not have permission to delete files.");
    return;
  }

  const fileId = btn.getAttribute("data-file-id");
  if (!fileId) {
    alert("File id missing");
    return;
  }

  const ok = await openConfirmModal({
    title: "Confirm delete",
    message: "Are you sure you want to delete this file?",
    confirmText: "Delete",
    cancelText: "Cancel",
  });
  if (!ok) return;

  try {
   const url = `/files/${fileId}`;
    const res = await fetch(url, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      alert((data && data.message) || "Delete failed");
      return;
    }
   
    // ✅ UI remove card (optional)
    const card = btn.closest(".file-card") || btn.closest(".card") || btn.closest("tr");
if (card) {
  card.remove();
}

if (typeof window.rebuildAdmissionFilesDropdowns === "function") {
  window.rebuildAdmissionFilesDropdowns();
}

if (typeof window.updateSchoolForwardCounts === "function") {
  window.updateSchoolForwardCounts();
}

  } catch (err) {
    console.error(err);
    alert("Delete failed");
  }
});
function updateForwardButtonAfterUpload(admissionId) {
  if (!admissionId) return;

  const cleanAdmissionId = String(admissionId);

  const card = document.querySelector(
    `.admission-card[data-admission-id="${CSS.escape(cleanAdmissionId)}"]`
  );

  if (!card) return;

  const dept = String(
    card.getAttribute("data-dept") || ""
  )
    .trim()
    .toLowerCase();

  const forwardStatus = String(
    card.getAttribute("data-forward-status") ||
    "not_forwarded"
  )
    .trim()
    .toLowerCase();

  const forwardSubStatus = String(
    card.getAttribute("data-forward-sub-status") ||
    ""
  )
    .trim()
    .toLowerCase();

  const currentReturnStatus = String(
    card.getAttribute("data-school-return-status") ||
    ""
  )
    .trim()
    .toLowerCase();

  const activeUser =
    CURRENT_USER ||
    window.CURRENT_USER ||
    {};

  const activeUserDept = String(
    activeUser.dept ||
    activeUser.department ||
    ""
  )
    .trim()
    .toLowerCase();

  const changedToReupload =
    (isSuperUser() || activeUserDept === "school") &&
    dept === "school" &&
    currentReturnStatus === "not_received";

  const nextReturnStatus =
    changedToReupload
      ? "reupload"
      : currentReturnStatus;

  const currentReuploadTagActive =
    card.getAttribute(
      "data-reupload-tag-active"
    ) === "1";

  const nextReuploadTagActive =
    changedToReupload ||
    currentReuploadTagActive ||
    nextReturnStatus === "reupload";

  const nextWorkflowTag =
    nextReturnStatus === "not_received"
      ? "Not Received"
      : nextReuploadTagActive
        ? "Reupload"
        : "";

  const canForwardNow =
    dept === "school" &&
    (
      forwardStatus !== "forwarded" ||
      nextReturnStatus === "reupload"
    );

  card.setAttribute(
    "data-has-upload",
    "1"
  );

  card.setAttribute(
    "data-uploaded-by-current-user",
    "1"
  );

  card.setAttribute(
    "data-school-return-status",
    nextReturnStatus
  );

  card.setAttribute(
    "data-reupload-tag-active",
    nextReuploadTagActive ? "1" : "0"
  );

  card.setAttribute(
    "data-can-forward",
    canForwardNow ? "1" : "0"
  );

  card.setAttribute(
    "data-not-received-visible-for-current-user",
    nextReturnStatus === "not_received" ||
    nextReturnStatus === "reupload"
      ? "1"
      : "0"
  );

  const workflowAdmission = {
    id: cleanAdmissionId,
    forwardStatus,
    forwardSubStatus,
    schoolReturnStatus: nextReturnStatus,
    school_return_status: nextReturnStatus,
    reuploadTagActive:
      nextReuploadTagActive ? 1 : 0,
    reupload_tag_active:
      nextReuploadTagActive ? 1 : 0,
    workflowTag: nextWorkflowTag,
    canShowForwardButton: canForwardNow,
    notReceivedVisibleForCurrentUser:
      nextReturnStatus === "not_received" ||
      nextReturnStatus === "reupload",
  };

  if (
    typeof window.updateAdmissionWorkflowCard ===
    "function"
  ) {
    window.updateAdmissionWorkflowCard(
      card,
      workflowAdmission
    );
  }

  /*
   * Manual fallback:
   * Super/Admin/Agent/Sub Agent dashboard script available
   * na ho tab bhi Forward button correctly show ho.
   */
  if (canForwardNow) {
    const actions = card.querySelector(
      ".admission-card-actions"
    );

    if (actions) {
      const forwardedDone = actions.querySelector(
        ".mini-forwarded-done"
      );

      if (forwardedDone) {
        forwardedDone.remove();
      }

      let forwardBtn = actions.querySelector(
        ".btn-forward-admission"
      );

      if (!forwardBtn) {
        forwardBtn =
          document.createElement("button");

        forwardBtn.type = "button";

        forwardBtn.className =
          "mini-action-btn mini-forward btn-forward-admission";

        forwardBtn.innerHTML =
          '<i class="bi bi-send"></i> Forward';

        const deleteBtn = actions.querySelector(
          ".btn-delete-admission"
        );

        if (deleteBtn) {
          actions.insertBefore(
            forwardBtn,
            deleteBtn
          );
        } else {
          actions.appendChild(
            forwardBtn
          );
        }
      }

      const studentTitle = card.querySelector(
        ".admission-title"
      );

      const studentName = studentTitle
        ? String(
            studentTitle.textContent || ""
          ).trim()
        : "";

      forwardBtn.setAttribute(
        "data-admission-id",
        cleanAdmissionId
      );

      forwardBtn.setAttribute(
        "data-student",
        studentName || "Student"
      );

      forwardBtn.classList.remove(
        "d-none"
      );
    }
  }

  if (
    typeof window.rebuildAdmissionFilesDropdowns ===
    "function"
  ) {
    window.rebuildAdmissionFilesDropdowns();
  }

  if (
    typeof window.updateSchoolForwardCounts ===
    "function"
  ) {
    window.updateSchoolForwardCounts();
  }
}
// ✅ Upload handler (GLOBAL)
document.addEventListener("change", async (e) => {
  const input = e.target;
  if (!input || input.type !== "file") return;

  const admissionId = input.getAttribute("data-admission-id");
  if (!admissionId) return;

  if (!pFlag("btnUpload", false)) {
    alert("You do not have permission to upload files.");
    input.value = "";
    return;
  }

  const file = input.files && input.files[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("admission_id", admissionId);
  fd.append("file", file);

  try {
    const res = await fetch("/uploads", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      alert((data && data.message) || "Upload failed");
      return;
    }

   window.showUploadFlash
  ? window.showUploadFlash("success", "Uploaded", "File uploaded successfully.")
  : alert("Uploaded ✅");

if (typeof window.rebuildAdmissionFilesDropdowns === "function") {
  window.rebuildAdmissionFilesDropdowns();
}

updateForwardButtonAfterUpload(admissionId);

input.value = "";
  } catch (err) {
    console.error(err);
    alert("Upload failed");
  }
});

/* =========================
   ✅ WhatsApp Modal
========================= */
function initWhatsAppModal() {
  // ✅ permission gate (NEW)
  if (!pFlag("btnWhatsApp", false)) return;

  const modalEl = document.getElementById("waModal");
  if (!modalEl) return;

  const waStudent = document.getElementById("waStudent");
  const waGrade = document.getElementById("waGrade");
  const waPhone = document.getElementById("waPhone");
  const waId = document.getElementById("waId");

  const waAddCustom = document.getElementById("waAddCustom");
  const waCustomText = document.getElementById("waCustomText");
  const waOptionsWrap = document.getElementById("waOptions");
  const waManualMsg = document.getElementById("waManualMsg");
  const waSendBtn = document.getElementById("waSendBtn");

  if (
    !waStudent || !waGrade || !waPhone || !waId ||
    !waAddCustom || !waCustomText || !waOptionsWrap || !waManualMsg || !waSendBtn
  ) return;

  let currentAdmissionId = null;

  function getRowFieldValue(row, name) {
    const el = row.querySelector(`[name="${name}"]`);
    return el ? (el.value || "").trim() : "";
  }

  function resetModal() {
    waManualMsg.value = "";
    waCustomText.value = "";
  }

  async function loadOptionsAndRender() {
    try {
      const res = await fetch("/api/whatsapp/options");
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        waOptionsWrap.innerHTML = `<div class="small text-danger">Options load failed</div>`;
        return;
      }
      renderOptions(Array.isArray(data.data) ? data.data : []);
    } catch (e) {
      console.error(e);
      waOptionsWrap.innerHTML = `<div class="small text-danger">Options load failed</div>`;
    }
  }

  function renderOptions(list) {
    waOptionsWrap.innerHTML = "";

    if (!list.length) {
      waOptionsWrap.innerHTML = `<div class="small text-muted">No options found.</div>`;
      return;
    }

    const isSuper = isSuperUser();

    list.forEach((opt) => {
      const id = Number(opt.id);
      const key = String(opt.opt_key || "");
      const label = String(opt.label || "");
      const isCustom = Number(opt.is_custom) === 1;

      const wrap = document.createElement("div");
      wrap.className = "border rounded-3 p-2 bg-white d-flex align-items-center justify-content-between";

      wrap.innerHTML = `
        <label class="m-0 d-flex align-items-center gap-2" style="cursor:pointer; flex:1;">
          <input type="checkbox" class="wa-opt" value="${escapeHtml(key)}"
            data-id="${id}"
            data-label="${escapeHtml(label)}"
            data-custom="${isCustom ? "1" : "0"}"
          >
          <span>${escapeHtml(label)}</span>
        </label>
        ${
          (isCustom && isSuper)
            ? `<button type="button" class="btn btn-sm btn-outline-danger wa-del" data-id="${id}">Delete</button>`
            : ""
        }
      `;

      waOptionsWrap.appendChild(wrap);
    });

    waOptionsWrap.querySelectorAll(".wa-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        if (!id) return;

        const ok = await openConfirmModal({
          title: "Delete option",
          message: "Do you want to delete this custom option?",
          confirmText: "Delete",
          cancelText: "Cancel",
        });
        if (!ok) return;

        try {
          const res = await fetch(`/api/whatsapp/options/${id}`, { method: "DELETE" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) {
            alert((data && data.message) || "Delete failed");
            return;
          }
          await loadOptionsAndRender();
        } catch {
          alert("Delete failed");
        }
      });
    });
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-whatsapp");
    if (!btn) return;

    currentAdmissionId = btn.getAttribute("data-admission-id");
    const row = btn.closest("tr");
    if (!row) return;

    waStudent.textContent = getRowFieldValue(row, "student") || "-";
    waGrade.textContent = getRowFieldValue(row, "grade") || "-";
    waPhone.textContent = getRowFieldValue(row, "phone") || "-";
    waId.textContent = currentAdmissionId || "-";

    resetModal();
    await loadOptionsAndRender();

    if (typeof bootstrap === "undefined" || !bootstrap.Modal) {
      alert("Bootstrap JS not loaded. Please refresh.");
      return;
    }
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  });

  waAddCustom.addEventListener("click", async (e) => {
    e.preventDefault();

    if (!isSuperUser()) {
      alert("Only Super Admin can add custom options.");
      return;
    }

    const text = (waCustomText.value || "").trim();
    if (!text) return;

    waAddCustom.disabled = true;
    try {
      const res = await fetch("/api/whatsapp/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: text }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        alert((data && data.message) || "Add failed");
        return;
      }

      waCustomText.value = "";
      await loadOptionsAndRender();
    } catch (err) {
      console.error(err);
      alert("Add failed");
    } finally {
      waAddCustom.disabled = false;
    }
  });

  waSendBtn.addEventListener("click", async () => {
    if (!currentAdmissionId) return;

    const actions = [];
    modalEl.querySelectorAll(".wa-opt:checked").forEach((c) => {
      actions.push({
        key: c.value,
        label: c.getAttribute("data-label") || "",
        isCustom: c.getAttribute("data-custom") === "1",
      });
    });

    const payload = {
      admissionId: currentAdmissionId,
      actions,
      manualMessage: (waManualMsg.value || "").trim(),
    };

    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        window.showUploadFlash
          ? window.showUploadFlash("danger", "WhatsApp failed", (data && data.message) || "Failed")
          : alert((data && data.message) || "Failed");
        return;
      }

      window.showUploadFlash
        ? window.showUploadFlash("success", "Sent to n8n", "WhatsApp request sent successfully.")
        : alert("Sent to n8n successfully ✅");

      const inst = bootstrap.Modal.getInstance(modalEl);
      if (inst) inst.hide();
    } catch (err) {
      console.error(err);
      window.showUploadFlash
        ? window.showUploadFlash("danger", "Network error", "Could not reach server.")
        : alert("Network error");
    }
  });

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
}

/* =========================
   ✅ Billing Modal (Jan–Dec)
========================= */
function initBillingModal() {
  // ✅ permission gate (NEW)
  if (!pFlag("btnBilling", false)) return;

  const modalEl = document.getElementById("billingModal");
  if (!modalEl) return;

  const billStudent = document.getElementById("billStudent");
  const billGrade = document.getElementById("billGrade");
  const billPhone = document.getElementById("billPhone");
  const billId = document.getElementById("billId");
  const billCurrency = document.getElementById("billCurrency");
  const billSaveBtn = document.getElementById("billSaveBtn");
  const billYearSelect = document.getElementById("billingYearSelect");

  // ✅ saving billing now depends on btnUpdateRow (your "Update/Save button")
  const canSave = pFlag("btnUpdateRow", false);

  if (billSaveBtn && !canSave) {
    billSaveBtn.setAttribute("disabled", "disabled");
    billSaveBtn.classList.add("disabled");
  }

  const inputs = {
    january: document.getElementById("bill_january"),
    february: document.getElementById("bill_february"),
    march: document.getElementById("bill_march"),
    april: document.getElementById("bill_april"),
    may: document.getElementById("bill_may"),
    june: document.getElementById("bill_june"),
    july: document.getElementById("bill_july"),
    august: document.getElementById("bill_august"),
    september: document.getElementById("bill_september"),
    october: document.getElementById("bill_october"),
    november: document.getElementById("bill_november"),
    december: document.getElementById("bill_december"),
  };

  const feeInputs = {
    january: document.getElementById("bill_fee_january"),
    february: document.getElementById("bill_fee_february"),
    march: document.getElementById("bill_fee_march"),
    april: document.getElementById("bill_fee_april"),
    may: document.getElementById("bill_fee_may"),
    june: document.getElementById("bill_fee_june"),
    july: document.getElementById("bill_fee_july"),
    august: document.getElementById("bill_fee_august"),
    september: document.getElementById("bill_fee_september"),
    october: document.getElementById("bill_fee_october"),
    november: document.getElementById("bill_fee_november"),
    december: document.getElementById("bill_fee_december"),
  };

  const feeLabels = {
    january: document.getElementById("bill_fee_label_january"),
    february: document.getElementById("bill_fee_label_february"),
    march: document.getElementById("bill_fee_label_march"),
    april: document.getElementById("bill_fee_label_april"),
    may: document.getElementById("bill_fee_label_may"),
    june: document.getElementById("bill_fee_label_june"),
    july: document.getElementById("bill_fee_label_july"),
    august: document.getElementById("bill_fee_label_august"),
    september: document.getElementById("bill_fee_label_september"),
    october: document.getElementById("bill_fee_label_october"),
    november: document.getElementById("bill_fee_label_november"),
    december: document.getElementById("bill_fee_label_december"),
  };
const verifInputs = {
  january: document.getElementById("bill_verif_january"),
  february: document.getElementById("bill_verif_february"),
  march: document.getElementById("bill_verif_march"),
  april: document.getElementById("bill_verif_april"),
  may: document.getElementById("bill_verif_may"),
  june: document.getElementById("bill_verif_june"),
  july: document.getElementById("bill_verif_july"),
  august: document.getElementById("bill_verif_august"),
  september: document.getElementById("bill_verif_september"),
  october: document.getElementById("bill_verif_october"),
  november: document.getElementById("bill_verif_november"),
  december: document.getElementById("bill_verif_december"),
};

const bankInputs = {
  january: document.getElementById("bill_bank_january"),
  february: document.getElementById("bill_bank_february"),
  march: document.getElementById("bill_bank_march"),
  april: document.getElementById("bill_bank_april"),
  may: document.getElementById("bill_bank_may"),
  june: document.getElementById("bill_bank_june"),
  july: document.getElementById("bill_bank_july"),
  august: document.getElementById("bill_bank_august"),
  september: document.getElementById("bill_bank_september"),
  october: document.getElementById("bill_bank_october"),
  november: document.getElementById("bill_bank_november"),
  december: document.getElementById("bill_bank_december"),
};


  function setFeeLabelsFromCalc(calc) {
    const perMonth =
      (calc && (calc.perMonth || calc.per_month || calc.months)) || null;

    let baseFee = "";
    if (currentRow) {
      const feeEl = currentRow.querySelector(`[name="fees"]`);
      baseFee = feeEl ? (feeEl.value || "").trim() : "";
    }
    let cur = "";
    if (currentRow) {
    const curEl =
    currentRow.querySelector(`[name="currency_code"]`) ||
    currentRow.querySelector(`[name="currency"]`);
    cur = curEl ? (curEl.value || "").trim() : "";
    }


    Object.keys(inputs).forEach((m) => {
      const el = feeLabels[m];
      if (!el) return;

      const fee =
        perMonth && perMonth[m] && perMonth[m].fee != null
          ? Number(perMonth[m].fee)
          : (baseFee ? Number(baseFee) : 0);

      el.textContent = fee > 0 
      ? `Fee${cur ? " (" + cur + ")" : ""}: ${fee}` 
      : `Fee${cur ? " (" + cur + ")" : ""}: -`;
    });
  }

  if (!billStudent || !billGrade || !billPhone || !billId || !billSaveBtn) return;
  for (const k of Object.keys(inputs)) if (!inputs[k]) return;
  for (const k of Object.keys(verifInputs)) if (!verifInputs[k]) return;
  for (const k of Object.keys(bankInputs)) if (!bankInputs[k]) return;


  const statusSelects = {};
  Object.keys(inputs).forEach((m) => {
    statusSelects[m] = modalEl.querySelector(`.bill-status[data-month="${m}"]`);
  });

  function applyStatusClass(sel) {
    if (!sel) return;
    sel.classList.remove("status-notadmitted", "status-nopayment", "status-partial", "status-full");

    const v = (sel.value || "").trim();
    if (v === "Not admitted") sel.classList.add("status-notadmitted");
    else if (v === "No payment") sel.classList.add("status-nopayment");
    else if (v === "Partial payment") sel.classList.add("status-partial");
    else if (v === "Full payment") sel.classList.add("status-full");
  }

  function toggleFeeBox(month) {
  const sel = statusSelects[month];
  const wrap = document.getElementById(`bill_fee_wrap_${month}`);
  if (!sel || !wrap) return;

  wrap.classList.add("d-none");
}


 Object.keys(inputs).forEach((m) => {
  const sel = statusSelects[m];
  if (!sel) return;
  sel.addEventListener("change", () => {
    applyStatusClass(sel);
    toggleFeeBox(m);
  });
});

  function setAllInputsEmpty() {
    Object.keys(inputs).forEach((k) => (inputs[k].value = ""));
    Object.keys(feeInputs).forEach((k) => feeInputs[k] && (feeInputs[k].value = ""));
    Object.keys(verifInputs).forEach((k) => verifInputs[k] && (verifInputs[k].value = ""));
    Object.keys(bankInputs).forEach((k) => bankInputs[k] && (bankInputs[k].value = ""));

    Object.keys(statusSelects).forEach((k) => {
      if (statusSelects[k]) {
        statusSelects[k].value = "";
        applyStatusClass(statusSelects[k]);

        const wrap = document.getElementById(`bill_fee_wrap_${k}`);
        if (wrap) wrap.classList.add("d-none");
      }
    });

    Object.keys(feeLabels).forEach((m) => {
      if (feeLabels[m]) feeLabels[m].textContent = "Fee: -";
    });

setTimeout(() => {
  if (window.applyDynamicBillingColors) {
    window.applyDynamicBillingColors();
  }
}, 0);
}
function getSelectedBillingYear() {
  const y = Number(billYearSelect?.value || new Date().getFullYear());
  if (!Number.isInteger(y) || y < 2020 || y > 2100) {
    return new Date().getFullYear();
  }
  return y;
}
  let currentAdmissionId = null;
let currentRow = null;
let loadedBillingSnapshot = {};

  function getRowFieldValue(row, name) {
    const el = row.querySelector(`[name="${name}"]`);
    return el ? (el.value || "").trim() : "";
  }

  async function loadBillingFromDb(admissionId) {
    setAllInputsEmpty();

    try {
      const billingYear = getSelectedBillingYear();
const res = await fetch(`/api/billing/${admissionId}?year=${billingYear}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) return;

      const b = data.billing || {};
      loadedBillingSnapshot = JSON.parse(JSON.stringify(b || {}));
      setFeeLabelsFromCalc(data.calc || data.calculation || {});

      Object.keys(inputs).forEach((k) => {
        const entry = b[k] || {};
        const sel = statusSelects[k];

        if (sel) {
          sel.value = (entry.status || "").toString();
          applyStatusClass(sel);
          toggleFeeBox(k);
        }

        inputs[k].value = (entry.amount || "").toString();
        if (feeInputs[k]) feeInputs[k].value = (entry.feeOverride || "").toString();
        if (verifInputs[k]) {
        verifInputs[k].value = (entry.verification || entry.verif || entry.verificationNumber || "").toString();
        }
        if (bankInputs[k]) {
  setBankSelectValueSafe(
    bankInputs[k],
    entry.bank || entry.bankName || entry.bank_name || entry.number || ""
  );
}
       });
      setTimeout(() => {
  if (window.applyDynamicBillingColors) {
    window.applyDynamicBillingColors();
  }
}, 0);
    } catch (e) {
      console.error("billing load error:", e);
    }
  }

  function normalizeBillValue(v) {
  return String(v || "").trim();
}
function setBankSelectValueSafe(selectEl, value) {
  if (!selectEl) return;

  const finalValue = String(value || "").trim();

  if (!finalValue) {
    selectEl.value = "";
    selectEl.setAttribute("data-prev-value", "");
    return;
  }

  const exists = Array.from(selectEl.options).some(opt =>
    String(opt.value || "").trim().toLowerCase() === finalValue.toLowerCase()
  );

  if (!exists) {
    const addOption = Array.from(selectEl.options).find(opt =>
      opt.value === "__add_new_bank__"
    );

    const option = document.createElement("option");
    option.value = finalValue;
    option.textContent = finalValue;

    if (addOption) {
      selectEl.insertBefore(option, addOption);
    } else {
      selectEl.appendChild(option);
    }
  }

  selectEl.value = finalValue;
  selectEl.setAttribute("data-prev-value", finalValue);
}
function getLatestChangedBillingValues(nextBilling) {
  let latestChangedMonthKey = "";

  for (const k of Object.keys(inputs)) {
    const beforeItem = loadedBillingSnapshot[k] || {};
    const afterItem = nextBilling[k] || {};

    const beforeStatus = normalizeBillValue(beforeItem.status);
    const beforeAmount = normalizeBillValue(beforeItem.amount);
    const beforeVerification =
      normalizeBillValue(beforeItem.verification) ||
      normalizeBillValue(beforeItem.verif) ||
      normalizeBillValue(beforeItem.verificationNumber);
    const beforeBank =
      normalizeBillValue(beforeItem.bank) ||
      normalizeBillValue(beforeItem.bankName) ||
      normalizeBillValue(beforeItem.bank_name) ||
      normalizeBillValue(beforeItem.number);

    const afterStatus = normalizeBillValue(afterItem.status);
    const afterAmount = normalizeBillValue(afterItem.amount);
    const afterVerification = normalizeBillValue(afterItem.verification);
    const afterBank = normalizeBillValue(afterItem.bank);

    const changed =
      beforeStatus !== afterStatus ||
      beforeAmount !== afterAmount ||
      beforeVerification !== afterVerification ||
      beforeBank !== afterBank;

    if (changed) {
      latestChangedMonthKey = k;
    }
  }

  if (!latestChangedMonthKey) {
    return null;
  }

  return {
    verification: normalizeBillValue(
      nextBilling[latestChangedMonthKey]?.verification
    ),
    bank: normalizeBillValue(
      nextBilling[latestChangedMonthKey]?.bank
    ),
  };
}

function updateCurrentRowBillingField(fieldKey, value) {
  if (!currentRow || value === null || typeof value === "undefined") return;

  const selectors = {
    verificationNumber: [
      'td[data-col="verificationNumber"] input',
      'input[name="verificationNumber"]',
    ],
    bank: [
      'td[data-col="bank"] select',
      'td[data-col="bank"] input',
      'select[name="bank"]',
      'select[name="bank_name"]',
      'input[name="bank"]',
      'input[name="bank_name"]',
    ],
  };

  const selectorList = selectors[fieldKey] || [];
  const control = selectorList
    .map((selector) => currentRow.querySelector(selector))
    .find(Boolean);

  if (control) {
    control.value = value || "";
  }

  const cardField = currentRow.querySelector(
    `.admission-field-link[data-field-key="${CSS.escape(fieldKey)}"] .field-value`
  );

  if (cardField) {
    const displayValue = value || "-";
    cardField.textContent = displayValue;
    cardField.setAttribute("title", displayValue);
  }
}

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-billing");
    if (!btn) return;

    /*
     * Card dashboards already own their Billing open/load/save workflow
     * inside the page-specific EJS scripts. This shared file only owns
     * the legacy table-row billing flow, otherwise both handlers can
     * submit the same billing payload.
     */
    const row = btn.closest("tr");

    if (!row) {
      currentAdmissionId = null;
      currentRow = null;
      loadedBillingSnapshot = {};
      return;
    }

    currentAdmissionId = btn.getAttribute("data-admission-id");
    currentRow = row;

    if (billYearSelect && !billYearSelect.value) {
      billYearSelect.value = String(new Date().getFullYear());
    }

    billStudent.textContent = getRowFieldValue(row, "student") || "-";
    billGrade.textContent = getRowFieldValue(row, "grade") || "-";
    billPhone.textContent = getRowFieldValue(row, "phone") || "-";
    billId.textContent = currentAdmissionId || "-";

    if (billCurrency) {
      billCurrency.textContent =
        getRowFieldValue(row, "currency_code") ||
        getRowFieldValue(row, "currency") ||
        "-";
    }

    await loadBillingFromDb(currentAdmissionId);

    if (typeof bootstrap === "undefined" || !bootstrap.Modal) {
      alert("Bootstrap JS not loaded. Please refresh.");
      return;
    }
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
    setTimeout(() => {
  if (window.applyDynamicBillingColors) {
    window.applyDynamicBillingColors();
  }
}, 150);

  });

  billSaveBtn.addEventListener("click", async () => {
    if (!canSave) return;
    if (!currentAdmissionId) return;

    const billing = {};

for (const k of Object.keys(inputs)) {
  const statusVal = (statusSelects[k]?.value || "").trim();

 

  billing[k] = {
    status: statusVal,
    amount: (inputs[k].value || "").trim(),
    feeOverride: (feeInputs[k]?.value || "").trim(),
    verification: (verifInputs[k]?.value || "").trim(),
    bank: (bankInputs[k]?.value || "").trim(),
  };
}

    billSaveBtn.disabled = true;

    try {
    const billingYear = getSelectedBillingYear();

const res = await fetch(`/api/billing/${currentAdmissionId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    year: billingYear,
    billing
  }),
});

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        window.showUploadFlash
          ? window.showUploadFlash("danger", "Save failed", (data && data.message) || "Save failed")
          : alert((data && data.message) || "Save failed");
        return;
      }

    window.showUploadFlash
  ? window.showUploadFlash("success", "Saved", "Data has been saved.")
  : alert("Data has been saved ✅");

const latestBillingValues = getLatestChangedBillingValues(billing);

if (latestBillingValues) {
  updateCurrentRowBillingField(
    "verificationNumber",
    latestBillingValues.verification
  );

  updateCurrentRowBillingField(
    "bank",
    latestBillingValues.bank
  );
}

// Snapshot update so the next save compares against the latest values.
loadedBillingSnapshot = JSON.parse(JSON.stringify(billing || {}));

const inst = bootstrap.Modal.getInstance(modalEl);
if (inst) inst.hide();
    } catch (err) {
      console.error(err);
      window.showUploadFlash
        ? window.showUploadFlash("danger", "Network error", "Could not reach server.")
        : alert("Network error");
    } finally {
      billSaveBtn.disabled = false;
    }
  });
  if (billYearSelect) {
  billYearSelect.addEventListener("change", async () => {
    if (!currentAdmissionId) return;
    await loadBillingFromDb(currentAdmissionId);

    setTimeout(() => {
      if (window.applyDynamicBillingColors) {
        window.applyDynamicBillingColors();
      }
    }, 0);
  });
}
  function applyBillStatusClass(selectEl) {
  if (!selectEl) return;

  // remove old classes
  selectEl.classList.remove(
  "status-notadmitted",
  "status-nopayment",
  "status-partial",
  "status-full"
);

  const v = (selectEl.value || "").toLowerCase().trim();

  if (v === "not admitted") selectEl.classList.add("status-notadmitted");
  else if (v === "no payment") selectEl.classList.add("status-nopayment");
  else if (v === "partial payment") selectEl.classList.add("status-partial");
  else if (v === "full payment") selectEl.classList.add("status-full");
}

function refreshAllBillStatus() {
  document.querySelectorAll("#billingModal .bill-status").forEach(applyBillStatusClass);
}

// when user changes status
document.addEventListener("change", (e) => {
  if (e.target && e.target.classList.contains("bill-status")) {
    applyBillStatusClass(e.target);

    if (window.applyDynamicBillingColors) {
      window.applyDynamicBillingColors();
    }
  }
});

// when modal opens
document.addEventListener("shown.bs.modal", (e) => {
  if (e.target && e.target.id === "billingModal") {
    refreshAllBillStatus();

    setTimeout(() => {
      if (window.applyDynamicBillingColors) {
        window.applyDynamicBillingColors();
      }
    }, 0);
  }
});

}
