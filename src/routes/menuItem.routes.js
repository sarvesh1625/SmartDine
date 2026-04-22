const router = require('express').Router();
const c      = require('../controllers/menuItem.controller');
const { authenticate, isAdmin } = require('../middleware/auth');
const { validate, createMenuItemSchema, updateMenuItemSchema } = require('../utils/validators');

router.get   ('/public',           c.getPublicMenu);
router.get   ('/',                 authenticate, isAdmin,                               c.getAdminMenuItems);
router.post  ('/',                 authenticate, isAdmin, validate(createMenuItemSchema), c.createMenuItem);
router.put   ('/:id',              authenticate, isAdmin, validate(updateMenuItemSchema), c.updateMenuItem);
router.patch ('/:id/availability', authenticate, isAdmin,                               c.toggleAvailability);
router.delete('/:id',              authenticate, isAdmin,                               c.deleteMenuItem);

module.exports = router;