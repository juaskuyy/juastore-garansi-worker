CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  product_name TEXT NOT NULL,
  price TEXT DEFAULT '',
  duration TEXT DEFAULT '',
  order_date TEXT DEFAULT '',
  order_id TEXT NOT NULL,
  payment TEXT DEFAULT '',
  claim_type TEXT DEFAULT 'Garansi',
  problem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Menunggu',
  admin_note TEXT DEFAULT '',
  telegram_chat_id TEXT DEFAULT '',
  telegram_message_id INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_whatsapp ON claims(whatsapp);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
