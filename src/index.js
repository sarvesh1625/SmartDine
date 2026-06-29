require('dotenv').config();
const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const { connectDB }       = require('./config/db');
const { connectRedis }    = require('./config/redis');
const { initSocket }      = require('./socket');
const { errorHandler }    = require('./middleware/errorHandler');
const { notFound }        = require('./middleware/notFound');
const logger              = require('./utils/logger');

const authRoutes       = require('./routes/auth.routes');
const restaurantRoutes = require('./routes/restaurant.routes');
const categoryRoutes   = require('./routes/category.routes');
const menuItemRoutes   = require('./routes/menuItem.routes');
const orderRoutes      = require('./routes/order.routes');
const paymentRoutes    = require('./routes/payment.routes');
const analyticsRoutes  = require('./routes/analytics.routes');
const feedbackRoutes   = require('./routes/feedback.routes');
const promotionRoutes  = require('./routes/promotion.routes');
const superAdminRoutes = require('./routes/superAdmin.routes');
const billingRoutes    = require('./routes/billing.routes');
const bookingRoutes    = require('./routes/booking.routes');
const webhookRoutes    = require('./routes/payment_webhook.routes');

const app    = express();
const server = http.createServer(app);

// Trust Render's proxy — required for rate limiter to work correctly
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:      process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Global rate limiter
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
}));

// Auth rate limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 100,
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
  message: { success: false, message: 'Too many login attempts, please try again later.' },
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ success: true, status: 'ok', timestamp: new Date() }));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/v1/auth',       authLimiter, authRoutes);
app.use('/api/v1/bookings',   bookingRoutes);
app.use('/api/v1/restaurant', restaurantRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/menu-items', menuItemRoutes);
app.use('/api/v1/orders',     orderRoutes);
app.use('/api/v1/payments',   paymentRoutes);
app.use('/api/v1/analytics',  analyticsRoutes);
app.use('/api/v1/feedback',   feedbackRoutes);
app.use('/api/v1/promotions', promotionRoutes);
app.use('/api/v1/superadmin', superAdminRoutes);
app.use('/api/v1/billing',    billingRoutes);
app.use('/api/v1/webhooks',   webhookRoutes);

// ── 404 & error handling ──────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await connectDB();
    logger.info('MySQL connected');

    await connectRedis();

    initSocket(server);

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`MenuCloud API running on port ${PORT}`);

      // Keep Render server warm — ping every 14 min to prevent cold starts
      if (process.env.NODE_ENV === 'production') {
        setInterval(async () => {
          try {
            const url = process.env.BACKEND_URL || 'https://suvidha-backend.onrender.com';
            await fetch(`${url}/health`);
            logger.info('Keep-alive ping sent');
          } catch {}
        }, 14 * 60 * 1000);
      }
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

module.exports = { app, server };