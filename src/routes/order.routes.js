const router = require('express').Router();
const c      = require('../controllers/order.controller');
const { authenticate, isStaff, isKitchen }                  = require('../middleware/auth');
const { validate, placeOrderSchema, updateOrderStatusSchema } = require('../utils/validators');
const { query, queryOne } = require('../config/db');

router.post ('/',              validate(placeOrderSchema),        c.placeOrder);
router.get  ('/',              authenticate, isStaff,             c.getOrders);
router.get  ('/kitchen-queue', authenticate, isKitchen,           c.getKitchenQueue);
router.get  ('/:id',           authenticate, isStaff,             c.getOrder);
router.patch('/:id/status',    authenticate, isKitchen, validate(updateOrderStatusSchema), c.updateOrderStatus);

// Public order tracking — customers can check their order status without auth
router.get('/track/:orderId', async (req, res, next) => {
  try {
    const order = await queryOne(
      `SELECT o.id, o.status, o.customer_name, o.final_amount,
              o.discount_amount, o.special_instructions, o.created_at,
              o.restaurant_id, r.name AS restaurant_name, r.slug
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = ?`,
      [req.params.orderId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.items = await query(
      'SELECT item_name_snapshot, quantity, unit_price FROM order_items WHERE order_id = ?',
      [req.params.orderId]
    );

    res.json({ success: true, data: order });
  } catch (err) { next(err); }
});

module.exports = router;