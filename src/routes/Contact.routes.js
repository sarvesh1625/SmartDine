const router      = require('express').Router();
const nodemailer  = require('nodemailer');
const { AppError } = require('../middleware/errorHandler');

// POST /api/v1/contact
router.post('/', async (req, res, next) => {
  try {
    const { name, email, phone, restaurant, message } = req.body;
    if (!name || !email || !message) throw new AppError('name, email and message are required', 400);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.CONTACT_EMAIL_USER,
        pass: process.env.CONTACT_EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from:    `"SmartDine Contact" <${process.env.CONTACT_EMAIL_USER}>`,
      to:      'sarveshthokala1625@gmail.com',
      subject: `New enquiry from ${name}${restaurant ? ` — ${restaurant}` : ''}`,
      html: `
        <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #f9f9f9; border-radius: 12px;">
          <h2 style="color: #FF2D55; margin-bottom: 20px;">New SmartDine Enquiry</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #555; width: 140px;"><strong>Name</strong></td><td style="padding: 8px 0;">${name}</td></tr>
            <tr><td style="padding: 8px 0; color: #555;"><strong>Email</strong></td><td style="padding: 8px 0;"><a href="mailto:${email}">${email}</a></td></tr>
            <tr><td style="padding: 8px 0; color: #555;"><strong>Phone</strong></td><td style="padding: 8px 0;">${phone ? `<a href="tel:${phone}">${phone}</a>` : '—'}</td></tr>
            <tr><td style="padding: 8px 0; color: #555;"><strong>Restaurant</strong></td><td style="padding: 8px 0;">${restaurant || '—'}</td></tr>
          </table>
          <div style="margin-top: 20px; padding: 16px; background: #fff; border-radius: 8px; border-left: 4px solid #FF2D55;">
            <strong style="color: #333;">Message:</strong>
            <p style="margin: 8px 0 0; color: #444; line-height: 1.6;">${message.replace(/\n/g, '<br>')}</p>
          </div>
          <p style="margin-top: 20px; font-size: 12px; color: #999;">Sent via SmartDine contact form</p>
        </div>
      `,
    });

    res.json({ success: true, message: 'Message sent successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;