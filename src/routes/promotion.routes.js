const router = require('express').Router();
const { authenticate, isAdmin }         = require('../middleware/auth');
const { query, queryOne, getDB }        = require('../config/db');
const { AppError }                      = require('../middleware/errorHandler');
const { validate, createPromotionSchema } = require('../utils/validators');

// GET /api/v1/promotions
router.get('/', authenticate, isAdmin, async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT * FROM promotions WHERE restaurant_id = ? ORDER BY created_at DESC',
      [req.restaurantId]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/v1/promotions
router.post('/', authenticate, isAdmin, validate(createPromotionSchema), async (req, res, next) => {
  try {
    const { code, discount_type, discount_value, min_order_amount, valid_from, valid_to, max_uses } = req.body;

    const existing = await queryOne(
      'SELECT id FROM promotions WHERE restaurant_id = ? AND code = ?',
      [req.restaurantId, code.toUpperCase()]
    );
    if (existing) throw new AppError(`Coupon code "${code}" already exists`, 409);

    await getDB().execute(
      `INSERT INTO promotions
         (restaurant_id, code, discount_type, discount_value, min_order_amount, valid_from, valid_to, max_uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.restaurantId,
        code.toUpperCase(),
        discount_type,
        discount_value,
        min_order_amount || 0,
        valid_from,
        valid_to,
        max_uses || null,
      ]
    );
    res.status(201).json({ success: true, message: 'Promotion created' });
  } catch (err) { next(err); }
});

// PATCH /api/v1/promotions/:id/toggle  — activate / deactivate
router.patch('/:id/toggle', authenticate, isAdmin, async (req, res, next) => {
  try {
    const promo = await queryOne(
      'SELECT id, is_active FROM promotions WHERE id = ? AND restaurant_id = ?',
      [req.params.id, req.restaurantId]
    );
    if (!promo) throw new AppError('Promotion not found', 404);

    const newStatus = promo.is_active ? 0 : 1;
    await query('UPDATE promotions SET is_active = ? WHERE id = ?', [newStatus, req.params.id]);
    res.json({ success: true, message: `Promotion ${newStatus ? 'activated' : 'deactivated'}` });
  } catch (err) { next(err); }
});

// DELETE /api/v1/promotions/:id
router.delete('/:id', authenticate, isAdmin, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM promotions WHERE id = ? AND restaurant_id = ?',
      [req.params.id, req.restaurantId]
    );
    if (!result.affectedRows) throw new AppError('Promotion not found', 404);
    res.json({ success: true, message: 'Promotion deleted' });
  } catch (err) { next(err); }
});

// POST /api/v1/promotions/validate  — public, used at checkout
router.post('/validate', async (req, res, next) => {
  try {
    const { restaurantId, code, orderAmount } = req.body;
    if (!restaurantId || !code || orderAmount == null) {
      throw new AppError('restaurantId, code, and orderAmount are required', 400);
    }

    const promo = await queryOne(
      `SELECT * FROM promotions
       WHERE restaurant_id = ? AND code = ? AND is_active = 1
         AND valid_from <= NOW() AND valid_to >= NOW()
         AND (max_uses IS NULL OR used_count < max_uses)`,
      [restaurantId, code.toUpperCase()]
    );
    if (!promo) throw new AppError('Invalid or expired coupon', 400);
    if (orderAmount < promo.min_order_amount) {
      throw new AppError(`Minimum order amount of ₹${promo.min_order_amount} required for this coupon`, 400);
    }

    const discount = promo.discount_type === 'percent'
      ? (orderAmount * promo.discount_value) / 100
      : promo.discount_value;

    res.json({
      success: true,
      data: {
        discount:      Math.min(Math.round(discount * 100) / 100, orderAmount),
        discount_type: promo.discount_type,
        code:          promo.code,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;