# Supabase Setup & Migration Guide

This guide walks you through setting up your free Supabase project and deploying the Supabase Edge Function for the Twitch Local Game Data Bridge.

---

## 1. Create a Free Supabase Project

1. Go to [https://supabase.com](https://supabase.com) and click **Start your project** (Sign in with GitHub — **no credit card required**).
2. Click **New Project** and select your organization name.
3. Enter a project name (e.g. `twitch-game-data-bridge`) and a secure database password.
4. Select your preferred region (e.g. `us-east-1` or closest to your location) and select the **Free Plan**.
5. Click **Create new project** (takes ~1 minute to spin up).

---

## 2. Run the SQL Database Setup Script

1. In your Supabase Dashboard, click **SQL Editor** in the left navigation sidebar.
2. Click **New Query**.
3. Copy the entire contents of [`supabase/schema.sql`](file:///c:/Users/family/.gemini/antigravity-ide/scratch/twitch-game-data/supabase/schema.sql) and paste it into the editor.
4. Click **Run** (bottom right).
5. You will see `Success. No rows returned.` — your `game_data`, `channel_stats`, `api_keys`, `channels`, and `blocked_channels` tables are now created with RLS policies!

---

## 3. Deploy the Supabase Edge Function

1. Install the Supabase CLI (or run via npx):
   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase functions deploy bridge
   ```

2. Alternatively, copy [`supabase/functions/bridge/index.ts`](file:///c:/Users/family/.gemini/antigravity-ide/scratch/twitch-game-data/supabase/functions/bridge/index.ts) into your Supabase Dashboard under **Edge Functions** → **Create Function**.

---

## 4. Activate Supabase in Dashboard & Extension Config

Once deployed, copy your Supabase Edge Function URL (e.g. `https://<ref>.supabase.co/functions/v1/bridge`) and update:

1. **[`dashboard/config.js`](file:///c:/Users/family/.gemini/antigravity-ide/scratch/twitch-game-data/dashboard/config.js)**:
   ```javascript
   backendType: 'supabase',
   supabaseFunctionUrl: 'https://<ref>.supabase.co/functions/v1/bridge',
   ```

2. **[`overlay.js`](file:///c:/Users/family/.gemini/antigravity-ide/scratch/GuildRunDataDisplayTwitchExtension/overlay.js)**:
   ```javascript
   activeBackend: 'supabase',
   supabaseUrl: 'https://<ref>.supabase.co/functions/v1/bridge',
   ```

3. Rebuild `extension.zip` via `node tools/build-zip.js`.
