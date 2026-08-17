-- =============================================================================
-- Supabase PostgreSQL Schema for Twitch Local Game Data Bridge
-- Clean SQL table definitions with UPSERT (ON CONFLICT) optimization for zero bloat
-- =============================================================================

-- 1. Game Data Store (Payloads)
CREATE TABLE IF NOT EXISTS public.game_data (
  channel_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT DEFAULT 'text/plain',
  size INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, game_id, file_key)
);

-- Index for fast lookup by channel
CREATE INDEX IF NOT EXISTS idx_game_data_channel ON public.game_data(channel_id);

-- 2. Daily Channel Usage Stats
CREATE TABLE IF NOT EXISTS public.channel_stats (
  channel_id TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  uploads INT DEFAULT 0,
  bytes_in BIGINT DEFAULT 0,
  gets INT DEFAULT 0,
  bytes_out BIGINT DEFAULT 0,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, date)
);

-- 3. API Key Mapping
CREATE TABLE IF NOT EXISTS public.api_keys (
  api_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  twitch_user_id TEXT,
  twitch_login TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Channel Registrations
CREATE TABLE IF NOT EXISTS public.channels (
  channel_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  twitch_login TEXT,
  twitch_user_id TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Blocked Channels
CREATE TABLE IF NOT EXISTS public.blocked_channels (
  channel_id TEXT PRIMARY KEY,
  reason TEXT,
  blocked_at TIMESTAMPTZ DEFAULT NOW(),
  blocked_until TIMESTAMPTZ,
  blocked_by TEXT DEFAULT 'admin'
);

-- Enable Row Level Security (RLS) & Allow Anonymous Read Access to game_data
ALTER TABLE public.game_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_channels ENABLE ROW LEVEL SECURITY;

-- Allow public read access to game_data so Twitch overlay can fetch payload
CREATE POLICY "Allow public read to game_data" ON public.game_data FOR SELECT USING (true);
CREATE POLICY "Allow service role full access to game_data" ON public.game_data FOR ALL USING (true);

-- Allow public read/write to channel_stats for edge function tracking
CREATE POLICY "Allow public read to channel_stats" ON public.channel_stats FOR SELECT USING (true);
CREATE POLICY "Allow service role full access to channel_stats" ON public.channel_stats FOR ALL USING (true);
