/**
 * =============================================================================
 * Twitch Local Game Data Bridge — Dashboard Configuration
 * =============================================================================
 * Fill in both values before deploying, then commit/upload this file.
 * This file is loaded as a plain <script> tag so it runs before the ES module.
 */
window.TLGDB_CONFIG = {
  /**
   * The base URL of your deployed Cloudflare Worker, without a trailing slash.
   * Example: "https://twitch-local-game-data-bridge.kalani-ehu-kai.workers.dev"
   *      or: "https://api.yourdomain.com"  (if using a custom domain)
   */
  workerUrl: 'https://twitch-local-game-data-bridge.kalani-ehu-kai.workers.dev',

  /**
   * Your Twitch Developer Application Client ID.
   * Find it at: https://dev.twitch.tv/console/apps
   * This is the PUBLIC client ID — it is safe to include here.
   * Never put your Client Secret in this file.
   */
  twitchClientId: 'r4bobxefhulol3yqbqna3dqdfce65i',
};
