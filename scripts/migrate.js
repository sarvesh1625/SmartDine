require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mysql = require('mysql2/promise');

const schema = `
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS promotions;
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS tables_info;
DROP TABLE IF EXISTS menu_items;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS restaurants;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE restaurants (
  id               CHAR(36)      NOT NULL DEFAULT (UUID()),
  name             VARCHAR(150)  NOT NULL,
  slug             VARCHAR(100)  NOT NULL UNIQUE,
  phone            VARCHAR(20)   NOT NULL,
  email            VARCHAR(150)  NOT NULL UNIQUE,
  address          TEXT,
  city             VARCHAR(100),
  state            VARCHAR(100),
  logo_url         TEXT,
  default_language VARCHAR(10)   NOT NULL DEFAULT 'en',
  plan_type        ENUM('free','pro','enterprise') NOT NULL DEFAULT 'free',
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id              CHAR(36)     NOT NULL DEFAULT (UUID()),
  restaurant_id   CHAR(36)     NULL,
  name            VARCHAR(100) NOT NULL,
  email           VARCHAR(150) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  role            ENUM('super_admin','admin','staff','kitchen') NOT NULL DEFAULT 'admin',
  phone           VARCHAR(20),
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  INDEX idx_restaurant (restaurant_id),
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE categories (
  id              INT          NOT NULL AUTO_INCREMENT,
  restaurant_id   CHAR(36)     NOT NULL,
  name_en         VARCHAR(100) NOT NULL,
  name_te         VARCHAR(100),
  name_hi         VARCHAR(100),
  name_ta         VARCHAR(100),
  sort_order      INT          NOT NULL DEFAULT 0,
  image_url       TEXT,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  INDEX idx_restaurant (restaurant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE menu_items (
  id                     INT           NOT NULL AUTO_INCREMENT,
  restaurant_id          CHAR(36)      NOT NULL,
  category_id            INT           NOT NULL,
  name_en                VARCHAR(150)  NOT NULL,
  name_te                VARCHAR(150),
  name_hi                VARCHAR(150),
  description_en         TEXT,
  description_te         TEXT,
  price                  DECIMAL(10,2) NOT NULL,
  discounted_price       DECIMAL(10,2),
  image_url              TEXT,
  is_veg                 TINYINT(1)    NOT NULL DEFAULT 1,
  is_available           TINYINT(1)    NOT NULL DEFAULT 1,
  preparation_time_mins  INT           NOT NULL DEFAULT 15,
  calories               INT,
  tags                   JSON,
  sort_order             INT           NOT NULL DEFAULT 0,
  created_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id)   REFERENCES categories(id)  ON DELETE CASCADE,
  INDEX idx_restaurant (restaurant_id),
  INDEX idx_category   (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tables_info (
  id              INT          NOT NULL AUTO_INCREMENT,
  restaurant_id   CHAR(36)     NOT NULL,
  table_number    VARCHAR(20)  NOT NULL,
  qr_code_url     TEXT,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_restaurant_table (restaurant_id, table_number),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE orders (
  id                   CHAR(36)      NOT NULL DEFAULT (UUID()),
  restaurant_id        CHAR(36)      NOT NULL,
  table_id             INT           NULL,
  customer_name        VARCHAR(100),
  customer_phone       VARCHAR(20),
  status               ENUM('placed','confirmed','preparing','ready','delivered','cancelled') NOT NULL DEFAULT 'placed',
  total_amount         DECIMAL(10,2) NOT NULL,
  discount_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  final_amount         DECIMAL(10,2) NOT NULL,
  payment_status       ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  payment_method       ENUM('upi','card','cash','pending') NOT NULL DEFAULT 'pending',
  razorpay_order_id    VARCHAR(100),
  razorpay_payment_id  VARCHAR(100),
  special_instructions TEXT,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (table_id)      REFERENCES tables_info(id) ON DELETE SET NULL,
  INDEX idx_restaurant (restaurant_id),
  INDEX idx_status     (status),
  INDEX idx_created    (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE order_items (
  id                    INT           NOT NULL AUTO_INCREMENT,
  order_id              CHAR(36)      NOT NULL,
  menu_item_id          INT           NOT NULL,
  quantity              INT           NOT NULL DEFAULT 1,
  unit_price            DECIMAL(10,2) NOT NULL,
  item_name_snapshot    VARCHAR(200)  NOT NULL,
  customization_notes   TEXT,
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (order_id)     REFERENCES orders(id)     ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE RESTRICT,
  INDEX idx_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE feedback (
  id              INT          NOT NULL AUTO_INCREMENT,
  restaurant_id   CHAR(36)     NOT NULL,
  order_id        CHAR(36)     NOT NULL UNIQUE,
  food_rating     TINYINT      NOT NULL CHECK (food_rating BETWEEN 1 AND 5),
  service_rating  TINYINT      NOT NULL CHECK (service_rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id)      REFERENCES orders(id)      ON DELETE CASCADE,
  INDEX idx_restaurant (restaurant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE subscriptions (
  id                         INT          NOT NULL AUTO_INCREMENT,
  restaurant_id              CHAR(36)     NOT NULL,
  plan_type                  ENUM('free','pro','enterprise') NOT NULL,
  start_date                 DATE         NOT NULL,
  end_date                   DATE         NOT NULL,
  amount_paid                DECIMAL(10,2) NOT NULL DEFAULT 0,
  razorpay_subscription_id   VARCHAR(100),
  status                     ENUM('active','expired','cancelled') NOT NULL DEFAULT 'active',
  created_at                 DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  INDEX idx_restaurant (restaurant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE promotions (
  id                INT           NOT NULL AUTO_INCREMENT,
  restaurant_id     CHAR(36)      NOT NULL,
  code              VARCHAR(30)   NOT NULL,
  discount_type     ENUM('percent','flat') NOT NULL,
  discount_value    DECIMAL(10,2) NOT NULL,
  min_order_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  valid_from        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  max_uses          INT,
  used_count        INT           NOT NULL DEFAULT 0,
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_restaurant_code (restaurant_id, code),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function migrate() {
  const conn = await mysql.createConnection({
    host:               process.env.DB_HOST || 'localhost',
    port:               parseInt(process.env.DB_PORT) || 3306,
    user:               process.env.DB_USER || 'root',
    password:           process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'menucloud'}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${process.env.DB_NAME || 'menucloud'}\``);
    console.log('✅  Database selected');
    await conn.query(schema);
    console.log('✅  All tables created successfully');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

migrate();