/**
 * Slice & Dice — Game Profile
 *
 * Slice & Dice stores user save data and active run state in `xsrvc.dll`
 * (`C:\Program Files (x86)\Steam\steamapps\common\Slice_n_Dice\xsrvc.dll`).
 *
 * Twitch extension endpoint: GET /data/:channelId/slice-and-dice/data
 */

/**
 * Attempt to decode non-human-readable Slice & Dice encoded strings
 * (Base64, GZIP, Deflate, or encoded JSON payloads) into a clean, human/machine-readable format.
 *
 * @param {string} rawVal
 * @returns {Promise<any>}
 */
async function decodeSliceAndDiceEncodedString(rawVal) {
  if (!rawVal || typeof rawVal !== 'string') return rawVal;
  const trimmed = rawVal.trim();
  if (!trimmed) return rawVal;

  // 1. Check if already valid JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch { }
  }

  // 2. Try Base64 + GZIP / Deflate / UTF-8 decoding
  try {
    const binaryStr = atob(trimmed);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // GZIP header 0x1f 0x8b
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const res = new Response(ds.readable);
        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
      } catch { }
    }

    // Zlib header 0x78
    if (bytes.length > 2 && bytes[0] === 0x78 && typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(bytes.slice(2)); // strip zlib header
        writer.close();
        const res = new Response(ds.readable);
        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
      } catch { }
    }

    // Plain Base64 ASCII/UTF-8 text
    const textDecoder = new TextDecoder('utf-8');
    const decodedText = textDecoder.decode(bytes);
    if (/^[\x20-\x7E\r\n\t]+$/.test(decodedText)) {
      try { return JSON.parse(decodedText); } catch { return decodedText; }
    }
  } catch { }

  return rawVal;
}

/**
 * Unescape XML entities including numeric decimal entities (e.g. &#154;).
 *
 * @param {string} str
 * @returns {string}
 */
function decodeXmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  let res = str.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  res = res.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return res;
}

/**
 * Extract mode name from decoded run_history array, object, or string.
 *
 * @param {any} history
 * @returns {string|null}
 */
function extractModeFromRunHistory(history) {
  if (!history) return null;
  let target = history;

  if (Array.isArray(history) && history.length > 0) {
    // Get latest run entry in history
    target = history[history.length - 1] || history[0];
  }

  if (typeof target === 'object' && target !== null) {
    return target.mode || target.modeName || target.mode_name || target.lastMode || target.name || null;
  }

  if (typeof target === 'string') {
    const m = target.match(/["']?(?:mode|modeName|lastMode)["']?\s*[:=]\s*["']?([^"',;\]}\s]+)/i);
    if (m) return m[1];
  }

  return null;
}

/**
 * Translate current run mode name to XML entry key prefix.
 *
 * @param {string} currentRunModeName
 * @returns {string}
 */
function translateCurrentRunModeNameToXmlEntryKeyValue(currentRunModeName) {
  if (!currentRunModeName) return '';
  switch (currentRunModeName) {
    case 'Cursed':
      return 'curse2';
    case 'Blursed':
      return 'curse-easy';
    default:
      return currentRunModeName;
  }
}

/**
 * Parse Slice & Dice save/run content into a clean JSON object.
 *
 * NOTE FOR FUTURE MAINTAINERS / DEVELOPERS:
 * DO NOT add dummy fallback values (e.g. defaulting currentRunModeName to "Classic") if parsing fails!
 * If mode name, XML key, or run data cannot be cleanly parsed or extracted from the payload,
 * fields MUST output `null`. Returning `null` explicitly signals a parsing error so that downstream
 * consumers and extension layers treat unparsed/corrupted data as an error instead of displaying false data.
 *
 * @param {string} content - Raw content of the data file
 * @returns {Promise<string>} JSON string containing parsed game state
 */
async function parseSliceAndDiceData(content) {
  if (!content || typeof content !== 'string') {
    return JSON.stringify({ error: 'Empty file', parsedAt: new Date().toISOString() });
  }

  const trimmed = content.trim();

  // If raw content is already a top-level JSON object:
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const data = JSON.parse(trimmed);
      return JSON.stringify({ ...data, parsedAt: new Date().toISOString() });
    } catch { }
  }

  // Parse all <entry key="..." value="..."> or <entry key="...">value</entry> tags into a map
  const entriesMap = {};

  if (trimmed.includes('<map') || trimmed.includes('<entry')) {
    const entryRegex = /<entry\s+key="([^"]+)"(?:\s+value="([^"]*)")?(?:>([\s\S]*?)<\/entry>|\/>)/gi;
    let m;
    while ((m = entryRegex.exec(trimmed)) !== null) {
      const key = m[1];
      let val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : '');
      val = decodeXmlEntities(val);

      // Privacy filter: skip local machine paths
      if (key.toLowerCase().includes('path') || val.includes(':\\') || val.includes('/Users/')) {
        continue;
      }
      entriesMap[key] = val;
    }
  }

  // Fallback line parser for plain key=value properties files
  if (Object.keys(entriesMap).length === 0) {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith('//') || trimmedLine.startsWith('<')) continue;

      const eqIdx = trimmedLine.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmedLine.slice(0, eqIdx).trim();
        let val = trimmedLine.slice(eqIdx + 1).trim();
        val = decodeXmlEntities(val);

        if (key.toLowerCase().includes('path') || val.includes(':\\') || val.includes('/Users/')) {
          continue;
        }
        entriesMap[key] = val;
      }
    }
  }

  // 1. Decode run_history and other encoded strings into human/machine readable JSON first
  let runHistoryDecoded = null;
  if (entriesMap['run_history']) {
    runHistoryDecoded = await decodeSliceAndDiceEncodedString(entriesMap['run_history']);
  }

  // Decode any other complex history/stats entries if present
  for (const k of Object.keys(entriesMap)) {
    if (k.includes('history') || k.includes('achieve') || k.includes('undo')) {
      entriesMap[k] = await decodeSliceAndDiceEncodedString(entriesMap[k]);
    }
  }

  // 2. Extract currentRunModeName from decoded run_history!
  let currentRunModeName = extractModeFromRunHistory(runHistoryDecoded);

  // Fallback to settings if run_history didn't specify a mode name
  if (!currentRunModeName && entriesMap['settings']) {
    const settingsRaw = entriesMap['settings'];
    try {
      const settingsObj = typeof settingsRaw === 'object' ? settingsRaw : JSON.parse(settingsRaw);
      currentRunModeName = settingsObj.lastMode || settingsObj.mode || null;
    } catch {
      const lastModeMatch = String(settingsRaw).match(/["']?lastMode["']?\s*:\s*["']([^"']+)["']/i);
      if (lastModeMatch) {
        currentRunModeName = lastModeMatch[1];
      }
    }
  }

  // 3. Mode name to XML key mapping
  const modeNameToKeyMap = {
    'classic': 'classic',
    'classic_normal': 'classic',
    'cursed': 'curse2',
    'curse2': 'curse2',
    'blursed': 'curse-easy',
    'curse-easy': 'curse-easy',
    'blyptra': 'blyptra',
    'loot': 'loot',
  };

  let xmlKey = null;
  if (currentRunModeName) {
    const norm = String(currentRunModeName).toLowerCase();
    xmlKey = modeNameToKeyMap[norm] || norm;
  }

  // 4. Retrieve current run data
  let currentRunDataRaw = null;
  let currentRunDataParsed = null;

  if (xmlKey) {
    currentRunDataRaw = entriesMap[`${xmlKey}_mode_of_current_run`] || entriesMap[xmlKey] || null;
  }

  if (currentRunDataRaw) {
    try {
      currentRunDataParsed = typeof currentRunDataRaw === 'object' ? currentRunDataRaw : JSON.parse(currentRunDataRaw);
    } catch {
      currentRunDataParsed = currentRunDataRaw;
    }
  }

  // STRICT ERROR SIGNALING:
  // If parsing fails to extract mode or run details, DO NOT force dummy defaults (e.g., defaulting to 'Classic').
  // Output null for unparsed fields so callers/extensions accurately detect parsing errors.
  const result = {
    game: 'Slice & Dice',
    currentRunModeName: currentRunModeName || null,
    currentRunModeXmlKey: xmlKey || null,
    currentRunData: currentRunDataParsed !== null ? currentRunDataParsed : (currentRunDataRaw || null),
    runHistory: runHistoryDecoded || null,
    parsedAt: new Date().toISOString(),
  };

  return JSON.stringify(result);
}

/** @type {import('./registry.js').GameProfile} */
const sliceAndDice = {
  id: 'slice-and-dice',
  name: 'Slice & Dice (In Progress / Not Working)',
  description:
    '⚠️ IN PROGRESS — NOT CURRENTLY WORKING. Slice & Dice data parsing is under active development.',
  emoji: '🎲',
  defaultIntervalSec: 2,

  files: [
    {
      key: 'data',
      type: 'directory',
      label: 'Slice & Dice Directory',
      suggestedPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Slice_n_Dice',
      description:
        'Select the `Slice_n_Dice` folder. The game profile will automatically select and process `xsrvc.dll` (or backup save files).',
    },
  ],

  /**
   * Process selected Slice & Dice directory:
   * Inspects folder entries for xsrvc.dll or xsrvcx.dll, reads binary save content, and returns JSON payload.
   *
   * @param {string} fileKey
   * @param {Object} dirItem
   * @returns {Promise<string|null>}
   */
  async processDirectory(fileKey, dirItem) {
    if (!dirItem) return null;
    let file = null;

    if (dirItem.type === 'directory') {
      try {
        const handle = await dirItem.handle.getFileHandle('xsrvc.dll');
        file = await handle.getFile();
      } catch {
        try {
          const handle = await dirItem.handle.getFileHandle('xsrvcx.dll');
          file = await handle.getFile();
        } catch { }
      }
    } else if (dirItem.type === 'directory-fallback' && Array.isArray(dirItem.allFiles)) {
      file = dirItem.allFiles.find(f => f.name.toLowerCase() === 'xsrvc.dll') ||
             dirItem.allFiles.find(f => f.name.toLowerCase() === 'xsrvcx.dll') ||
             dirItem.file;
    }

    if (!file) return null;

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binaryStr = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }

    return {
      content: parseSliceAndDiceData(binaryStr),
      fileName: file.name,
    };
  },

  parse(fileKey, content) {
    if (fileKey === 'data') {
      return parseSliceAndDiceData(content);
    }
    return content;
  },
};

export default sliceAndDice;
