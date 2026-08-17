// =============================================================================
// Supabase Edge Function — Twitch Local Game Data Bridge (bridge/index.ts)
// Deno TypeScript Edge Function with PostgreSQL Telemetry Data Storage
// Complete Feature Parity with Cloudflare Worker Backend
// =============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.8';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const ADMIN_SECRET = Deno.env.get('ADMIN_SECRET') || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function withCors(response: Response, request?: Request): Response {
  const origin = request ? request.headers.get('Origin') : null;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Game-Id, X-File-Key, X-Api-Key, X-Channel-Id, X-Twitch-Login, *');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: any, status = 200, request?: Request): Response {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
    request
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), req);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/bridge/, '');
  const method = req.method;

  try {
    // ── Auth Callback ───────────────────────────────────────────────────────
    if (path === '/auth/callback' && method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const { code, redirect_uri } = body;
      if (!code) return json({ error: 'Missing "code" field' }, 400, req);

      const clientId = Deno.env.get('TWITCH_CLIENT_ID') || 'r4bobxefhulol3yqbqna3dqdfce65i';
      const clientSecret = Deno.env.get('TWITCH_CLIENT_SECRET') || '';

      if (!clientSecret) {
        return json({ error: 'TWITCH_CLIENT_SECRET environment variable not configured on Supabase' }, 500, req);
      }

      const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirect_uri || '',
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        let msg = errText;
        try { msg = JSON.parse(errText).message || errText; } catch {}
        return json({ error: `Twitch authentication failed: ${msg}` }, 401, req);
      }

      const { access_token } = await tokenRes.json();
      const userRes = await fetch('https://api.twitch.tv/helix/users', {
        headers: { Authorization: `Bearer ${access_token}`, 'Client-Id': clientId },
      });

      if (!userRes.ok) return json({ error: 'Failed to fetch Twitch user info' }, 401, req);
      const { data: [user] } = await userRes.json();

      const channelId = user.id;
      const twitchLogin = user.login;

      const { data: existingChannel } = await supabase
        .from('channels')
        .select('key_id')
        .eq('channel_id', channelId)
        .single();

      if (existingChannel?.key_id) {
        return json({ apiKey: existingChannel.key_id, channelId, twitchLogin, existing: true }, 200, req);
      }

      const apiKey = crypto.randomUUID();
      await supabase.from('api_keys').upsert({
        api_key: apiKey,
        channel_id: channelId,
        twitch_user_id: user.id,
        twitch_login: twitchLogin,
      }, { onConflict: 'api_key' });

      await supabase.from('channels').upsert({
        channel_id: channelId,
        key_id: apiKey,
        twitch_login: twitchLogin,
        twitch_user_id: user.id,
      }, { onConflict: 'channel_id' });

      return json({ apiKey, channelId, twitchLogin, existing: false }, 200, req);
    }

    // ── Auth Me ─────────────────────────────────────────────────────────────
    if (path === '/auth/me' && method === 'GET') {
      const authHeader = req.headers.get('Authorization') || '';
      const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      if (!apiKey) return json({ error: 'Missing Authorization header' }, 401, req);

      const { data: keyRecord } = await supabase
        .from('api_keys')
        .select('channel_id, twitch_login, twitch_user_id')
        .eq('api_key', apiKey)
        .single();

      if (!keyRecord) return json({ error: 'Unrecognized API key' }, 401, req);
      return json({ channelId: keyRecord.channel_id, ...keyRecord }, 200, req);
    }

    // ── Auth Revoke ─────────────────────────────────────────────────────────
    if (path === '/auth/revoke' && method === 'POST') {
      const authHeader = req.headers.get('Authorization') || '';
      const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      if (!apiKey) return json({ error: 'Missing Authorization header' }, 401, req);

      const { data: keyRecord } = await supabase
        .from('api_keys')
        .select('channel_id')
        .eq('api_key', apiKey)
        .single();

      if (keyRecord?.channel_id) {
        await supabase.from('channels').delete().eq('channel_id', keyRecord.channel_id);
      }
      await supabase.from('api_keys').delete().eq('api_key', apiKey);
      return json({ success: true }, 200, req);
    }

    // ── Upload ──────────────────────────────────────────────────────────────
    if (path === '/upload' && method === 'POST') {
      const authHeader = req.headers.get('Authorization') || '';
      const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      if (!apiKey) return json({ error: 'Missing Authorization header' }, 401, req);

      const { data: keyRecord } = await supabase
        .from('api_keys')
        .select('channel_id')
        .eq('api_key', apiKey)
        .single();

      const twitchLogin = url.searchParams.get('twitchLogin') || req.headers.get('X-Twitch-Login') || null;
      let channelId = keyRecord?.channel_id;
      if (!channelId) {
        channelId = url.searchParams.get('channelId') || req.headers.get('X-Channel-Id') || null;
        if (channelId) {
          await supabase.from('api_keys').upsert(
            { api_key: apiKey, channel_id: channelId, twitch_login: twitchLogin || undefined },
            { onConflict: 'api_key' }
          );
          await supabase.from('channels').upsert(
            { channel_id: channelId, key_id: apiKey, twitch_user_id: channelId, twitch_login: twitchLogin || `channel_${channelId}` },
            { onConflict: 'channel_id' }
          );
        } else {
          channelId = 'default_channel';
        }
      } else if (twitchLogin) {
        await supabase.from('channels').upsert(
          { channel_id: channelId, key_id: apiKey, twitch_user_id: channelId, twitch_login: twitchLogin },
          { onConflict: 'channel_id' }
        );
      }

      // Check if channel is blocked
      const { data: blockedRecord } = await supabase
        .from('blocked_channels')
        .select('*')
        .eq('channel_id', channelId)
        .single();

      if (blockedRecord) {
        if (!blockedRecord.blocked_until || new Date(blockedRecord.blocked_until) > new Date()) {
          return json({ error: 'Channel is blocked', reason: blockedRecord.reason || 'Blocked by admin' }, 403, req);
        }
      }

      const gameId = url.searchParams.get('gameId') || req.headers.get('X-Game-Id') || 'unknown';
      const fileKey = url.searchParams.get('fileKey') || req.headers.get('X-File-Key') || 'default';
      const content = await req.text();

      // Upsert payload to Postgres game_data table
      const { error: upsertErr } = await supabase
        .from('game_data')
        .upsert({
          channel_id: channelId,
          game_id: gameId,
          file_key: fileKey,
          content,
          content_type: req.headers.get('Content-Type') || 'text/plain',
          size: content.length,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'channel_id,game_id,file_key' });

      if (upsertErr) return json({ error: `Database error: ${upsertErr.message}` }, 500, req);

      // Async update daily channel_stats
      const todayStr = today();
      const { data: existingStats } = await supabase
        .from('channel_stats')
        .select('uploads, bytes_in')
        .eq('channel_id', channelId)
        .eq('date', todayStr)
        .single();

      await supabase.from('channel_stats').upsert({
        channel_id: channelId,
        date: todayStr,
        uploads: (existingStats?.uploads || 0) + 1,
        bytes_in: (existingStats?.bytes_in || 0) + content.length,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'channel_id,date' });

      return json({ success: true, key: `data:${channelId}:${gameId}:${fileKey}`, size: content.length }, 200, req);
    }

    // ── Data Serve ─────────────────────────────────────────────────────────
    if (path.startsWith('/data') && method === 'GET') {
      const parts = path.split('/').filter(Boolean);
      if (parts.length < 4) return json({ error: 'Invalid path' }, 400, req);
      const [, channelId, gameId, fileKey] = parts;

      const { data: record } = await supabase
        .from('game_data')
        .select('content, content_type, size, updated_at')
        .eq('channel_id', channelId)
        .eq('game_id', gameId)
        .eq('file_key', fileKey)
        .single();

      if (!record) return json({ error: 'No data found' }, 404, req);

      // Update viewer GET stats
      const todayStr = today();
      const { data: existingStats } = await supabase
        .from('channel_stats')
        .select('gets, bytes_out')
        .eq('channel_id', channelId)
        .eq('date', todayStr)
        .single();

      await supabase.from('channel_stats').upsert({
        channel_id: channelId,
        date: todayStr,
        gets: (existingStats?.gets || 0) + 1,
        bytes_out: (existingStats?.bytes_out || 0) + (record.size || record.content.length),
        last_seen: new Date().toISOString(),
      }, { onConflict: 'channel_id,date' });

      const isJson = record.content.trimStart().startsWith('{') || record.content.trimStart().startsWith('[');
      return withCors(
        new Response(record.content, {
          headers: {
            'Content-Type': isJson ? 'application/json' : record.content_type || 'text/plain; charset=utf-8',
            'X-Updated-At': record.updated_at || '',
            'X-Data-Size': String(record.size || record.content.length),
            'Cache-Control': 'no-cache, no-store',
          },
        }),
        req
      );
    }

    // ── Data Delete ────────────────────────────────────────────────────────
    if (path.startsWith('/data') && method === 'DELETE') {
      const authHeader = req.headers.get('Authorization') || '';
      const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const headerChannelId = req.headers.get('X-Channel-Id') || url.searchParams.get('channelId');

      let channelId: string | null = null;
      if (apiKey) {
        const { data: keyRecord } = await supabase
          .from('api_keys')
          .select('channel_id')
          .eq('api_key', apiKey)
          .single();
        channelId = keyRecord?.channel_id || headerChannelId;
      } else {
        channelId = headerChannelId;
      }

      if (!channelId) return json({ error: 'Could not resolve channel_id for delete' }, 400, req);

      const parts = path.split('/').filter(Boolean);
      // DELETE /data/:gameId/:fileKey
      if (parts.length >= 3) {
        const [, gameId, fileKey] = parts;
        const { error: delErr } = await supabase
          .from('game_data')
          .delete()
          .eq('channel_id', channelId)
          .eq('game_id', gameId)
          .eq('file_key', fileKey);

        if (delErr) return json({ error: delErr.message }, 500, req);
        return json({ success: true, deletedCount: 1 }, 200, req);
      }

      // DELETE /data -> delete all game_data rows for this channel_id
      const { error: delErr, count } = await supabase
        .from('game_data')
        .delete({ count: 'exact' })
        .eq('channel_id', channelId);

      if (delErr) return json({ error: delErr.message }, 500, req);
      return json({ success: true, deletedCount: count || 0 }, 200, req);
    }

    // ── Admin Endpoints ────────────────────────────────────────────────────
    if (path.startsWith('/admin')) {
      const authHeader = req.headers.get('Authorization') || '';
      const bearer = authHeader.replace('Bearer ', '').trim();
      if (ADMIN_SECRET && bearer !== ADMIN_SECRET) {
        return json({ error: 'Unauthorized' }, 401, req);
      }

      if (path === '/admin/stats' && method === 'GET') {
        const dateStr = url.searchParams.get('date') || today();
        const { data: statsRows } = await supabase
          .from('channel_stats')
          .select('*')
          .eq('date', dateStr);

        let totalUploads = 0, totalBytesIn = 0, totalGets = 0, totalBytesOut = 0;
        const streamers: string[] = [];

        (statsRows || []).forEach(r => {
          totalUploads += r.uploads || 0;
          totalBytesIn += r.bytes_in || 0;
          totalGets += r.gets || 0;
          totalBytesOut += r.bytes_out || 0;
          if ((r.uploads || 0) > 0 || (r.gets || 0) > 0) streamers.push(r.channel_id);
        });

        return json({ uploads: totalUploads, bytesIn: totalBytesIn, gets: totalGets, bytesOut: totalBytesOut, streamers }, 200, req);
      }

      if (path === '/admin/streamers' && method === 'GET') {
        const dateStr = url.searchParams.get('date') || today();
        const { data: channels } = await supabase.from('channels').select('*');
        const { data: keys } = await supabase.from('api_keys').select('*');
        const { data: statsList } = await supabase.from('channel_stats').select('*').eq('date', dateStr);
        const { data: activeGameData } = await supabase.from('game_data').select('channel_id');
        const { data: blockedList } = await supabase.from('blocked_channels').select('*');

        const channelMap = new Map<string, any>();

        (channels || []).forEach(c => {
          const login = (c.twitch_login && !c.twitch_login.startsWith('channel_')) ? c.twitch_login : (c.channel_id === '48715826' ? 'panterdnola' : (c.twitch_login || `user_${c.channel_id}`));
          channelMap.set(c.channel_id, {
            channelId: c.channel_id,
            twitchLogin: login,
            twitchUserId: c.twitch_user_id || c.channel_id,
            registeredAt: c.registered_at || new Date().toISOString(),
          });
        });

        (keys || []).forEach(k => {
          const login = (k.twitch_login && !k.twitch_login.startsWith('channel_')) ? k.twitch_login : (k.channel_id === '48715826' ? 'panterdnola' : (k.twitch_login || `user_${k.channel_id}`));
          if (k.channel_id) {
            const existing = channelMap.get(k.channel_id);
            if (!existing || existing.twitchLogin.startsWith('channel_') || existing.twitchLogin.startsWith('user_')) {
              channelMap.set(k.channel_id, {
                channelId: k.channel_id,
                twitchLogin: login,
                twitchUserId: k.twitch_user_id || k.channel_id,
                registeredAt: k.created_at || existing?.registeredAt || new Date().toISOString(),
              });
            }
          }
        });

        (statsList || []).forEach(s => {
          if (s.channel_id && !channelMap.has(s.channel_id)) {
            const login = s.channel_id === '48715826' ? 'panterdnola' : `user_${s.channel_id}`;
            channelMap.set(s.channel_id, {
              channelId: s.channel_id,
              twitchLogin: login,
              twitchUserId: s.channel_id,
              registeredAt: s.last_seen || new Date().toISOString(),
            });
          }
        });

        (activeGameData || []).forEach(g => {
          if (g.channel_id && !channelMap.has(g.channel_id)) {
            const login = g.channel_id === '48715826' ? 'panterdnola' : `user_${g.channel_id}`;
            channelMap.set(g.channel_id, {
              channelId: g.channel_id,
              twitchLogin: login,
              twitchUserId: g.channel_id,
              registeredAt: new Date().toISOString(),
            });
          }
        });

        const blockedMap = new Map((blockedList || []).map(b => [b.channel_id, b]));
        const statsMap = new Map((statsList || []).map(s => [s.channel_id, s]));

        const streamers = Array.from(channelMap.values()).map(ch => {
          const s = statsMap.get(ch.channelId);
          return {
            ...ch,
            blocked: blockedMap.has(ch.channelId),
            blockInfo: blockedMap.get(ch.channelId) || null,
            todayStats: {
              uploads: s?.uploads || 0,
              gets: s?.gets || 0,
              bytesIn: s?.bytes_in || 0,
              bytesOut: s?.bytes_out || 0,
            },
          };
        });

        return json(streamers, 200, req);
      }

      if (path === '/admin/block' && method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const { channelId, reason, blockedUntil } = body;
        if (!channelId) return json({ error: '"channelId" is required' }, 400, req);

        await supabase.from('blocked_channels').upsert({
          channel_id: channelId,
          reason: reason || 'Manual admin block',
          blocked_at: new Date().toISOString(),
          blocked_until: blockedUntil || null,
          blocked_by: 'admin',
        }, { onConflict: 'channel_id' });

        return json({ success: true, channelId, blocked: true }, 200, req);
      }

      if (path === '/admin/unblock' && method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const { channelId } = body;
        if (!channelId) return json({ error: '"channelId" is required' }, 400, req);

        await supabase.from('blocked_channels').delete().eq('channel_id', channelId);
        return json({ success: true, channelId, blocked: false }, 200, req);
      }
    }

    return json({ error: 'Not found' }, 404, req);
  } catch (err: any) {
    return json({ error: `Internal server error: ${err.message}` }, 500, req);
  }
});
