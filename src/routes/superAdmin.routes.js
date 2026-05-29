const router = require('express').Router();
const { authenticate, isSuperAdmin } = require('../middleware/auth');
const { query, queryOne }            = require('../config/db');
const { AppError }                   = require('../middleware/errorHandler');

// GET /api/v1/superadmin/restaurants
router.get('/restaurants', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT r.*,
              COUNT(DISTINCT u.id)  AS staff_count,
              COUNT(DISTINCT o.id)  AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue
       FROM restaurants r
       LEFT JOIN users  u ON u.restaurant_id = r.id AND u.role != 'admin'
       LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status != 'cancelled'
       GROUP BY r.id
       ORDER BY r.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/analytics  — platform-wide stats
router.get('/analytics', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const [stats] = await query(
      `SELECT
         (SELECT COUNT(*) FROM restaurants)                                                           AS total_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'free')                                  AS free_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'pro')                                   AS pro_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'enterprise')                            AS enterprise_restaurants,
         (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURDATE())                             AS today_orders,
         (SELECT COALESCE(SUM(final_amount),0) FROM orders WHERE DATE(created_at) = CURDATE()
            AND status != 'cancelled')                                                                AS today_revenue,
         (SELECT COALESCE(SUM(final_amount),0) FROM orders WHERE status != 'cancelled')              AS total_revenue,
         (SELECT COUNT(*) FROM users WHERE role IN ('admin'))                                         AS total_admins`
    );

    const topRestaurants = await query(
      `SELECT r.id, r.name, r.slug, r.plan_type, r.city, r.state,
              COUNT(o.id)                AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue
       FROM restaurants r
       LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status != 'cancelled'
       GROUP BY r.id
       ORDER BY total_revenue DESC
       LIMIT 10`
    );

    res.json({ success: true, data: { stats, topRestaurants } });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/restaurants/:id
router.get('/restaurants/:id', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;

    const restaurant = await queryOne(
      `SELECT r.*,
              COUNT(DISTINCT u.id) AS staff_count,
              COUNT(DISTINCT o.id) AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue,
              COUNT(DISTINCT mi.id) AS menu_item_count,
              COUNT(DISTINCT t.id) AS table_count
       FROM restaurants r
       LEFT JOIN users u ON u.restaurant_id = r.id AND u.role != 'admin'
       LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status != 'cancelled'
       LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
       LEFT JOIN tables_info t ON t.restaurant_id = r.id
       WHERE r.id = ?
       GROUP BY r.id`,
      [id]
    );
    if (!restaurant) throw new AppError('Restaurant not found', 404);

    // Recent orders
    const recentOrders = await query(
      `SELECT o.id, o.customer_name, o.final_amount, o.status,
              o.payment_method, o.created_at, t.table_number
       FROM orders o
       LEFT JOIN tables_info t ON t.id = o.table_id
       WHERE o.restaurant_id = ?
       ORDER BY o.created_at DESC LIMIT 10`,
      [id]
    );

    // Top items
    const topItems = await query(
      `SELECT oi.item_name_snapshot AS name,
              SUM(oi.quantity) AS total_sold,
              SUM(oi.quantity * oi.unit_price) AS total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status != 'cancelled'
       GROUP BY oi.item_name_snapshot
       ORDER BY total_sold DESC LIMIT 5`,
      [id]
    );

    // Revenue by day (last 14 days)
    const revenueByDay = await query(
      `SELECT DATE(created_at) AS date,
              COUNT(*) AS orders,
              COALESCE(SUM(final_amount), 0) AS revenue
       FROM orders
       WHERE restaurant_id = ? AND status != 'cancelled'
         AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [id]
    );

    // Staff
    const staff = await query(
      `SELECT id, name, email, role, phone, is_active, created_at
       FROM users WHERE restaurant_id = ? AND role != 'admin'`,
      [id]
    );

    res.json({ success: true, data: {
      restaurant, recentOrders, topItems, revenueByDay, staff
    }});
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

// PATCH /api/v1/superadmin/restaurants/:id/status  — activate / deactivate
router.patch('/restaurants/:id/status', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') throw new AppError('is_active (boolean) is required', 400);

    const restaurant = await queryOne('SELECT id FROM restaurants WHERE id = ?', [req.params.id]);
    if (!restaurant) throw new AppError('Restaurant not found', 404);

    await query('UPDATE restaurants SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
    res.json({ success: true, message: `Restaurant ${is_active ? 'activated' : 'deactivated'}` });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/stats — alias for analytics
router.get('/stats', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    // Run each query separately to handle missing tables gracefully
    const [statsRow] = await query(
      `SELECT
         (SELECT COUNT(*) FROM restaurants)                               AS total_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'free')      AS free_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'pro')       AS pro_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'enterprise') AS enterprise_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE is_active = 0)           AS inactive_restaurants,
         (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURDATE()) AS today_orders,
         (SELECT COALESCE(SUM(final_amount),0) FROM orders
            WHERE DATE(created_at) = CURDATE() AND status != 'cancelled') AS today_revenue,
         (SELECT COALESCE(SUM(final_amount),0) FROM orders
            WHERE status != 'cancelled')                                   AS total_revenue,
         (SELECT COUNT(*) FROM orders)                                     AS total_orders,
         (SELECT COUNT(*) FROM users WHERE role = 'admin')                AS total_admins,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type != 'free')     AS paid_restaurants`
    );

    let total_bookings = 0;
    try {
      const [b] = await query('SELECT COUNT(*) AS cnt FROM bookings WHERE payment_status = "paid"');
      total_bookings = b?.cnt || 0;
    } catch {}

    const recentRestaurants = await query(
      `SELECT r.id, r.name, r.slug, r.plan_type, r.city, r.is_active,
              r.created_at, COUNT(o.id) AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue
       FROM restaurants r
       LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status != 'cancelled'
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT 10`
    );

    res.json({ success: true, data: { ...statsRow, total_bookings, recentRestaurants } });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/analytics
router.get('/analytics', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const [stats] = await query(
      `SELECT
         (SELECT COUNT(*) FROM restaurants)                                      AS total_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type != 'free')            AS paid_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'pro')              AS pro_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'enterprise')       AS enterprise_restaurants,
         (SELECT COUNT(*) FROM restaurants WHERE is_active = 0)                  AS inactive_restaurants,
         (SELECT COUNT(*) FROM users WHERE role = 'admin')                       AS total_admins,
         (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURDATE())        AS today_orders,
         (SELECT COALESCE(SUM(final_amount),0) FROM orders
            WHERE DATE(created_at) = CURDATE() AND status != 'cancelled')        AS today_revenue,
         (SELECT COALESCE(SUM(final_amount),0) FROM orders
            WHERE status != 'cancelled')                                          AS total_revenue,
         (SELECT COUNT(*) FROM orders)                                            AS total_orders`
    );

    const topRestaurants = await query(
      `SELECT r.id, r.name, r.slug, r.plan_type, r.city,
              COUNT(DISTINCT o.id) AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue
       FROM restaurants r
       LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status != 'cancelled'
       GROUP BY r.id
       ORDER BY total_revenue DESC
       LIMIT 10`
    );

    const revenueByDay = await query(
      `SELECT DATE(created_at) AS date,
              COUNT(*) AS orders,
              COALESCE(SUM(final_amount), 0) AS revenue
       FROM orders
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND status != 'cancelled'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );

    res.json({ success: true, data: { stats: stats, topRestaurants, revenueByDay } });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/platform-settings
router.get('/platform-settings', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const settings = await query('SELECT * FROM platform_settings');
    res.json({ success: true, data: settings });
  } catch (err) { next(err); }
});

// PUT /api/v1/superadmin/platform-settings
router.put('/platform-settings', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const { key, value } = req.body;
    await query(
      `INSERT INTO platform_settings (setting_key, setting_val)
       VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_val = ?`,
      [key, value, value]
    );
    res.json({ success: true, message: 'Setting updated' });
  } catch (err) { next(err); }
});

module.exports = router;