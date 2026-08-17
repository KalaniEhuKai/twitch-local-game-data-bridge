# Empirical Telemetry Fact: GuildRun Streamer Upload Frequency

- **Empirical Baseline**: A streamer actively playing **GuildRun** generates **~450 state-change uploads in 2.25 hours** (~200 uploads / hour, or ~1 upload every 18 seconds).
- **Current KV Write Architecture**: **2 KV Writes per upload** (1 write for payload `data:...`, 1 write for channel upload stats `stats:ch:...`).
- **KV Capacity Impact**:
  - **450 uploads (2.25h stream)** = **900 KV Writes** total (fits 1 full 2.25h stream/day on Cloudflare Free Tier limit of 1,000 writes/day).
  - On **Cloudflare Workers Paid ($5/mo)** with 1,000,000 KV Writes/day, 450 uploads/session supports **~1,111 full stream sessions per day** (~500,000 uploads/day).
