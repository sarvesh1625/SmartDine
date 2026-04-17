const router = require('express').Router();
const { authenticate, isSuperAdmin } = require('../middleware/auth');
const { query, queryOne }            = require('../config/db');
const { AppError }                   = require('../middleware/errorHandler');

// GET /api/v1/superadmin/restaurants — all restaurants with full stats
router.get('/restaurants', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT
         r.*,
         COUNT(DISTINCT u.id)                          AS staff_count,
         COUNT(DISTINCT o.id)                          AS total_orders,
         COALESCE(SUM(o.final_amount), 0)              AS total_revenue,
         COUNT(DISTINCT mi.id)                         AS menu_item_count,
         COUNT(DISTINCT t.id)                          AS table_count,
         MAX(o.created_at)                             AS last_order_at
       FROM restaurants r
       LEFT JOIN users      u  ON u.restaurant_id  = r.id AND u.role != 'admin'
       LEFT JOIN orders     o  ON o.restaurant_id  = r.id AND o.status != 'cancelled'
       LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
       LEFT JOIN tables_info t ON t.restaurant_id  = r.id
       GROUP BY r.id
       ORDER BY r.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/stats — platform-wide numbers
router.get('/stats', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const [stats] = await query(
      `SELECT
        (SELECT COUNT(*)                        FROM restaurants)                                          AS total_restaurants,
        (SELECT COUNT(*)                        FROM restaurants WHERE plan_type != 'free')                AS paid_restaurants,
        (SELECT COUNT(*)                        FROM restaurants WHERE plan_type = 'pro')                  AS pro_restaurants,
        (SELECT COUNT(*)                        FROM restaurants WHERE plan_type = 'enterprise')           AS enterprise_restaurants,
        (SELECT COUNT(*)                        FROM restaurants WHERE is_active = 0)                      AS inactive_restaurants,
        (SELECT COUNT(*)                        FROM orders WHERE DATE(created_at) = CURDATE())            AS today_orders,
        (SELECT COALESCE(SUM(final_amount), 0)  FROM orders WHERE DATE(created_at) = CURDATE()
           AND status != 'cancelled')                                                                      AS today_revenue,
        (SELECT COALESCE(SUM(final_amount), 0)  FROM orders WHERE status != 'cancelled')                  AS total_revenue,
        (SELECT COUNT(*)                        FROM orders)                                               AS total_orders,
        (SELECT COUNT(*)                        FROM users WHERE role = 'admin')                           AS total_admins`
    );
    res.json({ success: true, data: stats });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/analytics — top restaurants + plan breakdown
router.get('/analytics', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const [stats] = await query(
      `SELECT
        (SELECT COUNT(*) FROM restaurants)                                          AS total_restaurants,
        (SELECT COUNT(*) FROM restaurants WHERE plan_type != 'free')                AS paid_restaurants,
        (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'pro')                  AS pro_restaurants,
        (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'enterprise')           AS enterprise_restaurants,
        (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURDATE())            AS today_orders,
        (SELECT COALESCE(SUM(final_amount),0) FROM orders WHERE DATE(created_at) = CURDATE()
           AND status != 'cancelled')                                               AS today_revenue,
        (SELECT COALESCE(SUM(final_amount),0) FROM orders WHERE status != 'cancelled') AS total_revenue`
    );

    const topRestaurants = await query(
      `SELECT r.id, r.name, r.slug, r.plan_type, r.city, r.state, r.is_active,
              COUNT(o.id)                    AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue
       FROM restaurants r
       LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status != 'cancelled'
       GROUP BY r.id
       ORDER BY total_revenue DESC
       LIMIT 10`
    );

    // Revenue by day for last 7 days (platform-wide)
    const revenueByDay = await query(
      `SELECT DATE(created_at) AS date,
              COALESCE(SUM(final_amount), 0) AS revenue,
              COUNT(*) AS orders
       FROM orders
       WHERE status != 'cancelled'
         AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );

    res.json({ success: true, data: { stats, topRestaurants, revenueByDay } });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/restaurants/:id — single restaurant full detail
router.get('/restaurants/:id', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const restaurant = await queryOne(
      `SELECT r.*,
              COUNT(DISTINCT u.id)             AS staff_count,
              COUNT(DISTINCT o.id)             AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue,
              COUNT(DISTINCT mi.id)            AS menu_item_count,
              COUNT(DISTINCT t.id)             AS table_count,
              ROUND(AVG(f.food_rating), 1)     AS avg_food_rating,
              MAX(o.created_at)                AS last_order_at
       FROM restaurants r
       LEFT JOIN users       u  ON u.restaurant_id  = r.id AND u.role != 'admin'
       LEFT JOIN orders      o  ON o.restaurant_id  = r.id AND o.status != 'cancelled'
       LEFT JOIN menu_items  mi ON mi.restaurant_id = r.id
       LEFT JOIN tables_info t  ON t.restaurant_id  = r.id
       LEFT JOIN feedback    f  ON f.restaurant_id  = r.id
       WHERE r.id = ?
       GROUP BY r.id`,
      [req.params.id]
    );
    if (!restaurant) throw new AppError('Restaurant not found', 404);

    // Revenue last 7 days
    const revenueByDay = await query(
      `SELECT DATE(created_at) AS date,
              COALESCE(SUM(final_amount), 0) AS revenue,
              COUNT(*) AS orders
       FROM orders
       WHERE restaurant_id = ? AND status != 'cancelled'
         AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [req.params.id]
    );

    // Top menu items
    const topItems = await query(
      `SELECT oi.item_name_snapshot AS name,
              SUM(oi.quantity)      AS total_sold,
              SUM(oi.quantity * oi.unit_price) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status != 'cancelled'
       GROUP BY oi.item_name_snapshot
       ORDER BY total_sold DESC
       LIMIT 5`,
      [req.params.id]
    );

    // Recent orders
    const recentOrders = await query(
      `SELECT id, customer_name, final_amount, status, payment_status, created_at
       FROM orders WHERE restaurant_id = ?
       ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    // Staff list
    const staff = await query(
      `SELECT id, name, email, role, is_active, created_at
       FROM users WHERE restaurant_id = ? AND role != 'admin'`,
      [req.params.id]
    );

    res.json({ success: true, data: { restaurant, revenueByDay, topItems, recentOrders, staff } });
  } catch (err) { next(err); }
});

// PATCH /api/v1/superadmin/restaurants/:id/plan
router.patch('/restaurants/:id/plan', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const { plan_type } = req.body;
    if (!['free', 'pro', 'enterprise'].includes(plan_type)) {
      throw new AppError('plan_type must be free, pro, or enterprise', 400);
    }
    const restaurant = await queryOne('SELECT id FROM restaurants WHERE id = ?', [req.params.id]);
    if (!restaurant) throw new AppError('Restaurant not found', 404);
    await query('UPDATE restaurants SET plan_type = ? WHERE id = ?', [plan_type, req.params.id]);
    res.json({ success: true, message: `Plan updated to ${plan_type}` });
  } catch (err) { next(err); }
});

// PATCH /api/v1/superadmin/restaurants/:id/status — activate/deactivate
router.patch('/restaurants/:id/status', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') throw new AppError('is_active (boolean) required', 400);
    const restaurant = await queryOne('SELECT id FROM restaurants WHERE id = ?', [req.params.id]);
    if (!restaurant) throw new AppError('Restaurant not found', 404);
    await query('UPDATE restaurants SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
    res.json({ success: true, message: `Restaurant ${is_active ? 'activated' : 'deactivated'}` });
  } catch (err) { next(err); }
});

// ── PLATFORM SETTINGS (super admin only) ──────────────────────────────────

// GET /api/v1/superadmin/settings — get all platform settings
router.get('/settings', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const rows = await query('SELECT setting_key, setting_value FROM platform_settings');
    const settings = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    res.json({ success: true, data: settings });
  } catch (err) { next(err); }
});

// PATCH /api/v1/superadmin/settings — update a platform setting
router.patch('/settings', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const { key, value } = req.body;
    if (!key) throw new AppError('key is required', 400);
    await query(
      `INSERT INTO platform_settings (setting_key, setting_value)
       VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?`,
      [key, String(value), String(value)]
    );
    res.json({ success: true, message: `Setting "${key}" updated to "${value}"` });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/settings/public — public endpoint (no auth) for frontend to check
router.get('/settings/public', async (req, res, next) => {
  try {
    const rows = await query('SELECT setting_key, setting_value FROM platform_settings');
    const settings = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    res.json({ success: true, data: settings });
  } catch (err) { next(err); }
});

module.exports = router;