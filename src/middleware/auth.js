const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/db');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await queryOne(
      'SELECT id, restaurant_id, name, email, role, is_active FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }

    req.user         = user;
    req.restaurantId = user.restaurant_id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${roles.join(', ')}`
      });
    }
    next();
  };
}

const isAdmin      = authorize('admin', 'super_admin');
const isStaff      = authorize('admin', 'staff', 'super_admin');
const isKitchen    = authorize('admin', 'staff', 'kitchen', 'super_admin');
const isSuperAdmin = authorize('super_admin');

module.exports = { authenticate, authorize, isAdmin, isStaff, isKitchen, isSuperAdmin };