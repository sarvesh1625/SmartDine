require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mysql = require('mysql2/promise');

async function run() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'menucloud',
  });

  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id         INT          NOT NULL AUTO_INCREMENT,
        user_id    CHAR(36)     NOT NULL,
        token_hash TEXT         NOT NULL,
        expires_at DATETIME     NOT NULL,
        created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ refresh_tokens table created successfully');
  } catch (err) {
    console.error('❌ Failed:', err.message);
  } finally {
    await conn.end();
  }
}

run();