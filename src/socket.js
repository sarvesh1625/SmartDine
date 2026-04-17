const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const logger     = require('./utils/logger');

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin:  process.env.FRONTEND_URL || '*',
      methods: ['GET', 'POST'],
    },
  });

  // Auth middleware — staff / kitchen / admin must pass a valid JWT
  // Customers connect to a public room without auth
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      // Allow unauthenticated sockets for customer order tracking
      socket.role         = 'customer';
      socket.restaurantId = null;
      return next();
    }
    try {
      const decoded       = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId       = decoded.userId;
      socket.restaurantId = decoded.restaurantId;
      socket.role         = decoded.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // Staff / kitchen / admin join their restaurant room
    if (socket.restaurantId) {
      socket.join(`restaurant:${socket.restaurantId}`);
      logger.info(`Socket connected — role:${socket.role} restaurant:${socket.restaurantId}`);
    }

    // Customer joins a room to track their own order
    socket.on('track_order', ({ orderId }) => {
      if (orderId) socket.join(`order:${orderId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected — ${socket.id}`);
    });
  });

  logger.info('Socket.io initialised');
  return io;
}

// Emit a new order to the restaurant's room (admin + kitchen displays)
function emitNewOrder(restaurantId, order) {
  if (!io) return;
  io.to(`restaurant:${restaurantId}`).emit('new_order', order);
}

// Emit a status change to the restaurant room AND the customer tracking room
function emitOrderUpdate(restaurantId, orderId, status) {
  if (!io) return;
  io.to(`restaurant:${restaurantId}`).emit('order_updated', { orderId, status });
  io.to(`order:${orderId}`).emit('order_status', { orderId, status });
}

// Emit a waiter call to the restaurant room
function emitWaiterCall(restaurantId, payload) {
  if (!io) return;
  io.to(`restaurant:${restaurantId}`).emit('waiter_call', payload);
}

function emitToRestaurant(restaurantId, event, payload) {
  if (!io) return;
  io.to(`restaurant:${restaurantId}`).emit(event, payload);
}

function getIO() { return io; }

module.exports = { initSocket, emitNewOrder, emitOrderUpdate, emitWaiterCall, emitToRestaurant, getIO };