const router   = require('express').Router();
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const { authenticate, isAdmin } = require('../middleware/auth');
const { query, queryOne }       = require('../config/db');
const { AppError }              = require('../middleware/errorHandler');
const logger                    = require('../utils/logger');

const PLANS = {
  pro:        { amount: 99900,  label: 'Pro',        period_days: 30  },
  enterprise: { amount: 299900, label: 'Enterprise',  period_days: 30  },
};

const razorpay = process.env.RAZORPAY_KEY_ID ? new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
}) : null;

/* ── GET /api/v1/billing/status ── */
router.get('/status', authenticate, isAdmin, async (req, res, next) => {
  try {
    // For branches: read plan from parent restaurant
    const self = await queryOne(
      'SELECT id, name, plan_type, created_at, parent_restaurant_id, DATE_ADD(created_at, INTERVAL 15 DAY) AS trial_ends_at FROM restaurants WHERE id = ?',
      [req.restaurantId]
    );
    if (!self) throw new AppError('Restaurant not found', 404);

    // If this is a branch, use parent's plan
    const rootId     = self.parent_restaurant_id || self.id;
    const restaurant = self.parent_restaurant_id
      ? await queryOne('SELECT id, name, plan_type, created_at, DATE_ADD(created_at, INTERVAL 15 DAY) AS trial_ends_at FROM restaurants WHERE id = ?', [rootId])
      : self;

    const now           = new Date();
    const trialEndsAt   = restaurant.trial_ends_at ? new Date(restaurant.trial_ends_at) : null;
    const trialDaysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - now) / (1000*60*60*24))) : 0;
    const isTrialActive = trialDaysLeft > 0;
    const isPaid        = restaurant.plan_type !== 'free';
    const hasAccess     = isPaid || isTrialActive;

    // Get current active subscription from root
    const subscription = await queryOne(
      `SELECT * FROM subscriptions WHERE restaurant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [rootId]
    );

    res.json({
      success: true,
      data: {
        planType:      restaurant.plan_type,
        isBranch:      !!self.parent_restaurant_id,
        rootRestaurantId: rootId,
        trialDaysLeft,
        isTrialActive,
        isPaid,
        hasAccess,
        trialEndsAt:   restaurant.trial_ends_at,
        subscription,
        registeredAt:  restaurant.created_at,
      },
    });
  } catch (err) { next(err); }
});

/* ── POST /api/v1/billing/create-order ── */
router.post('/create-order', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { plan_type } = req.body;
    logger.info(`create-order: plan_type=${plan_type} restaurantId=${req.restaurantId} role=${req.user?.role}`);
    if (!plan_type) throw new AppError('plan_type is required (pro or enterprise)', 400);
    if (!PLANS[plan_type]) throw new AppError(`Invalid plan "${plan_type}". Must be "pro" or "enterprise"`, 400);
    if (!razorpay) throw new AppError('Payment gateway not configured. Contact support.', 503);

    const plan  = PLANS[plan_type];
    const order = await razorpay.orders.create({
      amount:   plan.amount,
      currency: 'INR',
      receipt:  `plan_${req.restaurantId}_${Date.now()}`,
      notes:    { restaurantId: req.restaurantId, plan_type },
    });

    res.json({
      success: true,
      data: {
        orderId:  order.id,
        amount:   plan.amount,
        currency: 'INR',
        keyId:    process.env.RAZORPAY_KEY_ID,
        plan_type,
        planLabel: plan.label,
      },
    });
  } catch (err) { next(err); }
});

/* ── POST /api/v1/billing/verify-payment ── */
router.post('/verify-payment', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_type } = req.body;

    // Verify signature
    const generated = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generated !== razorpay_signature) throw new AppError('Payment verification failed', 400);

    const plan = PLANS[plan_type];
    if (!plan) throw new AppError('Invalid plan', 400);

    const now       = new Date();
    const endDate   = new Date(now.getTime() + plan.period_days * 24 * 60 * 60 * 1000);

    // Update restaurant plan
    await query('UPDATE restaurants SET plan_type = ? WHERE id = ?', [plan_type, req.restaurantId]);

    // Cancel existing subscriptions
    await query(
      `UPDATE subscriptions SET status = 'cancelled' WHERE restaurant_id = ? AND status = 'active'`,
      [req.restaurantId]
    );

    // Insert new subscription
    await query(
      `INSERT INTO subscriptions (restaurant_id, plan_type, start_date, end_date, amount_paid, razorpay_subscription_id, status)
       VALUES (?, ?, CURDATE(), ?, ?, ?, 'active')`,
      [req.restaurantId, plan_type, endDate.toISOString().split('T')[0], plan.amount / 100, razorpay_payment_id]
    );

    logger.info(`Plan upgraded: ${req.restaurantId} → ${plan_type}`);

    res.json({
      success: true,
      message: `Successfully upgraded to ${plan.label} plan!`,
      data: { plan_type, validUntil: endDate },
    });
  } catch (err) { next(err); }
});

/* ── POST /api/v1/billing/manual-upgrade (super admin only) ── */
router.post('/manual-upgrade', authenticate, async (req, res, next) => {
  try {
    if (req.role !== 'super_admin') throw new AppError('Forbidden', 403);
    const { restaurant_id, plan_type, days = 30 } = req.body;
    if (!PLANS[plan_type] && plan_type !== 'free') throw new AppError('Invalid plan', 400);

    await query('UPDATE restaurants SET plan_type = ? WHERE id = ?', [plan_type, restaurant_id]);

    if (plan_type !== 'free') {
      await query(
        `UPDATE subscriptions SET status = 'cancelled' WHERE restaurant_id = ? AND status = 'active'`,
        [restaurant_id]
      );
      await query(
        `INSERT INTO subscriptions (restaurant_id, plan_type, start_date, end_date, amount_paid, status)
         VALUES (?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), 0, 'active')`,
        [restaurant_id, plan_type, days]
      );
    }

    res.json({ success: true, message: `Plan updated to ${plan_type}` });
  } catch (err) { next(err); }
});

module.exports = router;