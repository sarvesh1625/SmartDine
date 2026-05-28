const router  = require('express').Router();
const { authenticate, isAdmin } = require('../middleware/auth');
const { query }  = require('../config/db');

// GET /api/v1/analytics/summary
// Today's revenue, order count, total all-time, top 5 items, avg order value
router.get('/summary', authenticate, isAdmin, async (req, res, next) => {
  try {
    const [today] = await query(
      `SELECT
         COALESCE(SUM(final_amount), 0)                              AS today_revenue,
         COUNT(*)                                                    AS today_orders,
         COALESCE(AVG(final_amount), 0)                             AS today_avg_order_value
       FROM orders
       WHERE restaurant_id = ? AND DATE(created_at) = CURDATE() AND status != 'cancelled'`,
      [req.restaurantId]
    );

    const [allTime] = await query(
      `SELECT
         COALESCE(SUM(final_amount), 0) AS total_revenue,
         COUNT(*)                       AS total_orders
       FROM orders
       WHERE restaurant_id = ? AND status != 'cancelled'`,
      [req.restaurantId]
    );

    const topItems = await query(
      `SELECT oi.item_name_snapshot AS name, SUM(oi.quantity) AS total_sold,
              SUM(oi.quantity * oi.unit_price) AS total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status != 'cancelled'
       GROUP BY oi.item_name_snapshot
       ORDER BY total_sold DESC
       LIMIT 5`,
      [req.restaurantId]
    );

    const [ratings] = await query(
      `SELECT
         ROUND(AVG(food_rating), 1)    AS avg_food_rating,
         ROUND(AVG(service_rating), 1) AS avg_service_rating,
         COUNT(*)                      AS total_reviews
       FROM feedback WHERE restaurant_id = ?`,
      [req.restaurantId]
    );

    res.json({
      success: true,
      data: { ...today, ...allTime, topItems, ...ratings },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/analytics/revenue?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/revenue', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const startDate = from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const endDate   = to   || new Date().toISOString().split('T')[0];

    const rows = await query(
      `SELECT
         DATE(created_at)               AS date,
         COALESCE(SUM(final_amount), 0) AS revenue,
         COUNT(*)                       AS orders
       FROM orders
       WHERE restaurant_id = ? AND status != 'cancelled'
         AND DATE(created_at) BETWEEN ? AND ?
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [req.restaurantId, startDate, endDate]
    );

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/analytics/top-items?limit=10
router.get('/top-items', authenticate, isAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const rows = await query(
      `SELECT
         oi.item_name_snapshot                 AS name,
         SUM(oi.quantity)                      AS total_sold,
         SUM(oi.quantity * oi.unit_price)      AS total_revenue,
         ROUND(AVG(oi.unit_price), 2)          AS avg_price
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status != 'cancelled'
       GROUP BY oi.item_name_snapshot
       ORDER BY total_sold DESC
       LIMIT ?`,
      [req.restaurantId, parseInt(limit, 10)]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/analytics/peak-hours
router.get('/peak-hours', authenticate, isAdmin, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT
         HOUR(created_at)               AS hour,
         COUNT(*)                       AS order_count,
         COALESCE(SUM(final_amount), 0) AS revenue
       FROM orders
       WHERE restaurant_id = ? AND status != 'cancelled'
       GROUP BY HOUR(created_at)
       ORDER BY hour ASC`,
      [req.restaurantId]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/v1/analytics/feedback
router.get('/feedback', authenticate, isAdmin, async (req, res, next) => {
  try {
    const [averages] = await query(
      `SELECT
         ROUND(AVG(food_rating), 1)    AS avg_food,
         ROUND(AVG(service_rating), 1) AS avg_service,
         COUNT(*)                      AS total
       FROM feedback WHERE restaurant_id = ?`,
      [req.restaurantId]
    );

    // Rating distribution (1–5) for food
    const distribution = await query(
      `SELECT food_rating AS rating, COUNT(*) AS count
       FROM feedback WHERE restaurant_id = ?
       GROUP BY food_rating ORDER BY food_rating ASC`,
      [req.restaurantId]
    );

    const recent = await query(
      `SELECT f.food_rating, f.service_rating, f.comment, f.created_at, o.customer_name
       FROM feedback f
       JOIN orders o ON o.id = f.order_id
       WHERE f.restaurant_id = ?
       ORDER BY f.created_at DESC LIMIT 10`,
      [req.restaurantId]
    );

    res.json({ success: true, data: { averages, distribution, recent } });
  } catch (err) { next(err); }
});

module.exports = router;