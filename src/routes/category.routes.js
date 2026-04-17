const router = require('express').Router();
const c      = require('../controllers/category.controller');
const { authenticate, isAdmin } = require('../middleware/auth');
const { validate, createCategorySchema, updateCategorySchema } = require('../utils/validators');

router.get   ('/',    authenticate, isAdmin,                              c.getCategories);
router.post  ('/',    authenticate, isAdmin, validate(createCategorySchema), c.createCategory);
router.put   ('/:id', authenticate, isAdmin, validate(updateCategorySchema), c.updateCategory);
router.delete('/:id', authenticate, isAdmin,                              c.deleteCategory);

module.exports = router;