// backend/users.js
import db from '../db.js';

// SUPER ADMIN: Users Directory
export function listSuperUsers(req, res) {
  const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();

  const users = rows.map(u => ({
    ...u,
    permissions: u.permissions ? JSON.parse(u.permissions) : {},
  }));

  const roleFilter = req.query.role || 'all';

  // optional: role filter apply
  const filtered = roleFilter === 'all'
    ? users
    : users.filter(u => {
        if (roleFilter === 'super') return u.role === 'super_admin';
        if (roleFilter === 'admin') return u.role === 'admin';
        if (roleFilter === 'agent') return u.role === 'agent';
        if (roleFilter === 'sub_agent') return u.role === 'sub_agent';
        return true;
      });

  const counts = {
    total: users.length,
    admins: users.filter(u => u.role === 'super_admin' || u.role === 'admin').length,
    agents: users.filter(u => u.role === 'agent').length,
    subAgents: users.filter(u => u.role === 'sub_agent').length,
  };

  res.render('super-users', {
    user: req.user,
    users: filtered,
    counts,
    roleFilter,
  });
}

// DEPARTMENT ADMIN: Agents & Sub Agents list
export function listDeptUsers(req, res) {
  const dept = req.user.dept;

  const rows = db.prepare(
    'SELECT * FROM users WHERE dept = ? AND role IN ("agent","sub_agent") ORDER BY id ASC'
  ).all(dept);

  const deptUsers = rows.map(u => ({
    ...u,
    permissions: u.permissions ? JSON.parse(u.permissions) : {},
  }));

  res.render('admin-users', { user: req.user, deptUsers });
}
