# Telemetry Infrastructure, Supabase & Cloudflare Scaling Capacity Rules

- **Empirical Baseline**: A streamer actively playing **GuildRun** generates **~450 state-change uploads in 2.25 hours** (~200 uploads / hour, or ~1 upload every 18 seconds).
- **Intensive 2s Upload Benchmark**: 1 upload every 2s = 1,800 uploads/hr → 14,400 uploads/8-hr stream → 312,000 uploads/month (40-hr month).
- **1,000-Viewer Stream Extension Benchmark**: 250 active extension viewers (25% adoption) checking once every 5 mins = 120,000 viewer requests/month (40-hr month).

## Active Backend: Supabase (Edge Functions + PostgreSQL JSONB)
- **Spend Cap**: Enabled by default (hard $0 overage guarantee; hard-stops requests at budget if limits reached).
- **Ingress Bandwidth (Uploads)**: **100% Free and Unlimited ($0)**.
- **Egress Bandwidth (Viewer Reads)**: **5 GB / month** (Free) | **250 GB / month** (Pro $25/mo).
- **Edge Function Calls**: **500,000 / month** (Free) | **2,000,000 / month** (Pro $25/mo).
- **Database Storage**: PostgreSQL `UPSERT` (`PRIMARY KEY (channel_id, game_id, file_key)`) keeps total database size **< 5 MB forever**.
- **Data Retention**: **60 Days (2 Months)** automated metrics retention.

## Fallback Backend: Cloudflare Workers & KV
Official Reference: https://developers.cloudflare.com/kv/platform/pricing/
- **Free Plan**: 1,000 KV Writes / day, 100,000 KV Reads / day.
- **Workers Paid Plan ($5/mo Base)**: 1M KV Writes / mo, 10M KV Reads / mo.
- **Static Dashboard Hosting**: 100% Free static asset hosting on Cloudflare Workers Assets.
