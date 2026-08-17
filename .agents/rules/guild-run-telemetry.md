# Empirical Telemetry Fact: GuildRun Streamer Upload Frequency

- **Empirical Baseline**: A streamer actively playing **GuildRun** generates **~450 state-change uploads in 2.25 hours** (~200 uploads / hour, or ~1 upload every 18 seconds).
- **KV Capacity Impact**:
  - At **3 KV Writes per upload**, 450 uploads = **1,350 KV Writes** (exceeds Cloudflare Free Tier limit of 1,000 writes/day for a single 2.25h stream).
  - At **1 KV Write per upload**, 450 uploads = **450 KV Writes** (allows 2 full 2.25h stream sessions per day on Free Tier).
  - On **Cloudflare Workers Paid ($5/mo)** with 1,000,000 KV Writes/day, 450 uploads/session supports **~2,222 full stream sessions per day**.
