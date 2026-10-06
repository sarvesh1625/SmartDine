const { query } = require('../config/db');
const logger = require('./logger');

/*
  Moves a restaurant back to the Free plan once its paid subscription has run out.

  A main restaurant is "lapsed" when ALL of these are true:
    - its plan is currently pro or enterprise
    - it has at least one paid subscription record  (so restaurants you upgraded by hand
      with no record at all are never touched)
    - it has no active paid subscription whose end_date is today or later

  Branches have no subscription of their own: they follow their main restaurant.
*/
const LAPSED_SQL = `
  SELECT r.id, r.name, r.plan_type
  FROM restaurants r
  WHERE r.parent_restaurant_id IS NULL
    AND r.plan_type IN ('pro', 'enterprise')
    AND EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.restaurant_id = r.id AND s.plan_type IN ('pro', 'enterprise')
    )
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.restaurant_id = r.id
        AND s.plan_type IN ('pro', 'enterprise')
        AND s.status = 'active'
        AND s.end_date >= CURDATE()
    )`;

/**
 * @param {string|null} onlyRestaurantId  limit the check to one main restaurant
 * @returns {Promise<Array>} restaurants that were moved to free
 */
async function expireSubscriptions(onlyRestaurantId = null) {
  const lapsed = await query(
    LAPSED_SQL + (onlyRestaurantId ? ' AND r.id = ?' : ''),
    onlyRestaurantId ? [onlyRestaurantId] : []
  );

  if (lapsed.length) {
    const ids = lapsed.map(r => r.id);
    const ph  = ids.map(() => '?').join(',');
    await query(
      `UPDATE restaurants SET plan_type = 'free'
       WHERE id IN (${ph}) OR parent_restaurant_id IN (${ph})`,
      [...ids, ...ids]
    );
    logger.info(`Plan expired → free: ${lapsed.map(r => `${r.name} (${r.plan_type})`).join(', ')}`);
  }

  // Keep the subscription records honest too
  await query(
    `UPDATE subscriptions SET status = 'expired'
     WHERE status = 'active' AND plan_type IN ('pro', 'enterprise') AND end_date < CURDATE()
     ${onlyRestaurantId ? 'AND restaurant_id = ?' : ''}`,
    onlyRestaurantId ? [onlyRestaurantId] : []
  );

  return lapsed;
}

// Runs shortly after boot, then every hour
function startSubscriptionExpiryJob() {
  const run = () => expireSubscriptions().catch(err =>
    logger.error(`Subscription expiry job failed: ${err.message}`)
  );
  setTimeout(run, 15 * 1000);
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { expireSubscriptions, startSubscriptionExpiryJob };