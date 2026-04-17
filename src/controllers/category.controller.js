const { query, queryOne } = require('../config/db');
const { cacheDelPattern } = require('../config/redis');
const { AppError } = require('../middleware/errorHandler');

async function getCategories(req, res, next) {
  try {
    const rows = await query(
      'SELECT * FROM categories WHERE restaurant_id = ? ORDER BY sort_order ASC, id ASC',
      [req.restaurantId]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
}

async function createCategory(req, res, next) {
  try {
    const { name_en, name_te, name_hi, name_ta, sort_order, image_url } = req.body;
    if (!name_en) throw new AppError('name_en is required', 400);
    const [result] = await require('../config/db').getDB().execute(
      `INSERT INTO categories (restaurant_id, name_en, name_te, name_hi, name_ta, sort_order, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.restaurantId, name_en, name_te || null, name_hi || null, name_ta || null, sort_order || 0, image_url || null]
    );
    await cacheDelPattern(`menu:${req.restaurantId}`);
    res.status(201).json({ success: true, message: 'Category created', data: { id: result.insertId } });
  } catch (err) { next(err); }
}

async function updateCategory(req, res, next) {
  try {
    const { id } = req.params;
    const { name_en, name_te, name_hi, name_ta, sort_order, image_url, is_active } = req.body;
    const cat = await queryOne('SELECT id FROM categories WHERE id = ? AND restaurant_id = ?', [id, req.restaurantId]);
    if (!cat) throw new AppError('Category not found', 404);
    await query(
      `UPDATE categories SET
        name_en    = COALESCE(?, name_en),
        name_te    = COALESCE(?, name_te),
        name_hi    = COALESCE(?, name_hi),
        name_ta    = COALESCE(?, name_ta),
        sort_order = COALESCE(?, sort_order),
        image_url  = COALESCE(?, image_url),
        is_active  = COALESCE(?, is_active)
       WHERE id = ? AND restaurant_id = ?`,
      [name_en, name_te, name_hi, name_ta, sort_order, image_url, is_active, id, req.restaurantId]
    );
    await cacheDelPattern(`menu:${req.restaurantId}`);
    res.json({ success: true, message: 'Category updated' });
  } catch (err) { next(err); }
}

async function deleteCategory(req, res, next) {
  try {
    const { id } = req.params;
    const result = await query(
      'DELETE FROM categories WHERE id = ? AND restaurant_id = ?',
      [id, req.restaurantId]
    );
    if (!result.affectedRows) throw new AppError('Category not found', 404);
    await cacheDelPattern(`menu:${req.restaurantId}`);
    res.json({ success: true, message: 'Category deleted' });
  } catch (err) { next(err); }
}

module.exports = { getCategories, createCategory, updateCategory, deleteCategory };