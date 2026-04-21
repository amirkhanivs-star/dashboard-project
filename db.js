// db.js  (ES module)

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DB file path
const dbPath = path.join(__dirname, "data", "ivs-dashboard.db");
const db = new Database(dbPath);

// Better reliability
db.pragma("journal_mode = WAL");

// ================== ✅ PERMISSIONS SCHEMA ==================
const PERMISSION_KEYS = [
  "colStatus",
  "colFeeStatus",
  "colDept",
  "colStudentName",
  "colFatherName",
  "colFatherEmail",
  "colGrade",
  "colTuitionGrade",
  "colPhone",
  "colProcessedBy",
  "colPaymentStatus",
  "colPaidUpto",
  "colVerificationNumber",
  "colRegistrationNumber",
  "colFamilyNumber",
  "colRegistrationFee",
  "colFees",
  "colCurrency",
  "colMonth",
  "colTotalFees",
  "colPendingDues",
  "colReceivedPayment",
  "colInvoiceStatus",
  "colInvoiceStatusTimestamp",
  "colPaidInvoiceStatus",
  "colPaidInvoiceStatusTimestamp",
  "colActionButtons",

  "btnEditRow",
  "btnUpdateRow",
  "btnPdf",
  "btnBilling",
  "btnWhatsApp",
  "btnUpload",
  "btnFiles",
  "btnDetails",

  "canDeleteFiles",
  "canDeleteAdmissions",
];

const LEGACY_MAP = {
  showPhone: "colPhone",
  showPaymentStatus: "colPaymentStatus",
  showPaidUpto: "colPaidUpto",
  showVerificationNumber: "colVerificationNumber",
  showRegistrationNumber: "colRegistrationNumber",
};

function safeParseJson(str, fallback = {}) {
  try {
    if (!str) return fallback;
    if (typeof str === "object") return str;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function buildDefaultPermissions(role) {
  const isSuper = role === "super_admin";
  const obj = {};
  for (const k of PERMISSION_KEYS) obj[k] = isSuper ? true : false;
  return obj;
}

function normalizePermissions(rawPermissions, role) {
  const isSuper = role === "super_admin";
  const raw = safeParseJson(rawPermissions, {});

  for (const [legacyKey, newKey] of Object.entries(LEGACY_MAP)) {
    if (typeof raw[newKey] === "undefined" && typeof raw[legacyKey] !== "undefined") {
      raw[newKey] = !!raw[legacyKey];
    }
  }

  const clean = {};
  for (const key of PERMISSION_KEYS) clean[key] = !!raw[key];

  if (isSuper) for (const key of PERMISSION_KEYS) clean[key] = true;
  return clean;
}

// ================== TABLES ==================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('super_admin','admin','agent','sub_agent')),
    dept TEXT,
    agentType TEXT,
    managerId INTEGER,
    permissions TEXT,
    lastUpdatedBy TEXT,
    lastUpdatedByRole TEXT,
    lastUpdatedAt TEXT,
    updateNoticeUnread INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    actorId INTEGER,
    actorName TEXT,
    actorRole TEXT,
    actorDept TEXT,
    eventType TEXT NOT NULL,
    targetUserId INTEGER,
    targetUserName TEXT,
    dept TEXT,
    details TEXT
  );

  CREATE TABLE IF NOT EXISTS admissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    dept TEXT,
    status TEXT,
    feeStatus TEXT,

    student_name TEXT,
    gender TEXT,
    dob TEXT,
    grade TEXT,
    father_name TEXT,
    guardian_whatsapp TEXT,
    religion TEXT,
    father_email TEXT,
    father_occupation TEXT,
    nationality TEXT,
    present_address TEXT,
    city TEXT,
    state TEXT,
    secondary_contact TEXT,
    session TEXT,
    registration_date TEXT,
    processed_by TEXT,

    tuition_grade TEXT,
    phone TEXT,

    accounts_payment_status TEXT,
    accounts_paid_upto TEXT,
    accounts_verification_number TEXT,
    accounts_registration_number TEXT,
    accounts_family_number TEXT,

    admission_registration_fee TEXT,
    admission_fees TEXT,
    fee_history TEXT,
    admission_month TEXT,

    admission_total_paid TEXT,
    admission_total_fees TEXT,
    admission_pending_dues TEXT,

    admission_invoice_status TEXT,
    admission_invoice_status_timestamp TEXT,
    admission_paid_invoice_status TEXT,
    admission_paid_invoice_status_timestamp TEXT,

    january TEXT,
    february TEXT,
    march TEXT,
    april TEXT,
    may TEXT,
    june TEXT,
    july TEXT,
    august TEXT,
    september TEXT,
    october TEXT,
    november TEXT,
    december TEXT,

    whatsapp TEXT,
       pdf_path TEXT,

    is_deleted INTEGER DEFAULT 0,
    deleted_at TEXT,
    deleted_by TEXT,
    deleted_by_id INTEGER,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_id INTEGER,
    original_name TEXT,
    stored_name TEXT,
    file_url TEXT,
    mime_type TEXT,
    size INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS whatsapp_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opt_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    is_custom INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS status_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opt_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    is_custom INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payment_status_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opt_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    is_custom INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

    CREATE TABLE IF NOT EXISTS billing_status_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opt_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    is_custom INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bank_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opt_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  is_custom INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admission_billing_yearly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id INTEGER NOT NULL,
  billing_year INTEGER NOT NULL,
  month_key TEXT NOT NULL,
  status TEXT,
  amount_received TEXT,
  fee_amount TEXT,
  payment_date TEXT,
  verification_number TEXT,
  bank_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(admission_id, billing_year, month_key)
);
`);

function ensureColumn(table, column, type) {
  try {
    db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes("no such column")) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`Added missing column ${column} on ${table}`);
      } catch (e2) {
        console.error(`Failed to add column ${column} on ${table}:`, e2.message);
      }
    }
  }
}

function hasColumn(table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => r && r.name === column);
  } catch (e) {
    return false;
  }
}

function tableExists(table) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table);
    return !!row;
  } catch {
    return false;
  }
}

ensureColumn("users", "dept", "TEXT");
ensureColumn("users", "agentType", "TEXT");
ensureColumn("users", "managerId", "INTEGER");
ensureColumn("users", "permissions", "TEXT");
ensureColumn("users", "lastUpdatedBy", "TEXT");
ensureColumn("users", "lastUpdatedByRole", "TEXT");
ensureColumn("users", "lastUpdatedAt", "TEXT");
ensureColumn("users", "updateNoticeUnread", "INTEGER DEFAULT 0");
ensureColumn("users", "createdAt", "TEXT");
try { db.exec(`UPDATE users SET createdAt = COALESCE(createdAt, CURRENT_TIMESTAMP)`); } catch {}
ensureColumn("users", "updatedAt", "TEXT");

ensureColumn("audit_logs", "actorDept", "TEXT");
ensureColumn("audit_logs", "dept", "TEXT");

ensureColumn("admissions", "status", "TEXT");
ensureColumn("admissions", "feeStatus", "TEXT");
ensureColumn("admissions", "tuition_grade", "TEXT");
ensureColumn("admissions", "phone", "TEXT");
ensureColumn("admissions", "processed_by", "TEXT");
ensureColumn("admissions", "father_email", "TEXT");
ensureColumn("admissions", "accounts_payment_status", "TEXT");
ensureColumn("admissions", "accounts_paid_upto", "TEXT");
ensureColumn("admissions", "accounts_verification_number", "TEXT");
ensureColumn("admissions", "accounts_registration_number", "TEXT");
ensureColumn("admissions", "accounts_family_number", "TEXT");
ensureColumn("admissions", "admission_registration_fee", "TEXT");
ensureColumn("admissions", "admission_fees", "TEXT");
ensureColumn("admissions", "currency_code", "TEXT DEFAULT 'SAR'");
ensureColumn("admissions", "fee_history", "TEXT");
ensureColumn("admissions", "admission_month", "TEXT");
ensureColumn("admissions", "admission_total_paid", "TEXT");
ensureColumn("admissions", "admission_total_fees", "TEXT");
ensureColumn("admissions", "admission_pending_dues", "TEXT");

ensureColumn("admissions", "admission_invoice_status", "TEXT");
ensureColumn("admissions", "admission_invoice_status_timestamp", "TEXT");
ensureColumn("admissions", "admission_paid_invoice_status", "TEXT");
ensureColumn("admissions", "admission_paid_invoice_status_timestamp", "TEXT");

ensureColumn("admissions", "january", "TEXT");
ensureColumn("admissions", "february", "TEXT");
ensureColumn("admissions", "march", "TEXT");
ensureColumn("admissions", "april", "TEXT");
ensureColumn("admissions", "may", "TEXT");
ensureColumn("admissions", "june", "TEXT");
ensureColumn("admissions", "july", "TEXT");
ensureColumn("admissions", "august", "TEXT");
ensureColumn("admissions", "september", "TEXT");
ensureColumn("admissions", "october", "TEXT");
ensureColumn("admissions", "november", "TEXT");
ensureColumn("admissions", "december", "TEXT");

ensureColumn("admissions", "billing_json", "TEXT");
ensureColumn("admissions", "monthly_fee_current", "REAL");
ensureColumn("admissions", "has_extra_fee", "INTEGER");
ensureColumn("admissions", "whatsapp", "TEXT");
ensureColumn("admissions", "pdf_path", "TEXT");
ensureColumn("admissions", "is_deleted", "INTEGER DEFAULT 0");
ensureColumn("admissions", "deleted_at", "TEXT");
ensureColumn("admissions", "deleted_by", "TEXT");
ensureColumn("admissions", "deleted_by_id", "INTEGER");
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admissions_unique_reg_no
    ON admissions(accounts_registration_number)
    WHERE accounts_registration_number IS NOT NULL
      AND TRIM(accounts_registration_number) <> '';
  `);
} catch (e) {
  console.error("unique reg index error:", e.message);
}

ensureColumn("uploads", "admission_id", "INTEGER");
ensureColumn("uploads", "original_name", "TEXT");
ensureColumn("uploads", "stored_name", "TEXT");
ensureColumn("uploads", "file_url", "TEXT");
ensureColumn("uploads", "mime_type", "TEXT");
ensureColumn("uploads", "size", "INTEGER");
ensureColumn("uploads", "created_at", "TEXT");

ensureColumn("status_options", "opt_key", "TEXT");
ensureColumn("status_options", "label", "TEXT");
ensureColumn("status_options", "color", "TEXT DEFAULT '#64748b'");
ensureColumn("status_options", "is_custom", "INTEGER DEFAULT 0");
ensureColumn("status_options", "created_at", "TEXT");

ensureColumn("payment_status_options", "opt_key", "TEXT");
ensureColumn("payment_status_options", "label", "TEXT");
ensureColumn("payment_status_options", "color", "TEXT DEFAULT '#64748b'");
ensureColumn("payment_status_options", "is_custom", "INTEGER DEFAULT 0");
ensureColumn("payment_status_options", "created_at", "TEXT");

if (!tableExists("billing_status_options")) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_status_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opt_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#64748b',
      is_custom INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

ensureColumn("billing_status_options", "opt_key", "TEXT");
ensureColumn("billing_status_options", "label", "TEXT");
ensureColumn("billing_status_options", "color", "TEXT DEFAULT '#64748b'");
ensureColumn("billing_status_options", "is_custom", "INTEGER DEFAULT 0");
ensureColumn("billing_status_options", "created_at", "TEXT");

if (!tableExists("currency_options")) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS currency_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opt_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      is_custom INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

ensureColumn("currency_options", "opt_key", "TEXT");
ensureColumn("currency_options", "label", "TEXT");
ensureColumn("currency_options", "is_custom", "INTEGER DEFAULT 0");
ensureColumn("currency_options", "created_at", "TEXT");

if (!tableExists("bank_options")) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opt_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      is_custom INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

ensureColumn("bank_options", "opt_key", "TEXT");
ensureColumn("bank_options", "label", "TEXT");
ensureColumn("bank_options", "is_custom", "INTEGER DEFAULT 0");
ensureColumn("bank_options", "created_at", "TEXT");

if (!tableExists("admission_billing_yearly")) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admission_billing_yearly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_id INTEGER NOT NULL,
      billing_year INTEGER NOT NULL,
      month_key TEXT NOT NULL,
      status TEXT,
      amount_received TEXT,
      fee_amount TEXT,
      payment_date TEXT,
      verification_number TEXT,
      bank_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(admission_id, billing_year, month_key)
    );
  `);
}

ensureColumn("admission_billing_yearly", "admission_id", "INTEGER");
ensureColumn("admission_billing_yearly", "billing_year", "INTEGER");
ensureColumn("admission_billing_yearly", "month_key", "TEXT");
ensureColumn("admission_billing_yearly", "status", "TEXT");
ensureColumn("admission_billing_yearly", "amount_received", "TEXT");
ensureColumn("admission_billing_yearly", "fee_amount", "TEXT");
ensureColumn("admission_billing_yearly", "payment_date", "TEXT");
ensureColumn("admission_billing_yearly", "verification_number", "TEXT");
ensureColumn("admission_billing_yearly", "bank_name", "TEXT");
ensureColumn("admission_billing_yearly", "created_at", "TEXT");
ensureColumn("admission_billing_yearly", "updated_at", "TEXT");

try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admission_billing_yearly_unique
    ON admission_billing_yearly(admission_id, billing_year, month_key);
  `);
} catch (e) {
  console.error("admission_billing_yearly unique index error:", e.message);
}

// ================== ✅ MIGRATE OLD status_options STRUCTURE IF NEEDED ==================
try {
  const hasOldType = tableExists("status_options") && hasColumn("status_options", "type");
  const hasOldValue = tableExists("status_options") && hasColumn("status_options", "value");
  const hasNewOptKey = tableExists("status_options") && hasColumn("status_options", "opt_key");
  const hasNewLabel = tableExists("status_options") && hasColumn("status_options", "label");

  if ((hasOldType || hasOldValue) && (!hasNewOptKey || !hasNewLabel)) {
    db.exec("BEGIN");

    const oldRows = db.prepare(`
      SELECT
        id,
        type,
        value,
        color,
        created_by_user_id,
        created_at,
        updated_at
      FROM status_options
    `).all();

    db.exec(`ALTER TABLE status_options RENAME TO status_options_old;`);

    db.exec(`
      CREATE TABLE status_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opt_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#64748b',
        is_custom INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS billing_status_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opt_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#64748b',
        is_custom INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
     );

      CREATE TABLE IF NOT EXISTS currency_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opt_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        is_custom INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
   );

      CREATE TABLE IF NOT EXISTS bank_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opt_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        is_custom INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_status_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opt_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#64748b',
        is_custom INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const insStatus = db.prepare(`
      INSERT OR IGNORE INTO status_options (opt_key, label, color, is_custom, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insFee = db.prepare(`
      INSERT OR IGNORE INTO payment_status_options (opt_key, label, color, is_custom, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const r of oldRows) {
      const label = String(r?.value || "").trim();
      if (!label) continue;

      const optKey = label;
      const color = String(r?.color || "#64748b").trim() || "#64748b";
      const createdAt = r?.created_at || new Date().toISOString();
      const isCustom = 1;

      if (String(r?.type || "").trim() === "fee") {
        insFee.run(optKey, label, color, isCustom, createdAt);
      } else {
        insStatus.run(optKey, label, color, isCustom, createdAt);
      }
    }

    db.exec(`DROP TABLE status_options_old;`);
    db.exec("COMMIT");
    console.log("Migrated old status_options structure to new status/payment tables");
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("status_options migration error:", e.message);
}

// ================== ✅ REMOVE OLD FEE/STATUS COLUMNS (SAFE REBUILD) ==================
try {
  const hasCurrentStatus = hasColumn("admissions", "current_status");
  const hasFeeStatusOld = hasColumn("admissions", "fee_status");

  if (hasCurrentStatus || hasFeeStatusOld) {
    db.exec("BEGIN");

    db.exec(`
      CREATE TABLE IF NOT EXISTS admissions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        dept TEXT,
        status TEXT,
        feeStatus TEXT,

        student_name TEXT,
        gender TEXT,
        dob TEXT,
        grade TEXT,
        father_name TEXT,
        guardian_whatsapp TEXT,
        religion TEXT,
        father_email TEXT,
        father_occupation TEXT,
        nationality TEXT,
        present_address TEXT,
        city TEXT,
        state TEXT,
        secondary_contact TEXT,
        session TEXT,
        registration_date TEXT,
        processed_by TEXT,

        tuition_grade TEXT,
        phone TEXT,

        accounts_payment_status TEXT,
        accounts_paid_upto TEXT,
        accounts_verification_number TEXT,
        accounts_registration_number TEXT,
        accounts_family_number TEXT,

        admission_registration_fee TEXT,
        admission_fees TEXT,
        currency_code TEXT DEFAULT 'SAR',
        fee_history TEXT,
        admission_month TEXT,

        admission_total_paid TEXT,
        admission_total_fees TEXT,
        admission_pending_dues TEXT,

        admission_invoice_status TEXT,
        admission_invoice_status_timestamp TEXT,
        admission_paid_invoice_status TEXT,
        admission_paid_invoice_status_timestamp TEXT,
        

        january TEXT,
        february TEXT,
        march TEXT,
        april TEXT,
        may TEXT,
        june TEXT,
        july TEXT,
        august TEXT,
        september TEXT,
        october TEXT,
        november TEXT,
        december TEXT,

        billing_json TEXT,
        monthly_fee_current REAL,
        has_extra_fee INTEGER,

               whatsapp TEXT,
        pdf_path TEXT,

        is_deleted INTEGER DEFAULT 0,
        deleted_at TEXT,
        deleted_by TEXT,
        deleted_by_id INTEGER,

        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      INSERT INTO admissions_new (
        id,
        dept, status, feeStatus,
        student_name, gender, dob, grade, father_name, guardian_whatsapp, religion, father_email, father_occupation, nationality,
        present_address, city, state, secondary_contact, session, registration_date, processed_by,
        tuition_grade, phone,
        accounts_payment_status, accounts_paid_upto, accounts_verification_number, accounts_registration_number, accounts_family_number,
        admission_registration_fee, admission_fees, currency_code, fee_history, admission_month,
        admission_total_paid, admission_total_fees, admission_pending_dues,
        admission_invoice_status, admission_invoice_status_timestamp,
        admission_paid_invoice_status, admission_paid_invoice_status_timestamp,
        january, february, march, april, may, june, july, august, september, october, november, december,
        billing_json, monthly_fee_current, has_extra_fee,
                whatsapp, pdf_path,
        is_deleted, deleted_at, deleted_by, deleted_by_id,
        created_at
      )
      SELECT
        id,
        dept,
        COALESCE(NULLIF(status,''), ${hasCurrentStatus ? "current_status" : "NULL"}) AS status,
        COALESCE(NULLIF(feeStatus,''), ${hasFeeStatusOld ? "fee_status" : "NULL"}) AS feeStatus,

        student_name, gender, dob, grade, father_name, guardian_whatsapp, religion, father_email, father_occupation, nationality,
        present_address, city, state, secondary_contact, session, registration_date, processed_by,
        tuition_grade, phone,
        accounts_payment_status, accounts_paid_upto, accounts_verification_number, accounts_registration_number, accounts_family_number,
        admission_registration_fee, admission_fees, currency_code, fee_history, admission_month,
        admission_total_paid, admission_total_fees, admission_pending_dues,
        admission_invoice_status, admission_invoice_status_timestamp,
        admission_paid_invoice_status, admission_paid_invoice_status_timestamp,
        january, february, march, april, may, june, july, august, september, october, november, december,
        billing_json, monthly_fee_current, has_extra_fee,
               whatsapp, pdf_path,
        COALESCE(is_deleted, 0), deleted_at, deleted_by, deleted_by_id,
        created_at
      FROM admissions;
    `);

    db.exec(`DROP TABLE admissions;`);
    db.exec(`ALTER TABLE admissions_new RENAME TO admissions;`);

    db.exec("COMMIT");
    console.log("Rebuilt admissions table (removed current_status / fee_status)");
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("admissions rebuild error:", e.message);
}

// ================== ✅ PERMISSIONS MIGRATION ==================
try {
  const rows = db.prepare("SELECT id, role, permissions FROM users").all();
  const upd = db.prepare("UPDATE users SET permissions = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?");

  const tx = db.transaction(() => {
    for (const r of rows) {
      const normalized = normalizePermissions(r.permissions, r.role);
      upd.run(JSON.stringify(normalized), r.id);
    }
  });

  tx();
} catch (e) {
  console.error("permissions normalize error:", e.message);
}

// ================== ✅ Seed default WhatsApp options if table is empty ==================
try {
  const c = db.prepare("SELECT COUNT(*) AS c FROM whatsapp_options").get();
  if (!c || c.c === 0) {
    const ins = db.prepare("INSERT INTO whatsapp_options (opt_key, label, is_custom) VALUES (?, ?, ?)");
    const seed = db.transaction(() => {
      ins.run("send_fee_payment", "Send fee payment", 0);
      ins.run("send_invoice", "Send invoice", 0);
      ins.run("send_fee_reminder", "Send fee reminder", 0);
    });
    seed();
    console.log("Seeded whatsapp_options defaults");
  }
} catch (e) {
  console.error("whatsapp_options seed error:", e.message);
}

// ================== ✅ Ensure default status_options always exist ==================
try {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO status_options (opt_key, label, color, is_custom)
    VALUES (?, ?, ?, ?)
  `);

  const seed = db.transaction(() => {
    ins.run("New Admission", "New Admission", "#64748b", 0);
    ins.run("Running", "Running", "#22c55e", 0);
    ins.run("Leave", "Leave", "#f59e0b", 0);
    ins.run("Stop", "Stop", "#ef4444", 0);
    ins.run("Left", "Left", "#2563eb", 0);
    ins.run("Freez", "Freez", "#94a3b8", 0);
  });

  seed();
  console.log("Ensured status_options defaults");
} catch (e) {
  console.error("status_options seed error:", e.message);
}

// ================== ✅ Ensure default payment_status_options always exist ==================
try {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO payment_status_options (opt_key, label, color, is_custom)
    VALUES (?, ?, ?, ?)
  `);

  const seed = db.transaction(() => {
    ins.run("New Admission", "New Admission", "#64748b", 0);
    ins.run("Present + Dues", "Present + Dues", "#ef4444", 0);
    ins.run("Present + No Dues", "Present + No Dues", "#22c55e", 0);
  });

  seed();
  console.log("Ensured payment_status_options defaults");
} catch (e) {
  console.error("payment_status_options seed error:", e.message);
}

// ================== ✅ Ensure default billing_status_options always exist ==================
try {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO billing_status_options (opt_key, label, color, is_custom)
    VALUES (?, ?, ?, ?)
  `);

  const seed = db.transaction(() => {
    ins.run("Not admitted", "Not admitted", "#64748b", 0);
    ins.run("No payment", "No payment", "#ef4444", 0);
    ins.run("Partial payment", "Partial payment", "#f59e0b", 0);
    ins.run("Full payment", "Full payment", "#22c55e", 0);
  });

  seed();
  console.log("Ensured billing_status_options defaults");
} catch (e) {
  console.error("billing_status_options seed error:", e.message);
}

// ================== ✅ Ensure default currency_options always exist ==================
try {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO currency_options (opt_key, label, is_custom)
    VALUES (?, ?, ?)
  `);

  const seed = db.transaction(() => {
    ins.run("AED", "AED", 0);
    ins.run("SAR", "SAR", 0);
    ins.run("PKR", "PKR", 0);
    ins.run("USD", "USD", 0);
    ins.run("GBP", "GBP", 0);
  });

  seed();
  console.log("Ensured currency_options defaults");
} catch (e) {
  console.error("currency_options seed error:", e.message);
}

// ================== ✅ Ensure default bank_options always exist ==================
try {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO bank_options (opt_key, label, is_custom)
    VALUES (?, ?, ?)
  `);

  const seed = db.transaction(() => {
    ins.run("UBL SMC", "UBL SMC", 0);
    ins.run("MZ IVS", "MZ IVS", 0);
    ins.run("Mashreq bank", "Mashreq bank", 0);
    ins.run("MZ Ahmad Ali", "MZ Ahmad Ali", 0);
    ins.run("PayPal", "PayPal", 0);
    ins.run("UBL", "UBL", 0);
    ins.run("Pick Up", "Pick Up", 0);
    ins.run("EasyPaisa", "EasyPaisa", 0);
    ins.run("Summit", "Summit", 0);
    ins.run("Nomood payment", "Nomood payment", 0);
    ins.run("MZ solution", "MZ solution", 0);
    ins.run("FREE", "FREE", 0);
    ins.run("MZ ivs solution 7793", "MZ ivs solution 7793", 0);
    ins.run("UBL Ahmad Ali 6593", "UBL Ahmad Ali 6593", 0);
    ins.run("UBL solution 0322", "UBL solution 0322", 0);
  });

  seed();
  console.log("Ensured bank_options defaults");
} catch (e) {
  console.error("bank_options seed error:", e.message);
}

// ===============================
// ✅ Admission Details (Single)
// ===============================

try {
  const billingTableHasData = tableExists("admission_billing_yearly")
    ? db.prepare("SELECT COUNT(*) AS c FROM admission_billing_yearly").get()
    : { c: 0 };

  if (!billingTableHasData || billingTableHasData.c === 0) {
    const rows = db.prepare(`
      SELECT id, billing_json,
             january, february, march, april, may, june,
             july, august, september, october, november, december
      FROM admissions
    `).all();

    const monthsOrder = [
      "january","february","march","april","may","june",
      "july","august","september","october","november","december"
    ];

    const currentYear = new Date().getFullYear();

    const ins = db.prepare(`
      INSERT OR IGNORE INTO admission_billing_yearly (
        admission_id,
        billing_year,
        month_key,
        status,
        amount_received,
        fee_amount,
        payment_date,
        verification_number,
        bank_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const row of rows) {
        const parsed = safeParseJson(row.billing_json, null);

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const yearKeys = Object.keys(parsed).filter(k => /^\d{4}$/.test(String(k)));

          if (yearKeys.length > 0) {
            for (const y of yearKeys) {
              const yearData = parsed[y] || {};
              for (const month of monthsOrder) {
                const item = yearData[month] || {};
                ins.run(
                  row.id,
                  Number(y),
                  month,
                  item.status || item.paymentStatus || "",
                  item.amount ?? item.amountReceived ?? item.received ?? "",
                  item.fee ?? item.monthlyFee ?? "",
                  item.date || item.receivedOn || item.received_on || item.paidOn || "",
                  item.verificationNumber || item.verification_number || "",
                  item.bank || item.bank_name || ""
                );
              }
            }
            continue;
          }

          for (const month of monthsOrder) {
            const item = parsed[month] || {};
            ins.run(
              row.id,
              currentYear,
              month,
              item.status || item.paymentStatus || "",
              item.amount ?? item.amountReceived ?? item.received ?? "",
              item.fee ?? item.monthlyFee ?? "",
              item.date || item.receivedOn || item.received_on || item.paidOn || "",
              item.verificationNumber || item.verification_number || "",
              item.bank || item.bank_name || ""
            );
          }
          continue;
        }

        for (const month of monthsOrder) {
          ins.run(
            row.id,
            currentYear,
            month,
            "",
            row[month] || "",
            "",
            "",
            "",
            ""
          );
        }
      }
    });

    tx();
    console.log("Migrated old billing data into admission_billing_yearly");
  }
} catch (e) {
  console.error("billing migration error:", e.message);
}

function parseBillingFromJson(billingJson) {
  const data = safeParseJson(billingJson, null);

  // If already array -> normalize keys
  if (Array.isArray(data)) {
    return data.map((x) => ({
      month: x.month || x.key || "",
      status: x.status || x.paymentStatus || "",
      amount: x.amount ?? x.amountReceived ?? x.received ?? "",
      fee: x.fee ?? x.monthlyFee ?? "",
      date: x.date || x.receivedOn || x.received_on || x.paidOn || "",
      verificationNumber: x.verificationNumber || x.verification_number || "",
    }));
  }

  // If object like { january: {...}, february: {...} }
  if (data && typeof data === "object") {
    const monthsOrder = [
      "january","february","march","april","may","june",
      "july","august","september","october","november","december"
    ];

    return monthsOrder.map((m) => {
      const x = data[m] || {};
      return {
        month: m,
        status: x.status || x.paymentStatus || "",
        amount: x.amount ?? x.amountReceived ?? x.received ?? "",
        fee: x.fee ?? x.monthlyFee ?? "",
        date: x.date || x.receivedOn || x.received_on || x.paidOn || "",
        verificationNumber: x.verificationNumber || x.verification_number || "",
      };
    });
  }

  return null;
}

export function getAdmissionBillingByYear(admissionId, billingYear) {
  const monthsOrder = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december"
  ];

  const rows = db.prepare(`
    SELECT *
    FROM admission_billing_yearly
    WHERE admission_id = ? AND billing_year = ?
    ORDER BY CASE month_key
      WHEN 'january' THEN 1
      WHEN 'february' THEN 2
      WHEN 'march' THEN 3
      WHEN 'april' THEN 4
      WHEN 'may' THEN 5
      WHEN 'june' THEN 6
      WHEN 'july' THEN 7
      WHEN 'august' THEN 8
      WHEN 'september' THEN 9
      WHEN 'october' THEN 10
      WHEN 'november' THEN 11
      WHEN 'december' THEN 12
      ELSE 99
    END
  `).all(admissionId, billingYear);

  const byMonth = Object.fromEntries(rows.map(r => [r.month_key, r]));

  return monthsOrder.map((m) => {
    const x = byMonth[m] || {};
    return {
      month: m,
      status: x.status || "",
      amount: x.amount_received || "",
      fee: x.fee_amount || "",
      date: x.payment_date || "",
      verificationNumber: x.verification_number || "",
      bank: x.bank_name || "",
      year: billingYear,
    };
  });
}
export function saveAdmissionBillingMonthByYear({
  admissionId,
  billingYear,
  monthKey,
  status,
  amountReceived,
  feeAmount,
  paymentDate,
  verificationNumber,
  bankName,
}) {
  return db.prepare(`
    INSERT INTO admission_billing_yearly (
      admission_id,
      billing_year,
      month_key,
      status,
      amount_received,
      fee_amount,
      payment_date,
      verification_number,
      bank_name,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(admission_id, billing_year, month_key)
    DO UPDATE SET
      status = excluded.status,
      amount_received = excluded.amount_received,
      fee_amount = excluded.fee_amount,
      payment_date = excluded.payment_date,
      verification_number = excluded.verification_number,
      bank_name = excluded.bank_name,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    admissionId,
    billingYear,
    monthKey,
    status || "",
    amountReceived || "",
    feeAmount || "",
    paymentDate || "",
    verificationNumber || "",
    bankName || "",

  );
}

export function dbGetAdmissionDetailsById(id, billingYear = new Date().getFullYear()) {
  const row = db.prepare(`
  SELECT *
  FROM admissions
  WHERE id = ?
    AND COALESCE(is_deleted, 0) = 0
`).get(id);
  if (!row) return null;

  let billingArr = getAdmissionBillingByYear(id, billingYear);

  const hasAnyYearData = Array.isArray(billingArr) && billingArr.some(
    (x) => x.status || x.amount || x.fee || x.date || x.verificationNumber || x.bank
  );

  if (!hasAnyYearData) {
    let oldBillingArr = parseBillingFromJson(row.billing_json);

    if (!oldBillingArr) {
      const months = [
        "january","february","march","april","may","june",
        "july","august","september","october","november","december"
      ];

    oldBillingArr = months.map((m) => ({
  month: m,
  status: "",
  amount: row[m] || "",
  fee: "",
  date: "",
  verificationNumber: "",
  bank: "",
  year: billingYear,
}));
    }

    billingArr = oldBillingArr.map(item => ({
      ...item,
      year: billingYear,
      bank: item.bank || "",
    }));
  }

  return {
    id: row.id,
    dept: row.dept,
    status: row.status || "",
    feeStatus: row.feeStatus || "",

    student: row.student_name || "",
    father: row.father_name || "",
    fatherEmail: row.father_email || "",
    father_email: row.father_email || "",
    grade: row.grade || "",
    tuitionGrade: row.tuition_grade || "",
    phone: row.phone || "",
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
      month: row.admission_month || "",
      totalFees: row.admission_total_fees || "",
      pendingDues: row.admission_pending_dues || "",
      receivedPayment: row.admission_total_paid || "0",
      invoiceStatus: row.admission_invoice_status || "",
      invoiceStatusTimestamp: row.admission_invoice_status_timestamp || "",
      paidInvoiceStatus: row.admission_paid_invoice_status || "",
      paidInvoiceStatusTimestamp: row.admission_paid_invoice_status_timestamp || "",
      currencyCode: row.currency_code || "",
    },

    currency_code: row.currency_code || "",
    billingYear,
    billing: billingArr,
  };
}
export default db;
export { PERMISSION_KEYS, buildDefaultPermissions, normalizePermissions };