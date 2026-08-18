# System Infrastructure, Quotas & Usage Documentation

This document outlines the architecture, rate limits, data quotas, zero-overage protections, and capacity math for the **Twitch Local Game Data Bridge** across both **Supabase** (primary database & edge functions) and **Cloudflare Workers** (static frontend hosting & fallback worker).

---

## 1. Dual-Backend Architecture Overview

The system supports a dual-backend toggle configured in [`dashboard/config.js`](file:///c:/Users/family/.gemini/antigravity-ide/scratch/twitch-game-data/dashboard/config.js) and [`overlay.js`](file:///c:/Users/family/.gemini/antigravity-ide/scratch/GuildRunDataDisplayTwitchExtension/overlay.js):

| Provider | Components Used | Purpose / Benefits |
| :--- | :--- | :--- |
| **Supabase** *(Active Backend)* | Edge Functions + PostgreSQL (`UPSERT` JSONB) | **$0 / Zero Credit Card Required**, Native **Spend Cap** (hard $0 overage guarantee), zero DB bloat via PostgreSQL `UPSERT`, 5 GB free egress. |
| **Cloudflare** *(Static & Fallback)* | Cloudflare Workers Assets + KV Namespace | **100% Free** static website hosting for Streamer Dashboard (`tlgdb-dashboard`), auth fallback, and optional backup Worker. |

---

## 2. Infrastructure Quotas & Cost Guarantee

### 2.1 Supabase Tier Limits & Spend Cap

Supabase provides **100% hard limit protection** (Spend Cap enabled by default on Pro, $0 credit card required on Free Tier):

| Supabase Resource | Free Tier Limit | Pro Plan ($25/mo) | Overage Protection |
| :--- | :--- | :--- | :--- |
| **Data Ingress (Uploads)** | ♾️ **Unlimited ($0)** | ♾️ **Unlimited ($0)** | **$0 / Uncapped** (incoming data transfer is free). |
| **Data Egress (Downloads)** | **5 GB / month** | **250 GB / month** | **Hard-stopped at limit** (HTTP 429) if Spend Cap enabled. Zero unexpected charges. |
| **Edge Function Invocations**| **500,000 / month** | **2,000,000 / month** | Hard limit on Free; $2/1M on Pro (Spend Cap caps at budget). |
| **Postgres Storage** | **500 MB** | **8 GB** | We use `UPSERT`, keeping total DB storage **< 5 MB forever**! |
| **Data Retention** | **60 Days** (2 Months) | **60 Days** (2 Months) | Automated daily metrics pruning in Edge Function and PL/pgSQL function. |

---

### 2.2 Cloudflare KV & Workers Limits (Official Reference)

Official Reference: [Cloudflare Workers KV Pricing Docs](https://developers.cloudflare.com/kv/platform/pricing/)

| Cloudflare Resource | Free Tier Limit | Paid Plan ($5/mo Base) | Behavioral Handling |
| :--- | :--- | :--- | :--- |
| **Static Dashboard Assets**| ♾️ **Unlimited ($0)** | ♾️ **Unlimited ($0)** | Serves static HTML/JS/CSS with **0 KV reads/writes**. |
| **KV Writes** | **1,000 / day** | **1,000,000 / month** | Returns `HTTP 429 KV Daily Limit Reached` on Free Tier when limit is hit. |
| **KV Reads** | **100,000 / day** | **10,000,000 / month** | Returns cached payload metadata. |
| **Worker Requests** | **100,000 / day** | **10,000,000 / month** | $0.30 / million requests after base. |

---

## 3. Capacity Benchmark Scenarios

### Scenario A: Intensive Streamer Upload Baseline (1 Upload every 2 seconds)
- **Upload Frequency**: 1 upload / 2 seconds = 1,800 uploads / hour.
- **Single Stream Session (8 hours)**: 14,400 uploads / session.
- **Monthly Streamer Load (40 hrs / month)**: **312,000 uploads / month**.
- **Supabase Cost**: **$0.00** (Edge function invocations: 312k of 500k free tier limit; ingress bandwidth: 100% free).

### Scenario B: 1,000-Viewer Extension Overlay Usage
- **Active Extension Viewers (25% adoption)**: 250 active extension viewers.
- **Hover Rate**: 1 hover / 5 minutes = 12 reads / viewer / hour.
- **Monthly Viewer Fetches (40 hrs / month stream)**: **120,000 viewer requests / month**.
- **Payload Size**: ~5 KB compressed JSON.
- **Monthly Egress Bandwidth**: 120,000 × 5 KB = **0.6 GB / month** (well under Supabase's 5 GB free egress limit!).

### Scenario C: Combined Heavy Streamer + 1,000 Viewers
- **Total Edge Function Calls**: 312,000 (uploads) + 120,000 (viewer GETs) = **432,000 calls / month** (86.4% of 500k free tier).
- **Total Egress Bandwidth**: **~0.6 GB / month** (12% of 5 GB free tier).
- **Total Ingress Bandwidth**: **~1.5 GB / month** (100% Free).
- **Total Monthly Cost**: **$0.00 / month** (100% covered by free tiers).

---

## 4. App Safety Controls & Data Retention

| Control | Setting | Location |
| :--- | :--- | :--- |
| **Max Payload Size** | **512 KB** (`524,288` bytes) | Enforced in Edge Function and Cloudflare Worker. |
| **Metrics Data Retention**| **60 Days (2 Months)** | Auto-pruned in `channel_stats` table by Edge Function and SQL function `cleanup_old_channel_stats()`. |
| **Payload Storage Strategy**| **Zero-Bloat `UPSERT`** | `PRIMARY KEY (channel_id, game_id, file_key)` overwrites active run payload, keeping database size < 5 MB forever. |
| **Dual-Backend Toggle** | `'supabase'` or `'cloudflare'` | Configurable in `dashboard/config.js` and `overlay.js`. |
