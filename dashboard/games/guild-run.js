/**
 * Guild Run — Game Profile
 *
 * Twitch extension endpoint: GET /data/:channelId/guild-run/data
 */

/** @type {import('./registry.js').GameProfile} */
const guildRun = {
  id: 'guild-run',
  name: 'Guild Run',
  description:
    'Monitors your Guild Run save directory to automatically detect and stream your active run save (`Run`).',
  emoji: '🛡️',
  defaultIntervalSec: 2,

  files: [
    {
      key: 'data',
      type: 'directory',
      label: 'Guild Run Save Directory',
      suggestedPath: 'C:\\Users\\<user>\\AppData\\LocalLow\\Leyline\\Guildrun\\Saves\\steam-<id>',
      description:
        'Select your steam save directory (`C:\\Users\\...\\AppData\\LocalLow\\Leyline\\Guildrun\\Saves\\steam-...`). The profile automatically detects the `Run` save file.',
    },
  ],

  /**
   * Process selected Guild Run save directory:
   * Looks for the 'Run' file inside the directory.
   * If found: decodes binary MessagePack 'Run' save into structured JSON.
   * If missing: returns static payload { status: "no_file_found", message: "No active run file found" } (without timestamp to allow skip-if-unchanged).
   *
   * @param {string} fileKey
   * @param {Object} dirItem - Directory handle, entry, or fallback item
   * @returns {Promise<Object|string|null>}
   */
  async processDirectory(fileKey, dirItem) {
    if (!dirItem) return null;

    // NOTE: Long-term, a separate status endpoint (e.g. GET/POST /status) would be cleaner,
    // but sending status in the main data payload avoids additional HTTP overhead & bandwidth currently.
    const noRunPayload = JSON.stringify({
      status: 'no_file_found',
      message: 'No active run file found'
    });

    let runFile = null;

    try {
      if (dirItem.type === 'directory' && dirItem.handle) {
        try {
          const runHandle = await dirItem.handle.getFileHandle('Run');
          runFile = await runHandle.getFile();
        } catch {
          return { content: noRunPayload, fileName: 'No Active Run' };
        }
      } else if (dirItem.type === 'directory-entry' && dirItem.entry) {
        try {
          const entries = await new Promise((resolve) => {
            const dirReader = dirItem.entry.createReader();
            dirReader.readEntries(res => resolve(res || []), () => resolve([]));
          });
          const runEntry = entries.find(e => e.isFile && e.name === 'Run');
          if (runEntry) {
            runFile = await new Promise(res => runEntry.file(f => res(f), () => res(null)));
          } else {
            return { content: noRunPayload, fileName: 'No Active Run' };
          }
        } catch {
          return { content: noRunPayload, fileName: 'No Active Run' };
        }
      } else if (dirItem.type === 'directory-fallback' && Array.isArray(dirItem.allFiles)) {
        runFile = dirItem.allFiles.find(f => f.name === 'Run') || null;
        if (!runFile) {
          return { content: noRunPayload, fileName: 'No Active Run' };
        }
      } else if (dirItem.file || dirItem.name) {
        if (dirItem.name === 'Run' || dirItem.file?.name === 'Run') {
          runFile = dirItem.file || dirItem;
        } else {
          return { content: noRunPayload, fileName: 'No Active Run' };
        }
      }
    } catch {
      return { content: noRunPayload, fileName: 'No Active Run' };
    }

    if (!runFile) {
      return { content: noRunPayload, fileName: 'No Active Run' };
    }

    try {
      const buffer = await runFile.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binaryStr = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }

      // Try MessagePack decode if available
      const decodeFunc = (typeof MessagePack !== 'undefined' && typeof MessagePack.decode === 'function')
        ? MessagePack.decode
        : (typeof window !== 'undefined' && window.MessagePack && window.MessagePack.decode);

      if (decodeFunc) {
        try {
          const root = decodeFunc(bytes);
          if (root && root.Payload) {
            const payload = decodeFunc(root.Payload);
            return {
              content: JSON.stringify({
                Version: root.Version,
                ScopeIndex: root.ScopeIndex,
                DifficultyIndex: root.DifficultyIndex,
                IsChallengeModeEnabled: root.IsChallengeModeEnabled,
                ...payload
              }),
              fileName: 'Run'
            };
          }
        } catch { }
      }

      return { content: binaryStr, fileName: 'Run' };
    } catch (err) {
      const isLockError = err.name === 'NotReadableError' || err.name === 'NotAllowedError' || err.name === 'SecurityError';
      if (isLockError) throw err;
      return { content: noRunPayload, fileName: 'No Active Run' };
    }
  },
};

export default guildRun;
