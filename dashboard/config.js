/**
 * =============================================================================
 * Twitch Local Game Data Bridge — Dashboard Configuration
 * =============================================================================
 * Fill in both values before deploying, then commit/upload this file.
 * This file is loaded as a plain <script> tag so it runs before the ES module.
 */
window.TLGDB_CONFIG = {
  /**
   * Active backend infrastructure provider:
   *   'cloudflare' — Cloudflare Worker + KV
   *   'supabase'   — Supabase Edge Function + Postgres JSONB
   */
  backendType: 'cloudflare',

  /** Endpoint URLs */
  cloudflareWorkerUrl: 'https://twitch-local-game-data-bridge.kalani-ehu-kai.workers.dev',
  supabaseFunctionUrl: 'https://YOUR_SUPABASE_PROJECT_REF.supabase.co/functions/v1/bridge',

  /** Active Backend URL (Evaluated dynamically) */
  get workerUrl() {
    return this.backendType === 'supabase' ? this.supabaseFunctionUrl : this.cloudflareWorkerUrl;
  },

  /**
   * Your Twitch Developer Application Client ID.
   */
  twitchClientId: 'r4bobxefhulol3yqbqna3dqdfce65i',
};
