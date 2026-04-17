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
    connectionLimit:    20,
    queueLimit:         0,
    timezone:           '+05:30',
    charset:            'utf8mb4',
  });

  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  return pool;
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