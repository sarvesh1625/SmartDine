const uuid      = require('uuid');           // uuid v13: import whole module
const { query, queryOne, transaction } = require('../config/db');
const { emitNewOrder, emitOrderUpdate } = require('../socket');
const { AppError } = require('../middleware/errorHandler');

const uuidv4 = () => uuid.v4();

async function placeOrder(req, res, next) {
  try {
    const { restaurantSlug, tableId, customerName, customerPhone,
            items, specialInstructions, couponCode } = req.body;

    if (!restaurantSlug || !items?.length) throw new AppError('restaurantSlug and items are required', 400);

    const restaurant = await queryOne('SELECT id, is_active FROM restaurants WHERE slug = ?', [restaurantSlug]);
    if (!restaurant?.is_active) throw new AppError('Restaurant not found', 404);

    // Resolve tableId: could be table_number (from URL) or tables_info.id
    // Try to find the actual table row
    let resolvedTableId = null;
    if (tableId) {
      const tableRow = await queryOne(
        'SELECT id FROM tables_info WHERE restaurant_id = ? AND (id = ? OR table_number = ?) LIMIT 1',
        [restaurant.id, tableId, String(tableId)]
      );
      resolvedTableId = tableRow?.id || null;
    }

    const itemIds   = items.map(i => Number(i.menuItemId));
    const menuItems = await query(
      `SELECT id, name_en, price, discounted_price, is_available, preparation_time_mins
       FROM menu_items WHERE id IN (${itemIds.map(() => '?').join(',')}) AND restaurant_id = ?`,
      [...itemIds, restaurant.id]
    );

    for (const reqItem of items) {
      const found = menuItems.find(m => Number(m.id) === Number(reqItem.menuItemId));
      if (!found) throw new AppError(`Menu item ${reqItem.menuItemId} not found`, 400);
      if (!found.is_available) throw new AppError(`"${found.name_en}" is currently unavailable`, 400);
    }

    let totalAmount = 0;
    const orderItems = items.map(reqItem => {
      const menuItem  = menuItems.find(m => Number(m.id) === Number(reqItem.menuItemId));
      const unitPrice = menuItem.discounted_price || menuItem.price;
      totalAmount += unitPrice * reqItem.quantity;
      return {
        menuItemId:         menuItem.id,
        quantity:           reqItem.quantity,
        unitPrice,
        itemNameSnapshot:   menuItem.name_en,
        customizationNotes: reqItem.customizationNotes || null,
        prepTime:           menuItem.preparation_time_mins,
      };
    });

    let discountAmount = 0;
    if (couponCode) {
      const promo = await queryOne(
        `SELECT * FROM promotions WHERE restaurant_id = ? AND code = ? AND is_active = 1
         AND valid_from <= NOW() AND valid_to >= NOW()
         AND (max_uses IS NULL OR used_count < max_uses)`,
        [restaurant.id, couponCode.toUpperCase()]
      );
      if (!promo) throw new AppError('Invalid or expired coupon code', 400);
      if (totalAmount < promo.min_order_amount) {
        throw new AppError(`Minimum order of ₹${promo.min_order_amount} required for this coupon`, 400);
      }
      discountAmount = promo.discount_type === 'percent'
        ? (totalAmount * promo.discount_value) / 100
        : promo.discount_value;
      discountAmount = Math.min(discountAmount, totalAmount);
    }

    const finalAmount       = totalAmount - discountAmount;
    const estimatedPrepTime = Math.max(...orderItems.map(i => i.prepTime));
    const orderId           = uuidv4();

    // Check if restaurant uses pay-first mode
    const restaurantFull = await queryOne(
      'SELECT id, is_active, pay_first FROM restaurants WHERE id = ?',
      [restaurant.id]
    );
    const payFirst = restaurantFull?.pay_first === 1;

    // Payment method from request
    const paymentMethod = req.body.paymentMethod || 'counter';

    // For pay-first restaurants, order starts as payment_pending
    // For counter/cash restaurants, order goes straight to placed
    const initialPaymentStatus = (payFirst && paymentMethod === 'upi') ? 'pending' : 'pending';
    const initialStatus = (payFirst && paymentMethod === 'upi') ? 'payment_pending' : 'placed';

    await transaction(async (conn) => {
      await conn.execute(
        `INSERT INTO orders
           (id, restaurant_id, table_id, customer_name, customer_phone,
            total_amount, discount_amount, final_amount, special_instructions,
            payment_method, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, restaurant.id, resolvedTableId, customerName || 'Guest',
         customerPhone || null, totalAmount, discountAmount, finalAmount, specialInstructions || null,
         paymentMethod, initialStatus]
      );
      for (const item of orderItems) {
        await conn.execute(
          `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, item_name_snapshot, customization_notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [orderId, item.menuItemId, item.quantity, item.unitPrice, item.itemNameSnapshot, item.customizationNotes]
        );
      }
      if (couponCode) {
        await conn.execute(
          'UPDATE promotions SET used_count = used_count + 1 WHERE restaurant_id = ? AND code = ?',
          [restaurant.id, couponCode.toUpperCase()]
        );
      }
    });

    const newOrder = await getOrderById(orderId, restaurant.id);
    emitNewOrder(restaurant.id, newOrder);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully!',
      data: { orderId, totalAmount, discountAmount, finalAmount, estimatedPrepTime, status: 'placed' },
    });
  } catch (err) { next(err); }
}

async function getOrders(req, res, next) {
  try {
    const { status, date, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `SELECT o.*, t.table_number FROM orders o
               LEFT JOIN tables_info t ON t.id = o.table_id
               WHERE o.restaurant_id = ?`;
    const params = [req.restaurantId];
    if (status) { sql += ' AND o.status = ?'; params.push(status); }
    if (date)   { sql += ' AND DATE(o.created_at) = ?'; params.push(date); }
    sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const orders = await query(sql, params);
    for (const order of orders) {
      order.items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    }
    res.json({ success: true, data: orders, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
}

async function getKitchenQueue(req, res, next) {
  try {
    const orders = await query(
      `SELECT o.*, t.table_number FROM orders o
       LEFT JOIN tables_info t ON t.id = o.table_id
       WHERE o.restaurant_id = ? AND o.status IN ('placed','confirmed','preparing')
       ORDER BY o.created_at ASC`,
      [req.restaurantId]
    );
    for (const order of orders) {
      order.items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    }
    res.json({ success: true, data: orders });
  } catch (err) { next(err); }
}

async function getOrder(req, res, next) {
  try {
    const order = await getOrderById(req.params.id, req.restaurantId);
    if (!order) throw new AppError('Order not found', 404);
    res.json({ success: true, data: order });
  } catch (err) { next(err); }
}

async function updateOrderStatus(req, res, next) {
  try {
    const { id }     = req.params;
    const { status } = req.body;
    const validStatuses = ['confirmed','preparing','ready','delivered','cancelled'];
    if (!validStatuses.includes(status)) throw new AppError(`Invalid status. Valid: ${validStatuses.join(', ')}`, 400);

    const order = await queryOne('SELECT id, status FROM orders WHERE id = ? AND restaurant_id = ?', [id, req.restaurantId]);
    if (!order) throw new AppError('Order not found', 404);

    await query('UPDATE orders SET status = ? WHERE id = ? AND restaurant_id = ?', [status, id, req.restaurantId]);
    emitOrderUpdate(req.restaurantId, id, status);
    res.json({ success: true, message: `Order status updated to "${status}"`, data: { status } });
  } catch (err) { next(err); }
}

async function getOrderById(orderId, restaurantId) {
  const order = await queryOne(
    `SELECT o.*, t.table_number FROM orders o
     LEFT JOIN tables_info t ON t.id = o.table_id
     WHERE o.id = ? AND o.restaurant_id = ?`,
    [orderId, restaurantId]
  );
  if (!order) return null;
  order.items = await query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  return order;
}

module.exports = { placeOrder, getOrders, getKitchenQueue, getOrder, updateOrderStatus };