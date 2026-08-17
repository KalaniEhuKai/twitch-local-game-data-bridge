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

## 1.1 Capacity Benchmark Scenarios

### Scenario A: Intensive Game Upload Baseline (1 Upload every 2 seconds)
- **Upload Rate**: 1 upload / 2 sec = 1,800 uploads / hr → **14,400 uploads / 8-hr stream session**.
- **Monthly Streamer Load (40 hrs / mo)**: **312,000 uploads / month**.
- **KV Writes (at 2 KV Writes per upload)**: 312,000 × 2 = **624,000 KV Writes / month** (under 1M included monthly writes).

### Scenario B: 1,000-Viewer Stream Extension Usage
- **Active Extension Viewers (25% adoption)**: 250 active extension viewers.
- **Interaction Rate**: 1 hover / 5 min = 12 checks / viewer / hr → **3,000 viewer requests / hr**.
- **Monthly Viewer Load (40 hrs / mo)**: **120,000 viewer requests / month**.
- **KV Operations per Viewer Request**: 2 KV Reads + 1 KV Write (updates GET counter).
- **Monthly Viewer Usage**: **240,000 KV Reads / month** + **120,000 KV Writes / month**.

### Scenario C: Combined Monthly Heavy Streamer + 1,000 Viewers
- **Total KV Writes**: 624,000 (uploads) + 120,000 (viewer stats) = **744,000 KV Writes / month** (74.4% of 1M included).
- **Total KV Reads**: **240,000 KV Reads / month** (2.4% of 10M included).
- **Total HTTP Requests**: **432,000 requests / month** (4.3% of 10M included).
- **Total Monthly Cost**: **$5.00 / month flat** ($0 in overage fees).

---

## 2. Cloudflare Quotas & Official Pricing

Official Reference: [Cloudflare Workers KV Pricing Docs](https://developers.cloudflare.com/kv/platform/pricing/)

### Free Plan vs Paid Plan ($5/month Base)

| Cloudflare Resource | Free Plan (Daily Limits) | Paid Plan ($5/mo Base) | Overage Rate (After Base Included) |
| :--- | :--- | :--- | :--- |
| **KV Writes** | **1,000 / day** | **1,000,000 / month included** | **$5.00 per 1 million writes** |
| **KV Reads** | **100,000 / day** | **10,000,000 / month included** | **$0.50 per 1 million reads** |
| **KV Deletes** | **1,000 / day** | **1,000,000 / month included** | **$5.00 per 1 million deletes** |
| **List Requests** | **1,000 / day** | **1,000,000 / month included** | **$5.00 per 1 million lists** |
| **Worker Requests** | **100,000 / day** | **10,000,000 / month included** | **$0.30 per 1 million requests** |
| **Stored Data** | **1 GB total** | **1 GB included** | **$0.50 / GB-month** |

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
