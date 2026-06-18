const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const uuid      = require('uuid');
const { query, queryOne, transaction } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const uuidv4 = () => uuid.v4();

function generateTokens(user) {
  const payload = {
    userId:       user.id,
    restaurantId: user.restaurant_id,
    role:         user.role,
  };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
  });
  const refreshToken = jwt.sign(
    { userId: user.id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d' }
  );
  return { accessToken, refreshToken };
}

async function register(req, res, next) {
  try {
    const { restaurantName, ownerName, email, password, phone, city, state } = req.body;

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw new AppError('Email already registered', 409);

    let slug = restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slugExists = await queryOne('SELECT id FROM restaurants WHERE slug = ?', [slug]);
    if (slugExists) slug = `${slug}-${Date.now()}`;

    await transaction(async (conn) => {
      const restaurantId = uuidv4();
      await conn.execute(
        `INSERT INTO restaurants (id, name, slug, phone, email, city, state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [restaurantId, restaurantName, slug, phone, email, city || null, state || null]
      );

      const userId       = uuidv4();
      const passwordHash = await bcrypt.hash(password, 12);
      await conn.execute(
        `INSERT INTO users (id, restaurant_id, name, email, password_hash, role, phone)
         VALUES (?, ?, ?, ?, ?, 'admin', ?)`,
        [userId, restaurantId, ownerName, email, passwordHash, phone]
      );

      await conn.execute(
        `INSERT INTO subscriptions (restaurant_id, plan_type, start_date, end_date, amount_paid)
         VALUES (?, 'free', CURDATE(), DATE_ADD(CURDATE(), INTERVAL 100 YEAR), 0)`,
        [restaurantId]
      );

      await conn.execute(
        `UPDATE restaurants SET trial_ends_at = DATE_ADD(NOW(), INTERVAL 15 DAY) WHERE id = ?`,
        [restaurantId]
      );

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      await conn.execute(
        `INSERT INTO tables_info (restaurant_id, table_number, label, qr_code_url)
         VALUES (?, '1', 'Takeaway / Table 1', ?)`,
        [restaurantId, `${frontendUrl}/menu/${slug}/table/1`]
      );

      logger.info(`New restaurant registered: ${restaurantName} (${slug}) — default table created`);
    });

    res.status(201).json({
      success: true,
      message: 'Restaurant registered successfully! Please login.',
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const user = await queryOne(
      `SELECT u.*, r.name AS restaurant_name, r.slug, r.plan_type,
              r.is_active AS restaurant_active, r.id AS rid,
              r.trial_ends_at
       FROM users u
       LEFT JOIN restaurants r ON r.id = u.restaurant_id
       WHERE u.email = ?`,
      [email]
    );

    if (!user) throw new AppError('Invalid email or password', 401);
    if (!user.is_active) throw new AppError('Your account has been deactivated', 403);
    if (user.restaurant_id && !user.restaurant_active) {
      throw new AppError('Your restaurant account has been deactivated', 403);
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) throw new AppError('Invalid email or password', 401);

    const trialEndsAt   = user.trial_ends_at;
    const trialDaysLeft = trialEndsAt
      ? Math.max(0, Math.ceil((new Date(trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)))
      : 0;
    const isTrialActive = trialDaysLeft > 0;
    const planType      = user.plan_type || 'free';
    const hasAccess     = planType !== 'free' || isTrialActive;

    const { accessToken, refreshToken } = generateTokens({
      ...user,
      trialDaysLeft,
      isTrialActive,
      hasAccess,
    });

    // Store refresh token in DB — survives server restarts
    await query('DELETE FROM refresh_tokens WHERE user_id = ?', [user.id]);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [user.id, refreshToken]
    );

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id:             user.id,
          name:           user.name,
          email:          user.email,
          role:           user.role,
          restaurantId:   user.restaurant_id,
          restaurantName: user.restaurant_name,
          restaurantSlug: user.slug,
          planType:       user.plan_type,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

async function refreshToken(req, res, next) {
  try {
    const { refreshToken: token } = req.body;
    if (!token) throw new AppError('Refresh token required', 400);

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check token in DB instead of cache
    const stored = await queryOne(
      `SELECT token_hash FROM refresh_tokens
       WHERE user_id = ? AND expires_at > NOW()`,
      [decoded.userId]
    );
    if (!stored || stored.token_hash !== token) {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const user = await queryOne(
      'SELECT id, restaurant_id, role, is_active FROM users WHERE id = ?',
      [decoded.userId]
    );
    if (!user || !user.is_active) throw new AppError('User not found', 401);

    const { accessToken, refreshToken: newRefresh } = generateTokens(user);

    // Rotate refresh token in DB
    await query('DELETE FROM refresh_tokens WHERE user_id = ?', [user.id]);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [user.id, newRefresh]
    );

    res.json({ success: true, data: { accessToken, refreshToken: newRefresh } });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    await query('DELETE FROM refresh_tokens WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

async function getMe(req, res, next) {
  try {
    const user = await queryOne(
      `SELECT u.id, u.name, u.email, u.role, u.phone,
              r.id AS restaurant_id, r.name AS restaurant_name,
              r.slug, r.logo_url, r.plan_type, r.city, r.state, r.default_language
       FROM users u
       LEFT JOIN restaurants r ON r.id = u.restaurant_id
       WHERE u.id = ?`,
      [req.user.id]
    );
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await queryOne(
      'SELECT id, password_hash FROM users WHERE id = ?',
      [req.user.id]
    );
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) throw new AppError('Current password is incorrect', 400);

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

    // Invalidate refresh token on password change
    await query('DELETE FROM refresh_tokens WHERE user_id = ?', [req.user.id]);

    res.json({ success: true, message: 'Password changed successfully. Please login again.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, refreshToken, logout, getMe, changePassword };