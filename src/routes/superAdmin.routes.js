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