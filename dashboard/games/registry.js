/**
 * =============================================================================
 * Game Profile Registry
 * =============================================================================
 *
 * To add a new game:
 *   1. Create a new file in this folder: dashboard/games/your-game.js
 *   2. Export a default GameProfile object (see generic.js for the shape)
 *   3. Import it below and add it to the GAMES array
 *
 * The dashboard will automatically list all games in the dropdown.
 */

import generic from './generic.js?v=2';
import sliceAndDice from './slice-and-dice.js?v=2';
import guildRun from './guild-run.js?v=2';

// ── Add new game profiles here ────────────────────────────────────────────────
export const GAMES = [
  sliceAndDice,
  guildRun,
  generic,
];

/**
 * @typedef {Object} GameFile
 * @property {string} key           - Unique identifier for this file (used in the KV key and API path)
 * @property {string} label         - Human-readable label shown in the dashboard UI
 * @property {string} suggestedPath - Suggested default path shown as a hint to the user
 * @property {string} [description] - Optional longer description shown under the label
 */

/**
 * @typedef {Object} GameProfile
 * @property {string}     id          - Unique game identifier (used in API paths, e.g. "path-of-exile")
 * @property {string}     name        - Display name shown in the dropdown
 * @property {string}     description - Short description of what data is captured
 * @property {string}     [emoji]              - Optional emoji icon displayed next to the game name
 * @property {number}     [defaultIntervalSec] - Default check frequency in seconds (e.g. 1 or 2)
 * @property {GameFile[]} files                - List of game files this profile watches
 * @property {Function}   [parse]     - Optional parser: (fileKey: string, content: string) => string | null
 *                                      Return a string to upload, or null to skip this update.
 *                                      If omitted, raw file content is uploaded as-is.
 */
