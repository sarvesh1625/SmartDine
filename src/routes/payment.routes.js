const router  = require('express').Router();
const crypto  = require('crypto');
const Razorpay = require('razorpay');
const { authenticate, isAdmin } = require('../middleware/auth');
const { query, queryOne }       = require('../config/db');
const { AppError }              = require('../middleware/errorHandler');

// Lazily create the Razorpay instance so the app boots even without keys
function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new AppError('Razorpay credentials not configured', 503);
  }
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// POST /api/v1/payments/create-order
// Body: { orderId }   (our internal order UUID)
router.post('/create-order', async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) throw new AppError('orderId is required', 400);

    const order = await queryOne(
      `SELECT id, final_amount, payment_status, restaurant_id
       FROM orders WHERE id = ?`,
      [orderId]
    );
    if (!order) throw new AppError('Order not found', 404);
    if (order.payment_status === 'paid') throw new AppError('Order already paid', 400);

    const rzp = getRazorpay();
    const rzpOrder = await rzp.orders.create({
      amount:   Math.round(order.final_amount * 100), // paise
      currency: 'INR',
      receipt:  `mcl_${orderId.slice(0, 20)}`,
      notes:    { menucloud_order_id: orderId },
    });

    // Store the razorpay_order_id so we can verify later
    await query(
      'UPDATE orders SET razorpay_order_id = ? WHERE id = ?',
      [rzpOrder.id, orderId]
    );

    res.json({
      success: true,
      data: {
        razorpayOrderId: rzpOrder.id,
        amount:          rzpOrder.amount,
        currency:        rzpOrder.currency,
        keyId:           process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/payments/verify
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId }
router.post('/verify', async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
      throw new AppError('razorpay_order_id, razorpay_payment_id, razorpay_signature and orderId are required', 400);
    }

    // Signature verification — server-side, never trust the client
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      throw new AppError('Payment verification failed — invalid signature', 400);
    }

    const order = await queryOne(
      'SELECT id, final_amount, razorpay_order_id FROM orders WHERE id = ?',
      [orderId]
    );
    if (!order) throw new AppError('Order not found', 404);
    if (order.razorpay_order_id !== razorpay_order_id) {
      throw new AppError('Order ID mismatch', 400);
    }

    await query(
      `UPDATE orders
       SET payment_status = 'paid', payment_method = 'razorpay', razorpay_payment_id = ?
       WHERE id = ?`,
      [razorpay_payment_id, orderId]
    );

    res.json({ success: true, message: 'Payment verified successfully', data: { orderId } });
  } catch (err) { next(err); }
});

// GET /api/v1/payments/history  [Admin only]
router.get('/history', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, from, to } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `SELECT id, customer_name, final_amount, payment_method, payment_status,
                      razorpay_order_id, created_at
               FROM orders
               WHERE restaurant_id = ? AND payment_status = 'paid'`;
    const params = [req.restaurantId];

    if (from) { sql += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)   { sql += ' AND DATE(created_at) <= ?'; params.push(to); }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const rows = await query(sql, params);

    const [totals] = await query(
      `SELECT COALESCE(SUM(final_amount), 0) AS total_collected, COUNT(*) AS total_transactions
       FROM orders WHERE restaurant_id = ? AND payment_status = 'paid'`,
      [req.restaurantId]
    );

    res.json({
      success: true,
      data: rows,
      meta: { ...totals, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (err) { next(err); }
});

module.exports = router;