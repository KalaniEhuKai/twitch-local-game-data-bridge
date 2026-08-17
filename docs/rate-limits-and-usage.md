# System Rate Limits, Quotas & Usage Documentation

This document outlines the system rate limits, payload size constraints, security controls, and Cloudflare quota limits for the **Twitch Local Game Data Bridge** and its associated admin/streamer dashboard.

---

## 1. App-Enforced Safety Caps & Rate Limits

These limits are configured in `worker/wrangler.toml` and enforced in `worker/src/index.js`:

| Control / Metric | Default Limit | Behavior / Error Response |
| :--- | :--- | :--- |
| **Max Payload Size** | **512 KB** (`524,288` bytes) | Returns `HTTP 413 Payload Too Large` if POST upload exceeds 512 KB |
| **Burst Rate Limit** | **10 uploads / sec** | Returns `HTTP 429 Rate Limit Exceeded` (sliding 10-second window, max 100 uploads/10s) |
| **Daily Streamer Cap** | **50,000 uploads / day** per channel | System automatically blocks channel until midnight UTC |
| **Game Data TTL** | **12 hours** (`43,200` seconds) | Abandoned or inactive streamer game data auto-expires from Cloudflare KV |
| **Stats Retention TTL** | **14 days** (`1,209,600` seconds) | Per-channel and global daily metrics auto-cleanup |
| **Dashboard Auto-Refresh** | **10 seconds** | Admin dashboard polls `/admin/stats` and `/admin/streamers` |

---

## 1.1 Empirical Telemetry Baseline (GuildRun)

- **Actual Streamer Benchmark**: A streamer playing **GuildRun** generates **~450 state-change uploads in 2.25 hours** (~200 uploads / hour, or ~1 upload every 18 seconds).
- **Capacity Calculations for 450 Uploads**:
  - **At 3 KV Writes per upload**: 450 uploads = **1,350 KV Writes** per 2.25h stream (exceeds Cloudflare Free Tier 1,000 write limit for a single stream).
  - **At 1 KV Write per upload**: 450 uploads = **450 KV Writes** per 2.25h stream (supports 2 full streams/day on Free Tier).
  - **On Cloudflare Workers Paid ($5/mo)**: 1,000,000 KV Writes/day supports **~2,222 full 2.25-hour stream sessions per day**.

---

## 2. Cloudflare Quotas & Capacity Planning

### Free Tier Limits (Default)

| Cloudflare Resource | Free Tier Quota | Notes |
| :--- | :--- | :--- |
| **Worker Requests** | **100,000 requests / day** | Combined GETs (viewers), POSTs (streamers), and Dashboard requests |
| **KV Read Operations** | **100,000 reads / day** | Twitch overlay viewer data fetches (`GET /data/...`) |
| **KV Write Operations** | **1,000 writes / day** | Streamer data uploads (`POST /upload`) |

---

### Paid Tier Limits (Cloudflare Workers Paid — $5/month)

If total streamer upload frequency exceeds 1,000 writes/day across active channels, upgrading to Cloudflare Workers Paid increases limits to:

- **KV Writes**: **1,000,000 writes / day**
- **KV Reads**: **10,000,000 reads / day**
- **Worker Requests**: **10,000,000 requests / month**

---

## 3. Configuration & Overrides

To tune application limits without modifying source code, edit the `[vars]` block in `worker/wrangler.toml`:

```toml
[vars]
MAX_UPLOADS_PER_SEC = "10"
MAX_UPLOADS_PER_DAY = "50000"
MAX_PAYLOAD_BYTES   = "524288"   # 512 KB
```

After modifying `wrangler.toml`, deploy the updated environment variables via:

```bash
npx wrangler deploy
```
