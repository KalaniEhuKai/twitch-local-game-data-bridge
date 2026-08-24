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

    // NOTE FOR FUTURE MAINTAINERS & DEVELOPERS:
    // 1. SCHEMA VERSIONING: Always increment BridgeSchemaVersion (e.g. '1.1.0') when modifying or adding schema keys.
    // 2. BACKWARDS COMPATIBILITY: In the future, once the updated Twitch extension overlay code (v1.1.0+) is 100% deployed
    //    in production to all viewers, we can change the status string to distinguish "no_active_run" (Profile found, no Run file)
    //    vs "no_file_found" (no save files found at all). Currently, we keep status as "no_file_found" to guarantee 100%
    //    backwards compatibility with older extension overlay builds.
    const createNoRunPayload = (profileDto = null) => JSON.stringify({
      BridgeSchemaVersion: '1.1.0',
      status: 'no_file_found',
      message: 'No active run file found',
      ProfileDto: profileDto
    });

    let runFile = null;
    let profileFile = null;

    try {
      if (dirItem.type === 'directory' && dirItem.handle) {
        try {
          const runHandle = await dirItem.handle.getFileHandle('Run');
          runFile = await runHandle.getFile();
        } catch { }
        try {
          const profileHandle = await dirItem.handle.getFileHandle('Profile');
          profileFile = await profileHandle.getFile();
        } catch { }
      } else if (dirItem.type === 'directory-entry' && dirItem.entry) {
        try {
          const entries = await new Promise((resolve) => {
            const dirReader = dirItem.entry.createReader();
            dirReader.readEntries(res => resolve(res || []), () => resolve([]));
          });
          const runEntry = entries.find(e => e.isFile && e.name === 'Run');
          const profileEntry = entries.find(e => e.isFile && e.name === 'Profile');
          if (runEntry) {
            runFile = await new Promise(res => runEntry.file(f => res(f), () => res(null)));
          }
          if (profileEntry) {
            profileFile = await new Promise(res => profileEntry.file(f => res(f), () => res(null)));
          }
        } catch { }
      } else if (dirItem.type === 'directory-fallback' && Array.isArray(dirItem.allFiles)) {
        runFile = dirItem.allFiles.find(f => f.name === 'Run') || null;
        profileFile = dirItem.allFiles.find(f => f.name === 'Profile') || null;
      } else if (dirItem.file || dirItem.name) {
        if (dirItem.name === 'Run' || dirItem.file?.name === 'Run') {
          runFile = dirItem.file || dirItem;
        } else if (dirItem.name === 'Profile' || dirItem.file?.name === 'Profile') {
          profileFile = dirItem.file || dirItem;
        }
      }
    } catch { }

    // Helper for MessagePack decoding
    const decodeFunc = (typeof MessagePack !== 'undefined' && typeof MessagePack.decode === 'function')
      ? MessagePack.decode
      : (typeof window !== 'undefined' && window.MessagePack && window.MessagePack.decode);

    // Helper to decode ProfileDto from Profile file
    async function parseProfileDto(pFile) {
      if (!pFile || !decodeFunc) return null;
      try {
        const pBuffer = await pFile.arrayBuffer();
        const pBytes = new Uint8Array(pBuffer);
        const pRoot = decodeFunc(pBytes);
        if (pRoot) {
          const pData = pRoot.Payload ? decodeFunc(pRoot.Payload) : pRoot;
          const prog = pData.Progression || {};
          const history = prog.DemoChallengeRunHistory || prog.ChallengeRunHistory || [];
          
          let currentStreak = 0;
          for (let i = history.length - 1; i >= 0; i--) {
            const guid = history[i];
            if (guid && guid !== '00000000-0000-0000-0000-000000000000') {
              currentStreak++;
            } else {
              break;
            }
          }

          let bestStreak = 0;
          let tempStreak = 0;
          for (let i = 0; i < history.length; i++) {
            const guid = history[i];
            if (guid && guid !== '00000000-0000-0000-0000-000000000000') {
              tempStreak++;
              if (tempStreak > bestStreak) {
                bestStreak = tempStreak;
              }
            } else {
              tempStreak = 0;
            }
          }

          return {
            CurrentStreak: currentStreak,
            BestStreak: bestStreak,
            TotalStartedRuns: prog.TotalStartedRuns || 0,
            TotalRunsBeaten: prog.TotalRunsBeaten || 0,
            HighestDifficultyBeaten: prog.HighestDifficultyBeaten || 0
          };
        }
      } catch (pErr) {
        console.warn('[GuildRun] Error parsing Profile file:', pErr);
      }
      return null;
    }

    const profileDto = await parseProfileDto(profileFile);

    if (!runFile) {
      return { content: createNoRunPayload(profileDto), fileName: 'No Active Run' };
    }

    try {
      const buffer = await runFile.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binaryStr = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }

      if (decodeFunc) {
        try {
          const root = decodeFunc(bytes);
          if (root && root.Payload) {
            const payload = decodeFunc(root.Payload);
            return {
              content: JSON.stringify({
                BridgeSchemaVersion: '1.1.0',
                Version: root.Version,
                ScopeIndex: root.ScopeIndex,
                DifficultyIndex: root.DifficultyIndex,
                IsChallengeModeEnabled: root.IsChallengeModeEnabled,
                ...payload,
                ProfileDto: profileDto
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
      return { content: createNoRunPayload(profileDto), fileName: 'No Active Run' };
    }
  },
};

export default guildRun;
