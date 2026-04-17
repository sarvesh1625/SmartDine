const router   = require('express').Router();
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Razorpay = require('razorpay');
const { authenticate, isAdmin } = require('../middleware/auth');
const { query, queryOne }       = require('../config/db');
const { AppError }              = require('../middleware/errorHandler');
const { emitToRestaurant }       = require('../socket');

function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
    throw new AppError('Payment gateway not configured', 503);
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — Customer creates a booking + gets payment QR
// POST /api/v1/bookings
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      restaurantSlug, customerName, customerPhone, customerEmail,
      bookingDate, bookingTime, partySize,
      estimatedAmount, advancePercent = 10, specialRequests,
    } = req.body;

    if (!restaurantSlug || !customerName || !customerPhone || !estimatedAmount) {
      throw new AppError('restaurantSlug, customerName, customerPhone and estimatedAmount are required', 400);
    }
    if (customerPhone.replace(/\D/g,'').length !== 10) {
      throw new AppError('Phone must be 10 digits', 400);
    }

    const restaurant = await queryOne(
      'SELECT id, name FROM restaurants WHERE slug = ? AND is_active = 1',
      [restaurantSlug]
    );
    if (!restaurant) throw new AppError('Restaurant not found', 404);

    // Calculate advance
    const now = new Date();
    const finalDate = bookingDate || now.toISOString().split('T')[0];
    const finalTime = bookingTime || now.toTimeString().slice(0,5);
    const pct     = Math.min(Math.max(Number(advancePercent), 5), 50); // clamp 5-50%
    const advance = Math.ceil((Number(estimatedAmount) * pct) / 100);
    const balance = Number(estimatedAmount) - advance;

    const bookingId = uuidv4();

    // Create booking record
    await query(
      `INSERT INTO bookings
        (id, restaurant_id, customer_name, customer_phone, customer_email,
         booking_date, booking_time, party_size, estimated_amount,
         advance_percent, advance_amount, balance_amount, special_requests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bookingId, restaurant.id,
        customerName.trim(), customerPhone.replace(/\D/g,'').slice(-10),
        customerEmail?.trim() || null,
        finalDate, finalTime,
        partySize || 1,
        estimatedAmount, pct, advance, balance,
        specialRequests?.trim() || null,
      ]
    );

    // Generate Razorpay QR for advance payment
    let qrImageUrl = null;
    let razorpayOrderId = null;
    try {
      const rzp = getRazorpay();

      // Create Razorpay order
      const rzpOrder = await rzp.orders.create({
        amount:   Math.round(advance * 100),
        currency: 'INR',
        receipt:  `bk_${bookingId.slice(0, 20)}`,
        notes:    { booking_id: bookingId, type: 'advance_booking' },
      });
      razorpayOrderId = rzpOrder.id;

      // Generate QR code
      const qrRes = await fetch('https://api.razorpay.com/v1/payments/qr-codes', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Basic ' + Buffer.from(
            `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
          ).toString('base64'),
        },
        body: JSON.stringify({
          type:           'upi_qr',
          name:           restaurant.name,
          usage:          'single_use',
          fixed_amount:   true,
          payment_amount: Math.round(advance * 100),
          description:    `Advance booking at ${restaurant.name} on ${bookingDate} ${bookingTime}`,
          close_by:       Math.floor(Date.now() / 1000) + (30 * 60), // 30 min to pay
          notes:          { booking_id: bookingId },
        }),
      });

      if (qrRes.ok) {
        const qrData = await qrRes.json();
        qrImageUrl = qrData.image_url;
        await query('UPDATE bookings SET razorpay_order_id = ?, qr_code = ? WHERE id = ?',
          [razorpayOrderId, qrImageUrl, bookingId]);
      }
    } catch (payErr) {
      // Payment setup failed — booking still created, can pay via UPI ID
      console.error('QR generation failed:', payErr.message);
    }

    // Notify restaurant via socket
    emitToRestaurant(restaurant.id, 'new_booking', {
      bookingId,
      customerName: customerName.trim(),
      customerPhone: customerPhone.replace(/\D/g,'').slice(-10),
      bookingDate, bookingTime,
      partySize: partySize || 1,
      estimatedAmount,
      advanceAmount: advance,
      specialRequests: specialRequests?.trim() || null,
    });

    res.status(201).json({
      success: true,
      message: `Booking created! Pay ₹${advance} advance to confirm.`,
      data: {
        bookingId,
        advanceAmount:    advance,
        balanceAmount:    balance,
        estimatedAmount,
        advancePercent:   pct,
        qrImageUrl,
        razorpayOrderId,
        razorpayKeyId:    process.env.RAZORPAY_KEY_ID,
        restaurantName:   restaurant.name,
        bookingDate,
        bookingTime,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — Verify advance payment after Razorpay callback
// POST /api/v1/bookings/:id/verify-payment
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/verify-payment', async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const booking = await queryOne(
      'SELECT b.*, r.id AS restaurant_id FROM bookings b JOIN restaurants r ON r.id = b.restaurant_id WHERE b.id = ?',
      [req.params.id]
    );
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.payment_status === 'paid') throw new AppError('Already paid', 400);

    // Verify Razorpay signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) throw new AppError('Payment verification failed', 400);

    // Confirm booking
    await query(
      `UPDATE bookings
       SET payment_status = 'paid', razorpay_payment_id = ?, status = 'confirmed'
       WHERE id = ?`,
      [razorpay_payment_id, booking.id]
    );

    // Notify restaurant
    emitToRestaurant(booking.restaurant_id, 'booking_confirmed', {
      bookingId:      booking.id,
      customerName:   booking.customer_name,
      customerPhone:  booking.customer_phone,
      bookingDate:    booking.booking_date,
      bookingTime:    booking.booking_time,
      partySize:      booking.party_size,
      advanceAmount:  booking.advance_amount,
      balanceAmount:  booking.balance_amount,
    });

    res.json({
      success: true,
      message: 'Advance payment confirmed! Your booking is reserved. 🎉',
      data: { bookingId: booking.id, status: 'confirmed' },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — Get booking status by ID
// GET /api/v1/bookings/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const booking = await queryOne(
      `SELECT b.id, b.customer_name, b.customer_phone, b.booking_date, b.booking_time,
              b.party_size, b.estimated_amount, b.advance_amount, b.balance_amount,
              b.advance_percent, b.status, b.payment_status, b.special_requests,
              b.created_at, r.name AS restaurant_name, r.slug AS restaurant_slug
       FROM bookings b
       JOIN restaurants r ON r.id = b.restaurant_id
       WHERE b.id = ?`,
      [req.params.id]
    );
    if (!booking) throw new AppError('Booking not found', 404);
    res.json({ success: true, data: booking });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — List all bookings
// GET /api/v1/bookings/admin/list
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/list', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { date, status } = req.query;
    let sql = `SELECT id, customer_name, customer_phone, booking_date, booking_time,
                      party_size, estimated_amount, advance_amount, balance_amount,
                      status, payment_status, special_requests, created_at
               FROM bookings
               WHERE restaurant_id = ?`;
    const params = [req.restaurantId];
    if (date)   { sql += ' AND booking_date = ?';  params.push(date);   }
    if (status) { sql += ' AND status = ?';         params.push(status); }
    sql += ' ORDER BY booking_date ASC, booking_time ASC';

    const bookings = await query(sql, params);
    res.json({ success: true, data: bookings });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Update booking status (arrived, completed, cancelled, no_show)
// PATCH /api/v1/bookings/admin/:id/status
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/admin/:id/status', authenticate, isAdmin, async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const valid = ['confirmed','arrived','completed','cancelled','no_show'];
    if (!valid.includes(status)) throw new AppError(`status must be one of: ${valid.join(', ')}`, 400);

    const booking = await queryOne(
      'SELECT id FROM bookings WHERE id = ? AND restaurant_id = ?',
      [req.params.id, req.restaurantId]
    );
    if (!booking) throw new AppError('Booking not found', 404);

    await query(
      'UPDATE bookings SET status = ?, notes = COALESCE(?, notes) WHERE id = ?',
      [status, notes || null, booking.id]
    );
    res.json({ success: true, message: `Booking marked as ${status}` });
  } catch (err) { next(err); }
});

module.exports = router;