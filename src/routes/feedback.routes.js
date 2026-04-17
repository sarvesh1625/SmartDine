const router = require('express').Router();
const { authenticate, isAdmin } = require('../middleware/auth');
const { query, getDB }          = require('../config/db');
const { AppError }              = require('../middleware/errorHandler');
const { validate, feedbackSchema } = require('../utils/validators');

// POST /api/v1/feedback  — public, customer submits after delivery
router.post('/', validate(feedbackSchema), async (req, res, next) => {
  try {
    const { orderId, restaurantId, foodRating, serviceRating, comment } = req.body;

    // Make sure the order belongs to this restaurant and is delivered
    const order = await require('../config/db').queryOne(
      'SELECT id FROM orders WHERE id = ? AND restaurant_id = ? AND status = ?',
      [orderId, restaurantId, 'delivered']
    );
    if (!order) throw new AppError('Order not found or not yet delivered', 400);

    // Prevent duplicate feedback
    const already = await require('../config/db').queryOne(
      'SELECT id FROM feedback WHERE order_id = ?',
      [orderId]
    );
    if (already) throw new AppError('Feedback already submitted for this order', 409);

    await getDB().execute(
      `INSERT INTO feedback (restaurant_id, order_id, food_rating, service_rating, comment)
       VALUES (?, ?, ?, ?, ?)`,
      [restaurantId, orderId, foodRating, serviceRating, comment || null]
    );

    res.status(201).json({ success: true, message: 'Thank you for your feedback!' });
  } catch (err) { next(err); }
});

// GET /api/v1/feedback  — admin views all feedback with averages
router.get('/', authenticate, isAdmin, async (req, res, next) => {
  try {
    const reviews = await query(
      `SELECT f.id, f.food_rating, f.service_rating, f.comment, f.created_at,
              o.customer_name, o.id AS order_id
       FROM feedback f
       JOIN orders o ON o.id = f.order_id
       WHERE f.restaurant_id = ?
       ORDER BY f.created_at DESC
       LIMIT 50`,
      [req.restaurantId]
    );

    const [averages] = await query(
      `SELECT
         ROUND(AVG(food_rating), 1)    AS avg_food,
         ROUND(AVG(service_rating), 1) AS avg_service,
         COUNT(*)                      AS total_reviews
       FROM feedback WHERE restaurant_id = ?`,
      [req.restaurantId]
    );

    res.json({ success: true, data: { reviews, averages } });
  } catch (err) { next(err); }
});

module.exports = router;