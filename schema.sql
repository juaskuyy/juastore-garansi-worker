DROP TABLE IF EXISTS claims;

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  product_name TEXT NOT NULL,
  price TEXT DEFAULT '',
  duration TEXT NOT NULL,
  order_date TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  payment TEXT DEFAULT '',
  claim_type TEXT NOT NULL,
  problem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'MENUNGGU',
  admin_note TEXT DEFAULT '',
  telegram_chat_id TEXT DEFAULT '',
  telegram_message_id TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_claims_order_id ON claims(order_id);
CREATE INDEX idx_claims_whatsapp ON claims(whatsapp);
CREATE INDEX idx_claims_status ON claims(status);
CREATE INDEX idx_claims_created_at ON claims(created_at);