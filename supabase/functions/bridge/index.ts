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
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Game-Id, X-File-Key, X-Api-Key');
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

      if (!keyRecord) return json({ error: 'Unrecognized API key' }, 401, req);
      const channelId = keyRecord.channel_id;

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

    return json({ error: 'Not found' }, 404, req);
  } catch (err: any) {
    return json({ error: `Internal server error: ${err.message}` }, 500, req);
  }
});
