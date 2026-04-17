const router = require('express').Router();
const { register, login, refreshToken, logout, getMe, changePassword } = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { validate, registerSchema, loginSchema, changePasswordSchema } = require('../utils/validators');

router.post('/register',        validate(registerSchema),        register);
router.post('/login',           validate(loginSchema),           login);
router.post('/refresh',                                          refreshToken);
router.post('/logout',          authenticate,                    logout);
router.get ('/me',              authenticate,                    getMe);
router.put ('/change-password', authenticate, validate(changePasswordSchema), changePassword);

module.exports = router;