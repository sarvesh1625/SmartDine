const router = require('express').Router();
const { authenticate, isSuperAdmin } = require('../middleware/auth');
const { query, queryOne }            = require('../config/db');
const { AppError }                   = require('../middleware/errorHandler');

/* ───────────────────────── helpers ───────────────────────── */

// Never send payment secrets (PhonePe salt key, Razorpay/Cashfree secrets…) to the browser
const SECRET_KEY = /secret|salt|password|token/i;
function stripSecrets(row) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_KEY.test(k)));
}

// Last `days` calendar days (oldest first) with 0 for days that had no orders,
// so the 7-bar chart always has 7 bars.
async function revenueByDay(restaurantId = null, days = 7) {
  const rows = await query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date,
            COALESCE(SUM(final_amount), 0)      AS revenue,
            COUNT(*)                            AS orders
     FROM orders
     WHERE status != 'cancelled'
       AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)
       ${restaurantId ? 'AND restaurant_id = ?' : ''}
     GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')`,
    restaurantId ? [restaurantId] : []
  );
  const { today } = await queryOne(`SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today`);
  const [y, m, d] = today.split('-').map(Number);
  const base   = Date.UTC(y, m - 1, d);
  const byDate = new Map(rows.map(r => [r.date, r]));
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(base - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
    const r = byDate.get(date);
    return { date, revenue: r ? Number(r.revenue) : 0, orders: r ? Number(r.orders) : 0 };
  });
}

// One set of numbers used by both the Overview page and the Platform Stats page
async function platformStats() {
  const [s] = await query(
    `SELECT
       (SELECT COUNT(*) FROM restaurants)                                                     AS total_restaurants,
       (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'free')                            AS free_restaurants,
       (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'pro')                             AS pro_restaurants,
       (SELECT COUNT(*) FROM restaurants WHERE plan_type = 'enterprise')                      AS enterprise_restaurants,
       (SELECT COUNT(*) FROM restaurants WHERE plan_type IN ('pro', 'enterprise'))            AS paid_restaurants,
       (SELECT COUNT(*) FROM restaurants WHERE is_active = 0)                                 AS inactive_restaurants,
       (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURDATE() AND status != 'cancelled')              AS today_orders,
       (SELECT COALESCE(SUM(final_amount), 0) FROM orders WHERE DATE(created_at) = CURDATE() AND status != 'cancelled') AS today_revenue,
       (SELECT COUNT(*) FROM orders WHERE status != 'cancelled')                              AS total_orders,
       (SELECT COALESCE(SUM(final_amount), 0) FROM orders WHERE status != 'cancelled')        AS total_revenue,
       (SELECT COUNT(*) FROM users WHERE role = 'admin')                                      AS total_admins`
  );
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)]));
}

/* ───────────────────────── routes ───────────────────────── */

// GET /api/v1/superadmin/restaurants — list for the Restaurants page
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
    res.json({ success: true, data: rows.map(stripSecrets) });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/stats — numbers for the Overview page
router.get('/stats', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    res.json({ success: true, data: await platformStats() });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/analytics — Platform Stats page
router.get('/analytics', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const stats = await platformStats();

    const topRestaurants = (await query(
      `SELECT r.id, r.name, r.slug, r.plan_type, r.city, r.state,
              COUNT(o.id)                      AS total_orders,
              COALESCE(SUM(o.final_amount), 0) AS total_revenue
       FROM restaurants r
       LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status != 'cancelled'
       GROUP BY r.id, r.name, r.slug, r.plan_type, r.city, r.state
       ORDER BY total_revenue DESC
       LIMIT 10`
    )).map(r => ({ ...r, total_orders: Number(r.total_orders), total_revenue: Number(r.total_revenue) }));

    res.json({
      success: true,
      data: { stats, topRestaurants, revenueByDay: await revenueByDay(null, 7) },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/superadmin/restaurants/:id — everything in the slide-in detail panel
router.get('/restaurants/:id', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;

    const restaurant = await queryOne(
      `SELECT r.id, r.name, r.slug, r.email, r.phone, r.city, r.state,
              r.default_language, r.plan_type, r.is_active, r.created_at,
              (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id AND o.status != 'cancelled')                   AS total_orders,
              (SELECT COALESCE(SUM(o.final_amount), 0) FROM orders o WHERE o.restaurant_id = r.id AND o.status != 'cancelled') AS total_revenue,
              (SELECT COUNT(*) FROM menu_items m  WHERE m.restaurant_id = r.id)                                          AS menu_item_count,
              (SELECT COUNT(*) FROM tables_info t WHERE t.restaurant_id = r.id)                                          AS table_count,
              (SELECT COUNT(*) FROM users u       WHERE u.restaurant_id = r.id AND u.role != 'admin')                    AS staff_count,
              (SELECT ROUND(AVG(f.food_rating), 1) FROM feedback f WHERE f.restaurant_id = r.id)                         AS avg_food_rating,
              (SELECT MAX(o.created_at) FROM orders o WHERE o.restaurant_id = r.id)                                      AS last_order_at
       FROM restaurants r
       WHERE r.id = ?`,
      [id]
    );
    if (!restaurant) throw new AppError('Restaurant not found', 404);

    const topItems = (await query(
      `SELECT oi.item_name_snapshot              AS name,
              SUM(oi.quantity)                   AS total_sold,
              SUM(oi.quantity * oi.unit_price)   AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status != 'cancelled'
       GROUP BY oi.item_name_snapshot
       ORDER BY total_sold DESC
       LIMIT 5`,
      [id]
    )).map(i => ({ name: i.name, total_sold: Number(i.total_sold), revenue: Number(i.revenue) }));

    const recentOrders = await query(
      `SELECT id, customer_name, final_amount, status, created_at
       FROM orders WHERE restaurant_id = ?
       ORDER BY created_at DESC LIMIT 8`,
      [id]
    );

    const staff = await query(
      `SELECT id, name, email, role, is_active
       FROM users WHERE restaurant_id = ?
       ORDER BY FIELD(role, 'admin', 'staff', 'kitchen'), name`,
      [id]
    );

    res.json({
      success: true,
      data: {
        restaurant: {
          ...restaurant,
          total_orders:    Number(restaurant.total_orders),
          total_revenue:   Number(restaurant.total_revenue),
          menu_item_count: Number(restaurant.menu_item_count),
          table_count:     Number(restaurant.table_count),
          staff_count:     Number(restaurant.staff_count),
          avg_food_rating: restaurant.avg_food_rating == null ? null : Number(restaurant.avg_food_rating),
        },
        revenueByDay: await revenueByDay(id, 7),
        topItems,
        recentOrders,
        staff,
      },
    });
  } catch (err) { next(err); }
});

// PATCH /api/v1/superadmin/restaurants/:id/plan
router.patch('/restaurants/:id/plan', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const { plan_type, days } = req.body;
    if (!['free', 'pro', 'enterprise'].includes(plan_type)) {
      throw new AppError('plan_type must be free, pro, or enterprise', 400);
    }
    const restaurant = await queryOne('SELECT id FROM restaurants WHERE id = ?', [req.params.id]);
    if (!restaurant) throw new AppError('Restaurant not found', 404);

    await query('UPDATE restaurants SET plan_type = ? WHERE id = ?', [plan_type, req.params.id]);

    // Keep subscription records in step so the expiry job knows when this plan ends.
    // Granting a paid plan gives `days` days (default 30); moving to free closes it.
    await query(
      `UPDATE subscriptions SET status = 'cancelled'
       WHERE restaurant_id = ? AND status = 'active' AND plan_type IN ('pro', 'enterprise')`,
      [req.params.id]
    );
    let validDays = null;
    if (plan_type !== 'free') {
      validDays = Math.min(Math.max(parseInt(days) || 30, 1), 366);
      await query(
        `INSERT INTO subscriptions (restaurant_id, plan_type, start_date, end_date, amount_paid, status)
         VALUES (?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), 0, 'active')`,
        [req.params.id, plan_type, validDays]
      );
    }
    res.json({
      success: true,
      message: validDays ? `Plan updated to ${plan_type} for ${validDays} days` : `Plan updated to ${plan_type}`,
    });
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

module.exports = router;