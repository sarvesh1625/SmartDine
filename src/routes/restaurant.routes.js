const router = require('express').Router();
const { authenticate, isAdmin } = require('../middleware/auth');
const { emitWaiterCall } = require('../socket');
const { query, queryOne, getDB } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');

router.get('/profile', authenticate, isAdmin, async (req, res, next) => {
  try {
    const r = await queryOne('SELECT * FROM restaurants WHERE id = ?', [req.restaurantId]);
    res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

router.put('/profile', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { name, phone, address, city, state, logo_url, default_language } = req.body;
    await query(
      `UPDATE restaurants SET
        name             = COALESCE(?, name),
        phone            = COALESCE(?, phone),
        address          = COALESCE(?, address),
        city             = COALESCE(?, city),
        state            = COALESCE(?, state),
        logo_url         = COALESCE(?, logo_url),
        default_language = COALESCE(?, default_language)
       WHERE id = ?`,
      [name, phone, address, city, state, logo_url, default_language, req.restaurantId]
    );
    res.json({ success: true, message: 'Profile updated' });
  } catch (err) { next(err); }
});

router.get('/tables', authenticate, isAdmin, async (req, res, next) => {
  try {
    const tables = await query(
      'SELECT * FROM tables_info WHERE restaurant_id = ? ORDER BY table_number ASC',
      [req.restaurantId]
    );
    res.json({ success: true, data: tables });
  } catch (err) { next(err); }
});

router.post('/tables', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { table_number } = req.body;
    if (!table_number) throw new AppError('table_number is required', 400);
    const restaurant = await queryOne('SELECT slug FROM restaurants WHERE id = ?', [req.restaurantId]);
    const qrUrl = `${process.env.FRONTEND_URL}/menu/${restaurant.slug}/table/${table_number}`;
    const [result] = await getDB().execute(
      'INSERT INTO tables_info (restaurant_id, table_number, qr_code_url, upi_only) VALUES (?, ?, ?, ?)',
      [req.restaurantId, table_number, qrUrl, req.body.upi_only ? 1 : 0]
    );
    res.status(201).json({ success: true, data: { id: result.insertId, qrUrl } });
  } catch (err) { next(err); }
});

// PATCH /api/v1/restaurant/tables/:id — update table (upi_only toggle)
router.patch('/tables/:id', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { upi_only } = req.body;
    await query(
      'UPDATE tables_info SET upi_only = ? WHERE id = ? AND restaurant_id = ?',
      [upi_only ? 1 : 0, req.params.id, req.restaurantId]
    );
    res.json({ success: true, message: 'Table updated' });
  } catch (err) { next(err); }
});

router.delete('/tables/:id', authenticate, isAdmin, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM tables_info WHERE id = ? AND restaurant_id = ?',
      [req.params.id, req.restaurantId]
    );
    if (!result.affectedRows) throw new AppError('Table not found', 404);
    res.json({ success: true, message: 'Table removed' });
  } catch (err) { next(err); }
});

router.get('/staff', authenticate, isAdmin, async (req, res, next) => {
  try {
    const staff = await query(
      `SELECT id, name, email, role, phone, is_active, created_at
       FROM users WHERE restaurant_id = ? AND role != 'admin'`,
      [req.restaurantId]
    );
    res.json({ success: true, data: staff });
  } catch (err) { next(err); }
});

// POST /api/v1/restaurant/staff — create staff/kitchen account
router.post('/staff', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { name, email, password, phone, role } = req.body;
    if (!name || !email || !password || !role) {
      throw new AppError('name, email, password and role are required', 400);
    }
    if (!['staff', 'kitchen'].includes(role)) {
      throw new AppError('role must be staff or kitchen', 400);
    }
    if (password.length < 6) throw new AppError('Password must be at least 6 characters', 400);

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw new AppError('Email already in use', 409);

    const bcrypt = require('bcryptjs');
    const uuid   = require('uuid');
    const hash   = await bcrypt.hash(password, 10);
    const id     = uuid.v4();

    await query(
      `INSERT INTO users (id, restaurant_id, name, email, password_hash, role, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.restaurantId, name.trim(), email.trim().toLowerCase(), hash, role, phone || null]
    );
    res.status(201).json({ success: true, message: `${role} account created for ${name}` });
  } catch (err) { next(err); }
});

// PATCH /api/v1/restaurant/staff/:id/toggle — activate/deactivate
router.patch('/staff/:id/toggle', authenticate, isAdmin, async (req, res, next) => {
  try {
    const member = await queryOne(
      'SELECT id, is_active FROM users WHERE id = ? AND restaurant_id = ? AND role != ?',
      [req.params.id, req.restaurantId, 'admin']
    );
    if (!member) throw new AppError('Staff not found', 404);
    await query('UPDATE users SET is_active = ? WHERE id = ?', [member.is_active ? 0 : 1, req.params.id]);
    res.json({ success: true, message: member.is_active ? 'Account deactivated' : 'Account activated' });
  } catch (err) { next(err); }
});

// DELETE /api/v1/restaurant/staff/:id
router.delete('/staff/:id', authenticate, isAdmin, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM users WHERE id = ? AND restaurant_id = ? AND role != ?',
      [req.params.id, req.restaurantId, 'admin']
    );
    if (!result.affectedRows) throw new AppError('Staff not found', 404);
    res.json({ success: true, message: 'Staff removed' });
  } catch (err) { next(err); }
});

// POST /api/v1/restaurant/waiter-call — public, customer calls waiter
router.post('/waiter-call', async (req, res, next) => {
  try {
    const { restaurantSlug, tableId, type } = req.body;
    if (!restaurantSlug) throw new AppError('restaurantSlug is required', 400);

    const restaurant = await queryOne(
      'SELECT id, name FROM restaurants WHERE slug = ? AND is_active = 1',
      [restaurantSlug]
    );
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    // Resolve table number to table info
    let tableNumber = tableId;
    if (tableId) {
      const tableRow = await queryOne(
        'SELECT table_number FROM tables_info WHERE restaurant_id = ? AND table_number = ?',
        [restaurant.id, String(tableId)]
      );
      tableNumber = tableRow?.table_number || tableId;
    }

    emitWaiterCall(restaurant.id, {
      type:        type || 'waiter',
      tableNumber: tableNumber || 'Unknown',
      restaurantId: restaurant.id,
      calledAt:    new Date().toISOString(),
    });

    res.json({ success: true, message: 'Staff notified!' });
  } catch (err) { next(err); }
});

// ── BRANCH MANAGEMENT ──────────────────────────────────────────────────────

// GET /api/v1/restaurant/branches — list all branches of this restaurant
router.get('/branches', authenticate, isAdmin, async (req, res, next) => {
  try {
    // Find root (either this restaurant IS root, or find its parent)
    const self = await queryOne('SELECT id, parent_restaurant_id FROM restaurants WHERE id = ?', [req.restaurantId]);
    const rootId = self.parent_restaurant_id || self.id;

    const branches = await query(
      `SELECT r.id, r.name, r.branch_name, r.branch_code, r.slug, r.city, r.state,
              r.phone, r.email, r.is_active, r.created_at,
              COUNT(DISTINCT o.id)              AS total_orders,
              COALESCE(SUM(o.final_amount), 0)  AS total_revenue,
              COUNT(DISTINCT t.id)              AS table_count
       FROM restaurants r
       LEFT JOIN orders o      ON o.restaurant_id = r.id AND o.status != 'cancelled'
       LEFT JOIN tables_info t ON t.restaurant_id = r.id
       WHERE r.id = ? OR r.parent_restaurant_id = ?
       GROUP BY r.id
       ORDER BY r.created_at ASC`,
      [rootId, rootId]
    );
    res.json({ success: true, data: branches });
  } catch (err) { next(err); }
});

// POST /api/v1/restaurant/branches — create a new branch
router.post('/branches', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { branch_name, branch_code, city, state, phone, address } = req.body;
    if (!branch_name) throw new AppError('branch_name is required', 400);

    const self = await queryOne('SELECT id, name, parent_restaurant_id FROM restaurants WHERE id = ?', [req.restaurantId]);
    const rootId = self.parent_restaurant_id || self.id;
    const root   = await queryOne('SELECT name FROM restaurants WHERE id = ?', [rootId]);

    const uuid = require('uuid');
    const bcrypt = require('bcryptjs');
    const branchId = uuid.v4();
    const slug = `${root.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${(branch_code || branch_name).toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${Date.now().toString().slice(-4)}`;

    // Get parent plan to inherit
    const rootFull = await queryOne('SELECT plan_type FROM restaurants WHERE id = ?', [rootId]);

    // Create branch restaurant — inherits parent plan
    await query(
      `INSERT INTO restaurants (id, parent_restaurant_id, name, branch_name, branch_code, slug, city, state, phone, email, plan_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [branchId, rootId, root.name, branch_name, branch_code || null, slug, city || null, state || null, phone || null, `branch-${branchId.slice(0,8)}@menucloud.internal`, rootFull?.plan_type || 'enterprise']
    );

    // Create admin user for branch
    const adminId   = uuid.v4();
    const adminPass = await bcrypt.hash(`Branch@${Date.now()}`, 10);
    await query(
      `INSERT INTO users (id, restaurant_id, name, email, password_hash, role)
       VALUES (?, ?, ?, ?, ?, 'admin')`,
      [adminId, branchId, `${branch_name} Manager`, `branch-${branchId.slice(0,8)}@menucloud.in`, adminPass]
    );

    res.status(201).json({
      success: true,
      message: `Branch "${branch_name}" created successfully!`,
      data: { branchId, slug, adminEmail: `branch-${branchId.slice(0,8)}@menucloud.in` }
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/restaurant/branches/:id — update branch
router.patch('/branches/:id', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { branch_name, branch_code, city, state, phone, is_active } = req.body;
    await query(
      `UPDATE restaurants SET
         branch_name = COALESCE(?, branch_name),
         branch_code = COALESCE(?, branch_code),
         city = COALESCE(?, city),
         state = COALESCE(?, state),
         phone = COALESCE(?, phone),
         is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [branch_name, branch_code, city, state, phone, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id]
    );
    res.json({ success: true, message: 'Branch updated' });
  } catch (err) { next(err); }
});

// GET /api/v1/restaurant/payment-settings
router.get('/payment-settings', authenticate, isAdmin, async (req, res, next) => {
  try {
    const restaurant = await queryOne(
      `SELECT upi_id, phonepe_merchant_id, phonepe_salt_key, phonepe_salt_index, phonepe_env
       FROM restaurants WHERE id = ?`,
      [req.restaurantId]
    );
    res.json({ success: true, data: {
      upi_id:              restaurant?.upi_id              || null,
      phonepe_merchant_id: restaurant?.phonepe_merchant_id || null,
      phonepe_salt_key:    restaurant?.phonepe_salt_key    || null,
      phonepe_salt_index:  restaurant?.phonepe_salt_index  || 1,
      phonepe_env:         restaurant?.phonepe_env         || 'UAT',
    }});
  } catch (err) { next(err); }
});

// PUT /api/v1/restaurant/payment-settings — save UPI + PhonePe credentials
router.put('/payment-settings', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { upi_id, phonepe_merchant_id, phonepe_salt_key, phonepe_salt_index, phonepe_env } = req.body;
    if (upi_id && !/^[a-zA-Z0-9.\-_]+@[a-zA-Z0-9]+$/.test(upi_id.trim())) {
      return res.status(400).json({ success: false, message: 'Invalid UPI ID format. Example: yourname@ybl' });
    }
    await query(
      `UPDATE restaurants SET
         upi_id              = ?,
         phonepe_merchant_id = ?,
         phonepe_salt_key    = ?,
         phonepe_salt_index  = ?,
         phonepe_env         = ?
       WHERE id = ?`,
      [
        upi_id              ? upi_id.trim()              : null,
        phonepe_merchant_id ? phonepe_merchant_id.trim() : null,
        phonepe_salt_key    ? phonepe_salt_key.trim()    : null,
        phonepe_salt_index  || 1,
        phonepe_env         || 'UAT',
        req.restaurantId,
      ]
    );
    res.json({ success: true, message: 'Payment settings saved!' });
  } catch (err) { next(err); }
});

// GET /api/v1/restaurant/public/:slug — public route, returns upi_id + table flags
// Also accepts ?table=TABLE_NUMBER to return that table's upi_only flag
router.get('/public/:slug', async (req, res, next) => {
  try {
    const restaurant = await queryOne(
      'SELECT id, name, upi_id, default_language FROM restaurants WHERE slug = ? AND is_active = 1',
      [req.params.slug]
    );
    if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    // Check table-specific payment restrictions
    let tableUpiOnly = false;
    if (req.query.table) {
      const tableRow = await queryOne(
        'SELECT upi_only FROM tables_info WHERE restaurant_id = ? AND table_number = ?',
        [restaurant.id, String(req.query.table)]
      );
      tableUpiOnly = !!(tableRow?.upi_only);
    }

    // Try to get PhonePe config — columns may not exist if migration not run yet
    let hasMerchant = false;
    try {
      const pp = await queryOne(
        'SELECT phonepe_merchant_id, phonepe_salt_key FROM restaurants WHERE id = ?',
        [restaurant.id]
      );
      hasMerchant = !!(pp?.phonepe_merchant_id && pp?.phonepe_salt_key);
    } catch (e) { /* columns not migrated yet */ }

    res.json({ success: true, data: { ...restaurant, hasMerchant, tableUpiOnly } });
  } catch (err) { next(err); }
});

// POST /api/v1/restaurant/switch-branch — switch admin context to a branch
// Returns new tokens scoped to the branch restaurant
router.post('/switch-branch', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { branchId } = req.body;
    if (!branchId) throw new AppError('branchId is required', 400);

    // Verify this branch belongs to the same root restaurant
    const self = await queryOne(
      'SELECT id, parent_restaurant_id FROM restaurants WHERE id = ?',
      [req.restaurantId]
    );
    const rootId = self.parent_restaurant_id || self.id;

    const branch = await queryOne(
      `SELECT r.id, r.name, r.branch_name, r.slug, r.is_active,
              u.id AS user_id, u.name AS user_name, u.role, r.plan_type
       FROM restaurants r
       JOIN users u ON u.restaurant_id = r.id AND u.role = 'admin'
       WHERE r.id = ? AND (r.id = ? OR r.parent_restaurant_id = ?)
       LIMIT 1`,
      [branchId, rootId, rootId]
    );

    if (!branch) throw new AppError('Branch not found or access denied', 403);
    if (!branch.is_active) throw new AppError('This branch is inactive', 403);

    const jwt = require('jsonwebtoken');
    const accessToken = jwt.sign(
      { userId: branch.user_id, restaurantId: branch.id, role: branch.role },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = jwt.sign(
      { userId: branch.user_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id:             branch.user_id,
          name:           branch.user_name,
          role:           branch.role,
          restaurantId:   branch.id,
          restaurantName: branch.branch_name || branch.name,
          restaurantSlug: branch.slug,
          planType:       branch.plan_type,
        },
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;