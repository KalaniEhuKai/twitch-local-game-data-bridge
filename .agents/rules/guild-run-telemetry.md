# Telemetry & Cloudflare KV Scaling Capacity Rules

- **Empirical Baseline**: A streamer actively playing **GuildRun** generates **~450 state-change uploads in 2.25 hours** (~200 uploads / hour, or ~1 upload every 18 seconds).
- **Intensive 2s Upload Benchmark**: 1 upload every 2s = 1,800 uploads/hr → 14,400 uploads/8-hr stream → 312,000 uploads/month (40-hr month).
- **1,000-Viewer Stream Extension Benchmark**: 250 active extension viewers (25% adoption) checking once every 5 mins = 120,000 viewer requests/month (40-hr month).

## Official Cloudflare KV Pricing & Limits Reference
Official Reference: https://developers.cloudflare.com/kv/platform/pricing/

- **Free Plan**: 1,000 KV Writes / day, 100,000 KV Reads / day.
- **Workers Paid Plan ($5/mo Base)**:
  - **KV Writes**: 1,000,000 / month included (+ $5.00 per 1M overage writes).
  - **KV Reads**: 10,000,000 / month included (+ $0.50 per 1M overage reads).
  - **Worker Requests**: 10,000,000 / month included (+ $0.30 per 1M overage requests).

## System Architecture KV Operation Counts
- **Streamer Upload (`POST /upload`)**: **2 KV Writes** (1 payload data write + 1 channel stats write).
- **Viewer Overlay Fetch (`GET /data/...`)**: **2 KV Reads + 1 KV Write** (1 payload read + 1 GET stats read + 1 GET stats write).

## Scaling Costs for 1,000-Viewer Heavy Stream (40 hrs/month)
- **Upload KV Writes**: 312,000 uploads × 2 = **624,000 KV Writes / month**.
- **Viewer KV Writes**: 120,000 requests × 1 = **120,000 KV Writes / month**.
- **Viewer KV Reads**: 120,000 requests × 2 = **240,000 KV Reads / month**.
- **Total Monthly Usage**: 744,000 KV Writes (74.4% of 1M), 240,000 KV Reads (2.4% of 10M).
- **Total Monthly Cost**: **$5.00 / month flat** ($0 in overage charges).
