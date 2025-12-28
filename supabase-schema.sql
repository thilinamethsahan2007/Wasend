-- WaSender 2.0 Supabase Schema (Single Session Mode)
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Contacts Table
-- ============================================
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster phone lookups
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

-- ============================================
-- Birthdays Table
-- ============================================
CREATE TABLE IF NOT EXISTS birthdays (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  birthday DATE NOT NULL,
  gender TEXT CHECK (gender IN ('male', 'female')),
  relationship TEXT CHECK (relationship IN ('friend', 'family', 'relative', 'other')),
  custom_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for birthday date lookups
CREATE INDEX IF NOT EXISTS idx_birthdays_birthday ON birthdays(birthday);

-- ============================================
-- Schedule (Message Queue) Table
-- ============================================
CREATE TABLE IF NOT EXISTS schedule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id TEXT,
  recipient TEXT NOT NULL,
  caption TEXT,
  media_url TEXT,
  media_type TEXT,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for queue processing
CREATE INDEX IF NOT EXISTS idx_schedule_status ON schedule(status);
CREATE INDEX IF NOT EXISTS idx_schedule_send_at ON schedule(send_at);
CREATE INDEX IF NOT EXISTS idx_schedule_status_send_at ON schedule(status, send_at);

-- ============================================
-- Finances Table
-- ============================================
CREATE TABLE IF NOT EXISTS finances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Income', 'Expense')),
  amount DECIMAL(10, 2) NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for finance queries
CREATE INDEX IF NOT EXISTS idx_finances_date ON finances(date);
CREATE INDEX IF NOT EXISTS idx_finances_type ON finances(type);
CREATE INDEX IF NOT EXISTS idx_finances_category ON finances(category);

-- ============================================
-- Settings Table
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default settings
INSERT INTO settings (key, value) VALUES
  ('auto_view_status', 'true'),
  ('auto_react_status', 'true'),
  ('reaction_emoji', '🩵,🧡,💙,💚,💛,❤️'),
  ('freeze_last_seen', 'true')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE birthdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Allow all operations with anon key (for development)
CREATE POLICY "Allow all for contacts" ON contacts FOR ALL USING (true);
CREATE POLICY "Allow all for birthdays" ON birthdays FOR ALL USING (true);
CREATE POLICY "Allow all for schedule" ON schedule FOR ALL USING (true);
CREATE POLICY "Allow all for finances" ON finances FOR ALL USING (true);
CREATE POLICY "Allow all for settings" ON settings FOR ALL USING (true);
