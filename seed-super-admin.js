// seed-super-admin.js  (ES module)

import bcrypt from "bcrypt";
import db from "./db.js";

(async () => {
  try {
    const email = "super@ivs.com";
    const plainPassword = "super123";

    // Check agar user pehle se mojood hai
    const existing = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email);

    if (existing) {
      console.log("Super Admin already exists:", existing.email);
      process.exit(0);
    }

    // Password hash
    const hash = await bcrypt.hash(plainPassword, 10);

    const stmt = db.prepare(`
      INSERT INTO users
        (name, email, password_hash, role, dept, agentType, managerId, permissions)
      VALUES
        (@name, @email, @password_hash, @role, @dept, @agentType, @managerId, @permissions)
    `);

    stmt.run({
      name: "Super Admin",
      email,
      password_hash: hash,
      role: "super_admin",
      dept: null,
      agentType: null,
      managerId: null,
      permissions: JSON.stringify({
        showPhone: true,
        showPaymentStatus: true,
        showPaidUpto: true,
        showVerificationNumber: true,
        showRegistrationNumber: true,
        viewAdmissions: true,
        viewAccounts: true,
        viewManagement: true,
      }),
    });

    console.log("Super Admin created ✅");
    console.log("Login email   :", email);
    console.log("Login password:", plainPassword);
    process.exit(0);
  } catch (err) {
    console.error("Error seeding super admin:", err);
    process.exit(1);
  }
})();
