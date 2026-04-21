// server.js
import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import cors from "cors"; // ✅ CORS
import fs from "fs"; // ✅ PDF download check
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";

import http from "http"; // ✅ NEW (Socket server)
import { Server as SocketIOServer } from "socket.io"; // ✅ NEW

import dotenv from "dotenv";
dotenv.config();

import db, { PERMISSION_KEYS, normalizePermissions } from "./db.js";
import {
  calcPendingDues,
  BILLING_MONTHS,
  BILLING_STATUS_LIST,
  parseFirstNumber,
  splitBillingValue,
  safeJsonParse,
  getCurrentMonthKey,
  getNextMonthKey,
} from "./utils/calcPendingDues.js";
import { makeAdmissionPdf } from "./utils/makeAdmissionPdf.js"; // ✅ NEW
import makeMonthlyChallanPdf from "./utils/makeMonthlyChallanPdf.js";
import makeMonthlyPaidReceiptPdf from "./utils/makeMonthlyPaidReceiptPdf.js";
import makeBulkPaidReceiptPdf from "./utils/makeBulkPaidReceiptPdf.js";
import makeFamilyChallanPdf from "./utils/makeFamilyChallanPdf.js";
import {
  dbGetAdmissionDetailsById,
  getAdmissionBillingByYear,
  saveAdmissionBillingMonthByYear,
} from "./db.js";
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================== BILLING.JSON (FILE STORE) ==================
const BILLING_JSON_PATH = path.join(__dirname, "data", "billing.json");

function readBillingStoreSafe() {
  try {
    if (!fs.existsSync(BILLING_JSON_PATH)) return null;
    const raw = fs.readFileSync(BILLING_JSON_PATH, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error("billing.json read error:", e.message);
    return null;
  }
}

/**
 * Supports multiple shapes:
 * 1) { "53": { billing:{...}, paidUpto:"", calc:{...}, currencyCode:"SAR" }, ... }
 * 2) { data: { "53": {...} } }
 * 3) [ { admissionId:53, billing:{...}, paidUpto:"", calc:{...} }, ... ]
 */
function getBillingFromStore(store, admissionId) {
  const idStr = String(admissionId);

  if (!store) return null;

  // case: wrapped
  if (store.data) store = store.data;

  // case: array
  if (Array.isArray(store)) {
    const found = store.find((x) => String(x?.admissionId) === idStr);
    return found || null;
  }

  // case: object keyed by id
  if (store && typeof store === "object") {
    return store[idStr] || store[admissionId] || null;
  }

  return null;
}

// ----------------- Middlewares -----------------
app.use(cors()); // ✅ admission form (port 5000) se requests allow
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: "ivs-dashboard-secret",
    resave: false,
    saveUninitialized: false,
  })
);

// 🔔 Flash middleware (popup ke liye)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// Static + view engine
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ================== SOCKET.IO (NEW) ==================
const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

// attach io to express app so we can emit inside routes
app.set("io", io);

io.on("connection", (socket) => {
  // optional debug
  // console.log("Socket connected:", socket.id);
});

// helper: emit admission change safely
function emitAdmissionChanged(req, payload = {}) {
  try {
    const ioRef = req.app.get("io");
    if (ioRef) {
      ioRef.emit("admission:changed", { ts: Date.now(), ...payload });
    }
  } catch (e) {
    console.error("emitAdmissionChanged error:", e);
  }
}

// ================== UPLOADS SETUP (NEW) ==================
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
function pad2(n) {
  return String(n).padStart(2, "0");
}

// ✅ Use current date for folder: YYYY/MM
function getYearMonthParts(dateObj = new Date()) {
  const d = dateObj instanceof Date ? dateObj : new Date();
  const year = String(d.getFullYear());
  const month = pad2(d.getMonth() + 1);
  return { year, month };
}

// ✅ Convert Windows "\" to URL "/"
function toPosix(p) {
  return String(p || "").replaceAll("\\", "/");
}
function safeUnlink(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch (e) {
    console.error("unlink failed:", absPath, e.message);
  }
}
// serve uploaded files
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { year, month } = getYearMonthParts();
    const dir = path.join(uploadsDir, year, month);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});


// allow images + common docs
const allowedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",

  // ✅ CSV support
  "text/csv",
  "application/csv",
  "text/x-csv",
  "application/octet-stream",
]);

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isCsvByExt = ext === ".csv";
    const isAllowedMime = allowedTypes.has(file.mimetype);

    if (!isAllowedMime && !isCsvByExt) {
      return cb(new Error("File type not allowed"));
    }

    cb(null, true);
  },
});

function requireSuperAdmin(req, res, next) {
  const user = req.session.user;
  if (!user || user.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }
  next();
}
function requireManageDropdownOptions(req, res, next) {
  const user = req.session.user;
  if (!user) {
    return res.status(403).json({ success: false, message: "Not allowed" });
  }

  const perms = getPerm(user);

  // super admin always allowed
  if (user.role === "super_admin") return next();

  // jis user ke paas row update ya billing ka button hai usko allow karo
  if (perms.btnUpdateRow || perms.btnBilling) return next();

  return res.status(403).json({ success: false, message: "Not allowed" });
}

// ================== DB SETTINGS CSV HELPERS ==================
function getAdmissionsTableColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info(admissions)`).all();
    return cols.map((c) => String(c.name || "").trim()).filter(Boolean);
  } catch (e) {
    console.error("PRAGMA admissions error:", e.message);
    return [];
  }
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((row) =>
    columns.map((col) => csvEscape(row?.[col] ?? "")).join(",")
  );
  return [header, ...body].join("\n");
}

function normalizeImportValue(v) {
  if (v === null || typeof v === "undefined") return "";
  return String(v).trim();
}

function findExistingAdmissionForImport(row) {
  const regNo = normalizeImportValue(row.accounts_registration_number);
  const student = normalizeImportValue(row.student_name);
  const father = normalizeImportValue(row.father_name);
  const grade = normalizeImportValue(row.grade);
  const tuitionGrade = normalizeImportValue(row.tuition_grade);
  const phone = normalizeImportValue(row.phone);
  const dept = normalizeImportValue(row.dept);
  const regDate = normalizeImportValue(row.registration_date);

  // 1) strongest duplicate rule
  if (regNo) {
   const byReg = db.prepare(`
  SELECT id
  FROM admissions
  WHERE COALESCE(is_deleted, 0) = 0
    AND TRIM(COALESCE(accounts_registration_number, '')) = TRIM(?)
  LIMIT 1
`).get(regNo);

    if (byReg) return byReg;
  }

  // 2) fallback duplicate rule
  if (student && father && (grade || tuitionGrade || phone)) {
    const byFingerprint = db.prepare(`
  SELECT id
  FROM admissions
  WHERE COALESCE(is_deleted, 0) = 0
    AND TRIM(COALESCE(dept, '')) = TRIM(?)
    AND TRIM(COALESCE(student_name, '')) = TRIM(?)
    AND TRIM(COALESCE(father_name, '')) = TRIM(?)
    AND TRIM(COALESCE(grade, '')) = TRIM(?)
    AND TRIM(COALESCE(tuition_grade, '')) = TRIM(?)
    AND TRIM(COALESCE(phone, '')) = TRIM(?)
    AND TRIM(COALESCE(registration_date, '')) = TRIM(?)
  LIMIT 1
`).get(
  dept,
  student,
  father,
  grade,
  tuitionGrade,
  phone,
  regDate
);

    if (byFingerprint) return byFingerprint;
  }

  return null;
}

function buildSafeAdmissionImportRow(rawRow, allowedColumns) {
  const out = {};

  for (const col of allowedColumns) {
    if (col === "id") continue; // id auto create hone do
    if (typeof rawRow[col] === "undefined") continue;

    let value = rawRow[col];

    if (value === null || typeof value === "undefined") {
      out[col] = "";
      continue;
    }

    if (typeof value === "string") {
      out[col] = value.trim();
      continue;
    }

    out[col] = String(value);
  }

  return out;
}

// ----------------- Helpers -----------------
function pickCurrencyCode(body, fallback = "") {
  const sources = [
    body,
    body?.admission,
    body?.admissionPanel,
  ];

  for (const src of sources) {
    if (!src) continue;

    for (const key of ["currency", "currency_code", "currencyCode"]) {
      if (Object.prototype.hasOwnProperty.call(src, key)) {
        const raw = Array.isArray(src[key]) ? src[key][src[key].length - 1] : src[key];
        return String(raw ?? "").trim().toUpperCase();
      }
    }
  }

  return String(fallback ?? "").trim().toUpperCase();
}
function pickPaymentStatus(body, fallback = "") {
  const v =
    body?.paymentStatus ??
    body?.feeStatus ??
    body?.accounts_payment_status ??
    body?.accountsPaymentStatus ??
    body?.fee_status ??
    body?.accounts?.paymentStatus;

  const val = Array.isArray(v) ? v[v.length - 1] : v;
  return String(val ?? fallback).trim();
}

// 🔐 Login check + force logout if user updated after login
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  const sessionUser = req.session.user;

  try {
   const row = db.prepare("SELECT * FROM users WHERE id = ?").get(sessionUser.id);

if (!row) {
  return req.session.destroy(() => res.redirect("/login"));
}

const freshUser = mapUserRow(row);

// ✅ if user updated, refresh session (no logout)
if (freshUser.lastUpdatedAt && freshUser.lastUpdatedAt !== sessionUser.lastUpdatedAt) {
  req.session.user = freshUser;

  // optional: same “update notice” logic here so user ko popup mile
 if (freshUser.updateNoticeUnread) {
  const byName = freshUser.lastUpdatedBy || "an administrator";
  const roleMap = {
    super_admin: "Super Admin",
    admin: "Admin",
    agent: "Agent",
    sub_agent: "Sub Agent"
  };
  const byRoleLabel =
    roleMap[freshUser.lastUpdatedByRole] ||
    freshUser.lastUpdatedByRole ||
    "Admin / Manager";
  const when = freshUser.lastUpdatedAt || "";

  let msg = `Your account permissions were updated by ${byName} (${byRoleLabel}).`;
  if (when) msg += ` Time: ${when}`;

  const liveFlash = {
    type: "info",
    title: "Account updated",
    message: msg,
  };

  res.locals.flash = liveFlash;
  delete req.session.flash;

  db.prepare("UPDATE users SET updateNoticeUnread = 0 WHERE id = ?").run(freshUser.id);

  freshUser.updateNoticeUnread = 0;
  req.session.user = freshUser;
}
}
  } catch (err) {
    console.error("requireLogin check error:", err);
  }

  // ✅ make perms available everywhere (EJS + routes)
  try {
    req.perms = getPerm(req.session.user);
    res.locals.user = req.session.user;
    res.locals.perms = req.perms;
  } catch {}

  next();
}

// ================== PERMISSIONS HELPERS ==================
const isOn = (v) => {
  // ✅ handle duplicate inputs (hidden + checkbox)
  if (Array.isArray(v)) {
    // usually ["", "on"] => take last
    v = v[v.length - 1];
  }
  return v === "on" || v === "true" || v === true || v === 1 || v === "1";
};


// ✅ default = all false (non-super). super_admin always all true via normalizePermissions
const DEFAULT_PERMS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));

// ✅ Always return ONLY new keys (col*/btn*) and never fall back to old "true" defaults
function getPerm(user) {
  const p = {
    ...DEFAULT_PERMS,
    ...(normalizePermissions(user?.permissions, user?.role) || {}),
  };

  // super admin always full
  if (user?.role === "super_admin") return p;

  // ✅ Auto-derive view flags from allowed UI (so agent never gets blocked wrongly)
  const anyAccountsUi =
    p.colPaymentStatus ||
    p.colPaidUpto ||
    p.colVerificationNumber ||
    p.colRegistrationNumber ||
    p.colFamilyNumber ||
    p.colRegistrationFee ||
    p.colFees ||
    p.colMonth ||
    p.colTotalFees ||
    p.colPendingDues ||
    p.colReceivedPayment ||
    p.colInvoiceStatus ||
    p.colInvoiceStatusTimestamp ||
    p.colPaidInvoiceStatus ||
    p.colPaidInvoiceStatusTimestamp ||
    p.btnBilling ||
    p.btnUpdateRow;

  const anyAdmissionsUi =
    p.colDept ||
    p.colStudentName ||
    p.colFatherName ||
    p.colFatherEmail ||
    p.colGrade ||
    p.colTuitionGrade ||
    p.colPhone ||
    p.colProcessedBy ||
    p.btnPdf ||
    p.btnUpload ||
    p.btnFiles ||
    p.btnWhatsApp ||
    p.btnUpdateRow;

  // if these keys exist in DB fine, otherwise we still set them
  p.viewAccounts = !!(p.viewAccounts || anyAccountsUi);
  p.viewAdmissions = !!(p.viewAdmissions || anyAdmissionsUi);
  p.viewManagement = !!(p.viewManagement || p.viewManagement);

  return p;
}

// ✅ generic permission middleware (new keys)
function requirePerm(flag) {
  return (req, res, next) => {
    const user = req.session.user;
    if (user?.role === "super_admin") return next();

    const perms = getPerm(user);
    if (perms?.[flag]) return next();

    return res.status(403).send("Not allowed");
  };
}

// Map old route guards -> new buttons
const requireOpenBilling = requirePerm("btnBilling");
const requireSaveBilling = requirePerm("btnBilling");
const requireSendWhatsApp = requirePerm("btnWhatsApp");
const requireDeleteFiles = requirePerm("canDeleteFiles");
const requireDeleteAdmissions = requirePerm("canDeleteAdmissions");



// ✅ Masking: DB row (for /api/admissions list)
function maskAdmissionDbRow(row, perms) {
  const out = { ...row };
  if (!perms.colStatus) out.status = "";
  if (!perms.colFeeStatus) out.feeStatus = "";
  if (!perms.colDept) out.dept = "";

  if (!perms.colStudentName) {
    out.student_name = "";
    out.gender = "";
    out.dob = "";
  }

if (!perms.colFatherName) {
  out.father_name = "";
  out.father_occupation = "";
}

if (!perms.colFatherEmail) {
  out.father_email = "";
}

  if (!perms.colGrade) out.grade = "";
  if (!perms.colTuitionGrade) out.tuition_grade = "";

  if (!perms.colPhone) {
    out.phone = "";
    out.guardian_whatsapp = "";
    out.secondary_contact = "";
  }
if (!perms.colProcessedBy) out.processed_by = "";
  // Accounts columns
  if (!perms.colPaymentStatus) out.accounts_payment_status = "";
  if (!perms.colPaidUpto) out.accounts_paid_upto = "";
  if (!perms.colVerificationNumber) out.accounts_verification_number = "";
  if (!perms.colRegistrationNumber) out.accounts_registration_number = "";
  if (!perms.colFamilyNumber) out.accounts_family_number = "";
  if (!perms.colRegistrationFee) out.admission_registration_fee = "";

  // Admission columns
  if (!perms.colFees) out.admission_fees = "";
  if (!perms.colCurrency) out.currency_code = "";
  if (!perms.colMonth) out.admission_month = "";
  if (!perms.colTotalFees) out.admission_total_fees = "";
  if (!perms.colPendingDues) out.admission_pending_dues = "";
  if (!perms.colReceivedPayment) out.admission_total_paid = "";
  if (!perms.colInvoiceStatus) out.admission_invoice_status = "";
if (!perms.colInvoiceStatusTimestamp) out.admission_invoice_status_timestamp = "";
if (!perms.colPaidInvoiceStatus) out.admission_paid_invoice_status = "";
if (!perms.colPaidInvoiceStatusTimestamp) out.admission_paid_invoice_status_timestamp = "";

  return out;
}

function maskAdmissionMapped(obj, perms) {
  const out = JSON.parse(JSON.stringify(obj || {}));
  if (!perms.colStatus) out.status = "";
  if (!perms.colFeeStatus) out.feeStatus = "";
  if (!perms.colDept) out.dept = "";

  if (!perms.colStudentName) {
    out.studentName = "";
    out.student = "";
  }

  if (!perms.colFatherName) {
    out.fatherName = "";
    out.father = "";
  }

  if (!perms.colFatherEmail) {
  out.fatherEmail = "";
  out.father_email = "";
}

  if (!perms.colGrade) out.grade = "";
  if (!perms.colTuitionGrade) out.tuitionGrade = "";

  if (!perms.colPhone) {
    out.phone = "";
    out.contactNumber = "";
  }
if (!perms.colProcessedBy) {
  out.processedBy = "";
  out.processed_by = "";
}
 if (out.accounts) {
  if (!perms.colPaymentStatus) out.accounts.paymentStatus = "";
  if (!perms.colPaidUpto) out.accounts.paidUpto = "";
  if (!perms.colVerificationNumber) out.accounts.verificationNumber = "";
  if (!perms.colRegistrationNumber) out.accounts.registrationNumber = "";
  if (!perms.colFamilyNumber) out.accounts.familyNumber = "";
}

if (out.admission) {
  if (!perms.colRegistrationFee) out.admission.registrationFee = "";
  if (!perms.colFees) out.admission.fees = "";
  if (!perms.colCurrency) out.admission.currencyCode = "";
  if (!perms.colMonth) out.admission.month = "";
  if (!perms.colTotalFees) out.admission.totalFees = "";
  if (!perms.colPendingDues) out.admission.pendingDues = "";
  if (!perms.colReceivedPayment) out.admission.receivedPayment = "";
  if (!perms.colInvoiceStatus) out.admission.invoiceStatus = "";
  if (!perms.colInvoiceStatusTimestamp) out.admission.invoiceStatusTimestamp = "";
  if (!perms.colPaidInvoiceStatus) out.admission.paidInvoiceStatus = "";
  if (!perms.colPaidInvoiceStatusTimestamp) out.admission.paidInvoiceStatusTimestamp = "";
}

  return out;
}


function fetchAdmissionsForUser(user) {
  const perms = getPerm(user);
  const dept = user?.dept || null;
  if (!dept) return [];

  const rows = db
    .prepare(`
      SELECT *
      FROM admissions
      WHERE dept = ?
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY id DESC
    `)
    .all(dept);

  return rows.map((row) => {
    const mapped = mapAdmissionRow(row);

    mapped.latestBillingVerificationNumber =
      String(row.accounts_verification_number || "").trim();

    return maskAdmissionMapped(mapped, perms);
  });
}

// ✅ Simple API key check for /api routes (admission form -> dashboard)
function checkApiKey(req, res, next) {
  const headerKey = req.headers["x-api-key"];

  if (!headerKey || headerKey !== process.env.ADMISSIONS_API_KEY) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or missing API key" });
  }

  next();
}

// convert DB row -> user object
function mapUserRow(row) {
  if (!row) return null;
  return {
    ...row,
    permissions: row.permissions ? JSON.parse(row.permissions) : {},
  };
}

// 🔎 Audit log helper
function logAudit(eventType, actor, payload = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_logs
       (createdAt, actorId, actorName, actorRole, actorDept, eventType, targetUserId, targetUserName, dept, details)
       VALUES (@createdAt, @actorId, @actorName, @actorRole, @actorDept, @eventType, @targetUserId, @targetUserName, @dept, @details)
    `).run({
      createdAt: new Date().toISOString(),
      actorId: actor?.id || null,
      actorName: actor?.name || null,
      actorRole: actor?.role || null,
      actorDept: actor?.dept || null,
      eventType,
      targetUserId: payload.targetUserId || null,
      targetUserName: payload.targetUserName || null,
      dept: payload.dept || null,
      details: JSON.stringify(payload.details || payload || {}),
    });
  } catch (err) {
    console.error("audit log error:", err);
  }
}
// ================== DROPDOWN OPTIONS HELPERS ==================
function getOptions(tableName) {
  try {
    return db
      .prepare(`SELECT id, opt_key, label, color, is_custom FROM ${tableName} ORDER BY id ASC`)
      .all();
  } catch (e) {
    console.error("getOptions error:", tableName, e.message);
    return [];
  }
}

function resolveOption(tableName, key) {
  const k = String(key || "").trim();
  if (!k) return { key: "", label: "", color: "" };

  try {
    const row = db
      .prepare(`SELECT opt_key, label, color FROM ${tableName} WHERE opt_key = ?`)
      .get(k);

    if (!row) return { key: k, label: k, color: "" };
    return {
      key: row.opt_key,
      label: row.label,
      color: row.color || "",
    };
  } catch (e) {
    return { key: k, label: k, color: "" };
  }
}

function getCurrencyOptions() {
  try {
    return db
      .prepare("SELECT id, opt_key, label, is_custom FROM currency_options ORDER BY id ASC")
      .all();
  } catch (e) {
    console.error("getCurrencyOptions error:", e.message);
    return [];
  }
}

function getBankOptions() {
  try {
    return db
      .prepare("SELECT id, opt_key, label, is_custom FROM bank_options ORDER BY id ASC")
      .all();
  } catch (e) {
    console.error("getBankOptions error:", e.message);
    return [];
  }
}

function getActiveAdmissionWhereClause(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `COALESCE(${prefix}is_deleted, 0) = 0`;
}

function getActiveAdmissionById(id) {
  return db.prepare(`
    SELECT *
    FROM admissions
    WHERE id = ?
      AND COALESCE(is_deleted, 0) = 0
  `).get(id);
}

function getDeleteAdmissionAccess(user, row) {
  if (!user || !row) return false;
  if (user.role === "super_admin") return true;

  const perms = getPerm(user);
  if (!perms?.canDeleteAdmissions) return false;
  if (!user.dept) return false;

  const rowDept = String(row.dept || "").trim().toLowerCase();
  const userDept = String(user.dept || "").trim().toLowerCase();

  return rowDept && userDept && rowDept === userDept;
}


function checkDuplicateRegistrationNumber(registrationNumber, currentId = null) {
  const cleanRegistrationNumber = String(registrationNumber || "").trim();
  if (!cleanRegistrationNumber) {
    return null;
  }

  if (currentId) {
    return db.prepare(`
      SELECT id, student_name
      FROM admissions
      WHERE TRIM(accounts_registration_number) = TRIM(?)
        AND COALESCE(is_deleted, 0) = 0
        AND id != ?
      LIMIT 1
    `).get(cleanRegistrationNumber, currentId);
  }

  return db.prepare(`
    SELECT id, student_name
    FROM admissions
    WHERE TRIM(accounts_registration_number) = TRIM(?)
      AND COALESCE(is_deleted, 0) = 0
    LIMIT 1
  `).get(cleanRegistrationNumber);
}
/* ========== ADMISSIONS HELPERS (DB -> pipeline object) ========== */
function mapAdmissionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status || "New Admission",
    feeStatus: row.feeStatus || "New Admission",
    statusMeta: resolveOption("status_options", row.status || "New Admission"),
    feeStatusMeta: resolveOption("payment_status_options", row.feeStatus || "New Admission"),
    dept: row.dept,
    studentName: row.student_name,
    student: row.student_name,
    fatherName: row.father_name,
    father: row.father_name,
    fatherEmail: row.father_email || "",
    father_email: row.father_email || "",
    grade: row.grade,
    tuitionGrade: row.tuition_grade,
    phone: row.phone || row.guardian_whatsapp || "",
    contactNumber: row.phone || row.guardian_whatsapp || "",
    processedBy: row.processed_by || "",
    processed_by: row.processed_by || "",
   accounts: {
     paymentStatus: row.accounts_payment_status || "",
     paidUpto: row.accounts_paid_upto || "",
     verificationNumber: row.accounts_verification_number || "",
     registrationNumber: row.accounts_registration_number || "",
     familyNumber: row.accounts_family_number || "",
  },
    admission: {
      registrationFee: row.admission_registration_fee || "",
      fees: row.admission_fees || "",
      currencyCode: row.currency_code || "",
      month: row.admission_month || "",
      totalFees: row.admission_total_fees || "",
      pendingDues: row.admission_pending_dues || "",
      receivedPayment: row.admission_total_paid || "0",
      invoiceStatus: row.admission_invoice_status || "",
      invoiceStatusTimestamp: row.admission_invoice_status_timestamp || "",
      paidInvoiceStatus: row.admission_paid_invoice_status || "",
      paidInvoiceStatusTimestamp: row.admission_paid_invoice_status_timestamp || "",
    },
  };
}

function fetchAdmissionsForDept(dept) {
  const rows = dept
    ? db.prepare(`
        SELECT *
        FROM admissions
        WHERE dept = ?
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
      `).all(dept)
    : db.prepare(`
        SELECT *
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
      `).all();

  return rows.map((row) => {
    const mapped = mapAdmissionRow(row);

    mapped.latestBillingVerificationNumber =
      String(row.accounts_verification_number || "").trim();

    return mapped;
  });
}

function fetchAdmissionsPage({ dept = null, page = 1, limit = 200, perms = null }) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.max(parseInt(limit, 10) || 200, 1);
  const offset = (safePage - 1) * safeLimit;

  let totalRecords = 0;
  let rows = [];

  if (dept) {
    const totalRow = db
      .prepare(`
        SELECT COUNT(*) AS total
        FROM admissions
        WHERE dept = ?
          AND COALESCE(is_deleted, 0) = 0
      `)
      .get(dept);

    totalRecords = Number(totalRow?.total || 0);

    rows = db
      .prepare(`
        SELECT *
        FROM admissions
        WHERE dept = ?
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `)
      .all(dept, safeLimit, offset);
  } else {
    const totalRow = db
      .prepare(`
        SELECT COUNT(*) AS total
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
      `)
      .get();

    totalRecords = Number(totalRow?.total || 0);

    rows = db
      .prepare(`
        SELECT *
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `)
      .all(safeLimit, offset);
  }

  const mappedRows = rows.map((row) => {
    const mapped = mapAdmissionRow(row);

    mapped.latestBillingVerificationNumber =
      String(row.accounts_verification_number || "").trim();

    return perms ? maskAdmissionMapped(mapped, perms) : mapped;
  });

  const totalPages = Math.max(Math.ceil(totalRecords / safeLimit), 1);
  const startRecord = totalRecords === 0 ? 0 : offset + 1;
  const endRecord = totalRecords === 0 ? 0 : Math.min(offset + safeLimit, totalRecords);

  return {
    rows: mappedRows,
    page: safePage,
    limit: safeLimit,
    totalRecords,
    totalPages,
    startRecord,
    endRecord,
  };
}

/* ==================== OVERVIEW HELPERS ==================== */
function buildOverviewData(filters = {}) {
  const safeFilters = {
    startDate: String(filters.startDate || "").trim(),
    endDate: String(filters.endDate || "").trim(),
    day: String(filters.day || "").trim(),
    month: String(filters.month || "").trim(),
    year: String(filters.year || "").trim(),
    department: String(filters.department || "all").trim().toLowerCase(),
    status: String(filters.status || "all").trim(),
    feeStatus: String(filters.feeStatus || "all").trim(),
    billingStatus: String(filters.billingStatus || "all").trim(),
    currency: String(filters.currency || "all").trim(),
  };

  const rows = db.prepare(`
  SELECT *
  FROM admissions
  WHERE COALESCE(is_deleted, 0) = 0
  ORDER BY id DESC
`).all();
  console.log("OVERVIEW raw admissions:", rows.length);
console.log("OVERVIEW filters:", safeFilters);

  const statusOptions = getOptions("status_options");
  const feeOptions = getOptions("payment_status_options");
  const billingStatusOptions = getOptions("billing_status_options");
  const currencyOptions = getCurrencyOptions();

  const statusColorMap = Object.fromEntries(
    statusOptions.map((x) => [String(x.label || "").trim(), x.color || ""])
  );

  const feeColorMap = Object.fromEntries(
    feeOptions.map((x) => [String(x.label || "").trim(), x.color || ""])
  );

  const billingColorMap = Object.fromEntries(
    billingStatusOptions.map((x) => [String(x.label || "").trim(), x.color || ""])
  );

  const currencyKnownSet = new Set(
    currencyOptions.map((x) => String(x.label || "").trim().toUpperCase()).filter(Boolean)
  );

  const currentYearNum = new Date().getFullYear();
  const previousYearNum = currentYearNum - 1;

  const normalizeDept = (v) => String(v || "").trim().toLowerCase();
  const normalizeText = (v) => String(v || "").trim();
  const normalizeUpper = (v) => String(v || "").trim().toUpperCase();
  const safeNumber = (v) => Number(parseFirstNumber(v || 0) || 0);

    const prettyMonth = (v) => {
    const raw = String(v || "").trim();
    if (!raw) return "";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  };

  const matchesDateFilters = (row) => {
    const rawDate =
      row.registration_date ||
      row.created_at ||
      row.createdAt ||
      row.updated_at ||
      row.updatedAt ||
      "";

    if (!rawDate) {
      return !safeFilters.startDate && !safeFilters.endDate && !safeFilters.day && !safeFilters.month && !safeFilters.year;
    }

    const dt = new Date(rawDate);
    if (Number.isNaN(dt.getTime())) {
      return !safeFilters.startDate && !safeFilters.endDate && !safeFilters.day && !safeFilters.month && !safeFilters.year;
    }

    const yyyy = String(dt.getFullYear());
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const isoDate = `${yyyy}-${mm}-${dd}`;

    if (safeFilters.startDate && isoDate < safeFilters.startDate) return false;
    if (safeFilters.endDate && isoDate > safeFilters.endDate) return false;
    if (safeFilters.year && yyyy !== safeFilters.year) return false;
    if (safeFilters.month && mm !== safeFilters.month.padStart(2, "0")) return false;
    if (safeFilters.day && dd !== safeFilters.day.padStart(2, "0")) return false;

    return true;
  };

  const getBillingSnapshot = (row) => {
    const billingYear = safeFilters.year && /^\d{4}$/.test(safeFilters.year)
      ? Number(safeFilters.year)
      : currentYearNum;

    const billingArr = getAdmissionBillingByYear(row.id, billingYear);
    const billingJson = {};

    for (const item of billingArr) {
      billingJson[item.month] = {
        status: item.status || "",
        amount: String(item.amount || item.amountReceived || ""),
        feeOverride: String(item.fee || item.feeAmount || ""),
        verification: String(item.verificationNumber || ""),
        bank: String(item.bank || item.bankName || ""),
        updatedAt: item.updated_at || item.updatedAt || item.created_at || item.createdAt || "",
      };
    }

    return { billingYear, billingArr, billingJson };
  };

  const getLatestBillingEntry = (row) => {
    const { billingArr } = getBillingSnapshot(row);
    if (!billingArr.length) return null;

    const active = billingArr.filter((item) => {
      const status = normalizeText(item.status);
      const amount = safeNumber(item.amount || item.amountReceived);
      const verification = normalizeText(item.verificationNumber);
      const bank = normalizeText(item.bank || item.bankName);
      return !!(status || amount > 0 || verification || bank);
    });

    if (!active.length) return null;

    active.sort((a, b) => {
      const ta = new Date(a.updated_at || a.updatedAt || a.created_at || a.createdAt || 0).getTime();
      const tb = new Date(b.updated_at || b.updatedAt || b.created_at || b.createdAt || 0).getTime();
      return tb - ta;
    });

    return active[0];
  };

  const filteredRows = rows.filter((row) => {
    const dept = normalizeDept(row.dept);
    const status = normalizeText(row.status || "New Admission");
    const feeStatus = normalizeText(row.feeStatus || "New Admission");
    const currency = normalizeUpper(row.currency_code || "");
    const invoiceStatus = normalizeText(row.admission_invoice_status || "");
    const paidInvoiceStatus = normalizeText(row.admission_paid_invoice_status || "");

    if (safeFilters.department !== "all" && dept !== safeFilters.department) return false;
    if (safeFilters.status !== "all" && status !== safeFilters.status) return false;
    if (safeFilters.feeStatus !== "all" && feeStatus !== safeFilters.feeStatus) return false;
    if (safeFilters.currency.toLowerCase() !== "all" && currency !== normalizeUpper(safeFilters.currency)) return false;

    if (safeFilters.billingStatus !== "all") {
      const wanted = safeFilters.billingStatus;
      const { billingArr } = getBillingSnapshot(row);
      const hasMatch =
        invoiceStatus === wanted ||
        paidInvoiceStatus === wanted ||
        billingArr.some((x) => normalizeText(x.status) === wanted);

      if (!hasMatch) return false;
    }

    if (!matchesDateFilters(row)) return false;

    return true;
  });

  console.log("OVERVIEW filtered admissions:", filteredRows.length);

  const departmentStats = {
    school: {
      total: 0,
      currentStatus: {},
      feeStatus: {},
      billingStatus: {},
      currency: {},
      yearlyIntake: {},
      monthlyIntake: {},
      dailyIntake: {},
    },
    tuition: {
      total: 0,
      currentStatus: {},
      feeStatus: {},
      billingStatus: {},
      currency: {},
      yearlyIntake: {},
      monthlyIntake: {},
      dailyIntake: {},
    },
    quran: {
      total: 0,
      currentStatus: {},
      feeStatus: {},
      billingStatus: {},
      currency: {},
      yearlyIntake: {},
      monthlyIntake: {},
      dailyIntake: {},
    },
  };

  const statusStatsMap = new Map();
  const feeStatsMap = new Map();
  const currencyStatsMap = new Map();
   const billingSummaryMap = new Map();
  const invoiceStatusMap = new Map();
  const paidInvoiceStatusMap = new Map();

  const chartAdmissionsTrendDaily = {};
  const chartAdmissionsTrendMonthly = {};
  const chartAdmissionsTrendYearly = {};
  const departmentComparison = { school: 0, tuition: 0, quran: 0 };

  let totalAdmissions = 0;
  let totalSchoolStudents = 0;
  let totalTuitionStudents = 0;
  let totalQuranStudents = 0;

  let totalActiveStudents = 0;
  let totalInactiveStudents = 0;
  let totalPendingStudents = 0;

  let totalPaidStudents = 0;
  let totalUnpaidStudents = 0;
  let totalPartialFeeStudents = 0;
  let totalNoPaymentStudents = 0;

  let totalPendingDues = 0;
  let totalBillingRecords = 0;

  let totalAdmissionsCurrentYear = 0;
  let totalAdmissionsPreviousYear = 0;

  let totalReceivedAmount = 0;
  let totalBilledAdmissions = 0;
  let totalFullyPaidAdmissions = 0;
  let totalPartiallyPaidAdmissions = 0;
  let totalUnpaidAdmissions = 0;
  let totalNoPaymentAdmissions = 0;
    let invoiceTimestampTotals = 0;

  const pendingDueAdmissions = [];
  const noPaymentAdmissions = [];
  const recentBillingChanges = [];
  const recentAdmissions = [];

  const page = parseInt(filters.page) || 1;
const limit = 10;
const offset = (page - 1) * limit;

const recentAdmissionsPageData = recentAdmissions.slice(offset, offset + limit);
const totalPages = Math.ceil(recentAdmissions.length / limit);

  const activeWords = ["active", "running", "enrolled", "paid"];
  const inactiveWords = ["inactive", "closed", "drop", "left", "withdraw"];
  const pendingWords = ["pending", "trial", "new admission", "waiting"];

  for (const row of filteredRows) {
    const dept = normalizeDept(row.dept);
    const status = normalizeText(row.status || "New Admission");
    const feeStatus = normalizeText(row.feeStatus || "New Admission");
    const currency = normalizeUpper(row.currency_code || "UNKNOWN") || "UNKNOWN";

    const registrationDate =
      row.registration_date ||
      row.created_at ||
      row.createdAt ||
      "";

    const dt = registrationDate ? new Date(registrationDate) : null;
    const yyyy = dt && !Number.isNaN(dt.getTime()) ? String(dt.getFullYear()) : "Unknown";
    const mm = dt && !Number.isNaN(dt.getTime()) ? String(dt.getMonth() + 1).padStart(2, "0") : "00";
    const dd = dt && !Number.isNaN(dt.getTime()) ? String(dt.getDate()).padStart(2, "0") : "00";

    const isoMonth = yyyy !== "Unknown" ? `${yyyy}-${mm}` : "Unknown";
    const isoDay = yyyy !== "Unknown" ? `${yyyy}-${mm}-${dd}` : "Unknown";

    totalAdmissions += 1;
    if (dept === "school") totalSchoolStudents += 1;
    if (dept === "tuition") totalTuitionStudents += 1;
    if (dept === "quran") totalQuranStudents += 1;

    if (yyyy === String(currentYearNum)) totalAdmissionsCurrentYear += 1;
    if (yyyy === String(previousYearNum)) totalAdmissionsPreviousYear += 1;

    const statusLower = status.toLowerCase();
    if (activeWords.some((w) => statusLower.includes(w))) totalActiveStudents += 1;
    if (inactiveWords.some((w) => statusLower.includes(w))) totalInactiveStudents += 1;
    if (pendingWords.some((w) => statusLower.includes(w))) totalPendingStudents += 1;

    const feeLower = feeStatus.toLowerCase();
    if (feeLower.includes("paid") && !feeLower.includes("unpaid") && !feeLower.includes("partial")) totalPaidStudents += 1;
    if (feeLower.includes("unpaid")) totalUnpaidStudents += 1;
    if (feeLower.includes("partial")) totalPartialFeeStudents += 1;
    if (feeLower.includes("no payment")) totalNoPaymentStudents += 1;

    const pendingDues = safeNumber(row.admission_pending_dues);
    const receivedAmount = safeNumber(row.admission_total_paid);
    totalPendingDues += pendingDues;
    totalReceivedAmount += receivedAmount;

    const { billingYear, billingArr, billingJson } = getBillingSnapshot(row);
    const invoiceStatusValue = normalizeText(row.admission_invoice_status || "");
    const paidInvoiceStatusValue = normalizeText(row.admission_paid_invoice_status || "");
    const invoiceStatusTimestamp = normalizeText(row.admission_invoice_status_timestamp || "");
    const paidInvoiceStatusTimestamp = normalizeText(row.admission_paid_invoice_status_timestamp || "");

    if (invoiceStatusValue) {
      const old = invoiceStatusMap.get(invoiceStatusValue) || {
        label: invoiceStatusValue,
        total: 0,
      };
      old.total += 1;
      invoiceStatusMap.set(invoiceStatusValue, old);
    }

    if (paidInvoiceStatusValue) {
      const old = paidInvoiceStatusMap.get(paidInvoiceStatusValue) || {
        label: paidInvoiceStatusValue,
        total: 0,
      };
      old.total += 1;
      paidInvoiceStatusMap.set(paidInvoiceStatusValue, old);
    }

    if (invoiceStatusTimestamp) invoiceTimestampTotals += 1;
    if (paidInvoiceStatusTimestamp) invoiceTimestampTotals += 1;
    const hasAnyBilling = Array.isArray(billingArr) && billingArr.length > 0;
    if (hasAnyBilling) totalBilledAdmissions += 1;

    totalBillingRecords += billingArr.length;

    let rowHasFullPayment = false;
    let rowHasPartialPayment = false;
    let rowHasNoPayment = false;
    let rowHasUnpaid = false;

    for (const item of billingArr) {
      const st = normalizeText(item.status || "");
      const stLower = st.toLowerCase();
      const amount = safeNumber(item.amount || item.amountReceived);

      if (st) {
        billingSummaryMap.set(st, {
          label: st,
          color: billingColorMap[st] || "",
          total: (billingSummaryMap.get(st)?.total || 0) + 1,
        });
      }

      if (dept && departmentStats[dept]) {
        departmentStats[dept].billingStatus[st || "Unknown"] =
          (departmentStats[dept].billingStatus[st || "Unknown"] || 0) + 1;
      }

      if (stLower.includes("full payment")) rowHasFullPayment = true;
      if (stLower.includes("partial payment")) rowHasPartialPayment = true;
      if (stLower.includes("no payment")) rowHasNoPayment = true;
      if (stLower.includes("unpaid")) rowHasUnpaid = true;
    }

    if (rowHasFullPayment) totalFullyPaidAdmissions += 1;
    if (rowHasPartialPayment) totalPartiallyPaidAdmissions += 1;
    if (rowHasUnpaid) totalUnpaidAdmissions += 1;
    if (rowHasNoPayment) totalNoPaymentAdmissions += 1;

      if (pendingDues > 0) {
      const latestPendingMonth =
        billingArr.find((x) => {
          const s = normalizeText(x.status || "").toLowerCase();
          return s.includes("partial") || s.includes("unpaid") || s.includes("no payment");
        }) || null;

      pendingDueAdmissions.push({
        id: row.id,
        studentName: row.student_name || "",
        dept: row.dept || "",
        amount: pendingDues,
        month: latestPendingMonth?.month || "",
        monthLabel: prettyMonth(latestPendingMonth?.month || ""),
        billingYear,
        enteredAt: registrationDate || "",
      });
    }

        if (rowHasNoPayment) {
      const latestNoPaymentMonth =
        billingArr.find((x) => {
          const s = normalizeText(x.status || "").toLowerCase();
          return s.includes("no payment");
        }) || null;

      noPaymentAdmissions.push({
        id: row.id,
        studentName: row.student_name || "",
        dept: row.dept || "",
        amount: 0,
        month: latestNoPaymentMonth?.month || "",
        monthLabel: prettyMonth(latestNoPaymentMonth?.month || ""),
        billingYear,
        enteredAt: registrationDate || "",
      });
    }

    if (dept && departmentStats[dept]) {
      departmentStats[dept].total += 1;
      departmentComparison[dept] += 1;

      departmentStats[dept].currentStatus[status] =
        (departmentStats[dept].currentStatus[status] || 0) + 1;

      departmentStats[dept].feeStatus[feeStatus] =
        (departmentStats[dept].feeStatus[feeStatus] || 0) + 1;

      departmentStats[dept].currency[currency] =
        (departmentStats[dept].currency[currency] || 0) + 1;

      departmentStats[dept].yearlyIntake[yyyy] =
        (departmentStats[dept].yearlyIntake[yyyy] || 0) + 1;

      departmentStats[dept].monthlyIntake[isoMonth] =
        (departmentStats[dept].monthlyIntake[isoMonth] || 0) + 1;

      departmentStats[dept].dailyIntake[isoDay] =
        (departmentStats[dept].dailyIntake[isoDay] || 0) + 1;
    }

    const existingStatus = statusStatsMap.get(status) || {
      label: status,
      color: statusColorMap[status] || "",
      total: 0,
      school: 0,
      tuition: 0,
      quran: 0,
    };
    existingStatus.total += 1;
    if (dept === "school") existingStatus.school += 1;
    if (dept === "tuition") existingStatus.tuition += 1;
    if (dept === "quran") existingStatus.quran += 1;
    statusStatsMap.set(status, existingStatus);

    const existingFee = feeStatsMap.get(feeStatus) || {
      label: feeStatus,
      color: feeColorMap[feeStatus] || "",
      total: 0,
      school: 0,
      tuition: 0,
      quran: 0,
    };
    existingFee.total += 1;
    if (dept === "school") existingFee.school += 1;
    if (dept === "tuition") existingFee.tuition += 1;
    if (dept === "quran") existingFee.quran += 1;
    feeStatsMap.set(feeStatus, existingFee);

    const existingCurrency = currencyStatsMap.get(currency) || {
      currency,
      total: 0,
      received: 0,
      pending: 0,
    };
    existingCurrency.total += 1;
    existingCurrency.received += receivedAmount;
    existingCurrency.pending += pendingDues;
    currencyStatsMap.set(currency, existingCurrency);

    chartAdmissionsTrendYearly[yyyy] = (chartAdmissionsTrendYearly[yyyy] || 0) + 1;
    chartAdmissionsTrendMonthly[isoMonth] = (chartAdmissionsTrendMonthly[isoMonth] || 0) + 1;
    chartAdmissionsTrendDaily[isoDay] = (chartAdmissionsTrendDaily[isoDay] || 0) + 1;

    recentAdmissions.push({
      id: row.id,
      studentName: row.student_name || "",
      dept: row.dept || "",
      status,
      registration_date: registrationDate || "",
      createdAt: registrationDate || "",
    });

    const latestBilling = getLatestBillingEntry(row);
    if (latestBilling) {
      recentBillingChanges.push({
        id: row.id,
        studentName: row.student_name || "",
        dept: row.dept || "",
        month: latestBilling.month || "",
        status: latestBilling.status || "",
        amount: safeNumber(latestBilling.amount || latestBilling.amountReceived),
        updatedAt:
          latestBilling.updated_at ||
          latestBilling.updatedAt ||
          latestBilling.created_at ||
          latestBilling.createdAt ||
          "",
      });
    }
  }

  for (const opt of statusOptions) {
    const label = normalizeText(opt.label);
    if (!label) continue;
    if (!statusStatsMap.has(label)) {
      statusStatsMap.set(label, {
        label,
        color: opt.color || "",
        total: 0,
        school: 0,
        tuition: 0,
        quran: 0,
      });
    }
  }

  for (const opt of feeOptions) {
    const label = normalizeText(opt.label);
    if (!label) continue;
    if (!feeStatsMap.has(label)) {
      feeStatsMap.set(label, {
        label,
        color: opt.color || "",
        total: 0,
        school: 0,
        tuition: 0,
        quran: 0,
      });
    }
  }

  for (const opt of currencyOptions) {
    const label = normalizeUpper(opt.label);
    if (!label) continue;
    if (!currencyStatsMap.has(label)) {
      currencyStatsMap.set(label, {
        currency: label,
        total: 0,
        received: 0,
        pending: 0,
      
      });
    }
  }

  for (const curr of currencyKnownSet) {
    if (!currencyStatsMap.has(curr)) {
      currencyStatsMap.set(curr, {
        currency: curr,
        total: 0,
        received: 0,
        pending: 0,
      });
    }
  }

  const summaryCards = [
    { label: "Total Admissions", value: totalAdmissions, icon: "bi bi-people-fill", hint: "All departments combined" },
    { label: "Total School Students", value: totalSchoolStudents, icon: "bi bi-mortarboard-fill", hint: "School department" },
    { label: "Total Tuition Students", value: totalTuitionStudents, icon: "bi bi-journal-bookmark-fill", hint: "Tuition department" },
    { label: "Total Quran Students", value: totalQuranStudents, icon: "bi bi-book-half", hint: "Quran department" },
    { label: "Total Active Students", value: totalActiveStudents, icon: "bi bi-check-circle-fill", hint: "Status based" },
    { label: "Total Inactive Students", value: totalInactiveStudents, icon: "bi bi-pause-circle-fill", hint: "Status based" },
    { label: "Total Pending Students", value: totalPendingStudents, icon: "bi bi-hourglass-split", hint: "Status based" },
    { label: "Total Paid Students", value: totalPaidStudents, icon: "bi bi-cash-coin", hint: "Fee status based" },
    { label: "Total Unpaid Students", value: totalUnpaidStudents, icon: "bi bi-wallet2", hint: "Fee status based" },
    { label: "Total Partial Fee Students", value: totalPartialFeeStudents, icon: "bi bi-pie-chart-fill", hint: "Fee status based" },
    { label: "Total No Payment Students", value: totalNoPaymentStudents, icon: "bi bi-exclamation-octagon-fill", hint: "Fee status based" },
    { label: "Total Pending Dues", value: totalPendingDues, icon: "bi bi-cash-stack", hint: "Billing due amount" },
    { label: "Total Billing Records", value: totalBillingRecords, icon: "bi bi-receipt-cutoff", hint: "Billing month rows" },
    { label: "Current Year Admissions", value: totalAdmissionsCurrentYear, icon: "bi bi-calendar2-check-fill", hint: String(currentYearNum) },
    { label: "Previous Year Admissions", value: totalAdmissionsPreviousYear, icon: "bi bi-calendar2-minus-fill", hint: String(previousYearNum) },
    { label: "Currency-wise Totals", value: currencyStatsMap.size, icon: "bi bi-currency-exchange", hint: "Dynamic currencies" },
  ];

  recentAdmissions.sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta;
  });

  recentBillingChanges.sort((a, b) => {
    const ta = new Date(a.updatedAt || 0).getTime();
    const tb = new Date(b.updatedAt || 0).getTime();
    return tb - ta;
  });

  return {
    summaryCards,
    departmentStats,
    statusStats: Array.from(statusStatsMap.values()).sort((a, b) => b.total - a.total),
    feeStats: Array.from(feeStatsMap.values()).sort((a, b) => b.total - a.total),
        billingStats: {
      totalBilled: totalBilledAdmissions,
      totalUnpaidAdmissions,
      totalPartiallyPaidAdmissions,
      totalFullyPaidAdmissions,
      totalNoPaymentAdmissions,
      totalPendingDues,
      totalReceivedAmount,
      recentAdmissionsPageData,
currentPage: page,
totalPages,
      invoiceStatusTotals: invoiceStatusMap.size,
      paidInvoiceStatusTotals: paidInvoiceStatusMap.size,
      invoiceTimestampTotals,
      invoiceStatusBreakdown: Array.from(invoiceStatusMap.values()).sort((a, b) => b.total - a.total),
      paidInvoiceStatusBreakdown: Array.from(paidInvoiceStatusMap.values()).sort((a, b) => b.total - a.total),
      pendingDueAdmissions,
      noPaymentAdmissions,
      billingBreakdown: Array.from(billingSummaryMap.values()).sort((a, b) => b.total - a.total),
    },
    currencyStats: Array.from(currencyStatsMap.values()).sort((a, b) => b.total - a.total),
    charts: {
      admissionsTrendDaily: chartAdmissionsTrendDaily,
      admissionsTrendMonthly: chartAdmissionsTrendMonthly,
      admissionsTrendYearly: chartAdmissionsTrendYearly,
      departmentComparison,
      statusDistribution: Array.from(statusStatsMap.values()).map((x) => ({
        label: x.label,
        value: x.total,
        color: x.color || "",
      })),
      feeDistribution: Array.from(feeStatsMap.values()).map((x) => ({
        label: x.label,
        value: x.total,
        color: x.color || "",
      })),
      billingDistribution: Array.from(billingSummaryMap.values()).map((x) => ({
        label: x.label,
        value: x.total,
        color: x.color || "",
      })),
    },
    recentBillingChanges: recentBillingChanges.slice(0, 10),
  };
}

function buildPipelineSnapshotFromRow(row) {
  return {
    status: row.status || "New Admission",
    feeStatus: row.feeStatus || "New Admission",
    statusMeta: resolveOption("status_options", row.status || "New Admission"),
    feeStatusMeta: resolveOption("payment_status_options", row.feeStatus || "New Admission"),
    dept: row.dept,
    student: row.student_name,
    father: row.father_name,
    fatherEmail: row.father_email || "",
    father_email: row.father_email || "",
    grade: row.grade,
    tuitionGrade: row.tuition_grade,
    phone: row.phone,
    processedBy: row.processed_by || "",
    accounts: {
  paymentStatus: row.accounts_payment_status || "",
  paidUpto: row.accounts_paid_upto || "",
  verificationNumber: row.accounts_verification_number || "",
  registrationNumber: row.accounts_registration_number || "",
  familyNumber: row.accounts_family_number || "",
},
    admissionPanel: {
      registrationFee: row.admission_registration_fee || "",
      fees: row.admission_fees || "",
      month: row.admission_month || "",
      totalFees: row.admission_total_fees || "",
      currencyCode: row.currency_code || "",
      pendingDues: row.admission_pending_dues || "",
      receivedPayment: row.admission_total_paid || "0",
      invoiceStatus: row.admission_invoice_status || "",
      invoiceStatusTimestamp: row.admission_invoice_status_timestamp || "",
      paidInvoiceStatus: row.admission_paid_invoice_status || "",
      paidInvoiceStatusTimestamp: row.admission_paid_invoice_status_timestamp || "",
    },
  };
}

/* ================== BILLING HELPERS (Jan-Dec) ================== */
// ✅ Use BILLING_MONTHS keys (single source of truth)
const BILLING_MONTH_KEYS = BILLING_MONTHS.map(m => String(m.key || "").trim().toLowerCase());
const MONTH_INDEX = Object.fromEntries(BILLING_MONTH_KEYS.map((k, i) => [k, i]));
function currentMonthKey() {
  const m = new Date().getMonth(); // 0 = Jan
  return BILLING_MONTHS[m]?.key || "january";
}
function normalizeMonthKey(v) {
  return String(v || "").trim().toLowerCase();
}
function getBillingYearFromReq(req) {
  const raw =
    req.query?.year ??
    req.body?.year ??
    new Date().getFullYear();

  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) {
    return new Date().getFullYear();
  }
  return y;
}

// ✅ accepts both key and label (safe)
function toMonthKey(v) {
  const s = normalizeMonthKey(v);
  if (MONTH_INDEX[s] != null) return s;

  const found = BILLING_MONTHS.find(m => normalizeMonthKey(m.label) === s);
  return found ? normalizeMonthKey(found.key) : "";
}

function monthIndex(keyOrLabel) {
  const k = toMonthKey(keyOrLabel);
  return k && MONTH_INDEX[k] != null ? MONTH_INDEX[k] : -1;
}

function getNextMonthKeyFrom(monthKeyOrLabel) {
  const idx = monthIndex(monthKeyOrLabel);
  if (idx === -1) return getNextMonthKey(); // fallback
  return BILLING_MONTH_KEYS[Math.min(idx + 1, BILLING_MONTH_KEYS.length - 1)];
}

// ✅ history normalize + duplication remove (same effectiveMonthKey -> last one wins)
function normalizeFeeHistory(history) {
  if (!Array.isArray(history)) return [];
  const sorted = [...history]
    .filter(h => h && h.effectiveMonthKey && h.fee != null)
    .sort((a, b) => (Date.parse(a.changedAt || "") || 0) - (Date.parse(b.changedAt || "") || 0));

  const map = new Map();
  for (const h of sorted) {
    const mk = normalizeMonthKey(h.effectiveMonthKey);
    if (monthIndex(mk) === -1) continue;
    map.set(mk, {
      ...h,
      effectiveMonthKey: mk,
      fee: Number(h.fee) || 0,
    });
  }

  return [...map.values()].sort((a, b) => monthIndex(a.effectiveMonthKey) - monthIndex(b.effectiveMonthKey));
}

// ✅ CORE: month ke liye fee choose karo (effectiveMonthKey <= month => apply)
function feeForMonth(history, fallbackFee, monthKey) {
  const targetIdx = monthIndex(monthKey);
  let fee = Number(fallbackFee) || 0;

  const h = normalizeFeeHistory(history);
  for (const item of h) {
    if (monthIndex(item.effectiveMonthKey) <= targetIdx) {
      fee = Number(item.fee) || fee;
    }
  }
  return fee;
}
function attachComputedMonthFees(row, targetObj, billingYear = new Date().getFullYear()) {
  const billingArr = getAdmissionBillingByYear(row.id, billingYear);

  const billingJson = {};
  for (const item of billingArr) {
    billingJson[item.month] = {
      status: item.status || "",
      amount: String(item.amount || ""),
      feeOverride: String(item.fee || ""),
      verification: String(item.verificationNumber || ""),
      bank: String(item.bank || ""),
    };
  }

  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
  const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);

  const monthFees = {};
  for (const m of BILLING_MONTHS) {
    const entry = billingJson?.[m.key] || {};
    const override = parseFirstNumber(entry.feeOverride || "");
    monthFees[m.key] = override > 0 ? override : feeForMonth(feeHistory, baseFee, m.key);
  }

  targetObj.billingJson = billingJson;
  targetObj.monthFees = monthFees;
  targetObj.baseFee = baseFee;
  targetObj.feeHistory = feeHistory;
}

// ✅ fee change should start from "paid upto" ka next month (best behavior)
function getEffectiveStartMonthKey(row) {
  const paidUpto = normalizeMonthKey(row?.accounts_paid_upto);
  if (monthIndex(paidUpto) !== -1) return getNextMonthKeyFrom(paidUpto);
  return getNextMonthKey();
}

function getFeeHistory(row) {
  const parsed = safeJsonParse(row?.fee_history);
  return Array.isArray(parsed) ? parsed : [];
}

function ensureInitialFeeHistory(row, history, fallbackOldFee = 0) {
  const h = Array.isArray(history) ? history.slice() : [];
  if (h.length > 0) return h;

  const oldFee =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(fallbackOldFee || 0) ||
    parseFirstNumber(row?.admission_fees || 0);

  if (oldFee > 0) {
    h.push({
      fee: oldFee,
      effectiveMonthKey: "january",
      changedAt: row?.created_at || new Date().toISOString(),
      changedBy: "system",
    });
  }
  return h;
}

function applyFeeChangeIfNeeded(row, actorUser, incomingFeeNumber, fallbackOldFee = 0, paidUptoKey = "") {
  let history = getFeeHistory(row);
  history = normalizeFeeHistory(history);

  const currentLastFee =
    (history.length ? Number(history[history.length - 1].fee) : 0) ||
    parseFirstNumber(row?.monthly_fee_current || fallbackOldFee || row?.admission_fees || 0) ||
    0;

  // ✅ effective month = paidUpto ke NEXT month se
  const paidKey = normalizeMonthKey(paidUptoKey || row?.accounts_paid_upto || "");
  const effective = getNextMonthKeyFrom(paidKey);

  if (incomingFeeNumber > 0 && Number(incomingFeeNumber) !== Number(currentLastFee)) {
    // ✅ same effective month entry replace (duplicate na bane)
    history = history.filter(h => normalizeMonthKey(h.effectiveMonthKey) !== effective);

    history.push({
      fee: Number(incomingFeeNumber),
      effectiveMonthKey: effective,
      changedAt: new Date().toISOString(),
      changedBy: actorUser?.name || "unknown",
    });

    history = normalizeFeeHistory(history);
  }

  return history;
}

function baseFeeFromHistoryOrRow(row, history, incomingFeeNumber) {
  if (Array.isArray(history) && history.length > 0) {
    return parseFirstNumber(history[0].fee || 0);
  }
  return incomingFeeNumber || parseFirstNumber(row?.admission_fees || row?.monthly_fee_current || 0) || 0;
}

function getBillingJsonFromRow(row) {
  const parsed = safeJsonParse(row.billing_json);
  if (parsed) return parsed;

  const out = {};
  for (const m of BILLING_MONTHS) {
    const raw = String(row[m.key] || "").trim();
    if (!raw) {
      out[m.key] = { status: "", amount: "", feeOverride: "", verification: "", number: "" };
      continue;
    }
    const { status, amount } = splitBillingValue(raw);
    out[m.key] = {
      status: status || "",
      amount: String(amount || ""),
      feeOverride: "",
      verification: "",
      number: "",
    };
  }
  return out;
}

function computePaidUptoFromBillingJson(billingJson) {
  let last = "";

  for (const m of BILLING_MONTHS) {
    const e = billingJson[m.key] || {};
    const st = String(e.status || "").trim().toLowerCase();
    const amt = parseFirstNumber(e.amount || "");
    const hasAnyActivity = st !== "" || amt > 0;

    // sirf Not admitted month ignore hoga
    if (!hasAnyActivity) continue;
    if (st === "not admitted") continue;

    last = m.key;
  }

  return last;
}

function computeReceivedPaymentFromBillingJson(billingJson) {
  let total = 0;

  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim();
    const amt = parseFirstNumber(e.amount || "");

    if (st === "Not admitted" || st === "No payment") continue;
    if (amt > 0) total += amt;
  }
  return total;
}

function inferMonthlyFee(row, billingObj) {
  const fromAdmissionFees = parseFirstNumber(row?.admission_fees || "");
  if (fromAdmissionFees > 0) return fromAdmissionFees;

  const amounts = [];

  for (const m of BILLING_MONTHS) {
    const entry = billingObj ? billingObj[m.key] : null;

    if (entry && typeof entry === "object") {
      const amt = parseFirstNumber(entry.amount || "");
      if (amt > 0) amounts.push(amt);
      continue;
    }

    const raw = String(entry || "").trim();
    if (!raw) continue;

    const { amount } = splitBillingValue(raw);
    if (amount > 0) amounts.push(amount);
  }

  if (!amounts.length) return 0;

  const freq = new Map();
  for (const a of amounts) freq.set(a, (freq.get(a) || 0) + 1);

  let best = amounts[0];
  let bestC = 0;
  for (const [a, c] of freq.entries()) {
    if (c > bestC) {
      best = a;
      bestC = c;
    }
  }
  return best > 0 ? best : 0;
}

function toMonthString(entry) {
  const status = String(entry?.status || "").trim();
  const amt = parseFirstNumber(entry?.amount || "");

  if (!status) {
    return amt > 0 ? String(amt) : "";
  }

  if (status === "Not admitted" || status === "No payment") return status;

  if (
    status === "Partial payment" ||
    status === "Full payment" 
  ) {
    return amt > 0 ? `${status} | ${amt}` : status;
  }

  return status;
}
// =========================
// ✅ Pending Month Rows Helper (NEW)
// =========================
function buildPendingRowsFromRow(row, billingYear = new Date().getFullYear()) {
  const billingArr = getAdmissionBillingByYear(row.id, billingYear);

  const billingJson = {};
  for (const item of billingArr) {
    billingJson[item.month] = {
      status: item.status || "",
      amount: String(item.amount || ""),
      feeOverride: String(item.fee || ""),
      verification: String(item.verificationNumber || ""),
      bank: String(item.bank || ""),
    };
  }

  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
  const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);

  const pending = [];

  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim();
    const stLower = st.toLowerCase();

    const amt = parseFirstNumber(e.amount || "");
    const feeOverride = parseFirstNumber(e.feeOverride || "");
    const fee = feeOverride > 0 ? feeOverride : (feeForMonth(feeHistory, baseFee, m.key) || 0);

    if (stLower !== "no payment" && stLower !== "partial payment") continue;

    const due = Math.max(0, (fee || 0) - (amt || 0));

    pending.push({
      monthKey: m.key,
      monthLabel: m.label,
      status: st || "",
      fee: fee || 0,
      received: amt || 0,
      due: due || 0,
      verification: String(e.verification || "").trim(),
      number: "",
      bank: String(e.bank || "").trim(),
      year: billingYear,
    });
  }

  return pending;
}
function getPaidMonthsFromRow(row, billingYear = new Date().getFullYear()) {
  const billingArr = getAdmissionBillingByYear(row.id, billingYear);

  const billingJson = {};
  for (const item of billingArr) {
    billingJson[item.month] = {
      status: item.status || "",
      amount: String(item.amount || ""),
      feeOverride: String(item.fee || ""),
      verification: String(item.verificationNumber || ""),
      bank: String(item.bank || ""),
    };
  }

  const paid = [];

  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim().toLowerCase();
    const amt = parseFirstNumber(e.amount || "");

    const isPaid =
      amt > 0 ||
      st === "full payment" ||
      st === "partial payment";

    if (!isPaid) continue;

    paid.push({
      monthKey: m.key,
      monthLabel: m.label,
      status: String(e.status || "").trim(),
      received: amt || 0,
      verification: String(e.verification || "").trim(),
      number: "",
      bank: String(e.bank || "").trim(),
      year: billingYear,
    });
  }

  return paid;
}

function getLatestUpdatedBillingMonth(row, billingYear = new Date().getFullYear()) {
  const billingArr = getAdmissionBillingByYear(row.id, billingYear);

  if (!Array.isArray(billingArr) || !billingArr.length) return null;

  const active = billingArr.filter(item => {
    const status = String(item?.status || "").trim();
    const amount = parseFirstNumber(item?.amountReceived || item?.amount || "");
    const verification = String(item?.verificationNumber || "").trim();
    const bank = String(item?.bank || item?.bankName || "").trim();

    return status || amount > 0 || verification || bank;
  });

  if (!active.length) return null;

  active.sort((a, b) => {
    const aTime = new Date(
      a.updated_at || a.updatedAt || a.created_at || a.createdAt || 0
    ).getTime();

    const bTime = new Date(
      b.updated_at || b.updatedAt || b.created_at || b.createdAt || 0
    ).getTime();

    return bTime - aTime;
  });

  return active[0];
}

function normalizeBulkText(v) {
  return String(v || "").trim();
}

function getBulkChallanClassOptions() {
  return [
    "FS 1",
    "FS 2",
    "FS 3",
    "Grade 1",
    "Grade 2",
    "Grade 3",
    "Grade 4",
    "Grade 5",
    "Grade 6",
    "Grade 7",
    "Grade 8 (FBISE)",
    "Grade 8 (IGCSE / O'Level)",
    "Grade 9 (FBISE)",
    "Grade 9 (IGCSE / O'Level)",
    "Grade 10 (FBISE)",
    "Grade 10 (IGCSE / O'Level)",
    "Grade 11 (FBISE)",
    "Grade 11 (IGCSE, O / A'Level)",
    "Grade 12 (FBISE)"
  ];
}

function matchesBulkSection(row, selectedSection) {
  const wanted = String(selectedSection || "").trim().toLowerCase();

  if (!wanted || wanted === "all sections") return true;

  const possibleValues = [
    row?.section,
    row?.admission_section,
    row?.student_section,
    row?.class_section,
  ]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);

  if (!possibleValues.length) return false;

  return possibleValues.includes(wanted);
}

function getBulkChallanMatchingAdmissions({ user, className, section }) {
  const cleanClass = String(className || "").trim();

  let rows = [];

  if (user?.role === "super_admin") {
    rows = db.prepare(`
      SELECT *
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
        AND (
          TRIM(COALESCE(grade, '')) = TRIM(?)
          OR TRIM(COALESCE(tuition_grade, '')) = TRIM(?)
        )
      ORDER BY id DESC
    `).all(cleanClass, cleanClass);
  } else {
    rows = db.prepare(`
      SELECT *
      FROM admissions
      WHERE dept = ?
        AND COALESCE(is_deleted, 0) = 0
        AND (
          TRIM(COALESCE(grade, '')) = TRIM(?)
          OR TRIM(COALESCE(tuition_grade, '')) = TRIM(?)
        )
      ORDER BY id DESC
    `).all(user?.dept || "", cleanClass, cleanClass);
  }

  return rows.filter((row) => matchesBulkSection(row, section));
}

function isBillingMonthAlreadyUpdated(row, monthKey, billingYear = new Date().getFullYear()) {
  const billingArr = getAdmissionBillingByYear(row.id, billingYear);
  if (!Array.isArray(billingArr) || !billingArr.length) return false;

  const target = billingArr.find(
    (item) => String(item?.month || "").trim().toLowerCase() === String(monthKey || "").trim().toLowerCase()
  );

  if (!target) return false;

  const status = String(target?.status || "").trim();
  const amount = parseFirstNumber(target?.amountReceived || target?.amount || "");
  const verification = String(target?.verificationNumber || "").trim();
  const bank = String(target?.bank || target?.bankName || "").trim();
  

  return !!(status || amount > 0 || verification || bank);
}

function buildReceivableRowsFromRow(row, billingYear = new Date().getFullYear()) {
  const billingArr = getAdmissionBillingByYear(row.id, billingYear);

  const billingJson = {};
  for (const item of billingArr) {
    billingJson[item.month] = {
      status: item.status || "",
      amount: String(item.amount || item.amountReceived || ""),
      feeOverride: String(item.fee || item.feeAmount || ""),
      verification: String(item.verificationNumber || ""),
      bank: String(item.bank || item.bankName || ""),
      paymentDate: String(item.paymentDate || item.paidOn || ""),
    };
  }

  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
  const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);

  const paidUptoKey = normalizeMonthKey(
    computePaidUptoFromBillingJson(billingJson) || row?.accounts_paid_upto || ""
  );

  const paidUptoIdx = monthIndex(paidUptoKey);
  const rows = [];

  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim();
    const stLower = st.toLowerCase();

    if (stLower === "not admitted") continue;

    const monthIdx = monthIndex(m.key);

    // Agar paid upto maujood hai to us se pehle ke bilkul blank months skip kar do
    if (paidUptoIdx !== -1 && monthIdx < paidUptoIdx) {
      const oldAmt = parseFirstNumber(e.amount || "");
      const hasOldActivity =
        !!st ||
        oldAmt > 0 ||
        String(e.verification || "").trim() ||
        String(e.bank || "").trim();

      if (!hasOldActivity) continue;
    }

    const amt = parseFirstNumber(e.amount || "");
    const feeOverride = parseFirstNumber(e.feeOverride || "");
    const fee = feeOverride > 0 ? feeOverride : (feeForMonth(feeHistory, baseFee, m.key) || 0);
    const due = Math.max(0, fee - amt);

    if (due <= 0) continue;

    rows.push({
      monthKey: m.key,
      monthLabel: m.label,
      status: st || "",
      fee: fee || 0,
      received: amt || 0,
      due: due || 0,
      verification: String(e.verification || "").trim(),
      bank: String(e.bank || "").trim(),
      year: billingYear,
    });
  }

  return rows;
}

function buildFeeCollectionRowsForAdmission(row, billingYear = new Date().getFullYear()) {
  const receivableRows = buildReceivableRowsFromRow(row, billingYear) || [];

  return receivableRows
    .map((r) => ({
      admissionId: row.id,
      studentName: row.student_name || "",
      familyNumber: String(row.accounts_family_number || "").trim(),
      registrationNumber: String(row.accounts_registration_number || "").trim(),
      dept: row.dept || "",
      grade: row.grade || "",
      currency: row.currency_code || "",
      monthKey: String(r.monthKey || "").trim().toLowerCase(),
      monthLabel: r.monthLabel || "",
      status: r.status || "",
      fee: Number(r.fee || 0),
      received: Number(r.received || 0),
      due: Number(r.due || 0),
      verification: String(r.verification || "").trim(),
      bank: String(r.bank || "").trim(),
      year: Number(r.year || billingYear),
    }))
    .filter((x) => x.due > 0);
}

function buildFeeCollectionRowsForFamily(rows, billingYear = new Date().getFullYear()) {
  const all = [];

  for (const row of rows || []) {
    const one = buildFeeCollectionRowsForAdmission(row, billingYear);
    all.push(...one);
  }

  all.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return monthIndex(a.monthKey) - monthIndex(b.monthKey);
  });

  return all;
}

function summarizeFeeCollectionRows(
  admissionRows = [],
  billingYear = new Date().getFullYear(),
  uptoMonthKey = currentMonthKey()
) {
  let totalFee = 0;
  let totalReceived = 0;
  let totalDues = 0; // current month + previous pending
  let totalFullPendingDues = 0; // all pending dues, including future receivable months

  const uptoIdx = monthIndex(uptoMonthKey);

  for (const row of admissionRows || []) {
    if (!row) continue;

    const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);

    const oldFeeSnapshot =
      parseFirstNumber(row?.monthly_fee_current || 0) ||
      parseFirstNumber(row?.admission_fees || 0) ||
      inferMonthlyFee(row, billingJson) ||
      0;

    let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
    const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);

    for (const m of BILLING_MONTHS) {
      const e = billingJson?.[m.key] || {};
      const st = String(e.status || "").trim().toLowerCase();

      if (st === "not admitted") continue;

      const received = parseFirstNumber(e.amount || "");
      const feeOverride = parseFirstNumber(e.feeOverride || "");
      const fee = feeOverride > 0 ? feeOverride : (feeForMonth(feeHistory, baseFee, m.key) || 0);
      const due = Math.max(0, fee - received);

      totalFee += fee;
      totalReceived += received;
      totalFullPendingDues += due;

      const rowIdx = monthIndex(m.key);
      if (uptoIdx === -1 || rowIdx === -1 || rowIdx <= uptoIdx) {
        totalDues += due;
      }
    }
  }

  return {
    totalFee,
    totalReceived,
    totalDues,
    totalFullPendingDues,
    totalFeeForSession: totalFee,
    totalDuesUptoCurrentMonth: totalDues,
    currentMonthKey: uptoMonthKey,
  };
}


function getBillingJsonByAdmissionId(admissionId, billingYear = new Date().getFullYear()) {
  const billingArr = getAdmissionBillingByYear(admissionId, billingYear);
  const billingJson = {};

  for (const item of billingArr) {
    billingJson[item.month] = {
      status: item.status || "",
      amount: String(item.amount || item.amountReceived || ""),
      feeOverride: String(item.fee || item.feeAmount || ""),
      verification: String(item.verificationNumber || ""),
      bank: String(item.bank || item.bankName || ""),
      paymentDate: String(item.paymentDate || item.paidOn || ""),
    };
  }

  return billingJson;
}

function markSelectedMonthsNotAdmitted({
  row,
  billingYear,
  selectedMonths = [],
}) {
  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);
  const touchedMonths = [];

  for (const item of selectedMonths) {
    const monthKey = String(item?.monthKey || "").trim().toLowerCase();
    if (!BILLING_MONTH_KEYS.includes(monthKey)) continue;

    billingJson[monthKey] = {
      status: "Not admitted",
      amount: "",
      feeOverride: "",
      verification: "",
      bank: "",
      paymentDate: "",
    };

    touchedMonths.push({
      monthKey,
      status: "Not admitted",
    });
  }

  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
  const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);

  for (const m of BILLING_MONTHS) {
    const item = billingJson[m.key] || {};
    saveAdmissionBillingMonthByYear({
      admissionId: row.id,
      billingYear,
      monthKey: m.key,
      status: String(item.status || ""),
      amountReceived: String(item.amount || ""),
      feeAmount: String(item.feeOverride || ""),
      verificationNumber: String(item.verification || ""),
      bankName: String(item.bank || ""),
      paymentDate: String(item.paymentDate || ""),
    });
  }

  const dues = calcPendingDues(baseFee, billingJson, feeHistory);
  const paidUpto = computePaidUptoFromBillingJson(billingJson);
  const receivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

 const latestTouchedMonthKey = touchedMonths.length
  ? touchedMonths[touchedMonths.length - 1].monthKey
  : "";

const latestVerificationForColumn =
  latestTouchedMonthKey && billingJson[latestTouchedMonthKey]
    ? String(billingJson[latestTouchedMonthKey].verification || "").trim()
    : "";

db.prepare(`
  UPDATE admissions
  SET billing_json = @billing_json,
      fee_history = @fee_history,
      monthly_fee_current = @monthly_fee_current,
      accounts_paid_upto = @accounts_paid_upto,
      accounts_verification_number = @accounts_verification_number,
      admission_total_fees = @admission_total_fees,
      admission_pending_dues = @admission_pending_dues,
      admission_total_paid = @admission_total_paid
  WHERE id = @id
`).run({
  id: row.id,
  billing_json: JSON.stringify(billingJson),
  fee_history: JSON.stringify(feeHistory),
  monthly_fee_current: dues.currentFee || baseFee || 0,
  accounts_paid_upto: paidUpto || "",
  accounts_verification_number: latestVerificationForColumn,
  admission_total_fees: String(dues.expected || 0),
  admission_pending_dues: String(dues.pending || 0),
  admission_total_paid: String(receivedPayment || 0),
});

  return {
    success: true,
    touchedMonths,
    billingJson,
    paidUpto,
    receivedPayment,
  };
}

function applyFeeCollectionToBilling({
  row,
  billingYear,
  receiveAmount,
  verificationNumber,
  collectionAccount,
  receivingDate,
  note,
  actorUser,
}) {
  let remaining = Number(receiveAmount || 0);

  if (!row || remaining <= 0) {
    return {
      success: false,
      message: "Invalid row or amount",
      appliedAmount: 0,
      remainingAmount: remaining,
      touchedMonths: [],
    };
  }

  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);

  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
  const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);

  const receivableRows = buildReceivableRowsFromRow(row, billingYear)
  .sort((a, b) => monthIndex(a.monthKey) - monthIndex(b.monthKey));

const touchedMonths = [];

for (const p of receivableRows) {
    if (remaining <= 0) break;

    const monthKey = String(p.monthKey || "").trim().toLowerCase();
    const current = billingJson[monthKey] || {
      status: "",
      amount: "",
      feeOverride: "",
      verification: "",
      bank: "",
      paymentDate: "",
    };

    const currentReceived = parseFirstNumber(current.amount || 0);
    const feeOverride =
      parseFirstNumber(current.feeOverride || 0) ||
      feeForMonth(feeHistory, baseFee, monthKey) ||
      0;

    const currentDue = Math.max(0, feeOverride - currentReceived);
    if (currentDue <= 0) continue;

    const used = Math.min(remaining, currentDue);
    const newReceived = currentReceived + used;
    const balance = Math.max(0, feeOverride - newReceived);

    current.amount = String(newReceived);
    current.feeOverride = String(feeOverride);
    current.verification = String(verificationNumber || "").trim();
    current.bank = String(collectionAccount || "").trim();
    current.paymentDate = String(receivingDate || "").trim();

    if (balance <= 0) current.status = "Full payment";
    else current.status = "Partial payment";

    billingJson[monthKey] = current;

    touchedMonths.push({
      monthKey,
      fee: feeOverride,
      previousReceived: currentReceived,
      used,
      newReceived,
      balance,
      status: current.status,
    });

    remaining -= used;
  }

  for (const m of BILLING_MONTHS) {
    const item = billingJson[m.key] || {};
    saveAdmissionBillingMonthByYear({
      admissionId: row.id,
      billingYear,
      monthKey: m.key,
      status: String(item.status || ""),
      amountReceived: String(item.amount || ""),
      feeAmount: String(item.feeOverride || ""),
      verificationNumber: String(item.verification || ""),
      bankName: String(item.bank || ""),
      paymentDate: String(item.paymentDate || ""),
    });
  }

  const dues = calcPendingDues(baseFee, billingJson, feeHistory);
  const paidUpto = computePaidUptoFromBillingJson(billingJson);
  const receivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

  const latestTouched = touchedMonths.length ? touchedMonths[touchedMonths.length - 1] : null;
  const latestVerificationForColumn =
    latestTouched
      ? String(billingJson[latestTouched.monthKey]?.verification || "").trim()
      : String(row.accounts_verification_number || "").trim();

  db.prepare(`
    UPDATE admissions
    SET billing_json = @billing_json,
        fee_history = @fee_history,
        monthly_fee_current = @monthly_fee_current,
        
        accounts_paid_upto = @accounts_paid_upto,
        accounts_verification_number = @accounts_verification_number,
        admission_total_fees = @admission_total_fees,
        admission_pending_dues = @admission_pending_dues,
        admission_total_paid = @admission_total_paid
    WHERE id = @id
  `).run({
    id: row.id,
    billing_json: JSON.stringify(billingJson),
    fee_history: JSON.stringify(feeHistory),
    monthly_fee_current: dues.currentFee || baseFee || 0,
    
    accounts_paid_upto: paidUpto || "",
    accounts_verification_number: latestVerificationForColumn,
    admission_total_fees: String(dues.expected || 0),
    admission_pending_dues: String(dues.pending || 0),
    admission_total_paid: String(receivedPayment || 0),
  });

  logAudit("fee_collection_received", actorUser, {
    dept: row.dept || "",
    details: {
      admissionId: row.id,
      studentName: row.student_name || "",
      billingYear,
      collectionAccount,
      receivingDate,
      note: String(note || "").trim(),
      receiveAmount: Number(receiveAmount || 0),
      appliedAmount: Number(receiveAmount || 0) - remaining,
      remainingAmount: remaining,
      touchedMonths,
    },
  });

  return {
    success: true,
    billingJson,
    calc: { baseFee, ...dues },
    paidUpto,
    receivedPayment,
    appliedAmount: Number(receiveAmount || 0) - remaining,
    remainingAmount: remaining,
    touchedMonths,
  };
}

function buildBulkWhatsappPayload({ req, user, rows, className, section, monthKey, year, feeType }) {
  return {
    event: "bulk_challan_send_request",
    ts: new Date().toISOString(),
    triggeredBy: {
      id: user?.id || null,
      name: user?.name || null,
      role: user?.role || null,
      dept: user?.dept || null,
    },
    filters: {
      className: String(className || "").trim(),
      section: String(section || "All Sections").trim(),
      monthKey: String(monthKey || "").trim(),
      year: Number(year) || new Date().getFullYear(),
      feeType: String(feeType || "Monthly Fee").trim(),
    },
    count: rows.length,
    records: rows.map((row) => ({
      admissionId: row.id,
      admission: row,
      pipeline: mapAdmissionRow(row),
      actions: [],
      manualMessage: "",
    })),
  };
}

function buildBillingWebhookPayload({
  user,
  updatedRow,
  billingYear,
  billingJson,
  calc,
  paidUpto,
  receivedPayment,
  latestChangedMonthKey,
  familyRows = [],
}) {
  return {
    event: "billing_save_request",
    ts: new Date().toISOString(),
    triggeredBy: {
      id: user?.id || null,
      name: user?.name || null,
      role: user?.role || null,
      dept: user?.dept || null,
    },
    admissionId: updatedRow?.id || null,
    billingYear,
    latestChangedMonthKey: latestChangedMonthKey || "",
    admission: updatedRow,
    pipeline: mapAdmissionRow(updatedRow),
    billing: billingJson,
    calc,
    paidUpto: paidUpto || "",
    receivedPayment: receivedPayment || 0,
    family: familyRows.map((r) => ({
      admissionId: r.id,
      admission: r,
      pipeline: mapAdmissionRow(r),
    })),
  };
}

/* =========================
   ✅ BILLING APIs
========================= */

app.get("/api/billing/:id", requireLogin, requireOpenBilling, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = getActiveAdmissionById(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    // ✅ non-super dept restriction
    if (user?.role !== "super_admin") {
      if (!user?.dept || row.dept !== user.dept) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }

    const billingYear = getBillingYearFromReq(req);
const billingArr = getAdmissionBillingByYear(id, billingYear);

const billingJson = {};
for (const item of billingArr) {
  billingJson[item.month] = {
    status: item.status || "",
    amount: String(item.amount || ""),
    feeOverride: String(item.fee || ""),
    verification: String(item.verificationNumber || ""),
    bank: String(item.bank || ""),
  };
}

    let baseFee = parseFirstNumber(row.admission_fees || "") || 0;
    if (!baseFee) {
      baseFee =
        parseFirstNumber(row.monthly_fee_current || "") ||
        inferMonthlyFee(row, billingJson) ||
        0;
    }
    
   const oldFeeSnapshot =
  parseFirstNumber(row?.monthly_fee_current || 0) ||
  parseFirstNumber(row?.admission_fees || 0) ||
  inferMonthlyFee(row, billingJson) ||
  0;

    const feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
    baseFee = baseFeeFromHistoryOrRow(row, feeHistory, baseFee);


    const dues = calcPendingDues(baseFee, billingJson, feeHistory);
    // ✅ LOCK feeOverride for months that already have status/amount
  for (const m of BILLING_MONTHS) {
  const e = billingJson?.[m.key] || {};
  const st = String(e.status || "").trim();
  const amt = parseFirstNumber(e.amount || "");

  const shouldLock = (st && st !== "") || (amt > 0);

  // agar lock hona chahiye aur feeOverride empty hai to history wali fee set kar do
  if (shouldLock && !String(e.feeOverride || "").trim()) {
    e.feeOverride = String(feeForMonth(feeHistory, baseFee, m.key) || "");
    billingJson[m.key] = e;
  }
}

    const paidUpto = computePaidUptoFromBillingJson(billingJson);

   return res.json({
  success: true,
  admissionId: id,
  billingYear,
  currencyCode: row.currency_code || "",
  billing: billingJson,
  paidUpto,
  calc: { baseFee, ...dues },
});
  } catch (err) {
    console.error("GET /api/billing/:id error:", err);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.post("/api/billing/:id", requireLogin, requireSaveBilling, async (req, res) => {
  const user = req.session.user;

  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = getActiveAdmissionById(id);
    const billingYear = getBillingYearFromReq(req);
    if (!row) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    // ✅ non-super dept restriction
    if (user?.role !== "super_admin") {
      if (!user?.dept || row.dept !== user.dept) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }
   // ✅ ALWAYS first
    const beforeBillingArr = getAdmissionBillingByYear(id, billingYear);
const beforeBilling = {};

for (const item of beforeBillingArr) {
  beforeBilling[item.month] = {
    status: item.status || "",
    amount: String(item.amount || ""),
    feeOverride: String(item.fee || ""),
    verification: String(item.verificationNumber || ""),
    bank: String(item.bank || ""),
  };
}

   // (optional) agar aap still paidUptoBefore rakhna chahen
   const paidUptoBefore =
     computePaidUptoFromBillingJson(beforeBilling) || row.accounts_paid_upto || "";


    // ✅ input normalize
    const input = req.body && req.body.billing ? req.body.billing : (req.body || {});
    const billingJson = {};

    // ✅ incoming fee (user updated fee)
    const incomingFeeNumber = parseFirstNumber(
      req.body?.baseFee ?? req.body?.monthlyFee ?? req.body?.fees ?? ""
    );

    // ✅ Old fee snapshot
    const oldFeeSnapshot =
      parseFirstNumber(row?.monthly_fee_current || 0) ||
      parseFirstNumber(row?.admission_fees || 0) ||
      inferMonthlyFee(row, beforeBilling) ||
      0;
     const baseFeeBefore = oldFeeSnapshot || 0;

    // ✅ feeHistory BEFORE change (old)
    let feeHistoryBefore = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);

  let feeHistoryAfter = applyFeeChangeIfNeeded(
  row,
  user,
  incomingFeeNumber,
  oldFeeSnapshot,
  paidUptoBefore
);


    // ✅ base fee
    let baseFee =
      parseFirstNumber(row.admission_fees || "") ||
      parseFirstNumber(row.monthly_fee_current || "") ||
      oldFeeSnapshot ||
      0;

    baseFee = baseFeeFromHistoryOrRow(row, feeHistoryAfter, incomingFeeNumber || baseFee);

    // ✅ Build billingJson with correct lock rule:
    // - If month already had status/amount BEFORE (beforeBilling) => LOCK feeOverride using OLD history
    // - Else if new status/amount set now => LOCK using NEW history
    // - Else keep feeOverride empty
    for (const m of BILLING_MONTHS) {
      const v = input[m.key];

      // old month activity (already paid/entered previously)
      const prev = (beforeBilling && beforeBilling[m.key]) ? beforeBilling[m.key] : {};
      const prevSt = String(prev.status || "").trim();
      const prevAmt = parseFirstNumber(prev.amount || "");
      const hadPrevActivity = (prevSt && prevSt !== "") || (prevAmt > 0);

      if (v && typeof v === "object") {
        const st = String(v.status || "").trim();
                if (st) {
          const allowed = db
            .prepare("SELECT id FROM billing_status_options WHERE label = ?")
            .get(st);

          if (!allowed) {
            return res.status(400).json({
              success: false,
              message: `Invalid billing status selected for ${m.label}`
            });
          }
        }
        const bankVal = String(v.bank || "").trim();
        if (bankVal) {
         const allowedBank = db
          .prepare("SELECT id FROM bank_options WHERE label = ?")
           .get(bankVal);

        if (!allowedBank) {
        return res.status(400).json({
        success: false,
        message: `Invalid bank selected for ${m.label}`
      });
    }
  }
        const amt = parseFirstNumber(v.amount || "");
        const hasNowActivity = (st && st !== "") || (amt > 0);

        let feeOverride = "";

        if (hadPrevActivity) {
          // ✅ LOCK old months by old history (old fee)
          feeOverride = String(
            prev.feeOverride ||
            feeForMonth(feeHistoryBefore, baseFeeBefore, m.key) ||
            ""
          );
        } else if (hasNowActivity) {
          // ✅ New month activity locks by new history
          feeOverride = String(feeForMonth(feeHistoryAfter, baseFee, m.key) || "");
        }

        billingJson[m.key] = {
        status: st,
        amount: String(v.amount || "").trim(),
        feeOverride,
        verification: String(v.verification || "").trim(),
        bank: String(v.bank || "").trim(),
        
      };
      } else {
        const raw = String(v || "").trim();
        const { status, amount } = splitBillingValue(raw);

        const st = String(status || "").trim();
                if (st) {
          const allowed = db
            .prepare("SELECT id FROM billing_status_options WHERE label = ?")
            .get(st);

          if (!allowed) {
            return res.status(400).json({
              success: false,
              message: `Invalid billing status selected for ${m.label}`
            });
          }
        }
        const bankVal = String(v.bank || "").trim();
        if (bankVal) {
        const allowedBank = db
       .prepare("SELECT id FROM bank_options WHERE label = ?")
       .get(bankVal);

       if (!allowedBank) {
       return res.status(400).json({
       success: false,
       message: `Invalid bank selected for ${m.label}`
      });
    }
  }
        const amt = parseFirstNumber(amount || "");
        const hasNowActivity = (st && st !== "") || (amt > 0);

        let feeOverride = "";

        if (hadPrevActivity) {
          feeOverride = String(
            prev.feeOverride ||
            feeForMonth(feeHistoryBefore, baseFeeBefore, m.key) ||
            ""
          );
        } else if (hasNowActivity) {
          feeOverride = String(feeForMonth(feeHistoryAfter, baseFee, m.key) || "");
        }

       billingJson[m.key] = {
       status: st,
       amount: String(amount || ""),
       feeOverride,
       verification: "",
       bank: "",
       };
      }
    }

    let latestChangedMonthKey = "";

for (const m of BILLING_MONTHS) {
  const beforeItem = beforeBilling[m.key] || {};
  const afterItem = billingJson[m.key] || {};

  const beforeStatus = String(beforeItem.status || "").trim();
  const beforeAmount = String(beforeItem.amount || "").trim();
  const beforeVerification = String(beforeItem.verification || "").trim();
  const beforeBank = String(beforeItem.bank || "").trim();

  const afterStatus = String(afterItem.status || "").trim();
  const afterAmount = String(afterItem.amount || "").trim();
  const afterVerification = String(afterItem.verification || "").trim();
  const afterBank = String(afterItem.bank || "").trim();

  const changed =
    beforeStatus !== afterStatus ||
    beforeAmount !== afterAmount ||
    beforeVerification !== afterVerification ||
    beforeBank !== afterBank ;

  if (changed) {
    latestChangedMonthKey = m.key;
  }
}

const latestVerificationForColumn = latestChangedMonthKey
  ? String(billingJson[latestChangedMonthKey]?.verification || "").trim()
  : String(row.accounts_verification_number || "").trim();

    // ✅ now calculate dues using history + billingJson
    const dues = calcPendingDues(baseFee, billingJson, feeHistoryAfter);

    const paidUpto = computePaidUptoFromBillingJson(billingJson);
    const receivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

    const billingStrings = {};
    for (const m of BILLING_MONTHS) {
      billingStrings[m.key] = toMonthString(billingJson[m.key]);
    }
    for (const m of BILLING_MONTHS) {
  const item = billingJson[m.key] || {};

  saveAdmissionBillingMonthByYear({
    admissionId: id,
    billingYear,
    monthKey: m.key,
    status: String(item.status || ""),
    amountReceived: String(item.amount || ""),
    feeAmount: String(item.feeOverride || ""),
    verificationNumber: String(item.verification || ""),
    bankName: String(item.bank || ""),
    paymentDate: "",
  });
}

    db.prepare(`
      UPDATE admissions
         SET january = @january,
             february = @february,
             march = @march,
             april = @april,
             may = @may,
             june = @june,
             july = @july,
             august = @august,
             september = @september,
             october = @october,
             november = @november,
             december = @december,

             billing_json = @billing_json,
             fee_history = @fee_history,
             monthly_fee_current = @monthly_fee_current,

             accounts_paid_upto = @accounts_paid_upto,
             accounts_verification_number = @accounts_verification_number,
             admission_total_fees = @admission_total_fees,
             admission_pending_dues = @admission_pending_dues,
             admission_total_paid = @admission_total_paid
       WHERE id = @id
    `).run({
      id,
      ...billingStrings,

      billing_json: JSON.stringify(billingJson),
      fee_history: JSON.stringify(feeHistoryAfter),

      monthly_fee_current: dues.currentFee || baseFee || 0,

      accounts_paid_upto: paidUpto || "",
      admission_total_fees: String(dues.expected || 0),
      admission_pending_dues: String(dues.pending || 0),
      admission_total_paid: String(receivedPayment || 0),
      accounts_verification_number: latestVerificationForColumn,
    });

    logAudit("billing_update", user, {
      dept: row.dept,
      details: {
        admissionId: id,
        beforeBilling,
        afterBilling: billingJson,
        calc: { baseFee, ...dues, paidUpto },
      },
    });

   emitAdmissionChanged(req, { type: "billing_update", admissionId: id, dept: row.dept });

const updatedRow = db.prepare("SELECT * FROM admissions WHERE id = ?").get(id);

const familyNumber = String(updatedRow?.accounts_family_number || "").trim();

let familyRows = [];
if (familyNumber) {
  if (user?.role === "super_admin") {
    familyRows = db.prepare(`
      SELECT *
      FROM admissions
      WHERE accounts_family_number = ?
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY id DESC
    `).all(familyNumber);
  } else {
    familyRows = db.prepare(`
      SELECT *
      FROM admissions
      WHERE accounts_family_number = ?
        AND dept = ?
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY id DESC
    `).all(familyNumber, user?.dept || "");
  }
}

const billingPayload = buildBillingWebhookPayload({
  user,
  updatedRow,
  billingYear,
  billingJson,
  calc: { baseFee, ...dues },
  paidUpto,
  receivedPayment,
  latestChangedMonthKey,
  familyRows,
});

let n8nStatus = "skipped";
let n8nResponseText = "";

if (process.env.N8N_BILLING_WEBHOOK_URL) {
  try {
    const webhookResp = await fetch(process.env.N8N_BILLING_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(billingPayload),
    });

    n8nResponseText = await webhookResp.text();
    n8nStatus = webhookResp.ok ? "sent" : "failed";
  } catch (e) {
    n8nStatus = "failed";
    n8nResponseText = String(e?.message || e);
  }
}

return res.json({
  success: true,
  message: "Billing saved",
  billingYear,
  paidUpto: paidUpto || "",
  receivedPayment,
  billing: billingJson,
  calc: { baseFee, ...dues },
  n8nStatus,
  n8nResponse: n8nResponseText,
});
  } catch (err) {
    console.error("POST /api/billing/:id error:", err);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

function getPreviousSixMonthsRecord(full, selectedMonthKey) {
  const months = Array.isArray(BILLING_MONTHS) ? BILLING_MONTHS : [];
  const selectedIndex = months.findIndex(
    (m) => String(m.key || "").toLowerCase() === String(selectedMonthKey || "").toLowerCase()
  );

  if (selectedIndex === -1) return [];

  const billingRows = Array.isArray(full?.billing) ? full.billing : [];

  const startIndex = Math.max(0, selectedIndex - 6);
  const rangeMonths = months.slice(startIndex, selectedIndex);

  return rangeMonths.map((m) => {
    const found = billingRows.find(
      (b) => String(b?.month || "").toLowerCase() === String(m.key || "").toLowerCase()
    );

    return {
      monthKey: m.key,
      monthLabel: m.label,
      status: String(found?.status || "").trim(),
      amount: Number(found?.amount || 0),
      fee: Number(found?.fee || found?.expectedFee || 0),
      due: Number(found?.due || 0),
      verification: String(found?.verificationNumber || found?.verification || "").trim(),
      bank: String(found?.bank || found?.bankName || "").trim(),
    };
  });
}

function attachPreviousSixMonthsToFull(full, selectedMonthKey) {
  if (!full || typeof full !== "object") return full;

  const sixMonthsHistory = getPreviousSixMonthsRecord(full, selectedMonthKey);

  return {
    ...full,
    sixMonthsHistory,
  };
}
function getLastActiveMonthKeyFromBilling(billingJson) {
  let last = null;
  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim();
    const amt = parseFirstNumber(e.amount || "");
    if (st || amt > 0) last = m.key;
  }
  return last; // ex: "june" or null
}

function nextMonthKeyFromKey(monthKey) {
  const idx = BILLING_MONTHS.findIndex(x => x.key === monthKey);
  if (idx < 0) return "january";
  return BILLING_MONTHS[(idx + 1) % 12].key;
}

/* Shared handler: Super Admin full pipeline update (DB) */
function handleSuperFullUpdate(req, res) {
  console.log("UPDATE BODY:", req.body);
  const user = req.session.user;
  if (!user || user.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);
  const row = getActiveAdmissionById(id);

  if (!row) {
    return res.status(404).send("Not found");
  }

  const before = buildPipelineSnapshotFromRow(row);

 const {
  status,
  feeStatus,
  dept,
  student,
  father,
  father_email,
  grade,
  tuitionGrade,
  phone,
  paymentStatus,
  paidUpto,
  verificationNumber,
  registrationNumber,
  familyNumber,
  registrationFee,
  fees,
  month,
  currencyCode,
  currency_code,
  currency, // ✅ ADD
} = req.body;

  const cleanRegistrationNumber = String(registrationNumber || "").trim();
  const resolvedCurrencyCode = pickCurrencyCode(req.body, row.currency_code || "");
if (resolvedCurrencyCode) {
  const allowedCurrency = db
    .prepare("SELECT id FROM currency_options WHERE label = ?")
    .get(resolvedCurrencyCode);

  if (!allowedCurrency) {
    return res.status(400).json({
      success: false,
      message: "Invalid currency selected"
    });
  }
}
  const duplicateReg = checkDuplicateRegistrationNumber(cleanRegistrationNumber, id);
  if (duplicateReg) {
    return res.status(409).json({
      success: false,
      message: "This registration number is already in use. Please enter another number."
    });
  }
  const billingJson = getBillingJsonFromRow(row);
  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  const incomingFeeNumber = parseFirstNumber(
    typeof fees !== "undefined" && fees !== null ? fees : ""
  );

 // ✅ Always start from existing fee_history (so old months keep old fee)
let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
const effectivePaidUpto =
  computePaidUptoFromBillingJson(billingJson) ||
  paidUpto ||
  row.accounts_paid_upto ||
  "";
feeHistory = applyFeeChangeIfNeeded(
  row,
  user,
  incomingFeeNumber,
  oldFeeSnapshot,
  effectivePaidUpto
);

// ✅ baseFee + dues
const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, incomingFeeNumber || oldFeeSnapshot);
const dues = calcPendingDues(baseFee, billingJson, feeHistory);


  const updated = {
    status: typeof status !== "undefined" && status !== null ? status : (row.status || ""),
    feeStatus: (typeof feeStatus !== "undefined" && feeStatus !== null)
    ? feeStatus
    : (row.feeStatus || ""),   // ✅ ADD
    dept: dept && dept !== "" ? dept : row.dept,
    student_name:
      typeof student !== "undefined" && student !== null
        ? student
        : row.student_name,
    father_name:
      typeof father !== "undefined" && father !== null
        ? father
        : row.father_name,
    father_email:
      typeof father_email !== "undefined" && father_email !== null
        ? father_email
        : (row.father_email || ""),
    grade: typeof grade !== "undefined" && grade !== null ? grade : row.grade,
    tuition_grade:
      typeof tuitionGrade !== "undefined" && tuitionGrade !== null
        ? tuitionGrade
        : row.tuition_grade,
    phone: typeof phone !== "undefined" && phone !== null ? phone : row.phone,
    accounts_payment_status: pickPaymentStatus(req.body, row.accounts_payment_status || ""),
    accounts_paid_upto:
      typeof paidUpto !== "undefined" && paidUpto !== null
        ? paidUpto
        : row.accounts_paid_upto || "",
    accounts_verification_number:
      typeof verificationNumber !== "undefined" &&
      verificationNumber !== null
        ? verificationNumber
        : row.accounts_verification_number || "",
    accounts_registration_number:
  typeof registrationNumber !== "undefined" &&
  registrationNumber !== null
    ? cleanRegistrationNumber
    : row.accounts_registration_number || "",
    accounts_family_number:
      typeof familyNumber !== "undefined" && familyNumber !== null
        ? familyNumber
        : row.accounts_family_number || "",
    admission_registration_fee:
       (typeof registrationFee !== "undefined" && registrationFee !== null && String(registrationFee).trim() !== "")
       ? String(registrationFee).trim()
       : (row.admission_registration_fee || ""),
    // ✅ admission_fees = CURRENT fee (always update if provided)
    admission_fees:
      (typeof fees !== "undefined" && fees !== null && String(fees).trim() !== "")
       ? String(fees).trim()
       : (row.admission_fees || ""),
    currency_code: resolvedCurrencyCode,
    admission_month:
      typeof month !== "undefined" && month !== null
        ? month
        : row.admission_month || "",
    fee_history: JSON.stringify(feeHistory),
    admission_total_fees: String(dues.expected || 0),
    admission_pending_dues: String(dues.pending || 0),
  };

  db.prepare(`
    UPDATE admissions
     SET dept = @dept,
         status = @status,
         feeStatus = @feeStatus,       -- ✅ ADD
         student_name = @student_name,
         father_name = @father_name,
         father_email = @father_email,
         grade = @grade,
         tuition_grade = @tuition_grade,
         phone = @phone,
         accounts_payment_status = @accounts_payment_status,
         accounts_paid_upto = @accounts_paid_upto,
         accounts_verification_number = @accounts_verification_number,
         accounts_registration_number = @accounts_registration_number,
         accounts_family_number = @accounts_family_number,
         admission_registration_fee = @admission_registration_fee,
         admission_fees = @admission_fees,
         currency_code = @currency_code,
         admission_month = @admission_month,
         fee_history = @fee_history,
         monthly_fee_current = @monthly_fee_current,
         admission_total_fees = @admission_total_fees,
         admission_pending_dues = @admission_pending_dues
     WHERE id = @id
  `).run({
    id,
    ...updated,
    monthly_fee_current: incomingFeeNumber > 0 ? incomingFeeNumber : (dues.currentFee || baseFee || 0),
  });

  const afterRow = { ...row, ...updated };
  const after = buildPipelineSnapshotFromRow(afterRow);

  logAudit("pipeline_super_update", user, {
    dept: updated.dept,
    details: { admissionId: id, before, after },
  });

  emitAdmissionChanged(req, { type: "super_update", admissionId: id });

  return res.redirect("/dashboard");
}

/* ================= API: WEB ADMISSIONS (form se) ================= */

// ✅ Admission form submit (API key required)
app.post("/api/admissions", checkApiKey, async (req, res) => {
  try {
    const {
      dept,
      deptLabel,

      session,
      registration_date,
      processed_by,

      father_name,
      guardian_whatsapp,
      religion,
      father_email,
      father_occupation,
      nationality,

      present_address,
      city,
      state,
      secondary_contact,

      tuition_grade,
      tuitionGrade,
      phone,
      currency_code,
      currencyCode,
      currency,


      children = [],
    } = req.body || {};

    if (!Array.isArray(children) || children.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No children data sent" });
    }

    const resolvedDept =
      (dept || deptLabel || "").toString().toLowerCase() || "school";
    const resolvedTuitionGrade = tuition_grade || tuitionGrade || "";
    const resolvedPhone = phone || guardian_whatsapp || "";
    const regDate = registration_date || new Date().toISOString().slice(0, 10);
    const resolvedSession = session || "2025-26";
    const resolvedCurrency =
    (currency_code || currencyCode || currency || "").toString().trim().toUpperCase() || "";
    if (resolvedCurrency) {
  const allowedCurrency = db
    .prepare("SELECT id FROM currency_options WHERE label = ?")
    .get(resolvedCurrency);

  if (!allowedCurrency) {
    return res.status(400).json({
      success: false,
      message: "Invalid currency selected"
    });
  }
}

    const base = {
      dept: resolvedDept || "",
      father_name: father_name || "",
      guardian_whatsapp: guardian_whatsapp || "",
      religion: religion || "",
      father_email: father_email || "",
      father_occupation: father_occupation || "",
      nationality: nationality || "",
      present_address: present_address || "",
      city: city || "",
      state: state || "",
      secondary_contact: secondary_contact || "",
      session: resolvedSession || "",
      registration_date: regDate || "",
      processed_by: processed_by || "",
      tuition_grade: resolvedTuitionGrade || "",
      phone: resolvedPhone || "",
      currency_code: resolvedCurrency,

    };

    const rows = children.map((child) => ({
      ...base,
      student_name: child.student_name || "",
      gender: child.gender || "",
      dob: child.dob || "",
      grade: child.grade || "",
    }));

    const stmt = db.prepare(`
  INSERT INTO admissions
  (dept,
   status, feeStatus,
   student_name, gender, dob, grade,
   father_name, guardian_whatsapp, religion, father_email, father_occupation, nationality,
   present_address, city, state, secondary_contact,
   session, registration_date, processed_by,
   tuition_grade, phone, currency_code)
  VALUES (
    @dept,
    @status, @feeStatus,
    @student_name, @gender, @dob, @grade,
    @father_name, @guardian_whatsapp, @religion,  @father_email, @father_occupation, @nationality,
    @present_address, @city, @state, @secondary_contact,
    @session, @registration_date, @processed_by,
    @tuition_grade, @phone, @currency_code
  )
`);

    const insertedIds = [];

    const insertMany = db.transaction((rowsToInsert) => {
      rowsToInsert.forEach((row) => {
        const safeRow = {
          status: "New Admission",
          feeStatus: "New Admission",
          dept: String(row.dept ?? ""),
          student_name: String(row.student_name ?? ""),
          gender: String(row.gender ?? ""),
          dob: String(row.dob ?? ""),
          grade: String(row.grade ?? ""),
          father_name: String(row.father_name ?? ""),
          guardian_whatsapp: String(row.guardian_whatsapp ?? ""),
          religion: String(row.religion ?? ""),
          father_email: String(row.father_email ?? ""),
          father_occupation: String(row.father_occupation ?? ""),
          nationality: String(row.nationality ?? ""),
          present_address: String(row.present_address ?? ""),
          city: String(row.city ?? ""),
          state: String(row.state ?? ""),
          secondary_contact: String(row.secondary_contact ?? ""),
          session: String(row.session ?? ""),
          registration_date: String(row.registration_date ?? ""),
          processed_by: String(row.processed_by ?? ""),
          tuition_grade: String(row.tuition_grade ?? ""),
          phone: String(row.phone ?? ""),
          currency_code: String(row.currency_code ?? ""),
        };

        const info = stmt.run(safeRow);
        insertedIds.push(Number(info.lastInsertRowid));
      });
    });

    insertMany(rows);

    const hostBaseUrl = `${req.protocol}://${req.get("host")}/`;
    let pdfOk = 0;
    let pdfFail = 0;

    for (const id of insertedIds) {
      try {
        const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(id);
        if (!row) continue;

        const pdfPath = await makeAdmissionPdf(row, hostBaseUrl);
        db.prepare("UPDATE admissions SET pdf_path = ? WHERE id = ?").run(
          pdfPath,
          id
        );

        pdfOk++;
      } catch (e) {
        pdfFail++;
        console.error("PDF generate failed for id:", id, e);
      }
    }

    emitAdmissionChanged(req, { type: "new_admission", insertedIds });

    return res.json({
      success: true,
      message: "Admissions saved to DB",
      inserted: rows.length,
      pdf_generated: pdfOk,
      pdf_failed: pdfFail,
    });
  } catch (err) {
    console.error("POST /api/admissions error:", err);
    return res
      .status(500)
      .json({ success: false, message: "DB insert failed" });
  }
});

// ✅ PDF download route (Dashboard se)
app.get("/admissions/:id/pdf", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    const id = parseInt(req.params.id, 10);
    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).send("Admission not found");

    // ✅ non-super: dept check + permission check
    if (user?.role !== "super_admin") {
     if (!perms.btnPdf) return res.status(403).send("Not allowed");
if (!user?.dept || row.dept !== user.dept) return res.status(403).send("Not allowed");

    }

    const hostBaseUrl = `${req.protocol}://${req.get("host")}/`;

    let pdfPath = row.pdf_path;

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      pdfPath = await makeAdmissionPdf(row, hostBaseUrl);
      db.prepare("UPDATE admissions SET pdf_path = ? WHERE id = ?").run(
        pdfPath,
        id
      );
    }

    const safeName = (row.student_name || `admission_${id}`)
      .toString()
      .replaceAll(" ", "_");
    return res.download(pdfPath, `${safeName}.pdf`);
  } catch (err) {
    console.error("GET /admissions/:id/pdf error:", err);
    return res.status(500).send("PDF error");
  }
});
// =====================================================
// ✅ COMMON DETAILS ACCESS HELPERS
// =====================================================
function canUseDetailsFeature(user, perms) {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  return !!perms?.btnDetails;
}

function ensureAdmissionRouteAccess(user, perms, row) {
  if (!user || !row) return false;

  // super admin: full access
  if (user.role === "super_admin") return true;

  // other users: must have details permission
  if (!perms?.btnDetails) return false;

  // same department only
  if (!user.dept || row.dept !== user.dept) return false;

  return true;
}

function getAccessibleFamilyRows(user, familyNumber) {
  if (!familyNumber) return [];

  if (user?.role === "super_admin") {
    return db
      .prepare(`
        SELECT *
        FROM admissions
        WHERE accounts_family_number = ?
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
      `)
      .all(familyNumber);
  }

  return db
    .prepare(`
      SELECT *
      FROM admissions
      WHERE accounts_family_number = ?
        AND dept = ?
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY id DESC
    `)
    .all(familyNumber, user.dept || "");
}

function getAccessibleFamilyIds(user, familyNumber) {
  if (!familyNumber) return [];

  if (user?.role === "super_admin") {
    return db
      .prepare(`
        SELECT id
        FROM admissions
        WHERE accounts_family_number = ?
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
      `)
      .all(familyNumber);
  }

  return db
    .prepare(`
      SELECT id
      FROM admissions
      WHERE accounts_family_number = ?
        AND dept = ?
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY id DESC
    `)
    .all(familyNumber, user.dept || "");
}
// =====================================================
// ✅ COMMON VIEW DETAILS PAGE
// supports super_admin + any user having btnDetails permission
// =====================================================
function renderSharedAdmissionDetails(req, res, viewName = "admission-details") {
  try {
    const user = req.session.user;
    const perms = getPerm(user);
    const billingYear = getBillingYearFromReq(req);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send("Invalid id");

    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).send("Admission not found");

    if (!ensureAdmissionRouteAccess(user, perms, row)) {
      return res.status(403).send("Not allowed");
    }

    const familyNumber = String(row.accounts_family_number || "").trim();

    let rows = [row];
    if (familyNumber) {
      rows = getAccessibleFamilyRows(user, familyNumber);
      if (!rows.length) rows = [row];
    }

  const admissionsFull = rows
  .map((r) => dbGetAdmissionDetailsById(r.id, billingYear))
  .filter(Boolean);

    const admissions = admissionsFull.map((full) => {
      const safe = maskAdmissionMapped(full, perms);
      const rrow = getActiveAdmissionById(full.id);
      if (rrow) attachComputedMonthFees(rrow, safe, billingYear);
      return safe;
    });

    const primaryFull = dbGetAdmissionDetailsById(id, billingYear);
    if (!primaryFull) return res.status(404).send("Admission not found");

    const primary = maskAdmissionMapped(primaryFull, perms);
    attachComputedMonthFees(row, primary, billingYear);

    return res.render(viewName, {
      user,
      perms,
      admission: primary,
      admissions,
      familyNumber,
      billingMonths: BILLING_MONTHS,
      pageTitle: "Admission Details",
    });
  } catch (err) {
    console.error("renderSharedAdmissionDetails error:", err);
    return res.status(500).send("Server error");
  }
}

function renderFeeCollectionPage(req, res) {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const admissionId = parseInt(req.query.admissionId, 10);
    const familyNumber = String(req.query.familyNumber || "").trim();
    const billingYear = getBillingYearFromReq(req);

    let rows = [];
    let mode = "single";
    let primaryRow = null;

    if (admissionId) {
      const row = getActiveAdmissionById(admissionId);
      if (!row) return res.status(404).send("Admission not found");

      if (!ensureAdmissionRouteAccess(user, perms, row)) {
        return res.status(403).send("Not allowed");
      }

      primaryRow = row;

      if (familyNumber) {
        rows = getAccessibleFamilyRows(user, familyNumber);
        if (rows.length) mode = "family";
        else rows = [row];
      } else {
        rows = [row];
      }
    } else if (familyNumber) {
      rows = getAccessibleFamilyRows(user, familyNumber);
      if (!rows.length) return res.status(404).send("No family admissions found");
      primaryRow = rows[0];
      mode = "family";
    } else {
      return res.status(400).send("admissionId or familyNumber required");
    }

    const feeRows =
      mode === "family"
        ? buildFeeCollectionRowsForFamily(rows, billingYear)
        : buildFeeCollectionRowsForAdmission(primaryRow, billingYear);

    const summary = summarizeFeeCollectionRows(rows, billingYear, currentMonthKey());

    return res.render("fee-collection", {
      user,
      perms,
      pageTitle: "Fee Collection",
      billingYear,
      mode,
      admissionId: primaryRow?.id || "",
      familyNumber: familyNumber || String(primaryRow?.accounts_family_number || "").trim(),
      rows,
      feeRows,
      summary,
      bankOptions: getBankOptions(),
    });
  } catch (err) {
    console.error("renderFeeCollectionPage error:", err);
    return res.status(500).send("Server error");
  }
}

app.get("/dashboard/super/fee-collection", requireLogin, (req, res) => {
  return renderFeeCollectionPage(req, res);
});

app.get("/admin/fee-collection", requireLogin, (req, res) => {
  return renderFeeCollectionPage(req, res);
});

// =====================================================
// ✅ VIEW DETAILS ROUTES
// keep both URLs working
// =====================================================



app.get("/dashboard/super/admission/:id", requireLogin, (req, res) => {
  return renderSharedAdmissionDetails(req, res, "admission-details");
});

app.get("/admin/admission/:id", requireLogin, (req, res) => {
  return renderSharedAdmissionDetails(req, res, "admission-details");
});

// Optional generic route for future use
app.get("/dashboard/admission/:id", requireLogin, (req, res) => {
  return renderSharedAdmissionDetails(req, res, "admission-details");
});

// =====================================================
// ✅ Month challan for single admission
// URL: /dashboard/super/admission/:id/challan/:monthKey
// =====================================================
app.get("/dashboard/super/admission/:id/challan/:monthKey", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const id = parseInt(req.params.id, 10);
    const monthKey = String(req.params.monthKey || "").toLowerCase().trim();

    if (!id) return res.status(400).send("Invalid id");
    if (!monthKey) return res.status(400).send("Invalid month");
    
    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).send("Admission not found");

    if (!ensureAdmissionRouteAccess(user, perms, row)) {
      return res.status(403).send("Not allowed");
    }
    const billingYear = getBillingYearFromReq(req);
    const full = dbGetAdmissionDetailsById(id, billingYear);
    if (!full) return res.status(404).send("Admission not found");

    const billArr = Array.isArray(full?.billing) ? full.billing : [];
    const monthRow = billArr.find(
      (b) => String(b?.month || "").toLowerCase() === monthKey
    );

    const monthStatus = String(monthRow?.status || "").trim().toLowerCase();

    if (monthStatus === "not admitted") {
      return res.status(400).send("Challan cannot be generated for a Not admitted month");
    }

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

    const fullWithHistory = attachPreviousSixMonthsToFull(full, monthKey);

const pdfBuffer = await makeMonthlyChallanPdf({
  full: fullWithHistory,
  monthKey,
  bannerPath,
});

    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
      console.log("pdfBuffer type:", typeof pdfBuffer, pdfBuffer?.constructor?.name);
      return res.status(500).send("PDF buffer is not a Buffer");
    }

    const head = pdfBuffer.subarray(0, 5).toString("utf8");
    if (head !== "%PDF-") {
      console.log("Not a PDF. First bytes:", pdfBuffer.subarray(0, 60).toString("utf8"));
      return res.status(500).send("Generated file is not a valid PDF");
    }

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const filename = `challan-${id}-${monthKey}-${Date.now()}.pdf`;
    const absPath = path.join(challanDir, filename);

    fs.writeFileSync(absPath, pdfBuffer);

    const relStored = toPosix(path.relative(uploadsDir, absPath));
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relStored}`;

    db.prepare(`
      INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      `Challan (${monthKey})`,
      relStored,
      fileUrl,
      "application/pdf",
      pdfBuffer.length || 0
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="challan-${id}-${monthKey}.pdf"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error("Month challan error:", err);
    return res.status(500).send("Server error");
  }
});
// =====================================================
// ✅ Single Admission: All Fee Challans Bulk
// URL: /dashboard/super/admission/:id/challan/bulk
// supports super_admin + any user having btnDetails permission
// =====================================================
app.get("/dashboard/super/admission/:id/challan/bulk", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send("Invalid id");

    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).send("Admission not found");

    if (!ensureAdmissionRouteAccess(user, perms, row)) {
      return res.status(403).send("Not allowed");
    }

    const billingYear = getBillingYearFromReq(req);
    const pendingRows = buildPendingRowsFromRow(row, billingYear);
    if (!pendingRows.length) {
      return res.status(400).send("No pending months found");
    }

    const full = dbGetAdmissionDetailsById(id, billingYear);
    if (!full) return res.status(404).send("Admission not found");

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const ins = db.prepare(`
      INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let made = 0;

    for (const p of pendingRows) {
     const fullWithHistory = attachPreviousSixMonthsToFull(full, p.monthKey);

const pdfBuffer = await makeMonthlyChallanPdf({
  full: fullWithHistory,
  monthKey: p.monthKey,
  bannerPath,
});

      const fname = `fee-bulk-${id}-${p.monthKey}-${Date.now()}.pdf`;
      const absPath = path.join(challanDir, fname);
      fs.writeFileSync(absPath, pdfBuffer);

      const relStored = toPosix(path.relative(uploadsDir, absPath));
      const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relStored}`;

      ins.run(
        id,
        `Fee Challan (${p.monthKey})`,
        relStored,
        fileUrl,
        "application/pdf",
        pdfBuffer.length || 0
      );

      made++;
    }

    req.session.flash = {
      type: "success",
      title: "Fee Challans",
      message: `Fee challans generated: ${made}. You can find them in Files.`,
    };

       emitAdmissionChanged(req, { type: "fee_bulk_generated", admissionId: id });
    return res.redirect(`/dashboard/super/admission/${id}`);
  } catch (err) {
    console.error("Single admission bulk fee challan error:", err);
    return res.status(500).send("Server error");
  }
});
// =====================================================
// ✅ Single Admission: All Paid Receipts Bulk
// URL: /dashboard/super/admission/:id/paid/bulk
// =====================================================
app.get("/dashboard/super/admission/:id/paid/bulk", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send("Invalid id");

    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).send("Admission not found");

    if (!ensureAdmissionRouteAccess(user, perms, row)) {
      return res.status(403).send("Not allowed");
    }

    const billingYear = getBillingYearFromReq(req);
    const paidMonths = getPaidMonthsFromRow(row, billingYear);
    if (!paidMonths.length) return res.status(400).send("No paid months found");

    const full = dbGetAdmissionDetailsById(id, billingYear);
    if (!full) return res.status(404).send("Admission not found");

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

   const pdfBuffer = await makeBulkPaidReceiptPdf({
  full,
  paidMonths,
  bannerPath,
});

const filename = `paid-bulk-${id}-${Date.now()}.pdf`;
const absPath = path.join(challanDir, filename);
fs.writeFileSync(absPath, pdfBuffer);

const relStored = toPosix(path.relative(uploadsDir, absPath));
const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relStored}`;

db.prepare(`
  INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  id,
  `All Paid Receipts`,
  relStored,
  fileUrl,
  "application/pdf",
  pdfBuffer.length || 0
);

emitAdmissionChanged(req, { type: "paid_bulk_generated", admissionId: id });

res.setHeader("Content-Type", "application/pdf");
res.setHeader("Content-Length", pdfBuffer.length);
res.setHeader("Content-Disposition", `attachment; filename="paid-bulk-${id}.pdf"`);
return res.send(pdfBuffer);
  } catch (err) {
    console.error("Single admission bulk paid challan error:", err);
    return res.status(500).send("Server error");
  }
});

// =====================================================
// ✅ Month PAID challan (Receipt) for single admission
// URL: /dashboard/super/admission/:id/paid/:monthKey
// =====================================================
app.get("/dashboard/super/admission/:id/paid/:monthKey", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const id = parseInt(req.params.id, 10);
    const monthKey = String(req.params.monthKey || "").toLowerCase().trim();

    if (!id) return res.status(400).send("Invalid id");
    if (!monthKey) return res.status(400).send("Invalid month");

    const rowBase = getActiveAdmissionById(id);
    if (!rowBase) return res.status(404).send("Admission not found");

    if (!ensureAdmissionRouteAccess(user, perms, rowBase)) {
      return res.status(403).send("Not allowed");
    }

    const billingYear = getBillingYearFromReq(req);
const full = dbGetAdmissionDetailsById(id, billingYear);
    if (!full) return res.status(404).send("Admission not found");

    const billArr = Array.isArray(full?.billing) ? full.billing : [];
    const row = billArr.find(b => String(b?.month || "").toLowerCase() === monthKey);
    const status = String(row?.status || "").trim().toLowerCase();

    if (status === "not admitted") {
      return res.status(400).send("Paid challan cannot be generated for a Not admitted month");
    }

    const amt = Number(row?.amount || 0);
    if (!amt || amt <= 0) {
      return res.status(400).send("No paid amount found for this month");
    }

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

    const pdfBuffer = await makeMonthlyPaidReceiptPdf({
      full,
      monthKey,
      bannerPath,
    });

    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
      console.log("pdfBuffer type:", typeof pdfBuffer, pdfBuffer?.constructor?.name);
      return res.status(500).send("PDF buffer is not a Buffer");
    }

    const head = pdfBuffer.subarray(0, 5).toString("utf8");
    if (head !== "%PDF-") {
      console.log("Not a PDF. First bytes:", pdfBuffer.subarray(0, 60).toString("utf8"));
      return res.status(500).send("Generated file is not a valid PDF");
    }

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const filename = `paid-challan-${id}-${monthKey}-${Date.now()}.pdf`;
    const absPath = path.join(challanDir, filename);

    fs.writeFileSync(absPath, pdfBuffer);

    const relStored = toPosix(path.relative(uploadsDir, absPath));
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relStored}`;

    db.prepare(`
      INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      `Paid Challan (${monthKey})`,
      relStored,
      fileUrl,
      "application/pdf",
      pdfBuffer.length || 0
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="paid-challan-${id}-${monthKey}.pdf"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error("Paid challan error:", err);
    return res.status(500).send("Server error");
  }
});

// =====================================================
// ✅ Pending months API (Family)
// =====================================================
app.get("/api/pending/family/:familyNumber", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const familyNumber = String(req.params.familyNumber || "").trim();
    if (!familyNumber) {
      return res.status(400).json({ success: false, message: "Invalid family number" });
    }

    const rows = getAccessibleFamilyRows(user, familyNumber);

   const billingYear = getBillingYearFromReq(req);

const result = rows.map((r) => ({
  admissionId: r.id,
  studentName: r.student_name || "",
  grade: r.grade || "",
  dept: r.dept || "",
  currency: r.currency_code || "",
  pending: buildPendingRowsFromRow(r, billingYear),
}));

    return res.json({
      success: true,
      mode: "family",
      familyNumber,
      students: result,
    });
  } catch (err) {
    console.error("GET /api/pending/family/:familyNumber error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// =====================================================
// ✅ One combined family challan
// URL: /dashboard/super/family/:familyNumber/challan
// =====================================================
app.get("/dashboard/super/family/:familyNumber/challan", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const familyNumber = String(req.params.familyNumber || "").trim();
    if (!familyNumber) return res.status(400).send("Invalid family number");

    const rows = getAccessibleFamilyIds(user, familyNumber);
    if (!rows || rows.length === 0) return res.status(404).send("No family admissions found");

   const billingYear = getBillingYearFromReq(req);

const admissionsFull = rows
  .map((r) => dbGetAdmissionDetailsById(r.id, billingYear))
  .filter(Boolean);

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

   const admissionsFullWithHistory = admissionsFull.map((adm) => {
 const billingRows = Array.isArray(adm?.billing) ? adm.billing : [];

const pendingMonths = billingRows.filter((b) => {
  const st = String(b?.status || "").trim().toLowerCase();
  return st === "partial payment" || st === "no payment" || st === "unpaid";
});

const latestPendingMonth =
  pendingMonths.length > 0
    ? String(pendingMonths[pendingMonths.length - 1]?.month || "").toLowerCase().trim()
    : "";

const latestAnyMonth =
  billingRows.length > 0
    ? String(billingRows[billingRows.length - 1]?.month || "").toLowerCase().trim()
    : "";

const currentMonthKey = latestPendingMonth || latestAnyMonth || "january";

  return attachPreviousSixMonthsToFull(adm, currentMonthKey);
});

const pdfBuffer = await makeFamilyChallanPdf({
  familyNumber,
  admissionsFull: admissionsFullWithHistory,
  bannerPath,
});

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const filename = `family-challan-${familyNumber}-${Date.now()}.pdf`;
    const absPath = path.join(challanDir, filename);
    fs.writeFileSync(absPath, pdfBuffer);

    const relStored = toPosix(path.relative(uploadsDir, absPath));
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relStored}`;

    const ins = db.prepare(`
      INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const adm of admissionsFull) {
      const admissionId = adm?.id || null;
      if (!admissionId) continue;

      ins.run(
        admissionId,
        `Family Challan (F.Code ${familyNumber})`,
        relStored,
        fileUrl,
        "application/pdf",
        pdfBuffer.length || 0
      );
    }

    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="family-challan-${familyNumber}.pdf"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error("Family challan error:", err);
    return res.status(500).send("Server error");
  }
});

// =====================================================
// ✅ Family Pending Challan Bulk
// URL: /dashboard/super/family/:familyNumber/challan/bulk
// =====================================================
app.get("/dashboard/super/family/:familyNumber/challan/bulk", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const familyNumber = String(req.params.familyNumber || "").trim();
    if (!familyNumber) return res.status(400).send("Invalid family number");

    const rows = getAccessibleFamilyIds(user, familyNumber);
    if (!rows.length) return res.status(404).send("No family admissions found");

    const billingYear = getBillingYearFromReq(req);
const admissionsFull = rows.map(r => dbGetAdmissionDetailsById(r.id, billingYear)).filter(Boolean);

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

   const admissionsFullWithHistory = admissionsFull.map((adm) => {
 const billingRows = Array.isArray(adm?.billing) ? adm.billing : [];

const pendingMonths = billingRows.filter((b) => {
  const st = String(b?.status || "").trim().toLowerCase();
  return st === "partial payment" || st === "no payment" || st === "unpaid";
});

const latestPendingMonth =
  pendingMonths.length > 0
    ? String(pendingMonths[pendingMonths.length - 1]?.month || "").toLowerCase().trim()
    : "";

const latestAnyMonth =
  billingRows.length > 0
    ? String(billingRows[billingRows.length - 1]?.month || "").toLowerCase().trim()
    : "";

const currentMonthKey = latestPendingMonth || latestAnyMonth || "january";

  return attachPreviousSixMonthsToFull(adm, currentMonthKey);
});

const pdfBuffer = await makeFamilyChallanPdf({
  familyNumber,
  admissionsFull: admissionsFullWithHistory,
  bannerPath,
  pendingOnly: true,
});
    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const filename = `family-pending-challan-${familyNumber}-${Date.now()}.pdf`;
    const absPath = path.join(challanDir, filename);
    fs.writeFileSync(absPath, pdfBuffer);

    const relStored = toPosix(path.relative(uploadsDir, absPath));
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relStored}`;

    const ins = db.prepare(`
      INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const a of admissionsFull) {
      ins.run(
        a.id,
        `All Pending Fee Challans (Family ${familyNumber})`,
        relStored,
        fileUrl,
        "application/pdf",
        pdfBuffer.length || 0
      );
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="family-pending-${familyNumber}.pdf"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error("Family bulk fee challan error:", err);
    return res.status(500).send("Server error");
  }
});

// =====================================================
// ✅ Family Paid Receipts Bulk
// URL: /dashboard/super/family/:familyNumber/paid/bulk
// =====================================================
app.get("/dashboard/super/family/:familyNumber/paid/bulk", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const familyNumber = String(req.params.familyNumber || "").trim();
    if (!familyNumber) return res.status(400).send("Invalid family number");

    const ids = getAccessibleFamilyIds(user, familyNumber);
    if (!ids.length) return res.status(404).send("No family admissions found");

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const ins = db.prepare(`
      INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let totalMade = 0;
    const billingYear = getBillingYearFromReq(req);

    for (const r of ids) {
      const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(r.id);
      if (!row) continue;

      if (!ensureAdmissionRouteAccess(user, perms, row)) continue;

      const paidMonths = getPaidMonthsFromRow(row, billingYear);
      if (!paidMonths.length) continue;

      const full = dbGetAdmissionDetailsById(r.id, billingYear);
      if (!full) continue;

      for (const pm of paidMonths) {
        const pdfBuffer = await makeMonthlyPaidReceiptPdf({
          full,
          monthKey: pm.monthKey,
          bannerPath,
        });

        const fname = `paid-bulk-${r.id}-${pm.monthKey}-${Date.now()}.pdf`;
        const absPath = path.join(challanDir, fname);
        fs.writeFileSync(absPath, pdfBuffer);

        const relStored = toPosix(path.relative(uploadsDir, absPath));
        const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relStored}`;

        ins.run(
          r.id,
          `All Paid Receipts (${pm.monthKey}) (Family ${familyNumber})`,
          relStored,
          fileUrl,
          "application/pdf",
          pdfBuffer.length || 0
        );

        totalMade++;
      }
    }

    return res.send(`Done. Paid receipts generated: ${totalMade}`);
  } catch (err) {
    console.error("Family bulk paid challan error:", err);
    return res.status(500).send("Server error");
  }
});

// =====================================================
// ✅ Single admission pending API
// =====================================================
app.get("/api/pending/admission/:id", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).json({ success: false, message: "Admission not found" });

    if (!ensureAdmissionRouteAccess(user, perms, row)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    return res.json({
      success: true,
      mode: "single",
      admissionId: row.id,
      studentName: row.student_name || "",
      grade: row.grade || "",
      dept: row.dept || "",
      currency: row.currency_code || "",
      pending: buildPendingRowsFromRow(row, getBillingYearFromReq(req)),
    });
  } catch (err) {
    console.error("GET /api/pending/admission/:id error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


app.post("/api/fee-collection/receive", requireLogin, requireSaveBilling, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const {
  admissionId,
  familyNumber,
  receivingAmount,
  verificationNumber,
  collectionAccount,
  receivingDate,
  note,
  year,
  selectedNotAdmittedMonths,
} = req.body || {};

    const billingYear = Number(year) || new Date().getFullYear();
    const amount = Number(receivingAmount || 0);
    const cleanFamilyNumber = String(familyNumber || "").trim();
    const cleanVerificationNumber = String(verificationNumber || "").trim();
    const cleanCollectionAccount = String(collectionAccount || "").trim();
    const cleanReceivingDate = String(receivingDate || "").trim();
    const cleanNote = String(note || "").trim();
    const cleanSelectedNotAdmittedMonths = Array.isArray(selectedNotAdmittedMonths)
  ? selectedNotAdmittedMonths
      .map((x) => ({
        admissionId: Number(x?.admissionId || 0),
        monthKey: String(x?.monthKey || "").trim().toLowerCase(),
      }))
      .filter((x) => x.admissionId > 0 && BILLING_MONTH_KEYS.includes(x.monthKey))
  : [];

    if (amount <= 0 && !cleanSelectedNotAdmittedMonths.length) {
  return res.status(400).json({
    success: false,
    message: "Receiving amount must be greater than zero or select month(s) for Not admitted",
  });
}

if (amount > 0 && !cleanVerificationNumber) {
  return res.status(400).json({
    success: false,
    message: "Verification number is required",
  });
}

if (amount > 0 && !cleanCollectionAccount) {
  return res.status(400).json({
    success: false,
    message: "Collection account is required",
  });
}
   if (amount > 0) {
  const allowedBank = db
    .prepare("SELECT id FROM bank_options WHERE label = ?")
    .get(cleanCollectionAccount);

  if (!allowedBank) {
    return res.status(400).json({
      success: false,
      message: "Invalid collection account selected",
    });
  }
}

    let targetRows = [];
    let mode = "single";

    if (cleanFamilyNumber) {
      targetRows = getAccessibleFamilyRows(user, cleanFamilyNumber);
      if (!targetRows.length) {
        return res.status(404).json({
          success: false,
          message: "No family admissions found",
        });
      }
      mode = "family";
    } else {
      const id = parseInt(admissionId, 10);
      if (!id) {
        return res.status(400).json({
          success: false,
          message: "admissionId or familyNumber required",
        });
      }

      const row = getActiveAdmissionById(id);
      if (!row) {
        return res.status(404).json({
          success: false,
          message: "Admission not found",
        });
      }

      if (!ensureAdmissionRouteAccess(user, perms, row)) {
        return res.status(403).json({
          success: false,
          message: "Not allowed",
        });
      }

      targetRows = [row];
    }

    const allPendingRows =
      mode === "family"
        ? buildFeeCollectionRowsForFamily(targetRows, billingYear)
        : buildFeeCollectionRowsForAdmission(targetRows[0], billingYear);

if (!allPendingRows.length && !cleanSelectedNotAdmittedMonths.length) {
  return res.status(400).json({
    success: false,
    message: "No pending dues found",
  });
}

    let remaining = amount;
    const applied = [];

    const rowsInOrder = [...targetRows].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));

    for (const row of rowsInOrder) {
  const selectedForThisRow = cleanSelectedNotAdmittedMonths.filter(
    (x) => Number(x.admissionId) === Number(row.id)
  );

  if (selectedForThisRow.length) {
    markSelectedMonthsNotAdmitted({
      row,
      billingYear,
      selectedMonths: selectedForThisRow,
    });
  }

  if (remaining <= 0) {
    applied.push({
      admissionId: row.id,
      studentName: row.student_name || "",
      usedAmount: 0,
      remainingAmount: remaining,
      touchedMonths: selectedForThisRow.map((x) => ({
        monthKey: x.monthKey,
        status: "Not admitted",
      })),
      paidUpto: "",
      receivedPayment: 0,
    });

    emitAdmissionChanged(req, {
      type: "fee_collection_received",
      admissionId: row.id,
      dept: row.dept || "",
    });

    continue;
  }

  const result = applyFeeCollectionToBilling({
    row,
    billingYear,
    receiveAmount: remaining,
    verificationNumber: cleanVerificationNumber,
    collectionAccount: cleanCollectionAccount,
    receivingDate: cleanReceivingDate,
    note: cleanNote,
    actorUser: user,
  });

      const used = Number(result.appliedAmount || 0);
      remaining = Number(result.remainingAmount || 0);

applied.push({
  admissionId: row.id,
  studentName: row.student_name || "",
  usedAmount: used,
  remainingAmount: remaining,
  touchedMonths: [
    ...selectedForThisRow.map((x) => ({
      monthKey: x.monthKey,
      status: "Not admitted",
    })),
    ...(result.touchedMonths || []),
  ],
  paidUpto: result.paidUpto || "",
  receivedPayment: result.receivedPayment || 0,
});

      emitAdmissionChanged(req, {
        type: "fee_collection_received",
        admissionId: row.id,
        dept: row.dept || "",
      });
    }

    const refreshedRows =
      mode === "family"
        ? getAccessibleFamilyRows(user, cleanFamilyNumber)
        : [getActiveAdmissionById(parseInt(admissionId, 10))].filter(Boolean);

    const refreshedFeeRows =
      mode === "family"
        ? buildFeeCollectionRowsForFamily(refreshedRows, billingYear)
        : buildFeeCollectionRowsForAdmission(refreshedRows[0], billingYear);

    const summary = summarizeFeeCollectionRows(refreshedRows, billingYear, currentMonthKey());

    return res.json({
      success: true,
      message: "Fee received successfully",
      mode,
      billingYear,
      totalInputAmount: amount,
      unallocatedAmount: remaining,
      applied,
      feeRows: refreshedFeeRows,
      summary,
    });
  } catch (err) {
    console.error("POST /api/fee-collection/receive error:", err);
    return res.status(500).json({
      success: false,
      message: "Fee collection failed",
    });
  }
});

// =====================================================
// ✅ Single admission JSON API
// =====================================================
app.get("/api/admissions/:id", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).json({ success: false, message: "Admission not found" });

    if (!ensureAdmissionRouteAccess(user, perms, row)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const billingYear = getBillingYearFromReq(req);
const full = dbGetAdmissionDetailsById(id, billingYear);
    if (!full) return res.status(404).json({ success: false, message: "Admission not found" });

    const safe = maskAdmissionMapped(full, perms);
    attachComputedMonthFees(row, safe, billingYear);

    return res.json({
      success: true,
      admission: safe,
    });
  } catch (err) {
    console.error("GET /api/admissions/:id error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
// ✅ Backward compatibility (optional)
app.get("/admissions/:id/details", requireLogin, (req, res) => {
  return res.redirect(`/dashboard/super/admission/${req.params.id}`);
});
// =========================
// ✅ current user + perms for frontend
app.get("/api/me", requireLogin, (req, res) => {
  const u = req.session.user;
  return res.json({
    success: true,
    user: { id: u?.id, name: u?.name, role: u?.role, dept: u?.dept, agentType: u?.agentType },
    perms: getPerm(u),
  });
});

// Simple JSON list (admissions.js table ke liye)
app.get("/api/admissions", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    let rows = [];

    if (user?.role === "super_admin") {
      rows = db.prepare(`
        SELECT *
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
      `).all();
      return res.json(rows);
    }

    if (!user?.dept) return res.json([]);

    rows = db
      .prepare(`
        SELECT *
        FROM admissions
        WHERE dept = ?
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
      `)
      .all(user.dept);

    const masked = rows.map((r) => maskAdmissionDbRow(r, perms));
    return res.json(masked);
  } catch (err) {
    console.error("GET /api/admissions error:", err);
    return res.status(500).json({ success: false, message: "DB select failed" });
  }
});

// ✅ NEW: External admissions API for n8n (API key se secure)
app.get("/api/admissions/external", checkApiKey, (req, res) => {
  try {
    const { dept } = req.query;

    let rows;
    if (dept) {
      rows = db
        .prepare(`
          SELECT *
          FROM admissions
          WHERE dept = ?
            AND COALESCE(is_deleted, 0) = 0
          ORDER BY id DESC
        `)
        .all(dept);
    } else {
      rows = db.prepare(`
        SELECT *
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
        ORDER BY id DESC
      `).all();
    }

    const data = rows.map(mapAdmissionRow);

    return res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    console.error("GET /api/admissions/external error:", err);
    return res
      .status(500)
      .json({ success: false, message: "DB select failed" });
  }
});

app.post("/api/admissions/invoice-status", checkApiKey, (req, res) => {
  try {
    const {
      admissionId,
      invoiceStatus,
      paidInvoiceStatus,
    } = req.body || {};

    const id = parseInt(admissionId, 10);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid admissionId" });
    }

    const row = getActiveAdmissionById(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    const now = new Date().toISOString();

    const hasInvoiceStatus = typeof invoiceStatus !== "undefined";
    const hasPaidInvoiceStatus = typeof paidInvoiceStatus !== "undefined";

    if (!hasInvoiceStatus && !hasPaidInvoiceStatus) {
      return res.status(400).json({
        success: false,
        message: "invoiceStatus or paidInvoiceStatus required"
      });
    }

    const updated = {
      id,
      admission_invoice_status: hasInvoiceStatus
        ? String(invoiceStatus || "").trim()
        : (row.admission_invoice_status || ""),
      admission_invoice_status_timestamp: hasInvoiceStatus
        ? now
        : (row.admission_invoice_status_timestamp || ""),
      admission_paid_invoice_status: hasPaidInvoiceStatus
        ? String(paidInvoiceStatus || "").trim()
        : (row.admission_paid_invoice_status || ""),
      admission_paid_invoice_status_timestamp: hasPaidInvoiceStatus
        ? now
        : (row.admission_paid_invoice_status_timestamp || ""),
    };

    db.prepare(`
      UPDATE admissions
         SET admission_invoice_status = @admission_invoice_status,
             admission_invoice_status_timestamp = @admission_invoice_status_timestamp,
             admission_paid_invoice_status = @admission_paid_invoice_status,
             admission_paid_invoice_status_timestamp = @admission_paid_invoice_status_timestamp
       WHERE id = @id
    `).run(updated);

    emitAdmissionChanged(req, {
      type: "invoice_status_update",
      admissionId: id,
      dept: row.dept,
    });

    return res.json({
      success: true,
      message: "Invoice status updated",
      data: updated,
    });
  } catch (err) {
    console.error("POST /api/admissions/invoice-status error:", err);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.post("/api/bulk-challan/create", requireLogin, requirePerm("btnUpdateRow"), (req, res) => {
  try {
    const user = req.session.user;

    const {
      month,
      feeType,
      className,
      section,
      year,
    } = req.body || {};

    const cleanFeeType = String(feeType || "").trim();
    const cleanClass = String(className || "").trim();
    const cleanSection = String(section || "All Sections").trim();
    const billingYear = Number(year);

    const monthKey = toMonthKey(month);

    if (!monthKey || !cleanFeeType || !cleanClass || !cleanSection || !billingYear) {
      return res.status(400).json({
        success: false,
        message: "Please select month, fee type, class, section and year",
      });
    }

    if (cleanFeeType !== "Monthly Fee") {
      return res.status(400).json({
        success: false,
        message: "Only Monthly Fee is supported for now",
      });
    }

    const matchedRows = getBulkChallanMatchingAdmissions({
      user,
      className: cleanClass,
      section: cleanSection,
    });

    if (!matchedRows.length) {
      return res.status(404).json({
        success: false,
        message: "No matching admissions found",
      });
    }

    const now = new Date().toISOString();
    let readyToSend = 0;
    let alreadyUpdated = 0;

    const updateStmt = db.prepare(`
      UPDATE admissions
      SET admission_invoice_status = ?,
          admission_invoice_status_timestamp = ?
      WHERE id = ?
    `);

    const runTxn = db.transaction((rows) => {
      for (const row of rows) {
        const already = isBillingMonthAlreadyUpdated(row, monthKey, billingYear);
        const nextStatus = already ? "Already Updated" : "Ready to Send";

        updateStmt.run(nextStatus, now, row.id);

        if (already) alreadyUpdated++;
        else readyToSend++;
      }
    });

    runTxn(matchedRows);

    logAudit("bulk_challan_status_created", user, {
      dept: user?.dept || null,
      details: {
        className: cleanClass,
        section: cleanSection,
        monthKey,
        year: billingYear,
        feeType: cleanFeeType,
        totalMatched: matchedRows.length,
        readyToSend,
        alreadyUpdated,
      },
    });

    emitAdmissionChanged(req, {
      type: "bulk_challan_status_created",
      dept: user?.dept || null,
      className: cleanClass,
      section: cleanSection,
      monthKey,
      year: billingYear,
    });

    return res.json({
      success: true,
      message: "Invoice status updated successfully",
      summary: {
        totalMatched: matchedRows.length,
        readyToSend,
        alreadyUpdated,
      },
    });
  } catch (err) {
    console.error("POST /api/bulk-challan/create error:", err);
    return res.status(500).json({
      success: false,
      message: "Invoice status update failed",
    });
  }
});

app.post("/api/bulk-challan/send-whatsapp", requireLogin, requireSendWhatsApp, async (req, res) => {
  try {
    const user = req.session.user;

    const {
      month,
      feeType,
      className,
      section,
      year,
    } = req.body || {};

    const cleanFeeType = String(feeType || "").trim();
    const cleanClass = String(className || "").trim();
    const cleanSection = String(section || "All Sections").trim();
    const billingYear = Number(year);

    const monthKey = toMonthKey(month);

    if (!monthKey || !cleanFeeType || !cleanClass || !cleanSection || !billingYear) {
      return res.status(400).json({
        success: false,
        message: "Please select month, fee type, class, section and year",
      });
    }

    if (!process.env.N8N_WHATSAPP_WEBHOOK_URL) {
      return res.status(500).json({
        success: false,
        message: "N8N webhook missing in .env",
      });
    }

    const matchedRows = getBulkChallanMatchingAdmissions({
      user,
      className: cleanClass,
      section: cleanSection,
    });

    if (!matchedRows.length) {
      return res.status(404).json({
        success: false,
        message: "No matching admissions found",
      });
    }

    const readyRows = matchedRows.filter(
      (row) => String(row.admission_invoice_status || "").trim() === "Ready to Send"
    );

    if (!readyRows.length) {
      return res.status(404).json({
        success: false,
        message: "No records ready to send",
      });
    }

    const payload = buildBulkWhatsappPayload({
      req,
      user,
      rows: readyRows,
      className: cleanClass,
      section: cleanSection,
      monthKey,
      year: billingYear,
      feeType: cleanFeeType,
    });

    const resp = await fetch(process.env.N8N_WHATSAPP_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();

    if (!resp.ok) {
      return res.status(500).json({
        success: false,
        message: "Failed to send invoices to WhatsApp",
        details: text,
      });
    }

    logAudit("bulk_challan_sent_to_whatsapp", user, {
      dept: user?.dept || null,
      details: {
        className: cleanClass,
        section: cleanSection,
        monthKey,
        year: billingYear,
        feeType: cleanFeeType,
        sentCount: readyRows.length,
      },
    });

    emitAdmissionChanged(req, {
      type: "bulk_challan_sent_to_whatsapp",
      dept: user?.dept || null,
      className: cleanClass,
      section: cleanSection,
      monthKey,
      year: billingYear,
      sentCount: readyRows.length,
    });

    return res.json({
      success: true,
      message: "Invoices sent to WhatsApp successfully",
      totalSent: readyRows.length,
      n8n: text,
    });
  } catch (err) {
    console.error("POST /api/bulk-challan/send-whatsapp error:", err);
    return res.status(500).json({
      success: false,
      message: "Send failed",
    });
  }
});

function getBaseUrl(req) {
  return (
    process.env.APP_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get("host")}/`
  ).replace(/\/+$/, "/");
}

async function generateMonthlyPaidReceiptForApi({
  req,
  admissionId,
  monthKey,
  billingYear,
  labelPrefix = "API Paid Invoice",
}) {
  const full = dbGetAdmissionDetailsById(admissionId, billingYear);
  if (!full) {
    throw new Error(`Admission details not found for id ${admissionId}`);
  }

  const billArr = Array.isArray(full?.billing) ? full.billing : [];
  const monthRow = billArr.find(
    (b) =>
      String(b?.month || "").toLowerCase().trim() ===
      String(monthKey || "").toLowerCase().trim()
  );

  if (!monthRow) {
    throw new Error(`No billing record found for month ${monthKey}`);
  }

  const monthStatus = String(monthRow?.status || "").trim().toLowerCase();
  if (monthStatus === "not admitted") {
    return {
      skipped: true,
      reason: "not_admitted_month",
      month: monthKey,
      year: billingYear,
    };
  }

  const amt = Number(monthRow?.amount || 0);
  if (!amt || amt <= 0) {
    return {
      skipped: true,
      reason: "no_paid_amount",
      month: monthKey,
      year: billingYear,
    };
  }

  const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

  const pdfBuffer = await makeMonthlyPaidReceiptPdf({
    full,
    monthKey,
    bannerPath,
  });

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error(`Invalid PDF buffer for paid invoice ${admissionId} month ${monthKey}`);
  }

  const head = pdfBuffer.subarray(0, 5).toString("utf8");
  if (head !== "%PDF-") {
    throw new Error(`Generated file is not a valid PDF for paid invoice ${admissionId} month ${monthKey}`);
  }

  const { year, month } = getYearMonthParts(new Date());
  const challanDir = path.join(uploadsDir, "challans", year, month);
  if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

  const filename = `api-paid-invoice-${admissionId}-${monthKey}-${Date.now()}.pdf`;
  const absPath = path.join(challanDir, filename);

  fs.writeFileSync(absPath, pdfBuffer);

  const relStored = toPosix(path.relative(uploadsDir, absPath));
  const fileUrl = `${getBaseUrl(req)}uploads/${relStored}`;

  const info = db.prepare(`
    INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    admissionId,
    `${labelPrefix} (${monthKey})`,
    relStored,
    fileUrl,
    "application/pdf",
    pdfBuffer.length || 0
  );

  return {
    skipped: false,
    uploadId: info.lastInsertRowid,
    month: monthKey,
    year: billingYear,
    fileUrl,
    storedName: relStored,
    mimeType: "application/pdf",
    size: pdfBuffer.length || 0,
  };
}



app.post("/api/invoices/create", checkApiKey, async (req, res) => {
  try {
    const {
      monthKey,
      year,
      familyNumber,
      registrationNumber,
    } = req.body || {};

    const cleanMonthKey = String(monthKey || "").trim().toLowerCase();
    const billingYear = Number(year);

    const cleanFamilyNumber = String(familyNumber || "").trim();
    const cleanRegistrationNumber = String(registrationNumber || "").trim();

    if (!BILLING_MONTH_KEYS.includes(cleanMonthKey)) {
      return res.status(400).json({
        success: false,
        message: "Invalid monthKey",
      });
    }

    if (!cleanMonthKey || !billingYear) {
      return res.status(400).json({
        success: false,
        message: "monthKey and year are required",
      });
    }

    if (!cleanFamilyNumber && !cleanRegistrationNumber) {
      return res.status(400).json({
        success: false,
        message: "familyNumber or registrationNumber is required",
      });
    }

    let rows = [];
    let mode = "";

    if (cleanFamilyNumber) {
      mode = "family";
      rows = db.prepare(`
       SELECT *
FROM admissions
WHERE TRIM(COALESCE(accounts_family_number, '')) = TRIM(?)
  AND COALESCE(is_deleted, 0) = 0
ORDER BY id DESC
      `).all(cleanFamilyNumber);
    } else {
      mode = "registration";
      rows = db.prepare(`
       SELECT *
FROM admissions
WHERE TRIM(COALESCE(accounts_registration_number, '')) = TRIM(?)
  AND COALESCE(is_deleted, 0) = 0
ORDER BY id DESC
      `).all(cleanRegistrationNumber);
    }

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "No matching admission found",
      });
    }

    const invoices = [];

    for (const row of rows) {
      try {
        const file = await generateMonthlyChallanForApi({
          req,
          admissionId: row.id,
          monthKey: cleanMonthKey,
          billingYear,
        });

        invoices.push({
          admissionId: row.id,
          studentName: row.student_name || "",
          fatherName: row.father_name || "",
          grade: row.grade || "",
          registrationNumber: row.accounts_registration_number || "",
          familyNumber: row.accounts_family_number || "",
          ...file,
        });
      } catch (err) {
        invoices.push({
          admissionId: row.id,
          studentName: row.student_name || "",
          registrationNumber: row.accounts_registration_number || "",
          familyNumber: row.accounts_family_number || "",
          error: String(err?.message || err),
        });
      }
    }

    return res.json({
      success: true,
      mode,
      monthKey: cleanMonthKey,
      year: billingYear,
      count: invoices.length,
      invoices,
    });
  } catch (err) {
    console.error("POST /api/invoices/create error:", err);
    return res.status(500).json({
      success: false,
      message: "Invoice creation failed",
    });
  }
});

app.post("/api/paid-invoices/create", checkApiKey, async (req, res) => {
  try {
    const {
      monthKey,
      year,
      familyNumber,
      registrationNumber,
    } = req.body || {};

    const cleanMonthKey = String(monthKey || "").trim().toLowerCase();
    const billingYear = Number(year);

    const cleanFamilyNumber = String(familyNumber || "").trim();
    const cleanRegistrationNumber = String(registrationNumber || "").trim();

    if (!BILLING_MONTH_KEYS.includes(cleanMonthKey)) {
      return res.status(400).json({
        success: false,
        message: "Invalid monthKey",
      });
    }

    if (!cleanMonthKey || !billingYear) {
      return res.status(400).json({
        success: false,
        message: "monthKey and year are required",
      });
    }

    if (!cleanFamilyNumber && !cleanRegistrationNumber) {
      return res.status(400).json({
        success: false,
        message: "familyNumber or registrationNumber is required",
      });
    }

    let rows = [];
    let mode = "";

    if (cleanFamilyNumber) {
      mode = "family";
      rows = db.prepare(`
        SELECT *
        FROM admissions
        WHERE TRIM(COALESCE(accounts_family_number, '')) = TRIM(?)
  AND COALESCE(is_deleted, 0) = 0
ORDER BY id DESC
      `).all(cleanFamilyNumber);
    } else {
      mode = "registration";
      rows = db.prepare(`
        SELECT *
        FROM admissions
        WHERE TRIM(COALESCE(accounts_registration_number, '')) = TRIM(?)
  AND COALESCE(is_deleted, 0) = 0
ORDER BY id DESC
      `).all(cleanRegistrationNumber);
    }

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "No matching admission found",
      });
    }

    const invoices = [];

    for (const row of rows) {
      try {
        const file = await generateMonthlyPaidReceiptForApi({
          req,
          admissionId: row.id,
          monthKey: cleanMonthKey,
          billingYear,
        });

        invoices.push({
          admissionId: row.id,
          studentName: row.student_name || "",
          fatherName: row.father_name || "",
          grade: row.grade || "",
          registrationNumber: row.accounts_registration_number || "",
          familyNumber: row.accounts_family_number || "",
          ...file,
        });
      } catch (err) {
        invoices.push({
          admissionId: row.id,
          studentName: row.student_name || "",
          registrationNumber: row.accounts_registration_number || "",
          familyNumber: row.accounts_family_number || "",
          error: String(err?.message || err),
        });
      }
    }

    return res.json({
      success: true,
      mode,
      monthKey: cleanMonthKey,
      year: billingYear,
      count: invoices.length,
      invoices,
    });
  } catch (err) {
    console.error("POST /api/paid-invoices/create error:", err);
    return res.status(500).json({
      success: false,
      message: "Paid invoice creation failed",
    });
  }
});

app.post("/api/admissions/update-row", checkApiKey, (req, res) => {
  try {
    const {
      columnToMatchOn,
      valueToMatch,
      valuesToSend
    } = req.body || {};

    const ALLOWED_MATCH_COLUMNS = [
      "id",
      "accounts_verification_number",
      "accounts_registration_number",
      "accounts_family_number",
      "phone",
      "guardian_whatsapp",
      "student_name",
      "father_name",
      "dept"
    ];

    const ALLOWED_UPDATE_COLUMNS = [
      "admission_invoice_status",
      "admission_invoice_status_timestamp",
      "admission_paid_invoice_status",
      "admission_paid_invoice_status_timestamp",
      "accounts_payment_status",
      "accounts_paid_upto",
      "accounts_verification_number",
      "accounts_registration_number",
      "accounts_family_number",
      "admission_registration_fee",
      "admission_fees",
      "admission_month",
      "admission_total_fees",
      "admission_pending_dues",
      "admission_total_paid",
      "currency_code",
      "status",
      "feeStatus"
    ];

    const matchCol = String(columnToMatchOn || "").trim();
    const matchVal = String(valueToMatch ?? "").trim();

    if (!matchCol || !ALLOWED_MATCH_COLUMNS.includes(matchCol)) {
      return res.status(400).json({
        success: false,
        message: "Invalid columnToMatchOn"
      });
    }

    if (matchVal === "") {
      return res.status(400).json({
        success: false,
        message: "valueToMatch is required"
      });
    }

    if (!valuesToSend || typeof valuesToSend !== "object" || Array.isArray(valuesToSend)) {
      return res.status(400).json({
        success: false,
        message: "valuesToSend must be an object"
      });
    }

    const cleanUpdates = {};
    for (const [key, value] of Object.entries(valuesToSend)) {
      const col = String(key || "").trim();
      if (!ALLOWED_UPDATE_COLUMNS.includes(col)) continue;
      cleanUpdates[col] = value == null ? "" : String(value);
    }

    if (!Object.keys(cleanUpdates).length) {
      return res.status(400).json({
        success: false,
        message: "No valid columns found in valuesToSend"
      });
    }

    const row = db
      .prepare(`SELECT * FROM admissions WHERE ${matchCol} = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1`)
      .get(matchVal);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "No matching admission found"
      });
    }

    const now = new Date().toISOString();

    if (Object.prototype.hasOwnProperty.call(cleanUpdates, "admission_invoice_status")) {
      cleanUpdates.admission_invoice_status_timestamp = now;
    }

    if (Object.prototype.hasOwnProperty.call(cleanUpdates, "admission_paid_invoice_status")) {
      cleanUpdates.admission_paid_invoice_status_timestamp = now;
    }

    const setClause = Object.keys(cleanUpdates)
      .map((col) => `${col} = @${col}`)
      .join(", ");

    const params = {
      id: row.id,
      ...cleanUpdates
    };

    db.prepare(`
      UPDATE admissions
      SET ${setClause}
      WHERE id = @id
    `).run(params);

    const updatedRow = db.prepare("SELECT * FROM admissions WHERE id = ?").get(row.id);

    emitAdmissionChanged(req, {
      type: "admission_update_row",
      admissionId: row.id,
      dept: row.dept,
      matchColumn: matchCol
    });

    return res.json({
      success: true,
      message: "Row updated successfully",
      matchedBy: {
        column: matchCol,
        value: matchVal
      },
      updatedColumns: Object.keys(cleanUpdates),
      data: updatedRow
    });
  } catch (err) {
    console.error("POST /api/admissions/update-row error:", err);
    return res.status(500).json({
      success: false,
      message: "DB error"
    });
  }
});

app.delete("/api/admissions/:id", requireLogin, requireDeleteAdmissions, (req, res) => {
  try {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid admission id" });
    }

    const row = getActiveAdmissionById(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    if (!getDeleteAdmissionAccess(user, row)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const now = new Date().toISOString();
    const actorName = String(user?.name || "").trim();
    const actorId = Number(user?.id || 0) || null;

    db.prepare(`
      UPDATE admissions
      SET is_deleted = 1,
          deleted_at = ?,
          deleted_by = ?,
          deleted_by_id = ?
      WHERE id = ?
        AND COALESCE(is_deleted, 0) = 0
    `).run(now, actorName, actorId, id);

    logAudit("admission_deleted", user, {
      dept: row.dept || "",
      details: {
        admissionId: row.id,
        studentName: row.student_name || "",
        fatherName: row.father_name || "",
        registrationNumber: row.accounts_registration_number || "",
        familyNumber: row.accounts_family_number || "",
        mode: "single",
      },
    });

    emitAdmissionChanged(req, {
      type: "admission_deleted",
      admissionId: row.id,
      dept: row.dept || "",
      mode: "single",
    });

    return res.json({
      success: true,
      message: "Admission deleted successfully",
      deletedId: row.id,
    });
  } catch (err) {
    console.error("DELETE /api/admissions/:id error:", err);
    return res.status(500).json({ success: false, message: "Delete failed" });
  }
});

app.post("/api/admissions/bulk-delete", requireLogin, requireDeleteAdmissions, (req, res) => {
  try {
    const user = req.session.user;
    const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];

    const ids = [...new Set(
      idsRaw
        .map((x) => parseInt(x, 10))
        .filter((x) => Number.isInteger(x) && x > 0)
    )];

    if (!ids.length) {
      return res.status(400).json({ success: false, message: "No admissions selected" });
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT *
      FROM admissions
      WHERE id IN (${placeholders})
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY id DESC
    `).all(...ids);

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "No active admissions found" });
    }

    const allowedRows = rows.filter((row) => getDeleteAdmissionAccess(user, row));

    if (!allowedRows.length) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const now = new Date().toISOString();
    const actorName = String(user?.name || "").trim();
    const actorId = Number(user?.id || 0) || null;

    const deleteTxn = db.transaction((items) => {
      const stmt = db.prepare(`
        UPDATE admissions
        SET is_deleted = 1,
            deleted_at = ?,
            deleted_by = ?,
            deleted_by_id = ?
        WHERE id = ?
          AND COALESCE(is_deleted, 0) = 0
      `);

      for (const item of items) {
        stmt.run(now, actorName, actorId, item.id);
      }
    });

    deleteTxn(allowedRows);

    logAudit("admission_bulk_deleted", user, {
      dept: user?.dept || null,
      details: {
        mode: "bulk",
        totalRequested: ids.length,
        totalDeleted: allowedRows.length,
        admissionIds: allowedRows.map((x) => x.id),
      },
    });

    emitAdmissionChanged(req, {
      type: "admission_deleted",
      mode: "bulk",
      deletedIds: allowedRows.map((x) => x.id),
      count: allowedRows.length,
      dept: user?.dept || null,
    });

    return res.json({
      success: true,
      message: "Admissions deleted successfully",
      totalDeleted: allowedRows.length,
      deletedIds: allowedRows.map((x) => x.id),
    });
  } catch (err) {
    console.error("POST /api/admissions/bulk-delete error:", err);
    return res.status(500).json({ success: false, message: "Bulk delete failed" });
  }
});

/* ✅ WhatsApp Options APIs
   - GET: allow super_admin OR canSendWhatsApp
   - POST/DELETE: super_admin only
*/
app.get("/api/whatsapp/options", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (user?.role !== "super_admin" && !perms.btnWhatsApp) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const rows = db
      .prepare(
        "SELECT id, opt_key, label, is_custom FROM whatsapp_options ORDER BY id ASC"
      )
      .all();
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("GET /api/whatsapp/options error:", err);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.post("/api/whatsapp/options", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const { label } = req.body || {};
    const cleanLabel = String(label || "").trim();
    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    let key = cleanLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!key) key = "custom_option";

    const exists = db
      .prepare("SELECT id FROM whatsapp_options WHERE opt_key = ?")
      .get(key);
    if (exists) {
      key = `${key}_${Date.now()}`;
    }

    const info = db
      .prepare("INSERT INTO whatsapp_options (opt_key, label, is_custom) VALUES (?, ?, 1)")
      .run(key, cleanLabel);

    return res.json({
      success: true,
      data: { id: info.lastInsertRowid, opt_key: key, label: cleanLabel, is_custom: 1 },
    });
  } catch (err) {
    console.error("POST /api/whatsapp/options error:", err);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.delete("/api/whatsapp/options/:id", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const row = db.prepare("SELECT * FROM whatsapp_options WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ success: false, message: "Not found" });

    if (!row.is_custom) {
      return res.status(400).json({ success: false, message: "Default option cannot be deleted" });
    }

    db.prepare("DELETE FROM whatsapp_options WHERE id = ?").run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/whatsapp/options/:id error:", err);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});
/* =========================
   ✅ STATUS & PAYMENT STATUS OPTIONS APIs
   Tables:
   - status_options
   - payment_status_options
========================= */

// ✅ GET: allow super_admin OR users who can update rows (so they can see dropdown)
app.get("/api/options/status", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (user?.role !== "super_admin" && !perms.btnUpdateRow) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const data = getOptions("status_options");
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.get("/api/options/fee-status", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (user?.role !== "super_admin" && !perms.btnUpdateRow) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const data = getOptions("payment_status_options");
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

// ✅ POST/DELETE: super_admin only (manage dropdown list)
app.post("/api/options/status", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const { label, color } = req.body || {};
    const cleanLabel = String(label || "").trim();
    const cleanColor = String(color || "").trim();

    if (!cleanLabel) return res.status(400).json({ success:false, message:"Label required" });

    let key = cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!key) key = `status_${Date.now()}`;

   const exists = db
  .prepare("SELECT id FROM status_options WHERE opt_key = ? OR label = ?")
  .get(key, cleanLabel);

if (exists) {
  return res.status(400).json({
    success: false,
    message: "Option already exists"
  });
}
    const info = db.prepare(
      "INSERT INTO status_options (opt_key, label, color, is_custom) VALUES (?, ?, ?, 1)"
    ).run(key, cleanLabel, cleanColor);

    logAudit("status_option_added", req.session.user, {
      details: { id: info.lastInsertRowid, opt_key: key, label: cleanLabel, color: cleanColor }
    });

    return res.json({ success:true, data:{ id: info.lastInsertRowid, opt_key:key, label:cleanLabel, color:cleanColor, is_custom:1 }});
  } catch (e) {
    return res.status(500).json({ success:false, message:"DB error" });
  }
});

app.patch("/api/options/status/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, color } = req.body || {};

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = db.prepare("SELECT * FROM status_options WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    // default options permanent
    if (!row.is_custom) {
      return res.status(400).json({
        success: false,
        message: "Default option cannot be edited"
      });
    }

    const cleanLabel = String(label || row.label || "").trim();
    const cleanColor = String(color || row.color || "#64748b").trim() || "#64748b";

    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    const dup = db
      .prepare("SELECT id FROM status_options WHERE label = ? AND id != ?")
      .get(cleanLabel, id);

    if (dup) {
      return res.status(400).json({
        success: false,
        message: "Option already exists"
      });
    }

    db.prepare(`
      UPDATE status_options
      SET opt_key = ?, label = ?, color = ?
      WHERE id = ?
    `).run(cleanLabel, cleanLabel, cleanColor, id);

    logAudit("status_option_updated", req.session.user, {
      details: { id, opt_key: cleanLabel, label: cleanLabel, color: cleanColor }
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/options/status/:id error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.delete("/api/options/status/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success:false, message:"Invalid id" });

    const row = db.prepare("SELECT * FROM status_options WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ success:false, message:"Not found" });
    if (!row.is_custom) return res.status(400).json({ success:false, message:"Default option cannot be deleted" });

    db.prepare("DELETE FROM status_options WHERE id = ?").run(id);

    logAudit("status_option_deleted", req.session.user, {
      details: { id, opt_key: row.opt_key, label: row.label }
    });

    return res.json({ success:true });
  } catch (e) {
    return res.status(500).json({ success:false, message:"DB error" });
  }
});

app.post("/api/options/fee-status", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const { label, color } = req.body || {};
    const cleanLabel = String(label || "").trim();
    const cleanColor = String(color || "").trim();

    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    let key = cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!key) key = `fee_status_${Date.now()}`;

    const exists = db
  .prepare("SELECT id FROM payment_status_options WHERE opt_key = ? OR label = ?")
  .get(key, cleanLabel);

if (exists) {
  return res.status(400).json({
    success: false,
    message: "Option already exists"
  });
}

    const info = db.prepare(
      "INSERT INTO payment_status_options (opt_key, label, color, is_custom) VALUES (?, ?, ?, 1)"
    ).run(key, cleanLabel, cleanColor);

    logAudit("fee_status_option_added", req.session.user, {
      details: {
        id: info.lastInsertRowid,
        opt_key: key,
        label: cleanLabel,
        color: cleanColor
      }
    });

    return res.json({
      success: true,
      data: {
        id: info.lastInsertRowid,
        opt_key: key,
        label: cleanLabel,
        color: cleanColor,
        is_custom: 1
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.patch("/api/options/fee-status/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, color } = req.body || {};

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = db.prepare("SELECT * FROM payment_status_options WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    // default options permanent
    if (!row.is_custom) {
      return res.status(400).json({
        success: false,
        message: "Default option cannot be edited"
      });
    }

    const cleanLabel = String(label || row.label || "").trim();
    const cleanColor = String(color || row.color || "#64748b").trim() || "#64748b";

    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    const dup = db
      .prepare("SELECT id FROM payment_status_options WHERE label = ? AND id != ?")
      .get(cleanLabel, id);

    if (dup) {
      return res.status(400).json({
        success: false,
        message: "Option already exists"
      });
    }

    db.prepare(`
      UPDATE payment_status_options
      SET opt_key = ?, label = ?, color = ?
      WHERE id = ?
    `).run(cleanLabel, cleanLabel, cleanColor, id);

    logAudit("fee_status_option_updated", req.session.user, {
      details: { id, opt_key: cleanLabel, label: cleanLabel, color: cleanColor }
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/options/fee-status/:id error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.delete("/api/options/fee-status/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const row = db.prepare("SELECT * FROM payment_status_options WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ success: false, message: "Not found" });
    if (!row.is_custom) {
      return res.status(400).json({ success: false, message: "Default option cannot be deleted" });
    }

   db.prepare("DELETE FROM payment_status_options WHERE id = ?").run(id);

    logAudit("fee_status_option_deleted", req.session.user, {
      details: { id, opt_key: row.opt_key, label: row.label }
    });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.get("/api/options/billing-status", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (user?.role !== "super_admin" && !perms.btnBilling) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const data = getOptions("billing_status_options");
    return res.json({ success: true, data });
  } catch (e) {
    console.error("GET /api/options/billing-status error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

/* =========================
   ✅ CURRENCY OPTIONS APIs
========================= */

app.get("/api/options/currency", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (user?.role !== "super_admin" && !perms.btnUpdateRow) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const data = getCurrencyOptions();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("GET /api/options/currency error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.post("/api/options/currency", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const { label } = req.body || {};
    const cleanLabel = String(label || "").trim().toUpperCase();

    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    let optKey = cleanLabel;

    const exists = db
      .prepare("SELECT id FROM currency_options WHERE opt_key = ? OR label = ?")
      .get(optKey, cleanLabel);

    if (exists) {
      return res.status(400).json({ success: false, message: "Option already exists" });
    }

    const info = db
      .prepare(`
        INSERT INTO currency_options (opt_key, label, is_custom)
        VALUES (?, ?, 1)
      `)
      .run(optKey, cleanLabel);

    logAudit("currency_option_added", req.session.user, {
      details: {
        id: info.lastInsertRowid,
        opt_key: optKey,
        label: cleanLabel
      }
    });

    return res.json({
      success: true,
      data: {
        id: info.lastInsertRowid,
        opt_key: optKey,
        label: cleanLabel,
        value: cleanLabel,
        is_custom: 1,
      },
    });
  } catch (e) {
    console.error("POST /api/options/currency error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.delete("/api/options/currency/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = db.prepare("SELECT * FROM currency_options WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Option not found" });
    }

    if (!row.is_custom) {
      return res.status(400).json({ success: false, message: "Default option cannot be deleted" });
    }

    db.prepare("DELETE FROM currency_options WHERE id = ?").run(id);

    logAudit("currency_option_deleted", req.session.user, {
      details: { id, opt_key: row.opt_key, label: row.label }
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/options/currency/:id error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

/* =========================
   ✅ BANK OPTIONS APIs
========================= */

app.get("/api/options/bank", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (user?.role !== "super_admin" && !perms.btnBilling) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const data = getBankOptions();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("GET /api/options/bank error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.post("/api/options/bank", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const { label } = req.body || {};
    const cleanLabel = String(label || "").trim();

    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    const optKey = cleanLabel;

    const exists = db
      .prepare("SELECT id FROM bank_options WHERE opt_key = ? OR label = ?")
      .get(optKey, cleanLabel);

    if (exists) {
      return res.status(400).json({ success: false, message: "Option already exists" });
    }

    const info = db
      .prepare(`
        INSERT INTO bank_options (opt_key, label, is_custom)
        VALUES (?, ?, 1)
      `)
      .run(optKey, cleanLabel);

    logAudit("bank_option_added", req.session.user, {
      details: {
        id: info.lastInsertRowid,
        opt_key: optKey,
        label: cleanLabel
      }
    });

    return res.json({
      success: true,
      data: {
        id: info.lastInsertRowid,
        opt_key: optKey,
        label: cleanLabel,
        value: cleanLabel,
        is_custom: 1,
      },
    });
  } catch (e) {
    console.error("POST /api/options/bank error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.delete("/api/options/bank/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = db.prepare("SELECT * FROM bank_options WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Option not found" });
    }

    if (!row.is_custom) {
      return res.status(400).json({ success: false, message: "Default option cannot be deleted" });
    }

    db.prepare("DELETE FROM bank_options WHERE id = ?").run(id);

    logAudit("bank_option_deleted", req.session.user, {
      details: { id, opt_key: row.opt_key, label: row.label }
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/options/bank/:id error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.post("/api/options/billing-status", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const { label, color } = req.body || {};

    const cleanLabel = String(label || "").trim();
    const cleanColor = String(color || "#64748b").trim() || "#64748b";

    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    let optKey = cleanLabel;

    const exists = db
      .prepare("SELECT id FROM billing_status_options WHERE opt_key = ? OR label = ?")
      .get(optKey, cleanLabel);

    if (exists) {
      return res.status(400).json({ success: false, message: "Option already exists" });
    }

    const info = db
      .prepare(`
        INSERT INTO billing_status_options (opt_key, label, color, is_custom)
        VALUES (?, ?, ?, 1)
      `)
      .run(optKey, cleanLabel, cleanColor);
     
    logAudit("billing_status_option_added", req.session.user, {
  details: {
    id: info.lastInsertRowid,
    opt_key: optKey,
    label: cleanLabel,
    color: cleanColor
  }
});

    return res.json({
      success: true,
      data: {
        id: info.lastInsertRowid,
        opt_key: optKey,
        label: cleanLabel,
        value: cleanLabel,
        color: cleanColor,
        is_custom: 1,
      },
    });
  } catch (e) {
    console.error("POST /api/options/billing-status error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.patch("/api/options/billing-status/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, color } = req.body || {};

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = db.prepare("SELECT * FROM billing_status_options WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Option not found" });
    }
   
    if (!row.is_custom) {
  return res.status(400).json({
    success: false,
    message: "Default option cannot be edited"
    });
   }

    const cleanLabel = String(label || row.label || "").trim();
    const cleanColor = String(color || row.color || "#64748b").trim() || "#64748b";

    if (!cleanLabel) {
      return res.status(400).json({ success: false, message: "Label required" });
    }

    const dup = db
      .prepare("SELECT id FROM billing_status_options WHERE label = ? AND id != ?")
      .get(cleanLabel, id);

    if (dup) {
      return res.status(400).json({ success: false, message: "Option already exists" });
    }

   db.prepare(`
  UPDATE billing_status_options
  SET opt_key = ?, label = ?, color = ?
  WHERE id = ?
`).run(cleanLabel, cleanLabel, cleanColor, id);

logAudit("billing_status_option_updated", req.session.user, {
  details: { id, opt_key: cleanLabel, label: cleanLabel, color: cleanColor }
});

return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/options/billing-status/:id error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});

app.delete("/api/options/billing-status/:id", requireLogin, requireManageDropdownOptions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const row = db.prepare("SELECT * FROM billing_status_options WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Option not found" });
    }

    if (!row.is_custom) {
      return res.status(400).json({ success: false, message: "Default option cannot be deleted" });
    }

  db.prepare("DELETE FROM billing_status_options WHERE id = ?").run(id);

logAudit("billing_status_option_deleted", req.session.user, {
  details: { id, opt_key: row.opt_key, label: row.label }
});

return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/options/billing-status/:id error:", e);
    return res.status(500).json({ success: false, message: "DB error" });
  }
});
/* ✅ WhatsApp -> n8n webhook
   - allow super_admin OR canSendWhatsApp
*/
app.post("/api/whatsapp/send", requireLogin, requireSendWhatsApp, async (req, res) => {
  let id = null;
  let actionsSafe = [];
  let manualSafe = "";
  let user = null;

  try {
    const { admissionId, actions = [], manualMessage = "" } = req.body || {};
    id = parseInt(admissionId, 10);
    actionsSafe = Array.isArray(actions) ? actions : [];
    manualSafe = String(manualMessage || "");

    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid admissionId" });
    }

    const row = getActiveAdmissionById(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    user = req.session.user;

    // ✅ non-super dept restriction
    if (user?.role !== "super_admin") {
      if (!user?.dept || row.dept !== user.dept) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }

    if (!process.env.N8N_WHATSAPP_WEBHOOK_URL) {
      return res.status(500).json({ success: false, message: "N8N webhook missing in .env" });
    }

    const payload = {
      event: "whatsapp_send_request",
      ts: new Date().toISOString(),
      triggeredBy: {
        id: user?.id || null,
        name: user?.name || null,
        role: user?.role || null,
        dept: user?.dept || null,
      },
      admissionId: id,
      admission: row,
      pipeline: mapAdmissionRow(row),
      actions: actionsSafe,
      manualMessage: manualSafe,
    };

    const resp = await fetch(process.env.N8N_WHATSAPP_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();

    const waLog = {
      updatedAt: new Date().toISOString(),
      status: resp.ok ? "sent_to_n8n" : "failed",
      admissionId: id,
      actions: actionsSafe,
      manualMessage: manualSafe,
      triggeredBy: {
        id: user?.id || null,
        name: user?.name || null,
        role: user?.role || null,
        dept: user?.dept || null,
      },
      n8n: {
        httpStatus: resp.status,
        response: text,
      },
    };

    try {
      db.prepare("UPDATE admissions SET whatsapp = ? WHERE id = ?").run(
        JSON.stringify(waLog),
        id
      );
    } catch (dbErr) {
      console.error("Failed to save whatsapp log in DB:", dbErr);
    }

    if (!resp.ok) {
      return res.status(500).json({
        success: false,
        message: "n8n webhook failed",
        details: text,
      });
    }

    return res.json({ success: true, message: "Sent to n8n", n8n: text });
  } catch (err) {
    console.error("POST /api/whatsapp/send error:", err);

    try {
      if (id) {
        const waLogFail = {
          updatedAt: new Date().toISOString(),
          status: "failed",
          admissionId: id,
          actions: actionsSafe,
          manualMessage: manualSafe,
          triggeredBy: {
            id: user?.id || null,
            name: user?.name || null,
            role: user?.role || null,
            dept: user?.dept || null,
          },
          error: String(err?.message || err),
        };
        db.prepare("UPDATE admissions SET whatsapp = ? WHERE id = ?").run(
          JSON.stringify(waLogFail),
          id
        );
      }
    } catch (dbErr2) {
      console.error("Failed to save whatsapp fail log in DB:", dbErr2);
    }

    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ==================== DB SETTINGS ROUTES ====================

// Super Admin only page
app.get("/db-settings", requireLogin, requireSuperAdmin, (req, res) => {
  return res.render("db-settings", {
    user: req.session.user,
    perms: getPerm(req.session.user),
    pageTitle: "DB Settings",
  });
});

// Export admissions CSV
app.get("/db-settings/export/admissions", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const columns = getAdmissionsTableColumns();
    if (!columns.length) {
      return res.status(500).send("Admissions table columns not found");
    }

    const rows = db.prepare(`
  SELECT *
  FROM admissions
  WHERE COALESCE(is_deleted, 0) = 0
  ORDER BY id ASC
`).all();
    const csv = rowsToCsv(rows, columns);

    const fileName = `admissions-backup-${Date.now()}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    return res.send(csv);
  } catch (err) {
    console.error("GET /db-settings/export/admissions error:", err);
    return res.status(500).send("CSV export failed");
  }
});

// Import admissions CSV
app.post(
  "/db-settings/import/admissions",
  requireLogin,
  requireSuperAdmin,
  upload.single("csvFile"),
  (req, res) => {
    try {
      if (!req.file) {
        req.session.flash = {
          type: "danger",
          title: "Import failed",
          message: "Please select a CSV file first.",
        };
        return res.redirect("/db-settings");
      }

      const absPath = req.file.path;
      const csvText = fs.readFileSync(absPath, "utf8");

      const parsedRows = parseCsv(csvText, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
        trim: true,
      });

      const allowedColumns = getAdmissionsTableColumns().filter((c) => c !== "id");
      if (!allowedColumns.length) {
        safeUnlink(absPath);
        req.session.flash = {
          type: "danger",
          title: "Import failed",
          message: "Admissions table structure not found.",
        };
        return res.redirect("/db-settings");
      }

      let inserted = 0;
      let skipped = 0;
      let failed = 0;

      const insertMany = db.transaction((rows) => {
        for (const raw of rows) {
          try {
            const cleanRow = buildSafeAdmissionImportRow(raw, allowedColumns);

            // minimum safety
            if (!String(cleanRow.student_name || "").trim()) {
              skipped++;
              continue;
            }

            const regNo = String(cleanRow.accounts_registration_number || "").trim();

let deletedMatch = null;
if (regNo) {
  deletedMatch = db.prepare(`
    SELECT id
    FROM admissions
    WHERE TRIM(COALESCE(accounts_registration_number, '')) = TRIM(?)
      AND COALESCE(is_deleted, 0) = 1
    LIMIT 1
  `).get(regNo);
}

if (deletedMatch) {
  const cols = Object.keys(cleanRow).filter((k) => allowedColumns.includes(k));
  if (!cols.length) {
    skipped++;
    continue;
  }

  const setClause = cols.map((c) => `${c} = @${c}`).join(", ");

  db.prepare(`
    UPDATE admissions
    SET ${setClause},
        is_deleted = 0,
        deleted_at = NULL,
        deleted_by = NULL,
        deleted_by_id = NULL
    WHERE id = @id
  `).run({
    id: deletedMatch.id,
    ...cleanRow,
  });

  inserted++;
  continue;
}

const duplicate = findExistingAdmissionForImport(cleanRow);
if (duplicate) {
  skipped++;
  continue;
}

const cols = Object.keys(cleanRow).filter((k) => allowedColumns.includes(k));
if (!cols.length) {
  skipped++;
  continue;
}

const placeholders = cols.map((c) => `@${c}`).join(", ");
const sql = `
  INSERT INTO admissions (${cols.join(", ")})
  VALUES (${placeholders})
`;

db.prepare(sql).run(cleanRow);
inserted++;
          } catch (rowErr) {
            failed++;
            console.error("CSV row import error:", rowErr.message);
          }
        }
      });

      insertMany(parsedRows);

      safeUnlink(absPath);

      req.session.flash = {
        type: "success",
        title: "CSV import completed",
        message: `Imported: ${inserted}, Skipped duplicates: ${skipped}, Failed: ${failed}`,
      };

      return res.redirect("/db-settings");
    } catch (err) {
      console.error("POST /db-settings/import/admissions error:", err);

      if (req.file?.path) safeUnlink(req.file.path);

      req.session.flash = {
        type: "danger",
        title: "Import failed",
        message: "CSV import failed. Please check file format.",
      };

      return res.redirect("/db-settings");
    }
  }
);


// ==================== MULTER ERROR HANDLER ====================
app.use((err, req, res, next) => {
  if (err && err.message === "File type not allowed") {
    req.session.flash = {
      type: "danger",
      title: "Upload failed",
      message: "Only CSV file is allowed for this import.",
    };
    return res.redirect("/db-settings");
  }

  if (err && err.code === "LIMIT_FILE_SIZE") {
    req.session.flash = {
      type: "danger",
      title: "Upload failed",
      message: "File size is too large.",
    };
    return res.redirect("/db-settings");
  }

  return next(err);
});

/* ==================== Auth Routes ==================== */

// Login page (with role boxes)
app.get("/login", (req, res) => {
  const type = req.query.type || null;
  res.render("login", { error: null, type });
});

// Handle login submit
app.post("/login", async (req, res) => {
  const { email, password, loginType } = req.body;

  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!row) {
    return res.render("login", {
      error: "Invalid email or password",
      type: loginType || null,
    });
  }

  const passwordOk = await bcrypt.compare(password, row.password_hash);
  if (!passwordOk) {
    return res.render("login", {
      error: "Invalid email or password",
      type: loginType || null,
    });
  }

  const user = mapUserRow(row);

  // Role restriction per tab
  if (loginType === "super" && user.role !== "super_admin") {
    return res.render("login", { error: "only Super Admin login here.", type: "super" });
  }
  if (loginType === "admin" && user.role !== "admin") {
    return res.render("login", { error: "only Admins login here.", type: "admin" });
  }
  if (loginType === "sub_agent" && user.role !== "sub_agent") {
    return res.render("login", { error: "only Sub Agents login here.", type: "sub_agent" });
  }
  if (loginType === "agent" && user.role !== "agent") {
    return res.render("login", { error: "only Agents login here.", type: "agent" });
  }

  // ✅ update notice
  if (user.updateNoticeUnread) {
    const byName = user.lastUpdatedBy || "an administrator";

    const roleMap = {
      super_admin: "Super Admin",
      admin: "Admin",
      agent: "Agent",
      sub_agent: "Sub Agent",
    };
    const byRoleLabel =
      roleMap[user.lastUpdatedByRole] ||
      user.lastUpdatedByRole ||
      "Admin / Manager";

    const when = user.lastUpdatedAt || "";

    let msg = `Your account permissions were updated by ${byName} (${byRoleLabel}).`;
    if (when) msg += ` Time: ${when}`;

    req.session.flash = {
      type: "info",
      title: "Account updated",
      message: msg,
    };

    db.prepare("UPDATE users SET updateNoticeUnread = 0 WHERE id = ?").run(user.id);
  }

  req.session.user = user;
  return res.redirect("/dashboard");
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

/* ==================== Dashboard Routes ==================== */

app.get("/dashboard", requireLogin, (req, res) => {
  const user = req.session.user;
  const perms = getPerm(user);
const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
const limit = Math.max(parseInt(req.query.limit, 10) || 200, 1);
 const statusOptionsCurrent = getOptions("status_options");
 const statusOptionsFee = getOptions("payment_status_options");
 const classOptions = getBulkChallanClassOptions();
  if (user.role === "super_admin") {
  const rows = db.prepare("SELECT * FROM users ORDER BY id ASC").all();
  const users = rows.map(mapUserRow);

  const admissionsPage = fetchAdmissionsPage({
    dept: null,
    page,
    limit,
    perms: null,
  });

  return res.render("dashboard-super", {
    user,
    perms,
    admissions: admissionsPage.rows,
    users,
    deptFilter: null,
    statusOptionsCurrent,
    statusOptionsFee,
    currencyOptions: getCurrencyOptions(),
    bankOptions: getBankOptions(),
    classOptions,
    pagination: {
      page: admissionsPage.page,
      limit: admissionsPage.limit,
      totalRecords: admissionsPage.totalRecords,
      totalPages: admissionsPage.totalPages,
      startRecord: admissionsPage.startRecord,
      endRecord: admissionsPage.endRecord,
    },
  });
}

  const deptAdmissionsPage = fetchAdmissionsPage({
  dept: user.dept || null,
  page,
  limit,
  perms,
});

if (user.role === "admin") {
  return res.render("dashboard-admin", {
    user,
    perms,
    admissions: deptAdmissionsPage.rows,
    statusOptionsCurrent,
    statusOptionsFee,
    currencyOptions: getCurrencyOptions(),
    bankOptions: getBankOptions(),
    classOptions,
    pagination: {
      page: deptAdmissionsPage.page,
      limit: deptAdmissionsPage.limit,
      totalRecords: deptAdmissionsPage.totalRecords,
      totalPages: deptAdmissionsPage.totalPages,
      startRecord: deptAdmissionsPage.startRecord,
      endRecord: deptAdmissionsPage.endRecord,
    },
  });
}

if (user.role === "sub_agent") {
  return res.render("dashboard-sub-agent", {
    user,
    perms,
    admissions: deptAdmissionsPage.rows,
    statusOptionsCurrent,
    statusOptionsFee,
    currencyOptions: getCurrencyOptions(),
    bankOptions: getBankOptions(),
    classOptions,
    pagination: {
      page: deptAdmissionsPage.page,
      limit: deptAdmissionsPage.limit,
      totalRecords: deptAdmissionsPage.totalRecords,
      totalPages: deptAdmissionsPage.totalPages,
      startRecord: deptAdmissionsPage.startRecord,
      endRecord: deptAdmissionsPage.endRecord,
    },
  });
}

if (user.role === "agent") {
  return res.render("dashboard-agent", {
    user,
    perms,
    admissions: deptAdmissionsPage.rows,
    statusOptionsCurrent,
    statusOptionsFee,
    currencyOptions: getCurrencyOptions(),
    bankOptions: getBankOptions(),
    classOptions,
    pagination: {
      page: deptAdmissionsPage.page,
      limit: deptAdmissionsPage.limit,
      totalRecords: deptAdmissionsPage.totalRecords,
      totalPages: deptAdmissionsPage.totalPages,
      startRecord: deptAdmissionsPage.startRecord,
      endRecord: deptAdmissionsPage.endRecord,
    },
  });
}

  return res.send("Unknown role");
});
// ==================== ADMIN: USERS PAGE ====================
// Dept Admin apne dept ke Agents/Sub Agents list dekh sakay
app.get("/dashboard/admin/users", requireLogin, (req, res) => {
  const user = req.session.user;

  // sirf admin allowed
  if (!user || user.role !== "admin") {
    return res.status(403).send("Not allowed");
  }

  // dept required
  if (!user.dept) {
    return res.render("admin-users", { user, deptUsers: [], roleFilter: "all" });
  }

  // ✅ role filter from query
  const roleFilter = (req.query.role || "all").toString();

  // ✅ dynamic filter
  let roleSql = "";
  if (roleFilter === "agent") roleSql = "AND role = 'agent'";
  else if (roleFilter === "sub_agent") roleSql = "AND role = 'sub_agent'";
  else roleSql = "AND role IN ('agent','sub_agent')"; // all

 const rows = db.prepare(`
  SELECT
    id,
    name,
    email,
    role,
    dept,
    agentType,
    permissions,
    lastUpdatedBy,
    lastUpdatedByRole,
    lastUpdatedAt
  FROM users
  WHERE dept = ?
    ${roleSql}
  ORDER BY id DESC
`).all(user.dept);

  const deptUsers = rows.map(mapUserRow);

  return res.render("admin-users", {
    user,
    deptUsers,
    roleFilter, // ✅ view ko bhi bhej do (active button highlight ke liye)
  });
});
// ==================== ADMIN: EDIT USER (GET) ====================
app.get("/dashboard/admin/users/:id/edit", requireLogin, (req, res) => {
  const current = req.session.user;

  if (!current || current.role !== "admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send("Invalid id");

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) return res.status(404).send("User not found");

  // ✅ Admin can edit only same dept + only agent/sub_agent
  if (!current.dept || row.dept !== current.dept) {
    return res.status(403).send("Not allowed");
  }
  if (!(row.role === "agent" || row.role === "sub_agent")) {
    return res.status(403).send("Not allowed");
  }

  const editUser = mapUserRow(row);

  // ✅ normalize child perms so missing keys become false
  editUser.permissions = getPerm(editUser);

  return res.render("admin-user-edit", {
    user: current,
    perms: getPerm(current),
    editUser,
    error: null,
  });
});
// ==================== ADMIN: EDIT USER (POST) ====================
app.post("/dashboard/admin/users/:id/edit", requireLogin, (req, res) => {
  const current = req.session.user;

  if (!current || current.role !== "admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send("Invalid id");

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) return res.status(404).send("User not found");

  // ✅ Admin can edit only same dept + only agent/sub_agent
  if (!current.dept || row.dept !== current.dept) {
    return res.status(403).send("Not allowed");
  }
  if (!(row.role === "agent" || row.role === "sub_agent")) {
    return res.status(403).send("Not allowed");
  }

  const { name, email, agentType } = req.body || {};

  if (!name || !email) {
    const editUser = mapUserRow(row);
    editUser.permissions = getPerm(editUser);

    return res.render("admin-user-edit", {
      user: current,
      perms: getPerm(current),
      editUser,
      error: "Name and email are required.",
    });
  }

  const allowedAgentTypes = ["accounts", "admission", "management"];
  const safeAgentType = allowedAgentTypes.includes(agentType) ? agentType : row.agentType;

  // ✅ IMPORTANT: admin can only grant permissions that admin has
  const parentPerms = getPerm(current);

  const newPerms = {};
  for (const key of PERMISSION_KEYS) {
    newPerms[key] = parentPerms[key] ? isOn(req.body[key]) : false;
  }

  db.prepare(`
    UPDATE users
       SET name=@name,
           email=@email,
           agentType=@agentType,
           permissions=@permissions,
           lastUpdatedBy=@lastUpdatedBy,
           lastUpdatedByRole=@lastUpdatedByRole,
           lastUpdatedAt=@lastUpdatedAt,
           updateNoticeUnread=1
     WHERE id=@id
  `).run({
    id,
    name: String(name).trim(),
    email: String(email).trim(),
    agentType: safeAgentType || null,
    permissions: JSON.stringify(newPerms),
    lastUpdatedBy: current.name,
    lastUpdatedByRole: current.role,
    lastUpdatedAt: new Date().toISOString(),
  });

  // socket notify
  try {
    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("user:updated", { userId: id, ts: Date.now() });
  } catch (e) {}

  logAudit("user_updated_by_admin", current, {
    targetUserId: id,
    targetUserName: name,
    dept: row.dept,
    details: { agentType: safeAgentType, permissions: newPerms },
  });

  req.session.flash = {
    type: "success",
    title: "User updated",
    message: `User "${name}" has been updated successfully.`,
  };

  return res.redirect("/dashboard/admin/users");
});
// ==================== ADMIN: DELETE USER (POST) ====================
app.post("/dashboard/admin/users/:id/delete", requireLogin, (req, res) => {
  const current = req.session.user;

  // ✅ only admin
  if (!current || current.role !== "admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send("Invalid id");

  // ✅ prevent self delete
  if (current.id === id) {
    req.session.flash = { type: "danger", title: "Not allowed", message: "You cannot delete yourself." };
    return res.redirect("/dashboard/admin/users");
  }

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) {
    req.session.flash = { type: "danger", title: "Not found", message: "User not found." };
    return res.redirect("/dashboard/admin/users");
  }

  // ✅ admin can delete only same dept
  if (!current.dept || row.dept !== current.dept) {
    return res.status(403).send("Not allowed");
  }

  // ✅ admin can delete only agent/sub_agent (NOT admin/super)
  if (!(row.role === "agent" || row.role === "sub_agent")) {
    return res.status(403).send("Not allowed");
  }

  // ✅ delete
  db.prepare("DELETE FROM users WHERE id = ?").run(id);

  // optional audit
  try {
    logAudit("user_deleted_by_admin", current, {
      targetUserId: id,
      targetUserName: row.name,
      dept: row.dept,
      role: row.role,
    });
  } catch (e) {}

  req.session.flash = {
    type: "success",
    title: "User deleted",
    message: `User "${row.name}" deleted successfully.`,
  };

  return res.redirect("/dashboard/admin/users");
});
app.get("/dashboard/admin/agents/new", requireLogin, (req, res) => {
  const user = req.session.user;

  if (!user || (user.role !== "admin" && user.role !== "agent")) {
    return res.status(403).send("Forbidden");
  }

  return res.render("admin-agent-form", {
    user,
    perms: getPerm(user),   // ✅ ADD THIS
    error: null
  });
});

const asOn = (v) => v === "on" || v === true || v === "true";

function readBoolPerm(raw, key, defVal, legacyKey) {
  if (typeof raw?.[key] !== "undefined") return !!raw[key];
  if (legacyKey && typeof raw?.[legacyKey] !== "undefined") return !!raw[legacyKey];
  return !!defVal;
}

function buildAllowedFromParent(parentPermRaw = {}) {
  const cols = {
    colDept: readBoolPerm(parentPermRaw, "colDept", false),
    colStudentName: readBoolPerm(parentPermRaw, "colStudentName", false),
    colFatherName: readBoolPerm(parentPermRaw, "colFatherName", false),
    colFatherEmail: readBoolPerm(parentPermRaw, "colFatherEmail", false),
    colGrade: readBoolPerm(parentPermRaw, "colGrade", false),
    colTuitionGrade: readBoolPerm(parentPermRaw, "colTuitionGrade", false),

    colPhone: readBoolPerm(parentPermRaw, "colPhone", false, "showPhone"),
    colProcessedBy: readBoolPerm(parentPermRaw, "colProcessedBy", false),
    colPaymentStatus: readBoolPerm(parentPermRaw, "colPaymentStatus", false, "showPaymentStatus"),
    colPaidUpto: readBoolPerm(parentPermRaw, "colPaidUpto", false, "showPaidUpto"),
    colVerificationNumber: readBoolPerm(parentPermRaw, "colVerificationNumber", false, "showVerificationNumber"),
    colRegistrationNumber: readBoolPerm(parentPermRaw, "colRegistrationNumber", false, "showRegistrationNumber"),

    colFamilyNumber: readBoolPerm(parentPermRaw, "colFamilyNumber", false),
    colRegistrationFee: readBoolPerm(parentPermRaw, "colRegistrationFee", false),
    colFees: readBoolPerm(parentPermRaw, "colFees", false),
    colCurrency: readBoolPerm(parentPermRaw, "colCurrency", false),
    colMonth: readBoolPerm(parentPermRaw, "colMonth", false),
    colTotalFees: readBoolPerm(parentPermRaw, "colTotalFees", false),
    colPendingDues: readBoolPerm(parentPermRaw, "colPendingDues", false),
    colReceivedPayment: readBoolPerm(parentPermRaw, "colReceivedPayment", false),
    colInvoiceStatus: readBoolPerm(parentPermRaw, "colInvoiceStatus", false),
colInvoiceStatusTimestamp: readBoolPerm(parentPermRaw, "colInvoiceStatusTimestamp", false),
colPaidInvoiceStatus: readBoolPerm(parentPermRaw, "colPaidInvoiceStatus", false),
colPaidInvoiceStatusTimestamp: readBoolPerm(parentPermRaw, "colPaidInvoiceStatusTimestamp", false),
    colActionButtons: readBoolPerm(parentPermRaw, "colActionButtons", false),
  };

  const btns = {
    btnEditRow: readBoolPerm(parentPermRaw, "btnEditRow", false),
    btnDetails: readBoolPerm(parentPermRaw, "btnDetails", false),
    btnUpdateRow: readBoolPerm(parentPermRaw, "btnUpdateRow", false),
    btnPdf: readBoolPerm(parentPermRaw, "btnPdf", false),
    btnBilling: readBoolPerm(parentPermRaw, "btnBilling", false),
    btnWhatsApp: readBoolPerm(parentPermRaw, "btnWhatsApp", false),
    btnUpload: readBoolPerm(parentPermRaw, "btnUpload", false),
    btnFiles: readBoolPerm(parentPermRaw, "btnFiles", false),
    canDeleteFiles: readBoolPerm(parentPermRaw, "canDeleteFiles", false),
  };

  const panels = {
    viewAdmissions: readBoolPerm(parentPermRaw, "viewAdmissions", false),
    viewAccounts: readBoolPerm(parentPermRaw, "viewAccounts", false),
    viewManagement: readBoolPerm(parentPermRaw, "viewManagement", false),
  };

  return { cols, btns, panels };
}

function clampChildPerms(allowed, requested) {
  const out = {};

  Object.keys(allowed.panels).forEach(k => out[k] = allowed.panels[k] ? !!requested[k] : false);
  Object.keys(allowed.cols).forEach(k => out[k] = allowed.cols[k] ? !!requested[k] : false);
  Object.keys(allowed.btns).forEach(k => out[k] = allowed.btns[k] ? !!requested[k] : false);

  return out;
}

app.get("/dashboard/agent/agents/new", requireLogin, (req, res) => {
  const user = req.session.user;

  if (!user || user.role !== "agent") {
    return res.status(403).send("Forbidden");
  }

  return res.render("admin-agent-form", {
    user,
    perms: getPerm(user),
    error: null
  });
});
// ✅ Delete ALL uploads (DB + disk) - SUPER ADMIN ONLY
app.post("/dashboard/super/files/delete-all", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    // 1) fetch all stored files from DB
    const rows = db.prepare("SELECT id, stored_name FROM uploads ORDER BY id DESC").all();

    // 2) delete files from disk
    for (const r of rows) {
      const stored = String(r.stored_name || "").trim();
      if (!stored) continue;

      // stored_name is relative to uploadsDir
      const absPath = path.join(uploadsDir, stored);
      safeUnlink(absPath);
    }

    // 3) delete all rows from DB
    db.prepare("DELETE FROM uploads").run();

    // optional: reset sqlite autoincrement (optional)
    // db.prepare("DELETE FROM sqlite_sequence WHERE name='uploads'").run();

    req.session.flash = {
      type: "success",
      title: "Deleted",
      message: `All uploaded files deleted (${rows.length}).`,
    };

    return res.redirect("/dashboard/super/files");
  } catch (err) {
    console.error("delete-all files error:", err);
    req.session.flash = { type: "danger", title: "Error", message: "Delete all failed." };
    return res.redirect("/dashboard/super/files");
  }
});
app.post("/dashboard/admin/agents", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;

      if (!user || (user.role !== "admin" && user.role !== "agent")) {
      return res.status(403).send("Not allowed");
      }

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "").trim();

    if (!name || !email || !password) {
      return res.render("admin-agent-form", {
        user,
        perms: getPerm(user),
        error: "Name, Email, Password required.",
      });
    }

    // dept force
    const dept = user.dept;

    // role rules
    let newRole = String(req.body.newRole || "agent").trim();
    if (user.role === "agent") newRole = "sub_agent";
    if (newRole !== "agent" && newRole !== "sub_agent") newRole = "agent";

    // agentType rules
    const allowedAgentTypes = ["accounts", "admission", "management"];
    let agentType = String(req.body.agentType || "accounts").trim();
    if (user.role === "agent") agentType = user.agentType || "accounts";
    if (!allowedAgentTypes.includes(agentType)) agentType = "accounts";

    const parentPerms = getPerm(user);

    const finalPerms = {};
    for (const key of PERMISSION_KEYS) {
      finalPerms[key] = parentPerms[key] ? isOn(req.body[key]) : false;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const info = db.prepare(`
      INSERT INTO users
        (name, email, password_hash, role, dept, agentType, managerId, permissions, updateNoticeUnread, updatedAt)
      VALUES
        (@name, @email, @password_hash, @role, @dept, @agentType, @managerId, @permissions, 0, CURRENT_TIMESTAMP)
    `).run({
      name,
      email,
      password_hash: passwordHash,
      role: newRole,
      dept: dept || null,
      agentType: agentType || null,
      managerId: user.id,
      permissions: JSON.stringify(finalPerms),
    });

    logAudit(user.role === "agent" ? "user_created_by_agent" : "user_created_by_admin", user, {
      targetUserId: info.lastInsertRowid,
      targetUserName: name,
      dept,
      details: { role: newRole, agentType, permissions: finalPerms },
    });

    req.session.flash = {
      type: "success",
      title: "User created",
      message: `User "${name}" created successfully.`,
    };

   // ✅ redirect based on who created the user
    if (user.role === "agent") {
    return res.redirect("/dashboard/agent/users");
  }
    return res.redirect("/dashboard/admin/users");
  } catch (err) {
    console.error("POST /dashboard/admin/agents error:", err);

    const user = req.session.user;
    return res.status(500).render("admin-agent-form", {
      user,
      perms: getPerm(user),
      error: "Server error while creating user. Please try again.",
    });
  }
});
// ==================== ADMIN UPLOADS (FIX) ====================

// admin upload (department restricted + permission based)
app.post("/admin/uploads",
  requireLogin,
  requirePerm("btnUpload"),
  upload.single("file"),
  (req, res) => {
    try {
      const user = req.session.user;
      const f = req.file;

      const admissionId = req.body.admission_id
        ? parseInt(req.body.admission_id, 10)
        : null;

      if (!f) {
        return res.status(400).json({ success: false, message: "No file received" });
      }

      // ✅ admin dept restriction
      if (user?.role !== "super_admin") {
        if (!user?.dept) return res.status(403).json({ success: false, message: "Dept missing" });

        // admissionId must belong to same dept
        if (admissionId) {
          const row = db.prepare("SELECT dept FROM admissions WHERE id = ?").get(admissionId);
          if (!row) return res.status(404).json({ success: false, message: "Admission not found" });
          if (row.dept !== user.dept) {
            return res.status(403).json({ success: false, message: "Not allowed" });
          }
        }
      }
    const relPath = toPosix(path.relative(uploadsDir, f.path));
const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relPath}`;

db.prepare(`
  INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  admissionId || null,
  f.originalname || "",
  relPath,          // ✅ stored_name = "YYYY/MM/filename.ext"
  fileUrl,          // ✅ /uploads/YYYY/MM/filename.ext
  f.mimetype || "",
  f.size || 0
);


      return res.json({ success: true, message: "Uploaded" });
    } catch (err) {
      console.error("admin upload error:", err);
      return res.status(500).json({ success: false, message: "Upload failed" });
    }
  }
);

// (optional) if your frontend uses /dashboard/admin/uploads anywhere
app.post(
  "/dashboard/admin/uploads",
  requireLogin,
  requirePerm("btnUpload"),
  upload.single("file"),
  (req, res) => {
    // same handler call by redirecting to the main route
    req.url = "/admin/uploads";
    return app._router.handle(req, res);
  }
);
// ==================== ADMIN: FILES PAGE (FIX) ====================
app.get("/admin/files", requireLogin, requirePerm("btnFiles"), (req, res) => {
  try {
    const user = req.session.user;

    const admissionId = req.query.admission_id
      ? parseInt(req.query.admission_id, 10)
      : null;
    let familyNumber = "";
    let familyAdmissionIds = [];
    let baseAdmission = null;
    // ✅ admin / agent / sub-agent dept restriction
if (user?.role !== "super_admin") {
  if (!user?.dept) return res.status(403).send("Dept missing");
}

if (admissionId) {
  baseAdmission = db.prepare(`
    SELECT id, dept, student_name, accounts_family_number
    FROM admissions
    WHERE id = ?
  `).get(admissionId);

  if (!baseAdmission) return res.status(404).send("Admission not found");

  if (user?.role !== "super_admin" && baseAdmission.dept !== user.dept) {
    return res.status(403).send("Not allowed");
  }

  familyNumber = String(baseAdmission.accounts_family_number || "").trim();

  if (familyNumber) {
    if (user?.role === "super_admin") {
      familyAdmissionIds = db.prepare(`
        SELECT id
        FROM admissions
        WHERE accounts_family_number = ?
        ORDER BY id DESC
      `).all(familyNumber).map(r => r.id);
    } else {
      familyAdmissionIds = db.prepare(`
        SELECT id
        FROM admissions
        WHERE accounts_family_number = ?
          AND dept = ?
        ORDER BY id DESC
      `).all(familyNumber, user.dept).map(r => r.id);
    }
  } else {
    familyAdmissionIds = [admissionId];
  }
}

   let files = [];

if (admissionId) {
  if (familyAdmissionIds.length > 0) {
    const placeholders = familyAdmissionIds.map(() => "?").join(",");

    files = db.prepare(`
      SELECT
        u.*,
        a.student_name AS student_name,
        a.accounts_family_number AS family_number,
        a.id AS linked_admission_id
      FROM uploads u
      LEFT JOIN admissions a ON a.id = u.admission_id
      WHERE u.admission_id IN (${placeholders})
      ORDER BY u.id DESC
    `).all(...familyAdmissionIds);
  } else {
    files = [];
  }
} else {
      // ✅ admin ko sirf apne dept ke admissions ki files
      if (user?.role !== "super_admin") {
        files = db.prepare(`
          SELECT
            u.*,
            a.student_name AS student_name
          FROM uploads u
          LEFT JOIN admissions a ON a.id = u.admission_id
          WHERE a.dept = ?
          ORDER BY u.id DESC
        `).all(user.dept);
      } else {
        files = db.prepare(`
          SELECT
            u.*,
            a.student_name AS student_name
          FROM uploads u
          LEFT JOIN admissions a ON a.id = u.admission_id
          ORDER BY u.id DESC
        `).all();
      }
    }

   return res.render("super-files", {
  user,
  files,
  pageTitle: "Uploaded Files",
  admissionId: admissionId || null,
  familyNumber: familyNumber || null,
  familyAdmissionIds,
});
  } catch (err) {
    console.error("admin files page error:", err);
    return res.status(500).send("DB error");
  }
});
// ✅ ADMIN: DELETE FILE (only if canDeleteFiles + same dept)
app.delete("/admin/files/:id", requireLogin, requireDeleteFiles, (req, res) => {
  try {
    const user = req.session.user;

    // sirf admin allowed (super admin ka separate route already hai)
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid file id" });
    }

    const fileRow = db.prepare("SELECT * FROM uploads WHERE id = ?").get(id);
    if (!fileRow) {
      return res.status(404).json({ success: false, message: "File not found" });
    }

    // ✅ admission dept check
    const adm = db.prepare("SELECT dept FROM admissions WHERE id = ?").get(fileRow.admission_id);
    if (!adm) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    if (!user.dept || adm.dept !== user.dept) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    // ✅ delete from folder
    const filePath = path.join(__dirname, "uploads", fileRow.stored_name || "");
    if (fileRow.stored_name && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // ✅ delete from DB
    db.prepare("DELETE FROM uploads WHERE id = ?").run(id);

    return res.json({ success: true });
  } catch (err) {
    console.error("ADMIN delete file error:", err);
    return res.status(500).json({ success: false, message: "Delete failed" });
  }
});

app.post("/dashboard/super/files/link", requireLogin, requireSuperAdmin, (req, res) => {
  // same code as /api/url/save
  try {
    const user = req.session.user;

    const { admission_id, name, summary, link } = req.body || {};
    const admissionId = admission_id ? parseInt(admission_id, 10) : null;

    const cleanName = String(name || "").trim() || "URL";
    const cleanSummary = String(summary || "").trim();
    const cleanLink = String(link || "").trim();

    if (!admissionId) return res.status(400).json({ success:false, message:"admission_id required" });
    if (!cleanLink.startsWith("http://") && !cleanLink.startsWith("https://"))
      return res.status(400).json({ success:false, message:"Valid http/https link required" });

    const adm = db.prepare("SELECT id, dept FROM admissions WHERE id = ?").get(admissionId);
    if (!adm) return res.status(404).json({ success:false, message:"Admission not found" });

    db.prepare(`
      INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(admissionId, cleanName, cleanSummary, cleanLink, "text/url", 0);

    return res.json({ success:true, message:"URL saved" });
  } catch (err) {
    console.error("POST /dashboard/super/files/link error:", err);
    return res.status(500).json({ success:false, message:"URL save failed" });
  }
});
// ==================== URL SAVE (ROLE BASED) ====================

// shared handler
function saveUrlToUploads(req, res, role) {
  try {
    const user = req.session.user;

    // role check
    if (!user || user.role !== role) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const { admission_id, name, summary, link } = req.body || {};
    const admissionId = admission_id ? parseInt(admission_id, 10) : null;

    const cleanName = String(name || "").trim() || "URL";
    const cleanSummary = String(summary || "").trim();
    const cleanLink = String(link || "").trim();

    if (!admissionId) {
      return res.status(400).json({ success: false, message: "admission_id required" });
    }

    if (!cleanLink.startsWith("http://") && !cleanLink.startsWith("https://")) {
      return res.status(400).json({ success: false, message: "Valid http/https link required" });
    }

    // ✅ admission exists + dept restriction
    const adm = db.prepare("SELECT id, dept FROM admissions WHERE id = ?").get(admissionId);
    if (!adm) return res.status(404).json({ success: false, message: "Admission not found" });

    // ✅ dept check for non-super
    if (user.role !== "super_admin") {
      if (!user.dept || adm.dept !== user.dept) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }

    const { year, month } = getYearMonthParts();
const groupedSummary = `[${year}-${month}] ${cleanSummary || ""}`.trim();

db.prepare(`
  INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(admissionId, cleanName, groupedSummary, cleanLink, "text/url", 0);


    return res.json({ success: true, message: "URL saved" });
  } catch (err) {
    console.error("URL save error:", err);
    return res.status(500).json({ success: false, message: "URL save failed" });
  }
}

// ✅ Admin
app.post(
  "/dashboard/admin/files/link",
  requireLogin,
  requirePerm("btnUpload"),
  (req, res) => saveUrlToUploads(req, res, "admin")
);

// ✅ Agent
app.post(
  "/dashboard/agent/files/link",
  requireLogin,
  requirePerm("btnUpload"),
  (req, res) => saveUrlToUploads(req, res, "agent")
);

// ✅ Sub Agent
app.post(
  "/dashboard/sub-agent/files/link",
  requireLogin,
  requirePerm("btnUpload"),
  (req, res) => saveUrlToUploads(req, res, "sub_agent")
);

// ==================== URL EDIT (ROLE BASED) ====================

// shared handler
function editUrlInUploads(req, res, role) {
  try {
    const user = req.session.user;

    // role check
    if (!user || user.role !== role) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const uploadId = parseInt(req.params.uploadId, 10);
    if (!uploadId) {
      return res.status(400).json({ success: false, message: "Invalid uploadId" });
    }

    const { name, summary, link } = req.body || {};

    const cleanName = String(name || "").trim() || "URL";
    const cleanSummary = String(summary || "").trim();
    const cleanLink = String(link || "").trim();

    if (!cleanLink.startsWith("http://") && !cleanLink.startsWith("https://")) {
      return res.status(400).json({ success: false, message: "Valid http/https link required" });
    }

    // ✅ get upload row
    const row = db.prepare("SELECT * FROM uploads WHERE id = ?").get(uploadId);
    if (!row) {
      return res.status(404).json({ success: false, message: "Upload not found" });
    }

    // ✅ only URL editable
    if (row.mime_type !== "text/url") {
      return res.status(400).json({ success: false, message: "Only URL items can be edited" });
    }

    // ✅ admission exists + dept restriction (same as save)
    const adm = db.prepare("SELECT id, dept FROM admissions WHERE id = ?").get(row.admission_id);
    if (!adm) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    // ✅ dept check for non-super
    if (user.role !== "super_admin") {
      if (!user.dept || adm.dept !== user.dept) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }

    // ✅ update in uploads
    db.prepare(`
      UPDATE uploads
         SET original_name = ?,
             stored_name = ?,
             file_url = ?
       WHERE id = ?
    `).run(cleanName, cleanSummary, cleanLink, uploadId);

    return res.json({ success: true, message: "URL updated" });
  } catch (err) {
    console.error("URL edit error:", err);
    return res.status(500).json({ success: false, message: "URL edit failed" });
  }
}

// ✅ Super Admin
app.post(
  "/dashboard/super/files/link/:uploadId/edit",
  requireLogin,
  requireSuperAdmin,
  (req, res) => editUrlInUploads(req, res, "super_admin")
);

// ✅ Admin
app.post(
  "/dashboard/admin/files/link/:uploadId/edit",
  requireLogin,
  requirePerm("btnUpload"),
  (req, res) => editUrlInUploads(req, res, "admin")
);

// ✅ Agent
app.post(
  "/dashboard/agent/files/link/:uploadId/edit",
  requireLogin,
  requirePerm("btnUpload"),
  (req, res) => editUrlInUploads(req, res, "agent")
);

// ✅ Sub Agent
app.post(
  "/dashboard/sub-agent/files/link/:uploadId/edit",
  requireLogin,
  requirePerm("btnUpload"),
  (req, res) => editUrlInUploads(req, res, "sub_agent")
);

/* ==================== SUPER ADMIN ROUTES ==================== */

app.post( "/dashboard/super/uploads",
  requireLogin,
  requireSuperAdmin,
  upload.single("file"),
  (req, res) => {
    try {
      const f = req.file;
      const admissionId = req.body.admission_id
        ? parseInt(req.body.admission_id, 10)
        : null;

      if (!f) {
        return res.status(400).json({ success: false, message: "No file received" });
      }
      const relPath = toPosix(path.relative(uploadsDir, f.path));
const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relPath}`;

db.prepare(`
  INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  admissionId || null,
  f.originalname || "",
  relPath,          // ✅ stored_name = "YYYY/MM/filename.ext"
  fileUrl,          // ✅ /uploads/YYYY/MM/filename.ext
  f.mimetype || "",
  f.size || 0
);
      return res.json({ success: true, message: "Uploaded" });
    } catch (err) {
      console.error("upload error:", err);
      return res.status(500).json({ success: false, message: "Upload failed" });
    }
  }
);

app.get("/dashboard/super/files", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const admissionId = req.query.admission_id
  ? parseInt(req.query.admission_id, 10)
  : null;

let files = [];
let familyNumber = "";
let familyAdmissionIds = [];

if (admissionId) {
  const baseAdmission = db.prepare(`
    SELECT id, student_name, accounts_family_number
    FROM admissions
    WHERE id = ?
  `).get(admissionId);

  if (!baseAdmission) {
    return res.status(404).send("Admission not found");
  }

  familyNumber = String(baseAdmission.accounts_family_number || "").trim();

  if (familyNumber) {
    familyAdmissionIds = db.prepare(`
      SELECT id
      FROM admissions
      WHERE accounts_family_number = ?
      ORDER BY id DESC
    `).all(familyNumber).map(r => r.id);
  } else {
    familyAdmissionIds = [admissionId];
  }
}

   if (admissionId) {
  if (familyAdmissionIds.length > 0) {
    const placeholders = familyAdmissionIds.map(() => "?").join(",");

    files = db.prepare(`
      SELECT
        u.*,
        a.student_name AS student_name,
        a.accounts_family_number AS family_number,
        a.id AS linked_admission_id
      FROM uploads u
      LEFT JOIN admissions a ON a.id = u.admission_id
      WHERE u.admission_id IN (${placeholders})
      ORDER BY u.id DESC
    `).all(...familyAdmissionIds);
  } else {
    files = [];
  }
} else {
      files = db
        .prepare(
          `
        SELECT
          u.*,
          a.student_name AS student_name
        FROM uploads u
        LEFT JOIN admissions a ON a.id = u.admission_id
        ORDER BY u.id DESC
      `
        )
        .all();
    }

   return res.render("super-files", {
  user: req.session.user,
  files,
  pageTitle: "Uploaded Files",
  admissionId: admissionId || null,
  familyNumber: familyNumber || null,
  familyAdmissionIds,
});
  } catch (err) {
    console.error("files page error:", err);
    return res.status(500).send("DB error");
  }
});

// ✅ DELETE FILE (DB + uploads folder) (super only)
app.delete("/dashboard/super/files/:id", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ success: false, message: "Invalid file id" });
    }

    const row = db.prepare("SELECT * FROM uploads WHERE id = ?").get(id);
    if (!row) {
      return res.status(404).json({ success: false, message: "File not found" });
    }

    const filePath = path.join(__dirname, "uploads", row.stored_name || "");
    if (row.stored_name && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.prepare("DELETE FROM uploads WHERE id = ?").run(id);

    return res.json({ success: true });
  } catch (err) {
    console.error("delete file error:", err);
    return res.status(500).json({ success: false, message: "Delete failed" });
  }
});
// Users list
app.get("/dashboard/super/users", requireLogin, (req, res) => {
  const current = req.session.user;
  if (!current || current.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const roleFilter = (req.query.role === "super" ? "super_admin" : (req.query.role || "all"));

  const rows = db.prepare("SELECT * FROM users ORDER BY id ASC").all();
  const allUsers = rows.map(mapUserRow);

  let filteredUsers = allUsers;
  if (roleFilter === "super_admin") {
    filteredUsers = allUsers.filter((u) => u.role === "super_admin");
  } else if (roleFilter === "admin") {
    filteredUsers = allUsers.filter((u) => u.role === "admin");
  } else if (roleFilter === "sub_agent") {
    filteredUsers = allUsers.filter((u) => u.role === "sub_agent");
  } else if (roleFilter === "agent") {
    filteredUsers = allUsers.filter((u) => u.role === "agent");
  }

  const counts = {
    total: allUsers.length,
    admins: allUsers.filter((u) => u.role === "admin" || u.role === "super_admin")
      .length,
    subAgents: allUsers.filter((u) => u.role === "sub_agent").length,
    agents: allUsers.filter((u) => u.role === "agent").length,
  };

  return res.render("super-users", {
    user: current,
    users: filteredUsers,
    roleFilter,
    counts,
  });
});

// Create User form
app.get("/dashboard/super/users/new", requireLogin, (req, res) => {
  const current = req.session.user;
  if (!current || current.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  res.render("super-user-form", {
    user: current,
    error: null,
  });
});

// Create User submit
app.post("/dashboard/super/users", requireLogin, async (req, res) => {
  const current = req.session.user;
  if (!current || current.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const {
    name,
    email,
    password,
    role,
    dept,
    agentType,
    colPhone,
    colPaymentStatus,
    colPaidUpto,
    colVerificationNumber,
    colRegistrationNumber,
  } = req.body;

  if (!name || !email || !password || !role) {
    return res.render("super-user-form", {
      user: current,
      error: "Name, email, password, role are required.",
    });
  }

  const allowedRoles = ["admin", "agent", "sub_agent"];
  if (!allowedRoles.includes(role)) {
    return res.render("super-user-form", {
      user: current,
      error: "Role must be Admin, Agent, or Sub Agent.",
    });
  }

  const allowedDepts = ["quran", "tuition", "school"];
  const allowedAgentTypes = ["accounts", "admission", "management"];
  const isPipelineRole = role === "sub_agent" || role === "agent";

  const passwordHash = await bcrypt.hash(password, 10);

 const permissions = {
  // Columns
  colStatus: isOn(req.body.colStatus),
  colFeeStatus: isOn(req.body.colFeeStatus),
  colDept: isOn(req.body.colDept),
  colStudentName: isOn(req.body.colStudentName || req.body.colStudent),
  colFatherName: isOn(req.body.colFatherName || req.body.colFather),
  colFatherEmail: isOn(req.body.colFatherEmail),
  colGrade: isOn(req.body.colGrade),
  colTuitionGrade: isOn(req.body.colTuitionGrade),
  colPhone: isOn(req.body.colPhone),
  colProcessedBy: isOn(req.body.colProcessedBy),
  colPaymentStatus: isOn(req.body.colPaymentStatus),
  colPaidUpto: isOn(req.body.colPaidUpto),
  colVerificationNumber: isOn(req.body.colVerificationNumber),
  colRegistrationNumber: isOn(req.body.colRegistrationNumber),
  colFamilyNumber: isOn(req.body.colFamilyNumber),
  colRegistrationFee: isOn(req.body.colRegistrationFee),
  colFees: isOn(req.body.colFees),
  colCurrency: isOn(req.body.colCurrency),
  colMonth: isOn(req.body.colMonth),
  colTotalFees: isOn(req.body.colTotalFees),
  colPendingDues: isOn(req.body.colPendingDues),
  colReceivedPayment: isOn(req.body.colReceivedPayment),
  colInvoiceStatus: isOn(req.body.colInvoiceStatus),
colInvoiceStatusTimestamp: isOn(req.body.colInvoiceStatusTimestamp),
colPaidInvoiceStatus: isOn(req.body.colPaidInvoiceStatus),
colPaidInvoiceStatusTimestamp: isOn(req.body.colPaidInvoiceStatusTimestamp),
  colActionButtons: isOn(req.body.colActionButtons),

  // Buttons
  btnEditRow: isOn(req.body.btnEditRow),
  btnDetails: isOn(req.body.btnDetails),
  btnUpdateRow: isOn(req.body.btnUpdateRow || req.body.canUpdateAdmissions || req.body.canUpdateAccounts),
  btnPdf: isOn(req.body.btnPdf || req.body.canDownloadPdf),
  btnBilling: isOn(req.body.btnBilling || req.body.canOpenBilling || req.body.canSaveBilling),
  btnWhatsApp: isOn(req.body.btnWhatsApp || req.body.canSendWhatsApp),
  btnUpload: isOn(req.body.btnUpload || req.body.canUploadFiles),
  btnFiles: isOn(req.body.btnFiles),

canDeleteFiles: isOn(req.body.canDeleteFiles),
canDeleteAdmissions: isOn(req.body.canDeleteAdmissions),
};




  const result = db
    .prepare(
      `
      INSERT INTO users
       (name, email, password_hash, role, dept, agentType, managerId, permissions)
       VALUES (@name, @email, @password_hash, @role, @dept, @agentType, @managerId, @permissions)
    `
    )
    .run({
      name,
      email,
      password_hash: passwordHash,
      role,
      dept: allowedDepts.includes(dept) ? dept : null,
      agentType: isPipelineRole
        ? allowedAgentTypes.includes(agentType)
          ? agentType
          : "accounts"
        : null,
      managerId: current.id,
      permissions: JSON.stringify(permissions),
    });

  logAudit("user_created", current, {
    targetUserId: result.lastInsertRowid,
    targetUserName: name,
    dept: allowedDepts.includes(dept) ? dept : null,
    details: { role, dept, agentType, permissions },
  });

  req.session.flash = {
    type: "success",
    title: "User created",
    message: `User "${name}" has been created successfully.`,
  };

  return res.redirect("/dashboard/super/users");
});

// Edit form
app.get("/dashboard/super/users/:id/edit", requireLogin, (req, res) => {
  const current = req.session.user;
  if (!current || current.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);

  if (!row) {
    return res.status(404).send("User not found");
  }

  const editUser = mapUserRow(row);
  editUser.permissions = getPerm(editUser);

  return res.render("super-user-edit", {
    user: current,
    editUser,
    error: null,
  });
});

// Handle edit submit
app.post("/dashboard/super/users/:id/edit", requireLogin, async (req, res) => {
  const current = req.session.user;
  if (!current || current.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);
  const existingRow = db.prepare("SELECT * FROM users WHERE id = ?").get(id);

  if (!existingRow) {
    return res.status(404).send("User not found");
  }

  const {
    name,
    email,
    password,
    role,
    dept,
    agentType,
    colPhone,
    colPaymentStatus,
    colPaidUpto,
    colVerificationNumber,
    colRegistrationNumber,
  } = req.body;

  if (!name || !email || !role) {
    const editUser = mapUserRow(existingRow);
    return res.render("super-user-edit", {
      user: current,
      editUser,
      error: "Name, email and role are required.",
    });
  }

  const allowedRoles = ["admin", "agent", "sub_agent"];
  if (!allowedRoles.includes(role)) {
    const editUser = mapUserRow(existingRow);
    return res.render("super-user-edit", {
      user: current,
      editUser,
      error: "Role must be Admin, Agent, or Sub Agent.",
    });
  }

  const allowedDepts = ["quran", "tuition", "school"];
  const allowedAgentTypes = ["accounts", "admission", "management"];
  const isPipelineRole = role === "sub_agent" || role === "agent";

  let passwordHash = existingRow.password_hash;
  if (password && password.trim() !== "") {
    passwordHash = await bcrypt.hash(password.trim(), 10);
  }

 const permissions = {
  // Columns
  colStatus: isOn(req.body.colStatus),
  colFeeStatus: isOn(req.body.colFeeStatus),
  colDept: isOn(req.body.colDept),
  colStudentName: isOn(req.body.colStudentName || req.body.colStudent),
  colFatherName: isOn(req.body.colFatherName || req.body.colFather),
  colFatherEmail: isOn(req.body.colFatherEmail),
  colGrade: isOn(req.body.colGrade),
  colTuitionGrade: isOn(req.body.colTuitionGrade),
  colPhone: isOn(req.body.colPhone),
  colProcessedBy: isOn(req.body.colProcessedBy),
  colPaymentStatus: isOn(req.body.colPaymentStatus),
  colPaidUpto: isOn(req.body.colPaidUpto),
  colVerificationNumber: isOn(req.body.colVerificationNumber),
  colRegistrationNumber: isOn(req.body.colRegistrationNumber),
  colFamilyNumber: isOn(req.body.colFamilyNumber),
  colRegistrationFee: isOn(req.body.colRegistrationFee),
  colFees: isOn(req.body.colFees),
  colCurrency: isOn(req.body.colCurrency),
  colMonth: isOn(req.body.colMonth),
  colTotalFees: isOn(req.body.colTotalFees),
  colPendingDues: isOn(req.body.colPendingDues),
  colReceivedPayment: isOn(req.body.colReceivedPayment),
  colInvoiceStatus: isOn(req.body.colInvoiceStatus),
colInvoiceStatusTimestamp: isOn(req.body.colInvoiceStatusTimestamp),
colPaidInvoiceStatus: isOn(req.body.colPaidInvoiceStatus),
colPaidInvoiceStatusTimestamp: isOn(req.body.colPaidInvoiceStatusTimestamp),
  colActionButtons: isOn(req.body.colActionButtons),

  // Buttons
  btnEditRow: isOn(req.body.btnEditRow),
  btnDetails: isOn(req.body.btnDetails),
  btnUpdateRow: isOn(req.body.btnUpdateRow || req.body.canUpdateAdmissions || req.body.canUpdateAccounts),
  btnPdf: isOn(req.body.btnPdf || req.body.canDownloadPdf),
  btnBilling: isOn(req.body.btnBilling || req.body.canOpenBilling || req.body.canSaveBilling),
  btnWhatsApp: isOn(req.body.btnWhatsApp || req.body.canSendWhatsApp),
  btnUpload: isOn(req.body.btnUpload || req.body.canUploadFiles),

  btnFiles: isOn(req.body.btnFiles),

canDeleteFiles: isOn(req.body.canDeleteFiles),
canDeleteAdmissions: isOn(req.body.canDeleteAdmissions),
};


  const before = {
    role: existingRow.role,
    dept: existingRow.dept,
    agentType: existingRow.agentType,
    permissions: existingRow.permissions,
  };

  db.prepare(`
    UPDATE users
     SET name=@name,
         email=@email,
         password_hash=@password_hash,
         role=@role,
         dept=@dept,
         agentType=@agentType,
         permissions=@permissions,
         lastUpdatedBy=@lastUpdatedBy,
         lastUpdatedByRole=@lastUpdatedByRole,
         lastUpdatedAt=@lastUpdatedAt,
         updateNoticeUnread=1
     WHERE id=@id
  `).run({
    id,
    name,
    email,
    password_hash: passwordHash,
    role,
    dept: allowedDepts.includes(dept) ? dept : null,
    agentType: isPipelineRole
      ? allowedAgentTypes.includes(agentType)
        ? agentType
        : "accounts"
      : null,
    permissions: JSON.stringify(permissions),
    lastUpdatedBy: current.name,
    lastUpdatedByRole: current.role,
    lastUpdatedAt: new Date().toISOString(),
  });
   try {
  const ioRef = req.app.get("io");
  if (ioRef) {
    ioRef.emit("user:updated", { userId: id, ts: Date.now() });
  }
} catch (e) {}

  const after = {
    role,
    dept: allowedDepts.includes(dept) ? dept : null,
    agentType: isPipelineRole
      ? allowedAgentTypes.includes(agentType)
        ? agentType
        : "accounts"
      : null,
    permissions,
  };

  logAudit("user_updated", current, {
    targetUserId: id,
    targetUserName: name,
    dept: after.dept,
    details: { before, after },
  });

  req.session.flash = {
    type: "success",
    title: "User updated",
    message: `User "${name}" has been updated successfully.`,
  };

  return res.redirect("/dashboard/super/users");
});

// SUPER ADMIN: DELETE USER
app.post("/dashboard/super/users/:id/delete", requireLogin, (req, res) => {
  const current = req.session.user;
  if (!current || current.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!row) {
    return res.status(404).send("User not found");
  }

  if (id === current.id) {
    return res.send("You cannot delete your own Super Admin account.");
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(id);

  logAudit("user_deleted", current, {
    targetUserId: id,
    targetUserName: row.name,
    dept: row.dept,
    details: {
      role: row.role,
      agentType: row.agentType,
    },
  });

  req.session.flash = {
    type: "success",
    title: "User deleted",
    message: "User has been deleted successfully.",
  };

  return res.redirect("/dashboard/super/users");
});

// ----------------- SUPER ADMIN: SYSTEM HISTORY PAGE -----------------
app.get("/dashboard/super/history", requireLogin, (req, res) => {
  const current = req.session.user;
  if (!current || current.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const { dept = "", role = "", eventType = "", q = "" } = req.query;

  const where = [];
  const params = {};

  if (dept) {
    where.push("a.dept = @dept");
    params.dept = dept;
  }

  if (role) {
    where.push("a.actorRole = @role");
    params.role = role;
  }

  if (eventType) {
    where.push("a.eventType = @eventType");
    params.eventType = eventType;
  }

  if (q) {
    where.push(
      "(a.actorName LIKE @q OR a.actorDept LIKE @q OR a.targetUserName LIKE @q OR a.details LIKE @q)"
    );
    params.q = `%${q}%`;
  }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const logs = db
    .prepare(
      `
      SELECT
        a.id,
        a.createdAt,
        a.actorName,
        a.actorRole,
        a.actorDept,
        a.targetUserId,
        a.targetUserName,
        a.eventType,
        a.dept,
        a.details
      FROM audit_logs a
      ${whereSql}
      ORDER BY a.id DESC
      LIMIT 200
    `
    )
    .all(params);

  const depts = db
    .prepare(
      "SELECT DISTINCT dept FROM audit_logs WHERE dept IS NOT NULL AND dept <> '' ORDER BY dept"
    )
    .all()
    .map((r) => r.dept);

  const roles = db
    .prepare(
      "SELECT DISTINCT actorRole FROM audit_logs WHERE actorRole IS NOT NULL AND actorRole <> '' ORDER BY actorRole"
    )
    .all()
    .map((r) => r.actorRole);

  const events = db
    .prepare(
      "SELECT DISTINCT eventType FROM audit_logs WHERE eventType IS NOT NULL AND eventType <> '' ORDER BY eventType"
    )
    .all()
    .map((r) => r.eventType);

  return res.render("super-history", {
    user: current,
    logs,
    pageTitle: "System Activity History",
    filters: { dept, role, eventType, q },
    filterMeta: { depts, roles, events },
  });
});

app.get("/dashboard/overview", requireLogin, requireSuperAdmin, (req, res) => {
  const page = parseInt(req.query.page) || 1;
const limit = 10;
const offset = (page - 1) * limit;
  const user = req.session.user;
  const perms = getPerm(user);

  const filters = {
    startDate: req.query.startDate || "",
    endDate: req.query.endDate || "",
    day: req.query.day || "",
    month: req.query.month || "",
    year: req.query.year || "",
    department: req.query.department || "all",
    status: req.query.status || "all",
    feeStatus: req.query.feeStatus || "all",
    billingStatus: req.query.billingStatus || "all",
    currency: req.query.currency || "all",
  };

  const overviewData = buildOverviewData(filters);

  return res.render("overview", {
  user,
  perms,
  pageTitle: "Overview",
  filters,
  overviewData,

  // ✅ ADD THIS
  pagination: {
    page: page,
    limit: limit,
    totalPages: 1, // temporary (baad me dynamic karenge)
  },
  pendingDuePagination: {
  page: page,
  limit: limit,
  totalPages: 1,
},
});
});

// Super Admin: filter main dashboard by department
app.get("/dashboard/super/:dept", requireLogin, (req, res) => {
  const user = req.session.user;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
const limit = Math.max(parseInt(req.query.limit, 10) || 200, 1);
 const statusOptionsCurrent = getOptions("status_options");
const statusOptionsFee = getOptions("payment_status_options");
const classOptions = getBulkChallanClassOptions();
  if (!user || user.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  const dept = req.params.dept;
  const allowed = ["quran", "tuition", "school"];
  if (!allowed.includes(dept)) {
    return res.status(404).send("Not found");
  }

  const deptAdmissionsPage = fetchAdmissionsPage({
  dept,
  page,
  limit,
  perms: null,
});

  const rows = db.prepare("SELECT * FROM users ORDER BY id ASC").all();
  const allUsers = rows.map(mapUserRow);

 return res.render("dashboard-super", {
  user,
  users: allUsers,
  perms: getPerm(user),
  admissions: deptAdmissionsPage.rows,
pagination: {
  page: deptAdmissionsPage.page,
  limit: deptAdmissionsPage.limit,
  totalRecords: deptAdmissionsPage.totalRecords,
  totalPages: deptAdmissionsPage.totalPages,
  startRecord: deptAdmissionsPage.startRecord,
  endRecord: deptAdmissionsPage.endRecord,
},
  deptFilter: dept,
  statusOptionsCurrent,
  statusOptionsFee,
  currencyOptions: getCurrencyOptions(),
  bankOptions: getBankOptions(),
   classOptions,
});
});

// -------- SUPER ADMIN: FULL PIPELINE UPDATE (DB) --------
app.post("/super/update/:id", requireLogin, handleSuperFullUpdate);
app.post("/dashboard/super/update/:id", requireLogin, handleSuperFullUpdate);

// -------- Admin full pipeline update (DB) --------
app.post("/admin/update/:id", requireLogin, (req, res) => {
  const user = req.session.user;
  if (!user || user.role !== "admin") {
    return res.status(403).send("Not allowed");
  }

  const id = parseInt(req.params.id, 10);
  const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(id);

  if (!row || row.dept !== user.dept) {
    return res.status(404).send("Not found");
  }

  const before = buildPipelineSnapshotFromRow(row);

  const {
    status,
    feeStatus,
    student,
    father,
    father_email,
    grade,
    tuitionGrade,
    phone,
    paymentStatus,
    paidUpto,
    verificationNumber,
    registrationNumber,
    familyNumber,
    registrationFee,
    fees,
    month,
    currencyCode,
    currency_code,
    currency, // ✅ ADD
  } = req.body;
 
    const cleanRegistrationNumber = String(registrationNumber || "").trim();
    
    const resolvedCurrencyCode = pickCurrencyCode(req.body, row.currency_code || "");

if (resolvedCurrencyCode) {
  const allowedCurrency = db
    .prepare("SELECT id FROM currency_options WHERE label = ?")
    .get(resolvedCurrencyCode);

  if (!allowedCurrency) {
    return res.status(400).json({
      success: false,
      message: "Invalid currency selected"
    });
  }
}

  const duplicateReg = checkDuplicateRegistrationNumber(cleanRegistrationNumber, id);

  if (duplicateReg) {
    return res.status(409).json({
      success: false,
      message: "This registration number is already in use. Please enter another number."
    });
  }

  const perms = getPerm(user);
  const canAdmissions = !!perms.btnUpdateRow;
  const canAccounts  = !!perms.btnUpdateRow;
  const billingJson = getBillingJsonFromRow(row);

const oldFeeSnapshot =
  parseFirstNumber(row?.monthly_fee_current || 0) ||
  parseFirstNumber(row?.admission_fees || 0) ||
  inferMonthlyFee(row, billingJson) ||
  0;

const incomingFeeNumber = parseFirstNumber(fees ?? "");

let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
const effectivePaidUpto =
  computePaidUptoFromBillingJson(billingJson) ||
  paidUpto ||
  row.accounts_paid_upto ||
  "";
feeHistory = applyFeeChangeIfNeeded(
  row,
  user,
  incomingFeeNumber,
  oldFeeSnapshot,
  effectivePaidUpto
);

const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, incomingFeeNumber || oldFeeSnapshot);
const dues = calcPendingDues(baseFee, billingJson, feeHistory);

  const updated = {
      status: canAdmissions
      ? (typeof status !== "undefined" && status !== null ? status : (row.status || ""))
      : (row.status || ""),
      feeStatus: canAdmissions
  ? (typeof feeStatus !== "undefined" && feeStatus !== null ? feeStatus : (row.feeStatus || ""))
  : (row.feeStatus || ""),

    // Admissions side
    student_name: canAdmissions
      ? (typeof student !== "undefined" && student !== null ? student : row.student_name)
      : row.student_name,
    father_name: canAdmissions
      ? (typeof father !== "undefined" && father !== null ? father : row.father_name)
      : row.father_name,
   father_email: perms.colFatherEmail
  ? (typeof father_email !== "undefined" && father_email !== null ? father_email : (row.father_email || ""))
  : (row.father_email || ""),
    grade: canAdmissions
      ? (typeof grade !== "undefined" && grade !== null ? grade : row.grade)
      : row.grade,
    tuition_grade: canAdmissions
      ? (typeof tuitionGrade !== "undefined" && tuitionGrade !== null ? tuitionGrade : row.tuition_grade)
      : row.tuition_grade,
    phone: canAdmissions
      ? (typeof phone !== "undefined" && phone !== null ? phone : row.phone)
      : row.phone,
   admission_fees: canAdmissions
  ? ((typeof fees !== "undefined" && fees !== null && String(fees).trim() !== "") ? String(fees).trim() : (row.admission_fees || ""))
  : (row.admission_fees || ""),
  currency_code: canAdmissions
  ? pickCurrencyCode(req.body, row.currency_code || "")
  : (row.currency_code || ""),
    admission_month: canAdmissions
      ? (typeof month !== "undefined" && month !== null ? month : row.admission_month || "")
      : (row.admission_month || ""),
    accounts_family_number: canAccounts
  ? (typeof familyNumber !== "undefined" && familyNumber !== null
      ? familyNumber
      : (row.accounts_family_number || ""))
  : (row.accounts_family_number || ""),
  admission_registration_fee: canAdmissions
  ? ((typeof registrationFee !== "undefined" && registrationFee !== null && String(registrationFee).trim() !== "")
      ? String(registrationFee).trim()
      : (row.admission_registration_fee || ""))
  : (row.admission_registration_fee || ""),
    // Accounts side
   accounts_payment_status: canAccounts
  ? pickPaymentStatus(req.body, row.accounts_payment_status || "")
  : (row.accounts_payment_status || ""),
    accounts_paid_upto: canAccounts
      ? (typeof paidUpto !== "undefined" && paidUpto !== null ? paidUpto : (row.accounts_paid_upto || ""))
      : (row.accounts_paid_upto || ""),
    accounts_verification_number: canAccounts
      ? (typeof verificationNumber !== "undefined" && verificationNumber !== null ? verificationNumber : (row.accounts_verification_number || ""))
      : (row.accounts_verification_number || ""),
    accounts_registration_number: canAccounts
      ? (typeof registrationNumber !== "undefined" && registrationNumber !== null ? cleanRegistrationNumber : (row.accounts_registration_number || ""))
      : (row.accounts_registration_number || ""),
      fee_history: JSON.stringify(feeHistory),
      monthly_fee_current: incomingFeeNumber > 0 ? incomingFeeNumber : (dues.currentFee || baseFee || 0),
      admission_total_fees: String(dues.expected || 0),
      admission_pending_dues: String(dues.pending || 0),
  };

  db.prepare(`
    UPDATE admissions
     SET status = @status,
         feeStatus = @feeStatus,
         student_name = @student_name,
         father_name = @father_name,
         father_email = @father_email,
         grade = @grade,
         tuition_grade = @tuition_grade,
         phone = @phone,
         accounts_payment_status = @accounts_payment_status,
         accounts_paid_upto = @accounts_paid_upto,
         accounts_verification_number = @accounts_verification_number,
         accounts_registration_number = @accounts_registration_number,
         accounts_family_number = @accounts_family_number,
         admission_registration_fee = @admission_registration_fee,
         admission_fees = @admission_fees,
         currency_code = @currency_code,
         admission_month = @admission_month,
         fee_history = @fee_history,
         monthly_fee_current = @monthly_fee_current,
         admission_total_fees = @admission_total_fees,
         admission_pending_dues = @admission_pending_dues
         WHERE id = @id
  `).run({ id, ...updated });

  const afterRow = { ...row, ...updated };
  const after = buildPipelineSnapshotFromRow(afterRow);

  logAudit("pipeline_admin_update", user, {
    dept: row.dept,
    details: { admissionId: id, before, after },
  });

  // ✅ NEW: Real-time notify all dashboards
  emitAdmissionChanged(req, { type: "admin_update", admissionId: id, dept: row.dept });

  return res.redirect("/dashboard");
});

app.post("/pipeline/update/:id", requireLogin, requirePerm("btnUpdateRow"), (req, res) => {
  const user = req.session.user;

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send("Invalid id");

  const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(id);
  if (!row) return res.status(404).send("Not found");
  const before = buildPipelineSnapshotFromRow(row);

  // ✅ dept restriction for non-super
  if (user?.role !== "super_admin") {
    if (!user?.dept || row.dept !== user.dept) return res.status(403).send("Not allowed");
  }

  // ✅ Only update fields that are allowed columns
  const perms = getPerm(user);

  const {
    status,feeStatus,dept, student, father, father_email, grade, tuitionGrade, phone,
    paymentStatus, paidUpto, verificationNumber, registrationNumber,
    familyNumber, registrationFee,  fees, month, currencyCode, currency_code,  currency // ✅ ADD
  } = req.body;
  
    const cleanRegistrationNumber = String(registrationNumber || "").trim();
  const duplicateReg = checkDuplicateRegistrationNumber(cleanRegistrationNumber, id);

  if (duplicateReg) {
    return res.status(409).json({
      success: false,
      message: "This registration number is already in use. Please enter another number."
    });
  }

 const billingJson = getBillingJsonFromRow(row);

const oldFeeSnapshot =
  parseFirstNumber(row?.monthly_fee_current || 0) ||
  parseFirstNumber(row?.admission_fees || 0) ||
  inferMonthlyFee(row, billingJson) ||
  0;

const incomingFeeNumber = parseFirstNumber(fees ?? "");

let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
const effectivePaidUpto =
  computePaidUptoFromBillingJson(billingJson) ||
  paidUpto ||
  row.accounts_paid_upto ||
  "";
feeHistory = applyFeeChangeIfNeeded(
  row,
  user,
  incomingFeeNumber,
  oldFeeSnapshot,
  effectivePaidUpto
);

const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, incomingFeeNumber || oldFeeSnapshot);
const dues = calcPendingDues(baseFee, billingJson, feeHistory);
  const updated = {
    status: perms.colStatus ? (status ?? row.status) : row.status,
    feeStatus: perms.colFeeStatus ? (feeStatus ?? row.feeStatus) : row.feeStatus, 
    dept: perms.colDept ? (dept ?? row.dept) : row.dept,
    student_name: perms.colStudentName ? (student ?? row.student_name) : row.student_name,
    father_name: perms.colFatherName ? (father ?? row.father_name) : row.father_name,
    father_email: perms.colFatherEmail ? (father_email ?? row.father_email) : row.father_email,
    grade: perms.colGrade ? (grade ?? row.grade) : row.grade,
    tuition_grade: perms.colTuitionGrade ? (tuitionGrade ?? row.tuition_grade) : row.tuition_grade,
    phone: perms.colPhone ? (phone ?? row.phone) : row.phone,

    accounts_payment_status: perms.colPaymentStatus
  ? pickPaymentStatus(req.body, row.accounts_payment_status || "")
  : row.accounts_payment_status,
    accounts_paid_upto: perms.colPaidUpto ? (paidUpto ?? row.accounts_paid_upto) : row.accounts_paid_upto,
    accounts_verification_number: perms.colVerificationNumber ? (verificationNumber ?? row.accounts_verification_number) : row.accounts_verification_number,
    accounts_registration_number: perms.colRegistrationNumber ? (cleanRegistrationNumber || row.accounts_registration_number) : row.accounts_registration_number,
    accounts_family_number: perms.colFamilyNumber ? (familyNumber ?? row.accounts_family_number) : row.accounts_family_number,
   admission_registration_fee: perms.colRegistrationFee
  ? ((typeof registrationFee !== "undefined" && registrationFee !== null && String(registrationFee).trim() !== "")
      ? String(registrationFee).trim()
      : (row.admission_registration_fee || ""))
  : (row.admission_registration_fee || ""),
   admission_fees: perms.colFees
  ? ((typeof fees !== "undefined" && fees !== null && String(fees).trim() !== "") ? String(fees).trim() : (row.admission_fees || ""))
  : (row.admission_fees || ""),
   currency_code: perms.colCurrency
  ? pickCurrencyCode(req.body, row.currency_code || "")
  : (row.currency_code || ""),
    admission_month: perms.colMonth ? (month ?? row.admission_month) : row.admission_month,
    fee_history: JSON.stringify(feeHistory),
    monthly_fee_current: incomingFeeNumber > 0 ? incomingFeeNumber : (dues.currentFee || baseFee || 0),
    
    admission_total_fees: String(dues.expected || 0),
   admission_pending_dues: String(dues.pending || 0),
  };

  db.prepare(`
    UPDATE admissions
       SET dept=@dept,
           status=@status,
           feeStatus=@feeStatus,
           student_name=@student_name,
           father_name=@father_name,
           father_email=@father_email,
           grade=@grade,
           tuition_grade=@tuition_grade,
           phone=@phone,
           accounts_payment_status=@accounts_payment_status,
           accounts_paid_upto=@accounts_paid_upto,
           accounts_verification_number=@accounts_verification_number,
           accounts_registration_number=@accounts_registration_number,
           accounts_family_number=@accounts_family_number,
           admission_registration_fee=@admission_registration_fee,
           admission_fees=@admission_fees,
           currency_code=@currency_code,
           admission_month=@admission_month,
           fee_history=@fee_history,
           monthly_fee_current=@monthly_fee_current,
           
           admission_total_fees=@admission_total_fees,
           admission_pending_dues=@admission_pending_dues
     WHERE id=@id
  `).run({ id, ...updated });
  const afterRow = { ...row, ...updated };
const after = buildPipelineSnapshotFromRow(afterRow);

const eventType =
  user?.role === "sub_agent" ? "pipeline_sub_agent_update" : "pipeline_agent_update";

logAudit(eventType, user, {
  dept: row.dept,
  details: {
    admissionId: id,
    before,
    after,
  },
});


  emitAdmissionChanged(req, { type: "pipeline_update", admissionId: id, dept: row.dept });

  return res.redirect("/dashboard");
});
app.post("/uploads", requireLogin, requirePerm("btnUpload"), upload.single("file"), (req, res) => {
  try {
    const user = req.session.user;
    const f = req.file;

    const admissionId = req.body.admission_id ? parseInt(req.body.admission_id, 10) : null;
    if (!f) return res.status(400).json({ success: false, message: "No file received" });

    // dept restriction
    if (user?.role !== "super_admin") {
      if (!user?.dept) return res.status(403).json({ success: false, message: "Dept missing" });
      if (admissionId) {
        const row = db.prepare("SELECT dept FROM admissions WHERE id = ?").get(admissionId);
        if (!row) return res.status(404).json({ success: false, message: "Admission not found" });
        if (row.dept !== user.dept) return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }

   const relPath = toPosix(path.relative(uploadsDir, f.path));
   const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relPath}`;

  db.prepare(`
  INSERT INTO uploads (admission_id, original_name, stored_name, file_url, mime_type, size)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  admissionId || null,
  f.originalname || "",
  relPath,
  fileUrl,
  f.mimetype || "",
  f.size || 0
);


    return res.json({ success: true, message: "Uploaded" });
  } catch (err) {
    console.error("upload error:", err);
    return res.status(500).json({ success: false, message: "Upload failed" });
  }
});
app.get("/files", requireLogin, requirePerm("btnFiles"), (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    const admissionId = req.query.admission_id ? parseInt(req.query.admission_id, 10) : null;
    if (!admissionId) return res.status(400).send("Invalid admission_id");

    let familyNumber = "";
    let familyAdmissionIds = [];

    const adm = db.prepare(`
  SELECT id, dept, student_name, accounts_family_number
  FROM admissions
  WHERE id = ?
`).get(admissionId);

if (!adm) return res.status(404).send("Admission not found");

if (user?.role !== "super_admin") {
  if (!user?.dept || adm.dept !== user.dept) return res.status(403).send("Not allowed");
}

familyNumber = String(adm.accounts_family_number || "").trim();

if (familyNumber) {
  if (user?.role === "super_admin") {
    familyAdmissionIds = db.prepare(`
      SELECT id
      FROM admissions
      WHERE accounts_family_number = ?
      ORDER BY id DESC
    `).all(familyNumber).map(r => r.id);
  } else {
    familyAdmissionIds = db.prepare(`
      SELECT id
      FROM admissions
      WHERE accounts_family_number = ?
        AND dept = ?
      ORDER BY id DESC
    `).all(familyNumber, user.dept).map(r => r.id);
  }
} else {
  familyAdmissionIds = [admissionId];
}

   let files = [];

if (familyAdmissionIds.length > 0) {
  const placeholders = familyAdmissionIds.map(() => "?").join(",");

  files = db.prepare(`
    SELECT
      u.*,
      a.student_name AS student_name,
      a.accounts_family_number AS family_number,
      a.id AS linked_admission_id
    FROM uploads u
    LEFT JOIN admissions a ON a.id = u.admission_id
    WHERE u.admission_id IN (${placeholders})
    ORDER BY u.id DESC
  `).all(...familyAdmissionIds);
}

   return res.render("super-files", {
  user,
  perms,
  files,
  pageTitle: "Uploaded Files",
  admissionId,
  familyNumber: familyNumber || null,
  familyAdmissionIds,
});
  } catch (err) {
    console.error("GET /files error:", err);
    return res.status(500).send("DB error");
  }
});

app.delete("/files/:id", requireLogin, requirePerm("canDeleteFiles"), (req, res) => {
  try {
    const user = req.session.user;

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: "Invalid file id" });

    const fileRow = db.prepare("SELECT * FROM uploads WHERE id = ?").get(id);
    if (!fileRow) return res.status(404).json({ success: false, message: "File not found" });

    const adm = db.prepare("SELECT dept FROM admissions WHERE id = ?").get(fileRow.admission_id);
    if (!adm) return res.status(404).json({ success: false, message: "Admission not found" });

    if (user?.role !== "super_admin") {
      if (!user?.dept || adm.dept !== user.dept) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }

    const filePath = path.join(__dirname, "uploads", fileRow.stored_name || "");
    if (fileRow.stored_name && fs.existsSync(filePath)) fs.unlinkSync(filePath);

    db.prepare("DELETE FROM uploads WHERE id = ?").run(id);

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /files/:id error:", err);
    return res.status(500).json({ success: false, message: "Delete failed" });
  }
});
// =========================
// Agent: View My Sub Agents
// =========================
// app.get("/dashboard/agent/users", requireLogin, (req, res) => {
//   try {
//     const user = req.session.user;

//     // ✅ only agent/sub_agent allowed
//     const isAgent =
//       user?.role === "agent" ||
//       user?.role === "sub_agent" ||
//       user?.agentType === "accounts" ||
//       user?.agentType === "admission" ||
//       user?.agentType === "management";

//     if (!isAgent) {
//       return res.status(403).send("Forbidden");
//     }

//     // ✅ better-sqlite3 style
//     // show only sub agents created by this agent AND same dept
//     const mySubAgents = db
//       .prepare(
//         `
//         SELECT id, name, email, role, dept, agentType, managerId, permissions, createdAt
//         FROM users
//         WHERE role = 'sub_agent'
//           AND dept = ?
//           AND managerId = ?
//         ORDER BY id DESC
//         `
//       )
//       .all(user.dept, user.id);

//     return res.render("agent-users", {
//       user,
//       mySubAgents,
//       perms: req.session.perms || user.permissions || null,
//     });
//   } catch (err) {
//     console.error("agent users route error:", err);
//     return res.status(500).send("Server error");
//   }
// });
// ======================= AGENT: MY SUB AGENTS =======================
// =========================
// AGENT: MY SUB AGENTS (CLEAN)
// =========================

// List (NO DUPLICATE)
app.get("/dashboard/agent/users", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    if (!user || user.role !== "agent") return res.status(403).send("Not allowed");

   const mySubAgents = db.prepare(`
  SELECT
    id,
    name,
    email,
    role,
    dept,
    agentType,
    managerId,
    permissions,
    createdAt,
    lastUpdatedBy,
    lastUpdatedByRole,
    lastUpdatedAt,
    updateNoticeUnread
  FROM users
  WHERE role = 'sub_agent'
    AND dept = ?
    AND managerId = ?
  ORDER BY id DESC
`).all(user.dept, user.id);

    return res.render("agent-users", {
      user,
      mySubAgents,
      perms: getPerm(user),
    });
  } catch (e) {
    console.error("agent users route error:", e);
    return res.status(500).send("Server error");
  }
});

// Edit page (GET)
app.get("/dashboard/agent/users/:id/edit", requireLogin, (req, res) => {
  const user = req.session.user;
  if (!user || user.role !== "agent") return res.status(403).send("Not allowed");

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send("Invalid id");

  const row = db.prepare(`
    SELECT *
    FROM users
    WHERE id = ?
      AND role = 'sub_agent'
      AND dept = ?
      AND managerId = ?
  `).get(id, user.dept, user.id);

  if (!row) return res.status(403).send("Not allowed");

  const editUser = mapUserRow(row);
  editUser.permissions = getPerm(editUser);

  return res.render("admin-user-edit", {
    user,
    perms: getPerm(user),
    editUser,
    targetUser: editUser,
    basePath: "/dashboard/agent",
    error: null,
  });
});

// Edit save (POST)
app.post("/dashboard/agent/users/:id/edit", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    if (!user || user.role !== "agent") return res.status(403).send("Not allowed");

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send("Invalid id");

    const owned = db.prepare(`
      SELECT *
      FROM users
      WHERE id = ?
        AND role = 'sub_agent'
        AND dept = ?
        AND managerId = ?
    `).get(id, user.dept, user.id);

    if (!owned) return res.status(403).send("Not allowed");

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();

    const allowedAgentTypes = ["accounts", "admission", "management"];
    const agentTypeRaw = String(req.body.agentType || "").trim();
    const safeAgentType = allowedAgentTypes.includes(agentTypeRaw)
      ? agentTypeRaw
      : (owned.agentType || null);

    // ✅ Agent can grant only what agent has
    const parentPerms = getPerm(user);

    const finalPerms = {};
    for (const key of PERMISSION_KEYS) {
      finalPerms[key] = parentPerms[key] ? isOn(req.body[key]) : false;
    }

    db.prepare(`
      UPDATE users
         SET name=@name,
             email=@email,
             agentType=@agentType,
             permissions=@permissions,
             lastUpdatedBy=@lastUpdatedBy,
             lastUpdatedByRole=@lastUpdatedByRole,
             lastUpdatedAt=@lastUpdatedAt,
             updateNoticeUnread=1
       WHERE id=@id
         AND role='sub_agent'
         AND dept=@dept
         AND managerId=@managerId
    `).run({
      id,
      name,
      email,
      agentType: safeAgentType,
      permissions: JSON.stringify(finalPerms),
      lastUpdatedBy: user.name,
      lastUpdatedByRole: user.role,
      lastUpdatedAt: new Date().toISOString(),
      dept: user.dept,
      managerId: user.id,
    });
    try {
  const ioRef = req.app.get("io");
  if (ioRef) {
    ioRef.emit("user:updated", { userId: id, ts: Date.now() });
  }
} catch (e) {}

    // ✅ audit
    logAudit("user_updated_by_agent", user, {
      targetUserId: id,
      targetUserName: name,
      dept: user.dept,
      details: { agentType: safeAgentType || null, permissions: finalPerms },
    });

    req.session.flash = {
      type: "success",
      title: "User updated",
      message: "User updated successfully.",
    };

    return res.redirect("/dashboard/agent/users");
  } catch (e) {
    console.error("agent user edit error:", e);
    return res.status(500).send("Server error");
  }
});

// Delete (POST)
app.post("/dashboard/agent/users/:id/delete", requireLogin, (req, res) => {
  const user = req.session.user;
  if (!user || user.role !== "agent") return res.status(403).send("Not allowed");

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send("Invalid id");

  const row = db.prepare(`
    SELECT id, name
    FROM users
    WHERE id = ?
      AND role = 'sub_agent'
      AND dept = ?
      AND managerId = ?
  `).get(id, user.dept, user.id);

  if (!row) return res.status(403).send("Not allowed");

  db.prepare(`
    DELETE FROM users
    WHERE id = ?
      AND role = 'sub_agent'
      AND dept = ?
      AND managerId = ?
  `).run(id, user.dept, user.id);

  logAudit("user_deleted_by_agent", user, {
    targetUserId: id,
    targetUserName: row.name,
    dept: user.dept,
    details: { role: "sub_agent" },
  });

  req.session.flash = {
    type: "success",
    title: "User deleted",
    message: "User deleted successfully.",
  };

  return res.redirect("/dashboard/agent/users");
});

/* ========== Root redirect ========== */
app.get("/", (req, res) => {
  res.redirect("/login");
});

/* ========== Start server ========== */
const PORT = Number(process.env.PORT) || 3000;

httpServer.listen(PORT, "0.0.0.0", () => {
  const host = "0.0.0.0";
  console.log(`Server running:
  - Local:  http://localhost:${PORT}
  - LAN:    http://${host}:${PORT}  (Use your PC IPv4, e.g. http://192.168.18.26:${PORT})`);
});