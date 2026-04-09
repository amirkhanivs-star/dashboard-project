// migrate-update-notice.js
import db from "./db.js";

// Safe helper: purani DB me column missing ho to add karo, warna skip
function ensureColumn(table, column, type) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = cols.some((c) => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`✅ Added ${table}.${column}`);
    } else {
      console.log(`ℹ️ Already exists: ${table}.${column}`);
    }
  } catch (err) {
    console.error(`❌ Failed for ${table}.${column}:`, err.message);
  }
}

const run = db.transaction(() => {
  ensureColumn("users", "lastUpdatedBy", "TEXT");
  ensureColumn("users", "lastUpdatedByRole", "TEXT");
  ensureColumn("users", "lastUpdatedAt", "TEXT");
  ensureColumn("users", "updateNoticeUnread", "INTEGER DEFAULT 0");
});

run();

console.log("✅ Migration completed.");
