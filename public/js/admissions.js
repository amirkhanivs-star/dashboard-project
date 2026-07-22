const API_URL = "/api/admissions";
function buildAdmissionsApiUrl() {
  const params = new URLSearchParams(window.location.search || "");
  const apiParams = new URLSearchParams();

  [
    "schoolUserId",
    "schoolTeamUserId",
    "teamUserId",
    "view",
    "accountsView",
    "accountsPipeline",
    "pipelineType",
    "forwardedToType",
    "forwardStatus"
  ].forEach((key) => {
    const value = params.get(key);
    if (value) {
      apiParams.set(key, value);
    }
  });

  const query = apiParams.toString();
  return query ? `${API_URL}?${query}` : API_URL;
}
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
 * ✅ Can View / Can Edit permission helpers
 * - No automatic role permission bypass
 * - Boolean, numeric and string values supported
 * - Legacy View → Edit fallback supported
 */
function getNested(obj, path) {
  try {
    const parts = String(path || "")
      .split(".")
      .filter(Boolean);

    let current = obj;

    for (const part of parts) {
      if (
        !current ||
        typeof current !== "object" ||
        !(part in current)
      ) {
        return undefined;
      }

      current = current[part];
    }

    return current;
  } catch {
    return undefined;
  }
}

/*
 * Keep this function.
 * It is still required by existing workflow and
 * WhatsApp custom-option role logic.
 */
function isSuperUser() {
  if (window.IS_SUPER === true) {
    return true;
  }

  const user = CURRENT_USER || {};

  return !!(
    user.role === "superadmin" ||
    user.role === "super_admin" ||
    user.agentType === "superadmin" ||
    user.agentType === "super_admin" ||
    user.isSuperAdmin === true ||
    user.is_super_admin === true
  );
}

function permissionEnabled(value) {
  if (value === true || value === 1) {
    return true;
  }

  if (
    value === false ||
    value === 0 ||
    value === null ||
    typeof value === "undefined"
  ) {
    return false;
  }

  return [
    "1",
    "true",
    "on",
    "yes"
  ].includes(
    String(value)
      .trim()
      .toLowerCase()
  );
}

function getPermissionSource() {
  let perms =
    window.USER_PERMS ??
    USER_PERMS ??
    null;

  try {
    if (typeof perms === "string") {
      perms = JSON.parse(perms);
    }
  } catch {
    perms = null;
  }

  return perms;
}

function hasOwnPermission(perms, key) {
  return !!(
    perms &&
    typeof perms === "object" &&
    !Array.isArray(perms) &&
    Object.prototype.hasOwnProperty.call(
      perms,
      key
    )
  );
}

function hasPermissionEntry(key) {
  const cleanKey =
    String(key || "").trim();

  if (!cleanKey) {
    return false;
  }

  const perms =
    getPermissionSource();

  if (!perms) {
    return false;
  }

  if (Array.isArray(perms)) {
    return perms.includes(cleanKey);
  }

  if (typeof perms !== "object") {
    return false;
  }

  if (hasOwnPermission(perms, cleanKey)) {
    return true;
  }

  if (
    typeof getNested(perms, cleanKey) !==
    "undefined"
  ) {
    return true;
  }

  const alternateKey =
    cleanKey.replace(/\./g, "_");

  return hasOwnPermission(
    perms,
    alternateKey
  );
}

function pFlag(key, fallback = false) {
  const cleanKey =
    String(key || "").trim();

  if (!cleanKey) {
    return fallback;
  }

  const perms =
    getPermissionSource();

  if (!perms) {
    return fallback;
  }

  if (perms === true) {
    return true;
  }

  if (Array.isArray(perms)) {
    return (
      perms.includes(cleanKey) ||
      perms.includes("*") ||
      perms.includes("all")
    );
  }

  if (typeof perms === "object") {
    if (hasOwnPermission(perms, cleanKey)) {
      return permissionEnabled(
        perms[cleanKey]
      );
    }

    const nested =
      getNested(perms, cleanKey);

    if (typeof nested !== "undefined") {
      return permissionEnabled(nested);
    }

    const alternateKey =
      cleanKey.replace(/\./g, "_");

    if (
      hasOwnPermission(
        perms,
        alternateKey
      )
    ) {
      return permissionEnabled(
        perms[alternateKey]
      );
    }
  }

  return fallback;
}

function pAny(keys = [], fallback = false) {
  for (const key of keys || []) {
    if (pFlag(key, false)) {
      return true;
    }
  }

  return fallback;
}

const COLUMN_VIEW_KEY_MAP = Object.freeze({
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
  comment: "colComment",
  invoiceStatus: "colInvoiceStatus",
  invoiceStatusTimestamp: "colInvoiceStatusTimestamp",
  paidInvoiceStatus: "colPaidInvoiceStatus",
  paidInvoiceStatusTimestamp: "colPaidInvoiceStatusTimestamp",
  actionButtons: "colActionButtons"
});

const COLUMN_EDIT_KEY_MAP = Object.freeze({
  status: "editStatus",
  feeStatus: "editFeeStatus",
  dept: "editDept",
  student: "editStudentName",
  father: "editFatherName",
  fatherEmail: "editFatherEmail",
  grade: "editGrade",
  tuitionGrade: "editTuitionGrade",
  phone: "editPhone",
  paymentStatus: "editPaymentStatus",
  verificationNumber: "editVerificationNumber",
  registrationNumber: "editRegistrationNumber",
  familyNumber: "editFamilyNumber",
  registrationFee: "editRegistrationFee",
  fees: "editFees",
  currency: "editCurrency",
  bank: "editBank",
  month: "editMonth",
  comment: "editComment"
});

const COLUMN_VIEW_LEGACY_KEY_MAP =
  Object.freeze({
    phone: [
      "showPhone"
    ],

    paymentStatus: [
      "showPaymentStatus"
    ],

    paidUpto: [
      "showPaidUpto"
    ],

    verificationNumber: [
      "showVerificationNumber"
    ],

    registrationNumber: [
      "showRegistrationNumber"
    ]
  });

const FIELD_NAME_TO_COLUMN_KEY =
  Object.freeze({
    status: "status",
    feeStatus: "feeStatus",
    dept: "dept",

    student: "student",
    student_name: "student",
    studentName: "student",

    father: "father",
    father_name: "father",
    fatherName: "father",

    father_email: "fatherEmail",
    fatherEmail: "fatherEmail",

    grade: "grade",

    tuitionGrade: "tuitionGrade",
    tuition_grade: "tuitionGrade",

    phone: "phone",

    paymentStatus: "paymentStatus",
    accounts_payment_status: "paymentStatus",
    accountsPaymentStatus: "paymentStatus",
    fee_status: "paymentStatus",

    paidUpto: "paidUpto",
    accounts_paid_upto: "paidUpto",
    accountsPaidUpto: "paidUpto",

    verificationNumber: "verificationNumber",
    verification_number: "verificationNumber",
    accounts_verification_number: "verificationNumber",
    verificationNumber2: "verificationNumber",
    secondVerificationNumber: "verificationNumber",
    accounts_verification_number_2: "verificationNumber",

    registrationNumber: "registrationNumber",
    registration_number: "registrationNumber",
    accounts_registration_number: "registrationNumber",

    familyNumber: "familyNumber",
    family_number: "familyNumber",
    accounts_family_number: "familyNumber",

    registrationFee: "registrationFee",
    admission_registration_fee: "registrationFee",

    fees: "fees",
    admission_fees: "fees",
    monthlyFee: "fees",
    baseFee: "fees",

    currency: "currency",
    currency_code: "currency",
    currencyCode: "currency",

    bank: "bank",
    bank_name: "bank",
    bankName: "bank",

    month: "month",
    admission_month: "month",

    totalFees: "totalFees",
    total_fees: "totalFees",

    pendingDues: "pendingDues",
    pending_dues: "pendingDues",

    receivedPayment: "receivedPayment",
    received_payment: "receivedPayment",

    comment: "comment",
    admission_comment: "comment",
    admissionComment: "comment",

    invoiceStatus: "invoiceStatus",
    invoiceStatusTimestamp: "invoiceStatusTimestamp",
    paidInvoiceStatus: "paidInvoiceStatus",
    paidInvoiceStatusTimestamp: "paidInvoiceStatusTimestamp"
  });

function hasExplicitEditSchema() {
  return Object.values(
    COLUMN_EDIT_KEY_MAP
  ).some((key) =>
    hasPermissionEntry(key)
  );
}

function pCol(name) {
  const key =
    String(name || "").trim();

  const permissionKey =
    COLUMN_VIEW_KEY_MAP[key];

  if (!permissionKey) {
    return false;
  }

  const legacyKeys =
    COLUMN_VIEW_LEGACY_KEY_MAP[key] ||
    [];

  const pascalKey =
    key.charAt(0).toUpperCase() +
    key.slice(1);

  return pAny([
    permissionKey,
    ...legacyKeys,

    `col.${key}`,
    `show_${key}`,
    `show${pascalKey}`,

    `super.col.${key}`,
    `super.column.${key}`,

    `admin.col.${key}`,
    `admin.column.${key}`,

    `agent.col.${key}`,
    `agent.column.${key}`,

    `subagent.col.${key}`,
    `subagent.column.${key}`,

    `sub_agent.col.${key}`,
    `sub_agent.column.${key}`,

    `dashboard_super.col.${key}`,
    `dashboard-super.col.${key}`,

    `dashboard_admin.col.${key}`,
    `dashboard-admin.col.${key}`,

    `dashboard_agent.col.${key}`,
    `dashboard-agent.col.${key}`,

    `dashboard_sub_agent.col.${key}`,
    `dashboard-sub-agent.col.${key}`,

    `perm.super.col.${key}`,
    `perm.admin.col.${key}`,
    `perm.agent.col.${key}`,
    `perm.sub_agent.col.${key}`,

    key
  ], false);
}

function pEditCol(name) {
  const key =
    String(name || "").trim();

  const editPermissionKey =
    COLUMN_EDIT_KEY_MAP[key];

  if (
    !editPermissionKey ||
    !pCol(key)
  ) {
    return false;
  }

  /*
   * Legacy users:
   * Existing View permission old Edit access ko
   * preserve karegi jab tak user new Edit schema
   * ke saath re-save na ho.
   */
  if (!hasExplicitEditSchema()) {
    return true;
  }

  return pFlag(
    editPermissionKey,
    false
  );
}

function getColumnKeyForControl(control) {
  if (!control) {
    return "";
  }

  const directKey =
    control.getAttribute?.("data-col") ||
    control.getAttribute?.("data-field-key") ||
    "";

  if (
    directKey &&
    COLUMN_VIEW_KEY_MAP[directKey]
  ) {
    return directKey;
  }

  const columnContainer =
    control.closest?.("[data-col]");

  const containerKey =
    columnContainer?.getAttribute?.(
      "data-col"
    ) || "";

  if (
    containerKey &&
    COLUMN_VIEW_KEY_MAP[containerKey]
  ) {
    return containerKey;
  }

  const fieldName =
    control.getAttribute?.("name") ||
    "";

  return (
    FIELD_NAME_TO_COLUMN_KEY[fieldName] ||
    ""
  );
}

function canEditColumnControl(columnKey) {
  return !!(
    pFlag("btnEditRow", false) &&
    pEditCol(columnKey)
  );
}


/**
 * ✅ Button + Column visibility
 */
function applyUiPermissions() {
  toggleByPerm(
    ".btn-whatsapp",
    "btnWhatsApp"
  );

  toggleByPerm(
    ".btn-billing",
    "btnBilling"
  );

  toggleByPerm(
    ".action-pdf, .mini-pdf",
    "btnPdf"
  );

  toggleByPerm(
    ".action-upload, input[type=\"file\"][data-admission-id]",
    "btnUpload"
  );

  toggleByPerm(
    ".btn-row-edit, .js-dashboard-edit-return-link:not(.admission-field-link)",
    "btnEditRow"
  );

  toggleByPerm(
    ".action-update",
    "btnUpdateRow"
  );

  toggleBulkChallanByPerm();

  toggleByAnyPerm(
    ".btn-file-delete",
    [
      "btnDeleteFile",
      "btnFilesDelete",
      "btnDeleteFiles",
      "deleteFile",
      "canDeleteFiles"
    ]
  );

  applyColumnVisibility();
  applyColumnEditability();
  applyCardFieldPermissions();
}

function toggleByPerm(selector, permKey) {
  const allowed =
    pFlag(permKey, false);

  document
    .querySelectorAll(selector)
    .forEach((element) => {
      if (!allowed) {
        element.classList.add("d-none");

        element.setAttribute(
          "disabled",
          "disabled"
        );

        element.setAttribute(
          "aria-disabled",
          "true"
        );
      }
    });
}

function toggleByAnyPerm(
  selector,
  permissionKeys
) {
  const allowed =
    pAny(permissionKeys, false);

  document
    .querySelectorAll(selector)
    .forEach((element) => {
      if (!allowed) {
        element.classList.add("d-none");

        element.setAttribute(
          "disabled",
          "disabled"
        );

        element.setAttribute(
          "aria-disabled",
          "true"
        );
      }
    });
}

function toggleBulkChallanByPerm() {
  const canCreate =
    pFlag("btnUpdateRow", false);

  const canSend =
    pFlag("btnWhatsApp", false);

  const allowed =
    canCreate || canSend;

  document
    .querySelectorAll(
      ".bulk-challan-open-btn"
    )
    .forEach((button) => {
      if (!allowed) {
        button.classList.add("d-none");

        button.setAttribute(
          "disabled",
          "disabled"
        );

        button.setAttribute(
          "aria-disabled",
          "true"
        );
      }
    });
}

/**
 * Supports:
 * <th data-perm="colPhone">
 * <th data-col="phone">
 */
function applyColumnVisibility() {
  const table =
    document.getElementById(
      "superAdmissionsTable"
    ) ||
    document.getElementById(
      "adminAdmissionsTable"
    ) ||
    document.getElementById(
      "agentAccountsTable"
    );

  if (table) {
    table
      .querySelectorAll("[data-perm]")
      .forEach((element) => {
        const permissionKey =
          element.getAttribute(
            "data-perm"
          );

        if (!permissionKey) {
          return;
        }

        element.style.display =
          pFlag(permissionKey, false)
            ? ""
            : "none";
      });

    const columnKeys = new Set();

    table
      .querySelectorAll(
        "thead th[data-col], tbody td[data-col]"
      )
      .forEach((element) => {
        const columnKey =
          element.getAttribute(
            "data-col"
          );

        if (columnKey) {
          columnKeys.add(columnKey);
        }
      });

    columnKeys.forEach((columnKey) => {
      const normalizedKey =
        columnKey === "actions"
          ? "actionButtons"
          : columnKey;

      const visible =
        COLUMN_VIEW_KEY_MAP[
          normalizedKey
        ]
          ? pCol(normalizedKey)
          : true;

      table
        .querySelectorAll(
          `[data-col="${CSS.escape(columnKey)}"]`
        )
        .forEach((element) => {
          element.style.display =
            visible ? "" : "none";
        });
    });
  }

  document
    .querySelectorAll(
      ".admission-field-link[data-field-key]"
    )
    .forEach((field) => {
      const columnKey =
        field.getAttribute(
          "data-field-key"
        ) || "";

      if (
        COLUMN_VIEW_KEY_MAP[columnKey] &&
        !pCol(columnKey)
      ) {
        field.classList.add("d-none");
      }
    });

  if (!pCol("actionButtons")) {
    document
      .querySelectorAll(
        ".admission-card-actions"
      )
      .forEach((actions) => {
        actions.classList.add("d-none");
      });
  }
}

function mapColToPerm(columnKey) {
  const key =
    String(columnKey || "").trim();

  const normalizedKey =
    key === "actions"
      ? "actionButtons"
      : key;

  return (
    COLUMN_VIEW_KEY_MAP[
      normalizedKey
    ] ||
    null
  );
}

function applyColumnEditability() {
  const tables = [
    document.getElementById(
      "superAdmissionsTable"
    ),

    document.getElementById(
      "adminAdmissionsTable"
    ),

    document.getElementById(
      "agentAccountsTable"
    )
  ].filter(Boolean);

  tables.forEach((table) => {
    table
      .querySelectorAll(
        "input[form], select[form], textarea[form], tbody input[name], tbody select[name], tbody textarea[name]"
      )
      .forEach((control) => {
        const columnKey =
          getColumnKeyForControl(
            control
          );

        if (!columnKey) {
          return;
        }

        const allowed =
          canEditColumnControl(
            columnKey
          );

        if (allowed) {
          return;
        }

        control.disabled = true;

        control.setAttribute(
          "aria-disabled",
          "true"
        );

        control.setAttribute(
          "tabindex",
          "-1"
        );

        control.classList.add(
          "permission-readonly-field"
        );

        if (
          control.tagName === "INPUT" ||
          control.tagName === "TEXTAREA"
        ) {
          control.readOnly = true;

          control.setAttribute(
            "aria-readonly",
            "true"
          );
        }
      });
  });
}

function applyCardFieldPermissions() {
  document
    .querySelectorAll(
      ".admission-field-link[data-field-key]"
    )
    .forEach((field) => {
      const columnKey =
        field.getAttribute(
          "data-field-key"
        ) || "";

      if (
        !COLUMN_VIEW_KEY_MAP[columnKey]
      ) {
        return;
      }

      if (!pCol(columnKey)) {
        field.classList.add("d-none");
        return;
      }

      if (
        field.tagName !== "A" ||
        canEditColumnControl(columnKey)
      ) {
        return;
      }

      if (
        field.hasAttribute("href") &&
        !field.dataset.permissionHref
      ) {
        field.dataset.permissionHref =
          field.getAttribute("href") ||
          "";
      }

      field.removeAttribute("href");

      field.setAttribute(
        "aria-disabled",
        "true"
      );

      field.setAttribute(
        "tabindex",
        "-1"
      );

      field.classList.add(
        "no-edit-field",
        "permission-readonly-field"
      );

      field.style.pointerEvents = "none";
      field.style.cursor = "default";
    });
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

function canSubmitRowUpdates() {
  return !!(
    pCol("actionButtons") &&
    pFlag("btnUpdateRow", false)
  );
}

function canSubmitAdmissionField(
  fieldName
) {
  const columnKey =
    FIELD_NAME_TO_COLUMN_KEY[
      String(fieldName || "")
    ] || "";

  if (!columnKey) {
    return true;
  }

  return canEditColumnControl(
    columnKey
  );
}
const VERIFICATION_DUPLICATE_INPUT_SELECTOR = [
  'input[name="verificationNumber"]',
  'input[name="verification_number"]',
  'input[name="accounts_verification_number"]',
  'input[name="verificationNumber2"]',
  'input[name="secondVerificationNumber"]',
  'input[name="accounts_verification_number_2"]',
  'input[id^="bill_verif_"]'
].join(",");

function splitVerificationConflictTokens(value) {
  return String(value || "")
    .split("+")
    .map((part) =>
      String(part || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
    )
    .filter(Boolean);
}

function getVerificationInputsForForm(form) {
  if (!form) return [];

  return Array.from(
    document.querySelectorAll(
      VERIFICATION_DUPLICATE_INPUT_SELECTOR
    )
  ).filter((input) => {
    return input.form === form || form.contains(input);
  });
}

function ensureVerificationConflictStyle() {
  if (
    document.getElementById(
      "admissionsVerificationConflictStyle"
    )
  ) {
    return;
  }

  const style = document.createElement("style");

  style.id =
    "admissionsVerificationConflictStyle";

  style.textContent = `
    .admissions-verification-duplicate-input,
    .admissions-verification-duplicate-input:focus{
      border-color:#dc2626!important;
      background:#fff7f7!important;
      box-shadow:0 0 0 3px rgba(220,38,38,.14)!important
    }
  `;

  document.head.appendChild(style);
}

function clearAdmissionsVerificationDuplicateState() {
  document
    .querySelectorAll(
      ".admissions-verification-duplicate-input"
    )
    .forEach((input) => {
      input.classList.remove(
        "admissions-verification-duplicate-input"
      );

      input.removeAttribute(
        "aria-invalid"
      );
    });
}

function showAdmissionsDuplicateVerificationConflict(
  errorOrData,
  candidateInputs = []
) {
  const responseData =
    errorOrData?.responseData &&
    typeof errorOrData.responseData === "object"
      ? errorOrData.responseData
      : (
          errorOrData &&
          typeof errorOrData === "object"
            ? errorOrData
            : {}
        );

  const detail =
    responseData.duplicateVerification &&
    typeof responseData.duplicateVerification === "object"
      ? responseData.duplicateVerification
      : {};

  const code = String(
    responseData.code ||
    detail.code ||
    ""
  ).trim();

  const field = String(
    responseData.field ||
    detail.field ||
    ""
  ).trim();

  if (
    code !== "DUPLICATE_VERIFICATION_NUMBER" &&
    field !== "verificationNumber"
  ) {
    return false;
  }

  ensureVerificationConflictStyle();
  clearAdmissionsVerificationDuplicateState();

  const admissions =
    Array.isArray(responseData.admissions)
      ? responseData.admissions
      : (
          Array.isArray(detail.admissions)
            ? detail.admissions
            : []
        );

  const isFamily =
    responseData.isFamily === true ||
    detail.isFamily === true ||
    String(
      responseData.duplicateType ||
      detail.duplicateType ||
      ""
    ).trim() === "family" ||
    admissions.length > 1;

  const familyNumber = String(
    responseData.familyNumber ||
    detail.familyNumber ||
    ""
  ).trim();

  const matchedNumber = String(
    detail.matchedVerificationNumber ||
    detail.submittedVerificationNumber ||
    ""
  ).trim();

  const matchedToken =
    splitVerificationConflictTokens(
      matchedNumber
    )[0] || "";

  const inputs =
    Array.from(
      candidateInputs || []
    ).filter(Boolean);

  let firstInput = null;

  inputs.forEach((input) => {
    const inputTokens =
      splitVerificationConflictTokens(
        input.value
      );

    if (
      matchedToken &&
      !inputTokens.includes(
        matchedToken
      )
    ) {
      return;
    }

    input.classList.add(
      "admissions-verification-duplicate-input"
    );

    input.setAttribute(
      "aria-invalid",
      "true"
    );

    if (!firstInput) {
      firstInput = input;
    }
  });

  if (!firstInput) {
    firstInput =
      inputs.find(
        (input) => !input.disabled
      ) || null;

    if (firstInput) {
      firstInput.classList.add(
        "admissions-verification-duplicate-input"
      );

      firstInput.setAttribute(
        "aria-invalid",
        "true"
      );
    }
  }

  firstInput?.scrollIntoView({
    behavior: "smooth",
    block: "center"
  });

  const familyLabel =
    familyNumber
      ? `Family #${familyNumber}`
      : (
          isFamily
            ? "Auto-matched family (Family Number not assigned)"
            : ""
        );

  const admissionDetails =
    admissions.map((admission) => {
      const studentName = String(
        admission?.studentName ||
        admission?.student_name ||
        "Unnamed Student"
      ).trim();

      const admissionId = Number(
        admission?.admissionId ||
        admission?.id ||
        0
      );

      const entryNumber = String(
        admission?.entryNumber ||
        admission?.entry_number ||
        ""
      ).trim();

      const entryText =
        entryNumber &&
        entryNumber !==
          String(admissionId || "")
          ? `, Entry #${entryNumber}`
          : "";

      return (
        `${studentName} (` +
        `${
          admissionId
            ? `Admission ID #${admissionId}`
            : "Admission ID not available"
        }${entryText})`
      );
    }).join(", ");

  const messageParts = [
    String(
      responseData.message ||
      detail.message ||
      errorOrData?.message ||
      "This Verification Number is already in use."
    ).trim(),

    `Verification Number: ${
      matchedNumber ||
      "Entered number"
    }`,

    `Conflict Type: ${
      isFamily
        ? "Family"
        : "Single Admission"
    }`
  ];

  if (familyLabel) {
    messageParts.push(
      `Family: ${familyLabel}`
    );
  }

  if (admissionDetails) {
    messageParts.push(
      `${
        isFamily
          ? "Students"
          : "Student"
      }: ${admissionDetails}`
    );
  }

  const finalMessage =
    messageParts.join(" | ");

  if (
    typeof window.showUploadFlash ===
    "function"
  ) {
    window.showUploadFlash(
      "danger",
      "Verification Number Already in Use",
      finalMessage
    );
  } else {
    alert(finalMessage);
  }

  return true;
}

document.addEventListener(
  "input",
  (event) => {
    if (
      event.target?.classList?.contains(
        "admissions-verification-duplicate-input"
      )
    ) {
      clearAdmissionsVerificationDuplicateState();
    }
  }
);
async function submitRowFormAjax(
  form,
  formIdOverride = ""
) {
  if (!form) return;

  if (!canSubmitRowUpdates()) {
    const message =
      "You do not have permission to update this row.";

    if (window.showUploadFlash) {
      window.showUploadFlash(
        "danger",
        "Update blocked",
        message
      );
    } else {
      alert(message);
    }

    return;
  }

  const formId =
    formIdOverride ||
    form.id ||
    "";

  const active =
    document.activeElement;

  const fieldName =
    active?.getAttribute?.("name") ||
    active?.getAttribute?.("data-field") ||
    "";

  beginRowSaveFlow(
    formId,
    fieldName,
    "Updating row..."
  );

  try {
    const formData =
      new FormData(form);

    const body =
      new URLSearchParams();

    let editableFieldCount = 0;

    for (
      const [key, value] of
      formData.entries()
    ) {
      const columnKey =
        FIELD_NAME_TO_COLUMN_KEY[
          String(key || "")
        ] || "";

      if (
        columnKey &&
        !canSubmitAdmissionField(key)
      ) {
        continue;
      }

      if (columnKey) {
        editableFieldCount += 1;
      }

      body.append(
        key,
        value == null
          ? ""
          : String(value)
      );
    }

    if (!editableFieldCount) {
      hideRowSavingOverlay();

      const message =
        "No permitted editable field was found.";

      if (window.showUploadFlash) {
        window.showUploadFlash(
          "danger",
          "Update blocked",
          message
        );
      } else {
        alert(message);
      }

      return;
    }

    const res = await fetch(form.action, {
      method:
        (form.method || "POST")
          .toUpperCase(),

      body,

      headers: {
        "X-Requested-With":
          "XMLHttpRequest",

        "Accept":
          "application/json",

        "Content-Type":
          "application/x-www-form-urlencoded; charset=UTF-8"
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
        const rowUpdateError =
          new Error(
            data.message ||
            "Row update failed"
          );

        rowUpdateError.responseData =
          data &&
          typeof data === "object"
            ? data
            : {};

        throw rowUpdateError;
      }
    } else if (!res.ok) {
      throw new Error(
        "Row update failed"
      );
    }

    clearAdmissionsVerificationDuplicateState();

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
    console.error(
      "Row update error:",
      err
    );

    hideRowSavingOverlay();

    if (
      showAdmissionsDuplicateVerificationConflict(
        err,
        getVerificationInputsForForm(
          form
        )
      )
    ) {
      return;
    }

    if (window.showUploadFlash) {
      window.showUploadFlash(
        "danger",
        "Update Failed",
        err.message ||
        "Record update failed."
      );
    } else {
      alert(
        err.message ||
        "Record update failed."
      );
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
        const res = await fetch(buildAdmissionsApiUrl(), {
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

function escapeAdmissionCell(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAdmissions(rows) {
  const tbody =
    document.getElementById(
      "admissions-tbody"
    );

  if (!tbody) return;

  tbody.innerHTML = "";

  const safeRows =
    Array.isArray(rows)
      ? rows
      : [];

  safeRows.forEach((row, index) => {
    const tableRow =
      document.createElement("tr");

    const cells = [
      {
        columnKey: "",
        value: index + 1
      },
      {
        columnKey: "student",
        value:
          row.student_name ||
          row.studentName ||
          row.student ||
          ""
      },
      {
        columnKey: "grade",
        value:
          row.grade ||
          ""
      },
      {
        columnKey: "father",
        value:
          row.father_name ||
          row.fatherName ||
          row.father ||
          ""
      },
      {
        columnKey: "currency",
        value:
          row.currency ||
          row.currency_code ||
          row.currencyCode ||
          ""
      },
      {
        columnKey: "bank",
        value:
          row.bank_name ||
          row.bankName ||
          row.bank ||
          ""
      }
    ];

    tableRow.innerHTML = cells
      .filter((cell) => {
        return (
          !cell.columnKey ||
          pCol(cell.columnKey)
        );
      })
      .map((cell) => {
        const dataColumn =
          cell.columnKey
            ? ` data-col="${cell.columnKey}"`
            : "";

        return (
          `<td${dataColumn}>` +
          `${escapeAdmissionCell(cell.value)}` +
          `</td>`
        );
      })
      .join("");

    tbody.appendChild(tableRow);
  });

  applyUiPermissions();
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
  if (
    canForwardNow &&
    pCol("actionButtons")
  ) {
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
    clearAdmissionsVerificationDuplicateState();

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
        const billingSaveError =
          new Error(
            (data && data.message) ||
            "Save failed"
          );

        billingSaveError.responseData =
          data &&
          typeof data === "object"
            ? data
            : {};

        const duplicateHandled =
          showAdmissionsDuplicateVerificationConflict(
            billingSaveError,
            Object.values(
              verifInputs
            ).filter(Boolean)
          );

        if (!duplicateHandled) {
          window.showUploadFlash
            ? window.showUploadFlash(
                "danger",
                "Save failed",
                (data && data.message) ||
                "Save failed"
              )
            : alert(
                (data && data.message) ||
                "Save failed"
              );
        }

        return;
      }

clearAdmissionsVerificationDuplicateState();

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
