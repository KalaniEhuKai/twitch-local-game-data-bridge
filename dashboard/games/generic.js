/**
 * Generic Game Profile
 *
 * Uploads any file as-is without parsing. Works with any game.
 * The Twitch extension is responsible for parsing the raw content.
 *
 * Use this when:
 *  - The game produces small data files (a few KB or less)
 *  - You want a single dashboard setup regardless of game
 *  - You haven't written a game-specific parser yet
 */

/** @type {import('./registry.js').GameProfile} */
const generic = {
  id: 'generic',
  name: 'Generic (Raw Upload)',
  description: 'Uploads the selected file as-is, without any parsing. Best for small files.',
  emoji: '🎮',
  defaultIntervalSec: 2,

  files: [
    {
      key: 'file1',
      type: 'file',
      label: 'Game Data File',
      suggestedPath: '(Browse to any game data or save file)',
      description: 'Select the game file you want to make available to viewers.',
    },
  ],

  // No parse() function — raw file content is uploaded unchanged.
  // parse: undefined
};

export default generic;
