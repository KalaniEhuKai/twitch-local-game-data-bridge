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
