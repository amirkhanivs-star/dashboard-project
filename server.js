// server.js
import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import cors from "cors"; // ✅ CORS
import fs from "fs"; // ✅ PDF download check
import crypto from "crypto";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import { GoogleGenerativeAI } from "@google/generative-ai";

import http from "http"; // ✅ NEW (Socket server)
import { Server as SocketIOServer } from "socket.io"; // ✅ NEW

import dotenv from "dotenv";
dotenv.config();

import db, {
  PERMISSION_KEYS,
  normalizePermissions,
  getApiSetting,
  getAllApiSettings,
  updateApiSetting,
} from "./db.js";
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

// ================== GEMINI AI ASSISTANT SETUP ==================
// Gemini key/model will be read from API Settings DB first,
// then from .env as fallback. Do not create genAI globally.
function getAiSettingValue(key, fallback = "") {
  try {
    const value = getApiSetting(key, fallback);
    return String(value || fallback || "").trim();
  } catch (err) {
    console.error("getAiSettingValue error:", err.message);
    return String(fallback || "").trim();
  }
}
// ================== DEVELOPER ACCESS HELPERS ==================
function ensureDeveloperCoreTables() {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS developer_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        email TEXT,
        profile_image_url TEXT,
        password_hash TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        last_login_at TEXT
      )
    `).run();

    // Existing database me email column safely add karo.
    const developerAccountColumns = new Set(
      db.prepare(`PRAGMA table_info(developer_accounts)`)
        .all()
        .map((column) => String(column.name || "").trim())
    );

    if (!developerAccountColumns.has("email")) {
      db.prepare(`
        ALTER TABLE developer_accounts
        ADD COLUMN email TEXT
      `).run();
    }

        // Existing database me Developer profile image column safely add karo.
    if (!developerAccountColumns.has("profile_image_url")) {
      db.prepare(`
        ALTER TABLE developer_accounts
        ADD COLUMN profile_image_url TEXT
      `).run();
    }

    // Agar purana username email format me tha to usko email me backfill karo.
    db.prepare(`
      UPDATE developer_accounts
      SET email = LOWER(TRIM(username))
      WHERE (
        email IS NULL
        OR TRIM(COALESCE(email, '')) = ''
      )
      AND TRIM(COALESCE(username, '')) LIKE '%@%'
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE,
        user_name TEXT,
        user_email TEXT,
        role TEXT,
        dept TEXT,
        current_page TEXT,
        ip_address TEXT,
        user_agent TEXT,
        last_seen TEXT NOT NULL
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        user_email TEXT,
        role TEXT,
        dept TEXT,
        page_url TEXT,
        event_type TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS developer_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        developer_id INTEGER,
        developer_name TEXT,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL
      )
    `).run();

    const devUsername = String(
      process.env.DEVELOPER_USERNAME || "mak"
    ).trim();

    const devEmail = String(
      process.env.DEVELOPER_EMAIL ||
      (devUsername.includes("@") ? devUsername : "")
    )
      .trim()
      .toLowerCase();

    const devPassword = String(
      process.env.DEVELOPER_PASSWORD || "Mak@2026"
    ).trim();

    // Sirf tab default Developer create karo jab koi Developer account na ho.
    // Username dashboard se change hone ke baad restart par duplicate account nahi banega.
    const existingDev = db.prepare(`
      SELECT id
      FROM developer_accounts
      ORDER BY id ASC
      LIMIT 1
    `).get();

    if (!existingDev && devUsername && devPassword) {
      const passwordHash = bcrypt.hashSync(devPassword, 10);

      db.prepare(`
        INSERT INTO developer_accounts
          (
            name,
            username,
            email,
            password_hash,
            is_active,
            created_at
          )
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(
        "MAK Developer",
        devUsername,
        devEmail,
        passwordHash,
        new Date().toISOString()
      );

      console.log(
        "Developer account created. Please change Developer credentials for production."
      );
    }
  } catch (err) {
    console.error("ensureDeveloperCoreTables error:", err.message);
  }
}

ensureDeveloperCoreTables();

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "";
}

function mapDeveloperRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name || "Developer",
    username: row.username || "",
    email: row.email || "",

    role: "Developer",
    profileImageUrl: row.profile_image_url || "",

    isActive: Number(row.is_active || 0) === 1,
    createdAt: row.created_at || "",
    lastLoginAt: row.last_login_at || "",
    updatedAt: row.updated_at || "",
  };
}

function requireDeveloperLogin(req, res, next) {
  const dev = req.session.developer;

  if (!dev?.id) {
    return res.redirect("/login");
  }

  try {
    const row = db.prepare(`
      SELECT *
      FROM developer_accounts
      WHERE id = ?
        AND is_active = 1
      LIMIT 1
    `).get(dev.id);

    if (!row) {
      delete req.session.developer;
      return res.redirect("/login");
    }

    req.developer = mapDeveloperRow(row);
    res.locals.developer = req.developer;
  } catch (err) {
    console.error("requireDeveloperLogin error:", err.message);
    return res.redirect("/login");
  }

  next();
}

function logDeveloperAction(req, action, details = {}) {
  try {
    const dev = req.session.developer || req.developer || {};

    db.prepare(`
      INSERT INTO developer_logs
        (developer_id, developer_name, action, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      dev.id || null,
      dev.name || dev.username || "Developer",
      action,
      JSON.stringify(details || {}),
      getClientIp(req),
      new Date().toISOString()
    );
  } catch (err) {
    console.error("logDeveloperAction error:", err.message);
  }
}

function tableExists(tableName) {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
      LIMIT 1
    `).get(tableName);

    return !!row;
  } catch {
    return false;
  }
}

function getTableColumnsSafe(tableName) {
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all()
      .map((c) => String(c.name || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sqlSafeColumn(col) {
  return `"${String(col || "").replaceAll('"', '""')}"`;
}

function countByDeptFromTable(tableName) {
  const out = { school: 0, quran: 0, tuition: 0, accounts: 0 };

  try {
    const hasIsDeleted = getTableColumnsSafe(tableName).includes("is_deleted");

    const rows = db.prepare(`
      SELECT LOWER(TRIM(COALESCE(dept, ''))) AS dept, COUNT(*) AS total
      FROM ${tableName}
      ${hasIsDeleted ? "WHERE COALESCE(is_deleted, 0) = 0" : ""}
      GROUP BY LOWER(TRIM(COALESCE(dept, '')))
    `).all();

    for (const row of rows) {
      let dept = String(row.dept || "").trim().toLowerCase();

      if (
        dept === "school accounts" ||
        dept === "school_accounts" ||
        dept === "account"
      ) {
        dept = "accounts";
      }

      if (Object.prototype.hasOwnProperty.call(out, dept)) {
        out[dept] = Number(row.total || 0);
      }
    }
  } catch (err) {
    console.error(`countByDeptFromTable ${tableName} error:`, err.message);
  }

  return out;
}

function getDeveloperUsersList() {
  try {
    const rows = db.prepare(`
      SELECT
        id,
        name,
        email,
        role,
        dept,
        agentType,
        managerId,
        assigned_admin_id,
        created_by,
        access_scope,
        permissions,
        createdAt,
        updatedAt,
        lastUpdatedAt,
        lastUpdatedBy,
        lastUpdatedByRole
      FROM users
      ORDER BY id DESC
    `).all();

    return rows.map((u) => {
  const parsedPermissions = safeJsonParse(u.permissions) || {};
  const finalPermissions = normalizeDeveloperControlledPermissions(parsedPermissions, u.role);

  return {
    ...u,
    password: "Protected. Use Reset Password.",
    permissions: finalPermissions,
        permissionsCount: Object.values(finalPermissions).filter(Boolean).length,
        enabledPermissions: Object.entries(finalPermissions)
          .filter(([, value]) => !!value)
          .map(([key]) => key),
        canResetPassword: true,
        canEdit: true,
        canDelete: true,
        canEditPermissions: true,
      };
    });
  } catch (err) {
    console.error("getDeveloperUsersList error:", err.message);
    return [];
  }
}

function getDeveloperOnlineUsers() {
  try {
    return db.prepare(`
      SELECT
        user_id,
        user_name,
        user_email,
        role,
        dept,
        current_page,
        ip_address,
        last_seen
      FROM user_activity
      WHERE datetime(last_seen) >= datetime('now', '-2 minutes')
      ORDER BY datetime(last_seen) DESC
    `).all();
  } catch (err) {
    console.error("getDeveloperOnlineUsers error:", err.message);
    return [];
  }
}

function getUsageCounts() {
  try {
    const getPeriodStats = (whereSql) => {
      return db.prepare(`
        SELECT
          COUNT(*) AS events,
          COUNT(DISTINCT actor_key) AS uniqueUsers,
          COUNT(DISTINCT actor_key || '|' || minute_bucket) AS activeMinutes
        FROM (
          SELECT
            COALESCE(
              NULLIF(TRIM(CAST(user_id AS TEXT)), ''),
              NULLIF(TRIM(user_email), ''),
              NULLIF(TRIM(ip_address), ''),
              'unknown'
            ) AS actor_key,
            strftime('%Y-%m-%d %H:%M', created_at) AS minute_bucket
          FROM usage_events
          WHERE ${whereSql}
        )
      `).get();
    };

    const todayStats = getPeriodStats(`
      date(created_at) = date('now')
    `);

    const weekStats = getPeriodStats(`
      date(created_at) >= date('now', '-6 days')
    `);

    const monthStats = getPeriodStats(`
      strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `);

    const yearStats = getPeriodStats(`
      strftime('%Y', created_at) = strftime('%Y', 'now')
    `);

    return {
      // Raw heartbeat/activity events
      today: Number(todayStats?.events || 0),
      week: Number(weekStats?.events || 0),
      month: Number(monthStats?.events || 0),
      year: Number(yearStats?.events || 0),

      // Unique active users
      uniqueUsers: {
        today: Number(todayStats?.uniqueUsers || 0),
        week: Number(weekStats?.uniqueUsers || 0),
        month: Number(monthStats?.uniqueUsers || 0),
        year: Number(yearStats?.uniqueUsers || 0),
      },

      // Final professional usage metric:
      // 1 user active for 1 minute = 1 active minute
      activeMinutes: {
        today: Number(todayStats?.activeMinutes || 0),
        week: Number(weekStats?.activeMinutes || 0),
        month: Number(monthStats?.activeMinutes || 0),
        year: Number(yearStats?.activeMinutes || 0),
      },
    };
  } catch (err) {
    console.error("getUsageCounts error:", err.message);

    return {
      today: 0,
      week: 0,
      month: 0,
      year: 0,
      uniqueUsers: {
        today: 0,
        week: 0,
        month: 0,
        year: 0,
      },
      activeMinutes: {
        today: 0,
        week: 0,
        month: 0,
        year: 0,
      },
    };
  }
}

function getIncomeTotalsByDept() {
  const empty = {
    school: { daily: 0, weekly: 0, monthly: 0, total: 0 },
    quran: { daily: 0, weekly: 0, monthly: 0, total: 0 },
    tuition: { daily: 0, weekly: 0, monthly: 0, total: 0 },
  };

  try {
    const totalRows = db.prepare(`
      SELECT
        LOWER(TRIM(COALESCE(dept, ''))) AS dept,
        COALESCE(SUM(CAST(COALESCE(NULLIF(admission_total_paid, ''), '0') AS REAL)), 0) AS total
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
      GROUP BY LOWER(TRIM(COALESCE(dept, '')))
    `).all();

    for (const row of totalRows) {
      const dept = String(row.dept || "").trim().toLowerCase();
      if (empty[dept]) {
        empty[dept].total = Number(row.total || 0);
      }
    }

    if (!tableExists("admission_billing")) {
      return empty;
    }

    const cols = getTableColumnsSafe("admission_billing");
    const amountCols = [
      "amount",
      "amountReceived",
      "amount_received",
      "registrationFeeReceived",
      "registration_fee_received",
    ].filter((c) => cols.includes(c));

    const dateCols = [
      "paymentDate",
      "payment_date",
      "paidOn",
      "paid_on",
      "updated_at",
      "updatedAt",
      "created_at",
      "createdAt",
    ].filter((c) => cols.includes(c));

    if (!amountCols.length || !dateCols.length) {
      return empty;
    }

    const amountExpr = amountCols
      .map((c) => `CAST(COALESCE(NULLIF(ab.${sqlSafeColumn(c)}, ''), '0') AS REAL)`)
      .join(" + ");

    const dateExpr = `COALESCE(${dateCols.map((c) => `NULLIF(ab.${sqlSafeColumn(c)}, '')`).join(", ")})`;

    const fillPeriod = (key, conditionSql) => {
      const rows = db.prepare(`
        SELECT
          LOWER(TRIM(COALESCE(a.dept, ''))) AS dept,
          COALESCE(SUM(${amountExpr}), 0) AS total
        FROM admission_billing ab
        INNER JOIN admissions a
          ON a.id = ab.admission_id
        WHERE COALESCE(a.is_deleted, 0) = 0
          AND ${conditionSql}
        GROUP BY LOWER(TRIM(COALESCE(a.dept, '')))
      `).all();

      for (const row of rows) {
        const dept = String(row.dept || "").trim().toLowerCase();
        if (empty[dept]) {
          empty[dept][key] = Number(row.total || 0);
        }
      }
    };

    fillPeriod("daily", `date(${dateExpr}) = date('now')`);
    fillPeriod("weekly", `date(${dateExpr}) >= date('now', '-6 days')`);
    fillPeriod("monthly", `strftime('%Y-%m', ${dateExpr}) = strftime('%Y-%m', 'now')`);

    return empty;
  } catch (err) {
    console.error("getIncomeTotalsByDept error:", err.message);
    return empty;
  }
}
function getAdmissionDateSqlExpression(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const cols = getTableColumnsSafe("admissions");

  const candidates = [
    "registration_date",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
  ].filter((col) => cols.includes(col));

  if (!candidates.length) {
    return "datetime('now')";
  }

  return `COALESCE(${candidates.map((col) => `NULLIF(TRIM(${prefix}${sqlSafeColumn(col)}), '')`).join(", ")}, datetime('now'))`;
}

function makeEmptyDeveloperDepartmentDetails() {
  return {
    school: {
      dailyAdmissions: 0,
      monthlyAdmissions: 0,
      yearlyAdmissions: 0,
      timeline: {},
    },
    quran: {
      dailyAdmissions: 0,
      monthlyAdmissions: 0,
      yearlyAdmissions: 0,
      timeline: {},
    },
    tuition: {
      dailyAdmissions: 0,
      monthlyAdmissions: 0,
      yearlyAdmissions: 0,
      timeline: {},
    },
  };
}

function getDeveloperDepartmentDetails() {
  const out = makeEmptyDeveloperDepartmentDetails();

  try {
    const dateExpr = getAdmissionDateSqlExpression("");

    const rows = db.prepare(`
      SELECT
        LOWER(TRIM(COALESCE(dept, ''))) AS dept,

        SUM(
          CASE
            WHEN date(${dateExpr}) = date('now') THEN 1
            ELSE 0
          END
        ) AS dailyAdmissions,

        SUM(
          CASE
            WHEN strftime('%Y-%m', ${dateExpr}) = strftime('%Y-%m', 'now') THEN 1
            ELSE 0
          END
        ) AS monthlyAdmissions,

        SUM(
          CASE
            WHEN strftime('%Y', ${dateExpr}) = strftime('%Y', 'now') THEN 1
            ELSE 0
          END
        ) AS yearlyAdmissions

      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
      GROUP BY LOWER(TRIM(COALESCE(dept, '')))
    `).all();

    for (const row of rows) {
      const dept = String(row.dept || "").trim().toLowerCase();

      if (!out[dept]) continue;

      out[dept].dailyAdmissions = Number(row.dailyAdmissions || 0);
      out[dept].monthlyAdmissions = Number(row.monthlyAdmissions || 0);
      out[dept].yearlyAdmissions = Number(row.yearlyAdmissions || 0);
    }

    const timelineRows = db.prepare(`
      SELECT
        LOWER(TRIM(COALESCE(dept, ''))) AS dept,
        strftime('%Y-%m', ${dateExpr}) AS period,
        COUNT(*) AS total
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
        AND date(${dateExpr}) >= date('now', '-11 months')
      GROUP BY
        LOWER(TRIM(COALESCE(dept, ''))),
        strftime('%Y-%m', ${dateExpr})
      ORDER BY period ASC
    `).all();

    for (const row of timelineRows) {
      const dept = String(row.dept || "").trim().toLowerCase();
      const period = String(row.period || "").trim();

      if (!out[dept] || !period) continue;

      out[dept].timeline[period] = Number(row.total || 0);
    }

    return out;
  } catch (err) {
    console.error("getDeveloperDepartmentDetails error:", err.message);
    return out;
  }
}

function getDeveloperDatabaseExportPayload() {
  const exportData = {
    generatedAt: new Date().toISOString(),
    generatedBy: "developer",
    tables: {},
  };

  try {
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all();

    for (const item of tables) {
      const tableName = String(item.name || "").trim();
      if (!tableName) continue;

      const safeTableName = `"${tableName.replaceAll('"', '""')}"`;
      const rows = db.prepare(`SELECT * FROM ${safeTableName}`).all();

      exportData.tables[tableName] = {
        totalRows: rows.length,
        rows,
      };
    }
  } catch (err) {
    exportData.error = err.message;
    console.error("getDeveloperDatabaseExportPayload error:", err.message);
  }

  return exportData;
}

function normalizeDeveloperControlledPermissions(rawPermissions = {}, role = "agent") {
  const source =
    typeof rawPermissions === "string"
      ? safeJsonParse(rawPermissions) || {}
      : rawPermissions || {};

  // ✅ Super Admin permissions must also be controlled by Developer Dashboard.
  // Do NOT auto-give all permissions here.
  if (role === "super_admin") {
    const permissions = {};

    for (const key of PERMISSION_KEYS) {
      permissions[key] =
        source[key] === true ||
        source[key] === "true" ||
        source[key] === "on" ||
        source[key] === 1 ||
        source[key] === "1";
    }

    return permissions;
  }

  return normalizePermissions(source, role);
}

function getDeveloperPermissionsFromBody(body = {}, role = "agent") {
  const incoming =
    body.permissions && typeof body.permissions === "object"
      ? body.permissions
      : body;

  const permissions = {};

  for (const key of PERMISSION_KEYS) {
    permissions[key] =
      incoming[key] === true ||
      incoming[key] === "true" ||
      incoming[key] === "on" ||
      incoming[key] === 1 ||
      incoming[key] === "1";
  }

  return normalizeDeveloperControlledPermissions(permissions, role);
}
function getDeveloperDashboardStats() {
  const usersByDept = countByDeptFromTable("users");
  const admissionsByDept = countByDeptFromTable("admissions");
  const onlineUsers = getDeveloperOnlineUsers();
  const usage = getUsageCounts();
  const income = getIncomeTotalsByDept();
  const departmentDetails = getDeveloperDepartmentDetails();

  let totalUsers = 0;
  let totalAdmissions = 0;

  try {
    totalUsers = Number(db.prepare(`SELECT COUNT(*) AS total FROM users`).get()?.total || 0);
  } catch {}

  try {
    totalAdmissions = Number(
      db.prepare(`
        SELECT COUNT(*) AS total
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
      `).get()?.total || 0
    );
  } catch {}

  return {
    totals: {
      users: totalUsers,
      admissions: totalAdmissions,
      onlineUsers: onlineUsers.length,

      // Final usage display = active minutes, not percentage
      todayUsage: usage.activeMinutes?.today || 0,
      weeklyUsage: usage.activeMinutes?.week || 0,
      monthlyUsage: usage.activeMinutes?.month || 0,
      yearlyUsage: usage.activeMinutes?.year || 0,

      // Extra details for developer dashboard/export
      todayUsageEvents: usage.today || 0,
      weeklyUsageEvents: usage.week || 0,
      monthlyUsageEvents: usage.month || 0,
      yearlyUsageEvents: usage.year || 0,

      todayUniqueUsers: usage.uniqueUsers?.today || 0,
      weeklyUniqueUsers: usage.uniqueUsers?.week || 0,
      monthlyUniqueUsers: usage.uniqueUsers?.month || 0,
      yearlyUniqueUsers: usage.uniqueUsers?.year || 0,
    },
    usersByDept,
    admissionsByDept,
    departmentDetails,
    income,
    onlineUsers,
    usage,
  };
}
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    if (!ioRef) return;

    const actor = req?.session?.user || null;

    ioRef.emit("admission:changed", {
      ts: Date.now(),
      type: payload.type || "admission_changed",
      admissionId: payload.admissionId || null,
      insertedIds: Array.isArray(payload.insertedIds) ? payload.insertedIds : [],
      deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds : [],
      dept: payload.dept || "",
      changedBy: actor
        ? {
            id: actor.id || null,
            name: actor.name || "",
            role: actor.role || "",
            dept: actor.dept || "",
          }
        : null,
      ...payload,
    });
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
// Serve public system files, but protect admission uploads.
const uploadsStatic = express.static(uploadsDir);

app.use("/uploads", (req, res, next) => {
  // POST /uploads aur doosre non-file requests ko normal routes tak jane do.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return next();
  }

  let relativePath = "";

  try {
    relativePath = decodeURIComponent(String(req.path || ""))
      .replace(/^\/+/, "")
      .replaceAll("\\", "/");
  } catch {
    return res.status(400).send("Invalid file path");
  }

  if (!relativePath || relativePath.includes("..")) {
    return res.status(400).send("Invalid file path");
  }

  // Ye files dashboard se bahar bhi use hoti hain.
  const isPublicSystemFile =
    relativePath.startsWith("developer-profile/") ||
    relativePath.startsWith("challans/");

  if (isPublicSystemFile) {
    return uploadsStatic(req, res, next);
  }

  const sessionUser = req.session.user;

  if (!sessionUser?.id) {
    return res.status(401).send("Login required");
  }

  const freshUserRow = db.prepare(`
    SELECT *
    FROM users
    WHERE id = ?
    LIMIT 1
  `).get(sessionUser.id);

  if (!freshUserRow) {
    return req.session.destroy(() => {
      res.status(401).send("Login required");
    });
  }

  const user = mapUserRow(freshUserRow);
  req.session.user = user;

  const perms = getPerm(user);

  if (!perms?.btnFiles) {
    return res.status(403).send("Not allowed");
  }

  const windowsRelativePath = relativePath.replaceAll("/", "\\");

  const uploadRow = db.prepare(`
    SELECT
      u.id,
      u.admission_id,
      u.stored_name,
      a.id AS linked_admission_id,
      a.dept,
      a.processed_by,
      a.is_deleted
    FROM uploads u
    LEFT JOIN admissions a
      ON a.id = u.admission_id
    WHERE u.stored_name = ?
       OR u.stored_name = ?
    LIMIT 1
  `).get(relativePath, windowsRelativePath);

  if (!uploadRow) {
    return res.status(404).send("File not found");
  }

  if (uploadRow.admission_id) {
    const admissionAccessRow = getActiveAdmissionById(uploadRow.admission_id);

    if (!admissionAccessRow) {
      return res.status(404).send("Admission not found");
    }

    if (!canAccessAdmissionRow(user, admissionAccessRow)) {
      return res.status(403).send("Not allowed");
    }
  } else if (user.role !== "super_admin") {
    return res.status(403).send("Not allowed");
  }

  return uploadsStatic(req, res, next);
});

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
// ================== DEVELOPER PROFILE IMAGE UPLOAD ==================

const developerProfileDir = path.join(
  uploadsDir,
  "developer-profile"
);

if (!fs.existsSync(developerProfileDir)) {
  fs.mkdirSync(developerProfileDir, {
    recursive: true,
  });
}

const developerProfileMimeExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

const developerProfileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, developerProfileDir);
  },

  filename: (req, file, cb) => {
    const developerId =
      Number(req.developer?.id || 0) || "developer";

    const safeExtension =
      developerProfileMimeExtensions.get(file.mimetype) ||
      ".jpg";

    const randomPart = crypto
      .randomBytes(8)
      .toString("hex");

    cb(
      null,
      `developer-${developerId}-${Date.now()}-${randomPart}${safeExtension}`
    );
  },
});

const developerProfileUpload = multer({
  storage: developerProfileStorage,

  // Original file bytes save honge; resize/compression nahi hogi.
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1,
  },

  fileFilter: (req, file, cb) => {
    if (
      !developerProfileMimeExtensions.has(
        String(file.mimetype || "").toLowerCase()
      )
    ) {
      return cb(
        new Error(
          "Only JPG, JPEG, PNG and WebP profile images are allowed."
        )
      );
    }

    cb(null, true);
  },
});

function getDeveloperProfileImageAbsolutePath(imageUrl = "") {
  const cleanUrl = String(imageUrl || "")
    .trim()
    .split("?")[0];

  const requiredPrefix =
    "/uploads/developer-profile/";

  if (!cleanUrl.startsWith(requiredPrefix)) {
    return "";
  }

  const fileName = path.basename(
    cleanUrl.slice(requiredPrefix.length)
  );

  if (!fileName) {
    return "";
  }

  return path.join(
    developerProfileDir,
    fileName
  );
}
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

function ensureAdmissionEntryNumberColumn() {
  try {
    const cols = db.prepare(`PRAGMA table_info(admissions)`).all();
    const existing = new Set(cols.map((c) => String(c.name || "").trim()));

    if (!existing.has("entry_number")) {
      db.prepare(`ALTER TABLE admissions ADD COLUMN entry_number INTEGER`).run();
    }

    if (!existing.has("last_activity_at")) {
      db.prepare(`ALTER TABLE admissions ADD COLUMN last_activity_at TEXT`).run();
    }

    // Old active admissions ko one-time fixed entry number do:
    // oldest admission = 1, latest admission = biggest number.
    db.prepare(`
      WITH ordered AS (
        SELECT
          id,
          ROW_NUMBER() OVER (ORDER BY id ASC) AS rn
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
      )
      UPDATE admissions
      SET entry_number = (
        SELECT rn
        FROM ordered
        WHERE ordered.id = admissions.id
      )
      WHERE COALESCE(is_deleted, 0) = 0
        AND (
          entry_number IS NULL
          OR TRIM(COALESCE(entry_number, '')) = ''
          OR CAST(entry_number AS INTEGER) = 0
        )
    `).run();

    // Old records ke liye initial activity time set karo.
    db.prepare(`
      UPDATE admissions
      SET last_activity_at = COALESCE(
        NULLIF(TRIM(last_activity_at), ''),
        NULLIF(TRIM(created_at), ''),
        NULLIF(TRIM(registration_date), ''),
        datetime('now')
      )
      WHERE COALESCE(is_deleted, 0) = 0
        AND (
          last_activity_at IS NULL
          OR TRIM(COALESCE(last_activity_at, '')) = ''
        )
    `).run();
  } catch (e) {
    console.error("ensureAdmissionEntryNumberColumn error:", e.message);
  }
}

ensureAdmissionEntryNumberColumn();
function ensureAdmissionBankColumn() {
  try {
    const cols = db.prepare(`PRAGMA table_info(admissions)`).all();
    const existing = new Set(cols.map((c) => String(c.name || "").trim()));

    if (!existing.has("bank_name")) {
      db.prepare(`ALTER TABLE admissions ADD COLUMN bank_name TEXT`).run();
    }
  } catch (e) {
    console.error("ensureAdmissionBankColumn error:", e.message);
  }
}

ensureAdmissionBankColumn();

function ensureAdmissionCommentColumn() {
  try {
    const cols = db.prepare(`PRAGMA table_info(admissions)`).all();
    const existing = new Set(cols.map((c) => String(c.name || "").trim()));

    if (!existing.has("admission_comment")) {
      db.prepare(`ALTER TABLE admissions ADD COLUMN admission_comment TEXT`).run();
    }
  } catch (e) {
    console.error("ensureAdmissionCommentColumn error:", e.message);
  }
}

ensureAdmissionCommentColumn();

function ensureAdmissionForwardColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info(admissions)`).all();
    const existing = new Set(cols.map((c) => String(c.name || "").trim()));

    const addColumn = (name, type) => {
      if (!existing.has(name)) {
        db.prepare(`ALTER TABLE admissions ADD COLUMN ${name} ${type}`).run();
        existing.add(name);
      }
    };

    addColumn("forward_status", "TEXT DEFAULT 'not_forwarded'");
    addColumn("forwarded_to_department", "TEXT");
    addColumn("forwarded_to_type", "TEXT");
    addColumn("forwarded_at", "TEXT");

    // Latest forwarding source. This is required because all three
    // School Accounts pipelines use the same main department value.
    addColumn("forwarded_from_department", "TEXT");
    addColumn("forwarded_from_type", "TEXT");

    // Current School Accounts stage:
    // new_admissions | record_to_update | old_admissions
    addColumn("accounts_workflow_stage", "TEXT DEFAULT 'new_admissions'");

    // Latest correction / issue details.
    addColumn("accounts_issue_message", "TEXT");
    addColumn("accounts_issue_fields", "TEXT");
    addColumn("accounts_issue_by_id", "INTEGER");
    addColumn("accounts_issue_by_name", "TEXT");
    addColumn("accounts_issue_by_role", "TEXT");
    addColumn("accounts_issue_at", "TEXT");

    // Record Update completion information.
    addColumn("accounts_completed_at", "TEXT");
    addColumn("accounts_completed_by_id", "INTEGER");
    addColumn("accounts_completed_by_name", "TEXT");
    addColumn("accounts_completed_by_role", "TEXT");

    // Kis user ne forward kiya
    addColumn("forwarded_by_id", "INTEGER");
    addColumn("forwarded_by_name", "TEXT");
    addColumn("forwarded_by_role", "TEXT");

    // Kis selected user ke pipeline mein admission show honi chahiye
    addColumn("forwarded_owner_user_id", "INTEGER");
    addColumn("forwarded_owner_user_name", "TEXT");
    addColumn("forwarded_owner_user_role", "TEXT");

    // Pipeline type change par assigned admissions transfer note/details.
    addColumn("accounts_transfer_note", "TEXT");
    addColumn("accounts_transfer_reason", "TEXT");
    addColumn("accounts_transfer_from_user_id", "INTEGER");
    addColumn("accounts_transfer_from_user_name", "TEXT");
    addColumn("accounts_transfer_from_user_role", "TEXT");
    addColumn("accounts_transfer_to_user_id", "INTEGER");
    addColumn("accounts_transfer_to_user_name", "TEXT");
    addColumn("accounts_transfer_to_user_role", "TEXT");
    addColumn("accounts_transfer_by_id", "INTEGER");
    addColumn("accounts_transfer_by_name", "TEXT");
    addColumn("accounts_transfer_by_role", "TEXT");
    addColumn("accounts_transfer_at", "TEXT");

    // Existing records ko safe defaults do. No current forwarding data is removed.
    db.prepare(`
      UPDATE admissions
      SET accounts_workflow_stage = 'new_admissions'
      WHERE COALESCE(is_deleted, 0) = 0
        AND (
          accounts_workflow_stage IS NULL
          OR TRIM(COALESCE(accounts_workflow_stage, '')) = ''
        )
    `).run();

    db.prepare(`
      UPDATE admissions
      SET forwarded_from_department = 'School Department',
          forwarded_from_type = 'school'
      WHERE COALESCE(is_deleted, 0) = 0
        AND LOWER(TRIM(COALESCE(forward_status, ''))) = 'forwarded'
        AND (
          forwarded_from_type IS NULL
          OR TRIM(COALESCE(forwarded_from_type, '')) = ''
        )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS admission_accounts_workflow_users (
        admission_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT,
        user_role TEXT,
        agent_type TEXT,
        first_assigned_at TEXT NOT NULL,
        last_assigned_at TEXT NOT NULL,
        PRIMARY KEY (admission_id, user_id)
      )
    `).run();
  } catch (e) {
    console.error("ensureAdmissionForwardColumns error:", e.message);
  }
}

ensureAdmissionForwardColumns();
function ensureAdmissionForwardTimerTable() {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS admission_forward_time_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admission_id INTEGER NOT NULL,
        holder_user_id INTEGER,
        holder_user_name TEXT,
        holder_user_role TEXT,
        holder_department TEXT,
        holder_type TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_seconds INTEGER DEFAULT 0,
        is_current INTEGER DEFAULT 1,
        ended_by_id INTEGER,
        ended_by_name TEXT,
        ended_by_role TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_admission_forward_time_logs_admission_current
      ON admission_forward_time_logs (admission_id, is_current)
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_admission_forward_time_logs_admission_started
      ON admission_forward_time_logs (admission_id, started_at)
    `).run();
  } catch (e) {
    console.error("ensureAdmissionForwardTimerTable error:", e.message);
  }
}

ensureAdmissionForwardTimerTable();

function parseForwardTimerDate(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const sqliteLike = new Date(raw.replace(" ", "T"));
  if (!Number.isNaN(sqliteLike.getTime())) {
    return sqliteLike;
  }

  return null;
}

function secondsBetweenForwardTimerDates(startValue = "", endValue = "") {
  const start = parseForwardTimerDate(startValue);
  const end = parseForwardTimerDate(endValue) || new Date();

  if (!start || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor((end.getTime() - start.getTime()) / 1000)
  );
}

function formatForwardTimerDuration(seconds = 0) {
  const totalSeconds = Math.max(0, Number(seconds || 0));
  const totalMinutes = Math.floor(totalSeconds / 60);

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  return `${days}d ${hours}h ${minutes}m`;
}

function normalizeForwardTimerDepartment(value = "") {
  const clean = String(value || "").trim();
  if (!clean) return "";

  const lower = clean.toLowerCase();

  if (
    lower === "school" ||
    lower === "school department" ||
    lower === "school dept"
  ) {
    return "School Department";
  }

  if (
    lower === "accounts" ||
    lower === "school accounts" ||
    lower === "school accounts department" ||
    lower === "school accounts dept"
  ) {
    return "School Accounts Department";
  }

  return clean;
}

function normalizeForwardTimerType(value = "") {
  const clean = String(value || "").trim();
  if (!clean) return "";

  const forwardTypeLabel = forwardTypeToDepartmentLabel(clean);
  if (forwardTypeLabel) return forwardTypeLabel;

  const lower = clean.toLowerCase();

  if (
    lower === "school_return" ||
    lower === "school return" ||
    lower === "not_received" ||
    lower === "not received"
  ) {
    return "Not Received";
  }

  return clean;
}

function mapAdmissionForwardTimeLog(row = {}) {
  if (!row) return null;

  const isCurrent =
    Number(row.is_current || 0) === 1 &&
    !String(row.ended_at || "").trim();

  const durationSeconds = isCurrent
    ? secondsBetweenForwardTimerDates(row.started_at, new Date().toISOString())
    : Number(
        row.duration_seconds ||
        secondsBetweenForwardTimerDates(row.started_at, row.ended_at)
      );

  const holderName = String(row.holder_user_name || "").trim();
  const holderDepartment = normalizeForwardTimerDepartment(
    row.holder_department || ""
  );
  const holderType = normalizeForwardTimerType(row.holder_type || "");

  return {
    id: row.id,
    admissionId: row.admission_id,

    holderUserId: row.holder_user_id || null,
    holderUserName: holderName,
    holderUserRole: row.holder_user_role || "",
    holderDepartment,
    holderType,

    name: holderName,
    department: holderDepartment,
    type: holderType,

    startedAt: row.started_at || "",
    endedAt: row.ended_at || "",

    durationSeconds,
    durationLabel: formatForwardTimerDuration(durationSeconds),

    isCurrent,

    endedById: row.ended_by_id || null,
    endedByName: row.ended_by_name || "",
    endedByRole: row.ended_by_role || "",

    label: [
      holderName ? `With ${holderName}` : "With selected user",
      holderDepartment,
      holderType,
      formatForwardTimerDuration(durationSeconds),
    ].filter(Boolean).join(" | "),
  };
}

function getAdmissionForwardTimeLogs(admissionId) {
  try {
    const cleanAdmissionId = Number(admissionId || 0);
    if (!cleanAdmissionId) return [];

    const rows = db.prepare(`
      SELECT *
      FROM admission_forward_time_logs
      WHERE admission_id = ?
      ORDER BY
        datetime(COALESCE(started_at, '1970-01-01')) ASC,
        id ASC
    `).all(cleanAdmissionId);

    return rows
      .map(mapAdmissionForwardTimeLog)
      .filter(Boolean);
  } catch (e) {
    console.error("getAdmissionForwardTimeLogs error:", e.message);
    return [];
  }
}
function getAdmissionPreviousForwardTimeLogs(admissionId) {
  return getAdmissionForwardTimeLogs(admissionId)
    .filter((log) => !log.isCurrent);
}
function getAdmissionCurrentForwardTimer(admissionId) {
  try {
    const cleanAdmissionId = Number(admissionId || 0);
    if (!cleanAdmissionId) return null;

    const row = db.prepare(`
      SELECT *
      FROM admission_forward_time_logs
      WHERE admission_id = ?
        AND is_current = 1
        AND (
          ended_at IS NULL
          OR TRIM(COALESCE(ended_at, '')) = ''
        )
      ORDER BY
        datetime(COALESCE(started_at, '1970-01-01')) DESC,
        id DESC
      LIMIT 1
    `).get(cleanAdmissionId);

    return mapAdmissionForwardTimeLog(row);
  } catch (e) {
    console.error("getAdmissionCurrentForwardTimer error:", e.message);
    return null;
  }
}

function finishAdmissionForwardTimer(
  admissionId,
  endedAt = new Date().toISOString(),
  endedByUser = null
) {
  try {
    const cleanAdmissionId = Number(admissionId || 0);
    if (!cleanAdmissionId) return;

    const finalEndedAt = String(endedAt || new Date().toISOString()).trim();

    const activeRows = db.prepare(`
      SELECT id, started_at
      FROM admission_forward_time_logs
      WHERE admission_id = ?
        AND is_current = 1
        AND (
          ended_at IS NULL
          OR TRIM(COALESCE(ended_at, '')) = ''
        )
      ORDER BY id ASC
    `).all(cleanAdmissionId);

    for (const row of activeRows) {
      const durationSeconds = secondsBetweenForwardTimerDates(
        row.started_at,
        finalEndedAt
      );

      db.prepare(`
        UPDATE admission_forward_time_logs
        SET ended_at = @ended_at,
            duration_seconds = @duration_seconds,
            is_current = 0,
            ended_by_id = @ended_by_id,
            ended_by_name = @ended_by_name,
            ended_by_role = @ended_by_role,
            updated_at = @updated_at
        WHERE id = @id
      `).run({
        id: row.id,
        ended_at: finalEndedAt,
        duration_seconds: durationSeconds,
        ended_by_id: endedByUser?.id || null,
        ended_by_name: endedByUser?.name || endedByUser?.email || "",
        ended_by_role: endedByUser?.role || "",
        updated_at: finalEndedAt,
      });
    }
  } catch (e) {
    console.error("finishAdmissionForwardTimer error:", e.message);
  }
}

function startAdmissionForwardTimer({
  admissionId,
  holderUser = {},
  holderDepartment = "",
  holderType = "",
  startedAt = new Date().toISOString(),
} = {}) {
  try {
    const cleanAdmissionId = Number(admissionId || 0);
    if (!cleanAdmissionId) return null;

    const finalStartedAt = String(startedAt || new Date().toISOString()).trim();

    const info = db.prepare(`
      INSERT INTO admission_forward_time_logs (
        admission_id,
        holder_user_id,
        holder_user_name,
        holder_user_role,
        holder_department,
        holder_type,
        started_at,
        ended_at,
        duration_seconds,
        is_current,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?)
    `).run(
      cleanAdmissionId,
      holderUser?.id || null,
      holderUser?.name || holderUser?.email || "",
      holderUser?.role || "",
      normalizeForwardTimerDepartment(holderDepartment),
      normalizeForwardTimerType(holderType),
      finalStartedAt,
      finalStartedAt,
      finalStartedAt
    );

    return info.lastInsertRowid || null;
  } catch (e) {
    console.error("startAdmissionForwardTimer error:", e.message);
    return null;
  }
}

function restartAdmissionForwardTimer({
  admissionId,
  holderUser = {},
  holderDepartment = "",
  holderType = "",
  startedAt = new Date().toISOString(),
  endedByUser = null,
} = {}) {
  const finalStartedAt = String(startedAt || new Date().toISOString()).trim();

  finishAdmissionForwardTimer(
    admissionId,
    finalStartedAt,
    endedByUser
  );

  return startAdmissionForwardTimer({
    admissionId,
    holderUser,
    holderDepartment,
    holderType,
    startedAt: finalStartedAt,
  });
}

function getForwardTimerTargetMeta({
  isReturnToSchool = false,
  toDepartment = "",
  toType = "",
} = {}) {
  if (isReturnToSchool) {
    return {
      holderDepartment: "School Department",
      holderType: "Not Received",
    };
  }

  return {
    holderDepartment: "School Accounts Department",
    holderType: forwardTypeToDepartmentLabel(toType) || toDepartment || "",
  };
}
function ensureAdmissionWorkflowTriggers() {
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_admissions_registration_workflow
      AFTER UPDATE OF accounts_registration_number ON admissions
      FOR EACH ROW
      WHEN TRIM(COALESCE(OLD.accounts_registration_number, '')) !=
           TRIM(COALESCE(NEW.accounts_registration_number, ''))
      BEGIN
        UPDATE admissions
        SET accounts_registration_number_assigned_at =
              CASE
                WHEN TRIM(COALESCE(OLD.accounts_registration_number, '')) = ''
                 AND TRIM(COALESCE(NEW.accounts_registration_number, '')) != ''
                 AND TRIM(COALESCE(NEW.accounts_registration_number_assigned_at, '')) = ''
                THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ELSE NEW.accounts_registration_number_assigned_at
              END,
            registration_number_removed =
              CASE
                WHEN TRIM(COALESCE(OLD.accounts_registration_number, '')) != ''
                 AND TRIM(COALESCE(NEW.accounts_registration_number, '')) = ''
                THEN 1
                WHEN TRIM(COALESCE(NEW.accounts_registration_number, '')) != ''
                THEN 0
                ELSE COALESCE(NEW.registration_number_removed, 0)
              END
        WHERE id = NEW.id;
      END;
    `);
  } catch (e) {
    console.error("ensureAdmissionWorkflowTriggers error:", e.message);
  }
}

ensureAdmissionWorkflowTriggers();

function touchAdmissionActivity(admissionId) {
  try {
    const id = Number(admissionId || 0);
    if (!id) return;

    db.prepare(`
      UPDATE admissions
      SET last_activity_at = datetime('now')
      WHERE id = ?
        AND COALESCE(is_deleted, 0) = 0
    `).run(id);
  } catch (e) {
    console.error("touchAdmissionActivity error:", e.message);
  }
}

const ADMISSION_ACTIVITY_ORDER_SQL = `
  datetime(
    COALESCE(
      NULLIF(TRIM(last_activity_at), ''),
      NULLIF(TRIM(created_at), ''),
      NULLIF(TRIM(registration_date), ''),
      '1970-01-01'
    )
  ) DESC,
  COALESCE(entry_number, id) DESC,
  id DESC
`;

function getNextAdmissionEntryNumber() {
  try {
    const row = db.prepare(`
      SELECT COALESCE(MAX(entry_number), 0) + 1 AS nextNumber
      FROM admissions
    `).get();

    return Number(row?.nextNumber || 1);
  } catch (e) {
    console.error("getNextAdmissionEntryNumber error:", e.message);
    return 1;
  }
}

// ================== USER ASSIGNMENT / ACCESS HELPERS ==================
function ensureUserAssignmentColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info(users)`).all();
    const existing = new Set(cols.map((c) => String(c.name || "").trim()));

    const addColumn = (name, type) => {
      if (!existing.has(name)) {
        db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${type}`).run();
      }
    };

    addColumn("assigned_admin_id", "INTEGER");
    addColumn("created_by", "INTEGER");
    addColumn("access_scope", "TEXT DEFAULT 'own'");
  } catch (e) {
    console.error("ensureUserAssignmentColumns error:", e.message);
  }
}

ensureUserAssignmentColumns();

function isAccountsUser(user) {
  const dept = String(user?.dept || "").trim().toLowerCase();

  // ✅ Sirf Department se School Accounts access milega.
  // Pipeline / Agent Type = accounts ko special accounts access nahi milega.
  return (
    dept === "accounts" ||
    dept === "school accounts" ||
    dept === "school_accounts"
  );
}

function getUserAccessScope(user) {
  if (!user) return "own";
  if (user.role === "super_admin") return "all";

  // ✅ School Accounts users can see School admissions only.
  // They should NOT see Quran/Tuition admissions.
  if (isAccountsUser(user)) return "school_accounts";

  if (user.role === "admin") return "team";
  if (user.role === "agent" || user.role === "sub_agent") return "own";
  return "own";
}

function getAssignableAdmins(dept = "") {
  try {
    const cleanDept = String(dept || "").trim().toLowerCase();

    if (cleanDept) {
      return db.prepare(`
        SELECT id, name, email, role, dept
        FROM users
        WHERE role = 'admin'
          AND dept = ?
        ORDER BY name ASC
      `).all(cleanDept);
    }

    return db.prepare(`
      SELECT id, name, email, role, dept
      FROM users
      WHERE role = 'admin'
      ORDER BY dept ASC, name ASC
    `).all();
  } catch (e) {
    console.error("getAssignableAdmins error:", e.message);
    return [];
  }
}

function getAdminTeamNames(adminUser) {
  try {
    if (!adminUser?.id) return [];

   const rows = db.prepare(`
      SELECT name
      FROM users
      WHERE role IN ('agent', 'sub_agent')
        AND (
          assigned_admin_id = ?
          OR managerId = ?
        )
      ORDER BY name ASC
    `).all(adminUser.id, adminUser.id);

    const names = rows
      .map((r) => String(r.name || "").trim())
      .filter(Boolean);

    const adminName = String(adminUser.name || "").trim();
    if (adminName) names.push(adminName);

    return [...new Set(names)];
  } catch (e) {
    console.error("getAdminTeamNames error:", e.message);
    return [];
  }
}

function makeInPlaceholders(arr) {
  return arr.map(() => "?").join(",");
}

function isSchoolDeptAdmin(user) {
  return (
    !!user &&
    user.role === "admin" &&
    String(user.dept || "").trim().toLowerCase() === "school"
  );
}

function getRequestedSchoolTeamUserId(source = {}) {
  const raw =
    source.schoolUserId ??
    source.schoolTeamUserId ??
    source.teamUserId ??
    "";

  return Number(raw || 0) || 0;
}

function getSchoolAdminAssignedUsers(adminUser) {
  try {
    if (!isSchoolDeptAdmin(adminUser) || !adminUser?.id) {
      return [];
    }

    /*
     * School Dept Admin ko apni admissions bhi same workflow me milni chahiye.
     * Is liye admin khud first card banega, phir uske assigned agents/sub-agents.
     */
    const adminSelf = {
      id: Number(adminUser.id || 0),
      name: String(adminUser.name || adminUser.email || "Admin").trim(),
      email: String(adminUser.email || "").trim(),
      role: "admin",
      dept: adminUser.dept || "school",
      agentType: adminUser.agentType || "",
      isSelf: true,
      isCurrentAdmin: true,
      displayName: "My Admissions",
    };

    const rows = db.prepare(`
      SELECT
        id,
        name,
        email,
        role,
        dept,
        agentType,
        assigned_admin_id,
        managerId
      FROM users
      WHERE role IN ('agent', 'sub_agent')
        AND LOWER(TRIM(COALESCE(dept, ''))) = 'school'
        AND (
          assigned_admin_id = ?
          OR managerId = ?
        )
      ORDER BY name ASC, id ASC
    `).all(adminUser.id, adminUser.id);

    const seen = new Set();

    return [
      adminSelf,
      ...rows.map((row) => ({
        id: Number(row.id || 0),
        name: String(row.name || row.email || "").trim(),
        email: String(row.email || "").trim(),
        role: row.role || "",
        dept: row.dept || "",
        agentType: row.agentType || "",
        isSelf: false,
        isCurrentAdmin: false,
        displayName: String(row.name || row.email || "").trim(),
      })),
    ]
      .filter((row) => row.id && row.name)
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
  } catch (e) {
    console.error("getSchoolAdminAssignedUsers error:", e.message);
    return [];
  }
}

function getSchoolAdminSelectedTeamUser(adminUser, selectedUserId = 0) {
  const cleanSelectedUserId = Number(selectedUserId || 0);
  if (!cleanSelectedUserId) return null;

  return (
    getSchoolAdminAssignedUsers(adminUser).find(
      (row) => Number(row.id || 0) === cleanSelectedUserId
    ) || null
  );
}

function buildSchoolAdminTeamUserFilters(adminUser) {
  const teamUsers = getSchoolAdminAssignedUsers(adminUser);

  if (!teamUsers.length) {
    return [];
  }

  const userNames = teamUsers
    .map((row) => String(row.name || "").trim().toLowerCase())
    .filter(Boolean);

  const countsByName = new Map();

  try {
    const placeholders = makeInPlaceholders(userNames);

    const rows = db.prepare(`
      SELECT
        LOWER(TRIM(COALESCE(processed_by, ''))) AS processedByName,
        COUNT(*) AS total
      FROM admissions
      WHERE LOWER(TRIM(COALESCE(dept, ''))) = 'school'
        AND COALESCE(is_deleted, 0) = 0
        AND LOWER(TRIM(COALESCE(processed_by, ''))) IN (${placeholders})
      GROUP BY LOWER(TRIM(COALESCE(processed_by, '')))
    `).all(...userNames);

    for (const row of rows) {
      countsByName.set(
        String(row.processedByName || "").trim().toLowerCase(),
        Number(row.total || 0)
      );
    }
  } catch (e) {
    console.error("buildSchoolAdminTeamUserFilters error:", e.message);
  }

  return teamUsers.map((row) => ({
    ...row,
    count: countsByName.get(
      String(row.name || "").trim().toLowerCase()
    ) || 0,
  }));
}
function canAccessAdmissionRow(user, row) {
  if (!user || !row) return false;

  // Super Admin = full access
  if (user.role === "super_admin") return true;

  const userDept = String(user.dept || "").trim().toLowerCase();
  const rowDept = String(row.dept || "").trim().toLowerCase();

  // School Accounts users can access only admissions that are currently
  // inside a School Accounts pipeline. Unforwarded School admissions remain hidden.
  if (isAccountsUser(user)) {
    if (rowDept !== "school") return false;

    const forwardStatus = String(
      row.forward_status || row.forwardStatus || ""
    )
      .trim()
      .toLowerCase();

    if (forwardStatus !== "forwarded") return false;

    const pipelineType = getAccountsPipelineTypeFromRow(row);
    if (!pipelineType) return false;

    const workflowStage = getAccountsWorkflowStageFromRow(row);

    // Accounts Admin sees all currently forwarded Accounts admissions.
    if (user.role === "admin") return true;

    if (user.role === "agent" || user.role === "sub_agent") {
      if (workflowStage === "old_admissions") {
        return canSeeCompletedAccountsOldAdmission(user, row);
      }

      const userType = normalizeAgentTypeForDept(
        user.agentType || "",
        user.dept || ""
      );

      if (!userType || userType !== pipelineType) return false;

      const viewerId = Number(user.id || 0);
      const ownerId = Number(
        row.forwarded_owner_user_id || row.forwardedOwnerUserId || 0
      );

      if (viewerId && ownerId) {
        return viewerId === ownerId;
      }

      // Legacy fallback for old records that only have owner name.
      const viewerName = String(user.name || "").trim().toLowerCase();
      const ownerName = String(
        row.forwarded_owner_user_name || row.forwardedOwnerUserName || ""
      )
        .trim()
        .toLowerCase();

      return !!viewerName && !!ownerName && viewerName === ownerName;
    }

    return false;
  }

  if (!userDept || !rowDept || userDept !== rowDept) return false;

  const processedBy = String(row.processed_by || row.processedBy || "").trim();
  const userName = String(user.name || "").trim();

  // Admin = only assigned team admissions
  if (user.role === "admin") {
    const teamNames = getAdminTeamNames(user)
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean);

    return teamNames.includes(processedBy.toLowerCase());
  }

  // Agent/Sub Agent = own admissions only
  if (user.role === "agent" || user.role === "sub_agent") {
    return processedBy && userName && processedBy.toLowerCase() === userName.toLowerCase();
  }

  return false;
}

function isUserAssignedToAdmin(row, adminUser) {
  if (!row || !adminUser) return false;

  return (
    Number(row.assigned_admin_id || 0) === Number(adminUser.id || 0) ||
    Number(row.managerId || 0) === Number(adminUser.id || 0)
  );
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

function pickBankName(body, fallback = "") {
  const sources = [
    body,
    body?.admission,
    body?.admissionPanel,
  ];

  for (const src of sources) {
    if (!src) continue;

    for (const key of ["bank", "bank_name", "bankName"]) {
      if (Object.prototype.hasOwnProperty.call(src, key)) {
        const raw = Array.isArray(src[key]) ? src[key][src[key].length - 1] : src[key];
        return String(raw ?? "").trim();
      }
    }
  }

  return String(fallback ?? "").trim();
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

// 🔐 Login check + refresh updated user session without forcing logout
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

    // Normal dashboard users update karein to public updater timestamp change hota hai.
    const publicUpdateChanged =
      !!freshUser.lastUpdatedAt &&
      freshUser.lastUpdatedAt !== sessionUser.lastUpdatedAt;

    // Developer updates ke liye sirf technical timestamp change hota hai.
    // Is se session silently refresh hogi, lekin popup nahi aayega.
    const silentDeveloperUpdateChanged =
      !!freshUser.updatedAt &&
      freshUser.updatedAt !== sessionUser.updatedAt;

    if (publicUpdateChanged || silentDeveloperUpdateChanged) {
      req.session.user = freshUser;
    }

    // Popup sirf Super Admin/Admin/Agent/Sub Agent ki public update par show hoga.
    if (publicUpdateChanged && freshUser.updateNoticeUnread) {
      const byName = freshUser.lastUpdatedBy || "an administrator";
      const roleMap = {
        super_admin: "Super Admin",
        admin: "Admin",
        agent: "Agent",
        sub_agent: "Sub Agent",
      };

      const byRoleLabel =
        roleMap[freshUser.lastUpdatedByRole] ||
        freshUser.lastUpdatedByRole ||
        "Admin / Manager";

      const when = freshUser.lastUpdatedAt || "";

      let msg = `Your account permissions were updated by ${byName} (${byRoleLabel}).`;
      if (when) msg += ` Time: ${when}`;

      res.locals.flash = {
        type: "info",
        title: "Account updated",
        message: msg,
      };

      delete req.session.flash;

      db.prepare(
        "UPDATE users SET updateNoticeUnread = 0 WHERE id = ?"
      ).run(freshUser.id);

      freshUser.updateNoticeUnread = 0;
      req.session.user = freshUser;
    }
  } catch (err) {
    console.error("requireLogin check error:", err);
  }

    // ✅ make current user's admission form link available everywhere
  try {
    req.session.user = attachAdmissionLinkToUser(req.session.user);
    res.locals.admissionFormBaseUrl = getAdmissionFormBaseUrl();
    res.locals.currentUserAdmissionLink = req.session.user?.admissionLink || "";
  } catch {}

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


// ✅ default = all false
const DEFAULT_PERMS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));

// ✅ Always return ONLY new keys (col*/btn*) and never fall back to old "true" defaults
function getPerm(user) {
  const p = {
    ...DEFAULT_PERMS,
    ...(
      user?.role === "super_admin"
        ? normalizeDeveloperControlledPermissions(user?.permissions, user?.role)
        : normalizePermissions(user?.permissions, user?.role)
    ),
  };

  // ✅ Auto-derive view flags from allowed UI (so agent never gets blocked wrongly)
  const anyAccountsUi =
    p.colPaymentStatus ||
    p.colPaidUpto ||
    p.colVerificationNumber ||
    p.colRegistrationNumber ||
    p.colFamilyNumber ||
    p.colRegistrationFee ||
    p.colFees ||
    p.colCurrency ||
    p.colBank ||
    p.colMonth ||
    p.colTotalFees ||
    p.colPendingDues ||
    p.colReceivedPayment ||
    p.colComment ||
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
    p.colCurrency ||
    p.colBank ||
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
    const perms = getPerm(user);

    if (perms?.[flag]) return next();

    return res.status(403).send("Not allowed");
  };
}

// Map old route guards -> new buttons
const requireOpenBilling = requirePerm("btnBilling");
const requireSaveBilling = requirePerm("btnBilling");
const requireSendWhatsApp = requirePerm("btnWhatsApp");
const requireViewFiles = requirePerm("btnFiles");
const requireDeleteFiles = requirePerm("canDeleteFiles");
const requireDeleteAdmissions = requirePerm("canDeleteAdmissions");



// ✅ Masking: DB row (for /api/admissions list)
function maskAdmissionDbRow(row, perms) {
  const out = { ...row };
  out.isDuplicate = !!row.isDuplicate;
out.duplicateWithId = row.duplicateWithId || "";
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
  if (!perms.colBank) out.bank_name = "";
  if (!perms.colCurrency) out.currency_code = "";
  if (!perms.colMonth) out.admission_month = "";
  if (!perms.colTotalFees) out.admission_total_fees = "";
  if (!perms.colPendingDues) out.admission_pending_dues = "";
  if (!perms.colReceivedPayment) out.admission_total_paid = "";
  if (!perms.colComment) out.admission_comment = "";
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
  if (!perms.colBank) out.admission.bankName = "";
  if (!perms.colMonth) out.admission.month = "";
  if (!perms.colTotalFees) out.admission.totalFees = "";
  if (!perms.colPendingDues) out.admission.pendingDues = "";
  if (!perms.colReceivedPayment) out.admission.receivedPayment = "";
  if (!perms.colComment) out.admission.comment = "";
  if (!perms.colInvoiceStatus) out.admission.invoiceStatus = "";
  if (!perms.colInvoiceStatusTimestamp) out.admission.invoiceStatusTimestamp = "";
  if (!perms.colPaidInvoiceStatus) out.admission.paidInvoiceStatus = "";
  if (!perms.colPaidInvoiceStatusTimestamp) out.admission.paidInvoiceStatusTimestamp = "";
}

  return out;
}


function fetchAdmissionsForUser(user, options = {}) {
  const perms = getPerm(user);
  const scope = getUserAccessScope(user);

  const requestedAccountsView = normalizeAccountsWorkflowStage(
    options.accountsView || "new_admissions"
  );

  const accountsView =
    requestedAccountsView === "old_admissions"
      ? "old_admissions"
      : "new_admissions";

  let rows = [];

  // Super Admin = all admissions. Accounts-specific filtering is applied
  // by /api/admissions only when an Accounts view is requested.
  if (scope === "all") {
    rows = db.prepare(`
      SELECT *
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
      ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
    `).all();
  }

  // School Accounts Admin sees all forwarded Accounts admissions.
  // Agent/Sub-Agent rows are restricted in SQL to their own pipeline and assignment.
  else if (scope === "school_accounts") {
    const stageSql =
      accountsView === "old_admissions"
        ? `LOWER(TRIM(COALESCE(accounts_workflow_stage, 'new_admissions'))) = 'old_admissions'`
        : `LOWER(TRIM(COALESCE(accounts_workflow_stage, 'new_admissions'))) != 'old_admissions'`;

    if (user.role === "admin") {
      rows = db.prepare(`
        SELECT *
        FROM admissions
        WHERE LOWER(TRIM(COALESCE(dept, ''))) = 'school'
          AND LOWER(TRIM(COALESCE(forward_status, ''))) = 'forwarded'
          AND ${stageSql}
          AND (
            LOWER(TRIM(COALESCE(forwarded_to_type, ''))) IN (
              'print_record_update',
              'verification_registration',
              'paid_slip'
            )
            OR LOWER(TRIM(COALESCE(forwarded_to_department, ''))) IN (
              'print + record update',
              'print & record update',
              'verification & registration',
              'paid slip'
            )
          )
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
      `).all();
    } else {
      const userType = normalizeAgentTypeForDept(
        user.agentType || "",
        user.dept || ""
      );

      const ownId = Number(user.id || 0);
      const ownName = String(user.name || "").trim().toLowerCase();
      const pipelineLabel = forwardTypeToDepartmentLabel(userType).toLowerCase();
      const alternatePipelineLabel =
        userType === "print_record_update"
          ? "print & record update"
          : pipelineLabel;

      if (!userType || !ownId) {
        rows = [];
      } else if (accountsView === "old_admissions") {
        rows = db.prepare(`
          SELECT *
          FROM admissions
          WHERE LOWER(TRIM(COALESCE(dept, ''))) = 'school'
            AND LOWER(TRIM(COALESCE(forward_status, ''))) = 'forwarded'
            AND LOWER(TRIM(COALESCE(accounts_workflow_stage, 'new_admissions'))) = 'old_admissions'
            AND (
              accounts_completed_by_id = ?
              OR (
                COALESCE(accounts_completed_by_id, 0) = 0
                AND LOWER(TRIM(COALESCE(accounts_completed_by_name, ''))) = ?
              )
            )
            AND COALESCE(is_deleted, 0) = 0
          ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
        `).all(ownId, ownName);
      } else {
        rows = db.prepare(`
          SELECT *
          FROM admissions
          WHERE LOWER(TRIM(COALESCE(dept, ''))) = 'school'
            AND LOWER(TRIM(COALESCE(forward_status, ''))) = 'forwarded'
            AND ${stageSql}
            AND (
              LOWER(TRIM(COALESCE(forwarded_to_type, ''))) = ?
              OR LOWER(TRIM(COALESCE(forwarded_to_department, ''))) = ?
              OR LOWER(TRIM(COALESCE(forwarded_to_department, ''))) = ?
            )
            AND (
              forwarded_owner_user_id = ?
              OR (
                COALESCE(forwarded_owner_user_id, 0) = 0
                AND LOWER(TRIM(COALESCE(forwarded_owner_user_name, ''))) = ?
              )
            )
            AND COALESCE(is_deleted, 0) = 0
          ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
        `).all(
          userType,
          pipelineLabel,
          alternatePipelineLabel,
          ownId,
          ownName
        );
      }
    }
  }

    // Admin = only assigned team admissions
  else if (scope === "team") {
    const dept = String(user?.dept || "").trim().toLowerCase();
    const selectedSchoolTeamUserId = Number(
      options.schoolTeamUserId || 0
    );

    const selectedSchoolTeamUser =
      isSchoolDeptAdmin(user) && selectedSchoolTeamUserId
        ? getSchoolAdminSelectedTeamUser(
            user,
            selectedSchoolTeamUserId
          )
        : null;

    const teamNames = (
      selectedSchoolTeamUser
        ? [selectedSchoolTeamUser.name]
        : getAdminTeamNames(user)
    )
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean);

    if (!dept || !teamNames.length) {
      rows = [];
    } else {
      const placeholders = makeInPlaceholders(teamNames);

      rows = db.prepare(`
        SELECT *
        FROM admissions
        WHERE LOWER(TRIM(COALESCE(dept, ''))) = ?
          AND COALESCE(is_deleted, 0) = 0
          AND LOWER(TRIM(COALESCE(processed_by, ''))) IN (${placeholders})
        ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
      `).all(dept, ...teamNames);
    }
  }

  // Agent / Sub Agent = only own admissions
  else {
    const dept = String(user?.dept || "").trim().toLowerCase();
    const ownName = String(user?.name || "").trim().toLowerCase();

    if (!dept || !ownName) {
      rows = [];
    } else {
      rows = db.prepare(`
        SELECT *
        FROM admissions
        WHERE LOWER(TRIM(COALESCE(dept, ''))) = ?
          AND COALESCE(is_deleted, 0) = 0
          AND LOWER(TRIM(COALESCE(processed_by, ''))) = ?
        ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
      `).all(dept, ownName);
    }
  }

  const rowsWithDuplicateFlags = attachDuplicateFlagsToRawRows(rows);

  return rowsWithDuplicateFlags.map((row) => {
    const latestUpload = getLatestUploadForAdmission(row.id, user);

    const latestUploadByCurrentUser =
      user?.role === "super_admin"
        ? !!latestUpload
        : user?.role === "admin"
          ? !!latestUpload && canAccessAdmissionRow(user, row)
          : !!latestUpload?.uploadedByCurrentUser;

    const latestUploadForDashboard = makeLatestUploadForDashboard(
      latestUpload,
      user,
      perms
    );

    const forwardedByCurrentUser =
      isForwardedByCurrentUser(user, row);

    const notForwardedVisibleForCurrentUser =
      isNotForwardedVisibleForCurrentUser(user, row);

    const notReceivedVisibleForCurrentUser =
      isNotReceivedVisibleForCurrentUser(user, row);

    const mapped = mapAdmissionRow({
      ...row,

      latestUpload: latestUploadForDashboard,

      latestUploadByCurrentUser: perms?.btnFiles
        ? latestUploadByCurrentUser
        : false,

      forwardedByCurrentUser,
      notForwardedVisibleForCurrentUser,
      notReceivedVisibleForCurrentUser,

      forwardScopeVisibleForCurrentUser:
        forwardedByCurrentUser ||
        notForwardedVisibleForCurrentUser ||
        notReceivedVisibleForCurrentUser,

      // Forwarding ke server logic ke liye original latestUpload use hoga.
      canShowForwardButton:
        canCurrentUserUseForwardForRow(
          user,
          row,
          latestUpload
        ),
    });

    mapped.latestBillingVerificationNumber =
      String(row.accounts_verification_number || "").trim();

    return maskAdmissionMapped(mapped, perms);
  });
}

// ✅ Simple API key check for /api routes (admission form -> dashboard)
function checkApiKey(req, res, next) {
  const headerKey = String(req.headers["x-api-key"] || "").trim();

  const validApiKey = getApiSetting(
    "ADMISSIONS_API_KEY",
    process.env.ADMISSIONS_API_KEY || ""
  );

  if (!headerKey || !validApiKey || headerKey !== validApiKey) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or missing API key" });
  }

  next();
}

// convert DB row -> user object
function getAdmissionFormBaseUrl() {
  return String(
    getApiSetting(
      "ADMISSION_FORM_BASE_URL",
      process.env.ADMISSION_FORM_BASE_URL ||
        "https://ivs-admission-form.onrender.com/"
    ) || "https://ivs-admission-form.onrender.com/"
  )
    .trim()
    .replace(/\?+$/, "")
    .replace(/\/+$/, "/");
}

function makeProcessedByAdmissionLink(userName = "") {
  const cleanName = String(userName || "").trim();
  const baseUrl = getAdmissionFormBaseUrl();

  if (!cleanName) return baseUrl;

  return `${baseUrl}?sentBy=${encodeURIComponent(cleanName)}`;
}

function attachAdmissionLinkToUser(user) {
  if (!user) return user;

  return {
    ...user,
    admissionLink: makeProcessedByAdmissionLink(user.name),
    admission_link: makeProcessedByAdmissionLink(user.name),
  };
}

// convert DB row -> user object
function mapUserRow(row) {
  if (!row) return null;

  const user = {
    ...row,
    permissions: row.permissions ? JSON.parse(row.permissions) : {},
  };

  return attachAdmissionLinkToUser(user);
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
// ================== AUDIT CHANGE HELPERS ==================
function normalizeAuditValue(value) {
  if (value === null || typeof value === "undefined") return "";

  if (typeof value === "boolean") {
    return value ? "On" : "Off";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "").trim();
  }
}

function makeAuditChange(
  key,
  label,
  beforeValue,
  afterValue,
  category = "data"
) {
  const before = normalizeAuditValue(beforeValue);
  const after = normalizeAuditValue(afterValue);

  if (before === after) return null;

  return {
    key,
    label,
    category,
    before,
    after,
  };
}

function humanizeAuditKey(value = "") {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bPdf\b/g, "PDF")
    .replace(/\bWhatsapp\b/g, "WhatsApp");
}

function getAuditPermissionLabel(key = "") {
  const cleanKey = String(key || "").trim();

  if (cleanKey.startsWith("col")) {
    return `${humanizeAuditKey(cleanKey.slice(3))} Column`;
  }

  if (cleanKey.startsWith("btn")) {
    return `${humanizeAuditKey(cleanKey.slice(3))} Button`;
  }

  if (cleanKey.startsWith("can")) {
    return `${humanizeAuditKey(cleanKey.slice(3))} Button`;
  }

  return humanizeAuditKey(cleanKey);
}

function auditPermissionEnabled(value) {
  const finalValue = Array.isArray(value)
    ? value[value.length - 1]
    : value;

  return (
    finalValue === true ||
    finalValue === 1 ||
    finalValue === "1" ||
    finalValue === "true" ||
    finalValue === "on"
  );
}

function getAuditPermissionState(rawPermissions = {}) {
  const source =
    typeof rawPermissions === "string"
      ? safeJsonParse(rawPermissions) || {}
      : rawPermissions || {};

  return Object.fromEntries(
    PERMISSION_KEYS.map((key) => [
      key,
      auditPermissionEnabled(source[key]),
    ])
  );
}

const ADMISSION_AUDIT_FIELDS = [
  ["status", "Status", "admission"],
  ["feeStatus", "Fee Status", "admission"],
  ["dept", "Department", "admission"],
  ["student_name", "Student Name", "admission"],
  ["father_name", "Father Name", "admission"],
  ["father_email", "Father Email", "admission"],
  ["grade", "Grade", "admission"],
  ["tuition_grade", "Tuition Grade", "admission"],
  ["phone", "Phone", "admission"],
  ["processed_by", "Processed By", "admission"],

  ["accounts_payment_status", "Payment Status", "accounts"],
  ["accounts_paid_upto", "Paid Upto", "accounts"],
  [
    "accounts_verification_number",
    "Verification Number",
    "accounts",
  ],
    [
    "accounts_registration_number",
    "Registration Number",
    "accounts",
  ],
  [
    "accounts_registration_number_assigned_at",
    "Registration Number Assigned Date",
    "accounts",
  ],
  [
    "registration_number_removed",
    "Registration Number Removed",
    "accounts",
  ],
  ["accounts_family_number", "Family Number", "accounts"],

  [
    "admission_registration_fee",
    "Registration Fee",
    "fees",
  ],
  ["admission_fees", "Monthly Fee", "fees"],
  ["currency_code", "Currency", "fees"],
  ["bank_name", "Bank", "fees"],
  ["admission_month", "Admission Month", "fees"],
  ["admission_total_fees", "Total Fees", "fees"],
  ["admission_pending_dues", "Pending Dues", "fees"],
  [
    "admission_total_paid",
    "Received Payment",
    "fees",
  ],
  ["admission_comment", "Comment", "admission"],

  [
    "admission_invoice_status",
    "Invoice Status",
    "invoice",
  ],
  [
    "admission_invoice_status_timestamp",
    "Invoice Status Time",
    "invoice",
  ],
  [
    "admission_paid_invoice_status",
    "Paid Invoice Status",
    "invoice",
  ],
  [
    "admission_paid_invoice_status_timestamp",
    "Paid Invoice Status Time",
    "invoice",
  ],
];

function buildAdmissionAuditChanges(
  beforeRow = {},
  afterRow = {}
) {
  const changes = [];

  for (const [key, label, category] of ADMISSION_AUDIT_FIELDS) {
    const change = makeAuditChange(
      key,
      label,
      beforeRow?.[key],
      afterRow?.[key],
      category
    );

    if (change) changes.push(change);
  }

  return changes;
}

function buildUserAuditChanges(
  beforeRow = {},
  afterRow = {},
  options = {}
) {
  const changes = [];

  const userFields = [
    ["name", "Name"],
    ["email", "Email"],
    ["role", "Role"],
    ["dept", "Department"],
    ["agentType", "Agent Type"],
    ["access_scope", "Access Scope"],
  ];

  for (const [key, label] of userFields) {
    const change = makeAuditChange(
      key,
      label,
      beforeRow?.[key],
      afterRow?.[key],
      "user"
    );

    if (change) changes.push(change);
  }

  const beforeAssignedAdminId =
    beforeRow?.assigned_admin_id ??
    beforeRow?.managerId ??
    "";

  const afterAssignedAdminId =
    afterRow?.assigned_admin_id ??
    afterRow?.managerId ??
    "";

  const assignedAdminChange = makeAuditChange(
    "assignedAdminId",
    "Assigned Admin",
    beforeAssignedAdminId,
    afterAssignedAdminId,
    "user"
  );

  if (assignedAdminChange) {
    changes.push(assignedAdminChange);
  }

  if (options.passwordChanged) {
    changes.push({
      key: "password",
      label: "Password",
      category: "security",
      before: "Protected",
      after: "Changed",
    });
  }

  const beforePermissions = getAuditPermissionState(
    beforeRow?.permissions
  );

  const afterPermissions = getAuditPermissionState(
    afterRow?.permissions
  );

  for (const key of PERMISSION_KEYS) {
    if (
      beforePermissions[key] === afterPermissions[key]
    ) {
      continue;
    }

    changes.push({
      key: `permissions.${key}`,
      label: getAuditPermissionLabel(key),
      category: key.startsWith("col")
        ? "column_permission"
        : "button_permission",
      before: beforePermissions[key] ? "On" : "Off",
      after: afterPermissions[key] ? "On" : "Off",
    });
  }

  return changes;
}

function buildBillingAuditChanges(
  beforeBilling = {},
  afterBilling = {}
) {
  const changes = [];

  const billingFields = [
    ["status", "Status", "billing"],
    ["amount", "Received Amount", "billing"],
    ["feeOverride", "Fee", "billing"],
    [
      "verification",
      "Verification Number",
      "billing",
    ],
    ["bank", "Bank", "billing"],
    ["paymentDate", "Payment Date", "billing"],

    [
      "registrationFeeTotal",
      "Registration Fee Total",
      "registration_fee",
    ],
    [
      "registrationFeeReceived",
      "Registration Fee Received",
      "registration_fee",
    ],
    [
      "registrationFeeStatus",
      "Registration Fee Status",
      "registration_fee",
    ],
    [
      "registrationFeeVerification",
      "Registration Fee Verification",
      "registration_fee",
    ],
    [
      "registrationFeeBank",
      "Registration Fee Bank",
      "registration_fee",
    ],
    [
      "registrationFeePaymentDate",
      "Registration Fee Payment Date",
      "registration_fee",
    ],
  ];

  for (const month of BILLING_MONTHS) {
    const monthKey = String(month.key || "")
      .trim()
      .toLowerCase();

    const monthLabel =
      month.label || humanizeAuditKey(monthKey);

    const beforeMonth =
      beforeBilling?.[monthKey] || {};

    const afterMonth =
      afterBilling?.[monthKey] || {};

    for (
      const [fieldKey, fieldLabel, category]
      of billingFields
    ) {
      const change = makeAuditChange(
        `billing.${monthKey}.${fieldKey}`,
        `${monthLabel} - ${fieldLabel}`,
        beforeMonth?.[fieldKey],
        afterMonth?.[fieldKey],
        category
      );

      if (change) changes.push(change);
    }
  }

  return changes;
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
function makeOptionKey(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function ensureBillingStatusOption(label, color = "#e5e7eb") {
  try {
    const cleanLabel = String(label || "").trim();
    const optKey = makeOptionKey(cleanLabel);

    if (!cleanLabel || !optKey) return;

    const exists = db.prepare(`
      SELECT id
      FROM billing_status_options
      WHERE label = ? OR opt_key = ?
      LIMIT 1
    `).get(cleanLabel, optKey);

    if (exists) return;

    db.prepare(`
      INSERT INTO billing_status_options (opt_key, label, color, is_custom)
      VALUES (?, ?, ?, 0)
    `).run(optKey, cleanLabel, color);
  } catch (e) {
    console.error("ensureBillingStatusOption error:", e.message);
  }
}

function ensureRequiredBillingStatusOptions() {
  ensureBillingStatusOption("Not admitted", "#e5e7eb");
  ensureBillingStatusOption("No payment", "#fee2e2");
  ensureBillingStatusOption("Partial payment", "#fef3c7");
  ensureBillingStatusOption("Full payment", "#dcfce7");
  ensureBillingStatusOption("Unpaid", "#fee2e2");
}

ensureRequiredBillingStatusOptions();

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
// ================== FAMILY MATCHING HELPERS ==================
// Family match priority:
// 1) Same accounts_family_number
// 2) Same father_name + same normalized phone number
function normalizeFamilyText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeFamilyPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");

  // Pakistan/local/international formats ko match karne ke liye last 10 digits use karo
  // Example: +92 335 5245551, 0335-5245551, 3355245551 = same
  if (digits.length > 10) {
    return digits.slice(-10);
  }

  return digits;
}

function getFamilyPhoneFromRow(row) {
  return normalizeFamilyPhone(row?.phone || row?.guardian_whatsapp || "");
}

function getFamilyFatherFromRow(row) {
  return normalizeFamilyText(row?.father_name || "");
}

function getFamilyPhoneSqlExpression() {
  const cleaned = `
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                COALESCE(NULLIF(TRIM(phone), ''), guardian_whatsapp, ''),
                ' ', ''
              ),
              '-', ''
            ),
            '+', ''
          ),
          '(', ''
        ),
        ')', ''
      ),
      '.', ''
    )
  `;

  return `
    CASE
      WHEN LENGTH(${cleaned}) > 10 THEN SUBSTR(${cleaned}, -10)
      ELSE ${cleaned}
    END
  `;
}

function getAccessibleFamilyRowsByAdmission(user, row) {
  if (!row) return [];

  const familyNumber = String(row.accounts_family_number || "").trim();
  const fatherName = getFamilyFatherFromRow(row);
  const phoneNumber = getFamilyPhoneFromRow(row);

  const whereParts = [];
  const params = {};

  if (familyNumber) {
    whereParts.push("TRIM(COALESCE(accounts_family_number, '')) = @familyNumber");
    params.familyNumber = familyNumber;
  }

  if (fatherName && phoneNumber) {
    whereParts.push(`
      (
        LOWER(TRIM(COALESCE(father_name, ''))) = @fatherName
        AND ${getFamilyPhoneSqlExpression()} = @phoneNumber
      )
    `);

    params.fatherName = fatherName;
    params.phoneNumber = phoneNumber;
  }

  if (!whereParts.length) {
    return canAccessAdmissionRow(user, row) ? [row] : [];
  }

  const rows = db.prepare(`
    SELECT *
    FROM admissions
    WHERE COALESCE(is_deleted, 0) = 0
      AND (
        ${whereParts.join(" OR ")}
      )
    ORDER BY id DESC
  `).all(params);

  if (user?.role === "super_admin") {
    return rows;
  }

  return rows.filter((familyRow) => canAccessAdmissionRow(user, familyRow));
}
// ================== UPLOAD NOTIFICATION HELPERS ==================
function ensureUploadsNotificationColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info(uploads)`).all();
    const existing = new Set(cols.map((c) => String(c.name || "").trim()));

    const addColumn = (name, type) => {
      if (!existing.has(name)) {
        db.prepare(`ALTER TABLE uploads ADD COLUMN ${name} ${type}`).run();
      }
    };

    addColumn("uploaded_by_id", "INTEGER");
    addColumn("uploaded_by_name", "TEXT");
    addColumn("uploaded_by_role", "TEXT");
    addColumn("uploaded_at", "TEXT");
  } catch (e) {
    console.error("ensureUploadsNotificationColumns error:", e.message);
  }
}

ensureUploadsNotificationColumns();
function ensureUploadSeenTable() {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS upload_seen_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id INTEGER NOT NULL,
        admission_id INTEGER,
        user_id INTEGER NOT NULL,
        seen_at TEXT NOT NULL,
        UNIQUE(upload_id, user_id)
      )
    `).run();
  } catch (e) {
    console.error("ensureUploadSeenTable error:", e.message);
  }
}

ensureUploadSeenTable();
// ================== EXTERNAL UPLOAD LINK HELPERS ==================
function ensureExternalUploadLinksTable() {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS admission_external_upload_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admission_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_by_id INTEGER,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      )
    `).run();
  } catch (e) {
    console.error("ensureExternalUploadLinksTable error:", e.message);
  }
}

ensureExternalUploadLinksTable();

function makeExternalUploadToken() {
  return crypto.randomBytes(24).toString("hex");
}

function createOrGetExternalUploadLink(admissionId, user) {
  const existing = db.prepare(`
    SELECT token
    FROM admission_external_upload_links
    WHERE admission_id = ?
      AND is_active = 1
    ORDER BY id DESC
    LIMIT 1
  `).get(admissionId);

  if (existing?.token) {
    return existing.token;
  }

  const token = makeExternalUploadToken();

  db.prepare(`
    INSERT INTO admission_external_upload_links
      (admission_id, token, is_active, created_by_id, created_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(
    admissionId,
    token,
    user?.id || null,
    new Date().toISOString()
  );

  return token;
}

function getAdmissionByExternalUploadToken(token) {
  const cleanToken = String(token || "").trim();

  if (!cleanToken) return null;

  return db.prepare(`
    SELECT
      l.id AS link_id,
      l.token,
      l.is_active,
      l.admission_id,
      a.id,
      a.dept,
      a.student_name,
      a.father_name,
      a.grade,
      a.tuition_grade,
      a.phone,
      a.guardian_whatsapp
    FROM admission_external_upload_links l
    INNER JOIN admissions a
      ON a.id = l.admission_id
    WHERE l.token = ?
      AND l.is_active = 1
      AND COALESCE(a.is_deleted, 0) = 0
    LIMIT 1
  `).get(cleanToken);
}

function normalizeExternalLinkUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }

  return `https://${raw}`;
}

function isSafeExternalLink(value) {
  const clean = normalizeExternalLinkUrl(value);

  if (!clean) return false;

  try {
    const url = new URL(clean);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
function hasUserSeenUpload(uploadId, userId) {
  try {
    if (!uploadId || !userId) return false;

    const row = db.prepare(`
      SELECT id
      FROM upload_seen_logs
      WHERE upload_id = ?
        AND user_id = ?
      LIMIT 1
    `).get(uploadId, userId);

    return !!row;
  } catch (e) {
    console.error("hasUserSeenUpload error:", e.message);
    return false;
  }
}

function getUploadActor(user) {
  return {
    uploadedById: user?.id || null,
    uploadedByName: user?.name || user?.email || "Unknown User",
    uploadedByRole: user?.role || "",
    uploadedAt: new Date().toISOString(),
  };
}

function getLatestUploadForAdmission(admissionId, viewerUser = null) {
  try {
    if (!admissionId) return null;

    const row = db.prepare(`
      SELECT
        id,
        admission_id,
        original_name,
        stored_name,
        file_url,
        mime_type,
        size,
        uploaded_by_id,
        uploaded_by_name,
        uploaded_by_role,
        uploaded_at
      FROM uploads
      WHERE admission_id = ?
      ORDER BY
        datetime(COALESCE(uploaded_at, '1970-01-01')) DESC,
        id DESC
      LIMIT 1
    `).get(admissionId);

    if (!row) return null;

    const seenByCurrentUser = hasUserSeenUpload(row.id, viewerUser?.id);
    const viewerId = Number(viewerUser?.id || 0);
    const uploaderId = Number(row.uploaded_by_id || 0);
    const uploadedByCurrentUser = !!viewerId && !!uploaderId && viewerId === uploaderId;

    return {
      id: row.id,
      admissionId: row.admission_id,
      fileName: row.original_name || row.stored_name || "File",
      fileUrl: row.file_url || "",
      mimeType: row.mime_type || "",
      size: row.size || 0,
      addedBy: row.uploaded_by_name || row.uploaded_by_role || "System / Old Record",
      addedByRole: row.uploaded_by_role || (row.uploaded_by_name ? "" : "Old file record"),
      uploadedAt: row.uploaded_at || "",
      uploadedById: row.uploaded_by_id || null,
      uploadedByName: row.uploaded_by_name || "",
      uploadedByRole: row.uploaded_by_role || "",
      uploadedByCurrentUser,
      isUrl: row.mime_type === "text/url",
      seenByCurrentUser,
    };
  } catch (e) {
    console.error("getLatestUploadForAdmission error:", e.message);
    return null;
  }
}

function makeLatestUploadForDashboard(
  latestUpload,
  viewerUser,
  viewerPerms = null
) {
  if (!latestUpload) return null;

  const perms = viewerPerms || getPerm(viewerUser);

  if (perms?.btnFiles) {
    return latestUpload;
  }

  // Permission off:
  // icon visible rahe, lekin file metadata template ko na mile.
  return {
    available: true,
  };
}

const ADMISSION_FORWARD_DEPARTMENTS = [
  "Print + Record update",
  "Verification & Registration",
  "Paid slip",
];
const SCHOOL_AGENT_TYPES = ["accounts", "admission", "management"];

const SCHOOL_ACCOUNTS_AGENT_TYPES = [
  "print_record_update",
  "verification_registration",
  "paid_slip",
];

const SCHOOL_ACCOUNTS_WORKFLOW_STAGES = [
  "new_admissions",
  "record_to_update",
  "old_admissions",
];

const SCHOOL_ACCOUNTS_SOURCE_TYPES = [
  "school",
  "print_record_update",
  "verification_registration",
  "paid_slip",
  "record_to_update",
  "internal_department",
];

function normalizeAccountsWorkflowStage(value = "") {
  const clean = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const aliases = {
    new: "new_admissions",
    new_admission: "new_admissions",
    new_admissions: "new_admissions",
    record_update: "record_to_update",
    record_to_update: "record_to_update",
    recordtoupdate: "record_to_update",
    old: "old_admissions",
    old_admission: "old_admissions",
    old_admissions: "old_admissions",
    completed: "old_admissions",
  };

  const finalStage = aliases[clean] || clean;

  return SCHOOL_ACCOUNTS_WORKFLOW_STAGES.includes(finalStage)
    ? finalStage
    : "new_admissions";
}

function normalizeAccountsSourceType(value = "") {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();

  const aliases = {
    school: "school",
    "school department": "school",
    school_department: "school",

    "internal department": "internal_department",
    internal_department: "internal_department",
    internal: "internal_department",

    "print + record update": "print_record_update",
    "print & record update": "print_record_update",
    print_record_update: "print_record_update",

    "verification & registration": "verification_registration",
    verification_registration: "verification_registration",

    "paid slip": "paid_slip",
    "fee slip": "paid_slip",
    paid_slip: "paid_slip",
    fee_slip: "paid_slip",

    "record to update": "record_to_update",
    record_to_update: "record_to_update",
  };

  const normalized = aliases[lower] || aliases[lower.replace(/[\s-]+/g, "_")] || "";

  return SCHOOL_ACCOUNTS_SOURCE_TYPES.includes(normalized)
    ? normalized
    : "";
}

function getAccountsPipelineTypeFromRow(row = {}) {
  return normalizeForwardType(
    row.forwarded_to_type ||
    row.forwardedToType ||
    row.forwarded_to_department ||
    row.forwardedToDepartment ||
    ""
  );
}

function getAccountsWorkflowStageFromRow(row = {}) {
  return normalizeAccountsWorkflowStage(
    row.accounts_workflow_stage ||
    row.accountsWorkflowStage ||
    "new_admissions"
  );
}

function getAccountsSourceTypeFromRow(row = {}) {
  const savedSource = normalizeAccountsSourceType(
    row.forwarded_from_type ||
    row.forwardedFromType ||
    row.forwarded_from_department ||
    row.forwardedFromDepartment ||
    ""
  );

  if (savedSource) {
    const pipelineType = getAccountsPipelineTypeFromRow(row);

    if (
      pipelineType &&
      savedSource === pipelineType &&
      getAccountsWorkflowStageFromRow(row) !== "old_admissions"
    ) {
      return "internal_department";
    }

    return savedSource;
  }

  // Safe fallback for admissions forwarded before source tracking was added.
  return "school";
}

function isAccountsInternalDepartmentRow(row = {}) {
  if (!row) return false;

  const workflowStage = getAccountsWorkflowStageFromRow(row);
  if (workflowStage === "old_admissions") return false;

  const pipelineType = getAccountsPipelineTypeFromRow(row);
  const rawSource = normalizeAccountsSourceType(
    row.forwarded_from_type ||
    row.forwardedFromType ||
    row.forwarded_from_department ||
    row.forwardedFromDepartment ||
    ""
  );

  return !!pipelineType && !!rawSource && pipelineType === rawSource;
}

function accountsSourceTypeToDepartmentLabel(type = "") {
  const clean = normalizeAccountsSourceType(type);

  const map = {
    school: "School Department",
    print_record_update: "Print + Record update",
    verification_registration: "Verification & Registration",
    paid_slip: "Paid slip",
    record_to_update: "Record to Update",
    internal_department: "Internal Department",
  };

  return map[clean] || "";
}

function isPaidSlipAgentOrSubAgent(user) {
  if (!user || !isAccountsUser(user)) return false;
  if (user.role !== "agent" && user.role !== "sub_agent") return false;

  return normalizeAgentTypeForDept(
    user.agentType || "",
    user.dept || ""
  ) === "paid_slip";
}

function isTruthyRequestFlag(value) {
  const finalValue = Array.isArray(value)
    ? value[value.length - 1]
    : value;

  return [true, 1, "1", "true", "yes", "on", "approved"].includes(
    typeof finalValue === "string"
      ? finalValue.trim().toLowerCase()
      : finalValue
  );
}

function isSchoolAccountsDeptValue(dept = "") {
  const d = String(dept || "").trim().toLowerCase();
  return d === "accounts" || d === "school accounts" || d === "school_accounts";
}

function getAllowedAgentTypesForDept(dept = "") {
  if (isSchoolAccountsDeptValue(dept)) {
    return SCHOOL_ACCOUNTS_AGENT_TYPES;
  }

  return SCHOOL_AGENT_TYPES;
}

function normalizeAgentTypeForDept(agentType = "", dept = "") {
  const clean = String(agentType || "").trim();
  const lower = clean.toLowerCase();

  const labelToKey = {
    "print + record update": "print_record_update",
    "print & record update": "print_record_update",
    "verification & registration": "verification_registration",
    "paid slip": "paid_slip",
    "fee slip": "paid_slip",
  };

  const finalType = labelToKey[lower] || clean;
  const allowedTypes = getAllowedAgentTypesForDept(dept);

  return allowedTypes.includes(finalType) ? finalType : allowedTypes[0];
}
function canCurrentUserUseForwardForRow(
  user,
  row,
  latestUpload = null
) {
  if (!user || !row) return false;

  const rowDept = String(
    row.dept || ""
  )
    .trim()
    .toLowerCase();

  const userDept = String(
    user.dept || ""
  )
    .trim()
    .toLowerCase();

  const schoolReturnStatus = String(
    row.school_return_status || ""
  )
    .trim()
    .toLowerCase();

  if (rowDept !== "school") {
    return false;
  }

  /*
   * Not Received mein purani file ki wajah se
   * Forward button show nahi hona chahiye.
   * Reupload ke baad status "reupload" hoga,
   * phir Forward button allow hoga.
   */
  if (schoolReturnStatus === "not_received") {
    return false;
  }

  if (
    user.role !== "super_admin" &&
    userDept !== "school" &&
    !isAccountsUser(user)
  ) {
    return false;
  }

  /*
   * Normal School admission ke liye Super Admin
   * aur School Accounts ka existing access same rahega.
   */
  if (
    user.role === "super_admin" ||
    isAccountsUser(user)
  ) {
    return canAccessAdmissionRow(
      user,
      row
    );
  }

  // School users ke liye upload required hai.
  if (!latestUpload) {
    return false;
  }

  // School Admin apni accessible/team admission forward karega.
  if (user.role === "admin") {
    return canAccessAdmissionRow(
      user,
      row
    );
  }

  /*
   * School Agent/Sub Agent sirf apni uploaded
   * file wali admission forward kar sakta hai.
   */
  const viewerId =
    Number(user.id || 0);

  const uploaderId =
    Number(
      latestUpload?.uploadedById || 0
    );

  return (
    !!viewerId &&
    !!uploaderId &&
    viewerId === uploaderId
  );
}
function findUserByNameForForwardOwner(name = "") {
  try {
    const cleanName = String(name || "").trim();
    if (!cleanName) return null;

    return db.prepare(`
      SELECT id, name, email, role, dept
      FROM users
      WHERE LOWER(TRIM(COALESCE(name, ''))) = LOWER(TRIM(?))
      LIMIT 1
    `).get(cleanName);
  } catch (e) {
    console.error("findUserByNameForForwardOwner error:", e.message);
    return null;
  }
}

function getForwardOwnerForAdmission({ actorUser, row, latestUpload }) {
  const actorRole = String(actorUser?.role || "").trim();

  // Agent/Sub Agent khud forward kare to owner wahi current user hoga.
  if (actorRole === "agent" || actorRole === "sub_agent") {
    return {
      id: actorUser?.id || null,
      name: actorUser?.name || actorUser?.email || "",
      role: actorUser?.role || "",
    };
  }

  // Super Admin/Admin forward kare to owner admission ka processed_by user hoga.
  const processedByName = String(row?.processed_by || "").trim();
  const processedUser = findUserByNameForForwardOwner(processedByName);

  if (processedUser) {
    return {
      id: processedUser.id || null,
      name: processedUser.name || processedUser.email || processedByName,
      role: processedUser.role || "",
    };
  }

  // Fallback: latest uploader internal user ho to owner latest uploader hoga.
  if (latestUpload?.uploadedById) {
    return {
      id: latestUpload.uploadedById || null,
      name: latestUpload.uploadedByName || "",
      role: latestUpload.uploadedByRole || "",
    };
  }

  // Last fallback: actor ko owner bana do.
  return {
    id: actorUser?.id || null,
    name: actorUser?.name || actorUser?.email || "",
    role: actorUser?.role || "",
  };
}

function getRequestedForwardOwnerId(body = {}) {
  const raw =
    body.targetUserId ??
    body.toUserId ??
    body.assignedUserId ??
    body.forwardedOwnerUserId ??
    body.forwarded_owner_user_id ??
    body.recipientUserId ??
    "";

  return Number(raw || 0) || 0;
}

function getSelectedAccountsForwardOwner(body = {}, toType = "") {
  const targetUserId = getRequestedForwardOwnerId(body);
  const cleanToType = normalizeForwardType(toType);

  if (!targetUserId || !cleanToType) return null;

  const targetUser = db.prepare(`
    SELECT id, name, email, role, dept, agentType, assigned_admin_id, managerId
    FROM users
    WHERE id = ?
      AND role IN ('agent', 'sub_agent')
    LIMIT 1
  `).get(targetUserId);

  if (!targetUser || !isAccountsUser(targetUser)) return null;

  const targetType = normalizeAgentTypeForDept(
    targetUser.agentType || "",
    targetUser.dept || ""
  );

  if (targetType !== cleanToType) return null;

  return {
    id: targetUser.id,
    name: targetUser.name || targetUser.email || "",
    role: targetUser.role || "",
    dept: targetUser.dept || "",
    agentType: targetType,
  };
}

function getForwardSourceForAdmission(row, actorUser) {
  const currentPipelineType = getAccountsPipelineTypeFromRow(row);

  if (currentPipelineType) {
    return {
      type: currentPipelineType,
      department: forwardTypeToDepartmentLabel(currentPipelineType),
    };
  }

  const actorType = isAccountsUser(actorUser)
    ? normalizeAgentTypeForDept(
        actorUser?.agentType || "",
        actorUser?.dept || ""
      )
    : "";

  if (actorType) {
    return {
      type: actorType,
      department: forwardTypeToDepartmentLabel(actorType),
    };
  }

  return {
    type: "school",
    department: "School Department",
  };
}

function normalizeIssueFields(value) {
  const incoming = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim());

  return [...new Set(
    incoming
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
}

function rememberAccountsWorkflowUser(admissionId, user, assignedAt = "") {
  try {
    const cleanAdmissionId = Number(admissionId || 0);
    const cleanUserId = Number(user?.id || 0);

    if (!cleanAdmissionId || !cleanUserId || !isAccountsUser(user)) {
      return;
    }

    const when = String(assignedAt || new Date().toISOString()).trim();
    const agentType = normalizeAgentTypeForDept(
      user.agentType || "",
      user.dept || ""
    );

    db.prepare(`
      INSERT INTO admission_accounts_workflow_users (
        admission_id,
        user_id,
        user_name,
        user_role,
        agent_type,
        first_assigned_at,
        last_assigned_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(admission_id, user_id)
      DO UPDATE SET
        user_name = excluded.user_name,
        user_role = excluded.user_role,
        agent_type = excluded.agent_type,
        last_assigned_at = excluded.last_assigned_at
    `).run(
      cleanAdmissionId,
      cleanUserId,
      user.name || user.email || "",
      user.role || "",
      agentType || "",
      when,
      when
    );
  } catch (err) {
    console.error("rememberAccountsWorkflowUser error:", err.message);
  }
}

function hasAccountsWorkflowHistoryForUser(admissionId, userId) {
  try {
    const cleanAdmissionId = Number(admissionId || 0);
    const cleanUserId = Number(userId || 0);

    if (!cleanAdmissionId || !cleanUserId) return false;

    const row = db.prepare(`
      SELECT admission_id
      FROM admission_accounts_workflow_users
      WHERE admission_id = ?
        AND user_id = ?
      LIMIT 1
    `).get(cleanAdmissionId, cleanUserId);

    return !!row;
  } catch (err) {
    console.error("hasAccountsWorkflowHistoryForUser error:", err.message);
    return false;
  }
}
function canSeeCompletedAccountsOldAdmission(user, row) {
  if (!user || !row) return false;

  const workflowStage = getAccountsWorkflowStageFromRow(row);
  if (workflowStage !== "old_admissions") return false;

  const status = String(row.forward_status || row.forwardStatus || "")
    .trim()
    .toLowerCase();
  if (status !== "forwarded") return false;

  if (user.role === "super_admin") return true;
  if (!isAccountsUser(user)) return false;

  if (user.role === "admin") return true;

  if (user.role !== "agent" && user.role !== "sub_agent") {
    return false;
  }

  const viewerId = Number(user.id || 0);
  const completedById = Number(
    row.accounts_completed_by_id ||
    row.accountsCompletedById ||
    0
  );

  if (viewerId && completedById) {
    return viewerId === completedById;
  }

  const viewerName = String(user.name || "").trim().toLowerCase();
  const completedByName = String(
    row.accounts_completed_by_name ||
    row.accountsCompletedByName ||
    ""
  )
    .trim()
    .toLowerCase();

  return !!viewerName && !!completedByName && viewerName === completedByName;
}

function buildForwardDisplayText(row) {
  const transferNote = String(row?.accounts_transfer_note || "").trim();
  if (transferNote) return transferNote;

  const status = String(row?.forward_status || "").trim().toLowerCase();
  if (status !== "forwarded") return "";

  const byName = String(row?.forwarded_by_name || "").trim() || "Unknown user";
  const toDept = String(row?.forwarded_to_department || "").trim() || "department";
  const ownerName = String(row?.forwarded_owner_user_name || "").trim();

  if (ownerName && ownerName.toLowerCase() !== byName.toLowerCase()) {
    return `Forwarded by ${byName} to ${toDept} for ${ownerName}`;
  }

  return `Forwarded by ${byName} to ${toDept}`;
}

function isSchoolAccountsPipelineTransferUserRow(row = {}) {
  if (!row) return false;

  const role = String(row.role || "").trim();
  if (role !== "agent" && role !== "sub_agent") return false;
  if (!isSchoolAccountsDeptValue(row.dept || "")) return false;

  const pipelineType = normalizeAgentTypeForDept(
    row.agentType || "",
    row.dept || ""
  );

  return SCHOOL_ACCOUNTS_AGENT_TYPES.includes(pipelineType);
}

function getAccountsPipelineTransferMetaForUser(row = {}) {
  if (!isSchoolAccountsPipelineTransferUserRow(row)) {
    return {
      eligible: false,
      pipelineType: "",
      pipelineLabel: "",
    };
  }

  const pipelineType = normalizeAgentTypeForDept(
    row.agentType || "",
    row.dept || ""
  );

  return {
    eligible: true,
    pipelineType,
    pipelineLabel: forwardTypeToDepartmentLabel(pipelineType),
  };
}

function getAccountsPipelineTransferTargetUsers({
  sourceUserId = 0,
  pipelineType = "",
} = {}) {
  try {
    const cleanSourceUserId = Number(sourceUserId || 0);
    const cleanPipelineType = normalizeForwardType(pipelineType);

    if (!cleanPipelineType) return [];

    const rows = db.prepare(`
      SELECT
        id,
        name,
        email,
        role,
        dept,
        agentType
      FROM users
      WHERE role IN ('agent', 'sub_agent')
        AND id != ?
      ORDER BY name ASC
    `).all(cleanSourceUserId);

    return rows
      .filter((row) => isAccountsUser(row))
      .filter((row) =>
        normalizeAgentTypeForDept(
          row.agentType || "",
          row.dept || ""
        ) === cleanPipelineType
      )
      .map((row) => ({
        id: row.id,
        name: row.name || row.email || `User #${row.id}`,
        email: row.email || "",
        role: row.role || "",
        dept: row.dept || "",
        agentType: cleanPipelineType,
        pipelineLabel: forwardTypeToDepartmentLabel(cleanPipelineType),
      }));
  } catch (err) {
    console.error("getAccountsPipelineTransferTargetUsers error:", err.message);
    return [];
  }
}

function getAccountsPipelineTransferTargetUser({
  targetUserId = 0,
  sourceUserId = 0,
  pipelineType = "",
} = {}) {
  const cleanTargetUserId = Number(targetUserId || 0);
  if (!cleanTargetUserId) return null;

  const targets = getAccountsPipelineTransferTargetUsers({
    sourceUserId,
    pipelineType,
  });

  return targets.find((user) => Number(user.id || 0) === cleanTargetUserId) || null;
}

function getAccountsPipelineTransferAdmissionsForUser(
  sourceUserRow = {},
  pipelineType = ""
) {
  try {
    const cleanPipelineType = normalizeForwardType(pipelineType);
    const sourceUserId = Number(sourceUserRow?.id || 0);
    const sourceUserName = String(sourceUserRow?.name || "")
      .trim()
      .toLowerCase();

    if (!cleanPipelineType || !sourceUserId) return [];

    const pipelineLabel = forwardTypeToDepartmentLabel(cleanPipelineType).toLowerCase();
    const alternatePipelineLabel =
      cleanPipelineType === "print_record_update"
        ? "print & record update"
        : pipelineLabel;

    return db.prepare(`
      SELECT *
      FROM admissions
      WHERE LOWER(TRIM(COALESCE(dept, ''))) = 'school'
        AND LOWER(TRIM(COALESCE(forward_status, ''))) = 'forwarded'
        AND COALESCE(is_deleted, 0) = 0
        AND (
          LOWER(TRIM(COALESCE(forwarded_to_type, ''))) = @pipelineType
          OR LOWER(TRIM(COALESCE(forwarded_to_department, ''))) = @pipelineLabel
          OR LOWER(TRIM(COALESCE(forwarded_to_department, ''))) = @alternatePipelineLabel
        )
        AND (
          (
            LOWER(TRIM(COALESCE(accounts_workflow_stage, 'new_admissions'))) != 'old_admissions'
            AND (
              forwarded_owner_user_id = @sourceUserId
              OR (
                COALESCE(forwarded_owner_user_id, 0) = 0
                AND LOWER(TRIM(COALESCE(forwarded_owner_user_name, ''))) = @sourceUserName
              )
            )
          )
          OR
          (
            LOWER(TRIM(COALESCE(accounts_workflow_stage, 'new_admissions'))) = 'old_admissions'
            AND (
              accounts_completed_by_id = @sourceUserId
              OR (
                COALESCE(accounts_completed_by_id, 0) = 0
                AND LOWER(TRIM(COALESCE(accounts_completed_by_name, ''))) = @sourceUserName
              )
            )
          )
        )
      ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
    `).all({
      pipelineType: cleanPipelineType,
      pipelineLabel,
      alternatePipelineLabel,
      sourceUserId,
      sourceUserName,
    });
  } catch (err) {
    console.error("getAccountsPipelineTransferAdmissionsForUser error:", err.message);
    return [];
  }
}

function getAccountsPipelineTransferCountForUser(
  sourceUserRow = {},
  pipelineType = ""
) {
  return getAccountsPipelineTransferAdmissionsForUser(
    sourceUserRow,
    pipelineType
  ).length;
}

function buildAccountsPipelineTransferInfoForUser(row = {}) {
  const meta = getAccountsPipelineTransferMetaForUser(row);

  if (!meta.eligible || !meta.pipelineType) {
    return {
      eligible: false,
      count: 0,
      currentPipelineType: "",
      currentPipelineLabel: "",
      targets: [],
    };
  }

  const count = getAccountsPipelineTransferCountForUser(
    row,
    meta.pipelineType
  );

  return {
    eligible: count > 0,
    count,
    currentPipelineType: meta.pipelineType,
    currentPipelineLabel: meta.pipelineLabel,
    sourceUserId: Number(row?.id || 0),
    sourceUserName: String(row?.name || row?.email || "").trim(),
    targets: getAccountsPipelineTransferTargetUsers({
      sourceUserId: Number(row?.id || 0),
      pipelineType: meta.pipelineType,
    }),
  };
}

function shouldRequireAccountsPipelineTransfer({
  existingRow = {},
  nextRole = "",
  nextDept = "",
  nextAgentType = "",
} = {}) {
  const oldMeta = getAccountsPipelineTransferMetaForUser(existingRow);
  if (!oldMeta.eligible || !oldMeta.pipelineType) {
    return {
      required: false,
      oldPipelineType: "",
      oldPipelineLabel: "",
    };
  }

  const nextIsPipelineRole =
    nextRole === "agent" ||
    nextRole === "sub_agent";

  const nextIsSchoolAccounts =
    isSchoolAccountsDeptValue(nextDept || "");

  const normalizedNextType =
    nextIsPipelineRole && nextIsSchoolAccounts
      ? normalizeAgentTypeForDept(nextAgentType || "", nextDept || "")
      : "";

  const required =
    !nextIsPipelineRole ||
    !nextIsSchoolAccounts ||
    normalizedNextType !== oldMeta.pipelineType;

  return {
    required,
    oldPipelineType: oldMeta.pipelineType,
    oldPipelineLabel: oldMeta.pipelineLabel,
    nextPipelineType: normalizedNextType,
  };
}

function transferAccountsPipelineAdmissionsForUserChange({
  sourceUserRow = {},
  targetUserRow = {},
  pipelineType = "",
  actorUser = {},
} = {}) {
  const cleanPipelineType = normalizeForwardType(pipelineType);
  const sourceUserId = Number(sourceUserRow?.id || 0);
  const targetUserId = Number(targetUserRow?.id || 0);

  if (!cleanPipelineType || !sourceUserId || !targetUserId) {
    return {
      count: 0,
      admissionIds: [],
      note: "",
    };
  }

  const rows = getAccountsPipelineTransferAdmissionsForUser(
    sourceUserRow,
    cleanPipelineType
  );

  if (!rows.length) {
    return {
      count: 0,
      admissionIds: [],
      note: "",
    };
  }

  const now = new Date().toISOString();

  const sourceName = String(
    sourceUserRow?.name ||
    sourceUserRow?.email ||
    `User #${sourceUserId}`
  ).trim();

  const targetName = String(
    targetUserRow?.name ||
    targetUserRow?.email ||
    `User #${targetUserId}`
  ).trim();

  const actorName = String(
    actorUser?.name ||
    actorUser?.email ||
    "Super Admin"
  ).trim();

  const actorRole = String(
    actorUser?.role ||
    "super_admin"
  ).trim();

  const targetRole = String(
    targetUserRow?.role ||
    ""
  ).trim();

  const note =
    `Transferred by ${actorName} from ${sourceName} to ${targetName} due to pipeline type change.`;

  const transferOne = db.transaction((admissionRows) => {
    for (const row of admissionRows) {
      const workflowStage = getAccountsWorkflowStageFromRow(row);
      const isOldAdmission = workflowStage === "old_admissions";

      db.prepare(`
        UPDATE admissions
        SET forwarded_owner_user_id = @targetUserId,
            forwarded_owner_user_name = @targetUserName,
            forwarded_owner_user_role = @targetUserRole,

            accounts_transfer_note = @note,
            accounts_transfer_reason = 'pipeline_type_change',
            accounts_transfer_from_user_id = @sourceUserId,
            accounts_transfer_from_user_name = @sourceUserName,
            accounts_transfer_from_user_role = @sourceUserRole,
            accounts_transfer_to_user_id = @targetUserId,
            accounts_transfer_to_user_name = @targetUserName,
            accounts_transfer_to_user_role = @targetUserRole,
            accounts_transfer_by_id = @actorUserId,
            accounts_transfer_by_name = @actorName,
            accounts_transfer_by_role = @actorRole,
            accounts_transfer_at = @now,

            forwarded_by_id = @actorUserId,
            forwarded_by_name = @actorName,
            forwarded_by_role = @actorRole,
            forwarded_at = @now,

            accounts_completed_by_id =
              CASE
                WHEN @isOldAdmission = 1 THEN @targetUserId
                ELSE accounts_completed_by_id
              END,
            accounts_completed_by_name =
              CASE
                WHEN @isOldAdmission = 1 THEN @targetUserName
                ELSE accounts_completed_by_name
              END,
            accounts_completed_by_role =
              CASE
                WHEN @isOldAdmission = 1 THEN @targetUserRole
                ELSE accounts_completed_by_role
              END,

            last_activity_at = datetime('now')
        WHERE id = @admissionId
          AND COALESCE(is_deleted, 0) = 0
      `).run({
        admissionId: row.id,
        targetUserId,
        targetUserName: targetName,
        targetUserRole: targetRole,
        note,
        sourceUserId,
        sourceUserName: sourceName,
        sourceUserRole: sourceUserRow?.role || "",
        actorUserId: actorUser?.id || null,
        actorName,
        actorRole,
        now,
        isOldAdmission: isOldAdmission ? 1 : 0,
      });

      rememberAccountsWorkflowUser(row.id, {
        id: targetUserId,
        name: targetName,
        role: targetRole,
        dept: targetUserRow?.dept || "",
        agentType: cleanPipelineType,
      }, now);

      if (!isOldAdmission) {
        restartAdmissionForwardTimer({
          admissionId: row.id,
          holderUser: {
            id: targetUserId,
            name: targetName,
            role: targetRole,
            dept: targetUserRow?.dept || "",
            agentType: cleanPipelineType,
          },
          holderDepartment: "School Accounts Department",
          holderType: forwardTypeToDepartmentLabel(cleanPipelineType),
          startedAt: now,
          endedByUser: actorUser,
        });
      }
    }
  });

  transferOne(rows);

  try {
    logAudit("accounts_pipeline_admissions_transferred", actorUser, {
      targetUserId: sourceUserId,
      targetUserName: sourceName,
      dept: "school",
      details: {
        reason: "pipeline_type_change",
        pipelineType: cleanPipelineType,
        pipelineLabel: forwardTypeToDepartmentLabel(cleanPipelineType),
        transferredFromUserId: sourceUserId,
        transferredFromUserName: sourceName,
        transferredToUserId: targetUserId,
        transferredToUserName: targetName,
        transferredBy: actorName,
        transferredAt: now,
        admissionIds: rows.map((row) => row.id),
        count: rows.length,
        note,
      },
    });
  } catch (err) {
    console.error("accounts_pipeline_admissions_transferred audit error:", err.message);
  }

  return {
    count: rows.length,
    admissionIds: rows.map((row) => row.id),
    note,
  };
}
function isForwardedByCurrentUser(user, row) {
  if (!user || !row) return false;

  const status = String(row.forward_status || "").trim().toLowerCase();
  if (status !== "forwarded") return false;

  if (getForwardSubStatus(row) === "not_received") {
    return isNotReceivedVisibleForCurrentUser(user, row);
  }

  // Super Admin ko sab forwarded admissions show hon.
  if (user.role === "super_admin") {
    return true;
  }

  // School Department users keep seeing their own/team admission even after
  // School Accounts transfers it internally to another pipeline.
  if (isSchoolDepartmentUser(user)) {
    return canAccessAdmissionRow(user, row);
  }

  // Accounts Admin sees all currently accessible forwarded admissions.
  if (user.role === "admin") {
    return canAccessAdmissionRow(user, row);
  }

  const viewerId = Number(user.id || 0);
  const ownerUserId = Number(row.forwarded_owner_user_id || 0);
  const forwardedById = Number(row.forwarded_by_id || 0);

  return (
    !!viewerId &&
    (
      (!!ownerUserId && viewerId === ownerUserId) ||
      (!!forwardedById && viewerId === forwardedById)
    )
  );
}
function normalizeForwardDepartment(value) {
  const clean = String(value || "").trim();

  const found = ADMISSION_FORWARD_DEPARTMENTS.find(
    (x) => x.toLowerCase() === clean.toLowerCase()
  );

  return found || "";
}
function normalizeForwardType(value = "") {
  const clean = String(value || "").trim();
  const lower = clean.toLowerCase();

  const labelToKey = {
    "print + record update": "print_record_update",
    "print & record update": "print_record_update",
    "verification & registration": "verification_registration",
    "paid slip": "paid_slip",
    "fee slip": "paid_slip",
  };

  const finalType = labelToKey[lower] || clean;
  return SCHOOL_ACCOUNTS_AGENT_TYPES.includes(finalType) ? finalType : "";
}

function forwardTypeToDepartmentLabel(type = "") {
  const cleanType = normalizeForwardType(type);

  const map = {
    print_record_update: "Print + Record update",
    verification_registration: "Verification & Registration",
    paid_slip: "Paid slip",
  };

  return map[cleanType] || "";
}
function isSchoolDepartmentUser(user) {
  return String(user?.dept || "").trim().toLowerCase() === "school";
}

function isSchoolReturnTarget(value = "") {
  const clean = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  return [
    "school",
    "school_department",
    "school_return",
    "return_to_school",
  ].includes(clean);
}

function canUseSchoolForwardFilters(user) {
  return !!user && (
    user.role === "super_admin" ||
    isSchoolDepartmentUser(user)
  );
}

function getSchoolReturnOwnerForAdmission(row) {
  const processedByName = String(row?.processed_by || "").trim();
  const processedUser = findUserByNameForForwardOwner(processedByName);

  if (
    processedUser &&
    String(processedUser.dept || "").trim().toLowerCase() === "school"
  ) {
    return {
      id: processedUser.id || null,
      name: processedUser.name || processedUser.email || processedByName,
      role: processedUser.role || "",
    };
  }

  const existingOwnerId = Number(row?.forwarded_owner_user_id || 0);

  if (existingOwnerId) {
    const existingOwner = db.prepare(`
      SELECT id, name, email, role, dept
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(existingOwnerId);

    if (
      existingOwner &&
      String(existingOwner.dept || "").trim().toLowerCase() === "school"
    ) {
      return {
        id: existingOwner.id || null,
        name: existingOwner.name || existingOwner.email || "",
        role: existingOwner.role || "",
      };
    }
  }

  return {
    id: null,
    name: processedByName,
    role: "",
  };
}

function getForwardSubStatus(row) {
  const returnStatus = String(
    row?.school_return_status || ""
  )
    .trim()
    .toLowerCase();

  if (
    returnStatus === "not_received" ||
    returnStatus === "reupload"
  ) {
    return "not_received";
  }

  return String(
    row?.accounts_registration_number || ""
  ).trim()
    ? "verified"
    : "not_verified";
}

function getAdmissionWorkflowTag(row) {
  const returnStatus = String(
    row?.school_return_status || ""
  )
    .trim()
    .toLowerCase();

  const reuploadTagActive =
    Number(
      row?.reupload_tag_active || 0
    ) === 1;

  const registrationNumberRemoved =
    Number(
      row?.registration_number_removed || 0
    ) === 1;

  /*
   * Not Received ko highest priority milegi.
   * Is stage mein orange Reupload tag temporarily
   * red Not Received tag ke peeche hidden rahega.
   */
  if (returnStatus === "not_received") {
    return "Not Received";
  }

  /*
   * Forward ke baad return status empty ho sakta hai,
   * lekin persistent flag ki wajah se tag rahega.
   */
  if (
    returnStatus === "reupload" ||
    reuploadTagActive
  ) {
    return "Reupload";
  }

  if (registrationNumberRemoved) {
    return "Registration Number Removed";
  }

  return "";
}

function isNotReceivedVisibleForCurrentUser(user, row) {
  if (!user || !row || !canUseSchoolForwardFilters(user)) {
    return false;
  }

  const returnStatus = String(row.school_return_status || "")
    .trim()
    .toLowerCase();

  if (returnStatus !== "not_received" && returnStatus !== "reupload") {
    return false;
  }

  if (user.role === "super_admin") {
    return true;
  }

  if (user.role === "admin") {
    return canAccessAdmissionRow(user, row);
  }

  const viewerId = Number(user.id || 0);
  const returnedToUserId = Number(row.school_returned_to_user_id || 0);

  if (viewerId && returnedToUserId) {
    return viewerId === returnedToUserId;
  }

  return canAccessAdmissionRow(user, row);
}

function toWorkflowDateOnly(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const directMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toISOString().slice(0, 10);
}

function matchesWorkflowDateFilters(admission, filters = {}) {
  const registrationDate = toWorkflowDateOnly(
    admission?.registrationDate ||
    admission?.registration_date
  );

  const assignedDate = toWorkflowDateOnly(
    admission?.registrationNumberAssignedAt ||
    admission?.accounts_registration_number_assigned_at ||
    admission?.accounts?.registrationNumberAssignedAt
  );

  const registrationExact = String(filters.registrationExact || "").trim();
  const registrationFrom = String(filters.registrationFrom || "").trim();
  const registrationTo = String(filters.registrationTo || "").trim();

  const assignedExact = String(filters.assignedExact || "").trim();
  const assignedFrom = String(filters.assignedFrom || "").trim();
  const assignedTo = String(filters.assignedTo || "").trim();

  if (registrationExact && registrationDate !== registrationExact) {
    return false;
  }

  if (
    registrationFrom &&
    (!registrationDate || registrationDate < registrationFrom)
  ) {
    return false;
  }

  if (
    registrationTo &&
    (!registrationDate || registrationDate > registrationTo)
  ) {
    return false;
  }

  if (assignedExact && assignedDate !== assignedExact) {
    return false;
  }

  if (
    assignedFrom &&
    (!assignedDate || assignedDate < assignedFrom)
  ) {
    return false;
  }

  if (
    assignedTo &&
    (!assignedDate || assignedDate > assignedTo)
  ) {
    return false;
  }

  return true;
}
function canSeeSchoolAccountsAdmission(user, row, requestedView = "new_admissions") {
  if (!user || !row) return false;

  const rowDept = String(row.dept || "").trim().toLowerCase();
  const status = String(row.forward_status || row.forwardStatus || "")
    .trim()
    .toLowerCase();

  const pipelineType = getAccountsPipelineTypeFromRow(row);
  const workflowStage = getAccountsWorkflowStageFromRow(row);
  const wantedView = normalizeAccountsWorkflowStage(requestedView);

  if (rowDept !== "school") return false;
  if (status !== "forwarded") return false;
  if (!pipelineType) return false;

  if (wantedView === "old_admissions") {
    if (workflowStage !== "old_admissions") return false;

    if (user.role === "super_admin") return true;
    if (!isAccountsUser(user)) return false;

    return canSeeCompletedAccountsOldAdmission(user, row);
  }

  if (workflowStage === "old_admissions") {
    return false;
  }

  if (user.role === "super_admin") return true;
  if (!isAccountsUser(user)) return false;

  return canAccessAdmissionRow(user, row);
}

function matchesSchoolAccountsPipelineFilter(row, filterValue = "") {
  const filterType = normalizeForwardType(filterValue);
  if (!filterType) return true;

  return getAccountsPipelineTypeFromRow(row) === filterType;
}

function matchesSchoolAccountsSourceFilter(row, filterValue = "") {
  const cleanFilter = normalizeAccountsSourceType(filterValue);
  if (!cleanFilter) return true;

  const workflowStage = getAccountsWorkflowStageFromRow(row);

  if (cleanFilter === "record_to_update") {
    return (
      workflowStage === "record_to_update" &&
      getAccountsPipelineTypeFromRow(row) === "print_record_update"
    );
  }

  if (cleanFilter === "internal_department") {
    return isAccountsInternalDepartmentRow(row);
  }

  return getAccountsSourceTypeFromRow(row) === cleanFilter;
}
function makeEmptySchoolAccountsPipelineCounts() {
  return {
    newAdmissions: 0,
    oldAdmissions: 0,
    internalDepartment: 0,
    pipelines: {
      print_record_update: 0,
      verification_registration: 0,
      paid_slip: 0,
    },
    sources: {
      school: 0,
      print_record_update: 0,
      verification_registration: 0,
      paid_slip: 0,
      record_to_update: 0,
      internal_department: 0,
    },
  };
}
function makeEmptySchoolForwardCounts() {
  return {
    forwarded: 0,
    notForwarded: 0,
    notVerified: 0,
    verified: 0,
    notReceived: 0,
  };
}

function buildSchoolForwardCountsFromAdmissions(admissions = []) {
  const counts = makeEmptySchoolForwardCounts();

  for (const admission of Array.isArray(admissions) ? admissions : []) {
    const dept = String(admission?.dept || "")
      .trim()
      .toLowerCase();

    if (dept !== "school") continue;

    const status = String(admission?.forwardStatus || "")
      .trim()
      .toLowerCase();

    const forwardSubStatus = String(admission?.forwardSubStatus || "")
      .trim()
      .toLowerCase();

    const isForwardedForThisUser =
      status === "forwarded" &&
      admission?.forwardedByCurrentUser === true;

    const isNotForwardedForThisUser =
      status !== "forwarded" &&
      admission?.notForwardedVisibleForCurrentUser === true;

    if (isForwardedForThisUser) {
      counts.forwarded += 1;

      if (forwardSubStatus === "not_verified") {
        counts.notVerified += 1;
      }

      if (forwardSubStatus === "verified") {
        counts.verified += 1;
      }
    }

    if (isNotForwardedForThisUser) {
      counts.notForwarded += 1;
    }

    if (admission?.notReceivedVisibleForCurrentUser === true) {
      counts.notReceived += 1;
    }
  }

  return counts;
}
function buildSchoolAccountsPipelineCounts(user) {
  const counts = makeEmptySchoolAccountsPipelineCounts();

  try {
    if (!user || (user.role !== "super_admin" && !isAccountsUser(user))) {
      return counts;
    }

    const newAdmissions = fetchAdmissionsForUser(user, {
      accountsView: "new_admissions",
    }).filter((admission) =>
      canSeeSchoolAccountsAdmission(
        user,
        admission,
        "new_admissions"
      )
    );

    const oldAdmissions = fetchAdmissionsForUser(user, {
      accountsView: "old_admissions",
    }).filter((admission) =>
      canSeeSchoolAccountsAdmission(
        user,
        admission,
        "old_admissions"
      )
    );

    counts.newAdmissions = newAdmissions.length;
    counts.oldAdmissions = oldAdmissions.length;

    for (const admission of newAdmissions) {
      const pipelineType = getAccountsPipelineTypeFromRow(admission);
      if (Object.prototype.hasOwnProperty.call(counts.pipelines, pipelineType)) {
        counts.pipelines[pipelineType] += 1;
      }

      if (matchesSchoolAccountsSourceFilter(admission, "internal_department")) {
        counts.internalDepartment += 1;
        counts.sources.internal_department += 1;
        continue;
      }

      if (matchesSchoolAccountsSourceFilter(admission, "record_to_update")) {
        counts.sources.record_to_update += 1;
        continue;
      }

      const sourceType = getAccountsSourceTypeFromRow(admission);
      if (Object.prototype.hasOwnProperty.call(counts.sources, sourceType)) {
        counts.sources[sourceType] += 1;
      }
    }
  } catch (err) {
    console.error("buildSchoolAccountsPipelineCounts error:", err.message);
  }

  return counts;
}

function getAdmissionForwardSnapshot(row) {
  const status = String(row?.forward_status || "not_forwarded").trim();
  const finalStatus = status === "forwarded" ? "forwarded" : "not_forwarded";

  const workflowStage = getAccountsWorkflowStageFromRow(row);
  const sourceType = getAccountsSourceTypeFromRow(row);
  const currentTimer =
    finalStatus === "forwarded"
      ? getAdmissionCurrentForwardTimer(row?.id)
      : null;

  return {
    status: finalStatus,
    subStatus: getForwardSubStatus(row),

    toDepartment: String(row?.forwarded_to_department || "").trim(),
    toType: String(row?.forwarded_to_type || "").trim(),
    forwardedAt: String(row?.forwarded_at || "").trim(),

    fromDepartment: String(
      row?.forwarded_from_department ||
      accountsSourceTypeToDepartmentLabel(sourceType) ||
      ""
    ).trim(),
    fromType: sourceType,

    workflowStage,
    isRecordToUpdate: workflowStage === "record_to_update",
    isOldAdmission: workflowStage === "old_admissions",

    issueMessage: String(row?.accounts_issue_message || "").trim(),
    issueFields: safeJsonParse(row?.accounts_issue_fields) || [],
    issueById: row?.accounts_issue_by_id || null,
    issueByName: String(row?.accounts_issue_by_name || "").trim(),
    issueByRole: String(row?.accounts_issue_by_role || "").trim(),
    issueAt: String(row?.accounts_issue_at || "").trim(),

    completedAt: String(row?.accounts_completed_at || "").trim(),
    completedById: row?.accounts_completed_by_id || null,
    completedByName: String(row?.accounts_completed_by_name || "").trim(),
    completedByRole: String(row?.accounts_completed_by_role || "").trim(),

    forwardedById: row?.forwarded_by_id || null,
    forwardedByName: String(row?.forwarded_by_name || "").trim(),
    forwardedByRole: String(row?.forwarded_by_role || "").trim(),

    forwardedOwnerUserId: row?.forwarded_owner_user_id || null,
    forwardedOwnerUserName: String(row?.forwarded_owner_user_name || "").trim(),
    forwardedOwnerUserRole: String(row?.forwarded_owner_user_role || "").trim(),

    transferNote: String(row?.accounts_transfer_note || "").trim(),
    transferReason: String(row?.accounts_transfer_reason || "").trim(),
    transferFromUserId: row?.accounts_transfer_from_user_id || null,
    transferFromUserName: String(row?.accounts_transfer_from_user_name || "").trim(),
    transferToUserId: row?.accounts_transfer_to_user_id || null,
    transferToUserName: String(row?.accounts_transfer_to_user_name || "").trim(),
    transferByName: String(row?.accounts_transfer_by_name || "").trim(),
    transferAt: String(row?.accounts_transfer_at || "").trim(),

    schoolReturnStatus: String(row?.school_return_status || "").trim(),
    schoolReturnedToUserId: row?.school_returned_to_user_id || null,
    schoolReturnedAt: String(row?.school_returned_at || "").trim(),
    schoolReuploadedAt:
      String(
        row?.school_reuploaded_at || ""
      ).trim(),

    reuploadTagActive:
      Number(
        row?.reupload_tag_active || 0
      ),

    reupload_tag_active:
      Number(
        row?.reupload_tag_active || 0
      ),

    workflowTag:
      getAdmissionWorkflowTag(row),

    currentTimer,
    timer: currentTimer,

    displayText:
      finalStatus === "forwarded"
        ? buildForwardDisplayText(row)
        : "",
  };
}

function isNotForwardedVisibleForCurrentUser(user, row) {
  if (!user || !row) return false;

  const rowDept = String(row.dept || "").trim().toLowerCase();
  const userDept = String(user.dept || "").trim().toLowerCase();
  const status = String(row.forward_status || "not_forwarded").trim().toLowerCase();

  // Ye forwarding system sirf School admissions ke liye hai.
  if (rowDept !== "school") return false;

  // Agar admission forwarded ho chuki hai to Not Forwarded mein show nahi hogi.
  if (status === "forwarded") return false;

  // Super Admin ko sab unforwarded School admissions show hon.
  if (user.role === "super_admin") return true;

  // Sirf School department users ko Not Forwarded filter ka access mile.
  // Quran, Tuition, School Accounts/Accounts ko ye buttons/filter access nahi milega.
  if (userDept !== "school") return false;

  // Admin = apni assigned team admissions
  // Agent/Sub-agent = apni admissions
  return canAccessAdmissionRow(user, row);
}
function canForwardAdmission(user, row) {
  if (!user || !row) return false;

  const rowDept = String(row.dept || "").trim().toLowerCase();
  const userDept = String(user.dept || "").trim().toLowerCase();

  if (rowDept !== "school") return false;

  // Super Admin, School CSR, aur School Accounts users forward kar sakte hain.
if (
  user.role !== "super_admin" &&
  userDept !== "school" &&
  !isAccountsUser(user)
) {
  return false;
}

  return canAccessAdmissionRow(user, row);
}
function getAdmissionUploadsForViewer(viewerUser = null, filter = "all") {
  try {
    const userId = Number(viewerUser?.id || 0);
    const userRole = String(viewerUser?.role || "").trim();
    const userDept = String(viewerUser?.dept || "").trim().toLowerCase();

    const cleanFilter = String(filter || "all").trim().toLowerCase();

    const rows = db.prepare(`
      SELECT
        u.id,
        u.admission_id,
        u.original_name,
        u.stored_name,
        u.file_url,
        u.mime_type,
        u.size,
        u.uploaded_by_id,
        u.uploaded_by_name,
        u.uploaded_by_role,
        u.uploaded_at,

        a.id AS adm_id,
        a.dept,
        a.student_name,
        a.father_name,
        a.grade,
        a.tuition_grade,
        a.phone,
                a.guardian_whatsapp,
        a.processed_by,
                a.accounts_registration_number,
        a.accounts_family_number,

        a.forward_status,
        a.forwarded_to_department,
        a.forwarded_to_type,
        a.forwarded_at,
        a.forwarded_from_department,
        a.forwarded_from_type,
        a.accounts_workflow_stage,
        a.accounts_issue_message,
        a.accounts_issue_fields,
        a.accounts_issue_by_id,
        a.accounts_issue_by_name,
        a.accounts_issue_by_role,
        a.accounts_issue_at,
        a.accounts_completed_at,
        a.accounts_completed_by_id,
        a.accounts_completed_by_name,
        a.accounts_completed_by_role,
        a.forwarded_by_id,
        a.forwarded_by_name,
        a.forwarded_by_role,
        a.forwarded_owner_user_id,
        a.forwarded_owner_user_name,
        a.forwarded_owner_user_role,
        a.accounts_transfer_note,
        a.accounts_transfer_reason,
        a.accounts_transfer_from_user_id,
        a.accounts_transfer_from_user_name,
        a.accounts_transfer_to_user_id,
        a.accounts_transfer_to_user_name,
        a.accounts_transfer_by_name,
        a.accounts_transfer_at,
        a.school_return_status,
        a.school_returned_to_user_id,
        a.school_returned_at,
        a.school_reuploaded_at,
        a.reupload_tag_active,

        CASE
          WHEN us.id IS NULL THEN 0
          ELSE 1
        END AS seen_by_current_user

      FROM uploads u
      LEFT JOIN admissions a
        ON a.id = u.admission_id
      LEFT JOIN upload_seen_logs us
        ON us.upload_id = u.id
       AND us.user_id = ?

      WHERE u.admission_id IS NOT NULL
        AND a.id IS NOT NULL
        AND COALESCE(a.is_deleted, 0) = 0

      ORDER BY
        datetime(COALESCE(u.uploaded_at, '1970-01-01')) DESC,
        u.id DESC
    `).all(userId);

    let safeRows = rows;

        if (userRole !== "super_admin") {
      safeRows = safeRows.filter((r) => {
        const admissionAccessRow = getActiveAdmissionById(
          r.adm_id || r.admission_id
        );

        return !!admissionAccessRow && canAccessAdmissionRow(
          viewerUser,
          admissionAccessRow
        );
      });
    }

    if (cleanFilter === "seen") {
      safeRows = safeRows.filter((r) => Number(r.seen_by_current_user || 0) === 1);
    }

    if (cleanFilter === "unseen") {
      safeRows = safeRows.filter((r) => Number(r.seen_by_current_user || 0) !== 1);
    }

    return safeRows.map((r) => {
      const admissionId =
        r.adm_id || r.admission_id;

      const forwardSnapshot =
        getAdmissionForwardSnapshot({
          id: admissionId,
          dept: r.dept,
          forward_status: r.forward_status,
          forwarded_to_department: r.forwarded_to_department,
          forwarded_to_type: r.forwarded_to_type,
          forwarded_at: r.forwarded_at,
          forwarded_from_department: r.forwarded_from_department,
          forwarded_from_type: r.forwarded_from_type,
          accounts_workflow_stage: r.accounts_workflow_stage,
          accounts_issue_message: r.accounts_issue_message,
          accounts_issue_fields: r.accounts_issue_fields,
          accounts_issue_by_id: r.accounts_issue_by_id,
          accounts_issue_by_name: r.accounts_issue_by_name,
          accounts_issue_by_role: r.accounts_issue_by_role,
          accounts_issue_at: r.accounts_issue_at,
          accounts_completed_at: r.accounts_completed_at,
          accounts_completed_by_id: r.accounts_completed_by_id,
          accounts_completed_by_name: r.accounts_completed_by_name,
          accounts_completed_by_role: r.accounts_completed_by_role,
          forwarded_by_id: r.forwarded_by_id,
          forwarded_by_name: r.forwarded_by_name,
          forwarded_by_role: r.forwarded_by_role,
          forwarded_owner_user_id: r.forwarded_owner_user_id,
          forwarded_owner_user_name: r.forwarded_owner_user_name,
          forwarded_owner_user_role: r.forwarded_owner_user_role,
          accounts_transfer_note: r.accounts_transfer_note,
          accounts_transfer_reason: r.accounts_transfer_reason,
          accounts_transfer_from_user_id: r.accounts_transfer_from_user_id,
          accounts_transfer_from_user_name: r.accounts_transfer_from_user_name,
          accounts_transfer_to_user_id: r.accounts_transfer_to_user_id,
          accounts_transfer_to_user_name: r.accounts_transfer_to_user_name,
          accounts_transfer_by_name: r.accounts_transfer_by_name,
          accounts_transfer_at: r.accounts_transfer_at,
          school_return_status: r.school_return_status,
          school_returned_to_user_id: r.school_returned_to_user_id,
          school_returned_at: r.school_returned_at,
          school_reuploaded_at: r.school_reuploaded_at,
          reupload_tag_active: r.reupload_tag_active,
          accounts_registration_number: r.accounts_registration_number,
        });

      return {
        id: r.id,
        uploadId: r.id,
        admissionId: r.admission_id,

        fileName: r.original_name || r.stored_name || "File",
        fileUrl: r.file_url || "",
        mimeType: r.mime_type || "",
        size: r.size || 0,

        addedBy: r.uploaded_by_name || r.uploaded_by_role || "System / Old Record",
        addedByRole: r.uploaded_by_role || (r.uploaded_by_name ? "" : "Old file record"),
        uploadedAt: r.uploaded_at || "",

        seen: Number(r.seen_by_current_user || 0) === 1,
        seenByCurrentUser: Number(r.seen_by_current_user || 0) === 1,

        student: r.student_name || "No Name",
        father: r.father_name || "-",
        dept: r.dept || "",
        grade: r.grade || r.tuition_grade || "",
        phone: r.phone || r.guardian_whatsapp || "",
        registrationNumber: r.accounts_registration_number || "",
        familyNumber: r.accounts_family_number || "",

        forward: forwardSnapshot,
        forwardTimer: forwardSnapshot.currentTimer,
        currentForwardTimer: forwardSnapshot.currentTimer,
        forwardTimeLogs: getAdmissionPreviousForwardTimeLogs(admissionId),
      };
    });
  } catch (e) {
    console.error("getAdmissionUploadsForViewer error:", e.message);
    return [];
  }
}
function insertUploadRecord({
  admissionId,
  originalName,
  storedName,
  fileUrl,
  mimeType,
  size,
  user,
}) {
  const actor = getUploadActor(user);

  const info = db.prepare(`
    INSERT INTO uploads (
      admission_id,
      original_name,
      stored_name,
      file_url,
      mime_type,
      size,
      uploaded_by_id,
      uploaded_by_name,
      uploaded_by_role,
      uploaded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    admissionId || null,
    originalName || "",
    storedName || "",
    fileUrl || "",
    mimeType || "",
    size || 0,
    actor.uploadedById,
    actor.uploadedByName,
    actor.uploadedByRole,
    actor.uploadedAt
  );

  if (admissionId) {
    touchAdmissionActivity(admissionId);
  }

  return info;
}

function markSchoolReturnReuploaded(admissionId, user) {
  try {
    const id = Number(admissionId || 0);
    if (!id || !user) return false;

    if (
      user.role !== "super_admin" &&
      !isSchoolDepartmentUser(user)
    ) {
      return false;
    }

    const row = getActiveAdmissionById(id);
    if (!row) return false;

    if (
      String(row.school_return_status || "")
        .trim()
        .toLowerCase() !== "not_received"
    ) {
      return false;
    }

    if (
      user.role !== "super_admin" &&
      !canAccessAdmissionRow(user, row)
    ) {
      return false;
    }

    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE admissions
      SET school_return_status = 'reupload',
          school_reuploaded_at = @school_reuploaded_at,
          reupload_tag_active = 1
      WHERE id = @id
        AND COALESCE(is_deleted, 0) = 0
        AND LOWER(
          TRIM(
            COALESCE(
              school_return_status,
              ''
            )
          )
        ) = 'not_received'
    `).run({
      id,
      school_reuploaded_at: now,
    });

    if (result.changes > 0) {
      logAudit("school_return_file_reuploaded", user, {
        dept: row.dept || "",
        details: {
          admissionId: id,
          studentName: row.student_name || "",
          previousStatus: "not_received",
          newStatus: "reupload",
          reuploadedAt: now,
          reuploadTagActive: 1,
        },
      });

      return true;
    }

    return false;
  } catch (e) {
    console.error(
      "markSchoolReturnReuploaded error:",
      e.message
    );

    return false;
  }
}

function getDeleteAdmissionAccess(user, row) {
  if (!user || !row) return false;

  const perms = getPerm(user);
  if (!perms?.canDeleteAdmissions) return false;

  return canAccessAdmissionRow(user, row);
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

function findDuplicateAdmissionFromForm(row) {
  return db.prepare(`
    SELECT id, student_name
    FROM admissions
    WHERE COALESCE(is_deleted, 0) = 0
      AND TRIM(COALESCE(dept, '')) = TRIM(@dept)
      AND TRIM(COALESCE(student_name, '')) = TRIM(@student_name)
      AND TRIM(COALESCE(father_name, '')) = TRIM(@father_name)
      AND TRIM(COALESCE(grade, '')) = TRIM(@grade)
      AND TRIM(COALESCE(dob, '')) = TRIM(@dob)
      AND TRIM(COALESCE(guardian_whatsapp, '')) = TRIM(@guardian_whatsapp)
      AND TRIM(COALESCE(registration_date, '')) = TRIM(@registration_date)
    LIMIT 1
  `).get({
    dept: String(row.dept || "").trim(),
    student_name: String(row.student_name || "").trim(),
    father_name: String(row.father_name || "").trim(),
    grade: String(row.grade || "").trim(),
    dob: String(row.dob || "").trim(),
    guardian_whatsapp: String(row.guardian_whatsapp || "").trim(),
    registration_date: String(row.registration_date || "").trim(),
  });
}

/* ========== ADMISSIONS HELPERS (DB -> pipeline object) ========== */
function mapAdmissionRow(row) {
  if (!row) return null;

  const forwardSnapshot = getAdmissionForwardSnapshot(row);

  const forwardTimeLogs =
    getAdmissionPreviousForwardTimeLogs(row.id);

  return {
    id: row.id,
    entryNumber: row.entry_number || row.id,
    entry_number: row.entry_number || row.id,
    lastActivityAt: row.last_activity_at || "",
    last_activity_at: row.last_activity_at || "",
    isDuplicate: !!row.isDuplicate,
duplicateWithId: row.duplicateWithId || "",
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

    registrationDate: row.registration_date || "",
    registration_date: row.registration_date || "",

    registrationNumberAssignedAt:
      row.accounts_registration_number_assigned_at || "",

    accounts_registration_number_assigned_at:
      row.accounts_registration_number_assigned_at || "",

    registrationNumberRemoved:
      Number(row.registration_number_removed || 0),

    registration_number_removed:
      Number(row.registration_number_removed || 0),

    schoolReturnStatus:
      row.school_return_status || "",

    school_return_status:
      row.school_return_status || "",

    schoolReturnedToUserId:
      row.school_returned_to_user_id || null,

    school_returned_to_user_id:
      row.school_returned_to_user_id || null,

    schoolReturnedAt:
      row.school_returned_at || "",

    school_returned_at:
      row.school_returned_at || "",

    schoolReuploadedAt:
      row.school_reuploaded_at || "",

    school_reuploaded_at:
      row.school_reuploaded_at || "",

    reuploadTagActive:
      Number(
        row.reupload_tag_active || 0
      ),

    reupload_tag_active:
      Number(
        row.reupload_tag_active || 0
      ),

    forwardSubStatus:
      getForwardSubStatus(row),

    notReceivedVisibleForCurrentUser:
      !!row.notReceivedVisibleForCurrentUser,

    workflowTag:
      getAdmissionWorkflowTag(row),

    latestUpload: row.latestUpload || null,
    hasLatestUpload: !!row.latestUpload,
    latestUploadByCurrentUser: !!row.latestUploadByCurrentUser,
    uploadedByCurrentUser: !!row.latestUploadByCurrentUser,
    forwardStatus: row.forward_status || "not_forwarded",
    forwardedToDepartment: row.forwarded_to_department || "",
    forwardedToType: row.forwarded_to_type || "",
    forwardedAt: row.forwarded_at || "",

    forwardedFromDepartment:
      row.forwarded_from_department ||
      accountsSourceTypeToDepartmentLabel(getAccountsSourceTypeFromRow(row)) ||
      "",
    forwardedFromType: getAccountsSourceTypeFromRow(row),

    accountsWorkflowStage: getAccountsWorkflowStageFromRow(row),
    accounts_workflow_stage: getAccountsWorkflowStageFromRow(row),
    isRecordToUpdate:
      getAccountsWorkflowStageFromRow(row) === "record_to_update",
    isOldAdmission:
      getAccountsWorkflowStageFromRow(row) === "old_admissions",

    accountsIssueMessage: row.accounts_issue_message || "",
    accountsIssueFields: safeJsonParse(row.accounts_issue_fields) || [],
    accountsIssueById: row.accounts_issue_by_id || null,
    accountsIssueByName: row.accounts_issue_by_name || "",
    accountsIssueByRole: row.accounts_issue_by_role || "",
    accountsIssueAt: row.accounts_issue_at || "",

    accountsCompletedAt: row.accounts_completed_at || "",
    accountsCompletedById: row.accounts_completed_by_id || null,
    accountsCompletedByName: row.accounts_completed_by_name || "",
    accountsCompletedByRole: row.accounts_completed_by_role || "",

    forwardedById: row.forwarded_by_id || null,
    forwardedByName: row.forwarded_by_name || "",
    forwardedByRole: row.forwarded_by_role || "",

    forwardedOwnerUserId: row.forwarded_owner_user_id || null,
    forwardedOwnerUserName: row.forwarded_owner_user_name || "",
    forwardedOwnerUserRole: row.forwarded_owner_user_role || "",

    accountsTransferNote: row.accounts_transfer_note || "",
    accountsTransferReason: row.accounts_transfer_reason || "",
    accountsTransferFromUserId: row.accounts_transfer_from_user_id || null,
    accountsTransferFromUserName: row.accounts_transfer_from_user_name || "",
    accountsTransferFromUserRole: row.accounts_transfer_from_user_role || "",
    accountsTransferToUserId: row.accounts_transfer_to_user_id || null,
    accountsTransferToUserName: row.accounts_transfer_to_user_name || "",
    accountsTransferToUserRole: row.accounts_transfer_to_user_role || "",
    accountsTransferById: row.accounts_transfer_by_id || null,
    accountsTransferByName: row.accounts_transfer_by_name || "",
    accountsTransferByRole: row.accounts_transfer_by_role || "",
    accountsTransferAt: row.accounts_transfer_at || "",

    forwardedByCurrentUser: !!row.forwardedByCurrentUser,
    notForwardedVisibleForCurrentUser: !!row.notForwardedVisibleForCurrentUser,
    forwardScopeVisibleForCurrentUser: !!row.forwardScopeVisibleForCurrentUser,
    forwardDisplayText: buildForwardDisplayText(row),
    canShowForwardButton: !!row.canShowForwardButton,
    forwardTimer: forwardSnapshot.currentTimer,
    currentForwardTimer: forwardSnapshot.currentTimer,

    forwardTimeLogs,
    forward_time_logs: forwardTimeLogs,
    timeLogs: forwardTimeLogs,

    forward: {
      ...forwardSnapshot,
      forwardTimeLogs,
      timeLogs: forwardTimeLogs,
    },
   accounts: {
     paymentStatus: row.accounts_payment_status || "",
     paidUpto: row.accounts_paid_upto || "",
     verificationNumber:
       row.accounts_verification_number || "",

     registrationNumber:
       row.accounts_registration_number || "",

     registrationNumberAssignedAt:
       row.accounts_registration_number_assigned_at || "",

     registrationNumberRemoved:
       Number(row.registration_number_removed || 0),

     familyNumber:
       row.accounts_family_number || "",
  },
    admission: {
  registrationFee: row.admission_registration_fee || "",
  fees: row.admission_fees || "",
  currencyCode: row.currency_code || "",
  bankName: row.bank_name || "",
  month: row.admission_month || "",
      totalFees: row.admission_total_fees || "",
      pendingDues: row.admission_pending_dues || "",
      receivedPayment: row.admission_total_paid || "0",
      comment: row.admission_comment || "",
      invoiceStatus: row.admission_invoice_status || "",
      invoiceStatusTimestamp: row.admission_invoice_status_timestamp || "",
      paidInvoiceStatus: row.admission_paid_invoice_status || "",
      paidInvoiceStatusTimestamp: row.admission_paid_invoice_status_timestamp || "",
    },
  };
}
function normalizeDuplicateField(v) {
  return String(v || "").trim().toLowerCase();
}

function buildAdmissionDuplicateKey(row) {
  return [
    row.dept,
    row.student_name,
    row.gender,
    row.dob,
    row.grade,
    row.father_name,
    row.guardian_whatsapp,
    row.religion,
    row.father_email,
    row.father_occupation,
    row.nationality,
    row.present_address,
    row.city,
    row.state,
    row.secondary_contact,
    row.session,
    row.registration_date,
    row.processed_by,
    row.tuition_grade,
    row.phone,
    row.currency_code,
  ].map(normalizeDuplicateField).join("||");
}

function attachDuplicateFlagsToRawRows(rows = []) {
  const countMap = new Map();
  const firstIdMap = new Map();

  for (const row of rows) {
    const key = buildAdmissionDuplicateKey(row);
    if (!key.replaceAll("||", "").trim()) continue;

    countMap.set(key, (countMap.get(key) || 0) + 1);

    if (!firstIdMap.has(key)) {
      firstIdMap.set(key, row.id);
    }
  }

  return rows.map((row) => {
    const key = buildAdmissionDuplicateKey(row);
    const isDuplicate = (countMap.get(key) || 0) > 1;

    return {
      ...row,
      isDuplicate,
      duplicateWithId: isDuplicate ? firstIdMap.get(key) : "",
    };
  });
}
function fetchAdmissionsForDept(dept, viewerUser = null) {
  const viewerPerms = getPerm(viewerUser);

  const rows = dept
    ? db.prepare(`
        SELECT *
        FROM admissions
        WHERE dept = ?
          AND COALESCE(is_deleted, 0) = 0
        ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
      `).all(dept)
    : db.prepare(`
        SELECT *
        FROM admissions
        WHERE COALESCE(is_deleted, 0) = 0
        ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
      `).all();

  const rowsWithDuplicateFlags = attachDuplicateFlagsToRawRows(rows);

  return rowsWithDuplicateFlags.map((row) => {
    const latestUpload =
      getLatestUploadForAdmission(row.id, viewerUser);

    const latestUploadByCurrentUser =
      viewerUser?.role === "super_admin"
        ? !!latestUpload
        : viewerUser?.role === "admin"
          ? !!latestUpload &&
            canAccessAdmissionRow(viewerUser, row)
          : !!latestUpload?.uploadedByCurrentUser;

    const latestUploadForDashboard =
      makeLatestUploadForDashboard(
        latestUpload,
        viewerUser,
        viewerPerms
      );

    const forwardedByCurrentUser =
      isForwardedByCurrentUser(viewerUser, row);

    const notForwardedVisibleForCurrentUser =
      isNotForwardedVisibleForCurrentUser(
        viewerUser,
        row
      );

    const notReceivedVisibleForCurrentUser =
      isNotReceivedVisibleForCurrentUser(
        viewerUser,
        row
      );

    const mapped = mapAdmissionRow({
      ...row,

      latestUpload: latestUploadForDashboard,

      latestUploadByCurrentUser: viewerPerms?.btnFiles
        ? latestUploadByCurrentUser
        : false,

            forwardedByCurrentUser,
      notForwardedVisibleForCurrentUser,
      notReceivedVisibleForCurrentUser,

      forwardScopeVisibleForCurrentUser:
        forwardedByCurrentUser ||
        notForwardedVisibleForCurrentUser ||
        notReceivedVisibleForCurrentUser,

      canShowForwardButton:
        canCurrentUserUseForwardForRow(
          viewerUser,
          row,
          latestUpload
        ),
    });

    mapped.latestBillingVerificationNumber =
      String(row.accounts_verification_number || "").trim();

    return mapped;
  });
}

function fetchAdmissionsPage({ dept = null, page = 1, limit = 200, perms = null, viewerUser = null }) {
  const dashboardPerms =
    perms || (viewerUser ? getPerm(viewerUser) : null);

  const safePage = Math.max(
    parseInt(page, 10) || 1,
    1
  );
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
        ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
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
        ORDER BY ${ADMISSION_ACTIVITY_ORDER_SQL}
        LIMIT ? OFFSET ?
      `)
      .all(safeLimit, offset);
  }

  const rowsWithDuplicateFlags = attachDuplicateFlagsToRawRows(rows);

  const mappedRows = rowsWithDuplicateFlags.map((row) => {
    const latestUpload =
      getLatestUploadForAdmission(row.id, viewerUser);

    const latestUploadByCurrentUser =
      viewerUser?.role === "super_admin"
        ? !!latestUpload
        : viewerUser?.role === "admin"
          ? !!latestUpload &&
            canAccessAdmissionRow(viewerUser, row)
          : !!latestUpload?.uploadedByCurrentUser;

    const latestUploadForDashboard =
      makeLatestUploadForDashboard(
        latestUpload,
        viewerUser,
        dashboardPerms
      );

    const forwardedByCurrentUser =
      isForwardedByCurrentUser(viewerUser, row);

        const notForwardedVisibleForCurrentUser =
      isNotForwardedVisibleForCurrentUser(
        viewerUser,
        row
      );

    const notReceivedVisibleForCurrentUser =
      isNotReceivedVisibleForCurrentUser(
        viewerUser,
        row
      );

    const mapped = mapAdmissionRow({
      ...row,

      latestUpload: latestUploadForDashboard,

      latestUploadByCurrentUser:
        dashboardPerms?.btnFiles
          ? latestUploadByCurrentUser
          : false,

      forwardedByCurrentUser,
      notForwardedVisibleForCurrentUser,
      notReceivedVisibleForCurrentUser,

      forwardScopeVisibleForCurrentUser:
        forwardedByCurrentUser ||
        notForwardedVisibleForCurrentUser ||
        notReceivedVisibleForCurrentUser,

      canShowForwardButton:
        canCurrentUserUseForwardForRow(
          viewerUser,
          row,
          latestUpload
        ),
    });

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
        q: String(filters.q || "").trim(),
    processedBy: String(filters.processedBy || "all").trim(),
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
        const processedBy = normalizeText(row.processed_by || "");
    const q = safeFilters.q.toLowerCase();

    if (safeFilters.department !== "all" && dept !== safeFilters.department) return false;
    if (safeFilters.status !== "all" && status !== safeFilters.status) return false;
    if (safeFilters.feeStatus !== "all" && feeStatus !== safeFilters.feeStatus) return false;
    if (safeFilters.currency.toLowerCase() !== "all" && currency !== normalizeUpper(safeFilters.currency)) return false;
        if (safeFilters.processedBy !== "all" && processedBy !== safeFilters.processedBy) return false;

    if (q) {
      const searchableText = [
        row.id,
        row.student_name,
        row.father_name,
        row.father_email,
        row.phone,
        row.guardian_whatsapp,
        row.accounts_registration_number,
        row.accounts_family_number,
        row.dept,
        row.status,
        row.feeStatus,
        row.processed_by,
        row.registration_date,
        row.admission_month,
        row.currency_code,
        row.admission_invoice_status,
        row.admission_paid_invoice_status,
      ].map((x) => String(x || "").toLowerCase()).join(" ");

      if (!searchableText.includes(q)) return false;
    }
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
     const processedByMap = new Map();
  const dailyAdmissionMap = new Map();
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
        const processedByName = normalizeText(row.processed_by || "") || "Not Set";

    totalAdmissions += 1;
        const processedOld = processedByMap.get(processedByName) || {
      name: processedByName,
      total: 0,
      school: 0,
      tuition: 0,
      quran: 0,
      latestAdmissionDate: "",
    };

    processedOld.total += 1;
    if (dept === "school") processedOld.school += 1;
    if (dept === "tuition") processedOld.tuition += 1;
    if (dept === "quran") processedOld.quran += 1;

    if (!processedOld.latestAdmissionDate || String(registrationDate || "") > String(processedOld.latestAdmissionDate || "")) {
      processedOld.latestAdmissionDate = registrationDate || "";
    }

    processedByMap.set(processedByName, processedOld);

    const dailyOld = dailyAdmissionMap.get(isoDay) || {
      date: isoDay,
      total: 0,
      school: 0,
      tuition: 0,
      quran: 0,
    };

    dailyOld.total += 1;
    if (dept === "school") dailyOld.school += 1;
    if (dept === "tuition") dailyOld.tuition += 1;
    if (dept === "quran") dailyOld.quran += 1;

    dailyAdmissionMap.set(isoDay, dailyOld);
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
      fatherName: row.father_name || "",
      phone: row.phone || row.guardian_whatsapp || "",
      registrationNumber: row.accounts_registration_number || "",
      familyNumber: row.accounts_family_number || "",
      processedBy: row.processed_by || "Not Set",
      dept: row.dept || "",
      status,
      feeStatus,
      registration_date: registrationDate || "",
      createdAt: registrationDate || "",
    });

    for (const bill of billingArr) {
  const billStatus = normalizeText(bill.status || "");
  const billAmount = safeNumber(bill.amount || bill.amountReceived);
  const billVerification = normalizeText(bill.verificationNumber || "");
  const billBank = normalizeText(bill.bank || bill.bankName || "");
  const billPaymentDate = normalizeText(bill.paymentDate || bill.paidOn || "");

  const billUpdatedAt =
    bill.updated_at ||
    bill.updatedAt ||
    bill.created_at ||
    bill.createdAt ||
    billPaymentDate ||
    "";

  const hasRealBillingUpdate =
    billStatus ||
    billAmount > 0 ||
    billVerification ||
    billBank ||
    billPaymentDate;

  if (!hasRealBillingUpdate) continue;

  recentBillingChanges.push({
    id: row.id,
    studentName: row.student_name || "",
    dept: row.dept || "",
    month: bill.month || "",
    status: billStatus || "-",
    amount: billAmount,
    updatedAt: billUpdatedAt || "-",
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

    const processedByStats = Array.from(processedByMap.values())
    .sort((a, b) => b.total - a.total);

  const dailyAdmissionStats = Array.from(dailyAdmissionMap.values())
    .filter((x) => x.date && x.date !== "Unknown")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 60);

  const searchResults = recentAdmissions.slice(0, 100);
    const recentAdmissionsPageData = recentAdmissions.slice(offset, offset + limit);
  const totalPages = Math.max(Math.ceil(recentAdmissions.length / limit), 1);

  const missingInsights = [
    {
      label: "Missing Processed By",
      total: filteredRows.filter((r) => !normalizeText(r.processed_by)).length,
      hint: "Admissions where processed_by is empty",
    },
    {
      label: "Missing Registration Number",
      total: filteredRows.filter((r) => !normalizeText(r.accounts_registration_number)).length,
      hint: "Admissions where registration number is empty",
    },
    {
      label: "Missing Family Number",
      total: filteredRows.filter((r) => !normalizeText(r.accounts_family_number)).length,
      hint: "Admissions where family number is empty",
    },
    {
      label: "Missing Phone",
      total: filteredRows.filter((r) => !normalizeText(r.phone || r.guardian_whatsapp)).length,
      hint: "Admissions where contact number is empty",
    },
    {
      label: "Missing Fee",
      total: filteredRows.filter((r) => safeNumber(r.admission_fees) <= 0).length,
      hint: "Admissions where monthly fee is empty or zero",
    },
    {
      label: "Missing Currency",
      total: filteredRows.filter((r) => !normalizeText(r.currency_code)).length,
      hint: "Admissions where currency is empty",
    },
  ];

  return {
    summaryCards,
        filters: safeFilters,
    processedByStats,
    dailyAdmissionStats,
    searchResults,
    missingInsights,
    recentAdmissions,
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
    recentBillingChanges: recentBillingChanges.slice(0, 100),
  };
}

function buildPipelineSnapshotFromRow(row) {
  const forwardSnapshot = getAdmissionForwardSnapshot(row);

  const forwardTimeLogs =
    getAdmissionPreviousForwardTimeLogs(row.id);

  return {
    id: row.id,
    entryNumber: row.entry_number || row.id,
    entry_number: row.entry_number || row.id,
    lastActivityAt: row.last_activity_at || "",
    last_activity_at: row.last_activity_at || "",
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

    registrationDate:
      row.registration_date || "",

    registration_date:
      row.registration_date || "",

    registrationNumberAssignedAt:
      row.accounts_registration_number_assigned_at || "",

    accounts_registration_number_assigned_at:
      row.accounts_registration_number_assigned_at || "",

    registrationNumberRemoved:
      Number(row.registration_number_removed || 0),

    registration_number_removed:
      Number(row.registration_number_removed || 0),

    schoolReturnStatus:
      row.school_return_status || "",

    school_return_status:
      row.school_return_status || "",

    schoolReturnedToUserId:
      row.school_returned_to_user_id || null,

    school_returned_to_user_id:
      row.school_returned_to_user_id || null,

    schoolReturnedAt:
      row.school_returned_at || "",

    school_returned_at:
      row.school_returned_at || "",

    schoolReuploadedAt:
      row.school_reuploaded_at || "",

    school_reuploaded_at:
      row.school_reuploaded_at || "",

    reuploadTagActive:
      Number(
        row.reupload_tag_active || 0
      ),

    reupload_tag_active:
      Number(
        row.reupload_tag_active || 0
      ),

    forwardSubStatus:
      getForwardSubStatus(row),

    workflowTag:
      getAdmissionWorkflowTag(row),

    forwardedFromDepartment:
      row.forwarded_from_department ||
      accountsSourceTypeToDepartmentLabel(getAccountsSourceTypeFromRow(row)) ||
      "",
    forwardedFromType:
      getAccountsSourceTypeFromRow(row),
    forwardedToDepartment:
      row.forwarded_to_department || "",
    forwardedToType:
      getAccountsPipelineTypeFromRow(row),
    accountsWorkflowStage:
      getAccountsWorkflowStageFromRow(row),
    accountsIssueMessage:
      row.accounts_issue_message || "",
    accountsIssueFields:
      safeJsonParse(row.accounts_issue_fields) || [],

    forwardTimer:
      forwardSnapshot.currentTimer,

    currentForwardTimer:
      forwardSnapshot.currentTimer,

    forwardTimeLogs,
    forward_time_logs: forwardTimeLogs,
    timeLogs: forwardTimeLogs,

    forward: {
      ...forwardSnapshot,
      forwardTimeLogs,
      timeLogs: forwardTimeLogs,
    },

    accounts: {
      paymentStatus:
        row.accounts_payment_status || "",

      paidUpto:
        row.accounts_paid_upto || "",

      verificationNumber:
        row.accounts_verification_number || "",

      registrationNumber:
        row.accounts_registration_number || "",

      registrationNumberAssignedAt:
        row.accounts_registration_number_assigned_at || "",

      registrationNumberRemoved:
        Number(row.registration_number_removed || 0),

      familyNumber:
        row.accounts_family_number || "",
    },
    admissionPanel: {
  registrationFee: row.admission_registration_fee || "",
  fees: row.admission_fees || "",
  month: row.admission_month || "",
  totalFees: row.admission_total_fees || "",
  currencyCode: row.currency_code || "",
  bankName: row.bank_name || "",
      pendingDues: row.admission_pending_dues || "",
      receivedPayment: row.admission_total_paid || "0",
      comment: row.admission_comment || "",
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
      out[m.key] = {
  status: "",
  amount: "",
  feeOverride: "",
  verification: "",
  number: "",
  bank: "",
  paymentDate: "",
};
      continue;
    }
    const { status, amount } = splitBillingValue(raw);
    out[m.key] = {
  status: status || "",
  amount: String(amount || ""),
  feeOverride: "",
  verification: "",
  number: "",
  bank: "",
  paymentDate: "",
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
// ✅ Admission Month select hone par us se pehle ke months ko Not admitted karo
function getBillingYearFromAdmissionMonthValue(monthValue, fallbackYear = new Date().getFullYear()) {
  const raw = String(monthValue || "").trim();

  const yearMatch = raw.match(/\b(20\d{2}|21\d{2})\b/);
  if (yearMatch) return Number(yearMatch[1]);

  const y = Number(fallbackYear);
  if (Number.isInteger(y) && y >= 2020 && y <= 2100) return y;

  return new Date().getFullYear();
}

function getMonthKeyFromAdmissionMonthValue(monthValue) {
  const raw = String(monthValue || "").trim().toLowerCase();

  for (const m of BILLING_MONTHS) {
    const key = String(m.key || "").toLowerCase();       // january
    const label = String(m.label || "").toLowerCase();   // January
    const shortKey = key.slice(0, 3);                    // jan
    const shortLabel = label.slice(0, 3);                // jan

    if (raw === key || raw === label || raw === shortKey || raw === shortLabel) {
      return key;
    }

    if (
      raw.includes(key) ||
      raw.includes(label) ||
      raw.includes(shortKey) ||
      raw.includes(shortLabel)
    ) {
      return key;
    }
  }

  return toMonthKey(raw);
}

function applyNotAdmittedBeforeAdmissionMonth({
  admissionId,
  billingJson,
  admissionMonthValue,
  billingYear,
}) {
  const selectedMonthKey = getMonthKeyFromAdmissionMonthValue(admissionMonthValue);
  const selectedIdx = monthIndex(selectedMonthKey);

  if (!admissionId || selectedIdx <= 0) {
    return {
      billingJson,
      touchedMonths: [],
    };
  }

  const touchedMonths = [];

  for (const m of BILLING_MONTHS) {
    const idx = monthIndex(m.key);

    if (idx >= 0 && idx < selectedIdx) {
      billingJson[m.key] = {
        status: "Not admitted",
        amount: "",
        feeOverride: "",
        verification: "",
        bank: "",
        paymentDate: "",
      };

      saveAdmissionBillingMonthByYear({
        admissionId,
        billingYear,
        monthKey: m.key,
        status: "Not admitted",
        amountReceived: "",
        feeAmount: "",
        verificationNumber: "",
        bankName: "",
        paymentDate: "",
      });

      touchedMonths.push(m.key);
    }
  }

  return {
    billingJson,
    touchedMonths,
  };
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
     const regSnap = getRegistrationFeeSnapshot(row, billingJson, billingYear);

  if (regSnap.enabled && regSnap.due > 0) {
    const existingMonthRow = pending.find(
      (x) => String(x.monthKey || "").trim().toLowerCase() === String(regSnap.monthKey || "").trim().toLowerCase()
    );

    if (existingMonthRow) {
      existingMonthRow.registrationFeeTotal = regSnap.total;
      existingMonthRow.registrationFeeReceived = regSnap.received;
      existingMonthRow.registrationFeeDue = regSnap.due;
      existingMonthRow.hasRegistrationFee = true;
      existingMonthRow.due = Number(existingMonthRow.due || 0) + Number(regSnap.due || 0);
    } else {
      pending.push({
        monthKey: regSnap.monthKey,
        monthLabel: regSnap.monthLabel,
        status: regSnap.status || "No payment",
        fee: 0,
        received: 0,
        due: Number(regSnap.due || 0),
        verification: regSnap.verification || "",
        number: "",
        bank: regSnap.bank || "",
        year: billingYear,
        isRegistrationFeeOnly: true,
        hasRegistrationFee: true,
        registrationFeeTotal: regSnap.total,
        registrationFeeReceived: regSnap.received,
        registrationFeeDue: regSnap.due,
      });
    }
  }
  return pending;
}
function getPaidMonthsFromRow(row, billingYear = new Date().getFullYear()) {
  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);

  const paid = [];

  const regSnap = getRegistrationFeeSnapshot(row, billingJson, billingYear);
  const registrationMonthKey = String(regSnap.monthKey || "").trim().toLowerCase();

  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim().toLowerCase();
    const amt = parseFirstNumber(e.amount || "");

    const regFeeReceived =
      String(m.key || "").trim().toLowerCase() === registrationMonthKey
        ? Number(regSnap.received || 0)
        : 0;

    const isPaid =
      amt > 0 ||
      regFeeReceived > 0 ||
      st === "full payment" ||
      st === "partial payment";

    if (!isPaid) continue;
    if (st === "not admitted") continue;

    paid.push({
      monthKey: m.key,
      monthLabel: m.label,
      status: String(e.status || regSnap.status || "Paid").trim(),
      received: amt || 0,
      registrationFeeReceived: regFeeReceived || 0,
      verification: String(e.verification || regSnap.verification || "").trim(),
      number: "",
      bank: String(e.bank || regSnap.bank || "").trim(),
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

  const rows = db.prepare(`
    SELECT *
    FROM admissions
    WHERE COALESCE(is_deleted, 0) = 0
      AND (
        TRIM(COALESCE(grade, '')) = TRIM(?)
        OR TRIM(COALESCE(tuition_grade, '')) = TRIM(?)
      )
    ORDER BY id DESC
  `).all(cleanClass, cleanClass);

  return rows
    .filter((row) => canAccessAdmissionRow(user, row))
    .filter((row) => matchesBulkSection(row, section));
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
function buildExcludedFeeCollectionRowsForAdmission(row, billingYear = new Date().getFullYear()) {
  if (!row) return [];

  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);
  const excludedRows = [];

  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim().toLowerCase();

    if (st !== "not admitted") continue;

    excludedRows.push({
      feeType: "Not Admitted",
      isExcludedMonth: true,
      admissionId: row.id,
      studentName: row.student_name || "",
      familyNumber: String(row.accounts_family_number || "").trim(),
      registrationNumber: String(row.accounts_registration_number || "").trim(),
      dept: row.dept || "",
      grade: row.grade || "",
      currency: row.currency_code || "",
      monthKey: m.key,
      monthLabel: m.label,
      status: "Not admitted",
      fee: 0,
      received: 0,
      due: 0,
      verification: String(e.verification || "").trim(),
      bank: String(e.bank || "").trim(),
      year: Number(billingYear),
    });
  }

  return excludedRows;
}

function buildExcludedFeeCollectionRowsForFamily(rows, billingYear = new Date().getFullYear()) {
  const all = [];

  for (const row of rows || []) {
    all.push(...buildExcludedFeeCollectionRowsForAdmission(row, billingYear));
  }

  all.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    if (Number(a.admissionId || 0) !== Number(b.admissionId || 0)) {
      return Number(a.admissionId || 0) - Number(b.admissionId || 0);
    }
    return monthIndex(a.monthKey) - monthIndex(b.monthKey);
  });

  return all;
}
function buildFeeCollectionRowsForAdmission(row, billingYear = new Date().getFullYear()) {
  const receivableRows = buildReceivableRowsFromRow(row, billingYear) || [];
  const registrationFeeRow = buildRegistrationFeeCollectionRow(row, billingYear);

  const monthlyRows = receivableRows
    .map((r) => ({
      feeType: "Monthly Fee",
      isRegistrationFee: false,
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

  return [
    ...(registrationFeeRow ? [registrationFeeRow] : []),
    ...monthlyRows,
  ];
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

function buildPaidFeeCollectionRowsForAdmission(row, billingYear = new Date().getFullYear()) {
  if (!row) return [];

  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);

  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
  const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);

  const paidRows = [];

  const regSnap = getRegistrationFeeSnapshot(row, billingJson, billingYear);

  if (regSnap.enabled && Number(regSnap.received || 0) > 0) {
    paidRows.push({
      feeType: "Registration Fee",
      isRegistrationFee: true,
      admissionId: row.id,
      studentName: row.student_name || "",
      familyNumber: String(row.accounts_family_number || "").trim(),
      registrationNumber: String(row.accounts_registration_number || "").trim(),
      dept: row.dept || "",
      grade: row.grade || "",
      currency: row.currency_code || "",
      monthKey: regSnap.monthKey,
      monthLabel: regSnap.monthLabel,
      status: regSnap.status || "Paid",
      fee: Number(regSnap.total || 0),
      received: Number(regSnap.received || 0),
      due: Number(regSnap.due || 0),
      verificationNumber: regSnap.verification || "",
      bank: regSnap.bank || "",
      year: Number(billingYear),
    });
  }

  for (const m of BILLING_MONTHS) {
    const e = billingJson?.[m.key] || {};
    const st = String(e.status || "").trim();
    const stLower = st.toLowerCase();
    const received = parseFirstNumber(e.amount || "");

    if (stLower === "not admitted") continue;

    const isPaid =
      received > 0 ||
      stLower === "full payment" ||
      stLower === "partial payment";

    if (!isPaid) continue;

    const feeOverride = parseFirstNumber(e.feeOverride || "");
    const fee = feeOverride > 0 ? feeOverride : (feeForMonth(feeHistory, baseFee, m.key) || 0);

    paidRows.push({
      feeType: "Monthly Fee",
      isRegistrationFee: false,
      admissionId: row.id,
      studentName: row.student_name || "",
      familyNumber: String(row.accounts_family_number || "").trim(),
      registrationNumber: String(row.accounts_registration_number || "").trim(),
      dept: row.dept || "",
      grade: row.grade || "",
      currency: row.currency_code || "",
      monthKey: m.key,
      monthLabel: m.label,
      status: st || "Paid",
      fee: Number(fee || 0),
      received: Number(received || 0),
      due: Math.max(0, Number(fee || 0) - Number(received || 0)),
      verificationNumber: String(e.verification || "").trim(),
      bank: String(e.bank || "").trim(),
      year: Number(billingYear),
    });
  }

  paidRows.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return monthIndex(a.monthKey) - monthIndex(b.monthKey);
  });

  return paidRows;
}

function buildPaidFeeCollectionRowsForFamily(rows, billingYear = new Date().getFullYear()) {
  const all = [];

  for (const row of rows || []) {
    const one = buildPaidFeeCollectionRowsForAdmission(row, billingYear);
    all.push(...one);
  }

  all.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    if (Number(a.admissionId || 0) !== Number(b.admissionId || 0)) {
      return Number(a.admissionId || 0) - Number(b.admissionId || 0);
    }
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
  let totalDues = 0;
  let totalFullPendingDues = 0;

  let totalRegistrationFee = 0;
  let totalRegistrationReceived = 0;
  let totalRegistrationPending = 0;

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

    const regSnap = getRegistrationFeeSnapshot(row, billingJson, billingYear);

    if (regSnap.enabled) {
      totalRegistrationFee += Number(regSnap.total || 0);
      totalRegistrationReceived += Number(regSnap.received || 0);
      totalRegistrationPending += Number(regSnap.due || 0);

      totalFee += Number(regSnap.total || 0);
      totalReceived += Number(regSnap.received || 0);
      totalFullPendingDues += Number(regSnap.due || 0);

      const regIdx = monthIndex(regSnap.monthKey);
      if (uptoIdx === -1 || regIdx === -1 || regIdx <= uptoIdx) {
        totalDues += Number(regSnap.due || 0);
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

    totalRegistrationFee,
    totalRegistrationReceived,
    totalRegistrationPending,
  };
}


function getBillingJsonByAdmissionId(admissionId, billingYear = new Date().getFullYear()) {
  const row = getActiveAdmissionById(admissionId);
  const savedBillingJson = row ? safeJsonParse(row.billing_json) : {};
  const billingArr = getAdmissionBillingByYear(admissionId, billingYear);

  const billingJson = {};

  for (const m of BILLING_MONTHS) {
    billingJson[m.key] = {
  ...(savedBillingJson?.[m.key] || {}),
  status: String(savedBillingJson?.[m.key]?.status || ""),
  amount: String(savedBillingJson?.[m.key]?.amount || ""),
  feeOverride: String(savedBillingJson?.[m.key]?.feeOverride || ""),
  verification: String(savedBillingJson?.[m.key]?.verification || ""),
  bank: String(savedBillingJson?.[m.key]?.bank || ""),
  paymentDate: String(savedBillingJson?.[m.key]?.paymentDate || ""),

  registrationFeeTotal: String(savedBillingJson?.[m.key]?.registrationFeeTotal || ""),
  registrationFeeReceived: String(savedBillingJson?.[m.key]?.registrationFeeReceived || ""),
  registrationFeeStatus: String(savedBillingJson?.[m.key]?.registrationFeeStatus || ""),
  registrationFeeVerification: String(savedBillingJson?.[m.key]?.registrationFeeVerification || ""),
  registrationFeeBank: String(savedBillingJson?.[m.key]?.registrationFeeBank || ""),
  registrationFeePaymentDate: String(savedBillingJson?.[m.key]?.registrationFeePaymentDate || ""),
};
  }

  for (const item of billingArr) {
    const monthKey = String(item.month || "").trim().toLowerCase();
    if (!monthKey) continue;

    billingJson[monthKey] = {
  ...(billingJson[monthKey] || {}),
  status: String(item.status || ""),
  amount: String(item.amount || item.amountReceived || ""),
  feeOverride: String(item.fee || item.feeAmount || ""),
  verification: String(item.verificationNumber || ""),
  bank: String(item.bank || item.bankName || ""),
  paymentDate: String(item.paymentDate || item.paidOn || ""),

  registrationFeeTotal: String(item.registrationFeeTotal || ""),
  registrationFeeReceived: String(item.registrationFeeReceived || ""),
  registrationFeeStatus: String(item.registrationFeeStatus || ""),
  registrationFeeVerification: String(item.registrationFeeVerification || ""),
  registrationFeeBank: String(item.registrationFeeBank || ""),
  registrationFeePaymentDate: String(item.registrationFeePaymentDate || ""),
};
  }

  return billingJson;
}

function getRegistrationFeeSnapshot(row, billingJson, billingYear = new Date().getFullYear()) {
  if (!row) {
    return {
      enabled: false,
      monthKey: "",
      monthLabel: "",
      total: 0,
      received: 0,
      due: 0,
      status: "",
    };
  }

  const registrationFeeTotal = parseFirstNumber(row.admission_registration_fee || 0);
  if (registrationFeeTotal <= 0) {
    return {
      enabled: false,
      monthKey: "",
      monthLabel: "",
      total: 0,
      received: 0,
      due: 0,
      status: "",
    };
  }

  const admissionMonthValue = String(row.admission_month || "").trim();
  const monthKey = getMonthKeyFromAdmissionMonthValue(admissionMonthValue);
  const admissionBillingYear = getBillingYearFromAdmissionMonthValue(admissionMonthValue, billingYear);

  if (!monthKey || admissionBillingYear !== Number(billingYear)) {
    return {
      enabled: false,
      monthKey: "",
      monthLabel: "",
      total: registrationFeeTotal,
      received: 0,
      due: 0,
      status: "",
    };
  }

  const monthEntry = billingJson?.[monthKey] || {};
  const received = parseFirstNumber(monthEntry.registrationFeeReceived || 0);
  const due = Math.max(0, registrationFeeTotal - received);

  const monthMeta = BILLING_MONTHS.find((m) => String(m.key).toLowerCase() === monthKey);

  return {
    enabled: true,
    monthKey,
    monthLabel: monthMeta?.label || monthKey,
    total: registrationFeeTotal,
    received,
    due,
    status:
      due <= 0
        ? "Full payment"
        : received > 0
          ? "Partial payment"
          : "No payment",
    verification: String(monthEntry.registrationFeeVerification || "").trim(),
    bank: String(monthEntry.registrationFeeBank || "").trim(),
    paymentDate: String(monthEntry.registrationFeePaymentDate || "").trim(),
  };
}

function buildRegistrationFeeCollectionRow(row, billingYear = new Date().getFullYear()) {
  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);
  const snap = getRegistrationFeeSnapshot(row, billingJson, billingYear);

  if (!snap.enabled || snap.due <= 0) return null;

  return {
    feeType: "Registration Fee",
    isRegistrationFee: true,
    admissionId: row.id,
    studentName: row.student_name || "",
    familyNumber: String(row.accounts_family_number || "").trim(),
    registrationNumber: String(row.accounts_registration_number || "").trim(),
    dept: row.dept || "",
    grade: row.grade || "",
    currency: row.currency_code || "",
    monthKey: snap.monthKey,
    monthLabel: snap.monthLabel,
    status: snap.status,
    fee: snap.total,
    received: snap.received,
    due: snap.due,
    verification: snap.verification || "",
    bank: snap.bank || "",
    year: Number(billingYear),
  };
}

function applyRegistrationFeeCollectionToBilling({
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
      appliedAmount: 0,
      remainingAmount: remaining,
      touchedMonths: [],
    };
  }

  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);
  const snap = getRegistrationFeeSnapshot(row, billingJson, billingYear);

  if (!snap.enabled || snap.due <= 0) {
    return {
      success: true,
      appliedAmount: 0,
      remainingAmount: remaining,
      touchedMonths: [],
    };
  }

  const used = Math.min(remaining, snap.due);
  const newReceived = snap.received + used;
  const balance = Math.max(0, snap.total - newReceived);

  const effectiveVerificationNumber = String(
    verificationNumber || row.accounts_verification_number || ""
  ).trim();

  const current = billingJson[snap.monthKey] || {
    status: "",
    amount: "",
    feeOverride: "",
    verification: "",
    bank: "",
    paymentDate: "",
  };

  current.registrationFeeTotal = String(snap.total);
  current.registrationFeeReceived = String(newReceived);
    current.registrationFeeVerification = effectiveVerificationNumber;
  current.registrationFeeBank = String(collectionAccount || "").trim();
  current.registrationFeePaymentDate = String(receivingDate || "").trim();
  current.registrationFeeStatus = balance <= 0 ? "Full payment" : "Partial payment";

  billingJson[snap.monthKey] = current;

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
        registrationFeeTotal: String(item.registrationFeeTotal || ""),
  registrationFeeReceived: String(item.registrationFeeReceived || ""),
  registrationFeeStatus: String(item.registrationFeeStatus || ""),
  registrationFeeVerification: String(item.registrationFeeVerification || ""),
  registrationFeeBank: String(item.registrationFeeBank || ""),
  registrationFeePaymentDate: String(item.registrationFeePaymentDate || ""),
    });
  }

  const oldFeeSnapshot =
    parseFirstNumber(row?.monthly_fee_current || 0) ||
    parseFirstNumber(row?.admission_fees || 0) ||
    inferMonthlyFee(row, billingJson) ||
    0;

  let feeHistory = ensureInitialFeeHistory(row, getFeeHistory(row), oldFeeSnapshot);
  const baseFee = baseFeeFromHistoryOrRow(row, feeHistory, oldFeeSnapshot);
  const dues = calcPendingDues(baseFee, billingJson, feeHistory);

  const paidUpto = computePaidUptoFromBillingJson(billingJson);
  const monthlyReceivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

  const regAfter = getRegistrationFeeSnapshot(row, billingJson, billingYear);
  const totalExpectedWithReg = Number(dues.expected || 0) + Number(regAfter.total || 0);
  const totalPendingWithReg = Number(dues.pending || 0) + Number(regAfter.due || 0);
  const totalReceivedWithReg = Number(monthlyReceivedPayment || 0) + Number(regAfter.received || 0);

  db.prepare(`
    UPDATE admissions
    SET billing_json = @billing_json,
        fee_history = @fee_history,
        monthly_fee_current = @monthly_fee_current,
        accounts_paid_upto = @accounts_paid_upto,
        accounts_verification_number = @accounts_verification_number,
        bank_name = @bank_name,
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
    accounts_verification_number: effectiveVerificationNumber,
    bank_name: String(collectionAccount || row.bank_name || "").trim(),
    admission_total_fees: String(totalExpectedWithReg || 0),
    admission_pending_dues: String(totalPendingWithReg || 0),
    admission_total_paid: String(totalReceivedWithReg || 0),
  });

  logAudit("registration_fee_collection_received", actorUser, {
    dept: row.dept || "",
    details: {
      admissionId: row.id,
      studentName: row.student_name || "",
      billingYear,
      monthKey: snap.monthKey,
      collectionAccount,
      receivingDate,
      note: String(note || "").trim(),
      receiveAmount: Number(receiveAmount || 0),
      appliedAmount: used,
      remainingAmount: remaining - used,
      registrationFeeTotal: snap.total,
      registrationFeeReceived: newReceived,
      registrationFeeBalance: balance,
    },
  });

  return {
    success: true,
    billingJson,
    paidUpto,
    receivedPayment: totalReceivedWithReg,
    appliedAmount: used,
    remainingAmount: remaining - used,
    touchedMonths: [
      {
        feeType: "Registration Fee",
        isRegistrationFee: true,
        monthKey: snap.monthKey,
        fee: snap.total,
        previousReceived: snap.received,
        used,
        newReceived,
        balance,
        status: balance <= 0 ? "Full payment" : "Partial payment",
      },
    ],
  };
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

      registrationFeeTotal: String(item.registrationFeeTotal || ""),
      registrationFeeReceived: String(item.registrationFeeReceived || ""),
      registrationFeeStatus: String(item.registrationFeeStatus || ""),
      registrationFeeVerification: String(item.registrationFeeVerification || ""),
      registrationFeeBank: String(item.registrationFeeBank || ""),
      registrationFeePaymentDate: String(item.registrationFeePaymentDate || ""),
    });
  }

  const dues = calcPendingDues(baseFee, billingJson, feeHistory);
  const paidUpto = computePaidUptoFromBillingJson(billingJson);
  const receivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

 const latestTouchedMonthKey = touchedMonths.length
  ? touchedMonths[touchedMonths.length - 1].monthKey
  : "";

const latestVerificationForColumn = String(row.accounts_verification_number || "").trim();

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

    const effectiveVerificationNumber = String(
      verificationNumber || row.accounts_verification_number || ""
    ).trim();

    current.amount = String(newReceived);
    current.feeOverride = String(feeOverride);
    current.verification = effectiveVerificationNumber;
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

      registrationFeeTotal: String(item.registrationFeeTotal || ""),
      registrationFeeReceived: String(item.registrationFeeReceived || ""),
      registrationFeeStatus: String(item.registrationFeeStatus || ""),
      registrationFeeVerification: String(item.registrationFeeVerification || ""),
      registrationFeeBank: String(item.registrationFeeBank || ""),
      registrationFeePaymentDate: String(item.registrationFeePaymentDate || ""),
    });
  }

  const dues = calcPendingDues(baseFee, billingJson, feeHistory);
const paidUpto = computePaidUptoFromBillingJson(billingJson);
const monthlyReceivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

const regSnapAfterMonthly = getRegistrationFeeSnapshot(row, billingJson, billingYear);
const receivedPayment =
  Number(monthlyReceivedPayment || 0) + Number(regSnapAfterMonthly.received || 0);

const expectedWithRegistration =
  Number(dues.expected || 0) + Number(regSnapAfterMonthly.total || 0);

const pendingWithRegistration =
  Number(dues.pending || 0) + Number(regSnapAfterMonthly.due || 0);

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
        bank_name = @bank_name,
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
    bank_name: String(collectionAccount || row.bank_name || "").trim(),
    admission_total_fees: String(expectedWithRegistration || 0),
    admission_pending_dues: String(pendingWithRegistration || 0),
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
function ensureAppliedEntry(appliedMap, row) {
  const key = Number(row.id || 0);

  if (!appliedMap.has(key)) {
    appliedMap.set(key, {
      admissionId: row.id,
      studentName: row.student_name || "",
      grade: row.grade || "",
      registrationNumber: String(row.accounts_registration_number || "").trim(),
familyNumber: String(row.accounts_family_number || "").trim(),
phone: String(row.phone || row.guardian_whatsapp || "").trim(),
guardianWhatsapp: String(row.guardian_whatsapp || row.phone || "").trim(),
usedAmount: 0,
      remainingAmount: 0,
      touchedMonths: [],
      paidUpto: "",
      receivedPayment: 0,
    });
  }

  return appliedMap.get(key);
}

function applySpecificMonthlyFeeToBilling({
  row,
  billingYear,
  monthKey,
  receiveAmount,
  verificationNumber,
  collectionAccount,
  receivingDate,
  note,
  actorUser,
}) {
  let remaining = Number(receiveAmount || 0);
  const cleanMonthKey = String(monthKey || "").trim().toLowerCase();

  if (!row || remaining <= 0 || !cleanMonthKey) {
    return {
      success: false,
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

  const current = billingJson[cleanMonthKey] || {
    status: "",
    amount: "",
    feeOverride: "",
    verification: "",
    bank: "",
    paymentDate: "",
  };

  const currentStatus = String(current.status || "").trim().toLowerCase();
  if (currentStatus === "not admitted") {
    return {
      success: true,
      appliedAmount: 0,
      remainingAmount: remaining,
      touchedMonths: [],
    };
  }

  const currentReceived = parseFirstNumber(current.amount || 0);
  const feeOverride =
    parseFirstNumber(current.feeOverride || 0) ||
    feeForMonth(feeHistory, baseFee, cleanMonthKey) ||
    0;

  const currentDue = Math.max(0, feeOverride - currentReceived);
  if (currentDue <= 0) {
    return {
      success: true,
      appliedAmount: 0,
      remainingAmount: remaining,
      touchedMonths: [],
    };
  }

  const used = Math.min(remaining, currentDue);
  const newReceived = currentReceived + used;
  const balance = Math.max(0, feeOverride - newReceived);

  const effectiveVerificationNumber = String(
    verificationNumber || row.accounts_verification_number || ""
  ).trim();

  current.amount = String(newReceived);
  current.feeOverride = String(feeOverride);
  current.verification = effectiveVerificationNumber;
  current.bank = String(collectionAccount || "").trim();
  current.paymentDate = String(receivingDate || "").trim();
  current.status = balance <= 0 ? "Full payment" : "Partial payment";

  billingJson[cleanMonthKey] = current;

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

      registrationFeeTotal: String(item.registrationFeeTotal || ""),
      registrationFeeReceived: String(item.registrationFeeReceived || ""),
      registrationFeeStatus: String(item.registrationFeeStatus || ""),
      registrationFeeVerification: String(item.registrationFeeVerification || ""),
      registrationFeeBank: String(item.registrationFeeBank || ""),
      registrationFeePaymentDate: String(item.registrationFeePaymentDate || ""),
    });
  }

  const dues = calcPendingDues(baseFee, billingJson, feeHistory);
  const paidUpto = computePaidUptoFromBillingJson(billingJson);
  const monthlyReceivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

  const regSnapAfterMonthly = getRegistrationFeeSnapshot(row, billingJson, billingYear);

  const receivedPayment =
    Number(monthlyReceivedPayment || 0) + Number(regSnapAfterMonthly.received || 0);

  const expectedWithRegistration =
    Number(dues.expected || 0) + Number(regSnapAfterMonthly.total || 0);

  const pendingWithRegistration =
    Number(dues.pending || 0) + Number(regSnapAfterMonthly.due || 0);

  db.prepare(`
    UPDATE admissions
    SET billing_json = @billing_json,
        fee_history = @fee_history,
        monthly_fee_current = @monthly_fee_current,
        accounts_paid_upto = @accounts_paid_upto,
        accounts_verification_number = @accounts_verification_number,
        bank_name = @bank_name,
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
    accounts_verification_number: effectiveVerificationNumber,
    bank_name: String(collectionAccount || row.bank_name || "").trim(),
    admission_total_fees: String(expectedWithRegistration || 0),
    admission_pending_dues: String(pendingWithRegistration || 0),
    admission_total_paid: String(receivedPayment || 0),
  });

  logAudit("family_month_wise_fee_collection_received", actorUser, {
    dept: row.dept || "",
    details: {
      admissionId: row.id,
      studentName: row.student_name || "",
      billingYear,
      monthKey: cleanMonthKey,
      collectionAccount,
      receivingDate,
      note: String(note || "").trim(),
      receiveAmount: Number(receiveAmount || 0),
      appliedAmount: used,
      remainingAmount: remaining - used,
      balance,
    },
  });

  return {
    success: true,
    billingJson,
    calc: { baseFee, ...dues },
    paidUpto,
    receivedPayment,
    appliedAmount: used,
    remainingAmount: remaining - used,
    touchedMonths: [
      {
        feeType: "Monthly Fee",
        isRegistrationFee: false,
        admissionId: row.id,
        studentName: row.student_name || "",
        grade: row.grade || "",
        registrationNumber: String(row.accounts_registration_number || "").trim(),
        familyNumber: String(row.accounts_family_number || "").trim(),
        monthKey: cleanMonthKey,
        fee: feeOverride,
        previousReceived: currentReceived,
        used,
        newReceived,
        balance,
        status: balance <= 0 ? "Full payment" : "Partial payment",
      },
    ],
  };
}

function applyFamilyMonthlyFeeCollectionMonthWise({
  rows,
  billingYear,
  receiveAmount,
  verificationNumber,
  collectionAccount,
  receivingDate,
  note,
  actorUser,
  appliedMap,
}) {
  let remaining = Number(receiveAmount || 0);

  const pendingMonthlyRows = [];

  for (const row of rows || []) {
    const receivableRows = buildReceivableRowsFromRow(row, billingYear) || [];

    for (const r of receivableRows) {
      pendingMonthlyRows.push({
        row,
        admissionId: row.id,
        studentName: row.student_name || "",
        grade: row.grade || "",
        registrationNumber: String(row.accounts_registration_number || "").trim(),
        familyNumber: String(row.accounts_family_number || "").trim(),
        monthKey: String(r.monthKey || "").trim().toLowerCase(),
        monthLabel: r.monthLabel || "",
        due: Number(r.due || 0),
        year: Number(r.year || billingYear),
      });
    }
  }

  pendingMonthlyRows.sort((a, b) => {
    if (Number(a.year || 0) !== Number(b.year || 0)) {
      return Number(a.year || 0) - Number(b.year || 0);
    }

    const monthDiff = monthIndex(a.monthKey) - monthIndex(b.monthKey);
    if (monthDiff !== 0) return monthDiff;

    return Number(a.admissionId || 0) - Number(b.admissionId || 0);
  });

  for (const item of pendingMonthlyRows) {
    if (remaining <= 0) break;

    const result = applySpecificMonthlyFeeToBilling({
      row: item.row,
      billingYear,
      monthKey: item.monthKey,
      receiveAmount: remaining,
      verificationNumber,
      collectionAccount,
      receivingDate,
      note,
      actorUser,
    });

    const used = Number(result.appliedAmount || 0);
    remaining = Number(result.remainingAmount || 0);

    if (used > 0) {
      const entry = ensureAppliedEntry(appliedMap, item.row);
      entry.usedAmount += used;
      entry.remainingAmount = remaining;
      entry.touchedMonths.push(...(result.touchedMonths || []));
      entry.paidUpto = result.paidUpto || entry.paidUpto || "";
      entry.receivedPayment = result.receivedPayment || entry.receivedPayment || 0;
    }
  }

  return {
    success: true,
    appliedAmount: Number(receiveAmount || 0) - remaining,
    remainingAmount: remaining,
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

async function generateReceivedPaidReceiptForN8n({
  req,
  admissionId,
  billingYear,
  paidMonths,
  labelPrefix = "Received Paid Receipt",
  fullOverride = null,
  familyNumber = "",
}) {
  let cleanPaidMonths = (Array.isArray(paidMonths) ? paidMonths : [])
    .map((x) => {
      const isRegistrationFee =
        x?.isRegistrationFee === true ||
        String(x?.feeType || "").toLowerCase().includes("registration");

      const cleanMonthKey = String(x.monthKey || "").trim().toLowerCase();

      return {
        feeType: isRegistrationFee ? "Registration Fee" : "Monthly Fee",
        isRegistrationFee,
        admissionId: Number(x.admissionId || admissionId || 0),
        studentName: String(x.studentName || "").trim(),
        grade: String(x.grade || "").trim(),
        registrationNumber: String(x.registrationNumber || "").trim(),
        familyNumber: String(x.familyNumber || familyNumber || "").trim(),
phone: String(x.phone || x.guardianWhatsapp || "").trim(),
guardianWhatsapp: String(x.guardianWhatsapp || x.phone || "").trim(),
monthKey: cleanMonthKey,
        monthLabel:
          BILLING_MONTHS.find(
            (m) => String(m.key).toLowerCase() === cleanMonthKey
          )?.label || String(x.monthKey || ""),
        status: String(x.status || "").trim(),

        // ✅ Sirf current receive amount use hoga
        received: Number(x.used ?? x.received ?? x.amount ?? 0),

        verification: String(x.verification || "").trim(),
        bank: String(x.bank || "").trim(),
        year: billingYear,
      };
    })
    .filter((x) => x.monthKey && x.received > 0);

  // ✅ Same student + same fee type + same month duplicate ho to merge karo
  // ✅ Registration Fee aur Monthly Fee same month me hon to merge na karo
  const paidMonthMap = new Map();

  for (const item of cleanPaidMonths) {
    const key = `${item.admissionId}:${item.year}:${item.monthKey}:${item.feeType}`;
    const old = paidMonthMap.get(key);

    if (!old) {
      paidMonthMap.set(key, { ...item });
    } else {
      old.received = Number(old.received || 0) + Number(item.received || 0);
      old.status = item.status || old.status;
      old.verification = item.verification || old.verification;
      old.bank = item.bank || old.bank;
      paidMonthMap.set(key, old);
    }
  }

  cleanPaidMonths = Array.from(paidMonthMap.values());

  if (!cleanPaidMonths.length) {
    return {
      skipped: true,
      reason: "no_received_paid_months",
    };
  }

  const full = fullOverride || dbGetAdmissionDetailsById(admissionId, billingYear);
  if (!full) {
    throw new Error(`Admission details not found for id ${admissionId}`);
  }

  const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

  const pdfBuffer = await makeBulkPaidReceiptPdf({
    full: {
      ...full,
      familyNumber: String(familyNumber || full?.familyNumber || "").trim(),
      accounts: {
        ...(full?.accounts || {}),
        familyNumber: String(familyNumber || full?.accounts?.familyNumber || "").trim(),
      },
    },
    paidMonths: cleanPaidMonths,
    bannerPath,
  });

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error(`Invalid PDF buffer for paid receipt ${admissionId}`);
  }

  const head = pdfBuffer.subarray(0, 5).toString("utf8");
  if (head !== "%PDF-") {
    throw new Error(`Generated paid receipt is not a valid PDF for ${admissionId}`);
  }

  const { year, month } = getYearMonthParts(new Date());
  const challanDir = path.join(uploadsDir, "challans", year, month);
  if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

  const filename = familyNumber
    ? `family-received-paid-receipt-${familyNumber}-${Date.now()}.pdf`
    : `received-paid-receipt-${admissionId}-${Date.now()}.pdf`;

  const absPath = path.join(challanDir, filename);

  fs.writeFileSync(absPath, pdfBuffer);

  const relStored = toPosix(path.relative(uploadsDir, absPath));
  const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

  const info = insertUploadRecord({
  admissionId,
  originalName: labelPrefix,
  storedName: relStored,
  fileUrl,
  mimeType: "application/pdf",
  size: pdfBuffer.length || 0,
  user: req.session.user,
});

  return {
    skipped: false,
    uploadId: info.lastInsertRowid,
    admissionId,
    familyNumber: String(familyNumber || "").trim(),
phone: String(cleanPaidMonths?.[0]?.phone || cleanPaidMonths?.[0]?.guardianWhatsapp || "").trim(),
guardianWhatsapp: String(cleanPaidMonths?.[0]?.guardianWhatsapp || cleanPaidMonths?.[0]?.phone || "").trim(),
billingYear,
paidMonths: cleanPaidMonths,
fileUrl,
    storedName: relStored,
    mimeType: "application/pdf",
    size: pdfBuffer.length || 0,
  };
}

function buildFeeCollectionWhatsappPayload({
  user,
  mode,
  billingYear,
  totalInputAmount,
  unallocatedAmount,
  applied,
  receipts,
  familyNumber,
  admissionId,
  receiving,
}) {
  return {
    event: "fee_collection_paid_receipt_send_request",
    ts: new Date().toISOString(),
    triggeredBy: {
      id: user?.id || null,
      name: user?.name || null,
      role: user?.role || null,
      dept: user?.dept || null,
    },
    mode,
    billingYear,
    admissionId: admissionId || null,
    familyNumber: familyNumber || "",
    totalInputAmount,
    unallocatedAmount,
    receiving,
    applied,
    receipts,
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
    if (!canAccessAdmissionRow(user, row)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const billingYear = getBillingYearFromReq(req);

// ✅ First read saved billing_json from admissions table
const savedBillingJson = safeJsonParse(row.billing_json) || {};

// ✅ Then read month-wise billing table
const billingArr = getAdmissionBillingByYear(id, billingYear);

// ✅ Always create all 12 months, so Billing Modal never misses old values
const billingJson = {};

for (const m of BILLING_MONTHS) {
  const saved = savedBillingJson?.[m.key] || {};

  billingJson[m.key] = {
    status: String(saved.status || ""),
    amount: String(saved.amount || ""),
    feeOverride: String(saved.feeOverride || ""),
    verification: String(saved.verification || ""),
    bank: String(saved.bank || ""),
    paymentDate: String(saved.paymentDate || ""),

    registrationFeeTotal: String(saved.registrationFeeTotal || ""),
    registrationFeeReceived: String(saved.registrationFeeReceived || ""),
    registrationFeeStatus: String(saved.registrationFeeStatus || ""),
    registrationFeeVerification: String(saved.registrationFeeVerification || ""),
    registrationFeeBank: String(saved.registrationFeeBank || ""),
    registrationFeePaymentDate: String(saved.registrationFeePaymentDate || ""),
  };
}

// ✅ admission_billing table values should override billing_json if present
for (const item of billingArr) {
  const monthKey = String(item.month || "").trim().toLowerCase();
  if (!monthKey) continue;

  billingJson[monthKey] = {
    ...(billingJson[monthKey] || {}),
    status: String(item.status || billingJson[monthKey]?.status || ""),
    amount: String(item.amount || item.amountReceived || billingJson[monthKey]?.amount || ""),
    feeOverride: String(item.fee || item.feeAmount || billingJson[monthKey]?.feeOverride || ""),
    verification: String(item.verificationNumber || billingJson[monthKey]?.verification || ""),
    bank: String(item.bank || item.bankName || billingJson[monthKey]?.bank || ""),
    paymentDate: String(item.paymentDate || item.paidOn || billingJson[monthKey]?.paymentDate || ""),

    registrationFeeTotal: String(item.registrationFeeTotal || billingJson[monthKey]?.registrationFeeTotal || ""),
    registrationFeeReceived: String(item.registrationFeeReceived || billingJson[monthKey]?.registrationFeeReceived || ""),
    registrationFeeStatus: String(item.registrationFeeStatus || billingJson[monthKey]?.registrationFeeStatus || ""),
    registrationFeeVerification: String(item.registrationFeeVerification || billingJson[monthKey]?.registrationFeeVerification || ""),
    registrationFeeBank: String(item.registrationFeeBank || billingJson[monthKey]?.registrationFeeBank || ""),
    registrationFeePaymentDate: String(item.registrationFeePaymentDate || billingJson[monthKey]?.registrationFeePaymentDate || ""),
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
// ================== EXTERNAL UPLOAD PUBLIC ROUTES ==================

// ✅ Generate / get external upload link
app.post("/api/admissions/:id/external-upload-link", requireLogin, requirePerm("btnUpload"), (req, res) => {
  try {
    const user = req.session.user;
    const admissionId = parseInt(req.params.id, 10);

    if (!admissionId) {
      return res.status(400).json({
        success: false,
        message: "Invalid admission id",
      });
    }

    const row = getActiveAdmissionById(admissionId);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Admission not found",
      });
    }

    if (!canAccessAdmissionRow(user, row)) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    const token = createOrGetExternalUploadLink(admissionId, user);
    const uploadBaseUrl =
  process.env.NODE_ENV === "production"
    ? getBaseUrl(req).replace(/\/$/, "")
    : `${req.protocol}://${req.get("host")}`;

const uploadUrl = `${uploadBaseUrl}/external-upload/${token}`;

    return res.json({
      success: true,
      admissionId,
      uploadUrl,
    });
  } catch (err) {
    console.error("POST /api/admissions/:id/external-upload-link error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not create external upload link",
    });
  }
});

// ✅ Public page, no login required
app.get("/external-upload/:token", (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const admission = getAdmissionByExternalUploadToken(token);

    if (!admission) {
      return res.status(404).send("Invalid or expired upload link");
    }

    return res.render("external-upload", {
      pageTitle: "External Upload",
      token,
      admission,
      success: false,
      error: "",
    });
  } catch (err) {
    console.error("GET /external-upload/:token error:", err);
    return res.status(500).send("Server error");
  }
});

// ✅ Public submit, no login required
app.post("/external-upload/:token", upload.single("file"), (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const admission = getAdmissionByExternalUploadToken(token);

    if (!admission) {
      return res.status(404).send("Invalid or expired upload link");
    }

    const f = req.file;
    const externalLinkRaw = String(req.body.external_link || "").trim();
    const hasExternalLink = externalLinkRaw && isSafeExternalLink(externalLinkRaw);

    if (!f && !hasExternalLink) {
      return res.status(400).render("external-upload", {
        pageTitle: "External Upload",
        token,
        admission,
        success: false,
        error: "Please upload a file or paste a valid link.",
      });
    }

    if (f) {
  const relPath = toPosix(path.relative(uploadsDir, f.path));
  const fileUrl = `/uploads/${relPath}`;

  insertUploadRecord({
    admissionId: admission.admission_id,
    originalName: f.originalname,
    storedName: relPath,
    fileUrl,
    mimeType: f.mimetype,
    size: f.size || 0,
    user: {
      id: null,
      name: "External Parent / Student",
      email: "",
      role: "external",
    },
  });
}

    if (hasExternalLink) {
      const safeLink = normalizeExternalLinkUrl(externalLinkRaw);

      insertUploadRecord({
        admissionId: admission.admission_id,
        originalName: "External Uploaded Link",
        storedName: "",
        fileUrl: safeLink,
        mimeType: "text/url",
        size: 0,
        user: {
          id: null,
          name: "External Parent / Student",
          email: "",
          role: "external",
        },
      });
    }

    db.prepare(`
      UPDATE admission_external_upload_links
      SET last_used_at = ?
      WHERE token = ?
    `).run(new Date().toISOString(), token);

    emitAdmissionChanged(req, {
      type: "external_upload_added",
      admissionId: admission.admission_id,
      dept: admission.dept || "",
    });

    return res.render("external-upload", {
      pageTitle: "External Upload",
      token,
      admission,
      success: true,
      error: "",
    });
  } catch (err) {
    console.error("POST /external-upload/:token error:", err);
    return res.status(500).send("Upload failed");
  }
});
app.get("/api/admission-files", requireLogin, requireViewFiles, (req, res) => {
  try {
    const user = req.session.user;
    const filter = String(req.query.filter || "all").trim().toLowerCase();

    const allowedFilters = new Set(["all", "seen", "unseen"]);
    const finalFilter = allowedFilters.has(filter) ? filter : "all";

    const files = getAdmissionUploadsForViewer(user, finalFilter);

    const allFiles = getAdmissionUploadsForViewer(user, "all");
    const seenFiles = allFiles.filter((f) => f.seen);
    const unseenFiles = allFiles.filter((f) => !f.seen);

    return res.json({
      success: true,
      filter: finalFilter,
      counts: {
        all: allFiles.length,
        seen: seenFiles.length,
        unseen: unseenFiles.length,
      },
      files,
    });
  } catch (err) {
    console.error("GET /api/admission-files error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});
app.post("/api/uploads/:uploadId/seen", requireLogin, requireViewFiles, (req, res) => {
  try {
    const user = req.session.user;
    const uploadId = Number(req.params.uploadId || 0);

    if (!uploadId || !user?.id) {
      return res.status(400).json({
        success: false,
        message: "Invalid upload or user",
      });
    }

    const uploadRow = db.prepare(`
            SELECT
        u.id,
        u.admission_id,
        a.id AS linked_admission_id
      FROM uploads u
      LEFT JOIN admissions a
        ON a.id = u.admission_id
      WHERE u.id = ?
      LIMIT 1
    `).get(uploadId);

    if (!uploadRow) {
      return res.status(404).json({
        success: false,
        message: "Upload not found",
      });
    }

    if (!uploadRow.admission_id) {
      return res.status(400).json({
        success: false,
        message: "Upload is not attached to an admission",
      });
    }

    const admissionAccessRow = getActiveAdmissionById(
      uploadRow.linked_admission_id || uploadRow.admission_id
    );

    if (!admissionAccessRow) {
      return res.status(404).json({
        success: false,
        message: "Admission not found",
      });
    }

    if (!canAccessAdmissionRow(user, admissionAccessRow)) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    db.prepare(`
      INSERT OR IGNORE INTO upload_seen_logs
        (upload_id, admission_id, user_id, seen_at)
      VALUES (?, ?, ?, ?)
    `).run(
      uploadRow.id,
      uploadRow.admission_id || null,
      user.id,
      new Date().toISOString()
    );

    return res.json({
      success: true,
      message: "Marked as seen",
      uploadId: uploadRow.id,
      admissionId: uploadRow.admission_id,
    });
  } catch (err) {
    console.error("POST /api/uploads/:uploadId/seen error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
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
    if (!canAccessAdmissionRow(user, row)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }
    // ✅ Existing billing_json + admission_billing ka complete merged snapshot
    const beforeBilling = getBillingJsonByAdmissionId(
      id,
      billingYear
    );

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
        paymentDate: String(v.paymentDate || prev.paymentDate || "").trim(),

        registrationFeeTotal: String(v.registrationFeeTotal || prev.registrationFeeTotal || ""),
        registrationFeeReceived: String(v.registrationFeeReceived || prev.registrationFeeReceived || ""),
        registrationFeeStatus: String(v.registrationFeeStatus || prev.registrationFeeStatus || ""),
        registrationFeeVerification: String(v.registrationFeeVerification || prev.registrationFeeVerification || ""),
        registrationFeeBank: String(v.registrationFeeBank || prev.registrationFeeBank || ""),
        registrationFeePaymentDate: String(v.registrationFeePaymentDate || prev.registrationFeePaymentDate || ""),
      };      } else {
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

const bankVal =
  v && typeof v === "object"
    ? String(v.bank || "").trim()
    : "";

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
       paymentDate: String(prev.paymentDate || ""),

       registrationFeeTotal: String(prev.registrationFeeTotal || ""),
       registrationFeeReceived: String(prev.registrationFeeReceived || ""),
       registrationFeeStatus: String(prev.registrationFeeStatus || ""),
       registrationFeeVerification: String(prev.registrationFeeVerification || ""),
       registrationFeeBank: String(prev.registrationFeeBank || ""),
       registrationFeePaymentDate: String(prev.registrationFeePaymentDate || ""),
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
const monthlyReceivedPayment = computeReceivedPaymentFromBillingJson(billingJson);

const regSnapAfterBilling = getRegistrationFeeSnapshot(row, billingJson, billingYear);

const receivedPayment =
  Number(monthlyReceivedPayment || 0) + Number(regSnapAfterBilling.received || 0);

const expectedWithRegistration =
  Number(dues.expected || 0) + Number(regSnapAfterBilling.total || 0);

const pendingWithRegistration =
  Number(dues.pending || 0) + Number(regSnapAfterBilling.due || 0);

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
    paymentDate: String(item.paymentDate || ""),

    registrationFeeTotal: String(item.registrationFeeTotal || ""),
    registrationFeeReceived: String(item.registrationFeeReceived || ""),
    registrationFeeStatus: String(item.registrationFeeStatus || ""),
    registrationFeeVerification: String(item.registrationFeeVerification || ""),
    registrationFeeBank: String(item.registrationFeeBank || ""),
    registrationFeePaymentDate: String(item.registrationFeePaymentDate || ""),
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
      admission_total_fees: String(expectedWithRegistration || 0),
admission_pending_dues: String(pendingWithRegistration || 0),
admission_total_paid: String(receivedPayment || 0),
      accounts_verification_number: latestVerificationForColumn,
    });

const updatedRow = db
  .prepare("SELECT * FROM admissions WHERE id = ?")
  .get(id);

const billingChanges = buildBillingAuditChanges(
  beforeBilling,
  billingJson
);

const billingSummaryKeys = new Set([
  "accounts_paid_upto",
  "accounts_verification_number",
  "admission_total_fees",
  "admission_pending_dues",
  "admission_total_paid",
]);

const billingSummaryChanges = updatedRow
  ? buildAdmissionAuditChanges(row, updatedRow).filter(
      (change) => billingSummaryKeys.has(change.key)
    )
  : [];

const monthlyFeeChange = updatedRow
  ? makeAuditChange(
      "monthly_fee_current",
      "Monthly Fee",
      row.monthly_fee_current,
      updatedRow.monthly_fee_current,
      "billing"
    )
  : null;

const changes = [
  ...billingChanges,
  ...(monthlyFeeChange ? [monthlyFeeChange] : []),
  ...billingSummaryChanges,
];

if (changes.length) {
  logAudit("billing_update", user, {
    dept: row.dept,
    details: {
      admissionId: id,
      billingYear,
      changes,
    },
  });
}

touchAdmissionActivity(id);

emitAdmissionChanged(req, {
  type: "billing_update",
  admissionId: id,
  dept: row.dept,
});

const familyNumber = String(updatedRow?.accounts_family_number || "").trim();

let familyRows = [];
if (updatedRow) {
  familyRows = getAccessibleFamilyRowsByAdmission(user, updatedRow);
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

const billingWebhookUrl = getApiSetting(
  "N8N_BILLING_WEBHOOK_URL",
  process.env.N8N_BILLING_WEBHOOK_URL || ""
);

if (billingWebhookUrl) {
  try {
    const webhookResp = await fetch(billingWebhookUrl, {
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
function attachRegistrationFeeToFullForMonth({
  full,
  row,
  billingYear = new Date().getFullYear(),
  monthKey,
}) {
  if (!full || !row) return full;

  const cleanMonthKey = String(monthKey || "").trim().toLowerCase();
  const billingJson = getBillingJsonByAdmissionId(row.id, billingYear);
  const snap = getRegistrationFeeSnapshot(row, billingJson, billingYear);

  const emptyRegistrationFeeForChallan = {
    enabled: false,
    monthKey: "",
    monthLabel: "",
    total: 0,
    received: 0,
    due: 0,
    status: "",
    verification: "",
    bank: "",
    paymentDate: "",
  };

  const registrationFeeForChallan =
    snap.enabled && String(snap.monthKey || "").trim().toLowerCase() === cleanMonthKey
      ? {
          enabled: true,
          feeType: "Registration Fee",
          monthKey: snap.monthKey,
          monthLabel: snap.monthLabel,
          total: Number(snap.total || 0),
          received: Number(snap.received || 0),
          due: Number(snap.due || 0),
          status: snap.status || "",
          verification: snap.verification || "",
          bank: snap.bank || "",
          paymentDate: snap.paymentDate || "",
        }
      : emptyRegistrationFeeForChallan;

  return {
    ...full,
    registrationFeeForChallan,

    // Family challan/PDF files ke liye helper data.
    // PDF utility khud month match karke sirf admission month mai show karegi.
    registrationFeeByMonth: snap.enabled
      ? {
          [snap.monthKey]: {
            enabled: true,
            feeType: "Registration Fee",
            monthKey: snap.monthKey,
            monthLabel: snap.monthLabel,
            total: Number(snap.total || 0),
            received: Number(snap.received || 0),
            due: Number(snap.due || 0),
            status: snap.status || "",
            verification: snap.verification || "",
            bank: snap.bank || "",
            paymentDate: snap.paymentDate || "",
          },
        }
      : {},
  };
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

  const beforeRowForAudit = { ...row };

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
  currency,
  bank,
  bank_name,
  bankName,
  comment,
  admission_comment,
  admissionComment,
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
const resolvedBankName = pickBankName(req.body, row.bank_name || "");

if (resolvedBankName) {
  const allowedBank = db
    .prepare("SELECT id FROM bank_options WHERE label = ?")
    .get(resolvedBankName);

  if (!allowedBank) {
    return res.status(400).json({
      success: false,
      message: "Invalid bank selected"
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

// ✅ Sirf jab Month/Year column update ho tab previous months Not admitted karo
const incomingAdmissionMonth =
  typeof month !== "undefined" && month !== null
    ? String(month || "").trim()
    : "";

const oldAdmissionMonth = String(row.admission_month || "").trim();

const canChangeAdmissionMonth =
  user?.role === "super_admin" ||
  (typeof perms !== "undefined" && perms?.colMonth) ||
  (typeof canAccounts !== "undefined" && canAccounts) ||
  (typeof canAdmissions !== "undefined" && canAdmissions);

const shouldApplyNotAdmittedBeforeAdmissionMonth =
  canChangeAdmissionMonth &&
  incomingAdmissionMonth &&
  getMonthKeyFromAdmissionMonthValue(incomingAdmissionMonth);

let updatedBillingJson = billingJson;

if (shouldApplyNotAdmittedBeforeAdmissionMonth) {
  const selectedBillingYear = getBillingYearFromAdmissionMonthValue(
    incomingAdmissionMonth,
    getBillingYearFromReq(req)
  );

  const notAdmittedResult = applyNotAdmittedBeforeAdmissionMonth({
    admissionId: id,
    billingJson,
    admissionMonthValue: incomingAdmissionMonth,
    billingYear: selectedBillingYear,
  });

  updatedBillingJson = notAdmittedResult.billingJson;
}

const dues = calcPendingDues(baseFee, updatedBillingJson, feeHistory);

const rowForRegistrationTotals = {
  ...row,
  admission_registration_fee:
    (typeof registrationFee !== "undefined" && registrationFee !== null && String(registrationFee).trim() !== "")
      ? String(registrationFee).trim()
      : (row.admission_registration_fee || ""),
  admission_month:
    typeof month !== "undefined" && month !== null
      ? month
      : row.admission_month || "",
};

const regSnapAfterAdmissionMonth = getRegistrationFeeSnapshot(
  rowForRegistrationTotals,
  updatedBillingJson,
  getBillingYearFromAdmissionMonthValue(rowForRegistrationTotals.admission_month, getBillingYearFromReq(req))
);

const paidUptoAfterAdmissionMonth = computePaidUptoFromBillingJson(updatedBillingJson);
const monthlyReceivedPaymentAfterAdmissionMonth = computeReceivedPaymentFromBillingJson(updatedBillingJson);

const receivedPaymentAfterAdmissionMonth =
  Number(monthlyReceivedPaymentAfterAdmissionMonth || 0) + Number(regSnapAfterAdmissionMonth.received || 0);

const expectedWithRegistrationAfterAdmissionMonth =
  Number(dues.expected || 0) + Number(regSnapAfterAdmissionMonth.total || 0);

const pendingWithRegistrationAfterAdmissionMonth =
  Number(dues.pending || 0) + Number(regSnapAfterAdmissionMonth.due || 0);

const billingStringsAfterAdmissionMonth = {};
for (const m of BILLING_MONTHS) {
  billingStringsAfterAdmissionMonth[m.key] = toMonthString(updatedBillingJson[m.key]);
}
// ✅ Sync all updated billing_json months into admission_billing table also
// This makes Billing Modal show Not admitted immediately after Month/Year update
const selectedBillingYearForSync = getBillingYearFromAdmissionMonthValue(
  rowForRegistrationTotals.admission_month,
  getBillingYearFromReq(req)
);

for (const m of BILLING_MONTHS) {
  const item = updatedBillingJson[m.key] || {};

  saveAdmissionBillingMonthByYear({
    admissionId: id,
    billingYear: selectedBillingYearForSync,
    monthKey: m.key,
    status: String(item.status || ""),
    amountReceived: String(item.amount || ""),
    feeAmount: String(item.feeOverride || ""),
    verificationNumber: String(item.verification || ""),
    bankName: String(item.bank || ""),
    paymentDate: String(item.paymentDate || ""),

    registrationFeeTotal: String(item.registrationFeeTotal || ""),
    registrationFeeReceived: String(item.registrationFeeReceived || ""),
    registrationFeeStatus: String(item.registrationFeeStatus || ""),
    registrationFeeVerification: String(item.registrationFeeVerification || ""),
    registrationFeeBank: String(item.registrationFeeBank || ""),
    registrationFeePaymentDate: String(item.registrationFeePaymentDate || ""),
  });
}


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
    bank_name: resolvedBankName,
    admission_comment:
      typeof comment !== "undefined" && comment !== null
        ? String(comment).trim()
        : typeof admission_comment !== "undefined" && admission_comment !== null
          ? String(admission_comment).trim()
          : typeof admissionComment !== "undefined" && admissionComment !== null
            ? String(admissionComment).trim()
            : row.admission_comment || "",
    admission_month:
      typeof month !== "undefined" && month !== null
        ? month
        : row.admission_month || "",
    fee_history: JSON.stringify(feeHistory),
    admission_total_fees: String(expectedWithRegistrationAfterAdmissionMonth || 0),
admission_pending_dues: String(pendingWithRegistrationAfterAdmissionMonth || 0),
admission_total_paid: String(receivedPaymentAfterAdmissionMonth || 0),
    accounts_paid_upto: paidUptoAfterAdmissionMonth || "",
    billing_json: JSON.stringify(updatedBillingJson),
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
         bank_name = @bank_name,
         admission_comment = @admission_comment,
         admission_month = @admission_month,
         fee_history = @fee_history,
         monthly_fee_current = @monthly_fee_current,
         admission_total_fees = @admission_total_fees,
         admission_pending_dues = @admission_pending_dues,
         admission_total_paid = @admission_total_paid,
         billing_json = @billing_json,
         january = @january,
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
         december = @december
     WHERE id = @id
  `).run({
    id,
    ...updated,
    ...billingStringsAfterAdmissionMonth,
    monthly_fee_current: incomingFeeNumber > 0 ? incomingFeeNumber : (dues.currentFee || baseFee || 0),
  });

  const afterRow =
    getActiveAdmissionById(id) ||
    { ...row, ...updated };

  const after =
    buildPipelineSnapshotFromRow(afterRow);

  const changes = buildAdmissionAuditChanges(
    beforeRowForAudit,
    afterRow
  );

  if (changes.length) {
    const permanentEntryNumber =
      afterRow.entry_number ||
      row.entry_number ||
      id;

    const studentName = String(
      afterRow.student_name ||
      row.student_name ||
      ""
    ).trim();

    logAudit("pipeline_super_update", user, {
      targetUserId: permanentEntryNumber,
      targetUserName:
        studentName ||
        `Admission ${permanentEntryNumber}`,

      dept: afterRow.dept || row.dept,

      details: {
        databaseAdmissionId: id,
        entryNumber: permanentEntryNumber,
        studentName,
        changes,
      },
    });
  }
  touchAdmissionActivity(id);
  emitAdmissionChanged(req, { type: "super_update", admissionId: id });

if (
  req.xhr ||
  req.get("X-Requested-With") === "XMLHttpRequest" ||
  String(req.headers.accept || "").includes("application/json")
) {
  return res.json({
    success: true,
    message: "Admission updated successfully.",
    admissionId: id,
    updatedFields: after,
  });
}

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
  (entry_number,
   last_activity_at,
   dept,
   status, feeStatus,
   student_name, gender, dob, grade,
   father_name, guardian_whatsapp, religion, father_email, father_occupation, nationality,
   present_address, city, state, secondary_contact,
   session, registration_date, processed_by,
   tuition_grade, phone, currency_code)
  VALUES (
    @entry_number,
    @last_activity_at,
    @dept,
    @status, @feeStatus,
    @student_name, @gender, @dob, @grade,
    @father_name, @guardian_whatsapp, @religion, @father_email, @father_occupation, @nationality,
    @present_address, @city, @state, @secondary_contact,
    @session, @registration_date, @processed_by,
    @tuition_grade, @phone, @currency_code
  )
`);

const insertedIds = [];
const skippedDuplicates = [];

const insertMany = db.transaction((rowsToInsert) => {
  rowsToInsert.forEach((row) => {
    const safeRow = {
      entry_number: getNextAdmissionEntryNumber(),
      last_activity_at: new Date().toISOString(),
      status: "New Admission",
      feeStatus: "New Admission",
      dept: String(row.dept ?? "").trim(),
      student_name: String(row.student_name ?? "").trim(),
      gender: String(row.gender ?? "").trim(),
      dob: String(row.dob ?? "").trim(),
      grade: String(row.grade ?? "").trim(),
      father_name: String(row.father_name ?? "").trim(),
      guardian_whatsapp: String(row.guardian_whatsapp ?? "").trim(),
      religion: String(row.religion ?? "").trim(),
      father_email: String(row.father_email ?? "").trim(),
      father_occupation: String(row.father_occupation ?? "").trim(),
      nationality: String(row.nationality ?? "").trim(),
      present_address: String(row.present_address ?? "").trim(),
      city: String(row.city ?? "").trim(),
      state: String(row.state ?? "").trim(),
      secondary_contact: String(row.secondary_contact ?? "").trim(),
      session: String(row.session ?? "").trim(),
      registration_date: String(row.registration_date ?? "").trim(),
      processed_by: String(row.processed_by ?? "").trim(),
      tuition_grade: String(row.tuition_grade ?? "").trim(),
      phone: String(row.phone ?? "").trim(),
      currency_code: String(row.currency_code ?? "").trim(),
    };

    const duplicate = findDuplicateAdmissionFromForm(safeRow);

if (duplicate) {
  skippedDuplicates.push({
    existingId: duplicate.id,
    studentName: duplicate.student_name || safeRow.student_name,
  });
}

const info = stmt.run(safeRow);
insertedIds.push(Number(info.lastInsertRowid));
  });
});

insertMany(rows);

    const hostBaseUrl = getBaseUrl(req);
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
  message: insertedIds.length
    ? "Admissions saved to DB"
    : "Duplicate admissions skipped",
  inserted: insertedIds.length,
  duplicates_skipped: skippedDuplicates.length,
  skipped_duplicates: skippedDuplicates,
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
if (!canAccessAdmissionRow(user, row)) return res.status(403).send("Not allowed");
    }

    const hostBaseUrl = getBaseUrl(req);

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
  return !!perms?.btnDetails;
}

function ensureAdmissionRouteAccess(user, perms, row) {
  if (!user || !row) return false;

  if (!perms?.btnDetails) return false;

  return canAccessAdmissionRow(user, row);
}

function canUseEditFeature(user, perms) {
  if (!user) return false;
  return !!perms?.btnEditRow;
}

function ensureAdmissionEditRouteAccess(user, perms, row) {
  if (!user || !row) return false;

  if (!perms?.btnEditRow) return false;

  return canAccessAdmissionRow(user, row);
}

function renderSharedAdmissionEdit(req, res) {
  try {
    const user = req.session.user;
    const perms = getPerm(user);
    const billingYear = getBillingYearFromReq(req);

    if (!canUseEditFeature(user, perms)) {
      return res.status(403).send("Not allowed");
    }

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send("Invalid id");

    const row = getActiveAdmissionById(id);
    if (!row) return res.status(404).send("Admission not found");

    if (!ensureAdmissionEditRouteAccess(user, perms, row)) {
      return res.status(403).send("Not allowed");
    }

    const familyNumber = String(row.accounts_family_number || "").trim();

let rows = getAccessibleFamilyRowsByAdmission(user, row);
if (!rows.length) rows = [row];

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

    return res.render("admission-edit", {
  user,
  perms,
  admission: primary,
  admissions,
  familyNumber,
  billingMonths: BILLING_MONTHS,
  bankOptions: getBankOptions(),
  pageTitle: "Edit Admission",
});
  } catch (err) {
    console.error("renderSharedAdmissionEdit error:", err);
    return res.status(500).send("Server error");
  }
}
function getAccessibleFamilyRows(user, familyNumber) {
  const cleanFamilyNumber = String(familyNumber || "").trim();
  if (!cleanFamilyNumber) return [];

  const rows = db
    .prepare(`
      SELECT *
      FROM admissions
      WHERE TRIM(COALESCE(accounts_family_number, '')) = TRIM(?)
        AND COALESCE(is_deleted, 0) = 0
      ORDER BY id DESC
    `)
    .all(cleanFamilyNumber);

  if (user?.role === "super_admin") {
    return rows;
  }

  return rows.filter((row) => canAccessAdmissionRow(user, row));
}

function getAccessibleFamilyIds(user, familyNumber) {
  if (!familyNumber) return [];

  const rows = getAccessibleFamilyRows(user, familyNumber);

  return rows.map((row) => ({
    id: row.id,
  }));
}
function getAccessibleFamilyRowsForRoute(user, { familyNumber = "", admissionId = "" } = {}) {
  const cleanFamilyNumber = String(familyNumber || "").trim();
  const cleanAdmissionId = parseInt(admissionId, 10);

  // ✅ Best case: admissionId mila to same family number + father name + phone se family nikalo
  if (cleanAdmissionId) {
    const row = getActiveAdmissionById(cleanAdmissionId);
    if (!row) return [];

    if (!canAccessAdmissionRow(user, row)) return [];

    const rows = getAccessibleFamilyRowsByAdmission(user, row);
    return rows.length ? rows : [row];
  }

  // ✅ Old support: sirf family number se family nikalo
  if (cleanFamilyNumber && cleanFamilyNumber.toLowerCase() !== "auto") {
    return getAccessibleFamilyRows(user, cleanFamilyNumber);
  }

  return [];
}

function getAccessibleFamilyIdsForRoute(user, { familyNumber = "", admissionId = "" } = {}) {
  const rows = getAccessibleFamilyRowsForRoute(user, { familyNumber, admissionId });

  return rows.map((row) => ({
    id: row.id,
  }));
}

function getFamilyRouteLabel(familyNumber, admissionId = "") {
  const cleanFamilyNumber = String(familyNumber || "").trim();
  if (cleanFamilyNumber && cleanFamilyNumber.toLowerCase() !== "auto") {
    return cleanFamilyNumber;
  }

  const cleanAdmissionId = String(admissionId || "").trim();
  return cleanAdmissionId ? `auto-${cleanAdmissionId}` : "auto-family";
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

let rows = getAccessibleFamilyRowsByAdmission(user, row);
if (!rows.length) rows = [row];

  const admissionsFull = rows
  .map((r) => dbGetAdmissionDetailsById(r.id, billingYear))
  .filter(Boolean);

        const admissions = admissionsFull.map((full) => {
      const safe = maskAdmissionMapped(full, perms);
      const rrow = getActiveAdmissionById(full.id);

      if (rrow) {
  safe.accounts = safe.accounts || {};
  safe.accounts.verificationNumber = String(rrow.accounts_verification_number || "").trim();
  safe.accounts_verification_number = String(rrow.accounts_verification_number || "").trim();

  // ✅ Details page read-only: Bank should show even if colBank permission is off
  safe.admission = safe.admission || {};
  safe.admission.bankName = String(rrow.bank_name || "").trim();
  safe.admission.bank_name = String(rrow.bank_name || "").trim();
  safe.bankName = String(rrow.bank_name || "").trim();
  safe.bank_name = String(rrow.bank_name || "").trim();

  attachComputedMonthFees(rrow, safe, billingYear);
}

      return safe;
    });

    const primaryFull = dbGetAdmissionDetailsById(id, billingYear);
    if (!primaryFull) return res.status(404).send("Admission not found");

    const primary = maskAdmissionMapped(primaryFull, perms);

    primary.accounts = primary.accounts || {};
primary.accounts.verificationNumber = String(row.accounts_verification_number || "").trim();
primary.accounts_verification_number = String(row.accounts_verification_number || "").trim();

// ✅ Details page read-only: Bank should show even if colBank permission is off
primary.admission = primary.admission || {};
primary.admission.bankName = String(row.bank_name || "").trim();
primary.admission.bank_name = String(row.bank_name || "").trim();
primary.bankName = String(row.bank_name || "").trim();
primary.bank_name = String(row.bank_name || "").trim();

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
  rows = getAccessibleFamilyRowsForRoute(user, {
    familyNumber,
    admissionId,
  });

  if (rows.length) {
    mode = "family";
  } else {
    rows = [row];
  }
} else {
  rows = getAccessibleFamilyRowsByAdmission(user, row);
  if (!rows.length) rows = [row];
  if (rows.length > 1) mode = "family";
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

    const paidRows =
      mode === "family"
        ? buildPaidFeeCollectionRowsForFamily(rows, billingYear)
        : buildPaidFeeCollectionRowsForAdmission(primaryRow, billingYear);

    const excludedRows =
     mode === "family"
      ? buildExcludedFeeCollectionRowsForFamily(rows, billingYear)
      : buildExcludedFeeCollectionRowsForAdmission(primaryRow, billingYear);

    const summary = summarizeFeeCollectionRows(rows, billingYear, currentMonthKey());

const familyLabelForView =
  mode === "family"
    ? getFamilyRouteLabel(familyNumber, primaryRow?.id || admissionId)
    : (familyNumber || String(primaryRow?.accounts_family_number || "").trim());

    return res.render("fee-collection", {
      user,
      perms,
      pageTitle: "Fee Collection",
      billingYear,
      mode,
      admissionId: primaryRow?.id || "",
      familyNumber: familyLabelForView,
      masterVerificationNumber: String(primaryRow?.accounts_verification_number || "").trim(),
      masterBankName: String(primaryRow?.bank_name || "").trim(),
      rows,
      feeRows,
      paidRows,
      excludedRows,
      summary,
      bankOptions: getBankOptions(),
      isPaidSlipWorkflowUser: isPaidSlipAgentOrSubAgent(user),
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
// ✅ EDIT ADMISSION PAGE
// btnEditRow permission required
// =====================================================
app.get("/dashboard/super/admission/:id/edit", requireLogin, (req, res) => {
  return renderSharedAdmissionEdit(req, res);
});

app.get("/admin/admission/:id/edit", requireLogin, (req, res) => {
  return renderSharedAdmissionEdit(req, res);
});

app.get("/dashboard/admission/:id/edit", requireLogin, (req, res) => {
  return renderSharedAdmissionEdit(req, res);
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

    const fullWithHistory = attachRegistrationFeeToFullForMonth({
  full: attachPreviousSixMonthsToFull(full, monthKey),
  row,
  billingYear,
  monthKey,
});

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
    const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

    insertUploadRecord({
  admissionId: id,
  originalName: `Challan (${monthKey})`,
  storedName: relStored,
  fileUrl,
  mimeType: "application/pdf",
  size: pdfBuffer.length || 0,
  user,
});
emitAdmissionChanged(req, {
  type: "challan_generated",
  admissionId: id,
  dept: row.dept || "",
});
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

    const ins = {
  run: (admissionId, originalName, storedName, fileUrl, mimeType, size) =>
    insertUploadRecord({
      admissionId,
      originalName,
      storedName,
      fileUrl,
      mimeType,
      size,
      user,
    }),
};

    let made = 0;

    for (const p of pendingRows) {
  const fullWithHistory = attachRegistrationFeeToFullForMonth({
    full: attachPreviousSixMonthsToFull(full, p.monthKey),
    row,
    billingYear,
    monthKey: p.monthKey,
  });

  const pdfBuffer = await makeMonthlyChallanPdf({
    full: fullWithHistory,
    monthKey: p.monthKey,
    bannerPath,
  });

      const fname = `fee-bulk-${id}-${p.monthKey}-${Date.now()}.pdf`;
      const absPath = path.join(challanDir, fname);
      fs.writeFileSync(absPath, pdfBuffer);

      const relStored = toPosix(path.relative(uploadsDir, absPath));
      const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

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

       emitAdmissionChanged(req, {
  type: "fee_bulk_generated",
  admissionId: id,
  dept: row.dept || "",
});
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
const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

insertUploadRecord({
  admissionId: id,
  originalName: `All Paid Receipts`,
  storedName: relStored,
  fileUrl,
  mimeType: "application/pdf",
  size: pdfBuffer.length || 0,
  user,
});

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
const regFeePaid = Number(row?.registrationFeeReceived || 0);

if ((!amt || amt <= 0) && (!regFeePaid || regFeePaid <= 0)) {
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
    const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

    insertUploadRecord({
  admissionId: id,
  originalName: `Challan (${monthKey})`,
  storedName: relStored,
  fileUrl,
  mimeType: "application/pdf",
  size: pdfBuffer.length || 0,
  user,
});
emitAdmissionChanged(req, {
  type: "paid_challan_generated",
  admissionId: id,
  dept: row.dept || "",
});
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
const admissionId = String(req.query.admissionId || req.query.id || "").trim();

const rows = getAccessibleFamilyRowsForRoute(user, {
  familyNumber,
  admissionId,
});

if (!rows.length) {
  return res.status(404).json({
    success: false,
    message: "No family admissions found",
  });
}

const familyLabel = getFamilyRouteLabel(familyNumber, admissionId);
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
      familyNumber: familyLabel,
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
const admissionId = String(req.query.admissionId || req.query.id || "").trim();
const familyLabel = getFamilyRouteLabel(familyNumber, admissionId);

const rows = getAccessibleFamilyIdsForRoute(user, {
  familyNumber,
  admissionId,
});

if (!rows.length) return res.status(404).send("No family admissions found");

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

    const originalRow = getActiveAdmissionById(adm.id);

  return attachRegistrationFeeToFullForMonth({
    full: attachPreviousSixMonthsToFull(adm, currentMonthKey),
    row: originalRow,
    billingYear,
    monthKey: currentMonthKey,
  });
});

const pdfBuffer = await makeFamilyChallanPdf({
  familyNumber: familyLabel,
  admissionsFull: admissionsFullWithHistory,
  bannerPath,
});

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const filename = `family-challan-${familyLabel}-${Date.now()}.pdf`;
    const absPath = path.join(challanDir, filename);
    fs.writeFileSync(absPath, pdfBuffer);

    const relStored = toPosix(path.relative(uploadsDir, absPath));
    const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

    const ins = {
  run: (admissionId, originalName, storedName, fileUrl, mimeType, size) =>
    insertUploadRecord({
      admissionId,
      originalName,
      storedName,
      fileUrl,
      mimeType,
      size,
      user,
    }),
};

    for (const adm of admissionsFull) {
      const admissionId = adm?.id || null;
      if (!admissionId) continue;

      ins.run(
        admissionId,
        `Family Challan (F.Code ${familyLabel})`,
        relStored,
        fileUrl,
        "application/pdf",
        pdfBuffer.length || 0
      );
    }

    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="family-challan-${familyLabel}.pdf"`);
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
const admissionId = String(req.query.admissionId || req.query.id || "").trim();
const familyLabel = getFamilyRouteLabel(familyNumber, admissionId);

const rows = getAccessibleFamilyIdsForRoute(user, {
  familyNumber,
  admissionId,
});

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

    const originalRow = getActiveAdmissionById(adm.id);

  return attachRegistrationFeeToFullForMonth({
    full: attachPreviousSixMonthsToFull(adm, currentMonthKey),
    row: originalRow,
    billingYear,
    monthKey: currentMonthKey,
  });
});

const pdfBuffer = await makeFamilyChallanPdf({
  familyNumber: familyLabel,
  admissionsFull: admissionsFullWithHistory,
  bannerPath,
  pendingOnly: true,
});
    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const filename = `family-pending-challan-${familyLabel}-${Date.now()}.pdf`;
    const absPath = path.join(challanDir, filename);
    fs.writeFileSync(absPath, pdfBuffer);

    const relStored = toPosix(path.relative(uploadsDir, absPath));
    const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

    const ins = {
  run: (admissionId, originalName, storedName, fileUrl, mimeType, size) =>
    insertUploadRecord({
      admissionId,
      originalName,
      storedName,
      fileUrl,
      mimeType,
      size,
      user,
    }),
};

    const changedAdmissionIds = [];

for (const a of admissionsFull) {
  ins.run(
    a.id,
    `All Pending Fee Challans (Family ${familyLabel})`,
    relStored,
    fileUrl,
    "application/pdf",
    pdfBuffer.length || 0
  );

  changedAdmissionIds.push(Number(a.id));
}

emitAdmissionChanged(req, {
  type: "family_fee_challan_generated",
  insertedIds: changedAdmissionIds,
  dept: admissionsFull?.[0]?.dept || "",
});

res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="family-pending-${familyLabel}.pdf"`);
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
    const admissionId = String(req.query.admissionId || req.query.id || "").trim();
    const familyLabel = getFamilyRouteLabel(familyNumber, admissionId);

    const ids = getAccessibleFamilyIdsForRoute(user, {
      familyNumber,
      admissionId,
    });

    if (!ids.length) return res.status(404).send("No family admissions found");

    const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

    const { year, month } = getYearMonthParts(new Date());
    const challanDir = path.join(uploadsDir, "challans", year, month);
    if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

    const ins = {
      run: (admissionId, originalName, storedName, fileUrl, mimeType, size) =>
        insertUploadRecord({
          admissionId,
          originalName,
          storedName,
          fileUrl,
          mimeType,
          size,
          user,
        }),
    };

    let totalMade = 0;
    const changedAdmissionIds = new Set();
    const changedDeptSet = new Set();
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
        const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

        ins.run(
          r.id,
          `All Paid Receipts (${pm.monthKey}) (Family ${familyLabel})`,
          relStored,
          fileUrl,
          "application/pdf",
          pdfBuffer.length || 0
        );

        changedAdmissionIds.add(Number(r.id));

        if (row.dept) {
          changedDeptSet.add(String(row.dept || "").trim());
        }

        totalMade++;
      }
    }

    if (changedAdmissionIds.size > 0) {
      emitAdmissionChanged(req, {
        type: "family_paid_receipts_generated",
        insertedIds: Array.from(changedAdmissionIds),
        dept: Array.from(changedDeptSet).join(","),
      });
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


app.post("/api/fee-collection/receive", requireLogin, requireSaveBilling, async (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    if (!canUseDetailsFeature(user, perms)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const {
  admissionId,
  familyNumber,
  registrationReceivingAmount,
  receivingAmount,
  verificationNumber,
  verificationMode,
  verificationChoice,
  verificationApproved,
  collectionAccountApproved,
  useMasterVerification,
  useMasterBank,
  bankMode,
  bankChoice,
  collectionAccount,
  receivingDate,
  note,
  year,
  selectedNotAdmittedMonths,
} = req.body || {};

    const billingYear = Number(year) || new Date().getFullYear();
    const registrationAmount = Number(registrationReceivingAmount || 0);
const amount = Number(receivingAmount || 0);
const totalInputAmount = registrationAmount + amount;
    const cleanFamilyNumber = String(familyNumber || "").trim();
    const cleanVerificationNumber = String(verificationNumber || "").trim();

    const requiresPaidSlipApprovals =
      isPaidSlipAgentOrSubAgent(user) && totalInputAmount > 0;

    if (
      requiresPaidSlipApprovals &&
      (
        !isTruthyRequestFlag(verificationApproved) ||
        !isTruthyRequestFlag(collectionAccountApproved)
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please approve both Verification Number and Collection Account before receiving payment.",
      });
    }

    const verificationDecision = String(
      useMasterVerification || verificationMode || verificationChoice || ""
    ).trim().toLowerCase();

    const shouldUseMasterVerification = [
      "1",
      "true",
      "yes",
      "master",
      "current",
      "saved",
    ].includes(verificationDecision);

    const bankDecision = String(
      useMasterBank || bankMode || bankChoice || ""
    ).trim().toLowerCase();

    const shouldUseMasterBank = [
      "1",
      "true",
      "yes",
      "master",
      "current",
      "saved",
    ].includes(bankDecision);

    const canEditVerificationNumber =
      user?.role === "super_admin" ||
      perms?.colVerificationNumber === true;

    if (
      totalInputAmount > 0 &&
      !shouldUseMasterVerification &&
      !canEditVerificationNumber
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to change verification number",
      });
    }

    const canEditBank =
      user?.role === "super_admin" ||
      perms?.colBank === true;

    const cleanCollectionAccount = String(collectionAccount || "").trim();

    if (!shouldUseMasterBank && !canEditBank) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to change collection account",
      });
    }

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

    if (totalInputAmount <= 0 && !cleanSelectedNotAdmittedMonths.length) {
  return res.status(400).json({
    success: false,
    message: "Receiving amount must be greater than zero or select month(s) for Not admitted",
  });
}




    let targetRows = [];
let mode = "single";

const cleanAdmissionId = parseInt(admissionId, 10);

if (cleanFamilyNumber || cleanAdmissionId) {
  targetRows = getAccessibleFamilyRowsForRoute(user, {
    familyNumber: cleanFamilyNumber,
    admissionId: cleanAdmissionId,
  });

  if (!targetRows.length) {
    return res.status(404).json({
      success: false,
      message: cleanFamilyNumber
        ? "No family admissions found"
        : "Admission not found",
    });
  }

  mode = targetRows.length > 1 || cleanFamilyNumber ? "family" : "single";

  const hasAnyMasterVerification = targetRows.some((r) =>
    String(r.accounts_verification_number || "").trim()
  );

  if (totalInputAmount > 0 && !shouldUseMasterVerification && !cleanVerificationNumber) {
    return res.status(400).json({
      success: false,
      message: "Verification number is required",
    });
  }

  if (totalInputAmount > 0 && shouldUseMasterVerification && !hasAnyMasterVerification) {
    return res.status(400).json({
      success: false,
      message: "Master verification number is missing. Please enter correct verification number.",
    });
  }
} else {
  return res.status(400).json({
    success: false,
    message: "admissionId or familyNumber required",
  });
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

const effectiveCollectionAccount = shouldUseMasterBank
  ? String(targetRows?.[0]?.bank_name || cleanCollectionAccount || "").trim()
  : cleanCollectionAccount;

if (totalInputAmount > 0 && !effectiveCollectionAccount) {
  return res.status(400).json({
    success: false,
    message: "Collection account is required",
  });
}

if (totalInputAmount > 0) {
  const allowedEffectiveBank = db
    .prepare("SELECT id FROM bank_options WHERE label = ?")
    .get(effectiveCollectionAccount);

  if (!allowedEffectiveBank) {
    return res.status(400).json({
      success: false,
      message: "Invalid collection account selected",
    });
  }
}

    let registrationRemaining = registrationAmount;
let remaining = amount;

const appliedMap = new Map();
const rowsInOrder = [...targetRows].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));

// ✅ 1) Not admitted + Registration fee pehle handle hogi
for (const row of rowsInOrder) {
  const selectedForThisRow = cleanSelectedNotAdmittedMonths.filter(
    (x) => Number(x.admissionId) === Number(row.id)
  );

  const entry = ensureAppliedEntry(appliedMap, row);

  if (selectedForThisRow.length) {
    markSelectedMonthsNotAdmitted({
      row,
      billingYear,
      selectedMonths: selectedForThisRow,
    });

    entry.touchedMonths.push(
  ...selectedForThisRow.map((x) => ({
    admissionId: row.id,
    studentName: row.student_name || "",
    grade: row.grade || "",
    registrationNumber: String(row.accounts_registration_number || "").trim(),
    familyNumber: String(row.accounts_family_number || "").trim(),
    phone: String(row.phone || row.guardian_whatsapp || "").trim(),
    guardianWhatsapp: String(row.guardian_whatsapp || row.phone || "").trim(),
    monthKey: x.monthKey,
    status: "Not admitted",
  }))
);
  }

  if (registrationRemaining > 0) {
    const registrationResult = applyRegistrationFeeCollectionToBilling({
      row,
      billingYear,
      receiveAmount: registrationRemaining,
      verificationNumber: shouldUseMasterVerification ? "" : cleanVerificationNumber,
      collectionAccount: effectiveCollectionAccount,
      receivingDate: cleanReceivingDate,
      note: cleanNote,
      actorUser: user,
    });

    const regUsed = Number(registrationResult?.appliedAmount || 0);
    registrationRemaining = Number(registrationResult?.remainingAmount || 0);

    if (regUsed > 0) {
      entry.usedAmount += regUsed;
      entry.remainingAmount = registrationRemaining + remaining;
      entry.touchedMonths.push(
        ...(registrationResult?.touchedMonths || []).map((m) => ({
          ...m,
          admissionId: row.id,
          studentName: row.student_name || "",
          grade: row.grade || "",
          registrationNumber: String(row.accounts_registration_number || "").trim(),
          familyNumber: String(row.accounts_family_number || "").trim(),
          phone: String(row.phone || row.guardian_whatsapp || "").trim(),
guardianWhatsapp: String(row.guardian_whatsapp || row.phone || "").trim(),
        }))
      );
      entry.paidUpto = registrationResult?.paidUpto || entry.paidUpto || "";
      entry.receivedPayment = registrationResult?.receivedPayment || entry.receivedPayment || 0;
    }
  }

  emitAdmissionChanged(req, {
    type: "fee_collection_received",
    admissionId: row.id,
    dept: row.dept || "",
  });
}

// ✅ 2) Monthly fee: family mode me month-wise distribute hogi
if (remaining > 0) {
  if (mode === "family") {
    const familyMonthlyResult = applyFamilyMonthlyFeeCollectionMonthWise({
      rows: rowsInOrder,
      billingYear,
      receiveAmount: remaining,
      verificationNumber: shouldUseMasterVerification ? "" : cleanVerificationNumber,
      collectionAccount: effectiveCollectionAccount,
      receivingDate: cleanReceivingDate,
      note: cleanNote,
      actorUser: user,
      appliedMap,
    });

    remaining = Number(familyMonthlyResult.remainingAmount || 0);
  } else {
    for (const row of rowsInOrder) {
      if (remaining <= 0) break;

      const result = applyFeeCollectionToBilling({
        row,
        billingYear,
        receiveAmount: remaining,
        verificationNumber: shouldUseMasterVerification ? "" : cleanVerificationNumber,
        collectionAccount: effectiveCollectionAccount,
        receivingDate: cleanReceivingDate,
        note: cleanNote,
        actorUser: user,
      });

      const used = Number(result.appliedAmount || 0);
      remaining = Number(result.remainingAmount || 0);

      if (used > 0) {
        const entry = ensureAppliedEntry(appliedMap, row);
        entry.usedAmount += used;
        entry.remainingAmount = remaining;
        entry.touchedMonths.push(
          ...(result.touchedMonths || []).map((m) => ({
            ...m,
            admissionId: row.id,
            studentName: row.student_name || "",
            grade: row.grade || "",
            registrationNumber: String(row.accounts_registration_number || "").trim(),
            familyNumber: String(row.accounts_family_number || "").trim(),
            phone: String(row.phone || row.guardian_whatsapp || "").trim(),
guardianWhatsapp: String(row.guardian_whatsapp || row.phone || "").trim(),
          }))
        );
        entry.paidUpto = result.paidUpto || entry.paidUpto || "";
        entry.receivedPayment = result.receivedPayment || entry.receivedPayment || 0;
      }

      emitAdmissionChanged(req, {
        type: "fee_collection_received",
        admissionId: row.id,
        dept: row.dept || "",
      });
    }
  }
}

const applied = Array.from(appliedMap.values())
  .filter((x) => {
    const hasTouched = Array.isArray(x.touchedMonths) && x.touchedMonths.length > 0;
    const hasAmount = Number(x.usedAmount || 0) > 0;
    return hasTouched || hasAmount;
  })
  .map((x) => ({
    ...x,
    remainingAmount: registrationRemaining + remaining,
  }));

   const refreshedRows =
      mode === "family"
        ? getAccessibleFamilyRowsForRoute(user, {
            familyNumber: cleanFamilyNumber,
            admissionId: cleanAdmissionId,
          })
        : [getActiveAdmissionById(cleanAdmissionId)].filter(Boolean);

    const refreshedFeeRows =
      mode === "family"
        ? buildFeeCollectionRowsForFamily(refreshedRows, billingYear)
        : buildFeeCollectionRowsForAdmission(refreshedRows[0], billingYear);

    const refreshedExcludedRows =
      mode === "family"
        ? buildExcludedFeeCollectionRowsForFamily(refreshedRows, billingYear)
        : buildExcludedFeeCollectionRowsForAdmission(refreshedRows[0], billingYear);

    const refreshedPaidRows =
      mode === "family"
        ? buildPaidFeeCollectionRowsForFamily(refreshedRows, billingYear)
        : buildPaidFeeCollectionRowsForAdmission(refreshedRows[0], billingYear);

    const summary = summarizeFeeCollectionRows(
      refreshedRows,
      billingYear,
      currentMonthKey()
    );
   const receipts = [];

const rowInfoMap = new Map(
  (refreshedRows || []).map((r) => [Number(r.id || 0), r])
);

const collectionFamilyLabel =
  mode === "family"
    ? getFamilyRouteLabel(cleanFamilyNumber, cleanAdmissionId)
    : cleanFamilyNumber;

if (mode === "family") {
  const familyPaidTouchedMonths = [];

  for (const item of applied) {
    const rowInfo = rowInfoMap.get(Number(item.admissionId || 0)) || {};

    const paidTouchedMonths = (item.touchedMonths || []).filter((m) => {
      const used = Number(m.used || 0);
      const status = String(m.status || "").trim().toLowerCase();

      return used > 0 && status !== "not admitted";
    });

    familyPaidTouchedMonths.push(
      ...paidTouchedMonths.map((m) => ({
        ...m,
        admissionId: item.admissionId,
        studentName: item.studentName || rowInfo.student_name || "",
        grade: item.grade || rowInfo.grade || "",
        registrationNumber:
          item.registrationNumber ||
          String(rowInfo.accounts_registration_number || "").trim(),
        familyNumber:
  item.familyNumber ||
  String(rowInfo.accounts_family_number || cleanFamilyNumber || "").trim(),
phone:
  item.phone ||
  String(rowInfo.phone || rowInfo.guardian_whatsapp || "").trim(),
guardianWhatsapp:
  item.guardianWhatsapp ||
  String(rowInfo.guardian_whatsapp || rowInfo.phone || "").trim(),
verification: cleanVerificationNumber,
        bank: effectiveCollectionAccount,
      }))
    );
  }

  if (familyPaidTouchedMonths.length) {
    try {
      const primaryAdmissionId =
        Number(familyPaidTouchedMonths[0]?.admissionId || 0) ||
        Number(refreshedRows?.[0]?.id || 0);

      const primaryFull = dbGetAdmissionDetailsById(primaryAdmissionId, billingYear);

      const receipt = await generateReceivedPaidReceiptForN8n({
        req,
        admissionId: primaryAdmissionId,
        billingYear,
        paidMonths: familyPaidTouchedMonths,
        fullOverride: {
          ...(primaryFull || {}),
          familyNumber: collectionFamilyLabel,
          accounts: {
            ...(primaryFull?.accounts || {}),
            familyNumber: collectionFamilyLabel,
          },
        },
        familyNumber: collectionFamilyLabel,
        labelPrefix: `Family Received Paid Receipt (${collectionFamilyLabel})`,
      });

      receipts.push({
        familyNumber: collectionFamilyLabel,
        ...receipt,
      });
    } catch (receiptErr) {
      receipts.push({
        familyNumber: collectionFamilyLabel,
        error: String(receiptErr?.message || receiptErr),
      });
    }
  }
} else {
  for (const item of applied) {
    const rowInfo = rowInfoMap.get(Number(item.admissionId || 0)) || {};

    const paidTouchedMonths = (item.touchedMonths || []).filter((m) => {
      const used = Number(m.used || 0);
      const status = String(m.status || "").trim().toLowerCase();

      return used > 0 && status !== "not admitted";
    });

    if (!paidTouchedMonths.length) continue;

    try {
      const receipt = await generateReceivedPaidReceiptForN8n({
        req,
        admissionId: item.admissionId,
        billingYear,
        paidMonths: paidTouchedMonths.map((m) => ({
          ...m,
          admissionId: item.admissionId,
          studentName: item.studentName || rowInfo.student_name || "",
          grade: item.grade || rowInfo.grade || "",
          registrationNumber:
            item.registrationNumber ||
            String(rowInfo.accounts_registration_number || "").trim(),
          familyNumber:
  item.familyNumber ||
  String(rowInfo.accounts_family_number || "").trim(),
phone:
  item.phone ||
  String(rowInfo.phone || rowInfo.guardian_whatsapp || "").trim(),
guardianWhatsapp:
  item.guardianWhatsapp ||
  String(rowInfo.guardian_whatsapp || rowInfo.phone || "").trim(),
verification: cleanVerificationNumber,
          bank: effectiveCollectionAccount,
        })),
        labelPrefix: "Received Paid Receipt",
      });

      receipts.push({
        admissionId: item.admissionId,
        studentName: item.studentName || "",
        ...receipt,
      });
    } catch (receiptErr) {
      receipts.push({
        admissionId: item.admissionId,
        studentName: item.studentName || "",
        error: String(receiptErr?.message || receiptErr),
      });
    }
  }
}

let n8nStatus = "skipped";
let n8nResponseText = "";

const billingWebhookUrl = getApiSetting(
  "N8N_BILLING_WEBHOOK_URL",
  process.env.N8N_BILLING_WEBHOOK_URL || ""
);

if (billingWebhookUrl) {
  const payload = buildFeeCollectionWhatsappPayload({
    user,
    mode,
    billingYear,
    totalInputAmount,
unallocatedAmount: registrationRemaining + remaining,
    applied,
    receipts,
    familyNumber: collectionFamilyLabel,
    admissionId: admissionId || "",
    receiving: {
      amount: totalInputAmount,
registrationAmount,
monthlyAmount: amount,
verificationNumber: shouldUseMasterVerification ? "" : cleanVerificationNumber,
      collectionAccount: effectiveCollectionAccount,
      receivingDate: cleanReceivingDate,
      note: cleanNote,
    },
  });

  try {
    const webhookResp = await fetch(billingWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
  message: "Fee received successfully",
  mode,
  billingYear,
  totalInputAmount,
  registrationInputAmount: registrationAmount,
  monthlyInputAmount: amount,
  unallocatedAmount: registrationRemaining + remaining,
  applied,
  receipts,
  n8nStatus,
  n8nResponse: n8nResponseText,
  feeRows: refreshedFeeRows,
  excludedRows: refreshedExcludedRows,
  paidRows: refreshedPaidRows,
  summary,

  // Paid Slip Agent/Sub-Agent will open the existing forwarding modal
  // after this successful response and select a Print & Record Update user.
  recordUpdateForwardRequired: requiresPaidSlipApprovals,
  nextWorkflowAction: requiresPaidSlipApprovals
    ? {
        toType: "print_record_update",
        toDepartment: "Print + Record update",
        workflowStage: "record_to_update",
        label: "Record to Update",
      }
    : null,
});
  } catch (err) {
    console.error("POST /api/fee-collection/receive error:", err);
    return res.status(500).json({
      success: false,
      message: "Fee collection failed",
    });
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
// =====================================================
// ✅ Single admission JSON API
// Used for real-time row refresh without full page reload
// =====================================================
app.get("/api/admissions/:id", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const perms = getPerm(user);

    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid id",
      });
    }

    const row = getActiveAdmissionById(id);
    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Admission not found",
      });
    }

    // ✅ Real-time row refresh ke liye btnDetails zaroori nahi.
    // Sirf wahi user row fetch kar sakta hai jisko us admission ka access hai.
    if (!canAccessAdmissionRow(user, row)) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    const billingYear = getBillingYearFromReq(req);
    const full = dbGetAdmissionDetailsById(id, billingYear);

    if (!full) {
      return res.status(404).json({
        success: false,
        message: "Admission not found",
      });
    }

    const safe = maskAdmissionMapped(full, perms);
    attachComputedMonthFees(row, safe, billingYear);

    safe.forwardStatus =
      row.forward_status || "not_forwarded";

    safe.forwardSubStatus =
      getForwardSubStatus(row);

    const forwardSnapshot =
      getAdmissionForwardSnapshot(row);

    const forwardTimeLogs =
      getAdmissionPreviousForwardTimeLogs(id);

    safe.forward = {
      ...forwardSnapshot,
      forwardTimeLogs,
      timeLogs: forwardTimeLogs,
    };

    safe.forwardTimer =
      forwardSnapshot.currentTimer;

    safe.currentForwardTimer =
      forwardSnapshot.currentTimer;

    safe.forwardTimeLogs =
      forwardTimeLogs;

    safe.forward_time_logs =
      forwardTimeLogs;

    safe.timeLogs =
      forwardTimeLogs;

    safe.notReceivedVisibleForCurrentUser =
      isNotReceivedVisibleForCurrentUser(
        user,
        row
      );

    safe.reuploadTagActive =
      Number(
        row.reupload_tag_active || 0
      );

    safe.reupload_tag_active =
      Number(
        row.reupload_tag_active || 0
      );

    safe.workflowTag =
      getAdmissionWorkflowTag(row);

    return res.json({
      success: true,
      admission: safe,
    });
  } catch (err) {
    console.error("GET /api/admissions/:id error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ✅ Forward timer history for one admission
app.get("/api/admissions/:id/forward-time-logs", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const admissionId = Number(req.params.id || 0);

    if (!admissionId) {
      return res.status(400).json({
        success: false,
        message: "Invalid admission id",
      });
    }

    const row = getActiveAdmissionById(admissionId);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Admission not found",
      });
    }

    if (!canAccessAdmissionRow(user, row)) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    const forwardSnapshot = getAdmissionForwardSnapshot(row);

    return res.json({
      success: true,
      admissionId,
      currentTimer: forwardSnapshot.currentTimer,
      logs: getAdmissionForwardTimeLogs(admissionId),
    });
  } catch (err) {
    console.error("GET /api/admissions/:id/forward-time-logs error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load forward timer history.",
    });
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
app.post("/api/admissions/:id/forward", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const admissionId = Number(req.params.id || 0);

    const rawTarget =
      req.body?.toType ??
      req.body?.toDepartment ??
      "";

    const returnFlag = String(
      req.body?.returnToSchool ?? ""
    )
      .trim()
      .toLowerCase();

    const wantsSchoolReturn =
      isSchoolReturnTarget(rawTarget) ||
      ["1", "true", "on", "yes"].includes(returnFlag);

    const isReturnToSchool =
      wantsSchoolReturn &&
      (
        user?.role === "super_admin" ||
        isAccountsUser(user)
      );

    const toType = isReturnToSchool
      ? "school_return"
      : normalizeForwardType(rawTarget);

    const toDepartment = isReturnToSchool
      ? "School Department"
      : forwardTypeToDepartmentLabel(toType);

    const requestedWorkflowStage = normalizeAccountsWorkflowStage(
      req.body?.workflowStage ??
      req.body?.accountsWorkflowStage ??
      req.body?.accounts_workflow_stage ??
      "new_admissions"
    );

    const nextAccountsWorkflowStage = isReturnToSchool
      ? getAccountsWorkflowStageFromRow({
          accounts_workflow_stage: req.body?.currentWorkflowStage || "new_admissions",
        })
      : (
          toType === "print_record_update" &&
          requestedWorkflowStage === "record_to_update"
            ? "record_to_update"
            : "new_admissions"
        );

    const issueMessage = String(
      req.body?.issueMessage ??
      req.body?.message ??
      req.body?.correctionMessage ??
      ""
    ).trim();

    const issueFields = normalizeIssueFields(
      req.body?.issueFields ??
      req.body?.incorrectFields ??
      []
    );

    const issueReturnRequested =
      isTruthyRequestFlag(req.body?.isIssueReturn) ||
      isTruthyRequestFlag(req.body?.withIssue) ||
      !!issueMessage ||
      issueFields.length > 0;

    if (!admissionId) {
      return res.status(400).json({
        success: false,
        message: "Invalid admission id",
      });
    }

    if (wantsSchoolReturn && !isReturnToSchool) {
      return res.status(403).json({
        success: false,
        message:
          "Only School Accounts users or Super Admin can return an admission to the School Department.",
      });
    }

    if (!toDepartment) {
      return res.status(400).json({
        success: false,
        message: "Please select a valid department.",
        allowedDepartments: [
          ...ADMISSION_FORWARD_DEPARTMENTS,
          "School Department",
        ],
      });
    }

    const row = getActiveAdmissionById(admissionId);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Admission not found",
      });
    }

    if (!canForwardAdmission(user, row)) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    if (
      issueReturnRequested &&
      !isReturnToSchool &&
      !issueMessage
    ) {
      return res.status(400).json({
        success: false,
        message: "Please write a message explaining the issue.",
      });
    }

    const currentReturnStatus = String(
      row.school_return_status || ""
    )
      .trim()
      .toLowerCase();

    if (
      !isReturnToSchool &&
      currentReturnStatus === "not_received" &&
      (
        user?.role === "super_admin" ||
        isSchoolDepartmentUser(user)
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please upload or re-upload the required file before forwarding this admission again.",
      });
    }

    if (
      !isReturnToSchool &&
      currentReturnStatus &&
      isAccountsUser(user)
    ) {
      return res.status(409).json({
        success: false,
        message:
          "This admission has already been returned to the School Department.",
      });
    }

    const latestUpload =
      getLatestUploadForAdmission(
        admissionId,
        user
      );

    if (
      user.role !== "super_admin" &&
      !isAccountsUser(user) &&
      !latestUpload
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please upload a file first. Forward button is allowed only after file upload.",
      });
    }

    if (
      !canCurrentUserUseForwardForRow(
        user,
        row,
        latestUpload
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "You are not allowed to forward this admission.",
      });
    }

    const selectedAccountsOwner = isReturnToSchool
      ? null
      : getSelectedAccountsForwardOwner(req.body || {}, toType);

    if (!isReturnToSchool && !selectedAccountsOwner) {
      return res.status(400).json({
        success: false,
        message:
          "Please select a valid Agent or Sub-Agent from the selected School Accounts pipeline.",
      });
    }

    const forwardOwner = isReturnToSchool
      ? getSchoolReturnOwnerForAdmission(row)
      : selectedAccountsOwner;

    const forwardSource = getForwardSourceForAdmission(row, user);

    if (
      isPaidSlipAgentOrSubAgent(user) &&
      issueReturnRequested &&
      toType !== "verification_registration"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Paid Slip issues must be returned to Verification & Registration.",
      });
    }

    if (
      nextAccountsWorkflowStage === "record_to_update" &&
      forwardSource.type !== "paid_slip"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Record to Update can only receive an admission from the Paid Slip pipeline.",
      });
    }

    const forwardedAt =
      new Date().toISOString();

    const isReuploadForward =
      !isReturnToSchool &&
      currentReturnStatus === "reupload" &&
      (
        user?.role === "super_admin" ||
        isSchoolDepartmentUser(user)
      );

    const nextSchoolReturnStatus =
      isReturnToSchool
        ? "not_received"
        : isReuploadForward
          ? ""
          : String(
              row.school_return_status || ""
            ).trim();

    const nextSchoolReturnedToUserId =
      isReturnToSchool
        ? (forwardOwner.id || null)
        : isReuploadForward
          ? null
          : (
              row.school_returned_to_user_id ||
              null
            );

    const nextSchoolReturnedAt =
      isReturnToSchool
        ? forwardedAt
        : isReuploadForward
          ? null
          : (
              row.school_returned_at ||
              null
            );

    const nextSchoolReuploadedAt =
      isReturnToSchool
        ? null
        : isReuploadForward
          ? null
          : (
              row.school_reuploaded_at ||
              null
            );

    const nextReuploadTagActive =
      isReuploadForward
        ? 1
        : Number(
            row.reupload_tag_active || 0
          ) === 1
          ? 1
          : 0;

    const nextWorkflowTag =
      getAdmissionWorkflowTag({
        ...row,

        school_return_status:
          nextSchoolReturnStatus,

        reupload_tag_active:
          nextReuploadTagActive,
      });

    const forwardTimerTargetMeta =
      getForwardTimerTargetMeta({
        isReturnToSchool,
        toDepartment,
        toType,
      });

    const savedIssueMessage = issueReturnRequested
      ? issueMessage
      : "";

    const savedIssueFields = issueReturnRequested
      ? JSON.stringify(issueFields)
      : "";

    db.prepare(`
      UPDATE admissions
      SET forward_status = 'forwarded',
          forwarded_to_department =
            @forwarded_to_department,
          forwarded_to_type =
            @forwarded_to_type,
          forwarded_at =
            @forwarded_at,

          forwarded_from_department =
            @forwarded_from_department,
          forwarded_from_type =
            @forwarded_from_type,
          accounts_workflow_stage =
            @accounts_workflow_stage,

          accounts_issue_message =
            @accounts_issue_message,
          accounts_issue_fields =
            @accounts_issue_fields,
          accounts_issue_by_id =
            @accounts_issue_by_id,
          accounts_issue_by_name =
            @accounts_issue_by_name,
          accounts_issue_by_role =
            @accounts_issue_by_role,
          accounts_issue_at =
            @accounts_issue_at,

          accounts_completed_at = NULL,
          accounts_completed_by_id = NULL,
          accounts_completed_by_name = '',
          accounts_completed_by_role = '',

          forwarded_by_id =
            @forwarded_by_id,
          forwarded_by_name =
            @forwarded_by_name,
          forwarded_by_role =
            @forwarded_by_role,

          forwarded_owner_user_id =
            @forwarded_owner_user_id,
          forwarded_owner_user_name =
            @forwarded_owner_user_name,
          forwarded_owner_user_role =
            @forwarded_owner_user_role,

          school_return_status =
            @school_return_status,
          school_returned_to_user_id =
            @school_returned_to_user_id,
          school_returned_at =
            @school_returned_at,
          school_reuploaded_at =
            @school_reuploaded_at,
          reupload_tag_active =
            @reupload_tag_active
      WHERE id = @id
        AND COALESCE(is_deleted, 0) = 0
    `).run({
      id: admissionId,

      forwarded_to_department:
        toDepartment,

      forwarded_to_type:
        toType,

      forwarded_at:
        forwardedAt,

      forwarded_from_department:
        forwardSource.department,

      forwarded_from_type:
        forwardSource.type,

      accounts_workflow_stage:
        nextAccountsWorkflowStage,

      accounts_issue_message:
        savedIssueMessage,

      accounts_issue_fields:
        savedIssueFields,

      accounts_issue_by_id:
        issueReturnRequested
          ? (user?.id || null)
          : null,

      accounts_issue_by_name:
        issueReturnRequested
          ? (user?.name || user?.email || "")
          : "",

      accounts_issue_by_role:
        issueReturnRequested
          ? (user?.role || "")
          : "",

      accounts_issue_at:
        issueReturnRequested
          ? forwardedAt
          : null,

      forwarded_by_id:
        user?.id || null,

      forwarded_by_name:
        user?.name ||
        user?.email ||
        "",

      forwarded_by_role:
        user?.role || "",

      forwarded_owner_user_id:
        forwardOwner.id || null,

      forwarded_owner_user_name:
        forwardOwner.name || "",

      forwarded_owner_user_role:
        forwardOwner.role || "",

      school_return_status:
        nextSchoolReturnStatus,

      school_returned_to_user_id:
        nextSchoolReturnedToUserId,

      school_returned_at:
        nextSchoolReturnedAt,

      school_reuploaded_at:
        nextSchoolReuploadedAt,

      reupload_tag_active:
        nextReuploadTagActive,
    });

    restartAdmissionForwardTimer({
      admissionId,
      holderUser: {
        id: forwardOwner.id || null,
        name: forwardOwner.name || "",
        role: forwardOwner.role || "",
      },
      holderDepartment:
        forwardTimerTargetMeta.holderDepartment,
      holderType:
        forwardTimerTargetMeta.holderType,
      startedAt:
        forwardedAt,
      endedByUser:
        user,
    });

    if (!isReturnToSchool) {
      rememberAccountsWorkflowUser(
        admissionId,
        selectedAccountsOwner,
        forwardedAt
      );

      if (isAccountsUser(user)) {
        rememberAccountsWorkflowUser(
          admissionId,
          user,
          forwardedAt
        );
      }
    }

    touchAdmissionActivity(admissionId);

    const currentForwardTimer =
      getAdmissionCurrentForwardTimer(admissionId);

    const forwardTimeLogs =
      getAdmissionPreviousForwardTimeLogs(admissionId);

    const eventType = isReturnToSchool
      ? "admission_returned_to_school"
      : issueReturnRequested
        ? "accounts_admission_returned_with_issue"
        : nextAccountsWorkflowStage === "record_to_update"
          ? "accounts_admission_forwarded_to_record_update"
          : isReuploadForward
            ? "admission_reforwarded_after_reupload"
            : "admission_forwarded";

    const forwardDisplayText =
      isReturnToSchool
        ? (
            forwardOwner.name
              ? `Returned by ${
                  user?.name ||
                  user?.email ||
                  "Unknown user"
                } to School Department for ${
                  forwardOwner.name
                }`
              : `Returned by ${
                  user?.name ||
                  user?.email ||
                  "Unknown user"
                } to School Department`
          )
        : (
            `Forwarded by ${
              user?.name ||
              user?.email ||
              "Unknown user"
            } from ${forwardSource.department} to ${toDepartment} for ${
              forwardOwner.name || "selected user"
            }`
          );

    logAudit(eventType, user, {
      targetUserId:
        forwardOwner.id || null,

      targetUserName:
        forwardOwner.name || "",

      dept:
        row.dept || "",

      details: {
        admissionId,

        studentName:
          row.student_name || "",

        processedBy:
          row.processed_by || "",

        forwardedFromDepartment:
          forwardSource.department,

        forwardedFromType:
          forwardSource.type,

        forwardedToDepartment:
          toDepartment,

        forwardedToType:
          toType,

        accountsWorkflowStage:
          nextAccountsWorkflowStage,

        issueMessage:
          savedIssueMessage,

        issueFields,

        forwardedById:
          user?.id || null,

        forwardedByName:
          user?.name ||
          user?.email ||
          "",

        forwardedByRole:
          user?.role || "",

        forwardedOwnerUserId:
          forwardOwner.id || null,

        forwardedOwnerUserName:
          forwardOwner.name || "",

        forwardedOwnerUserRole:
          forwardOwner.role || "",

        schoolReturnStatus:
          nextSchoolReturnStatus,

        schoolReturnedAt:
          nextSchoolReturnedAt,

        schoolReuploadedAt:
          nextSchoolReuploadedAt,

        reuploadTagActive:
          nextReuploadTagActive,

        workflowTag:
          nextWorkflowTag,

        displayText:
          forwardDisplayText,
      },
    });

    emitAdmissionChanged(req, {
      type: eventType,

      admissionId,

      dept:
        row.dept || "",

      forwardedFromDepartment:
        forwardSource.department,

      forwardedFromType:
        forwardSource.type,

      forwardedToDepartment:
        toDepartment,

      forwardedToType:
        toType,

      accountsWorkflowStage:
        nextAccountsWorkflowStage,

      issueMessage:
        savedIssueMessage,

      issueFields,

      forwardedById:
        user?.id || null,

      forwardedByName:
        user?.name ||
        user?.email ||
        "",

      forwardedOwnerUserId:
        forwardOwner.id || null,

      forwardedOwnerUserName:
        forwardOwner.name || "",

      schoolReturnStatus:
        nextSchoolReturnStatus,

      reuploadTagActive:
        nextReuploadTagActive,

      reupload_tag_active:
        nextReuploadTagActive,

      workflowTag:
        nextWorkflowTag,

      forwardSubStatus:
        isReturnToSchool
          ? "not_received"
          : getForwardSubStatus({
              ...row,
              school_return_status:
                nextSchoolReturnStatus,
            }),

      forwardTimer:
        currentForwardTimer,

      currentForwardTimer,

      forwardTimeLogs,
      forward_time_logs: forwardTimeLogs,
      timeLogs: forwardTimeLogs,
    });

    return res.json({
      success: true,

      message: isReturnToSchool
        ? "Admission returned to the School Department."
        : nextAccountsWorkflowStage === "record_to_update"
          ? "Admission forwarded to Record to Update."
          : issueReturnRequested
            ? `Admission returned to ${toDepartment} with issue details.`
            : `Admission forwarded to ${toDepartment}.`,

      admissionId,

      forwardStatus:
        "forwarded",

      forwardSubStatus:
        isReturnToSchool
          ? "not_received"
          : getForwardSubStatus({
              ...row,
              school_return_status:
                nextSchoolReturnStatus,
            }),

      forwardedFromDepartment:
        forwardSource.department,

      forwardedFromType:
        forwardSource.type,

      forwardedToDepartment:
        toDepartment,

      forwardedToType:
        toType,

      accountsWorkflowStage:
        nextAccountsWorkflowStage,

      issueMessage:
        savedIssueMessage,

      issueFields,

      forwardedById:
        user?.id || null,

      forwardedByName:
        user?.name ||
        user?.email ||
        "",

      forwardedByRole:
        user?.role || "",

      forwardedOwnerUserId:
        forwardOwner.id || null,

      forwardedOwnerUserName:
        forwardOwner.name || "",

      forwardedOwnerUserRole:
        forwardOwner.role || "",

      schoolReturnStatus:
        nextSchoolReturnStatus,

      schoolReturnedToUserId:
        nextSchoolReturnedToUserId,

      schoolReturnedAt:
        nextSchoolReturnedAt,

      schoolReuploadedAt:
        nextSchoolReuploadedAt,

      reuploadTagActive:
        nextReuploadTagActive,

      reupload_tag_active:
        nextReuploadTagActive,

      workflowTag:
        nextWorkflowTag,

      forwardTimer:
        currentForwardTimer,

      currentForwardTimer,

      forwardTimeLogs,
      forward_time_logs: forwardTimeLogs,
      timeLogs: forwardTimeLogs,

      forwardDisplayText,
    });
  } catch (err) {
    console.error(
      "POST /api/admissions/:id/forward error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "Could not forward admission",
    });
  }
});

// Return valid destination users for the existing forwarding modal.
app.get("/api/accounts/forward-users", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const toType = normalizeForwardType(
      req.query.toType || req.query.toDepartment || ""
    );

    if (!toType) {
      return res.status(400).json({
        success: false,
        message: "Invalid School Accounts pipeline.",
      });
    }

    if (
      user?.role !== "super_admin" &&
      !isSchoolDepartmentUser(user) &&
      !isAccountsUser(user)
    ) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    const rows = db.prepare(`
      SELECT id, name, email, role, dept, agentType, assigned_admin_id, managerId
      FROM users
      WHERE role IN ('agent', 'sub_agent')
      ORDER BY name ASC
    `).all();

    const users = rows
      .filter((item) => isAccountsUser(item))
      .filter(
        (item) =>
          normalizeAgentTypeForDept(
            item.agentType || "",
            item.dept || ""
          ) === toType
      )
      .map((item) => ({
        id: item.id,
        name: item.name || item.email || "",
        email: item.email || "",
        role: item.role || "",
        dept: item.dept || "",
        agentType: toType,
      }));

    return res.json({
      success: true,
      toType,
      toDepartment: forwardTypeToDepartmentLabel(toType),
      users,
    });
  } catch (err) {
    console.error("GET /api/accounts/forward-users error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load forwarding users.",
    });
  }
});

// Record to Update completion moves the admission to Old Admissions.
app.post(
  "/api/admissions/:id/accounts/complete-record-update",
  requireLogin,
  (req, res) => {
    try {
      const user = req.session.user;
      const admissionId = Number(req.params.id || 0);

      if (!admissionId) {
        return res.status(400).json({
          success: false,
          message: "Invalid admission id",
        });
      }

      const row = getActiveAdmissionById(admissionId);

      if (!row) {
        return res.status(404).json({
          success: false,
          message: "Admission not found",
        });
      }

      if (!canAccessAdmissionRow(user, row)) {
        return res.status(403).json({
          success: false,
          message: "Not allowed",
        });
      }

      const pipelineType = getAccountsPipelineTypeFromRow(row);
      const workflowStage = getAccountsWorkflowStageFromRow(row);

      if (
        pipelineType !== "print_record_update" ||
        workflowStage !== "record_to_update"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Only an admission in the Record to Update pipeline can be completed.",
        });
      }

      const allowedRole =
        user?.role === "super_admin" ||
        (
          isAccountsUser(user) &&
          ["admin", "agent", "sub_agent"].includes(user.role)
        );

      if (!allowedRole) {
        return res.status(403).json({
          success: false,
          message: "Not allowed",
        });
      }

      const completedAt = new Date().toISOString();

      db.prepare(`
        UPDATE admissions
        SET accounts_workflow_stage = 'old_admissions',
            accounts_completed_at = @accounts_completed_at,
            accounts_completed_by_id = @accounts_completed_by_id,
            accounts_completed_by_name = @accounts_completed_by_name,
            accounts_completed_by_role = @accounts_completed_by_role
        WHERE id = @id
          AND COALESCE(is_deleted, 0) = 0
      `).run({
        id: admissionId,
        accounts_completed_at: completedAt,
        accounts_completed_by_id: user?.id || null,
        accounts_completed_by_name: user?.name || user?.email || "",
        accounts_completed_by_role: user?.role || "",
      });

      finishAdmissionForwardTimer(
        admissionId,
        completedAt,
        user
      );

      touchAdmissionActivity(admissionId);

      const forwardTimeLogs =
        getAdmissionForwardTimeLogs(admissionId);

      logAudit("accounts_record_update_completed", user, {
        dept: row.dept || "",
        details: {
          admissionId,
          studentName: row.student_name || "",
          previousStage: workflowStage,
          newStage: "old_admissions",
          completedAt,
        },
      });

      emitAdmissionChanged(req, {
        type: "accounts_record_update_completed",
        admissionId,
        dept: row.dept || "",
        accountsWorkflowStage: "old_admissions",
        completedAt,
        forwardTimeLogs,
      });

      return res.json({
        success: true,
        message: "Record update completed. Admission moved to Old Admissions.",
        admissionId,
        accountsWorkflowStage: "old_admissions",
        completedAt,
        forwardTimeLogs,
      });
    } catch (err) {
      console.error(
        "POST /api/admissions/:id/accounts/complete-record-update error:",
        err
      );

      return res.status(500).json({
        success: false,
        message: "Could not complete Record Update.",
      });
    }
  }
);

// Simple JSON list (admissions.js table ke liye)
app.get("/api/admissions", requireLogin, (req, res) => {
  try {
    const user = req.session.user;

    const forwardStatus = String(
      req.query.forwardStatus || "all"
    )
      .trim()
      .toLowerCase();

    const forwardSubStatus = String(
      req.query.forwardSubStatus ||
      req.query.forwardView ||
      ""
    )
      .trim()
      .toLowerCase();

        const view = String(
      req.query.view || ""
    )
      .trim()
      .toLowerCase();

    const schoolTeamUserId =
      getRequestedSchoolTeamUserId(req.query);

    const accountsPipelineFilter = String(
      req.query.accountsPipeline ||
      req.query.pipelineType ||
      req.query.forwardedToType ||
      ""
    ).trim();

    const accountsSourceFilter = String(
      req.query.accountsSource ||
      req.query.sourceType ||
      req.query.forwardedFromType ||
      ""
    ).trim();

    const isAccountsOldView = [
      "old_admissions",
      "accounts_old_admissions",
    ].includes(view);

    const isAccountsNewView = [
      "new_admissions",
      "accounts_new_admissions",
    ].includes(view);

    const dateFilters = {
      registrationExact: String(
        req.query.registrationDateExact ||
        req.query.registration_date_exact ||
        ""
      ).trim(),

      registrationFrom: String(
        req.query.registrationDateFrom ||
        req.query.registration_date_from ||
        ""
      ).trim(),

      registrationTo: String(
        req.query.registrationDateTo ||
        req.query.registration_date_to ||
        ""
      ).trim(),

      assignedExact: String(
        req.query.assignedDateExact ||
        req.query.registrationAssignedDateExact ||
        req.query.assigned_date_exact ||
        ""
      ).trim(),

      assignedFrom: String(
        req.query.assignedDateFrom ||
        req.query.registrationAssignedDateFrom ||
        req.query.assigned_date_from ||
        ""
      ).trim(),

      assignedTo: String(
        req.query.assignedDateTo ||
        req.query.registrationAssignedDateTo ||
        req.query.assigned_date_to ||
        ""
      ).trim(),
    };

       let admissions = fetchAdmissionsForUser(user, {
      accountsView: isAccountsOldView
        ? "old_admissions"
        : "new_admissions",
      schoolTeamUserId,
    });

    if (isAccountsNewView || isAccountsOldView) {
      const requestedAccountsView = isAccountsOldView
        ? "old_admissions"
        : "new_admissions";

      admissions = admissions.filter(
        (admission) =>
          canSeeSchoolAccountsAdmission(
            user,
            admission,
            requestedAccountsView
          )
      );

      if (accountsPipelineFilter) {
        admissions = admissions.filter(
          (admission) =>
            matchesSchoolAccountsPipelineFilter(
              admission,
              accountsPipelineFilter
            )
        );
      }

      if (accountsSourceFilter) {
        admissions = admissions.filter(
          (admission) =>
            matchesSchoolAccountsSourceFilter(
              admission,
              accountsSourceFilter
            )
        );
      }
    }

    if (forwardStatus === "forwarded") {
      admissions = admissions.filter(
        (admission) => {
          const status = String(
            admission.forwardStatus || ""
          ).toLowerCase();

          const dept = String(
            admission.dept || ""
          )
            .trim()
            .toLowerCase();

          if (user?.role === "super_admin") {
            return (
              dept === "school" &&
              status === "forwarded"
            );
          }

          return (
            dept === "school" &&
            status === "forwarded" &&
            !!admission.forwardedByCurrentUser
          );
        }
      );
    }

       if (forwardStatus === "not_forwarded") {
      admissions = admissions.filter(
        (admission) => {
          const status = String(
            admission.forwardStatus ||
            "not_forwarded"
          )
            .trim()
            .toLowerCase();

          const dept = String(
            admission.dept || ""
          )
            .trim()
            .toLowerCase();

          if (dept !== "school") {
            return false;
          }

          if (status === "forwarded") {
            return false;
          }

          if (user?.role === "super_admin") {
            return true;
          }

          return admission.notForwardedVisibleForCurrentUser === true;
        }
      );
    }

    if (
      forwardSubStatus &&
      canUseSchoolForwardFilters(user)
    ) {
      const allowedSubStatuses = new Set([
        "not_verified",
        "verified",
        "not_received",
      ]);

      if (
        allowedSubStatuses.has(
          forwardSubStatus
        )
      ) {
        admissions = admissions.filter(
          (admission) =>
            String(
              admission.forwardStatus || ""
            )
              .trim()
              .toLowerCase() === "forwarded" &&
            String(
              admission.forwardSubStatus || ""
            )
              .trim()
              .toLowerCase() ===
                forwardSubStatus
        );
      }
    }

    admissions = admissions.filter(
      (admission) =>
        matchesWorkflowDateFilters(
          admission,
          dateFilters
        )
    );

    return res.json(admissions);
  } catch (err) {
    console.error(
      "GET /api/admissions error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "DB select failed",
    });
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

app.post("/api/bulk-challan/create", requireLogin, requireSendWhatsApp, (req, res) => {
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

    const whatsappWebhookUrl = getApiSetting(
      "N8N_WHATSAPP_WEBHOOK_URL",
      process.env.N8N_WHATSAPP_WEBHOOK_URL || ""
    );

    if (!monthKey || !cleanFeeType || !cleanClass || !cleanSection || !billingYear) {
      return res.status(400).json({
        success: false,
        message: "Please select month, fee type, class, section and year",
      });
    }

    if (!whatsappWebhookUrl) {
  return res.status(500).json({
    success: false,
    message: "N8N WhatsApp webhook missing in API Settings",
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

    const resp = await fetch(whatsappWebhookUrl, {
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
    getApiSetting(
      "APP_BASE_URL",
      process.env.APP_BASE_URL ||
        process.env.BASE_URL ||
        process.env.PUBLIC_BASE_URL ||
        ""
    ) ||
    `${req.protocol}://${req.get("host")}/`
  ).replace(/\/+$/, "/");
}
async function generateMonthlyChallanForApi({
  req,
  admissionId,
  monthKey,
  billingYear,
  labelPrefix = "API Fee Invoice",
}) {
  const row = getActiveAdmissionById(admissionId);
  if (!row) {
    throw new Error(`Admission not found for id ${admissionId}`);
  }

  const full = dbGetAdmissionDetailsById(admissionId, billingYear);
  if (!full) {
    throw new Error(`Admission details not found for id ${admissionId}`);
  }

  const cleanMonthKey = String(monthKey || "").trim().toLowerCase();

  const billArr = Array.isArray(full?.billing) ? full.billing : [];
  const monthRow = billArr.find(
    (b) =>
      String(b?.month || "").toLowerCase().trim() === cleanMonthKey
  );

  const monthStatus = String(monthRow?.status || "").trim().toLowerCase();

  if (monthStatus === "not admitted") {
    return {
      skipped: true,
      reason: "not_admitted_month",
      month: cleanMonthKey,
      year: billingYear,
    };
  }

  const bannerPath = path.join(__dirname, "public", "img", "ivs-banner.jpg");

  const fullWithRegistrationFee = attachRegistrationFeeToFullForMonth({
    full: attachPreviousSixMonthsToFull(full, cleanMonthKey),
    row,
    billingYear,
    monthKey: cleanMonthKey,
  });

  const pdfBuffer = await makeMonthlyChallanPdf({
    full: fullWithRegistrationFee,
    monthKey: cleanMonthKey,
    bannerPath,
  });

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error(`Invalid PDF buffer for invoice ${admissionId} month ${cleanMonthKey}`);
  }

  const head = pdfBuffer.subarray(0, 5).toString("utf8");
  if (head !== "%PDF-") {
    throw new Error(`Generated invoice is not a valid PDF for ${admissionId} month ${cleanMonthKey}`);
  }

  const { year, month } = getYearMonthParts(new Date());
  const challanDir = path.join(uploadsDir, "challans", year, month);
  if (!fs.existsSync(challanDir)) fs.mkdirSync(challanDir, { recursive: true });

  const filename = `api-fee-invoice-${admissionId}-${cleanMonthKey}-${Date.now()}.pdf`;
  const absPath = path.join(challanDir, filename);

  fs.writeFileSync(absPath, pdfBuffer);

  const relStored = toPosix(path.relative(uploadsDir, absPath));
  const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

  const info = insertUploadRecord({
  admissionId,
  originalName: `${labelPrefix} (${cleanMonthKey})`,
  storedName: relStored,
  fileUrl,
  mimeType: "application/pdf",
  size: pdfBuffer.length || 0,
  user: req.session.user,
});

  return {
    skipped: false,
    uploadId: info.lastInsertRowid,
    month: cleanMonthKey,
    year: billingYear,
    fileUrl,
    storedName: relStored,
    mimeType: "application/pdf",
    size: pdfBuffer.length || 0,
  };
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
const regFeePaid = Number(monthRow?.registrationFeeReceived || 0);

if ((!amt || amt <= 0) && (!regFeePaid || regFeePaid <= 0)) {
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
  const fileUrl = `${getBaseUrl(req)}/uploads/${relStored}`;

  const info = insertUploadRecord({
    admissionId,
    originalName: `${labelPrefix} (${monthKey})`,
    storedName: relStored,
    fileUrl,
    mimeType: "application/pdf",
    size: pdfBuffer.length || 0,
    user: req.session.user,
  });

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

        if (
      Object.prototype.hasOwnProperty.call(
        cleanUpdates,
        "admission_paid_invoice_status"
      )
    ) {
      cleanUpdates.admission_paid_invoice_status_timestamp =
        now;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        cleanUpdates,
        "accounts_registration_number"
      )
    ) {
      const duplicateRegistration =
        checkDuplicateRegistrationNumber(
          cleanUpdates.accounts_registration_number,
          row.id
        );

      if (duplicateRegistration) {
        return res.status(409).json({
          success: false,
          message:
            "This registration number is already in use. Please enter another number.",
        });
      }
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

    touchAdmissionActivity(row.id);

    const updatedRow = db
      .prepare(`
        SELECT *
        FROM admissions
        WHERE id = ?
      `)
      .get(row.id);

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

    if (user?.role !== "super_admin" && !perms.btnBilling && !perms.btnUpdateRow) {
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

    let optKey = makeOptionKey(cleanLabel);
if (!optKey) optKey = `bank_${Date.now()}`;

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

        // ✅ assigned access restriction
    if (!canAccessAdmissionRow(user, row)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const whatsappWebhookUrl = getApiSetting(
      "N8N_WHATSAPP_WEBHOOK_URL",
      process.env.N8N_WHATSAPP_WEBHOOK_URL || ""
    );

    if (!whatsappWebhookUrl) {
      return res.status(500).json({
        success: false,
        message: "N8N WhatsApp webhook missing in API Settings",
      });
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

    const resp = await fetch(whatsappWebhookUrl, {
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
// ==================== API SETTINGS ROUTES ====================

app.get("/api-settings", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const user = req.session.user;
    const settings = getAllApiSettings();

    return res.render("api-settings", {
      user,
      perms: getPerm(user),
      pageTitle: "API Settings",
      settings,
    });
  } catch (err) {
    console.error("GET /api-settings error:", err);
    return res.status(500).send("Server error");
  }
});

app.post("/api-settings/update", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const user = req.session.user;
    const body = req.body || {};

    const allowedKeys = [
  "APP_BASE_URL",
  "ADMISSIONS_API_KEY",
  "N8N_WHATSAPP_WEBHOOK_URL",
  "N8N_BILLING_WEBHOOK_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
];

    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updateApiSetting(key, body[key], user?.name || "Super Admin");
      }
    }

    logAudit("api_settings_updated", user, {
      details: {
        updatedKeys: allowedKeys.filter((key) =>
          Object.prototype.hasOwnProperty.call(body, key)
        ),
      },
    });

    req.session.flash = {
      type: "success",
      title: "API Settings Updated",
      message: "API settings have been updated successfully.",
    };

    return res.redirect("/api-settings");
  } catch (err) {
    console.error("POST /api-settings/update error:", err);

    req.session.flash = {
      type: "danger",
      title: "Update Failed",
      message: "API settings could not be updated.",
    };

    return res.redirect("/api-settings");
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
/* ==================== API SETTINGS ROUTES ==================== */

app.get("/api-settings", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const user = req.session.user;
    const settings = getAllApiSettings();

    return res.render("api-settings", {
      user,
      perms: getPerm(user),
      pageTitle: "API Settings",
      settings,
    });
  } catch (err) {
    console.error("GET /api-settings error:", err);
    return res.status(500).send("Server error");
  }
});

app.post("/api-settings/update", requireLogin, requireSuperAdmin, (req, res) => {
  try {
    const user = req.session.user;
    const body = req.body || {};

    const allowedKeys = [
      "APP_BASE_URL",
      "ADMISSIONS_API_KEY",
      "N8N_WHATSAPP_WEBHOOK_URL",
      "N8N_BILLING_WEBHOOK_URL",
    ];

    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updateApiSetting(key, body[key], user?.name || "Super Admin");
      }
    }

    logAudit("api_settings_updated", user, {
      details: {
        updatedKeys: allowedKeys.filter((key) =>
          Object.prototype.hasOwnProperty.call(body, key)
        ),
      },
    });

    req.session.flash = {
      type: "success",
      title: "API Settings Updated",
      message: "API settings have been updated successfully.",
    };

    return res.redirect("/api-settings");
  } catch (err) {
    console.error("POST /api-settings/update error:", err);

    req.session.flash = {
      type: "danger",
      title: "Update Failed",
      message: "API settings could not be updated.",
    };

    return res.redirect("/api-settings");
  }
});
/* ==================== DEVELOPER ROUTES ==================== */

app.post("/developer/login", async (req, res) => {
  try {
    const loginId = String(
      req.body.username ||
      req.body.email ||
      ""
    ).trim();

    const password = String(req.body.password || "");

    if (!loginId || !password) {
      return res.render("login", {
        error: null,
        devError: "Developer username/email and password are required.",
        type: null,
      });
    }

    const row = db.prepare(`
      SELECT *
      FROM developer_accounts
      WHERE (
        LOWER(TRIM(username)) = LOWER(TRIM(?))
        OR LOWER(TRIM(COALESCE(email, ''))) = LOWER(TRIM(?))
      )
      LIMIT 1
    `).get(loginId, loginId);

    if (!row || Number(row.is_active || 0) !== 1) {
      return res.render("login", {
        error: null,
        devError: "Invalid developer username/email or password.",
        type: null,
      });
    }

    const passwordOk = await bcrypt.compare(
      password,
      row.password_hash
    );

    if (!passwordOk) {
      return res.render("login", {
        error: null,
        devError: "Invalid developer username/email or password.",
        type: null,
      });
    }

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE developer_accounts
      SET last_login_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);

    const refreshedRow = db.prepare(`
      SELECT *
      FROM developer_accounts
      WHERE id = ?
      LIMIT 1
    `).get(row.id);

    const developer = mapDeveloperRow(refreshedRow || row);

    req.session.developer = developer;

    logDeveloperAction(req, "developer_login", {
      loginId,
    });

    return res.redirect("/developer/welcome");
  } catch (err) {
    console.error("POST /developer/login error:", err);

    return res.render("login", {
      error: null,
      devError: "Developer login failed. Please try again.",
      type: null,
    });
  }
});

app.get("/developer/welcome", requireDeveloperLogin, (req, res) => {
  return res.render("developer-welcome", {
    developer: req.developer,
    pageTitle: "Welcome Developer",
  });
});

app.get("/developer/dashboard", requireDeveloperLogin, (req, res) => {
  return res.render("developer-dashboard", {
    developer: req.developer,
    pageTitle: "Developer Dashboard",
  });
});

app.post("/developer/logout", requireDeveloperLogin, (req, res) => {
  logDeveloperAction(req, "developer_logout");

  delete req.session.developer;

  return res.redirect("/login");
});

app.get("/api/developer/stats", requireDeveloperLogin, (req, res) => {
  try {
    return res.json({
      success: true,
      stats: getDeveloperDashboardStats(),
    });
  } catch (err) {
    console.error("GET /api/developer/stats error:", err);

    return res.status(500).json({
      success: false,
      message: "Could not load developer stats.",
    });
  }
});

app.get("/api/developer/users", requireDeveloperLogin, (req, res) => {
  try {
    return res.json({
      success: true,
      users: getDeveloperUsersList(),
    });
  } catch (err) {
    console.error("GET /api/developer/users error:", err);

    return res.status(500).json({
      success: false,
      message: "Could not load users.",
    });
  }
});
app.post("/api/developer/users/create", requireDeveloperLogin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "agent").trim();
    const dept = String(req.body.dept || "school").trim().toLowerCase();
    const agentType = String(req.body.agentType || "").trim();
    const accessScope = String(req.body.access_scope || "own").trim();
    const assignedAdminId = Number(req.body.assigned_admin_id || req.body.managerId || 0) || null;

    const allowedRoles = ["super_admin", "admin", "agent", "sub_agent"];
    const allowedDepts = ["school", "quran", "tuition", "accounts", "school accounts", "school_accounts"];

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Name and email are required.",
      });
    }

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role selected.",
      });
    }

    if (!allowedDepts.includes(dept)) {
      return res.status(400).json({
        success: false,
        message: "Invalid department selected.",
      });
    }

    const duplicate = db.prepare(`
      SELECT id
      FROM users
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
      LIMIT 1
    `).get(email);

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "This email is already used by another user.",
      });
    }

    const temporaryPassword =
      String(req.body.password || "").trim() ||
      `IVS-${crypto.randomBytes(4).toString("hex")}`;

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    const permissions = getDeveloperPermissionsFromBody(req.body, role);

    const result = db.prepare(`
      INSERT INTO users
        (name, email, password_hash, role, dept, agentType, managerId, assigned_admin_id, created_by, access_scope, permissions)
      VALUES
        (@name, @email, @password_hash, @role, @dept, @agentType, @managerId, @assigned_admin_id, @created_by, @access_scope, @permissions)
    `).run({
      name,
      email,
      password_hash: passwordHash,
      role,
      dept,
      agentType: role === "agent" || role === "sub_agent"
        ? normalizeAgentTypeForDept(agentType, dept)
        : null,
      managerId: assignedAdminId,
      assigned_admin_id: assignedAdminId,
      created_by: null,
      access_scope: accessScope || getUserAccessScope({ role, dept }),
      permissions: JSON.stringify(permissions),
    });

    logDeveloperAction(req, "developer_user_created", {
      userId: result.lastInsertRowid,
      name,
      email,
      role,
      dept,
    });

    return res.json({
      success: true,
      message: "User created successfully.",
      userId: result.lastInsertRowid,
      email,
      temporaryPassword,
    });
  } catch (err) {
    console.error("POST /api/developer/users/create error:", err);

    return res.status(500).json({
      success: false,
      message: "User create failed.",
    });
  }
});

app.get("/api/developer/users/:id/permissions", requireDeveloperLogin, (req, res) => {
  try {
    const id = Number(req.params.id || 0);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id.",
      });
    }

    const row = db.prepare(`
      SELECT id, name, email, role, dept, permissions
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(id);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const permissions = normalizeDeveloperControlledPermissions(safeJsonParse(row.permissions) || {}, row.role);

    return res.json({
      success: true,
      user: {
        id: row.id,
        name: row.name || "",
        email: row.email || "",
        role: row.role || "",
        dept: row.dept || "",
        permissions,
      },
    });
  } catch (err) {
    console.error("GET /api/developer/users/:id/permissions error:", err);

    return res.status(500).json({
      success: false,
      message: "Could not load permissions.",
    });
  }
});

app.post("/api/developer/users/:id/permissions", requireDeveloperLogin, (req, res) => {
  try {
    const id = Number(req.params.id || 0);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id.",
      });
    }

    const existing = db.prepare(`
      SELECT id, name, email, role, dept
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(id);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    let permissions = getDeveloperPermissionsFromBody(req.body, existing.role);

    if (req.body.fullAccess === true || req.body.fullAccess === "true") {
  permissions = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true]));
  permissions = normalizeDeveloperControlledPermissions(permissions, existing.role);
}

    db.prepare(`
      UPDATE users
      SET
        permissions = @permissions,
        updatedAt = @updatedAt
      WHERE id = @id
    `).run({
      id,
      permissions: JSON.stringify(permissions),
      updatedAt: new Date().toISOString(),
    });

    logDeveloperAction(req, "developer_user_permissions_updated", {
      userId: id,
      userEmail: existing.email,
      enabledCount: Object.values(permissions).filter(Boolean).length,
    });

    try {
      const ioRef = req.app.get("io");
      if (ioRef) {
        ioRef.emit("user:permissions-updated", { userId: id, ts: Date.now() });
      }
    } catch {}

    return res.json({
      success: true,
      message: "Permissions updated successfully.",
      permissions,
    });
  } catch (err) {
    console.error("POST /api/developer/users/:id/permissions error:", err);

    return res.status(500).json({
      success: false,
      message: "Permissions update failed.",
    });
  }
});

app.get("/api/developer/database/export", requireDeveloperLogin, (req, res) => {
  try {
    const data = getDeveloperDatabaseExportPayload();
    const fileName = `developer-database-export-${Date.now()}.json`;

    logDeveloperAction(req, "developer_database_export", {
      tables: Object.keys(data.tables || {}),
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    return res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("GET /api/developer/database/export error:", err);

    return res.status(500).json({
      success: false,
      message: "Database export failed.",
    });
  }
});
app.post("/api/developer/users/:id/update", requireDeveloperLogin, (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id.",
      });
    }

    const existing = db.prepare(`
      SELECT *
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(id);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const name = String(req.body.name || existing.name || "").trim();
    const email = String(req.body.email || existing.email || "").trim().toLowerCase();
    const role = String(req.body.role || existing.role || "").trim();
    const dept = String(req.body.dept || existing.dept || "").trim().toLowerCase();
    const agentType = String(req.body.agentType || existing.agentType || "").trim();
    const accessScope = String(req.body.access_scope || existing.access_scope || "own").trim();

    if (!name || !email || !role) {
      return res.status(400).json({
        success: false,
        message: "Name, email and role are required.",
      });
    }

    const duplicateEmail = db.prepare(`
      SELECT id
      FROM users
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
        AND id != ?
      LIMIT 1
    `).get(email, id);

    if (duplicateEmail) {
      return res.status(409).json({
        success: false,
        message: "This email is already used by another user.",
      });
    }

    db.prepare(`
      UPDATE users
      SET
        name = @name,
        email = @email,
        role = @role,
        dept = @dept,
        agentType = @agentType,
        access_scope = @access_scope,
        updatedAt = @updatedAt
      WHERE id = @id
    `).run({
      id,
      name,
      email,
      role,
      dept,
      agentType: agentType || null,
      access_scope: accessScope || "own",
      updatedAt: new Date().toISOString(),
    });

    logDeveloperAction(req, "developer_user_updated", {
      userId: id,
      email,
      role,
      dept,
    });

    try {
      const ioRef = req.app.get("io");
      if (ioRef) {
        ioRef.emit("user:updated", { userId: id, ts: Date.now() });
      }
    } catch {}

    return res.json({
      success: true,
      message: "User updated successfully.",
    });
  } catch (err) {
    console.error("POST /api/developer/users/:id/update error:", err);

    return res.status(500).json({
      success: false,
      message: "User update failed.",
    });
  }
});

app.post("/api/developer/users/:id/reset-password", requireDeveloperLogin, async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id.",
      });
    }

    const userRow = db.prepare(`
      SELECT id, name, email
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(id);

    if (!userRow) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const temporaryPassword =
      String(req.body.password || "").trim() ||
      `IVS-${crypto.randomBytes(4).toString("hex")}`;

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    db.prepare(`
      UPDATE users
      SET
        password_hash = @password_hash,
        updatedAt = @updatedAt
      WHERE id = @id
    `).run({
      id,
      password_hash: passwordHash,
      updatedAt: new Date().toISOString(),
    });

    logDeveloperAction(req, "developer_user_password_reset", {
      userId: id,
      userEmail: userRow.email,
    });

    return res.json({
      success: true,
      message: "Password reset successfully.",
      email: userRow.email,
      temporaryPassword,
    });
  } catch (err) {
    console.error("POST /api/developer/users/:id/reset-password error:", err);

    return res.status(500).json({
      success: false,
      message: "Password reset failed.",
    });
  }
});

app.post("/api/developer/users/:id/delete", requireDeveloperLogin, (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id.",
      });
    }

    const userRow = db.prepare(`
      SELECT id, name, email, role, dept
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(id);

    if (!userRow) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    db.prepare(`
      DELETE FROM users
      WHERE id = ?
    `).run(id);

    logDeveloperAction(req, "developer_user_deleted", {
      userId: id,
      name: userRow.name,
      email: userRow.email,
      role: userRow.role,
      dept: userRow.dept,
    });

    try {
      const ioRef = req.app.get("io");
      if (ioRef) {
        ioRef.emit("user:deleted", { userId: id, ts: Date.now() });
      }
    } catch {}

    return res.json({
      success: true,
      message: "User deleted successfully.",
    });
  } catch (err) {
    console.error("POST /api/developer/users/:id/delete error:", err);

    return res.status(500).json({
      success: false,
      message: "User delete failed.",
    });
  }
});

app.get("/api/developer/api-settings", requireDeveloperLogin, (req, res) => {
  try {
    const allowedKeys = [
      "APP_BASE_URL",
      "ADMISSIONS_API_KEY",
      "N8N_WHATSAPP_WEBHOOK_URL",
      "N8N_BILLING_WEBHOOK_URL",
      "GEMINI_API_KEY",
      "GEMINI_MODEL",
    ];

    const fallbackValues = {
      APP_BASE_URL:
        process.env.APP_BASE_URL || "",

      ADMISSIONS_API_KEY:
        process.env.ADMISSIONS_API_KEY || "",

      N8N_WHATSAPP_WEBHOOK_URL:
        process.env.N8N_WHATSAPP_WEBHOOK_URL || "",

      N8N_BILLING_WEBHOOK_URL:
        process.env.N8N_BILLING_WEBHOOK_URL || "",

      GEMINI_API_KEY:
        process.env.GEMINI_API_KEY || "",

      GEMINI_MODEL:
        process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    };

    const settings = {};

    for (const key of allowedKeys) {
      const fallback = fallbackValues[key] || "";

      settings[key] = String(
        getApiSetting(key, fallback) || fallback
      ).trim();
    }

    return res.json({
      success: true,
      settings,
    });
  } catch (err) {
    console.error("GET /api/developer/api-settings error:", err);

    return res.status(500).json({
      success: false,
      message: "Could not load API settings.",
    });
  }
});

app.post(
  "/api/developer/api-settings/update",
  requireDeveloperLogin,
  (req, res) => {
    try {
      const body = req.body || {};

      const allowedKeys = [
        "APP_BASE_URL",
        "ADMISSIONS_API_KEY",
        "N8N_WHATSAPP_WEBHOOK_URL",
        "N8N_BILLING_WEBHOOK_URL",
        "GEMINI_API_KEY",
        "GEMINI_MODEL",
      ];

      const updatedKeys = [];

      for (const key of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          updateApiSetting(
            key,
            body[key],
            req.developer?.name || "Developer"
          );

          updatedKeys.push(key);
        }
      }

      logDeveloperAction(
        req,
        "developer_api_settings_updated",
        {
          updatedKeys,
        }
      );

      return res.json({
        success: true,
        message: "API settings updated successfully.",
        updatedKeys,
      });
    } catch (err) {
      console.error(
        "POST /api/developer/api-settings/update error:",
        err
      );

      return res.status(500).json({
        success: false,
        message: "API settings update failed.",
      });
    }
  }
);

// ================== DEVELOPER PROFILE SETTINGS ==================
// Public developer profile preview for login page robot card.
// Password/hash/security fields are never exposed here.
app.get("/api/public/developer-profile", (req, res) => {
  try {
    const row = db.prepare(`
      SELECT
        id,
        name,
        username,
        email,
        profile_image_url,
        is_active,
        created_at,
        updated_at,
        last_login_at
      FROM developer_accounts
      WHERE is_active = 1
      ORDER BY id ASC
      LIMIT 1
    `).get();

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Developer profile not found.",
      });
    }

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      profile: mapDeveloperRow(row),
    });
  } catch (err) {
    console.error("GET /api/public/developer-profile error:", err);

    return res.status(500).json({
      success: false,
      message: "Could not load Developer profile preview.",
    });
  }
});
app.get(
  "/api/developer/profile",
  requireDeveloperLogin,
  (req, res) => {
    try {
      const row = db.prepare(`
        SELECT
          id,
          name,
          username,
          email,
          profile_image_url,
          is_active,
          created_at,
          updated_at,
          last_login_at
        FROM developer_accounts
        WHERE id = ?
        LIMIT 1
      `).get(req.developer.id);

      if (!row) {
        return res.status(404).json({
          success: false,
          message: "Developer account not found.",
        });
      }

      return res.json({
        success: true,
        profile: mapDeveloperRow(row),
      });
    } catch (err) {
      console.error("GET /api/developer/profile error:", err);

      return res.status(500).json({
        success: false,
        message: "Could not load Developer profile.",
      });
    }
  }
);

app.post(
  "/api/developer/profile/update",
  requireDeveloperLogin,
  async (req, res) => {
    try {
      const developerId = Number(req.developer?.id || 0);
      const body = req.body || {};

      const name = String(body.name || "").trim();
      const username = String(body.username || "").trim();
      const email = String(body.email || "")
        .trim()
        .toLowerCase();

      const currentPassword = String(
        body.currentPassword || ""
      );

      const newPassword = String(
        body.newPassword || ""
      );

      const confirmPassword = String(
        body.confirmPassword || ""
      );

      if (!developerId) {
        return res.status(401).json({
          success: false,
          message: "Developer session is invalid.",
        });
      }

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Developer name is required.",
        });
      }

      if (!username || username.length < 3) {
        return res.status(400).json({
          success: false,
          message: "Username must contain at least 3 characters.",
        });
      }

      

      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!email || !emailPattern.test(email)) {
        return res.status(400).json({
          success: false,
          message: "Please enter a valid Developer email.",
        });
      }

      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          message: "Current password is required.",
        });
      }

      const existingRow = db.prepare(`
        SELECT *
        FROM developer_accounts
        WHERE id = ?
        LIMIT 1
      `).get(developerId);

      if (!existingRow) {
        return res.status(404).json({
          success: false,
          message: "Developer account not found.",
        });
      }

      const currentPasswordOk = await bcrypt.compare(
        currentPassword,
        existingRow.password_hash
      );

      if (!currentPasswordOk) {
        return res.status(400).json({
          success: false,
          message: "Current password is incorrect.",
        });
      }

      const usernameTaken = db.prepare(`
        SELECT id
        FROM developer_accounts
        WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
          AND id != ?
        LIMIT 1
      `).get(username, developerId);

      if (usernameTaken) {
        return res.status(409).json({
          success: false,
          message: "This Developer username is already in use.",
        });
      }

      const emailTaken = db.prepare(`
        SELECT id
        FROM developer_accounts
        WHERE LOWER(TRIM(COALESCE(email, ''))) = LOWER(TRIM(?))
          AND id != ?
        LIMIT 1
      `).get(email, developerId);

      if (emailTaken) {
        return res.status(409).json({
          success: false,
          message: "This Developer email is already in use.",
        });
      }

      const wantsPasswordChange =
        !!newPassword ||
        !!confirmPassword;

      if (
        wantsPasswordChange &&
        newPassword.length < 8
      ) {
        return res.status(400).json({
          success: false,
          message: "New password must contain at least 8 characters.",
        });
      }

      if (
        wantsPasswordChange &&
        newPassword !== confirmPassword
      ) {
        return res.status(400).json({
          success: false,
          message: "New password and confirmation do not match.",
        });
      }

      const passwordHash = wantsPasswordChange
        ? await bcrypt.hash(newPassword, 10)
        : existingRow.password_hash;

      const now = new Date().toISOString();

      db.prepare(`
        UPDATE developer_accounts
        SET name = ?,
            username = ?,
            email = ?,
            password_hash = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        name,
        username,
        email,
        passwordHash,
        now,
        developerId
      );

      const updatedRow = db.prepare(`
        SELECT *
        FROM developer_accounts
        WHERE id = ?
        LIMIT 1
      `).get(developerId);

      const updatedDeveloper = mapDeveloperRow(updatedRow);

      req.session.developer = updatedDeveloper;
      req.developer = updatedDeveloper;
      res.locals.developer = updatedDeveloper;

      logDeveloperAction(
        req,
        "developer_profile_updated",
        {
          nameChanged:
            String(existingRow.name || "") !== name,

          usernameChanged:
            String(existingRow.username || "") !== username,

          emailChanged:
            String(existingRow.email || "").toLowerCase() !== email,

          passwordChanged:
            wantsPasswordChange,
        }
      );

      return res.json({
        success: true,
        message: wantsPasswordChange
          ? "Developer profile and password updated successfully."
          : "Developer profile updated successfully.",
        profile: updatedDeveloper,
      });
    } catch (err) {
      console.error(
        "POST /api/developer/profile/update error:",
        err
      );

      return res.status(500).json({
        success: false,
        message: "Developer profile update failed.",
      });
    }
  }
);
app.post(
  "/api/developer/profile/image",
  requireDeveloperLogin,
  (req, res) => {
    developerProfileUpload.single("profileImage")(
      req,
      res,
      (uploadError) => {
        if (uploadError) {
          console.error(
            "Developer profile image upload validation error:",
            uploadError
          );

          const isSizeError =
            uploadError instanceof multer.MulterError &&
            uploadError.code === "LIMIT_FILE_SIZE";

          return res.status(400).json({
            success: false,
            message: isSizeError
              ? "Profile image must not be larger than 15 MB."
              : (
                  uploadError.message ||
                  "Profile image upload failed."
                ),
          });
        }

        const uploadedFile = req.file;

        if (!uploadedFile) {
          return res.status(400).json({
            success: false,
            message: "Please select a profile image.",
          });
        }

        let databaseUpdated = false;

        try {
          const developerId = Number(
            req.developer?.id || 0
          );

          if (!developerId) {
            safeUnlink(uploadedFile.path);

            return res.status(401).json({
              success: false,
              message: "Developer session is invalid.",
            });
          }

          const existingRow = db.prepare(`
            SELECT *
            FROM developer_accounts
            WHERE id = ?
              AND is_active = 1
            LIMIT 1
          `).get(developerId);

          if (!existingRow) {
            safeUnlink(uploadedFile.path);

            return res.status(404).json({
              success: false,
              message: "Developer account not found.",
            });
          }

          const relativeStoredPath = toPosix(
            path.relative(
              uploadsDir,
              uploadedFile.path
            )
          );

          const profileImageUrl =
            `/uploads/${relativeStoredPath}`;

          const now = new Date().toISOString();

          db.prepare(`
            UPDATE developer_accounts
            SET profile_image_url = ?,
                updated_at = ?
            WHERE id = ?
          `).run(
            profileImageUrl,
            now,
            developerId
          );

          databaseUpdated = true;

          const updatedRow = db.prepare(`
            SELECT *
            FROM developer_accounts
            WHERE id = ?
            LIMIT 1
          `).get(developerId);

          if (!updatedRow) {
            throw new Error(
              "Updated Developer account could not be loaded."
            );
          }

          const updatedDeveloper =
            mapDeveloperRow(updatedRow);

          req.session.developer =
            updatedDeveloper;

          req.developer =
            updatedDeveloper;

          res.locals.developer =
            updatedDeveloper;

          logDeveloperAction(
            req,
            "developer_profile_image_updated",
            {
              profileImageUrl,
              originalFileName:
                uploadedFile.originalname || "",
              mimeType:
                uploadedFile.mimetype || "",
              size:
                uploadedFile.size || 0,
            }
          );

          const oldImagePath =
            getDeveloperProfileImageAbsolutePath(
              existingRow.profile_image_url
            );

          if (
            oldImagePath &&
            path.resolve(oldImagePath) !==
              path.resolve(uploadedFile.path)
          ) {
            safeUnlink(oldImagePath);
          }

          return res.json({
            success: true,
            message:
              "Developer profile picture updated successfully.",
            profileImageUrl,
            profile: updatedDeveloper,
          });
        } catch (err) {
          console.error(
            "POST /api/developer/profile/image error:",
            err
          );

          // Database update fail ho to newly uploaded unused image remove karo.
          if (!databaseUpdated) {
            safeUnlink(uploadedFile.path);
          }

          return res.status(500).json({
            success: false,
            message:
              "Developer profile picture could not be updated.",
          });
        }
      }
    );
  }
);
app.post("/api/user-activity/heartbeat", requireLogin, (req, res) => {
  try {
    const user = req.session.user;
    const currentPage = String(req.body.currentPage || req.headers.referer || "").trim();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO user_activity
        (user_id, user_name, user_email, role, dept, current_page, ip_address, user_agent, last_seen)
      VALUES
        (@user_id, @user_name, @user_email, @role, @dept, @current_page, @ip_address, @user_agent, @last_seen)
      ON CONFLICT(user_id) DO UPDATE SET
        user_name = excluded.user_name,
        user_email = excluded.user_email,
        role = excluded.role,
        dept = excluded.dept,
        current_page = excluded.current_page,
        ip_address = excluded.ip_address,
        user_agent = excluded.user_agent,
        last_seen = excluded.last_seen
    `).run({
      user_id: user.id,
      user_name: user.name || "",
      user_email: user.email || "",
      role: user.role || "",
      dept: user.dept || "",
      current_page: currentPage,
      ip_address: getClientIp(req),
      user_agent: String(req.headers["user-agent"] || ""),
      last_seen: now,
    });

    db.prepare(`
      INSERT INTO usage_events
        (user_id, user_name, user_email, role, dept, page_url, event_type, ip_address, user_agent, created_at)
      VALUES
        (@user_id, @user_name, @user_email, @role, @dept, @page_url, @event_type, @ip_address, @user_agent, @created_at)
    `).run({
      user_id: user.id,
      user_name: user.name || "",
      user_email: user.email || "",
      role: user.role || "",
      dept: user.dept || "",
      page_url: currentPage,
      event_type: "heartbeat",
      ip_address: getClientIp(req),
      user_agent: String(req.headers["user-agent"] || ""),
      created_at: now,
    });

    return res.json({
      success: true,
    });
  } catch (err) {
    console.error("POST /api/user-activity/heartbeat error:", err);

    return res.status(500).json({
      success: false,
      message: "Heartbeat failed.",
    });
  }
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
  perms,
  viewerUser: user,
});

  const superAccessibleAdmissions =
    fetchAdmissionsForUser(user);

  const schoolForwardCounts =
    buildSchoolForwardCountsFromAdmissions(
      superAccessibleAdmissions
    );

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
        accountsPipelineCounts: buildSchoolAccountsPipelineCounts(user),
    schoolForwardCounts,
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

        const schoolTeamUserFilters =
    isSchoolDeptAdmin(user)
      ? buildSchoolAdminTeamUserFilters(user)
      : [];

  const requestedSchoolTeamUserId =
    getRequestedSchoolTeamUserId(req.query);

  const selectedSchoolTeamUser =
    requestedSchoolTeamUserId
      ? schoolTeamUserFilters.find(
          (row) =>
            Number(row.id || 0) ===
            requestedSchoolTeamUserId
        ) || null
      : null;

  const selectedSchoolTeamUserId =
    selectedSchoolTeamUser?.id || 0;

  const accessibleAdmissions = fetchAdmissionsForUser(user, {
    schoolTeamUserId: selectedSchoolTeamUserId,
  });

  const totalRecords = accessibleAdmissions.length;
  const totalPages = Math.max(Math.ceil(totalRecords / limit), 1);
  const offset = (page - 1) * limit;

  const deptAdmissionsPage = {
    rows: accessibleAdmissions.slice(offset, offset + limit),
    page,
    limit,
    totalRecords,
    totalPages,
    startRecord: totalRecords === 0 ? 0 : offset + 1,
    endRecord: totalRecords === 0 ? 0 : Math.min(offset + limit, totalRecords),
  };

    const accountsPipelineCounts =
    buildSchoolAccountsPipelineCounts(user);

  const schoolForwardCounts =
    buildSchoolForwardCountsFromAdmissions(accessibleAdmissions);

if (user.role === "admin") {
  return res.render("dashboard-admin", {
    user,
    perms: null,
    viewerUser: user,
    admissions: deptAdmissionsPage.rows,
    statusOptionsCurrent,
    statusOptionsFee,
    currencyOptions: getCurrencyOptions(),
    bankOptions: getBankOptions(),
        classOptions,
        accountsPipelineCounts,
    schoolForwardCounts,
    schoolTeamUserFilters,
    selectedSchoolTeamUserId,
    selectedSchoolTeamUser,
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
    perms: null,
    viewerUser: user,
    admissions: deptAdmissionsPage.rows,
    statusOptionsCurrent,
    statusOptionsFee,
    currencyOptions: getCurrencyOptions(),
    bankOptions: getBankOptions(),
        classOptions,
        accountsPipelineCounts,
    schoolForwardCounts,
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
    perms: null,
    viewerUser: user,
    admissions: deptAdmissionsPage.rows,
    statusOptionsCurrent,
    statusOptionsFee,
    currencyOptions: getCurrencyOptions(),
    bankOptions: getBankOptions(),
        classOptions,
        accountsPipelineCounts,
    schoolForwardCounts,
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
  if (roleFilter === "agent") roleSql = "AND u.role = 'agent'";
  else if (roleFilter === "sub_agent") roleSql = "AND u.role = 'sub_agent'";
  else roleSql = "AND u.role IN ('agent','sub_agent')"; // all

 const rows = db.prepare(`
  SELECT
    u.*,

    assigned.name AS assignedAdminName,
    assigned.email AS assignedAdminEmail,
    assigned.dept AS assignedAdminDept,

    creator.name AS createdByName,
    creator.email AS createdByEmail,
    creator.role AS createdByRole
  FROM users u
  LEFT JOIN users assigned
    ON assigned.id = COALESCE(u.assigned_admin_id, u.managerId)
  LEFT JOIN users creator
    ON creator.id = u.created_by
  WHERE u.dept = ?
    AND (
      u.assigned_admin_id = ?
      OR u.managerId = ?
    )
    ${roleSql}
  ORDER BY u.id DESC
`).all(user.dept, user.id, user.id);

  const deptUsers = rows.map((row) => {
    const u = mapUserRow(row);

    if (!u.access_scope) {
      if (u.role === "super_admin") u.access_scope = "all";
      else if (String(u.dept || "").toLowerCase() === "accounts") u.access_scope = "all";
      else if (u.role === "admin") u.access_scope = "team";
      else u.access_scope = "own";
    }

    return u;
  });

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

  const row = db.prepare(`
  SELECT
    u.*,

    assigned.name AS assignedAdminName,
    assigned.email AS assignedAdminEmail,
    assigned.dept AS assignedAdminDept,

    creator.name AS createdByName,
    creator.email AS createdByEmail,
    creator.role AS createdByRole
  FROM users u
  LEFT JOIN users assigned
    ON assigned.id = COALESCE(u.assigned_admin_id, u.managerId)
  LEFT JOIN users creator
    ON creator.id = u.created_by
  WHERE u.id = ?
  LIMIT 1
`).get(id);
  if (!row) return res.status(404).send("User not found");

  // ✅ Admin can edit only same dept + only agent/sub_agent
  if (!current.dept || row.dept !== current.dept) {
    return res.status(403).send("Not allowed");
  }
  if (!(row.role === "agent" || row.role === "sub_agent")) {
    return res.status(403).send("Not allowed");
  }
  if (!isUserAssignedToAdmin(row, current)) {
    return res.status(403).send("Not allowed");
  }
  const editUser = mapUserRow(row);

  // ✅ normalize child perms so missing keys become false
  editUser.permissions = getPerm(editUser);
  if (!editUser.access_scope) {
  if (editUser.role === "super_admin") editUser.access_scope = "all";
  else if (String(editUser.dept || "").toLowerCase() === "accounts") editUser.access_scope = "all";
  else if (editUser.role === "admin") editUser.access_scope = "team";
  else editUser.access_scope = "own";
}

  return res.render("admin-user-edit", {
  user: current,
  perms: getPerm(current),
  editUser,
  error: null,
  basePath: "/dashboard/admin",
  admissionFormBaseUrl: getAdmissionFormBaseUrl(),
  pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(row),
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

  const row = db.prepare(`
    SELECT
      u.*,

      assigned.name AS assignedAdminName,
      assigned.email AS assignedAdminEmail,
      assigned.dept AS assignedAdminDept,

      creator.name AS createdByName,
      creator.email AS createdByEmail,
      creator.role AS createdByRole
    FROM users u
    LEFT JOIN users assigned
      ON assigned.id = COALESCE(u.assigned_admin_id, u.managerId)
    LEFT JOIN users creator
      ON creator.id = u.created_by
    WHERE u.id = ?
    LIMIT 1
  `).get(id);

  if (!row) return res.status(404).send("User not found");

  const renderAdminEditError = (errorMessage) => {
    const editUser = mapUserRow(row);
    editUser.permissions = getPerm(editUser);

    if (!editUser.access_scope) {
      if (editUser.role === "super_admin") editUser.access_scope = "all";
      else if (String(editUser.dept || "").toLowerCase() === "accounts") editUser.access_scope = "all";
      else if (editUser.role === "admin") editUser.access_scope = "team";
      else editUser.access_scope = "own";
    }

    return res.render("admin-user-edit", {
      user: current,
      perms: getPerm(current),
      editUser,
      error: errorMessage,
      basePath: "/dashboard/admin",
      admissionFormBaseUrl: getAdmissionFormBaseUrl(),
      pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(row),
    });
  };

  // ✅ Admin can edit only same dept + only agent/sub_agent
  if (!current.dept || row.dept !== current.dept) {
    return res.status(403).send("Not allowed");
  }
  if (!(row.role === "agent" || row.role === "sub_agent")) {
    return res.status(403).send("Not allowed");
  }

  if (!isUserAssignedToAdmin(row, current)) {
    return res.status(403).send("Not allowed");
  }

  const { name, email, agentType } = req.body || {};

  if (!name || !email) {
    return renderAdminEditError("Name and email are required.");
  }

  const safeAgentType = normalizeAgentTypeForDept(
    agentType,
    row?.dept || current?.dept || ""
  );

  const pipelineTransferRequirement =
    shouldRequireAccountsPipelineTransfer({
      existingRow: row,
      nextRole: row.role,
      nextDept: row.dept,
      nextAgentType: safeAgentType || "",
    });

  let pendingPipelineTransfer = null;

  if (pipelineTransferRequirement.required) {
    const transferableCount =
      getAccountsPipelineTransferCountForUser(
        row,
        pipelineTransferRequirement.oldPipelineType
      );

    if (transferableCount > 0) {
      const pipelineTransferTargetUserId =
        Number(
          req.body.pipelineTransferTargetUserId ||
          req.body.accountsPipelineTransferTargetUserId ||
          req.body.transferTargetUserId ||
          0
        ) || 0;

      const pipelineTransferTargetUser =
        getAccountsPipelineTransferTargetUser({
          targetUserId: pipelineTransferTargetUserId,
          sourceUserId: id,
          pipelineType: pipelineTransferRequirement.oldPipelineType,
        });

      if (!pipelineTransferTargetUser) {
        return renderAdminEditError(
          `This user has ${transferableCount} assigned admissions in ${pipelineTransferRequirement.oldPipelineLabel}. Please select another ${pipelineTransferRequirement.oldPipelineLabel} Agent/Sub-Agent to receive these admissions before changing the pipeline type.`
        );
      }

      pendingPipelineTransfer = {
        count: transferableCount,
        pipelineType: pipelineTransferRequirement.oldPipelineType,
        pipelineLabel: pipelineTransferRequirement.oldPipelineLabel,
        targetUser: pipelineTransferTargetUser,
      };
    }
  }

  // ✅ IMPORTANT: admin can only grant permissions that admin has
  const parentPerms = getPerm(current);

  const newPerms = {};
  for (const key of PERMISSION_KEYS) {
    newPerms[key] = parentPerms[key] ? isOn(req.body[key]) : false;
  }

  const beforeUserForAudit = { ...row };

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

  let pipelineTransferResult = null;

  if (pendingPipelineTransfer) {
    pipelineTransferResult =
      transferAccountsPipelineAdmissionsForUserChange({
        sourceUserRow: row,
        targetUserRow: pendingPipelineTransfer.targetUser,
        pipelineType: pendingPipelineTransfer.pipelineType,
        actorUser: current,
      });

    if (pipelineTransferResult?.admissionIds?.length) {
      emitAdmissionChanged(req, {
        type: "accounts_pipeline_transfer",
        dept: "school",
        admissionId: pipelineTransferResult.admissionIds[0],
        insertedIds: pipelineTransferResult.admissionIds,
      });
    }
  }

  // socket notify
  try {
    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("user:updated", { userId: id, ts: Date.now() });
  } catch (e) {}

  const afterUserForAudit = {
    ...row,

    name: String(name || "").trim(),

    email: String(email || "").trim(),

    agentType: safeAgentType || null,

    permissions: newPerms,
  };

  const changes = buildUserAuditChanges(
    beforeUserForAudit,
    afterUserForAudit
  );

  if (changes.length) {
    logAudit("user_updated_by_admin", current, {
      targetUserId: id,
      targetUserName: afterUserForAudit.name,
      dept: row.dept,
      details: {
        changes,
      },
    });
  }

  req.session.flash = {
    type: "success",
    title: "User updated",
    message:
      pipelineTransferResult?.count > 0
        ? `User "${name}" has been updated successfully. ${pipelineTransferResult.count} admissions transferred to ${pendingPipelineTransfer.targetUser.name}.`
        : `User "${name}" has been updated successfully.`,
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
  if (!isUserAssignedToAdmin(row, current)) {
    return res.status(403).send("Not allowed");
  }
  // ✅ delete
    db.prepare(`
    DELETE FROM users
    WHERE id = ?
      AND dept = ?
      AND role IN ('agent', 'sub_agent')
      AND (
        assigned_admin_id = ?
        OR managerId = ?
      )
  `).run(id, current.dept, current.id, current.id);

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
    colComment: readBoolPerm(parentPermRaw, "colComment", false),
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
app.post(
  "/dashboard/super/files/delete-all",
  requireLogin,
  requireSuperAdmin,
  requireViewFiles,
  requireDeleteFiles,
  (req, res) => {
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
app.post("/dashboard/agent/agents", requireLogin, (req, res, next) => {
  req.url = "/dashboard/admin/agents";
  next();
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
    const allowedAgentTypes = getAllowedAgentTypesForDept(dept || user?.dept || "");
let agentType = String(req.body.agentType || "").trim();

if (user.role === "agent") {
  agentType = user.agentType || "";
}

agentType = normalizeAgentTypeForDept(agentType, dept || user?.dept || "");

    const parentPerms = getPerm(user);

    const finalPerms = {};
    for (const key of PERMISSION_KEYS) {
      finalPerms[key] = parentPerms[key] ? isOn(req.body[key]) : false;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const info = db.prepare(`
           INSERT INTO users
        (name, email, password_hash, role, dept, agentType, managerId, assigned_admin_id, created_by, access_scope, permissions, updateNoticeUnread, updatedAt)
      VALUES
        (@name, @email, @password_hash, @role, @dept, @agentType, @managerId, @assigned_admin_id, @created_by, @access_scope, @permissions, 0, CURRENT_TIMESTAMP)
    `).run({
      name,
      email,
      password_hash: passwordHash,
      role: newRole,
      dept: dept || null,
      agentType: agentType || null,
           managerId: user.id,
            assigned_admin_id: user.role === "admin" ? user.id : (user.assigned_admin_id || user.managerId || null),
      created_by: user.id,
      access_scope: "own",
      permissions: JSON.stringify(finalPerms),
    });

    logAudit(
      user.role === "agent"
        ? "user_created_by_agent"
        : "user_created_by_admin",
      user,
      {
        targetUserId: info.lastInsertRowid,
        targetUserName: name,
        dept,
        details: {
          action: "User created",
          role: newRole,
          dept,
          agentType: agentType || "",
        },
      }
    );

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

            // ✅ assigned access restriction
      if (admissionId) {
        const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(admissionId);
        if (!row) return res.status(404).json({ success: false, message: "Admission not found" });

        if (!canAccessAdmissionRow(user, row)) {
          return res.status(403).json({ success: false, message: "Not allowed" });
        }
      }
    const relPath = toPosix(path.relative(uploadsDir, f.path));
    const fileUrl = `${getBaseUrl(req).replace(/\/$/, "")}/uploads/${relPath}`;

insertUploadRecord({
  admissionId,
  originalName: f.originalname,
  storedName: relPath,
  fileUrl,
  mimeType: f.mimetype,
  size: f.size || 0,
  user,
});

const changedToReupload =
  markSchoolReturnReuploaded(
    admissionId,
    user
  );

emitAdmissionChanged(req, {
  type: changedToReupload
    ? "school_return_reuploaded"
    : "upload_added",
  admissionId,
  dept: user?.dept || "",
});


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
        SELECT *
    FROM admissions
    WHERE id = ?
      AND COALESCE(is_deleted, 0) = 0
  `).get(admissionId);

  if (!baseAdmission) return res.status(404).send("Admission not found");

if (!canAccessAdmissionRow(user, baseAdmission)) {
    return res.status(403).send("Not allowed");
  }

  familyNumber = String(baseAdmission.accounts_family_number || "").trim();

if (familyNumber) {
  familyAdmissionIds = getAccessibleFamilyIds(user, familyNumber).map((r) => r.id);
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
  files = db.prepare(`
    SELECT
      u.*,
      a.id AS linked_admission_id,
      a.student_name AS student_name,
      a.accounts_family_number AS family_number,
      a.dept,
      a.processed_by
    FROM uploads u
    LEFT JOIN admissions a ON a.id = u.admission_id
    WHERE a.id IS NOT NULL
      AND COALESCE(a.is_deleted, 0) = 0
    ORDER BY u.id DESC
  `).all();

  if (user?.role !== "super_admin") {
    files = files.filter((f) => {
      const admissionAccessRow = getActiveAdmissionById(
        f.linked_admission_id || f.admission_id
      );

      return !!admissionAccessRow && canAccessAdmissionRow(
        user,
        admissionAccessRow
      );
    });
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
app.delete(
  "/admin/files/:id",
  requireLogin,
  requireViewFiles,
  requireDeleteFiles,
  (req, res) => {
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
        const adm = db.prepare("SELECT * FROM admissions WHERE id = ?").get(fileRow.admission_id);
    if (!adm) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    if (!canAccessAdmissionRow(user, adm)) {
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

app.post(
  "/dashboard/super/files/link",
  requireLogin,
  requireSuperAdmin,
  requirePerm("btnUpload"),
  (req, res) => {
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

    const adm = db.prepare("SELECT * FROM admissions WHERE id = ?").get(admissionId);
    if (!adm) return res.status(404).json({ success:false, message:"Admission not found" });

    const actor = getUploadActor(user);

db.prepare(`
  INSERT INTO uploads (
    admission_id,
    original_name,
    stored_name,
    file_url,
    mime_type,
    size,
    uploaded_by_id,
    uploaded_by_name,
    uploaded_by_role,
    uploaded_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  admissionId,
  cleanName,
  cleanSummary,
  cleanLink,
  "text/url",
  0,
  actor.uploadedById,
  actor.uploadedByName,
  actor.uploadedByRole,
  actor.uploadedAt
);

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
const adm = db.prepare("SELECT * FROM admissions WHERE id = ?").get(admissionId);
    if (!adm) return res.status(404).json({ success: false, message: "Admission not found" });

    // ✅ dept check for non-super
if (!canAccessAdmissionRow(user, adm)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }
    const { year, month } = getYearMonthParts();
const groupedSummary = `[${year}-${month}] ${cleanSummary || ""}`.trim();

const actor = getUploadActor(user);

db.prepare(`
  INSERT INTO uploads (
    admission_id,
    original_name,
    stored_name,
    file_url,
    mime_type,
    size,
    uploaded_by_id,
    uploaded_by_name,
    uploaded_by_role,
    uploaded_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  admissionId,
  cleanName,
  groupedSummary,
  cleanLink,
  "text/url",
  0,
  actor.uploadedById,
  actor.uploadedByName,
  actor.uploadedByRole,
  actor.uploadedAt
);


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
    const adm = db.prepare("SELECT * FROM admissions WHERE id = ?").get(row.admission_id);
    if (!adm) {
      return res.status(404).json({ success: false, message: "Admission not found" });
    }

    // ✅ assigned access check
    if (!canAccessAdmissionRow(user, adm)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
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
  requirePerm("btnUpload"),
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
  requirePerm("btnUpload"),
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
     const fileUrl = `/uploads/${relPath}`;

insertUploadRecord({
  admissionId,
  originalName: f.originalname,
  storedName: relPath,
  fileUrl,
  mimeType: f.mimetype,
  size: f.size || 0,
  user: req.session.user,
});

const changedToReupload =
  markSchoolReturnReuploaded(
    admissionId,
    req.session.user
  );

emitAdmissionChanged(req, {
  type: changedToReupload
    ? "school_return_reuploaded"
    : "upload_added",
  admissionId,
  dept: req.session.user?.dept || "",
});
      return res.json({ success: true, message: "Uploaded" });
    } catch (err) {
      console.error("upload error:", err);
      return res.status(500).json({ success: false, message: "Upload failed" });
    }
  }
);

app.get(
  "/dashboard/super/files",
  requireLogin,
  requireSuperAdmin,
  requireViewFiles,
  (req, res) => {
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
app.delete(
  "/dashboard/super/files/:id",
  requireLogin,
  requireSuperAdmin,
  requireViewFiles,
  requireDeleteFiles,
  (req, res) => {
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

 const rows = db.prepare(`
  SELECT
    u.*,

    assigned.name AS assignedAdminName,
    assigned.email AS assignedAdminEmail,
    assigned.dept AS assignedAdminDept,

    creator.name AS createdByName,
    creator.email AS createdByEmail,
    creator.role AS createdByRole
  FROM users u
  LEFT JOIN users assigned
    ON assigned.id = COALESCE(u.assigned_admin_id, u.managerId)
  LEFT JOIN users creator
    ON creator.id = u.created_by
  ORDER BY u.id ASC
`).all();

const allUsers = rows.map((row) => {
  const u = mapUserRow(row);

  if (!u.access_scope) {
    if (u.role === "super_admin") u.access_scope = "all";
    else if (String(u.dept || "").toLowerCase() === "accounts") u.access_scope = "all";
    else if (u.role === "admin") u.access_scope = "team";
    else u.access_scope = "own";
  }

  return u;
});

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
  users: filteredUsers.map(attachAdmissionLinkToUser),
  roleFilter,
  counts,
  admissionFormBaseUrl: getAdmissionFormBaseUrl(),
  makeProcessedByAdmissionLink,
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
  assignableAdmins: getAssignableAdmins(),
  admissionFormBaseUrl: getAdmissionFormBaseUrl(),
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
  assignableAdmins: getAssignableAdmins(),
  user: current,
  error: "Name, email, password, role are required.",
  admissionFormBaseUrl: getAdmissionFormBaseUrl(),
});
  }

  const allowedRoles = ["admin", "agent", "sub_agent"];
  if (!allowedRoles.includes(role)) {
    return res.render("super-user-form", {
  assignableAdmins: getAssignableAdmins(),
  user: current,
  error: "Role must be Admin, Agent, or Sub Agent.",
  admissionFormBaseUrl: getAdmissionFormBaseUrl(),
});
  }

const allowedDepts = ["quran", "tuition", "school", "accounts", "school_accounts"];
const safeDept = allowedDepts.includes(dept) ? dept : null;
const allowedAgentTypes = getAllowedAgentTypesForDept(safeDept);
const isPipelineRole = role === "sub_agent" || role === "agent";

  const passwordHash = await bcrypt.hash(password, 10);
    let assignedAdminId = null;

  if (isPipelineRole) {
    const rawAssignedAdminId = Number(req.body.assignedAdminId || req.body.assigned_admin_id || 0);

    if (rawAssignedAdminId) {
      const assignedAdmin = db.prepare(`
        SELECT id, dept
        FROM users
        WHERE id = ?
          AND role = 'admin'
        LIMIT 1
      `).get(rawAssignedAdminId);

      if (!assignedAdmin) {
        return res.render("super-user-form", {
  user: current,
  error: "Selected assigned admin is not valid.",
  assignableAdmins: getAssignableAdmins(),
  admissionFormBaseUrl: getAdmissionFormBaseUrl(),
});
      }

      assignedAdminId = assignedAdmin.id;
    }
  }
  if (isPipelineRole && !assignedAdminId) {
    return res.render("super-user-form", {
  user: current,
  error: "Please select an Assigned Admin for Agent/Sub Agent.",
  assignableAdmins: getAssignableAdmins(),
  admissionFormBaseUrl: getAdmissionFormBaseUrl(),
});
  }
  const safeAccessScope =
  role === "admin"
    ? (isSchoolAccountsDeptValue(safeDept) ? "all" : "team")
    : "own";

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
  colBank: isOn(req.body.colBank),
  colMonth: isOn(req.body.colMonth),
  colTotalFees: isOn(req.body.colTotalFees),
  colPendingDues: isOn(req.body.colPendingDues),
  colReceivedPayment: isOn(req.body.colReceivedPayment),
  colComment: isOn(req.body.colComment),
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
       (name, email, password_hash, role, dept, agentType, managerId, assigned_admin_id, created_by, access_scope, permissions)
       VALUES (@name, @email, @password_hash, @role, @dept, @agentType, @managerId, @assigned_admin_id, @created_by, @access_scope, @permissions)
    `
    )
    .run({
      name,
      email,
      password_hash: passwordHash,
      role,
      dept: safeDept,
     agentType: isPipelineRole
  ? normalizeAgentTypeForDept(agentType, safeDept)
  : null,
      managerId: assignedAdminId || current.id,
      assigned_admin_id: assignedAdminId,
      created_by: current.id,
      access_scope: safeAccessScope,
      permissions: JSON.stringify(permissions),
        });

  logAudit("user_created", current, {
    targetUserId: result.lastInsertRowid,
    targetUserName: name,
    dept: allowedDepts.includes(dept) ? dept : null,
    details: {
      action: "User created",
      role,
      dept: safeDept || "",
      agentType: isPipelineRole
        ? normalizeAgentTypeForDept(agentType, safeDept)
        : "",
    },
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
    assignableAdmins: getAssignableAdmins(),
    admissionFormBaseUrl: getAdmissionFormBaseUrl(),
    pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(row),
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
        editUser.permissions = getPerm(editUser);

    return res.render("super-user-edit", {
      user: current,
      editUser,
      error: "Name, email and role are required.",
      assignableAdmins: getAssignableAdmins(),
      admissionFormBaseUrl: getAdmissionFormBaseUrl(),
      pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(existingRow),
    });
  }

  const allowedRoles = ["admin", "agent", "sub_agent"];
  if (!allowedRoles.includes(role)) {
    const editUser = mapUserRow(existingRow);
        editUser.permissions = getPerm(editUser);

    return res.render("super-user-edit", {
      user: current,
      editUser,
      error: "Role must be Admin, Agent, or Sub Agent.",
      assignableAdmins: getAssignableAdmins(),
      admissionFormBaseUrl: getAdmissionFormBaseUrl(),
      pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(existingRow),
    });
  }

   const allowedDepts = ["quran", "tuition", "school", "accounts", "school_accounts"];
const safeDept = allowedDepts.includes(dept) ? dept : null;
const allowedAgentTypes = getAllowedAgentTypesForDept(safeDept);
  const isPipelineRole = role === "agent" || role === "sub_agent";

  let passwordHash = existingRow.password_hash;
  if (password && password.trim() !== "") {
    passwordHash = await bcrypt.hash(password.trim(), 10);
  }
  let assignedAdminId = null;

  if (isPipelineRole) {
    const rawAssignedAdminId = Number(req.body.assignedAdminId || req.body.assigned_admin_id || 0);

    if (rawAssignedAdminId) {
      const assignedAdmin = db.prepare(`
        SELECT id
        FROM users
        WHERE id = ?
          AND role = 'admin'
        LIMIT 1
      `).get(rawAssignedAdminId);

      if (!assignedAdmin) {
        const editUser = mapUserRow(existingRow);
        editUser.permissions = getPerm(editUser);

        return res.render("super-user-edit", {
          user: current,
          editUser,
          error: "Selected assigned admin is not valid.",
          assignableAdmins: getAssignableAdmins(),
          admissionFormBaseUrl: getAdmissionFormBaseUrl(),
          pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(existingRow),
        });
      }

      assignedAdminId = assignedAdmin.id;
    }

    if (!assignedAdminId) {
      const editUser = mapUserRow(existingRow);
      editUser.permissions = getPerm(editUser);

      return res.render("super-user-edit", {
        user: current,
        editUser,
        error: "Please select an Assigned Admin for Agent/Sub Agent.",
        assignableAdmins: getAssignableAdmins(),
        admissionFormBaseUrl: getAdmissionFormBaseUrl(),
        pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(existingRow),
      });
    }
  }

  const nextAgentTypeForSave = isPipelineRole
    ? normalizeAgentTypeForDept(agentType, safeDept)
    : null;

  const pipelineTransferRequirement =
    shouldRequireAccountsPipelineTransfer({
      existingRow,
      nextRole: role,
      nextDept: safeDept,
      nextAgentType: nextAgentTypeForSave || "",
    });

  let pendingPipelineTransfer = null;

  if (pipelineTransferRequirement.required) {
    const transferableCount =
      getAccountsPipelineTransferCountForUser(
        existingRow,
        pipelineTransferRequirement.oldPipelineType
      );

    if (transferableCount > 0) {
      const pipelineTransferTargetUserId =
        Number(
          req.body.pipelineTransferTargetUserId ||
          req.body.accountsPipelineTransferTargetUserId ||
          req.body.transferTargetUserId ||
          0
        ) || 0;

      const pipelineTransferTargetUser =
        getAccountsPipelineTransferTargetUser({
          targetUserId: pipelineTransferTargetUserId,
          sourceUserId: id,
          pipelineType: pipelineTransferRequirement.oldPipelineType,
        });

      if (!pipelineTransferTargetUser) {
        const editUser = mapUserRow(existingRow);
        editUser.permissions = getPerm(editUser);

        return res.render("super-user-edit", {
          user: current,
          editUser,
          error:
            `This user has ${transferableCount} assigned admissions in ${pipelineTransferRequirement.oldPipelineLabel}. Please select another ${pipelineTransferRequirement.oldPipelineLabel} Agent/Sub-Agent to receive these admissions before changing the pipeline type.`,
          assignableAdmins: getAssignableAdmins(),
          admissionFormBaseUrl: getAdmissionFormBaseUrl(),
          pipelineTransferInfo: buildAccountsPipelineTransferInfoForUser(existingRow),
        });
      }

      pendingPipelineTransfer = {
        count: transferableCount,
        pipelineType: pipelineTransferRequirement.oldPipelineType,
        pipelineLabel: pipelineTransferRequirement.oldPipelineLabel,
        targetUser: pipelineTransferTargetUser,
      };
    }
  }

  const safeAccessScope =
    role === "admin"
      ? (isSchoolAccountsDeptValue(safeDept) ? "all" : "team")
      : "own";
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
  colBank: isOn(req.body.colBank),
  colMonth: isOn(req.body.colMonth),
    colTotalFees: isOn(req.body.colTotalFees),
  colPendingDues: isOn(req.body.colPendingDues),
  colReceivedPayment: isOn(req.body.colReceivedPayment),
  colComment: isOn(req.body.colComment),
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


  const beforeUserForAudit = { ...existingRow };

  db.prepare(`
    UPDATE users
     SET name=@name,
         email=@email,
         password_hash=@password_hash,
         role=@role,
         dept=@dept,
         agentType=@agentType,
         permissions=@permissions,
                managerId=@managerId,
       assigned_admin_id=@assigned_admin_id,
       access_scope=@access_scope,
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
    dept: safeDept,
    agentType: nextAgentTypeForSave,
    permissions: JSON.stringify(permissions),
        managerId: assignedAdminId || existingRow.managerId || current.id,
    assigned_admin_id: assignedAdminId,
    access_scope: safeAccessScope,
    lastUpdatedBy: current.name,
    lastUpdatedByRole: current.role,
    lastUpdatedAt: new Date().toISOString(),
  });

  let pipelineTransferResult = null;

  if (pendingPipelineTransfer) {
    pipelineTransferResult =
      transferAccountsPipelineAdmissionsForUserChange({
        sourceUserRow: existingRow,
        targetUserRow: pendingPipelineTransfer.targetUser,
        pipelineType: pendingPipelineTransfer.pipelineType,
        actorUser: current,
      });

    if (pipelineTransferResult?.admissionIds?.length) {
      emitAdmissionChanged(req, {
        type: "accounts_pipeline_transfer",
        dept: "school",
        admissionId: pipelineTransferResult.admissionIds[0],
        insertedIds: pipelineTransferResult.admissionIds,
      });
    }
  }
   try {
  const ioRef = req.app.get("io");
  if (ioRef) {
    ioRef.emit("user:updated", { userId: id, ts: Date.now() });
  }
} catch (e) {}

  const afterUserForAudit = {
    ...existingRow,

    name: String(name || "").trim(),

        email: String(email || "").trim(),

    role,

    dept: safeDept,

    agentType: nextAgentTypeForSave,

    managerId:
      assignedAdminId ||
      existingRow.managerId ||
      current.id,

    assigned_admin_id: assignedAdminId,

    access_scope: safeAccessScope,

    permissions,
  };

  const changes = buildUserAuditChanges(
    beforeUserForAudit,
    afterUserForAudit,
    {
      passwordChanged: !!(
        password &&
        password.trim()
      ),
    }
  );

  if (changes.length) {
    logAudit("user_updated", current, {
      targetUserId: id,
      targetUserName: afterUserForAudit.name,
      dept: afterUserForAudit.dept,
      details: {
        changes,
      },
    });
  }

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

  const {
    dept = "",
    role = "",
    eventType = "",
    q = "",
    from = "",
    to = "",
  } = req.query;

  const cleanDept = String(dept || "").trim();
  const cleanRole = String(role || "").trim();
  const cleanEventType = String(eventType || "").trim();
  const cleanQuery = String(q || "").trim();

  const rawFrom = String(from || "").trim();
  const rawTo = String(to || "").trim();

  // Sirf valid YYYY-MM-DD date ko SQL filter mein use karein.
  const cleanFrom = /^\d{4}-\d{2}-\d{2}$/.test(rawFrom)
    ? rawFrom
    : "";

  const cleanTo = /^\d{4}-\d{2}-\d{2}$/.test(rawTo)
    ? rawTo
    : "";

  const where = [];
  const params = {};

  if (cleanDept) {
    where.push("a.dept = @dept");
    params.dept = cleanDept;
  }

  if (cleanRole) {
    where.push("a.actorRole = @role");
    params.role = cleanRole;
  }

  if (cleanEventType) {
    where.push("a.eventType = @eventType");
    params.eventType = cleanEventType;
  }

  if (cleanQuery) {
    where.push(`
      (
        a.actorName LIKE @q
        OR a.actorDept LIKE @q
        OR a.targetUserName LIKE @q
        OR a.eventType LIKE @q
        OR a.dept LIKE @q
        OR a.details LIKE @q
        OR CAST(a.id AS TEXT) LIKE @q
        OR CAST(a.targetUserId AS TEXT) LIKE @q
      )
    `);

    params.q = `%${cleanQuery}%`;
  }

  // From date bhi results mein include hogi.
  if (cleanFrom) {
    where.push("date(a.createdAt) >= date(@from)");
    params.from = cleanFrom;
  }

  // To date bhi poore din ke saath results mein include hogi.
  if (cleanTo) {
    where.push("date(a.createdAt) <= date(@to)");
    params.to = cleanTo;
  }

  const whereSql = where.length
    ? `WHERE ${where.join(" AND ")}`
    : "";

  const logs = db
    .prepare(`
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
    `)
    .all(params);

  const depts = db
    .prepare(`
      SELECT DISTINCT dept
      FROM audit_logs
      WHERE dept IS NOT NULL
        AND TRIM(dept) <> ''
      ORDER BY dept
    `)
    .all()
    .map((row) => row.dept);

  const roles = db
    .prepare(`
      SELECT DISTINCT actorRole
      FROM audit_logs
      WHERE actorRole IS NOT NULL
        AND TRIM(actorRole) <> ''
      ORDER BY actorRole
    `)
    .all()
    .map((row) => row.actorRole);

  const events = db
    .prepare(`
      SELECT DISTINCT eventType
      FROM audit_logs
      WHERE eventType IS NOT NULL
        AND TRIM(eventType) <> ''
      ORDER BY eventType
    `)
    .all()
    .map((row) => row.eventType);

  return res.render("super-history", {
    user: current,
    logs,
    pageTitle: "System Activity History",

    filters: {
      dept: cleanDept,
      role: cleanRole,
      eventType: cleanEventType,
      q: cleanQuery,
      from: cleanFrom,
      to: cleanTo,
    },

    filterMeta: {
      depts,
      roles,
      events,
    },
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
        q: req.query.q || "",
    processedBy: req.query.processedBy || "all",
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

  const perms = getPerm(user);

const deptAdmissionsPage = fetchAdmissionsPage({
  dept,
  page,
  limit,
  perms,
  viewerUser: user,
});

const superDeptAccessibleAdmissions =
  dept === "school"
    ? fetchAdmissionsForDept("school", user)
    : [];

const schoolForwardCounts =
  buildSchoolForwardCountsFromAdmissions(
    superDeptAccessibleAdmissions
  );

const accountsPipelineCounts =
  buildSchoolAccountsPipelineCounts(user);

  const rows = db.prepare("SELECT * FROM users ORDER BY id ASC").all();
  const allUsers = rows.map((row) => {
  const u = mapUserRow(row);

  if (!u.access_scope) {
    if (u.role === "super_admin") u.access_scope = "all";
    else if (u.dept === "accounts") u.access_scope = "all";
    else if (u.role === "admin") u.access_scope = "team";
    else u.access_scope = "own";
  }

  return u;
});

 return res.render("dashboard-super", {
  user,
  users: allUsers,
  perms,
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
  accountsPipelineCounts,
  schoolForwardCounts,
});
});

// -------- SUPER ADMIN: FULL PIPELINE UPDATE (DB) --------
app.post("/super/update/:id", requireLogin, handleSuperFullUpdate);
app.post("/dashboard/super/update/:id", requireLogin, handleSuperFullUpdate);

// -------- Admin full pipeline update (DB) --------
app.post("/admin/update/:id", requireLogin, (req, res) => {
  const user = req.session.user;
const perms = getPerm(user);

if (!user) {
  return res.status(403).send("Not allowed");
}

if (user.role !== "admin" && user.role !== "agent" && user.role !== "sub_agent") {
  return res.status(403).send("Not allowed");
}

if (user.role !== "admin" && !perms.btnUpdateRow) {
  return res.status(403).send("Not allowed");
}

  const id = parseInt(req.params.id, 10);
  const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(id);

    if (!row || !canAccessAdmissionRow(user, row)) {
    return res.status(404).send("Not found");
  }

  const beforeRowForAudit = { ...row };

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
    currency,
    bank,
    bank_name,
    bankName,
    comment,
    admission_comment,
    admissionComment,
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
const resolvedBankName = pickBankName(req.body, row.bank_name || "");

if (resolvedBankName) {
  const allowedBank = db
    .prepare("SELECT id FROM bank_options WHERE label = ?")
    .get(resolvedBankName);

  if (!allowedBank) {
    return res.status(400).json({
      success: false,
      message: "Invalid bank selected"
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
// ✅ Sirf jab Month/Year column update ho tab previous months Not admitted karo
const incomingAdmissionMonth =
  typeof month !== "undefined" && month !== null
    ? String(month || "").trim()
    : "";

const oldAdmissionMonth = String(row.admission_month || "").trim();

const canChangeAdmissionMonth =
  user?.role === "super_admin" ||
  (typeof perms !== "undefined" && perms?.colMonth) ||
  (typeof canAccounts !== "undefined" && canAccounts) ||
  (typeof canAdmissions !== "undefined" && canAdmissions);

const monthColumnChanged =
  canChangeAdmissionMonth &&
  incomingAdmissionMonth &&
  incomingAdmissionMonth !== oldAdmissionMonth;

let updatedBillingJson = billingJson;

if (monthColumnChanged) {
  const selectedBillingYear = getBillingYearFromAdmissionMonthValue(
    incomingAdmissionMonth,
    getBillingYearFromReq(req)
  );

  const notAdmittedResult = applyNotAdmittedBeforeAdmissionMonth({
    admissionId: id,
    billingJson,
    admissionMonthValue: incomingAdmissionMonth,
    billingYear: selectedBillingYear,
  });

  updatedBillingJson = notAdmittedResult.billingJson;
}

const dues = calcPendingDues(baseFee, updatedBillingJson, feeHistory);

const paidUptoAfterAdmissionMonth = computePaidUptoFromBillingJson(updatedBillingJson);
const receivedPaymentAfterAdmissionMonth = computeReceivedPaymentFromBillingJson(updatedBillingJson);

const billingStringsAfterAdmissionMonth = {};
for (const m of BILLING_MONTHS) {
  billingStringsAfterAdmissionMonth[m.key] = toMonthString(updatedBillingJson[m.key]);
}

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
bank_name: perms.colBank
  ? resolvedBankName
  : (row.bank_name || ""),
admission_comment:
  canAccounts || perms.colComment
    ? (
        typeof comment !== "undefined" && comment !== null
          ? String(comment).trim()
          : typeof admission_comment !== "undefined" && admission_comment !== null
            ? String(admission_comment).trim()
            : typeof admissionComment !== "undefined" && admissionComment !== null
              ? String(admissionComment).trim()
              : row.admission_comment || ""
      )
    : row.admission_comment || "",
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
          admission_total_paid: String(receivedPaymentAfterAdmissionMonth || 0),
    accounts_paid_upto: paidUptoAfterAdmissionMonth || "",
    billing_json: JSON.stringify(updatedBillingJson),
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
         bank_name = @bank_name,
         admission_comment = @admission_comment,
         admission_month = @admission_month,
         fee_history = @fee_history,
         monthly_fee_current = @monthly_fee_current,
         admission_total_fees = @admission_total_fees,
         admission_pending_dues = @admission_pending_dues,
         admission_total_paid = @admission_total_paid,
         billing_json = @billing_json,
         january = @january,
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
         december = @december
         WHERE id = @id
  `).run({
    id,
    ...updated,
    ...billingStringsAfterAdmissionMonth,
  });

   const afterRow =
    getActiveAdmissionById(id) ||
    { ...row, ...updated };

  const after =
    buildPipelineSnapshotFromRow(afterRow);

  const changes = buildAdmissionAuditChanges(
    beforeRowForAudit,
    afterRow
  );

  if (changes.length) {
    const permanentEntryNumber =
      afterRow.entry_number ||
      row.entry_number ||
      id;

    const studentName = String(
      afterRow.student_name ||
      row.student_name ||
      ""
    ).trim();

    logAudit("pipeline_admin_update", user, {
      targetUserId: permanentEntryNumber,
      targetUserName:
        studentName ||
        `Admission ${permanentEntryNumber}`,

      dept: afterRow.dept || row.dept,

      details: {
        databaseAdmissionId: id,
        entryNumber: permanentEntryNumber,
        studentName,
        changes,
      },
    });
  }
  touchAdmissionActivity(id);
  // ✅ NEW: Real-time notify all dashboards
  emitAdmissionChanged(req, { type: "admin_update", admissionId: id, dept: row.dept });

if (
  req.xhr ||
  req.get("X-Requested-With") === "XMLHttpRequest" ||
  String(req.headers.accept || "").includes("application/json")
) {
  return res.json({
    success: true,
    message: "Admission updated successfully.",
    admissionId: id,
    updatedFields: after,
  });
}

return res.redirect("/dashboard");
});

app.post("/pipeline/update/:id", requireLogin, requirePerm("btnUpdateRow"), (req, res) => {
  const user = req.session.user;

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).send("Invalid id");

  const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(id);
  if (!row) return res.status(404).send("Not found");
  const beforeRowForAudit = { ...row };

  // ✅ dept restriction for non-super
  if (user?.role !== "super_admin") {
    if (!canAccessAdmissionRow(user, row)) return res.status(403).send("Not allowed");
  }

  // ✅ Only update fields that are allowed columns
  const perms = getPerm(user);

  const {
  status, feeStatus, dept, student, father, father_email, grade, tuitionGrade, phone,
  paymentStatus, paidUpto, verificationNumber, registrationNumber,
  familyNumber, registrationFee, fees, month, currencyCode, currency_code, currency,
  bank, bank_name, bankName, comment, admission_comment, admissionComment
} = req.body;
  
    const cleanRegistrationNumber = String(registrationNumber || "").trim();
  const duplicateReg = checkDuplicateRegistrationNumber(cleanRegistrationNumber, id);

if (duplicateReg) {
  return res.status(409).json({
    success: false,
    message: "This registration number is already in use. Please enter another number."
  });
}

const resolvedBankName = perms.colBank
  ? pickBankName(req.body, row.bank_name || "")
  : (row.bank_name || "");

if (perms.colBank && resolvedBankName) {
  const allowedBank = db
    .prepare("SELECT id FROM bank_options WHERE label = ?")
    .get(resolvedBankName);

  if (!allowedBank) {
    return res.status(400).json({
      success: false,
      message: "Invalid bank selected"
    });
  }
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
// ✅ Sirf jab Month/Year column update ho tab previous months Not admitted karo
const incomingAdmissionMonth =
  typeof month !== "undefined" && month !== null
    ? String(month || "").trim()
    : "";

const oldAdmissionMonth = String(row.admission_month || "").trim();

const canChangeAdmissionMonth =
  user?.role === "super_admin" ||
  (typeof perms !== "undefined" && perms?.colMonth) ||
  (typeof canAccounts !== "undefined" && canAccounts) ||
  (typeof canAdmissions !== "undefined" && canAdmissions);

const monthColumnChanged =
  canChangeAdmissionMonth &&
  incomingAdmissionMonth &&
  incomingAdmissionMonth !== oldAdmissionMonth;

let updatedBillingJson = billingJson;

if (monthColumnChanged) {
  const selectedBillingYear = getBillingYearFromAdmissionMonthValue(
    incomingAdmissionMonth,
    getBillingYearFromReq(req)
  );

  const notAdmittedResult = applyNotAdmittedBeforeAdmissionMonth({
    admissionId: id,
    billingJson,
    admissionMonthValue: incomingAdmissionMonth,
    billingYear: selectedBillingYear,
  });

  updatedBillingJson = notAdmittedResult.billingJson;
}

const dues = calcPendingDues(baseFee, updatedBillingJson, feeHistory);

const paidUptoAfterAdmissionMonth = computePaidUptoFromBillingJson(updatedBillingJson);
const receivedPaymentAfterAdmissionMonth = computeReceivedPaymentFromBillingJson(updatedBillingJson);

const billingStringsAfterAdmissionMonth = {};
for (const m of BILLING_MONTHS) {
  billingStringsAfterAdmissionMonth[m.key] = toMonthString(updatedBillingJson[m.key]);
}
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
    accounts_registration_number:
      perms.colRegistrationNumber
        ? (
            typeof registrationNumber !== "undefined" &&
            registrationNumber !== null
              ? cleanRegistrationNumber
              : row.accounts_registration_number
          )
        : row.accounts_registration_number,
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
bank_name: perms.colBank
  ? resolvedBankName
  : (row.bank_name || ""),
admission_comment: perms.colComment
  ? (
      typeof comment !== "undefined" && comment !== null
        ? String(comment).trim()
        : typeof admission_comment !== "undefined" && admission_comment !== null
          ? String(admission_comment).trim()
          : typeof admissionComment !== "undefined" && admissionComment !== null
            ? String(admissionComment).trim()
            : row.admission_comment || ""
    )
  : row.admission_comment || "",
admission_month: perms.colMonth ? (month ?? row.admission_month) : row.admission_month,
    fee_history: JSON.stringify(feeHistory),
    monthly_fee_current: incomingFeeNumber > 0 ? incomingFeeNumber : (dues.currentFee || baseFee || 0),
    
    admission_total_fees: String(dues.expected || 0),
   admission_pending_dues: String(dues.pending || 0),
       admission_total_paid: String(receivedPaymentAfterAdmissionMonth || 0),
    accounts_paid_upto: paidUptoAfterAdmissionMonth || "",
    billing_json: JSON.stringify(updatedBillingJson),
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
           bank_name=@bank_name,
           admission_comment=@admission_comment,
           admission_month=@admission_month,
           fee_history=@fee_history,
           monthly_fee_current=@monthly_fee_current,
           
           admission_total_fees=@admission_total_fees,
           admission_pending_dues = @admission_pending_dues,
         admission_total_paid = @admission_total_paid,
         billing_json = @billing_json,
         january = @january,
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
         december = @december
     WHERE id=@id
  `).run({
    id,
    ...updated,
    ...billingStringsAfterAdmissionMonth,
  });
  const afterRow =
    getActiveAdmissionById(id) ||
    { ...row, ...updated };

const after =
  buildPipelineSnapshotFromRow(afterRow);

const changes = buildAdmissionAuditChanges(
  beforeRowForAudit,
  afterRow
);

const eventType =
  user?.role === "sub_agent"
    ? "pipeline_sub_agent_update"
    : "pipeline_agent_update";

if (changes.length) {
  const permanentEntryNumber =
    afterRow.entry_number ||
    row.entry_number ||
    id;

  const studentName = String(
    afterRow.student_name ||
    row.student_name ||
    ""
  ).trim();

  logAudit(eventType, user, {
    targetUserId: permanentEntryNumber,
    targetUserName:
      studentName ||
      `Admission ${permanentEntryNumber}`,

    dept: afterRow.dept || row.dept,

    details: {
      databaseAdmissionId: id,
      entryNumber: permanentEntryNumber,
      studentName,
      changes,
    },
  });
}

  touchAdmissionActivity(id);
  emitAdmissionChanged(req, { type: "pipeline_update", admissionId: id, dept: row.dept });

if (
  req.xhr ||
  req.get("X-Requested-With") === "XMLHttpRequest" ||
  String(req.headers.accept || "").includes("application/json")
) {
  return res.json({
    success: true,
    message: "Admission updated successfully.",
    admissionId: id,
    updatedFields: after,
  });
}

return res.redirect("/dashboard");
});
app.post("/uploads", requireLogin, requirePerm("btnUpload"), upload.single("file"), (req, res) => {
  try {
    const user = req.session.user;
    const f = req.file;

    const admissionId = req.body.admission_id ? parseInt(req.body.admission_id, 10) : null;
    if (!f) return res.status(400).json({ success: false, message: "No file received" });

        // ✅ assigned access restriction
    if (admissionId) {
      const row = db.prepare("SELECT * FROM admissions WHERE id = ?").get(admissionId);
      if (!row) return res.status(404).json({ success: false, message: "Admission not found" });

      if (!canAccessAdmissionRow(user, row)) {
        return res.status(403).json({ success: false, message: "Not allowed" });
      }
    }

   const relPath = toPosix(path.relative(uploadsDir, f.path));
   const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${relPath}`;

  insertUploadRecord({
  admissionId,
  originalName: f.originalname,
  storedName: relPath,
  fileUrl,
  mimeType: f.mimetype,
  size: f.size || 0,
  user,
});

const changedToReupload =
  markSchoolReturnReuploaded(
    admissionId,
    user
  );

emitAdmissionChanged(req, {
  type: changedToReupload
    ? "school_return_reuploaded"
    : "upload_added",
  admissionId,
  dept: user?.dept || "",
});

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
    SELECT *
  FROM admissions
  WHERE id = ?
    AND COALESCE(is_deleted, 0) = 0
`).get(admissionId);

if (!adm) return res.status(404).send("Admission not found");

if (!canAccessAdmissionRow(user, adm)) {
  return res.status(403).send("Not allowed");
}

familyNumber = String(adm.accounts_family_number || "").trim();

if (familyNumber) {
  familyAdmissionIds = getAccessibleFamilyIds(user, familyNumber).map((r) => r.id);
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

app.delete(
  "/files/:id",
  requireLogin,
  requireViewFiles,
  requireDeleteFiles,
  (req, res) => {
  try {
    const user = req.session.user;

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: "Invalid file id" });

    const fileRow = db.prepare("SELECT * FROM uploads WHERE id = ?").get(id);
    if (!fileRow) return res.status(404).json({ success: false, message: "File not found" });

    const adm = db.prepare("SELECT * FROM admissions WHERE id = ?").get(fileRow.admission_id);
    if (!adm) return res.status(404).json({ success: false, message: "Admission not found" });

    if (!canAccessAdmissionRow(user, adm)) {
      return res.status(403).json({ success: false, message: "Not allowed" });
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

   const rows = db.prepare(`
  SELECT
    u.*,

    assigned.name AS assignedAdminName,
    assigned.email AS assignedAdminEmail,
    assigned.dept AS assignedAdminDept,

    creator.name AS createdByName,
    creator.email AS createdByEmail,
    creator.role AS createdByRole
  FROM users u
  LEFT JOIN users assigned
    ON assigned.id = COALESCE(u.assigned_admin_id, u.managerId)
  LEFT JOIN users creator
    ON creator.id = u.created_by
  WHERE u.role = 'sub_agent'
    AND u.dept = ?
    AND u.managerId = ?
  ORDER BY u.id DESC
`).all(user.dept, user.id);

const mySubAgents = rows.map((row) => {
  const u = mapUserRow(row);

  if (!u.access_scope) {
    u.access_scope = "own";
  }

  return u;
});
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
  SELECT
    u.*,

    assigned.name AS assignedAdminName,
    assigned.email AS assignedAdminEmail,
    assigned.dept AS assignedAdminDept,

    creator.name AS createdByName,
    creator.email AS createdByEmail,
    creator.role AS createdByRole
  FROM users u
  LEFT JOIN users assigned
    ON assigned.id = COALESCE(u.assigned_admin_id, u.managerId)
  LEFT JOIN users creator
    ON creator.id = u.created_by
  WHERE u.id = ?
    AND u.role = 'sub_agent'
    AND u.dept = ?
    AND u.managerId = ?
  LIMIT 1
`).get(id, user.dept, user.id);

  if (!row) return res.status(403).send("Not allowed");

  const editUser = mapUserRow(row);
  editUser.permissions = getPerm(editUser);
  if (!editUser.access_scope) {
  editUser.access_scope = "own";
}

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

    const allowedAgentTypes = getAllowedAgentTypesForDept(user?.dept || owned?.dept || "");
    const agentTypeRaw = String(req.body.agentType || "").trim();
    const safeAgentType = normalizeAgentTypeForDept(agentTypeRaw || owned.agentType, user?.dept || owned?.dept || "");

// ✅ Agent can assign only the permissions that are already allowed for his own account.
// Extra/tampered permissions from frontend will be ignored.
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

    // ✅ audit: sirf actual changed user fields / permissions save hongi
    const afterUserForAudit = {
      ...owned,

      name,

      email,

      agentType: safeAgentType || null,

      permissions: finalPerms,
    };

    const changes = buildUserAuditChanges(
      owned,
      afterUserForAudit
    );

    if (changes.length) {
      logAudit("user_updated_by_agent", user, {
        targetUserId: id,
        targetUserName: name,
        dept: user.dept,
        details: {
          changes,
        },
      });
    }

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
// =====================================================
// ✅ SUPER ADMIN AI ASSISTANT
// Read-only AI assistant connected with DB
// URL: POST /api/super-ai/ask
// =====================================================

function normalizeAiQuestion(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function aiSafeText(value) {
  return String(value ?? "").trim();
}

function aiNumber(value) {
  const n = Number(parseFirstNumber(value || 0) || 0);
  return Number.isFinite(n) ? n : 0;
}

function getAiDepartmentStats() {
  try {
    return db.prepare(`
      SELECT
        LOWER(TRIM(COALESCE(dept, 'unknown'))) AS dept,
        COUNT(*) AS total
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
      GROUP BY LOWER(TRIM(COALESCE(dept, 'unknown')))
      ORDER BY total DESC
    `).all();
  } catch (e) {
    console.error("getAiDepartmentStats error:", e.message);
    return [];
  }
}

function getAiStatusStats() {
  try {
    return db.prepare(`
      SELECT
        COALESCE(status, 'Not Set') AS status,
        COALESCE(feeStatus, 'Not Set') AS feeStatus,
        COUNT(*) AS total
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
      GROUP BY COALESCE(status, 'Not Set'), COALESCE(feeStatus, 'Not Set')
      ORDER BY total DESC
      LIMIT 30
    `).all();
  } catch (e) {
    console.error("getAiStatusStats error:", e.message);
    return [];
  }
}

function getAiPaymentStats() {
  try {
    return db.prepare(`
      SELECT
        COALESCE(accounts_payment_status, 'Not Set') AS paymentStatus,
        COUNT(*) AS total,
        SUM(CAST(COALESCE(NULLIF(admission_pending_dues, ''), '0') AS REAL)) AS pendingDues,
        SUM(CAST(COALESCE(NULLIF(admission_total_paid, ''), '0') AS REAL)) AS receivedPayment
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
      GROUP BY COALESCE(accounts_payment_status, 'Not Set')
      ORDER BY total DESC
      LIMIT 30
    `).all();
  } catch (e) {
    console.error("getAiPaymentStats error:", e.message);
    return [];
  }
}

function getAiUserStats() {
  try {
    return db.prepare(`
      SELECT
        role,
        COALESCE(dept, 'Not Set') AS dept,
        COUNT(*) AS total
      FROM users
      GROUP BY role, COALESCE(dept, 'Not Set')
      ORDER BY role ASC, total DESC
    `).all();
  } catch (e) {
    console.error("getAiUserStats error:", e.message);
    return [];
  }
}

function getAiProcessedByStats() {
  try {
    return db.prepare(`
      SELECT
        COALESCE(processed_by, 'Not Set') AS processedBy,
        COUNT(*) AS total,
        SUM(CAST(COALESCE(NULLIF(admission_pending_dues, ''), '0') AS REAL)) AS pendingDues,
        SUM(CAST(COALESCE(NULLIF(admission_total_paid, ''), '0') AS REAL)) AS receivedPayment
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
      GROUP BY COALESCE(processed_by, 'Not Set')
      ORDER BY total DESC
      LIMIT 30
    `).all();
  } catch (e) {
    console.error("getAiProcessedByStats error:", e.message);
    return [];
  }
}
function getAiSearchTerms(question) {
  const stopWords = new Set([
    "who", "is", "are", "the", "a", "an", "of", "for", "to", "in", "on", "by",
    "what", "which", "where", "when", "why", "how", "tell", "show", "give",
    "me", "about", "student", "admission", "details", "status", "fee", "fees",
    "payment", "record", "records", "please", "plz", "hey", "hi", "hello"
  ]);

  const clean = String(question || "")
    .toLowerCase()
    .replace(/[^\w\s@.+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = clean
    .split(" ")
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !stopWords.has(w));

  const uniqueWords = [...new Set(words)].slice(0, 8);

  return uniqueWords.length ? uniqueWords : [clean].filter(Boolean);
}
function getAiAdmissionSearchRows(question) {
  try {
    const terms = getAiSearchTerms(question);

    if (!terms.length) return [];

    const searchableColumns = [
      "CAST(id AS TEXT)",
      "student_name",
      "father_name",
      "father_email",
      "phone",
      "guardian_whatsapp",
      "processed_by",
      "dept",
      "status",
      "feeStatus",
      "grade",
      "tuition_grade",
      "accounts_registration_number",
      "accounts_family_number",
      "accounts_payment_status",
      "accounts_paid_upto",
      "accounts_verification_number",
      "admission_month",
      "admission_invoice_status",
      "admission_paid_invoice_status"
    ];

    const whereParts = [];
    const params = [];

    terms.forEach(term => {
      const likeTerm = `%${term}%`;

      searchableColumns.forEach(col => {
        whereParts.push(`LOWER(COALESCE(${col}, '')) LIKE LOWER(?)`);
        params.push(likeTerm);
      });
    });

    return db.prepare(`
      SELECT
        id,
        dept,
        status,
        feeStatus,
        student_name,
        father_name,
        father_email,
        grade,
        tuition_grade,
        phone,
        guardian_whatsapp,
        processed_by,
        registration_date,

        accounts_payment_status,
        accounts_paid_upto,
        accounts_verification_number,
        accounts_registration_number,
        accounts_family_number,

        admission_registration_fee,
        admission_fees,
        currency_code,
        admission_month,
        admission_total_fees,
        admission_pending_dues,
        admission_total_paid,
        admission_invoice_status,
        admission_invoice_status_timestamp,
        admission_paid_invoice_status,
        admission_paid_invoice_status_timestamp
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
        AND (${whereParts.join(" OR ")})
      ORDER BY id DESC
      LIMIT 60
    `).all(...params);
  } catch (e) {
    console.error("getAiAdmissionSearchRows error:", e.message);
    return [];
  }
}

function getAiUserSearchRows(question) {
  try {
    const terms = getAiSearchTerms(question);

    if (!terms.length) return [];

    const searchableColumns = [
      "CAST(id AS TEXT)",
      "name",
      "email",
      "role",
      "dept",
      "agentType",
      "access_scope",
      "created_by"
    ];

    const whereParts = [];
    const params = [];

    terms.forEach(term => {
      const likeTerm = `%${term}%`;

      searchableColumns.forEach(col => {
        whereParts.push(`LOWER(COALESCE(${col}, '')) LIKE LOWER(?)`);
        params.push(likeTerm);
      });
    });

    return db.prepare(`
      SELECT
        id,
        name,
        email,
        role,
        dept,
        agentType,
        assigned_admin_id,
        managerId,
        created_by,
        access_scope,
        lastUpdatedAt,
        lastUpdatedBy,
        lastUpdatedByRole
      FROM users
      WHERE ${whereParts.join(" OR ")}
      ORDER BY id DESC
      LIMIT 60
    `).all(...params);
  } catch (e) {
    console.error("getAiUserSearchRows error:", e.message);
    return [];
  }
}

function getAiExactCounts() {
  try {
    const totalAdmissions = db.prepare(`
      SELECT COUNT(*) AS total
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
    `).get()?.total || 0;

    const totalUsers = db.prepare(`
      SELECT COUNT(*) AS total
      FROM users
    `).get()?.total || 0;

    const feeTotals = db.prepare(`
      SELECT
        SUM(CAST(COALESCE(NULLIF(admission_total_fees, ''), '0') AS REAL)) AS totalFees,
        SUM(CAST(COALESCE(NULLIF(admission_pending_dues, ''), '0') AS REAL)) AS pendingDues,
        SUM(CAST(COALESCE(NULLIF(admission_total_paid, ''), '0') AS REAL)) AS receivedPayment
      FROM admissions
      WHERE COALESCE(is_deleted, 0) = 0
    `).get() || {};

    return {
      totalAdmissions,
      totalUsers,
      totalFees: aiNumber(feeTotals.totalFees),
      pendingDues: aiNumber(feeTotals.pendingDues),
      receivedPayment: aiNumber(feeTotals.receivedPayment),
    };
  } catch (e) {
    console.error("getAiExactCounts error:", e.message);
    return {
      totalAdmissions: 0,
      totalUsers: 0,
      totalFees: 0,
      pendingDues: 0,
      receivedPayment: 0,
    };
  }
}

function buildAiDbContext(question) {
  const exactCounts = getAiExactCounts();
  const matchingAdmissions = getAiAdmissionSearchRows(question);
  const matchingUsers = getAiUserSearchRows(question);

  return {
    generatedAt: new Date().toISOString(),
    exactCounts,
    departmentStats: getAiDepartmentStats(),
    statusStats: getAiStatusStats(),
    paymentStats: getAiPaymentStats(),
    processedByStats: getAiProcessedByStats(),
    userStats: getAiUserStats(),
    matchingAdmissions,
    matchingUsers,
    note: "This context is read-only database data from the dashboard. Answer only from this context. If the answer is not available, say it is not available in current DB context.",
  };
}

app.post("/api/super-ai/ask", requireLogin, requireSuperAdmin, async (req, res) => {
  try {
    const question = normalizeAiQuestion(req.body?.question);

    if (!question) {
      return res.status(400).json({
        success: false,
        message: "Question is required.",
      });
    }

    const geminiApiKey = getAiSettingValue(
  "GEMINI_API_KEY",
  process.env.GEMINI_API_KEY || ""
);

const geminiModelName = getAiSettingValue(
  "GEMINI_MODEL",
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"
);

if (!geminiApiKey) {
  return res.status(500).json({
    success: false,
    message: "GEMINI_API_KEY is missing. Please add it from API Settings.",
  });
}

const genAI = new GoogleGenerativeAI(geminiApiKey);

    const dbContext = buildAiDbContext(question);

    const model = genAI.getGenerativeModel({
  model: geminiModelName,
  systemInstruction:
    "You are the Super Admin AI Assistant for IQRA Virtual School dashboard. " +
    "You answer in clear, simple English unless the user asks another language. " +
    "You are read-only. Do not suggest editing/deleting/updating records unless the user asks how to do it manually. " +
    "Use only the provided database context. Do not invent values. " +
    "For admissions, fees, billing, users, and counts, give clear short answers with names, IDs, amounts, departments, and statuses when available.",
});

const result = await model.generateContent(
  JSON.stringify({
    question,
    databaseContext: dbContext,
  })
);

const answer =
  result.response.text() ||
  "Sorry, AI response could not be generated. Please try again.";

    logAudit("super_ai_assistant_ask", req.session.user, {
      dept: "all",
      details: {
        question,
        matchedAdmissions: dbContext.matchingAdmissions.length,
        matchedUsers: dbContext.matchingUsers.length,
      },
    });

    return res.json({
      success: true,
      answer,
      debug: {
        matchedAdmissions: dbContext.matchingAdmissions.length,
        matchedUsers: dbContext.matchingUsers.length,
        exactCounts: dbContext.exactCounts,
      },
    });
  } catch (err) {
    console.error("POST /api/super-ai/ask error:", err);

    return res.status(500).json({
      success: false,
      message: "AI assistant error. Please check server logs.",
      error: String(err?.message || err),
    });
  }
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