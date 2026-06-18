const { query, queryOne, getDB } = require('../config/db');
const { cacheGet, cacheSet, cacheDelPattern } = require('../config/redis');
const { AppError } = require('../middleware/errorHandler');

const MENU_CACHE_TTL = 600;
const cacheKey = (restaurantId) => `menu:${restaurantId}`;

async function getPublicMenu(req, res, next) {
  try {
    const { restaurantSlug } = req.query;
    if (!restaurantSlug) throw new AppError('restaurantSlug is required', 400);

    const restaurant = await queryOne(
      'SELECT id, name, slug, logo_url, default_language, is_active FROM restaurants WHERE slug = ?',
      [restaurantSlug]
    );
    if (!restaurant || !restaurant.is_active) throw new AppError('Restaurant not found', 404);

    const cached = await cacheGet(cacheKey(restaurant.id));
    if (cached) return res.json({ success: true, cached: true, data: { restaurant, menu: cached } });

    const categories = await query(
      `SELECT id, name_en, name_te, name_hi, name_ta, sort_order, image_url
       FROM categories WHERE restaurant_id = ? AND is_active = 1
       ORDER BY sort_order ASC, id ASC`,
      [restaurant.id]
    );

    const items = await query(
      `SELECT id, category_id, name_en, name_te, name_hi,
              description_en, description_te, price, discounted_price,
              image_url, is_veg, is_available, preparation_time_mins, calories, tags,
              is_combo, combo_items, combo_savings
       FROM menu_items WHERE restaurant_id = ?
       ORDER BY sort_order ASC, id ASC`,
      [restaurant.id]
    );

    const parseCombo = (item) => ({
      ...item,
      combo_items: item.combo_items
        ? (typeof item.combo_items === 'string' ? (() => { try { return JSON.parse(item.combo_items); } catch { return []; } })() : item.combo_items)
        : [],
      tags: item.tags
        ? (typeof item.tags === 'string' ? (() => { try { return JSON.parse(item.tags); } catch { return []; } })() : item.tags)
        : [],
    });

    const menu = categories.map(cat => ({
      ...cat,
      items: items.filter(item => item.category_id === cat.id).map(parseCombo),
    }));

    await cacheSet(cacheKey(restaurant.id), menu, MENU_CACHE_TTL);
    res.json({ success: true, cached: false, data: { restaurant, menu } });
  } catch (err) { next(err); }
}

async function getAdminMenuItems(req, res, next) {
  try {
    const { categoryId } = req.query;
    let sql = `SELECT m.*, c.name_en AS category_name
               FROM menu_items m JOIN categories c ON c.id = m.category_id
               WHERE m.restaurant_id = ?`;
    const params = [req.restaurantId];
    if (categoryId) { sql += ' AND m.category_id = ?'; params.push(categoryId); }
    sql += ' ORDER BY m.sort_order ASC, m.id ASC';
    const rawItems = await query(sql, params);
    const items = rawItems.map(item => ({
      ...item,
      combo_items: item.combo_items
        ? (typeof item.combo_items === 'string' ? (() => { try { return JSON.parse(item.combo_items); } catch { return []; } })() : item.combo_items)
        : [],
      tags: item.tags
        ? (typeof item.tags === 'string' ? (() => { try { return JSON.parse(item.tags); } catch { return []; } })() : item.tags)
        : [],
    }));
    res.json({ success: true, data: items });
  } catch (err) { next(err); }
}

async function createMenuItem(req, res, next) {
  try {
    const {
      category_id, name_en, name_te, name_hi,
      description_en, description_te, price, discounted_price,
      image_url, is_veg, preparation_time_mins, calories, tags,
      is_combo, combo_items, combo_savings,
    } = req.body;

    if (!category_id || !name_en || !price) throw new AppError('category_id, name_en, and price are required', 400);

    const cat = await queryOne(
      'SELECT id FROM categories WHERE id = ? AND restaurant_id = ?',
      [category_id, req.restaurantId]
    );
    if (!cat) throw new AppError('Category not found', 404);

    const [result] = await getDB().execute(
      `INSERT INTO menu_items
        (restaurant_id, category_id, name_en, name_te, name_hi,
         description_en, description_te, price, discounted_price,
         image_url, is_veg, preparation_time_mins, calories, tags,
         is_combo, combo_items, combo_savings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.restaurantId, category_id, name_en, name_te || null, name_hi || null,
        description_en || null, description_te || null, price,
        discounted_price || null, image_url || null,
        is_veg ?? 1, preparation_time_mins || 15, calories || null,
        tags ? JSON.stringify(tags) : null,
        is_combo ? 1 : 0,
        combo_items ? JSON.stringify(combo_items) : null,
        combo_savings || null,
      ]
    );

    await cacheDelPattern(cacheKey(req.restaurantId));
    res.status(201).json({ success: true, message: 'Menu item created', data: { id: result.insertId } });
  } catch (err) { next(err); }
}

async function updateMenuItem(req, res, next) {
  try {
    const { id } = req.params;
    const item = await queryOne('SELECT id FROM menu_items WHERE id = ? AND restaurant_id = ?', [id, req.restaurantId]);
    if (!item) throw new AppError('Menu item not found', 404);

    const fields = ['name_en','name_te','name_hi','description_en','description_te','price',
                    'discounted_price','image_url','is_veg','preparation_time_mins','calories','tags','sort_order',
                    'is_combo','combo_items','combo_savings'];
    const updates = [], values = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        const needsStringify = ['tags','combo_items'].includes(f);
        values.push(needsStringify && req.body[f] ? JSON.stringify(req.body[f]) : req.body[f]);
      }
    });
    if (!updates.length) throw new AppError('No fields to update', 400);

    values.push(id, req.restaurantId);
    await query(`UPDATE menu_items SET ${updates.join(', ')} WHERE id = ? AND restaurant_id = ?`, values);
    await cacheDelPattern(cacheKey(req.restaurantId));
    res.json({ success: true, message: 'Menu item updated' });
  } catch (err) { next(err); }
}

async function toggleAvailability(req, res, next) {
  try {
    const { id } = req.params;
    const item = await queryOne('SELECT id, is_available FROM menu_items WHERE id = ? AND restaurant_id = ?', [id, req.restaurantId]);
    if (!item) throw new AppError('Menu item not found', 404);

    const newStatus = item.is_available ? 0 : 1;
    await query('UPDATE menu_items SET is_available = ? WHERE id = ? AND restaurant_id = ?', [newStatus, id, req.restaurantId]);
    await cacheDelPattern(cacheKey(req.restaurantId));
    res.json({ success: true, message: `Item marked as ${newStatus ? 'available' : 'unavailable'}`, data: { is_available: newStatus } });
  } catch (err) { next(err); }
}

async function deleteMenuItem(req, res, next) {
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?', [id, req.restaurantId]);
    if (!result.affectedRows) throw new AppError('Menu item not found', 404);
    await cacheDelPattern(cacheKey(req.restaurantId));
    res.json({ success: true, message: 'Menu item deleted' });
  } catch (err) { next(err); }
}


module.exports = { getPublicMenu, getAdminMenuItems, createMenuItem, updateMenuItem, toggleAvailability, deleteMenuItem };