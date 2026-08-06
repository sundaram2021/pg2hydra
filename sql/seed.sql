CREATE TABLE customers (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL,
  tier        text NOT NULL DEFAULT 'standard',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,
  price_cents integer NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  role        text NOT NULL,
  manager_id  bigint REFERENCES employees(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           bigserial PRIMARY KEY,
  customer_id  bigint NOT NULL REFERENCES customers(id),
  handled_by   bigint REFERENCES employees(id),
  status       text NOT NULL,
  item_count   integer NOT NULL DEFAULT 0,
  total_cents  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id           bigserial PRIMARY KEY,
  order_id     bigint NOT NULL REFERENCES orders(id),
  product_id   bigint NOT NULL REFERENCES products(id),
  qty          integer NOT NULL,
  product_name text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES customers(id),
  key        text NOT NULL,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,
  action     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO customers (name, email, tier) VALUES
  ('Ada Lovelace', 'ada@example.com', 'gold'),
  ('Grace Hopper', 'grace@example.com', 'standard'),
  ('Alan Turing', 'alan@example.com', 'gold'),
  ('Katherine Johnson', 'katherine@example.com', 'platinum');

INSERT INTO products (name, category, price_cents) VALUES
  ('Mechanical Keyboard', 'peripherals', 12900),
  ('27-inch Monitor', 'displays', 34900),
  ('USB-C Dock', 'peripherals', 18900),
  ('Standing Desk', 'furniture', 59900);

INSERT INTO employees (name, role, manager_id) VALUES
  ('Rear Admiral', 'head of support', NULL),
  ('Jean Bartik', 'support lead', 1),
  ('Frances Spence', 'support agent', 2);

INSERT INTO orders (customer_id, handled_by, status, item_count, total_cents) VALUES
  (1, 3, 'shipped', 2, 47800),
  (1, 2, 'pending', 1, 34900),
  (2, 3, 'delivered', 3, 91700),
  (3, NULL, 'cancelled', 1, 59900),
  (4, 2, 'shipped', 2, 53800);

INSERT INTO order_items (order_id, product_id, qty, product_name) VALUES
  (1, 1, 1, 'Mechanical Keyboard'),
  (1, 3, 1, 'USB-C Dock'),
  (2, 2, 1, '27-inch Monitor'),
  (3, 1, 1, 'Mechanical Keyboard'),
  (3, 2, 1, '27-inch Monitor'),
  (3, 4, 1, 'Standing Desk'),
  (4, 4, 1, 'Standing Desk'),
  (5, 3, 2, 'USB-C Dock');

INSERT INTO user_preferences (user_id, key, value) VALUES
  (1, 'theme', 'dark'),
  (1, 'newsletter', 'weekly'),
  (2, 'theme', 'light'),
  (3, 'shipping', 'express'),
  (4, 'theme', 'dark');

INSERT INTO audit_log (actor, action) VALUES
  ('system', 'nightly reindex'),
  ('ada@example.com', 'password changed');
