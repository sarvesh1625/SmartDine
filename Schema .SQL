-- MenuCloud — Multi-Tenant SaaS Database Schema
-- MySQL 8.0+ | charset: utf8mb4 | timezone: +05:30
-- All tenant-specific tables carry restaurant_id for row-level isolation

CREATE DATABASE IF NOT EXISTS menucloud CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE menucloud;

-- ─────────────────────────────────────────────────────────────────────────────
-- restaurants
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurants (
  id               CHAR(36)     NOT NULL PRIMARY KEY,          -- UUID
  name             VARCHAR(100) NOT NULL,
  slug             VARCHAR(120) NOT NULL UNIQUE,               -- URL-safe identifier
  owner_id         CHAR(36)     NULL,                          -- FK → users (set after user insert)
  plan_type        ENUM('free','pro','enterprise') NOT NULL DEFAULT 'free',
  logo_url         VARCHAR(500) NULL,
  address          VARCHAR(300) NULL,
  city             VARCHAR(60)  NULL,
  state            VARCHAR(60)  NULL,
  phone            VARCHAR(15)  NULL,
  email            VARCHAR(150) NULL,
  default_language ENUM('en','te','hi','ta','kn','mr') NOT NULL DEFAULT 'en',
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  restaurant_id CHAR(36)     NULL,                             -- NULL for super_admin
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('super_admin','admin','staff','kitchen') NOT NULL DEFAULT 'staff',
  phone         VARCHAR(15)  NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE
);

ALTER TABLE restaurants
  ADD CONSTRAINT fk_restaurants_owner FOREIGN KEY (owner_id)
    REFERENCES users(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  restaurant_id            CHAR(36)    NOT NULL,
  plan_type                ENUM('free','pro','enterprise') NOT NULL,
  start_date               DATE        NOT NULL,
  end_date                 DATE        NOT NULL,
  amount_paid              DECIMAL(10,2) NOT NULL DEFAULT 0,
  razorpay_subscription_id VARCHAR(100) NULL,
  status                   ENUM('active','expired','cancelled') NOT NULL DEFAULT 'active',
  created_at               DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_subscriptions_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- tables_info
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tables_info (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  restaurant_id CHAR(36)    NOT NULL,
  table_number  VARCHAR(10) NOT NULL,
  qr_code_url   VARCHAR(500) NULL,
  is_active     TINYINT(1)  NOT NULL DEFAULT 1,
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_table (restaurant_id, table_number),
  CONSTRAINT fk_tables_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- categories
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  restaurant_id CHAR(36)    NOT NULL,
  name_en       VARCHAR(80) NOT NULL,
  name_te       VARCHAR(80) NULL,
  name_hi       VARCHAR(80) NULL,
  name_ta       VARCHAR(80) NULL,
  sort_order    INT         NOT NULL DEFAULT 0,
  image_url     VARCHAR(500) NULL,
  is_active     TINYINT(1)  NOT NULL DEFAULT 1,
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_categories_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- menu_items
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  restaurant_id         CHAR(36)       NOT NULL,
  category_id           INT UNSIGNED   NOT NULL,
  name_en               VARCHAR(120)   NOT NULL,
  name_te               VARCHAR(120)   NULL,
  name_hi               VARCHAR(120)   NULL,
  description_en        TEXT           NULL,
  description_te        TEXT           NULL,
  price                 DECIMAL(10,2)  NOT NULL,
  discounted_price      DECIMAL(10,2)  NULL,
  image_url             VARCHAR(500)   NULL,
  is_veg                TINYINT(1)     NOT NULL DEFAULT 1,
  is_available          TINYINT(1)     NOT NULL DEFAULT 1,
  preparation_time_mins INT            NOT NULL DEFAULT 15,
  calories              INT            NULL,
  tags                  JSON           NULL,
  sort_order            INT            NOT NULL DEFAULT 0,
  created_at            DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_items_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_category FOREIGN KEY (category_id)
    REFERENCES categories(id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- orders
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                   CHAR(36)      NOT NULL PRIMARY KEY,
  restaurant_id        CHAR(36)      NOT NULL,
  table_id             INT UNSIGNED  NULL,
  customer_name        VARCHAR(100)  NOT NULL DEFAULT 'Guest',
  customer_phone       VARCHAR(15)   NULL,
  status               ENUM('placed','confirmed','preparing','ready','delivered','cancelled')
                                     NOT NULL DEFAULT 'placed',
  total_amount         DECIMAL(10,2) NOT NULL,
  discount_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  final_amount         DECIMAL(10,2) NOT NULL,
  payment_status       ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  payment_method       ENUM('razorpay','cash','counter') NULL,
  razorpay_order_id    VARCHAR(100)  NULL,
  razorpay_payment_id  VARCHAR(100)  NULL,
  special_instructions TEXT          NULL,
  created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_table FOREIGN KEY (table_id)
    REFERENCES tables_info(id) ON DELETE SET NULL
);

-- Indexes for common queries
CREATE INDEX idx_orders_restaurant_status   ON orders(restaurant_id, status);
CREATE INDEX idx_orders_restaurant_date     ON orders(restaurant_id, created_at);
CREATE INDEX idx_orders_payment_status      ON orders(payment_status);

-- ─────────────────────────────────────────────────────────────────────────────
-- order_items
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id                  INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  order_id            CHAR(36)      NOT NULL,
  menu_item_id        INT UNSIGNED  NOT NULL,
  quantity            INT           NOT NULL,
  unit_price          DECIMAL(10,2) NOT NULL,
  item_name_snapshot  VARCHAR(120)  NOT NULL,  -- captured at order time, survives menu edits
  customization_notes VARCHAR(200)  NULL,
  created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_item FOREIGN KEY (menu_item_id)
    REFERENCES menu_items(id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- feedback
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  restaurant_id  CHAR(36)    NOT NULL,
  order_id       CHAR(36)    NOT NULL UNIQUE,   -- one feedback per order
  food_rating    TINYINT     NOT NULL CHECK (food_rating BETWEEN 1 AND 5),
  service_rating TINYINT     NOT NULL CHECK (service_rating BETWEEN 1 AND 5),
  comment        VARCHAR(500) NULL,
  created_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_feedback_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE,
  CONSTRAINT fk_feedback_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- promotions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promotions (
  id                INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  restaurant_id     CHAR(36)      NOT NULL,
  code              VARCHAR(20)   NOT NULL,
  discount_type     ENUM('percent','flat') NOT NULL,
  discount_value    DECIMAL(10,2) NOT NULL,
  min_order_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  valid_from        DATETIME      NOT NULL,
  valid_to          DATETIME      NOT NULL,
  max_uses          INT           NULL,
  used_count        INT           NOT NULL DEFAULT 0,
  is_active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_promo_code (restaurant_id, code),
  CONSTRAINT fk_promotions_restaurant FOREIGN KEY (restaurant_id)
    REFERENCES restaurants(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add trial system to restaurants
-- Run this in phpMyAdmin → menucloud → SQL tab
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add trial_ends_at column to restaurants
ALTER TABLE restaurants
  ADD COLUMN trial_ends_at DATETIME NULL DEFAULT NULL AFTER plan_type;

-- 2. Set 15-day trial for all existing restaurants from their registration date
UPDATE restaurants
SET trial_ends_at = DATE_ADD(created_at, INTERVAL 15 DAY)
WHERE trial_ends_at IS NULL;

-- 3. Verify
SELECT id, name, plan_type, created_at, trial_ends_at,
       DATEDIFF(trial_ends_at, NOW()) AS days_left
FROM restaurants
ORDER BY created_at DESC;