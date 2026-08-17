/**
 * =============================================================================
 * Twitch Local Game Data Bridge — Cloudflare Worker
 * =============================================================================
 *
 * Endpoints:
 *   POST /auth/callback          Exchange Twitch OAuth code for an API key
 *   GET  /auth/me                Verify the current API key & return channel info
 *   POST /auth/revoke            Revoke the caller's API key (disconnect)
 *   POST /upload                 Streamer dashboard pushes game file data
 *   GET  /data/:cid/:gid/:fkey   Twitch extension fetches the latest game data
 *   GET  /admin/stats            View usage statistics (admin-only)
 *   GET  /admin/streamers        List all registered channels (admin-only)
 *   POST /admin/block            Block a channel (admin-only)
 *   POST /admin/unblock          Unblock a channel (admin-only)
 *   POST /admin/revoke           Revoke a channel's API key (admin-only)
 *
 * KV Key Schema:
 *   key:{uuid}                          → { channelId, twitchUserId, twitchLogin, createdAt }
 *   channel:{channelId}                 → { keyId, twitchLogin, twitchUserId, registeredAt }
 *   data:{channelId}:{gameId}:{fileKey} → string (raw or pre-parsed content)
 *   blocked:{channelId}                 → { reason, blockedAt, blockedUntil?, blockedBy }
 *   rl:sec:{channelId}                  → count string  (TTL: 2 seconds)
 *   rl:day:{channelId}:{YYYY-MM-DD}     → count string  (TTL: ~25 hours)
 *   stats:ch:{channelId}:{YYYY-MM-DD}   → { uploads, bytesIn, lastSeen, games:{} }
 *   stats:global:{YYYY-MM-DD}           → { uploads, bytesIn, streamers:[] }
 *
 * Required Secrets (set via `wrangler secret put NAME`):
 *   TWITCH_CLIENT_ID       — Twitch Developer Application Client ID
 *   TWITCH_CLIENT_SECRET   — Twitch Developer Application Client Secret
 *   ADMIN_SECRET           — Bearer token that grants access to /admin/* routes
 *
 * Optional Env Vars (configure in wrangler.toml [vars]):
 *   MAX_UPLOADS_PER_SEC    (default: 5)
 *   MAX_UPLOADS_PER_DAY    (default: 50000)
 *   MAX_PAYLOAD_BYTES      (default: 524288 = 512 KB)
 * =============================================================================
 */

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  MAX_UPLOADS_PER_SEC: 5,
  MAX_UPLOADS_PER_DAY: 50_000,
  MAX_PAYLOAD_BYTES: 512 * 1024, // 512 KB — stays well under KV's 25 MB per-value limit
};

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function withCors(response) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
  return response;
}

function json(data, status = 200) {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

// ─── Main Router ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Handle CORS pre-flight for all routes
    if (request.method === 'OPTIONS') {
      const reqHeaders = request.headers.get('Access-Control-Request-Headers') || '*';
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': reqHeaders + ', Authorization, Content-Type, X-Game-Id, X-File-Key',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ── Auth ──────────────────────────────────────────────────────────────
      if (path === '/auth/callback' && method === 'POST') return handleAuthCallback(request, env);
      if (path === '/auth/me'       && method === 'GET')  return handleAuthMe(request, env);
      if (path === '/auth/revoke'   && method === 'POST') return handleAuthRevoke(request, env);

      // ── Upload (streamer → worker) ─────────────────────────────────────────
      if (path === '/upload' && method === 'POST') return handleUpload(request, env, ctx, url);

      // ── Data (Twitch extension → worker) ──────────────────────────────────
      if (path.startsWith('/data')) {
        if (method === 'GET')    return handleData(request, env, url, ctx);
        if (method === 'DELETE') return handleDataDelete(request, env, url);
      }

      // ── Admin ─────────────────────────────────────────────────────────────
      if (path.startsWith('/admin/')) return handleAdmin(request, env, path, url, method);

      // ── Health check ──────────────────────────────────────────────────────
      if (path === '/health') return json({ status: 'ok' });

      // ── Static Dashboard Assets ───────────────────────────────────────────
      if (env.ASSETS && (method === 'GET' || method === 'HEAD')) {
        const assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status !== 404) return assetRes;
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Unhandled worker error:', err);
      return json({ error: `Internal server error: ${err.message}` }, 500);
    }
  },
};

// ─── Auth: Twitch OAuth callback → issue API key ──────────────────────────────

async function handleAuthCallback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON' }, 400);
  }

  const { code, redirect_uri } = body;
  if (!code) return json({ error: 'Missing "code" field' }, 400);

  // Step 1: Exchange authorization code for access token
  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirect_uri || env.TWITCH_REDIRECT_URI || '',
    }),
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    console.error('Twitch token exchange failed:', errorText);
    let detailedMsg = errorText;
    try {
      const errObj = JSON.parse(errorText);
      detailedMsg = errObj.message || errObj.error_description || errObj.error || errorText;
    } catch {}
    return json({ error: `Twitch authentication failed: ${detailedMsg}` }, 401);
  }

  const { access_token } = await tokenRes.json();

  // Step 2: Fetch the authenticated user's info
  const userRes = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Client-Id': env.TWITCH_CLIENT_ID,
    },
  });

  if (!userRes.ok) return json({ error: 'Failed to fetch Twitch user info' }, 401);

  const {
    data: [user],
  } = await userRes.json();

  const channelId = user.id;
  const twitchLogin = user.login;

  // Step 3: Return existing key if the streamer has already registered
  const existingChannel = await env.KV.get(`channel:${channelId}`, 'json');
  if (existingChannel?.keyId) {
    const existingKey = await env.KV.get(`key:${existingChannel.keyId}`, 'json');
    if (existingKey) {
      return json({ apiKey: existingChannel.keyId, channelId, twitchLogin, existing: true });
    }
  }

  // Step 4: Issue a new UUID-based API key
  const apiKey = crypto.randomUUID();

  await env.KV.put(
    `key:${apiKey}`,
    JSON.stringify({ channelId, twitchUserId: user.id, twitchLogin, createdAt: new Date().toISOString() })
  );

  await env.KV.put(
    `channel:${channelId}`,
    JSON.stringify({ keyId: apiKey, twitchLogin, twitchUserId: user.id, registeredAt: new Date().toISOString() })
  );

  return json({ apiKey, channelId, twitchLogin, existing: false });
}

async function handleAuthMe(request, env) {
  const { channelId, error } = await validateApiKey(request, env);
  if (error) return json({ error }, 401);
  const channel = await env.KV.get(`channel:${channelId}`, 'json');
  return json({ channelId, ...channel });
}

async function handleAuthRevoke(request, env) {
  const { channelId, keyId, error } = await validateApiKey(request, env);
  if (error) return json({ error }, 401);
  await env.KV.delete(`key:${keyId}`);
  await env.KV.delete(`channel:${channelId}`);
  return json({ success: true });
}

// ─── Upload: receive game data from the streamer dashboard ────────────────────

async function handleUpload(request, env, ctx, url) {
  // 1. Validate API key — must be pre-registered via /auth/callback
  const { channelId, error: authError } = await validateApiKey(request, env);
  if (authError) return json({ error: authError }, 401);

  // 2. Check if the channel is blocked
  const block = await env.KV.get(`blocked:${channelId}`, 'json');
  if (block) {
    const expired = block.blockedUntil && new Date(block.blockedUntil) <= new Date();
    if (expired) {
      // Auto-expire time-based blocks so streamers don't need to contact admins
      await env.KV.delete(`blocked:${channelId}`);
    } else {
      return json({ error: 'Channel is blocked', reason: block.reason }, 403);
    }
  }

  // 3. Rate limiting (per-second and per-day)
  const rateLimit = await checkRateLimit(env, channelId);
  if (!rateLimit.ok) {
    return json({ error: rateLimit.error, retryAfter: rateLimit.retryAfter }, 429);
  }

  // 4. Enforce payload size cap
  const maxBytes = parseInt(env.MAX_PAYLOAD_BYTES || DEFAULTS.MAX_PAYLOAD_BYTES);
  const contentLength = parseInt(request.headers.get('Content-Length') || '0');
  if (contentLength > maxBytes) {
    return json({ error: `Payload too large. Maximum is ${maxBytes} bytes.` }, 413);
  }

  const gameId  = url?.searchParams.get('gameId')  || request.headers.get('X-Game-Id')  || 'unknown';
  const fileKey = url?.searchParams.get('fileKey') || request.headers.get('X-File-Key') || 'default';

  let content;
  try {
    content = await request.text();
  } catch {
    return json({ error: 'Failed to read request body' }, 400);
  }

  if (content.length > maxBytes) {
    return json({ error: `Payload too large. Maximum is ${maxBytes} bytes.` }, 413);
  }

  // 5. Store data in KV with 12-hour (43,200s) TTL safety net so abandoned data auto-expires
  const dataKey = `data:${channelId}:${gameId}:${fileKey}`;
  await env.KV.put(dataKey, content, {
    expirationTtl: 43_200, // 12 hours
    metadata: {
      updatedAt: new Date().toISOString(),
      contentType: request.headers.get('Content-Type') || 'text/plain',
      size: content.length,
    },
  });

  // 6. Update usage stats asynchronously — don't block the response on this
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      updateStats(env, channelId, gameId, content.length).catch(console.error)
    );
  } else {
    updateStats(env, channelId, gameId, content.length).catch(console.error);
  }

  return json({ success: true, key: dataKey, size: content.length });
}

// ─── Data: serve & delete stored game data ────────────────────────────────────

async function handleData(request, env, url) {
  // Path format: /data/:channelId/:gameId/:fileKey
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4) {
    return json({ error: 'Invalid path. Expected /data/:channelId/:gameId/:fileKey' }, 400);
  }

  const [, channelId, gameId, fileKey] = parts;

  // Track GET request immediately for channelId
  await updateGetStats(env, channelId, gameId, 0).catch(console.error);

  const dataKey = `data:${channelId}:${gameId}:${fileKey}`;
  const { value, metadata } = await env.KV.getWithMetadata(dataKey);
  if (value === null) {
    return json({ error: 'No data found for this channel / game / file combination' }, 404);
  }

  // Detect JSON vs plain text so the extension can parse it directly
  const isJson = value.trimStart().startsWith('{') || value.trimStart().startsWith('[');

  return withCors(
    new Response(value, {
      headers: {
        'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
        'X-Updated-At': metadata?.updatedAt || '',
        'X-Data-Size': String(metadata?.size ?? value.length),
        'Cache-Control': 'no-cache, no-store',
      },
    })
  );
}

async function handleDataDelete(request, env, url) {
  const { channelId, error: authError } = await validateApiKey(request, env);
  if (authError) return json({ error: authError }, 401);

  const parts = url.pathname.split('/').filter(Boolean);
  // If specific path: DELETE /data/:gameId/:fileKey
  if (parts.length >= 3) {
    const [, gameId, fileKey] = parts;
    const dataKey = `data:${channelId}:${gameId}:${fileKey}`;
    await env.KV.delete(dataKey);
    return json({ success: true, deletedCount: 1, keys: [dataKey] });
  }

  // Otherwise: DELETE /data -> delete all data keys for this streamer channel
  const list = await env.KV.list({ prefix: `data:${channelId}:` });
  const deleted = [];
  for (const key of list.keys) {
    await env.KV.delete(key.name);
    deleted.push(key.name);
  }

  return json({ success: true, deletedCount: deleted.length, keys: deleted });
}

// ─── Admin endpoints ──────────────────────────────────────────────────────────

async function handleAdmin(request, env, path, url, method) {
  // All admin routes require the ADMIN_SECRET bearer token
  const bearer = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_SECRET || bearer !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // GET /admin/stats?date=YYYY-MM-DD&channelId=optional
  if (path === '/admin/stats' && method === 'GET') {
    const date = url.searchParams.get('date') || today();
    const channelId = url.searchParams.get('channelId');

    if (channelId) {
      const chStats = (await env.KV.get(`stats:ch:${channelId}:${date}`, 'json')) || {};
      const getStats = (await env.KV.get(`stats:gets:${channelId}:${date}`, 'json')) || {};
      const gets = Math.max(chStats.gets || 0, getStats.gets || 0);
      const bytesOut = Math.max(chStats.bytesOut || 0, getStats.bytesOut || 0);
      return json({ uploads: 0, bytesIn: 0, games: {}, ...chStats, gets, bytesOut });
    }

    // Dynamic in-memory aggregation of global stats across all channels
    const list = await env.KV.list({ prefix: 'channel:' });
    let totalUploads = 0;
    let totalBytesIn = 0;
    let totalGets = 0;
    let totalBytesOut = 0;
    const activeStreamers = [];

    await Promise.all(
      list.keys.map(async ({ name }) => {
        const cId = name.replace('channel:', '');
        const chStats = (await env.KV.get(`stats:ch:${cId}:${date}`, 'json')) || {};
        const getStats = (await env.KV.get(`stats:gets:${cId}:${date}`, 'json')) || {};

        const cUploads = chStats.uploads || 0;
        const cBytesIn = chStats.bytesIn || 0;
        const cGets = Math.max(chStats.gets || 0, getStats.gets || 0);
        const cBytesOut = Math.max(chStats.bytesOut || 0, getStats.bytesOut || 0);

        totalUploads += cUploads;
        totalBytesIn += cBytesIn;
        totalGets += cGets;
        totalBytesOut += cBytesOut;

        if (cUploads > 0 || cGets > 0) {
          activeStreamers.push(cId);
        }
      })
    );

    // Merge legacy stats:global if present for backwards compatibility
    const legacyGlobal = (await env.KV.get(`stats:global:${date}`, 'json')) || {};
    const legacyGlobalGets = (await env.KV.get(`stats:global_gets:${date}`, 'json')) || {};
    totalUploads = Math.max(totalUploads, legacyGlobal.uploads || 0);
    totalBytesIn = Math.max(totalBytesIn, legacyGlobal.bytesIn || 0);
    totalGets = Math.max(totalGets, legacyGlobal.gets || 0, legacyGlobalGets.gets || 0);
    totalBytesOut = Math.max(totalBytesOut, legacyGlobal.bytesOut || 0, legacyGlobalGets.bytesOut || 0);

    return json({
      uploads: totalUploads,
      bytesIn: totalBytesIn,
      gets: totalGets,
      bytesOut: totalBytesOut,
      streamers: activeStreamers,
    });
  }

  // GET /admin/streamers — list all registered channels with stats for selected date
  if (path === '/admin/streamers' && method === 'GET') {
    const date = url.searchParams.get('date') || today();
    const list = await env.KV.list({ prefix: 'channel:' });
    const streamers = await Promise.all(
      list.keys.map(async ({ name }) => {
        const data = await env.KV.get(name, 'json');
        const channelId = name.replace('channel:', '');
        const blocked = await env.KV.get(`blocked:${channelId}`, 'json');
        const chStats = (await env.KV.get(`stats:ch:${channelId}:${date}`, 'json')) || {};
        const getStats = (await env.KV.get(`stats:gets:${channelId}:${date}`, 'json')) || {};
        const gets = Math.max(chStats.gets || 0, getStats.gets || 0);
        const bytesOut = Math.max(chStats.bytesOut || 0, getStats.bytesOut || 0);
        const todayStats = { ...chStats, gets, bytesOut };
        return { channelId, ...data, blocked: !!blocked, blockInfo: blocked || null, todayStats };
      })
    );
    return json(streamers);
  }

  // All remaining admin routes are POST
  if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body = {};
  try { body = await request.json(); } catch { /* body is optional for some routes */ }

  // POST /admin/block  { channelId, reason?, blockedUntil? }
  if (path === '/admin/block') {
    const { channelId, reason, blockedUntil } = body;
    if (!channelId) return json({ error: '"channelId" is required' }, 400);
    await env.KV.put(
      `blocked:${channelId}`,
      JSON.stringify({
        reason: reason || 'Manual admin block',
        blockedAt: new Date().toISOString(),
        blockedUntil: blockedUntil || null, // null = indefinite
        blockedBy: 'admin',
      })
    );
    return json({ success: true, channelId, blocked: true });
  }

  // POST /admin/unblock  { channelId }
  if (path === '/admin/unblock') {
    const { channelId } = body;
    if (!channelId) return json({ error: '"channelId" is required' }, 400);
    await env.KV.delete(`blocked:${channelId}`);
    return json({ success: true, channelId, blocked: false });
  }

  // POST /admin/revoke  { channelId }
  if (path === '/admin/revoke') {
    const { channelId } = body;
    if (!channelId) return json({ error: '"channelId" is required' }, 400);
    const channel = await env.KV.get(`channel:${channelId}`, 'json');
    if (channel?.keyId) await env.KV.delete(`key:${channel.keyId}`);
    await env.KV.delete(`channel:${channelId}`);
    return json({ success: true, channelId, revoked: true });
  }

  return json({ error: 'Unknown admin action' }, 404);
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
/**
 * =============================================================================
 * RATE LIMITING (DISABLED BY DEFAULT TO CONSERVE KV READS & WRITES)
 * =============================================================================
 * 
 * To maximize Cloudflare KV quota efficiency and minimize latency, active KV
 * rate limiting is currently bypassed. Performing KV reads and writes on every
 * upload for rate limiting adds 2 KV reads and 2 KV writes per payload.
 * 
 * HOW TO RE-ENABLE RATE LIMITING IN THE FUTURE:
 * -----------------------------------------------------------------------------
 * Option 1: Re-enable KV Rate Limiting
 * Uncomment the KV check block inside checkRateLimit() below. It maintains:
 *   - A 10-second sliding window counter (`rl:win:${channelId}:${windowId}`)
 *   - A per-day counter (`rl:day:${channelId}:${date}`)
 * 
 * Option 2: Cloudflare Native Rate Limiting Rules (Recommended for Production)
 * Configure Rate Limiting Rules directly in the Cloudflare Dashboard under:
 *   Security → WAF → Rate Limiting Rules
 * Match URI path `/upload` with a limit (e.g. 10 requests / 10 seconds per IP/Key).
 * This enforces rate limits at Cloudflare's edge before Worker execution,
 * with ZERO KV reads or writes.
 * 
 * Option 3: Durable Objects (Strict Atomic Concurrency)
 * Migrate counters to a Cloudflare Durable Object per channelId for in-memory,
 * atomic rate limiting with serialized reads and writes.
 * =============================================================================
 */

async function checkRateLimit(env, channelId) {
  // KV Rate Limiting is currently bypassed to optimize KV write quotas.
  // Always returns { ok: true } without performing any KV reads or writes.
  return { ok: true };

  /*
  // --- UNCOMMENT BELOW TO RE-ENABLE KV RATE LIMITING ---
  const maxPerSec = parseInt(env.MAX_UPLOADS_PER_SEC || DEFAULTS.MAX_UPLOADS_PER_SEC);
  const maxPerDay = parseInt(env.MAX_UPLOADS_PER_DAY || DEFAULTS.MAX_UPLOADS_PER_DAY);
  const date = today();

  // 10-second window timestamp to work within Cloudflare KV's 60-second minimum TTL
  const windowId = Math.floor(Date.now() / 10000);
  const maxPerWindow = maxPerSec * 10;

  const secKey = `rl:win:${channelId}:${windowId}`;
  const dayKey = `rl:day:${channelId}:${date}`;

  // ── 10-second Window check ────────────────────────────────────────────────
  const secCount = parseInt((await env.KV.get(secKey)) || '0');
  if (secCount >= maxPerWindow) {
    return { ok: false, error: 'Rate limit exceeded: too many uploads per second', retryAfter: 1 };
  }

  // ── Per-day check ─────────────────────────────────────────────────────────
  const dayCount = parseInt((await env.KV.get(dayKey)) || '0');
  if (dayCount >= maxPerDay) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    await env.KV.put(
      `blocked:${channelId}`,
      JSON.stringify({
        reason: `Daily upload limit of ${maxPerDay} exceeded. Resets at midnight UTC.`,
        blockedAt: new Date().toISOString(),
        blockedUntil: midnight.toISOString(),
        blockedBy: 'system:rate-limit',
      })
    );
    return {
      ok: false,
      error: 'Daily upload limit reached. Service will resume at midnight UTC.',
      retryAfter: Math.floor((midnight - Date.now()) / 1000),
    };
  }

  // ── Increment both counters ────────────────────────────────────────────────
  await env.KV.put(secKey, String(secCount + 1), { expirationTtl: 120 });       // expires in 2m
  await env.KV.put(dayKey, String(dayCount + 1), { expirationTtl: 90_000 });   // expires in ~25h

  return { ok: true };
  */
}

// ─── Stats Tracking ───────────────────────────────────────────────────────────

const STATS_RETENTION_TTL = 14 * 86400; // 14 days (1,209,600 seconds)

async function updateStats(env, channelId, gameId, byteCount) {
  const date = today();

  // Per-channel daily upload stats (retained for 14 days)
  const chKey = `stats:ch:${channelId}:${date}`;
  const rawCh = await env.KV.get(chKey, 'json');
  const chStats = rawCh || {
    uploads: 0, bytesIn: 0, lastSeen: null, games: {},
  };
  chStats.uploads = (chStats.uploads || 0) + 1;
  chStats.bytesIn = (chStats.bytesIn || 0) + byteCount;
  chStats.lastSeen = new Date().toISOString();
  chStats.games = chStats.games || {};
  chStats.games[gameId] = (chStats.games[gameId] || 0) + 1;
  await env.KV.put(chKey, JSON.stringify(chStats), { expirationTtl: STATS_RETENTION_TTL });
}

async function updateGetStats(env, channelId, gameId, byteCount) {
  const date = today();

  // Per-channel daily GET stats (dedicated key to prevent upload race conditions)
  const getKey = `stats:gets:${channelId}:${date}`;
  const rawGets = await env.KV.get(getKey, 'json');
  const getStats = rawGets || { gets: 0, bytesOut: 0 };

  // Also read legacy chStats in case gets were previously stored there
  const legacyCh = (await env.KV.get(`stats:ch:${channelId}:${date}`, 'json')) || {};
  const currentGets = Math.max(legacyCh.gets || 0, getStats.gets || 0);
  const currentBytesOut = Math.max(legacyCh.bytesOut || 0, getStats.bytesOut || 0);

  getStats.gets = currentGets + 1;
  getStats.bytesOut = currentBytesOut + (byteCount || 0);
  await env.KV.put(getKey, JSON.stringify(getStats), { expirationTtl: STATS_RETENTION_TTL });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function validateApiKey(request, env) {
  const header = request.headers.get('Authorization') || '';
  const apiKey = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!apiKey) return { error: 'Missing Authorization: Bearer <key> header' };

  const keyData = await env.KV.get(`key:${apiKey}`, 'json');
  if (!keyData) return { error: 'Unrecognized API key. Please authenticate via the dashboard.' };

  return { channelId: keyData.channelId, keyId: apiKey, keyData };
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}
