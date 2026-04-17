const { queryOne } = require('../config/db');
const { AppError }  = require('./errorHandler');

/**
 * Middleware: block access if restaurant's trial has expired
 * and they haven't upgraded to a paid plan.
 * Attach trial info to req for downstream use.
 */
async function trialCheck(req, res, next) {
  try {
    // Only applies to restaurant admins
    if (!req.restaurantId) return next();
    if (req.role === 'super_admin') return next();

    const restaurant = await queryOne(
      `SELECT id, plan_type, trial_ends_at, is_active FROM restaurants WHERE id = ?`,
      [req.restaurantId]
    );

    if (!restaurant) return next(new AppError('Restaurant not found', 404));
    if (!restaurant.is_active) return next(new AppError('Restaurant deactivated', 403));

    const now          = new Date();
    const trialEndsAt  = restaurant.trial_ends_at ? new Date(restaurant.trial_ends_at) : null;
    const trialDaysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - now) / (1000*60*60*24))) : 0;
    const isTrialActive = trialDaysLeft > 0;
    const planType      = restaurant.plan_type;
    const isPaid        = planType === 'pro' || planType === 'enterprise';
    const hasAccess     = isPaid || isTrialActive;

    // Attach to request for controllers
    req.trial = { trialDaysLeft, isTrialActive, planType, isPaid, hasAccess };

    if (!hasAccess) {
      return res.status(402).json({
        success:      false,
        code:         'TRIAL_EXPIRED',
        message:      'Your 15-day free trial has ended. Please upgrade to continue.',
        trialDaysLeft: 0,
        planType,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { trialCheck };