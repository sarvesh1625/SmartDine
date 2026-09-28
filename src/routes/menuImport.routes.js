const router = require('express').Router();
const { authenticate, isAdmin, isSuperAdmin } = require('../middleware/auth');
const { queryOne, transaction } = require('../config/db');
const { cacheDelPattern } = require('../config/redis');
const { AppError } = require('../middleware/errorHandler');

const MAX_ROWS = 500;

function parseVeg(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['0', 'false', 'no', 'n', 'non-veg', 'nonveg', 'non veg'].includes(s) ? 0 : 1;
}

function optionalNumber(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function importMenu(restaurantId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('No rows to import', 400);
  if (rows.length > MAX_ROWS) throw new AppError(`Maximum ${MAX_ROWS} items per upload`, 400);

  // ── Validate every row first, so nothing is half-imported ──
  const errors = [];
  const clean  = [];
  rows.forEach((r, i) => {
    const line     = i + 2; // +2 = header row + 1-based
    const category = String(r.category || '').trim();
    const name     = String(r.name_en  || '').trim();
    const price    = Number(r.price);
    const disc     = optionalNumber(r.discounted_price);

    if (!category)              return errors.push(`Row ${line}: category is required`);
    if (!name)                  return errors.push(`Row ${line}: name_en is required`);
    if (!(price > 0))           return errors.push(`Row ${line}: price must be a number above 0`);
    if (Number.isNaN(disc) || (disc !== null && !(disc > 0 && disc < price))) {
      return errors.push(`Row ${line}: discounted_price must be less than price`);
    }

    clean.push({
      category,
      name_en:               name.slice(0, 150),
      name_te:               String(r.name_te || '').trim().slice(0, 150) || null,
      description_en:        String(r.description_en || '').trim() || null,
      price,
      discounted_price:      disc,
      image_url:             String(r.image_url || '').trim() || null,
      is_veg:                parseVeg(r.is_veg),
      preparation_time_mins: Math.min(Math.max(parseInt(r.preparation_time_mins) || 15, 1), 180),
    });
  });
  if (errors.length) {
    throw new AppError(`Fix these and upload again — ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? ` (+${errors.length - 8} more)` : ''}`, 400);
  }

  // ── One transaction: all rows succeed or none do ──
  const result = await transaction(async (conn) => {
    const [catRows]  = await conn.execute('SELECT id, name_en FROM categories WHERE restaurant_id = ?', [restaurantId]);
    const catMap     = new Map(catRows.map(c => [c.name_en.trim().toLowerCase(), c.id]));

    const [itemRows] = await conn.execute('SELECT category_id, name_en FROM menu_items WHERE restaurant_id = ?', [restaurantId]);
    const existing   = new Set(itemRows.map(i => `${i.category_id}|${i.name_en.trim().toLowerCase()}`));

    let categoriesCreated = 0;
    let skipped = 0;
    const toInsert = [];

    for (const item of clean) {
      const key = item.category.toLowerCase();
      let catId = catMap.get(key);
      if (!catId) {
        const [res] = await conn.execute(
          'INSERT INTO categories (restaurant_id, name_en, sort_order) VALUES (?, ?, ?)',
          [restaurantId, item.category, catMap.size]
        );
        catId = res.insertId;
        catMap.set(key, catId);
        categoriesCreated++;
      }

      const dupKey = `${catId}|${item.name_en.toLowerCase()}`;
      if (existing.has(dupKey)) { skipped++; continue; }   // same dish already in this category
      existing.add(dupKey);

      toInsert.push([
        restaurantId, catId, item.name_en, item.name_te, item.description_en,
        item.price, item.discounted_price, item.image_url, item.is_veg,
        item.preparation_time_mins, toInsert.length,
      ]);
    }

    if (toInsert.length) {
      // Single multi-row INSERT — much faster than 500 separate queries
      await conn.query(
        `INSERT INTO menu_items
           (restaurant_id, category_id, name_en, name_te, description_en,
            price, discounted_price, image_url, is_veg, preparation_time_mins, sort_order)
         VALUES ?`,
        [toInsert]
      );
    }

    return { created: toInsert.length, skipped, categoriesCreated };
  });

  await cacheDelPattern(`menu:${restaurantId}`);
  return result;
}

// POST /api/v1/menu-import/superadmin/:restaurantId  — super admin, any restaurant
router.post('/superadmin/:restaurantId', authenticate, isSuperAdmin, async (req, res, next) => {
  try {
    const restaurant = await queryOne('SELECT id FROM restaurants WHERE id = ?', [req.params.restaurantId]);
    if (!restaurant) throw new AppError('Restaurant not found', 404);
    const data = await importMenu(restaurant.id, req.body.rows);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// POST /api/v1/menu-import/me  — restaurant admin, their own menu only
router.post('/me', authenticate, isAdmin, async (req, res, next) => {
  try {
    if (!req.restaurantId) throw new AppError('No restaurant linked to this account', 400);
    const data = await importMenu(req.restaurantId, req.body.rows);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

module.exports = router;