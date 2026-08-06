CREATE TABLE customers (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  full_name    TEXT NOT NULL,
  country      TEXT NOT NULL DEFAULT 'US',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  parent_id    INTEGER REFERENCES categories (id)
);

CREATE TABLE products (
  id           SERIAL PRIMARY KEY,
  sku          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  price_cents  INTEGER NOT NULL,
  category_id  INTEGER NOT NULL REFERENCES categories (id)
);

CREATE TABLE tags (
  id           SERIAL PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE
);

CREATE TABLE product_tags (
  product_id   INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  tag_id       INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);

CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers (id),
  status       TEXT NOT NULL DEFAULT 'pending',
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id     INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products (id),
  quantity     INTEGER NOT NULL DEFAULT 1,
  unit_cents   INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE VIEW order_summary AS
SELECT o.id AS order_id,
       c.full_name AS customer,
       o.status,
       count(oi.product_id) AS item_count,
       coalesce(sum(oi.quantity * oi.unit_cents), 0) AS total_cents
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, c.full_name, o.status;

INSERT INTO customers (email, full_name, country)
SELECT 'user' || i || '@example.com',
       (ARRAY['Alice Chen','Bruno Costa','Divya Rao','Erik Holm','Farida Nasser'])[1 + (i % 5)] || ' ' || i,
       (ARRAY['US','BR','IN','SE','EG'])[1 + (i % 5)]
FROM generate_series(1, 40) AS i;

INSERT INTO categories (name, parent_id) VALUES ('Electronics', NULL), ('Home', NULL);
INSERT INTO categories (name, parent_id) VALUES ('Laptops', 1), ('Audio', 1), ('Kitchen', 2);

INSERT INTO products (sku, name, price_cents, category_id)
SELECT 'SKU-' || lpad(i::text, 4, '0'),
       (ARRAY['Aurora Laptop','Nimbus Headphones','Kettle Pro','Studio Monitor','Chef Knife'])[1 + (i % 5)] || ' v' || i,
       9900 + (i * 137) % 90000,
       3 + (i % 3)
FROM generate_series(1, 30) AS i;

INSERT INTO tags (label) VALUES ('bestseller'), ('refurbished'), ('new-arrival'), ('clearance');

INSERT INTO product_tags (product_id, tag_id)
SELECT p, 1 + ((p * t) % 4)
FROM generate_series(1, 30) AS p, generate_series(1, 2) AS t
ON CONFLICT DO NOTHING;

INSERT INTO orders (customer_id, status, placed_at)
SELECT 1 + (i % 40),
       (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + (i % 5)],
       now() - (i || ' hours')::interval
FROM generate_series(1, 120) AS i;

INSERT INTO order_items (order_id, product_id, quantity, unit_cents)
SELECT o, 1 + ((o * k) % 30), 1 + (k % 3), 9900 + ((o * k) % 50000)
FROM generate_series(1, 120) AS o, generate_series(1, 3) AS k
ON CONFLICT DO NOTHING;
