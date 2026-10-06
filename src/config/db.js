const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

let pool;

async function connectDB() {
  pool = mysql.createPool({
    host:               process.env.DB_HOST || 'localhost',
    port:               parseInt(process.env.DB_PORT) || 3306,
    user:               process.env.DB_USER || 'root',
    password:           process.env.DB_PASSWORD || '',
    database:           process.env.DB_NAME || 'menucloud',
    waitForConnections: true,
    // The database plan allows only 5 connections in total for this user. Keep each server
    // well below that: during a deploy the old and the new server run side by side, and
    // phpMyAdmin needs one too. Extra requests simply wait in line for a free connection.
    connectionLimit:    3,
    queueLimit:         0,
    maxIdle:            1,       // keep just 1 idle connection open...
    idleTimeout:        15000,   // ...and close the rest after 15 s, so an old server frees them up
    // MySQL's CURRENT_TIMESTAMP / NOW() store UTC. Read them as UTC ('Z') — the browser
    // then shows them in the viewer's own time (IST in India). '+05:30' here made every
    // time appear 5 h 30 min earlier than it really was.
    timezone:           'Z',
    charset:            'utf8mb4',
  });

  // If the database is full (e.g. the old server is still shutting down during a deploy),
  // wait and try again instead of crashing straight away.
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      return pool;
    } catch (err) {
      if (err.errno !== 1226 || attempt >= MAX_ATTEMPTS) throw err;   // 1226 = connection limit reached
      logger.warn(`Database connection limit reached (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in 5s`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function getDB() {
  if (!pool) throw new Error('Database not initialized. Call connectDB() first.');
  return pool;
}

async function query(sql, params = []) {
  const db = getDB();
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function transaction(callback) {
  const db = getDB();
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { connectDB, getDB, query, queryOne, transaction };