// =============================================================================
// Supabase Edge Function — Twitch Local Game Data Bridge (bridge/index.ts)
// Deno TypeScript Edge Function with PostgreSQL JSONB Telemetry Data Storage
// =============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.8';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function withCors(response: Response, request?: Request): Response {
  const origin = request ? request.headers.get('Origin') : null;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Game-Id, X-File-Key, X-Api-Key, X-Channel-Id, *');
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

      // Check existing channel
      const { data: existingChannel } = await supabase
        .from('channels')
        .select('key_id')
        .eq('channel_id', channelId)
        .single();

      if (existingChannel?.key_id) {
        return json({ apiKey: existingChannel.key_id, channelId, twitchLogin, existing: true }, 200, req);
      }

      const apiKey = crypto.randomUUID();
      await supabase.from('api_keys').insert({
        api_key: apiKey,
        channel_id: channelId,
        twitch_user_id: user.id,
        twitch_login: twitchLogin,
      });

      await supabase.from('channels').insert({
        channel_id: channelId,
        key_id: apiKey,
        twitch_login: twitchLogin,
        twitch_user_id: user.id,
      });

      return json({ apiKey, channelId, twitchLogin, existing: false }, 200, req);
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

      // 1. Resolve channel_id from database keyRecord or incoming header / URL param
      let channelId = keyRecord?.channel_id;
      if (!channelId) {
        channelId = url.searchParams.get('channelId') || req.headers.get('X-Channel-Id') || null;
        if (channelId) {
          // Auto-persist api_key -> channel_id mapping in Supabase for subsequent uploads
          await supabase.from('api_keys').upsert(
            { api_key: apiKey, channel_id: channelId },
            { onConflict: 'api_key' }
          );
        } else {
          channelId = 'default_channel';
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

    return json({ error: 'Not found' }, 404, req);
  } catch (err: any) {
    return json({ error: `Internal server error: ${err.message}` }, 500, req);
  }
});
