const router = require('express').Router();
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/verify-widget-token
// Body: { token }  — the access-token returned by MSG91 widget's success callback
// This confirms server-side that the OTP was genuinely verified by MSG91,
// not just trusted from the frontend.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify-widget-token', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) throw new AppError('Verification token is required', 400);

    const authkey = process.env.MSG91_AUTH_KEY;
    if (!authkey) throw new AppError('OTP service not configured', 503);

    const response = await fetch('https://control.msg91.com/api/v5/widget/verifyAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authkey, 'access-token': token }),
    });
    const data = await response.json();

    if (data.type !== 'success') {
      logger.error(`MSG91 widget token verify failed: ${JSON.stringify(data)}`);
      return res.status(400).json({ success: false, message: 'Phone verification failed. Please try again.' });
    }

    res.json({ success: true, message: 'Phone number verified' });
  } catch (err) { next(err); }
});

module.exports = router;