const Joi = require('joi');

// ── middleware wrapper ──────────────────────────────────────────────────────
function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return next(error); // errorHandler picks up err.isJoi
    next();
  };
}

// ── auth ────────────────────────────────────────────────────────────────────
const registerSchema = Joi.object({
  restaurantName: Joi.string().min(2).max(100).required(),
  ownerName:      Joi.string().min(2).max(100).required(),
  email:          Joi.string().email().required(),
  password:       Joi.string().min(8).max(72).required(),
  phone:          Joi.string().pattern(/^[6-9]\d{9}$/).required().messages({
    'string.pattern.base': 'Phone must be a valid 10-digit Indian mobile number',
  }),
  city:  Joi.string().max(60).optional().allow('', null),
  state: Joi.string().max(60).optional().allow('', null),
});

const loginSchema = Joi.object({
  email:    Joi.string().email().required(),
  password: Joi.string().required(),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword:     Joi.string().min(8).max(72).required(),
});

// ── menu items ───────────────────────────────────────────────────────────────
const createMenuItemSchema = Joi.object({
  category_id:           Joi.number().integer().positive().required(),
  name_en:               Joi.string().min(1).max(120).required(),
  name_te:               Joi.string().max(120).optional().allow('', null),
  name_hi:               Joi.string().max(120).optional().allow('', null),
  description_en:        Joi.string().max(500).optional().allow('', null),
  description_te:        Joi.string().max(500).optional().allow('', null),
  price:                 Joi.number().positive().required(),
  discounted_price:      Joi.number().min(0).optional().allow(null, '', 0),
  image_url:             Joi.string().max(500).optional().allow('', null),
  is_veg:                Joi.boolean().optional().default(true),
  is_available:          Joi.boolean().optional().default(true),
  preparation_time_mins: Joi.number().integer().min(0).max(180).optional().allow(null, 0),
  calories:              Joi.number().integer().min(0).optional().allow(null, 0),
  tags:                  Joi.alternatives().try(Joi.array(), Joi.string()).optional().allow(null),
  is_combo:              Joi.boolean().optional().default(false),
  combo_items:           Joi.alternatives().try(Joi.array(), Joi.string()).optional().allow(null, ''),
  combo_savings:         Joi.number().min(0).optional().allow(null, 0),
}).options({ allowUnknown: true });

const updateMenuItemSchema = Joi.object({
  category_id:           Joi.number().integer().positive().optional(),
  name_en:               Joi.string().min(1).max(120).optional(),
  name_te:               Joi.string().max(120).optional().allow('', null),
  name_hi:               Joi.string().max(120).optional().allow('', null),
  description_en:        Joi.string().max(500).optional().allow('', null),
  description_te:        Joi.string().max(500).optional().allow('', null),
  price:                 Joi.number().positive().precision(2).optional(),
  discounted_price:      Joi.number().positive().precision(2).optional().allow(null),
  image_url:             Joi.string().uri().max(500).optional().allow('', null),
  is_veg:                Joi.boolean().optional(),
  preparation_time_mins: Joi.number().integer().min(1).max(180).optional(),
  calories:              Joi.number().integer().min(0).optional().allow(null, 0),
  tags:                  Joi.array().items(Joi.string().max(30)).optional().allow(null),
  is_combo:              Joi.boolean().optional(),
  combo_items:           Joi.alternatives().try(Joi.array(), Joi.string()).optional().allow(null),
  combo_savings:         Joi.number().min(0).optional().allow(null),
  sort_order:            Joi.number().integer().min(0).optional(),
}).min(1);

// ── categories ───────────────────────────────────────────────────────────────
const createCategorySchema = Joi.object({
  name_en:    Joi.string().min(1).max(80).required(),
  name_te:    Joi.string().max(80).optional().allow('', null),
  name_hi:    Joi.string().max(80).optional().allow('', null),
  name_ta:    Joi.string().max(80).optional().allow('', null),
  sort_order: Joi.number().integer().min(0).default(0),
  image_url:  Joi.string().uri().max(500).optional().allow('', null),
});

const updateCategorySchema = Joi.object({
  name_en:    Joi.string().min(1).max(80).optional(),
  name_te:    Joi.string().max(80).optional().allow('', null),
  name_hi:    Joi.string().max(80).optional().allow('', null),
  name_ta:    Joi.string().max(80).optional().allow('', null),
  sort_order: Joi.number().integer().min(0).optional(),
  image_url:  Joi.string().uri().max(500).optional().allow('', null),
  is_active:  Joi.boolean().optional(),
}).min(1);

// ── orders ───────────────────────────────────────────────────────────────────
const placeOrderSchema = Joi.object({
  restaurantSlug:      Joi.string().required(),
  tableId:             Joi.alternatives().try(Joi.number().integer().positive(), Joi.string()).optional().allow(null, ''),
  customerName:        Joi.string().max(100).optional().allow('', null),
  customerPhone:       Joi.string().pattern(/^\d{10}$/).optional().allow('', null),
  items: Joi.array().items(
    Joi.object({
      menuItemId:         Joi.alternatives().try(Joi.string().uuid(), Joi.number().integer().positive()).required(),
      quantity:           Joi.number().integer().min(1).max(20).required(),
      customizationNotes: Joi.string().max(200).optional().allow('', null),
    })
  ).min(1).required(),
  specialInstructions: Joi.string().max(500).optional().allow('', null),
  couponCode:          Joi.string().max(20).uppercase().optional().allow('', null),
  paymentMethod:       Joi.string().valid('counter', 'upi', 'razorpay', 'cash', 'card').optional().allow('', null),
});

const updateOrderStatusSchema = Joi.object({
  status: Joi.string()
    .valid('confirmed', 'preparing', 'ready', 'delivered', 'cancelled')
    .required(),
});

// ── feedback ─────────────────────────────────────────────────────────────────
const feedbackSchema = Joi.object({
  orderId:       Joi.string().uuid().required(),
  restaurantId:  Joi.string().uuid().required(),
  foodRating:    Joi.number().integer().min(1).max(5).required(),
  serviceRating: Joi.number().integer().min(1).max(5).required(),
  comment:       Joi.string().max(500).optional().allow('', null),
});

// ── promotions ───────────────────────────────────────────────────────────────
const createPromotionSchema = Joi.object({
  code:               Joi.string().alphanum().min(3).max(20).uppercase().required(),
  discount_type:      Joi.string().valid('percent', 'flat').required(),
  discount_value:     Joi.number().positive().required(),
  min_order_amount:   Joi.number().min(0).default(0),
  valid_from:         Joi.date().iso().required(),
  valid_to:           Joi.date().iso().greater(Joi.ref('valid_from')).required(),
  max_uses:           Joi.number().integer().positive().optional().allow(null),
});

// ── restaurant profile ────────────────────────────────────────────────────────
const updateRestaurantSchema = Joi.object({
  name:             Joi.string().min(2).max(100).optional(),
  phone:            Joi.string().pattern(/^[6-9]\d{9}$/).optional(),
  address:          Joi.string().max(300).optional().allow('', null),
  city:             Joi.string().max(60).optional().allow('', null),
  state:            Joi.string().max(60).optional().allow('', null),
  logo_url:         Joi.string().uri().max(500).optional().allow('', null),
  default_language: Joi.string().valid('en', 'te', 'hi', 'ta', 'kn', 'mr').optional(),
}).min(1);

// ── staff ─────────────────────────────────────────────────────────────────────
const createStaffSchema = Joi.object({
  name:     Joi.string().min(2).max(100).required(),
  email:    Joi.string().email().required(),
  password: Joi.string().min(8).max(72).required(),
  phone:    Joi.string().pattern(/^[6-9]\d{9}$/).optional().allow('', null),
  role:     Joi.string().valid('staff', 'kitchen').required(),
});

module.exports = {
  validate,
  // auth
  registerSchema,
  loginSchema,
  changePasswordSchema,
  // menu
  createMenuItemSchema,
  updateMenuItemSchema,
  // categories
  createCategorySchema,
  updateCategorySchema,
  // orders
  placeOrderSchema,
  updateOrderStatusSchema,
  // feedback
  feedbackSchema,
  // promotions
  createPromotionSchema,
  // restaurant
  updateRestaurantSchema,
  // staff
  createStaffSchema,
};