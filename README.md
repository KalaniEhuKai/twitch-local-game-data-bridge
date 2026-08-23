# Twitch Local Game Data Bridge

A zero-cost to streamer pipeline that reads local game files from a streamer's PC
and makes the data available at a stable URL so Twitch extensions can access it.

> [!NOTE]
> **Third-Party & Unofficial Project Disclaimer**:
> This software is an independent, third-party open-source utility developed by community members. It is **not** affiliated with, endorsed by, sponsored by, or officially associated with Guild Run, Twitch Interactive, Cloudflare, Supabase, or any game developers or publishers. All trademarks, game titles, and logos belong to their respective owners.

---

## How it Works

```
Streamer's browser tab          Cloudflare Worker          Twitch Extension
(dashboard/index.html)          (worker/src/index.js)      (your code)

File System Access API
  → reads game file(s)
  → runs parser
  → POST /upload          ──►  stores in KV
                                                  GET /data/:cid/:gid/:fkey  ──►
                                                  ◄── latest game data JSON
```

- The **streamer** opens the dashboard in Chrome or Edge — no software install (https://tlgdb-dashboard.kalani-ehu-kai.workers.dev/).
- The **Worker** stores the latest data per channel/game/file in Cloudflare KV.
- The **Twitch extension** (which you write separately) fetches data from the
  Worker's `GET /data/…` endpoint whenever a viewer interacts with it.

---

# Development Info

## Prerequisites

| What | Where |
|---|---|
| Cloudflare account (free) | https://dash.cloudflare.com/sign-up |
| Node.js (for Wrangler CLI) | https://nodejs.org |
| Twitch Developer Application | https://dev.twitch.tv/console/apps |

---

## Setup — Step by Step

### 1. Create a Twitch Application

1. Go to https://dev.twitch.tv/console/apps → **Register Your Application**
2. Set **OAuth Redirect URL** to your dashboard URL (you can update this later)
3. Choose **Category: Website Integration**
4. Note down your **Client ID** — you'll need it in Step 4

### 2. Deploy the Cloudflare Worker

```powershell
cd worker
npm install

# Create the KV namespace and copy the IDs it prints
npm run kv:create

# Edit wrangler.toml — paste the KV namespace IDs where indicated
notepad wrangler.toml

# Set secrets (you'll be prompted to type/paste each value)
npx wrangler secret put TWITCH_CLIENT_ID
npx wrangler secret put TWITCH_CLIENT_SECRET
npx wrangler secret put ADMIN_SECRET        # any long random string

# Deploy
npm run deploy
```

After deploying, Wrangler will print your Worker URL, e.g.:
`https://twitch-local-game-data-bridge.kalani-ehu-kai.workers.dev`

### 3. Update the Twitch OAuth Redirect URL

Back in the Twitch Dev Console, add your **dashboard URL** as an OAuth Redirect URL.
The dashboard URL will be wherever you host the `dashboard/` folder (see Step 4).

### 4. Configure the Dashboard

Edit `dashboard/config.js`:

```js
window.TLGDB_CONFIG = {
  workerUrl:     'https://twitch-local-game-data-bridge.kalani-ehu-kai.workers.dev',
  twitchClientId: 'abc123yourClientId',
};
```

### 5. Deploy the Dashboard

The dashboard is a plain static site — no build step needed.

**Option A — Cloudflare Pages (recommended, free)**
```powershell
# From the repo root:
npx wrangler pages deploy dashboard --project-name=tlgdb-dashboard
```

**Option B — GitHub Pages**
Push the `dashboard/` folder contents to a `gh-pages` branch and enable
GitHub Pages in your repo settings.

**Option C — Local test**
```powershell
# Any static file server works; e.g.:
npx serve dashboard
```
> Note: The File System Access API requires HTTPS or `localhost`. Opening
> `index.html` directly as `file://` will not work.

---

## Adding a New Game Profile

1. Create `dashboard/games/your-game.js` — use `generic.js` as a template.
2. Export a default object with `id`, `name`, `files[]`, and optionally `parse()`.
3. In `dashboard/games/registry.js`, import your file and add it to `GAMES`.

```js
// dashboard/games/registry.js
import myGame from './my-game.js';
export const GAMES = [ generic, pathOfExile, myGame ];
```

The dashboard dropdown updates automatically — no other changes needed.

**When to add a `parse()` function:**
Add a parser when the raw game file is large (hundreds of KB+). The parser runs
in the streamer's browser and only the compact result is uploaded, keeping
payload sizes and Cloudflare KV write costs low.

---

## Extension Integration

Your Twitch extension fetches data from:
```
GET https://<your-worker-url>/data/:channelId/:gameId/:fileKey
```

| Parameter | Description |
|---|---|
| `channelId` | Twitch numeric channel ID of the streamer |
| `gameId` | The `id` from the game profile (e.g. `path-of-exile`) |
| `fileKey` | The `key` from the file definition (e.g. `client_log`) |

The response is plain text or JSON (auto-detected), with headers:
- `X-Updated-At` — ISO timestamp of the last upload
- `X-Data-Size` — payload size in bytes

Example (in your extension JS):
```js
const res  = await fetch(`https://yourworker.workers.dev/data/${channelId}/path-of-exile/client_log`);
const data = await res.json();
console.log(data.currentZone);
```

---

## Admin API

All admin endpoints require `Authorization: Bearer <ADMIN_SECRET>`.

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/admin/stats` | — | Global or per-channel stats (`?date=YYYY-MM-DD&channelId=optional`) |
| `GET` | `/admin/streamers` | — | List all registered channels with today's stats |
| `POST` | `/admin/block` | `{ channelId, reason?, blockedUntil? }` | Block a channel |
| `POST` | `/admin/unblock` | `{ channelId }` | Unblock a channel |
| `POST` | `/admin/revoke` | `{ channelId }` | Revoke a channel's API key |

Example using curl:
```powershell
curl -X POST https://yourworker.workers.dev/admin/block `
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" `
  -H "Content-Type: application/json" `
  -d '{"channelId":"12345678","reason":"Excessive upload rate"}'
```

---

## Cost Reference

| Component | Provider | Free Tier | Paid |
|---|---|---|---|
| Worker (upload + serve) | Cloudflare Workers | 100k req/day | $5/mo → 10M req |
| State storage | Cloudflare KV | 1k writes/day, 100k reads/day | ~$1–2/mo overage |
| Dashboard hosting | Cloudflare Pages | Unlimited | Free |
| Viewer data delivery | Cloudflare KV reads | 100k/day | $0.50/million |

At realistic "upload only on change" rates, a handful of streamers fit within
the free tier. The paid Worker plan at $5/month comfortably handles ~100
simultaneous streamers.

---

## Project Structure

```
twitch-local-game-data/
├── worker/
│   ├── src/index.js          Cloudflare Worker — all backend logic
│   ├── wrangler.toml         Cloudflare deployment config
│   └── package.json
└── dashboard/
    ├── index.html            Streamer dashboard UI
    ├── style.css             Dark UI styles
    ├── app.js                Dashboard logic (ES module)
    ├── config.js             ← Edit this before deploying
    └── games/
        ├── registry.js       Game profile registry — add new games here
        ├── generic.js        Built-in: raw file upload, no parsing
        └── path-of-exile.js  Example: parses PoE client log
```
