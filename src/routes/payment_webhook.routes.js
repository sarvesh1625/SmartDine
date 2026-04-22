// backend/src/routes/payment_webhook.routes.js
// Auto-updates payment_status in DB when gateway confirms payment
// Emits socket event so admin sees "Paid" in real time — no manual tap needed

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { query, queryOne } = require('../config/db');
const { emitToRestaurant, emitNewOrder, emitOrderUpdate } = require('../socket');
const { AppError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — mark order as paid and notify admin via socket
// ─────────────────────────────────────────────────────────────────────────────
async function markOrderPaid(orderId, gatewayOrderId, gatewayPaymentId, method) {
  // 1. Update DB — mark paid, move to 'placed' if was pending payment
  await query(
    `UPDATE orders
     SET payment_status     = 'paid',
         payment_method     = ?,
         gateway_order_id   = ?,
         gateway_payment_id = ?,
         paid_at            = NOW(),
         status = CASE WHEN status = 'payment_pending' THEN 'placed' ELSE status END
     WHERE id = ? OR gateway_order_id = ?`,
    [method, gatewayOrderId, gatewayPaymentId, orderId, gatewayOrderId]
  );

  // 2. Get full order details
  const order = await queryOne(
    `SELECT o.id, o.restaurant_id, o.final_amount, o.payment_method,
            o.payment_status, o.status, o.customer_name,
            o.table_id, t.table_number
     FROM orders o
     LEFT JOIN tables_info t ON t.id = o.table_id
     WHERE o.id = ? OR o.gateway_order_id = ?
     LIMIT 1`,
    [orderId || gatewayOrderId, gatewayOrderId]
  );
  if (!order) return;

  // 3. Notify admin: payment confirmed
  emitToRestaurant(order.restaurant_id, 'payment_updated', {
    orderId:       order.id,
    paymentStatus: 'paid',
    paymentMethod: order.payment_method,
    amount:        order.final_amount,
    paidAt:        new Date().toISOString(),
  });

  // 4. Notify kitchen + admin: new order ready to prepare
  // This is the key step — kitchen now sees the order
  emitToRestaurant(order.restaurant_id, 'new_order', {
    orderId:       order.id,
    customerName:  order.customer_name,
    tableNumber:   order.table_number,
    amount:        order.final_amount,
    paymentMethod: order.payment_method,
    status:        'placed',
  });

  console.log(`Order ${order.id} paid via ${method} — kitchen notified`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. RAZORPAY WEBHOOK
// URL: POST /api/v1/webhooks/razorpay
// Set this URL in Razorpay Dashboard → Settings → Webhooks
// Events to enable: payment.captured, payment.failed, order.paid
// ─────────────────────────────────────────────────────────────────────────────
router.post('/razorpay',
  express.raw({ type: 'application/json' }), // raw body needed for signature
  async (req, res) => {
    try {
      const signature  = req.headers['x-razorpay-signature'];
      const secret     = process.env.RAZORPAY_WEBHOOK_SECRET;

      // Verify signature
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(req.body)
        .digest('hex');

      if (signature !== expectedSig) {
        console.error('Razorpay: invalid webhook signature');
        return res.status(400).json({ error: 'Invalid signature' });
      }

      const event = JSON.parse(req.body);
      const { event: eventName, payload } = event;

      if (eventName === 'payment.captured' || eventName === 'order.paid' || eventName === 'qr_code.closed') {
        const payment          = payload.payment?.entity || payload.order?.entity;
        const gatewayOrderId   = payment?.order_id || payment?.id;
        const gatewayPaymentId = payment?.id;
        const method           = payment?.method === 'upi' ? 'upi' : payment?.method || 'razorpay';
        const notes            = payment?.notes || {};

        // Check if this is a BOOKING payment
        if (notes.booking_id || notes.type === 'advance_booking') {
          const bookingId = notes.booking_id;
          if (bookingId) {
            const bookings = await query(
              `SELECT b.id, b.restaurant_id, b.customer_name, b.advance_amount, b.balance_amount
               FROM bookings b WHERE b.id = ? LIMIT 1`,
              [bookingId]
            );
            if (bookings.length) {
              const bk = bookings[0];
              await query(
                `UPDATE bookings SET payment_status = 'paid', razorpay_payment_id = ?, status = 'confirmed' WHERE id = ?`,
                [gatewayPaymentId, bookingId]
              );
              // Notify restaurant about confirmed booking
              emitToRestaurant(bk.restaurant_id, 'booking_confirmed', {
                bookingId:     bk.id,
                customerName:  bk.customer_name,
                advanceAmount: bk.advance_amount,
                balanceAmount: bk.balance_amount,
                paymentMethod: method,
                message:       `Booking confirmed! ${bk.customer_name} paid ₹${bk.advance_amount} via ${method.toUpperCase()}`,
              });
              console.log(`Booking ${bookingId} advance paid via ${method}`);
            }
          }
        } else {
          // Regular order payment
          await markOrderPaid(null, gatewayOrderId, gatewayPaymentId, method);
          console.log(`Razorpay: order ${gatewayOrderId} marked PAID via ${method}`);
        }
      }

      if (eventName === 'payment.failed') {
        const payment = payload.payment?.entity;
        await query(
          `UPDATE orders SET payment_status = 'failed'
           WHERE gateway_order_id = ?`,
          [payment.order_id]
        );
        const orders = await query(
          `SELECT id, restaurant_id FROM orders WHERE gateway_order_id = ? LIMIT 1`,
          [payment.order_id]
        );
        if (orders.length) {
          emitToRestaurant(orders[0].restaurant_id, 'payment_updated', {
            orderId:       orders[0].id,
            paymentStatus: 'failed',
          });
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Razorpay webhook error:', err.message);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. STRIPE WEBHOOK
// URL: POST /api/v1/webhooks/stripe
// Set in Stripe Dashboard → Developers → Webhooks
// Events: payment_intent.succeeded, payment_intent.payment_failed
// ─────────────────────────────────────────────────────────────────────────────
router.post('/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const sig       = req.headers['stripe-signature'];
      const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      } catch (err) {
        console.error('Stripe: webhook signature failed', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === 'payment_intent.succeeded') {
        const pi      = event.data.object;
        const orderId = pi.metadata?.orderId; // we store orderId in metadata when creating PI

        await markOrderPaid(orderId, pi.id, pi.id, 'card');
        console.log(`Stripe: order ${orderId} marked PAID`);
      }

      if (event.type === 'payment_intent.payment_failed') {
        const pi      = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          await query(
            `UPDATE orders SET payment_status = 'failed' WHERE id = ?`,
            [orderId]
          );
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook error:', err.message);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. PAYTM WEBHOOK
// URL: POST /api/v1/webhooks/paytm
// Set in Paytm Dashboard → Developer Settings → Webhook URL
// ─────────────────────────────────────────────────────────────────────────────
router.post('/paytm', express.json(), async (req, res) => {
  try {
    const { CHECKSUMHASH, ...body } = req.body;
    const PaytmChecksum = require('paytmchecksum');

    // Verify checksum
    const isValid = await PaytmChecksum.verifySignature(
      JSON.stringify(body),
      process.env.PAYTM_MERCHANT_KEY,
      CHECKSUMHASH
    );

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid checksum' });
    }

    const { STATUS, ORDERID, TXNID, PAYMENTMODE } = body;

    if (STATUS === 'TXN_SUCCESS') {
      const method = PAYMENTMODE === 'UPI' ? 'upi' : 'paytm';
      await markOrderPaid(ORDERID, ORDERID, TXNID, method);
      console.log(`Paytm: order ${ORDERID} marked PAID`);
    }

    if (STATUS === 'TXN_FAILURE') {
      await query(
        `UPDATE orders SET payment_status = 'failed' WHERE id = ?`,
        [ORDERID]
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Paytm webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. UPI QR — MANUAL CONFIRM (no gateway)
// Customer shows screenshot to staff → staff taps "Mark Paid" → auto updates
// PATCH /api/v1/webhooks/manual-paid/:orderId
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/manual-paid/:orderId',
  require('../middleware/auth').authenticate,
  async (req, res) => {
    try {
      const { orderId } = req.params;
      await query(
        `UPDATE orders
         SET payment_status = 'paid', paid_at = NOW()
         WHERE id = ? AND restaurant_id = ?`,
        [orderId, req.restaurantId]
      );

      // Emit to admin panel
      emitToRestaurant(req.restaurantId, 'payment_updated', {
        orderId,
        paymentStatus: 'paid',
        paidAt: new Date().toISOString(),
      });

      res.json({ success: true, message: 'Payment confirmed' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. CUSTOMER CONFIRMS PAYMENT (UPI screenshot flow)
// Called when customer taps "I've Paid" button
// PATCH /api/v1/webhooks/customer-paid/:orderId
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/customer-paid/:orderId', async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { amount, restaurantSlug } = req.body;

    // Get order and restaurant
    const orders = await query(
      `SELECT o.id, o.restaurant_id, o.final_amount, o.payment_status, o.table_id,
              r.name AS restaurant_name, t.table_number
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN tables_info t ON t.id = o.table_id
       WHERE o.id = ? LIMIT 1`,
      [orderId]
    );

    if (!orders.length) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];

    // Update payment status to 'customer_confirmed' (waiting for owner to verify)
    await query(
      `UPDATE orders SET payment_status = 'customer_confirmed' WHERE id = ?`,
      [orderId]
    );

    // Emit real-time notification to admin/staff
    emitToRestaurant(order.restaurant_id, 'payment_customer_confirmed', {
      orderId:        order.id,
      tableNumber:    order.table_number || 'Unknown',
      amount:         order.final_amount,
      paymentStatus:  'customer_confirmed',
      message:        `Table ${order.table_number || '?'} says they paid ₹${order.final_amount} via UPI`,
    });

    res.json({ success: true, message: 'Restaurant notified' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PHONEPE — Initiate Payment (creates PhonePe payment page/QR)
// POST /api/v1/webhooks/phonepe-init
// Called when customer is about to pay — PhonePe returns a redirect URL
// Customer pays on PhonePe page → webhook auto-fires → order confirmed
// ─────────────────────────────────────────────────────────────────────────────
router.post('/phonepe-init', express.json(), async (req, res, next) => {
  try {
    const { orderId, bookingId, restaurantId, amount } = req.body;
    if (!restaurantId || !amount) throw new AppError('restaurantId and amount required', 400);

    // Get restaurant PhonePe credentials
    const restaurant = await queryOne(
      `SELECT id, name, phonepe_merchant_id, phonepe_salt_key, phonepe_salt_index, phonepe_env
       FROM restaurants WHERE id = ?`,
      [restaurantId]
    );

    if (!restaurant?.phonepe_merchant_id || !restaurant?.phonepe_salt_key) {
      return res.status(503).json({ success: false, message: 'PhonePe not configured for this restaurant' });
    }

    const isUAT       = restaurant.phonepe_env !== 'PROD';
    const baseUrl     = isUAT
      ? 'https://api-preprod.phonepe.com/apis/pg-sandbox'
      : 'https://api.phonepe.com/apis/hermes';
    const merchantId  = restaurant.phonepe_merchant_id;
    const saltKey     = restaurant.phonepe_salt_key;
    const saltIndex   = restaurant.phonepe_salt_index || 1;
    const txnId       = orderId || bookingId || `TXN_${Date.now()}`;
    const amountPaise = Math.round(Number(amount) * 100); // convert to paise

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const backendUrl  = process.env.BACKEND_URL  || 'http://localhost:5000';

    const payload = {
      merchantId,
      merchantTransactionId: txnId,
      merchantUserId:        `USER_${txnId}`,
      amount:                amountPaise,
      redirectUrl:           `${frontendUrl}/payment-status/${txnId}`,
      redirectMode:          'REDIRECT',
      callbackUrl:           `${backendUrl}/api/v1/webhooks/phonepe/${restaurantId}`,
      paymentInstrument:     { type: 'PAY_PAGE' },
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const checksum = require('crypto')
      .createHash('sha256')
      .update(base64Payload + '/pg/v1/pay' + saltKey)
      .digest('hex') + '###' + saltIndex;

    const response = await fetch(`${baseUrl}/pg/v1/pay`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-VERIFY':      checksum,
        'X-MERCHANT-ID': merchantId,
      },
      body: JSON.stringify({ request: base64Payload }),
    });

    const data = await response.json();

    if (data.success) {
      const redirectUrl = data.data?.instrumentResponse?.redirectInfo?.url;
      res.json({ success: true, data: { redirectUrl, txnId } });
    } else {
      console.error('PhonePe init failed:', data);
      res.status(400).json({ success: false, message: data.message || 'PhonePe payment initiation failed' });
    }
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6b. PHONEPE BUSINESS WEBHOOK — per restaurant with signature verification
// URL: POST /api/v1/webhooks/phonepe/:restaurantId
// Register this exact URL in PhonePe Business Dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.post('/phonepe/:restaurantId', express.json(), async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { response }     = req.body; // PhonePe sends base64 encoded response

    // Get restaurant's PhonePe credentials
    const restaurant = await queryOne(
      `SELECT id, name, phonepe_salt_key, phonepe_salt_index, phonepe_merchant_id, phonepe_env
       FROM restaurants WHERE id = ?`,
      [restaurantId]
    );

    if (!restaurant || !restaurant.phonepe_salt_key) {
      console.log(`PhonePe: restaurant ${restaurantId} not configured`);
      return res.json({ received: true });
    }

    // Verify PhonePe signature
    const crypto = require('crypto');
    const xVerify = req.headers['x-verify'];
    if (xVerify && response) {
      const expectedHash = crypto
        .createHash('sha256')
        .update(response + '/pg/v1/status' + restaurant.phonepe_salt_key)
        .digest('hex') + '###' + restaurant.phonepe_salt_index;

      if (xVerify !== expectedHash) {
        console.error('PhonePe: invalid signature');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    // Decode and parse response
    const decoded = JSON.parse(Buffer.from(response, 'base64').toString('utf-8'));
    const { code, data } = decoded;

    if (code === 'PAYMENT_SUCCESS' && data) {
      const amount       = Number(data.amount) / 100; // paise to rupees
      const merchantTxnId = data.merchantTransactionId || data.transactionId;
      const payerPhone   = data.payerInfo?.phoneNumber;

      // Try to find matching order
      const orders = await query(
        `SELECT id FROM orders
         WHERE restaurant_id = ?
           AND payment_status IN ('pending','customer_confirmed')
           AND ABS(final_amount - ?) < 5
         ORDER BY created_at DESC LIMIT 1`,
        [restaurantId, amount]
      );

      if (orders.length) {
        await query(
          `UPDATE orders SET payment_status='paid', payment_method='upi',
           gateway_payment_id=?, paid_at=NOW() WHERE id=?`,
          [merchantTxnId, orders[0].id]
        );
        emitToRestaurant(restaurantId, 'payment_updated', {
          orderId: orders[0].id, paymentStatus: 'paid',
          paymentMethod: 'upi', amount,
        });
        emitToRestaurant(restaurantId, 'new_order', { orderId: orders[0].id });
      }

      // Always emit soundbox notification
      emitToRestaurant(restaurantId, 'upi_payment_received', {
        amount, payerPhone, txnId: merchantTxnId,
        orderId: orders[0]?.id || null,
        receivedAt: new Date().toISOString(),
      });

      console.log(`PhonePe payment ₹${amount} received at restaurant ${restaurantId}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('PhonePe webhook error:', err.message);
    res.json({ received: true }); // always 200 to prevent retries
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PHONEPE / PAYTM BUSINESS WEBHOOK
// When registered as PhonePe/Paytm business merchant, they send payment
// notifications to this URL automatically for every UPI payment received
// URL: POST /api/v1/webhooks/upi-notify
//
// Register this URL in:
// - PhonePe Business: business.phonepe.com → API → Webhook URL
// - Paytm Business:   business.paytm.com → Developer → Webhook URL
// - Google Pay Business: pay.google.com/business → Settings → Notifications
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upi-notify', express.json(), async (req, res) => {
  try {
    const body = req.body;
    console.log('UPI Notify received:', JSON.stringify(body));

    // Extract payment details — different providers use different field names
    const amount      = body.amount || body.txnAmount?.value || body.transactionAmount;
    const txnId       = body.transactionId || body.txnId || body.referenceId || body.orderId;
    const upiId       = body.payeeVpa || body.merchantVpa || body.vpa;
    const payerName   = body.payerName || body.customerName || 'Customer';
    const payerPhone  = body.payerMobile || body.mobile || '';
    const status      = body.status || body.transactionStatus || body.code;

    const isPaid = ['SUCCESS','TXN_SUCCESS','PAYMENT_SUCCESS','200','00'].includes(
      String(status).toUpperCase()
    );

    if (!isPaid) {
      return res.json({ received: true, action: 'ignored', reason: 'not a success event' });
    }

    // Find restaurant by UPI ID
    const restaurants = await query(
      'SELECT id, name FROM restaurants WHERE upi_id = ? AND is_active = 1 LIMIT 1',
      [upiId]
    );

    if (!restaurants.length) {
      // Try to find by any restaurant (if single restaurant setup)
      console.log('UPI ID not matched:', upiId);
      return res.json({ received: true });
    }

    const restaurant = restaurants[0];
    const amountNum  = Number(amount) / 100; // most providers send paise

    // Find matching pending order by amount (best effort)
    const orders = await query(
      `SELECT id FROM orders
       WHERE restaurant_id = ?
         AND payment_status IN ('pending','customer_confirmed')
         AND ABS(final_amount - ?) < 5
       ORDER BY created_at DESC LIMIT 1`,
      [restaurant.id, amountNum || Number(amount)]
    );

    if (orders.length) {
      await query(
        `UPDATE orders SET payment_status = 'paid', payment_method = 'upi',
         gateway_payment_id = ?, paid_at = NOW() WHERE id = ?`,
        [txnId, orders[0].id]
      );
      emitToRestaurant(restaurant.id, 'payment_updated', {
        orderId:       orders[0].id,
        paymentStatus: 'paid',
        paymentMethod: 'upi',
        amount:        amountNum || Number(amount),
        paidAt:        new Date().toISOString(),
      });
    }

    // Always emit the payment notification to admin (soundbox-style)
    emitToRestaurant(restaurant.id, 'upi_payment_received', {
      amount:      amountNum || Number(amount),
      txnId,
      payerName,
      payerPhone,
      upiId,
      orderId:     orders[0]?.id || null,
      receivedAt:  new Date().toISOString(),
    });

    console.log(`UPI payment ₹${amountNum} received at ${restaurant.name}`);
    res.json({ received: true, status: 'ok' });
  } catch (err) {
    console.error('UPI notify error:', err.message);
    res.json({ received: true }); // always 200 to prevent retries
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. CUSTOMER CONFIRMS BOOKING PAYMENT (UPI flow)
// PATCH /api/v1/webhooks/customer-booking-paid/:bookingId
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/customer-booking-paid/:bookingId', async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const { amount }    = req.body;

    const booking = await queryOne(
      `SELECT b.id, b.restaurant_id, b.customer_name, b.advance_amount, b.balance_amount,
              b.customer_phone, b.status
       FROM bookings b WHERE b.id = ?`,
      [bookingId]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Mark as customer_confirmed (admin still needs to verify)
    await query(
      `UPDATE bookings SET payment_status = 'paid', status = 'confirmed' WHERE id = ?`,
      [bookingId]
    );

    // Notify admin instantly — soundbox style
    emitToRestaurant(booking.restaurant_id, 'booking_confirmed', {
      bookingId:     booking.id,
      customerName:  booking.customer_name,
      customerPhone: booking.customer_phone,
      advanceAmount: booking.advance_amount,
      balanceAmount: booking.balance_amount,
      message:       `${booking.customer_name} paid ₹${booking.advance_amount} advance via UPI`,
    });

    // Also emit UPI sound notification
    emitToRestaurant(booking.restaurant_id, 'upi_payment_received', {
      amount:     booking.advance_amount,
      payerName:  booking.customer_name,
      txnId:      bookingId,
      bookingId:  booking.id,
      type:       'booking_advance',
      receivedAt: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Restaurant notified' });
  } catch (err) { next(err); }
});

module.exports = router;