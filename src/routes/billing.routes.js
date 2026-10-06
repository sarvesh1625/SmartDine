const router   = require('express').Router();
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const { authenticate, isAdmin } = require('../middleware/auth');
const { query, queryOne }       = require('../config/db');
const { AppError }              = require('../middleware/errorHandler');
const logger                    = require('../utils/logger');
const { expireSubscriptions }   = require('../utils/subscriptionExpiry');

const PLANS = {
  pro:        { amount: 49900,  label: 'Pro',        period_days: 30  },   // ₹499
  enterprise: { amount: 169900, label: 'Enterprise',  period_days: 30  },   // ₹1,699
};

const razorpay = process.env.RAZORPAY_KEY_ID ? new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
}) : null;

/* ── GET /api/v1/billing/status ── */
router.get('/status', authenticate, isAdmin, async (req, res, next) => {
  try {
    // Branches follow their main restaurant's subscription
    const self = await queryOne(
      'SELECT id, parent_restaurant_id FROM restaurants WHERE id = ?', [req.restaurantId]
    );
    if (!self) throw new AppError('Restaurant not found', 404);
    const rootId = self.parent_restaurant_id || self.id;

    // Make sure a lapsed paid plan is switched off right now, not at the next hourly run
    await expireSubscriptions(rootId).catch(err => logger.error(`expire check failed: ${err.message}`));

    const restaurant = await queryOne(
      `SELECT id, name, plan_type, created_at,
              COALESCE(trial_ends_at, DATE_ADD(created_at, INTERVAL 15 DAY)) AS trial_ends_at
       FROM restaurants WHERE id = ?`,
      [req.restaurantId]
    );

    const now           = new Date();
    const trialEndsAt   = restaurant.trial_ends_at ? new Date(restaurant.trial_ends_at) : null;
    const trialDaysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - now) / (1000*60*60*24))) : 0;
    const isTrialActive = trialDaysLeft > 0;
    const isPaid        = restaurant.plan_type !== 'free';
    const hasAccess     = isPaid || isTrialActive;

    // Current paid subscription (if any)
    const subscription = await queryOne(
      `SELECT * FROM subscriptions
       WHERE restaurant_id = ? AND status = 'active' AND plan_type IN ('pro','enterprise')
       ORDER BY end_date DESC LIMIT 1`,
      [rootId]
    );

    let planDaysLeft = null;
    if (subscription) {
      const end = new Date(subscription.end_date);
      end.setHours(23, 59, 59, 999);
      planDaysLeft = Math.max(0, Math.ceil((end - now) / (1000*60*60*24)));
    }

    // Did a paid plan run out? (lets the app say "plan expired" instead of "trial expired")
    const lastExpired = !isPaid ? await queryOne(
      `SELECT plan_type, end_date FROM subscriptions
       WHERE restaurant_id = ? AND plan_type IN ('pro','enterprise') AND status = 'expired'
       ORDER BY end_date DESC LIMIT 1`,
      [rootId]
    ) : null;

    res.json({
      success: true,
      data: {
        planType:      restaurant.plan_type,
        trialDaysLeft,
        isTrialActive,
        isPaid,
        hasAccess,
        trialEndsAt:   restaurant.trial_ends_at,
        subscription,
        planEndsAt:    subscription?.end_date || null,
        planDaysLeft,
        planExpired:   !!lastExpired,
        expiredPlan:   lastExpired?.plan_type || null,
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
      receipt:  `plan_${req.restaurantId.slice(0,8)}_${Date.now().toString().slice(-8)}`,
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
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new AppError('Missing payment details', 400);
    }
    if (!razorpay) throw new AppError('Payment gateway not configured. Contact support.', 503);

    // Verify signature
    const generated = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (generated !== razorpay_signature) throw new AppError('Payment verification failed', 400);

    // Same payment submitted twice? Don't extend the plan twice.
    const already = await queryOne(
      'SELECT plan_type FROM subscriptions WHERE razorpay_subscription_id = ?', [razorpay_payment_id]
    );
    if (already) {
      return res.json({ success: true, message: 'Payment already applied', data: { plan_type: already.plan_type } });
    }

    // Take the plan from Razorpay's own record of the order — not from the browser —
    // so nobody can pay for Pro and claim Enterprise.
    let order;
    try {
      order = await razorpay.orders.fetch(razorpay_order_id);
    } catch (e) {
      logger.error(`Razorpay order fetch failed: ${e.message}`);
      throw new AppError('Could not confirm the payment with Razorpay. If money was deducted, contact support.', 502);
    }
    const plan_type = order.notes?.plan_type;
    const plan      = PLANS[plan_type];
    if (!plan) throw new AppError('Invalid plan', 400);
    if (order.notes?.restaurantId !== req.restaurantId) throw new AppError('This payment belongs to another restaurant', 403);
    if (Number(order.amount) !== plan.amount) throw new AppError('Payment amount does not match the plan', 400);

    // Renewing before expiry? Keep the days that are left (same plan only).
    const current = await queryOne(
      `SELECT end_date FROM subscriptions
       WHERE restaurant_id = ? AND plan_type = ? AND status = 'active' AND end_date >= CURDATE()
       ORDER BY end_date DESC LIMIT 1`,
      [req.restaurantId, plan_type]
    );
    const base    = current ? new Date(current.end_date) : new Date();
    const endDate = new Date(base.getTime() + plan.period_days * 24 * 60 * 60 * 1000);

    await query('UPDATE restaurants SET plan_type = ? WHERE id = ?', [plan_type, req.restaurantId]);

    await query(
      `UPDATE subscriptions SET status = 'cancelled' WHERE restaurant_id = ? AND status = 'active'`,
      [req.restaurantId]
    );

    await query(
      `INSERT INTO subscriptions (restaurant_id, plan_type, start_date, end_date, amount_paid, razorpay_subscription_id, status)
       VALUES (?, ?, CURDATE(), ?, ?, ?, 'active')`,
      [req.restaurantId, plan_type, endDate.toISOString().split('T')[0], plan.amount / 100, razorpay_payment_id]
    );

    logger.info(`Plan upgraded: ${req.restaurantId} → ${plan_type} until ${endDate.toISOString().split('T')[0]}`);

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
    if (req.user.role !== 'super_admin') throw new AppError('Forbidden', 403);
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