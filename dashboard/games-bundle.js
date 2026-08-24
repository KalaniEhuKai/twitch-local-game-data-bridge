(() => {
  // node_modules/@msgpack/msgpack/dist.esm/utils/utf8.mjs
  var sharedTextEncoder = new TextEncoder();
  var CHUNK_SIZE = 4096;
  function utf8DecodeJs(bytes, inputOffset, byteLength) {
    let offset = inputOffset;
    const end = offset + byteLength;
    const units = [];
    let result = "";
    while (offset < end) {
      const byte1 = bytes[offset++];
      if ((byte1 & 128) === 0) {
        units.push(byte1);
      } else if ((byte1 & 224) === 192) {
        const byte2 = bytes[offset++] & 63;
        units.push((byte1 & 31) << 6 | byte2);
      } else if ((byte1 & 240) === 224) {
        const byte2 = bytes[offset++] & 63;
        const byte3 = bytes[offset++] & 63;
        units.push((byte1 & 31) << 12 | byte2 << 6 | byte3);
      } else if ((byte1 & 248) === 240) {
        const byte2 = bytes[offset++] & 63;
        const byte3 = bytes[offset++] & 63;
        const byte4 = bytes[offset++] & 63;
        let unit = (byte1 & 7) << 18 | byte2 << 12 | byte3 << 6 | byte4;
        if (unit > 65535) {
          unit -= 65536;
          units.push(unit >>> 10 & 1023 | 55296);
          unit = 56320 | unit & 1023;
        }
        units.push(unit);
      } else {
        units.push(byte1);
      }
      if (units.length >= CHUNK_SIZE) {
        result += String.fromCharCode(...units);
        units.length = 0;
      }
    }
    if (units.length > 0) {
      result += String.fromCharCode(...units);
    }
    return result;
  }
  var sharedTextDecoder = new TextDecoder();
  var TEXT_DECODER_THRESHOLD = 200;
  function utf8DecodeTD(bytes, inputOffset, byteLength) {
    const stringBytes = bytes.subarray(inputOffset, inputOffset + byteLength);
    return sharedTextDecoder.decode(stringBytes);
  }
  function utf8Decode(bytes, inputOffset, byteLength) {
    if (byteLength > TEXT_DECODER_THRESHOLD) {
      return utf8DecodeTD(bytes, inputOffset, byteLength);
    } else {
      return utf8DecodeJs(bytes, inputOffset, byteLength);
    }
  }

  // node_modules/@msgpack/msgpack/dist.esm/ExtData.mjs
  var ExtData = class {
    type;
    data;
    constructor(type, data) {
      this.type = type;
      this.data = data;
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/DecodeError.mjs
  var DecodeError = class _DecodeError extends Error {
    constructor(message) {
      super(message);
      const proto = Object.create(_DecodeError.prototype);
      Object.setPrototypeOf(this, proto);
      Object.defineProperty(this, "name", {
        configurable: true,
        enumerable: false,
        value: _DecodeError.name
      });
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/utils/int.mjs
  var UINT32_MAX = 4294967295;
  function setInt64(view, offset, value) {
    const high = Math.floor(value / 4294967296);
    const low = value;
    view.setUint32(offset, high);
    view.setUint32(offset + 4, low);
  }
  function getInt64(view, offset) {
    const high = view.getInt32(offset);
    const low = view.getUint32(offset + 4);
    return high * 4294967296 + low;
  }
  function getUint64(view, offset) {
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    return high * 4294967296 + low;
  }

  // node_modules/@msgpack/msgpack/dist.esm/timestamp.mjs
  var EXT_TIMESTAMP = -1;
  var TIMESTAMP32_MAX_SEC = 4294967296 - 1;
  var TIMESTAMP64_MAX_SEC = 17179869184 - 1;
  function encodeTimeSpecToTimestamp({ sec, nsec }) {
    if (sec >= 0 && nsec >= 0 && sec <= TIMESTAMP64_MAX_SEC) {
      if (nsec === 0 && sec <= TIMESTAMP32_MAX_SEC) {
        const rv = new Uint8Array(4);
        const view = new DataView(rv.buffer);
        view.setUint32(0, sec);
        return rv;
      } else {
        const secHigh = sec / 4294967296;
        const secLow = sec & 4294967295;
        const rv = new Uint8Array(8);
        const view = new DataView(rv.buffer);
        view.setUint32(0, nsec << 2 | secHigh & 3);
        view.setUint32(4, secLow);
        return rv;
      }
    } else {
      const rv = new Uint8Array(12);
      const view = new DataView(rv.buffer);
      view.setUint32(0, nsec);
      setInt64(view, 4, sec);
      return rv;
    }
  }
  function encodeDateToTimeSpec(date) {
    const msec = date.getTime();
    const sec = Math.floor(msec / 1e3);
    const nsec = (msec - sec * 1e3) * 1e6;
    const nsecInSec = Math.floor(nsec / 1e9);
    return {
      sec: sec + nsecInSec,
      nsec: nsec - nsecInSec * 1e9
    };
  }
  function encodeTimestampExtension(object) {
    if (object instanceof Date) {
      const timeSpec = encodeDateToTimeSpec(object);
      return encodeTimeSpecToTimestamp(timeSpec);
    } else {
      return null;
    }
  }
  function decodeTimestampToTimeSpec(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (data.byteLength) {
      case 4: {
        const sec = view.getUint32(0);
        const nsec = 0;
        return { sec, nsec };
      }
      case 8: {
        const nsec30AndSecHigh2 = view.getUint32(0);
        const secLow32 = view.getUint32(4);
        const sec = (nsec30AndSecHigh2 & 3) * 4294967296 + secLow32;
        const nsec = nsec30AndSecHigh2 >>> 2;
        return { sec, nsec };
      }
      case 12: {
        const sec = getInt64(view, 4);
        const nsec = view.getUint32(0);
        return { sec, nsec };
      }
      default:
        throw new DecodeError(`Unrecognized data size for timestamp (expected 4, 8, or 12): ${data.length}`);
    }
  }
  function decodeTimestampExtension(data) {
    const timeSpec = decodeTimestampToTimeSpec(data);
    return new Date(timeSpec.sec * 1e3 + timeSpec.nsec / 1e6);
  }
  var timestampExtension = {
    type: EXT_TIMESTAMP,
    encode: encodeTimestampExtension,
    decode: decodeTimestampExtension
  };

  // node_modules/@msgpack/msgpack/dist.esm/ExtensionCodec.mjs
  var ExtensionCodec = class _ExtensionCodec {
    static defaultCodec = new _ExtensionCodec();
    // ensures ExtensionCodecType<X> matches ExtensionCodec<X>
    // this will make type errors a lot more clear
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __brand;
    // built-in extensions
    builtInEncoders = [];
    builtInDecoders = [];
    // custom extensions
    encoders = [];
    decoders = [];
    constructor() {
      this.register(timestampExtension);
    }
    register({ type, encode, decode: decode2 }) {
      if (type >= 0) {
        this.encoders[type] = encode;
        this.decoders[type] = decode2;
      } else {
        const index = -1 - type;
        this.builtInEncoders[index] = encode;
        this.builtInDecoders[index] = decode2;
      }
    }
    tryToEncode(object, context) {
      for (let i = 0; i < this.builtInEncoders.length; i++) {
        const encodeExt = this.builtInEncoders[i];
        if (encodeExt != null) {
          const data = encodeExt(object, context);
          if (data != null) {
            const type = -1 - i;
            return new ExtData(type, data);
          }
        }
      }
      for (let i = 0; i < this.encoders.length; i++) {
        const encodeExt = this.encoders[i];
        if (encodeExt != null) {
          const data = encodeExt(object, context);
          if (data != null) {
            const type = i;
            return new ExtData(type, data);
          }
        }
      }
      if (object instanceof ExtData) {
        return object;
      }
      return null;
    }
    decode(data, type, context) {
      const decodeExt = type < 0 ? this.builtInDecoders[-1 - type] : this.decoders[type];
      if (decodeExt) {
        return decodeExt(data, type, context);
      } else {
        return new ExtData(type, data);
      }
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/utils/typedArrays.mjs
  function isArrayBufferLike(buffer) {
    return buffer instanceof ArrayBuffer || typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
  }
  function ensureUint8Array(buffer) {
    if (buffer instanceof Uint8Array) {
      return buffer;
    } else if (ArrayBuffer.isView(buffer)) {
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (isArrayBufferLike(buffer)) {
      return new Uint8Array(buffer);
    } else {
      return Uint8Array.from(buffer);
    }
  }

  // node_modules/@msgpack/msgpack/dist.esm/utils/prettyByte.mjs
  function prettyByte(byte) {
    return `${byte < 0 ? "-" : ""}0x${Math.abs(byte).toString(16).padStart(2, "0")}`;
  }

  // node_modules/@msgpack/msgpack/dist.esm/CachedKeyDecoder.mjs
  var DEFAULT_MAX_KEY_LENGTH = 16;
  var DEFAULT_MAX_LENGTH_PER_KEY = 16;
  var CachedKeyDecoder = class {
    hit = 0;
    miss = 0;
    caches;
    maxKeyLength;
    maxLengthPerKey;
    constructor(maxKeyLength = DEFAULT_MAX_KEY_LENGTH, maxLengthPerKey = DEFAULT_MAX_LENGTH_PER_KEY) {
      this.maxKeyLength = maxKeyLength;
      this.maxLengthPerKey = maxLengthPerKey;
      this.caches = [];
      for (let i = 0; i < this.maxKeyLength; i++) {
        this.caches.push([]);
      }
    }
    canBeCached(byteLength) {
      return byteLength > 0 && byteLength <= this.maxKeyLength;
    }
    find(bytes, inputOffset, byteLength) {
      const records = this.caches[byteLength - 1];
      FIND_CHUNK: for (const record of records) {
        const recordBytes = record.bytes;
        for (let j = 0; j < byteLength; j++) {
          if (recordBytes[j] !== bytes[inputOffset + j]) {
            continue FIND_CHUNK;
          }
        }
        return record.str;
      }
      return null;
    }
    store(bytes, value) {
      const records = this.caches[bytes.length - 1];
      const record = { bytes, str: value };
      if (records.length >= this.maxLengthPerKey) {
        records[Math.random() * records.length | 0] = record;
      } else {
        records.push(record);
      }
    }
    decode(bytes, inputOffset, byteLength) {
      const cachedValue = this.find(bytes, inputOffset, byteLength);
      if (cachedValue != null) {
        this.hit++;
        return cachedValue;
      }
      this.miss++;
      const str = utf8DecodeJs(bytes, inputOffset, byteLength);
      const slicedCopyOfBytes = Uint8Array.prototype.slice.call(bytes, inputOffset, inputOffset + byteLength);
      this.store(slicedCopyOfBytes, str);
      return str;
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/Decoder.mjs
  var STATE_ARRAY = "array";
  var STATE_MAP_KEY = "map_key";
  var STATE_MAP_VALUE = "map_value";
  var mapKeyConverter = (key) => {
    if (typeof key === "string" || typeof key === "number") {
      return key;
    }
    throw new DecodeError("The type of key must be string or number but " + typeof key);
  };
  var StackPool = class {
    stack = [];
    stackHeadPosition = -1;
    get length() {
      return this.stackHeadPosition + 1;
    }
    top() {
      return this.stack[this.stackHeadPosition];
    }
    pushArrayState(size) {
      const state = this.getUninitializedStateFromPool();
      state.type = STATE_ARRAY;
      state.position = 0;
      state.size = size;
      state.array = new Array(size);
    }
    pushMapState(size) {
      const state = this.getUninitializedStateFromPool();
      state.type = STATE_MAP_KEY;
      state.readCount = 0;
      state.size = size;
      state.map = {};
    }
    getUninitializedStateFromPool() {
      this.stackHeadPosition++;
      if (this.stackHeadPosition === this.stack.length) {
        const partialState = {
          type: void 0,
          size: 0,
          array: void 0,
          position: 0,
          readCount: 0,
          map: void 0,
          key: null
        };
        this.stack.push(partialState);
      }
      return this.stack[this.stackHeadPosition];
    }
    release(state) {
      const topStackState = this.stack[this.stackHeadPosition];
      if (topStackState !== state) {
        throw new Error("Invalid stack state. Released state is not on top of the stack.");
      }
      if (state.type === STATE_ARRAY) {
        const partialState = state;
        partialState.size = 0;
        partialState.array = void 0;
        partialState.position = 0;
        partialState.type = void 0;
      }
      if (state.type === STATE_MAP_KEY || state.type === STATE_MAP_VALUE) {
        const partialState = state;
        partialState.size = 0;
        partialState.map = void 0;
        partialState.readCount = 0;
        partialState.type = void 0;
      }
      this.stackHeadPosition--;
    }
    reset() {
      this.stack.length = 0;
      this.stackHeadPosition = -1;
    }
  };
  var HEAD_BYTE_REQUIRED = -1;
  var EMPTY_VIEW = new DataView(new ArrayBuffer(0));
  var EMPTY_BYTES = new Uint8Array(EMPTY_VIEW.buffer);
  try {
    EMPTY_VIEW.getInt8(0);
  } catch (e) {
    if (!(e instanceof RangeError)) {
      throw new Error("This module is not supported in the current JavaScript engine because DataView does not throw RangeError on out-of-bounds access");
    }
  }
  var MORE_DATA = new RangeError("Insufficient data");
  var sharedCachedKeyDecoder = new CachedKeyDecoder();
  var Decoder = class _Decoder {
    extensionCodec;
    context;
    useBigInt64;
    rawStrings;
    maxStrLength;
    maxBinLength;
    maxArrayLength;
    maxMapLength;
    maxExtLength;
    keyDecoder;
    mapKeyConverter;
    totalPos = 0;
    pos = 0;
    view = EMPTY_VIEW;
    bytes = EMPTY_BYTES;
    headByte = HEAD_BYTE_REQUIRED;
    stack = new StackPool();
    entered = false;
    constructor(options) {
      this.extensionCodec = options?.extensionCodec ?? ExtensionCodec.defaultCodec;
      this.context = options?.context;
      this.useBigInt64 = options?.useBigInt64 ?? false;
      this.rawStrings = options?.rawStrings ?? false;
      this.maxStrLength = options?.maxStrLength ?? UINT32_MAX;
      this.maxBinLength = options?.maxBinLength ?? UINT32_MAX;
      this.maxArrayLength = options?.maxArrayLength ?? UINT32_MAX;
      this.maxMapLength = options?.maxMapLength ?? UINT32_MAX;
      this.maxExtLength = options?.maxExtLength ?? UINT32_MAX;
      this.keyDecoder = options?.keyDecoder !== void 0 ? options.keyDecoder : sharedCachedKeyDecoder;
      this.mapKeyConverter = options?.mapKeyConverter ?? mapKeyConverter;
    }
    clone() {
      return new _Decoder({
        extensionCodec: this.extensionCodec,
        context: this.context,
        useBigInt64: this.useBigInt64,
        rawStrings: this.rawStrings,
        maxStrLength: this.maxStrLength,
        maxBinLength: this.maxBinLength,
        maxArrayLength: this.maxArrayLength,
        maxMapLength: this.maxMapLength,
        maxExtLength: this.maxExtLength,
        keyDecoder: this.keyDecoder
      });
    }
    reinitializeState() {
      this.totalPos = 0;
      this.headByte = HEAD_BYTE_REQUIRED;
      this.stack.reset();
    }
    setBuffer(buffer) {
      const bytes = ensureUint8Array(buffer);
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = 0;
    }
    appendBuffer(buffer) {
      if (this.headByte === HEAD_BYTE_REQUIRED && !this.hasRemaining(1)) {
        this.setBuffer(buffer);
      } else {
        const remainingData = this.bytes.subarray(this.pos);
        const newData = ensureUint8Array(buffer);
        const newBuffer = new Uint8Array(remainingData.length + newData.length);
        newBuffer.set(remainingData);
        newBuffer.set(newData, remainingData.length);
        this.setBuffer(newBuffer);
      }
    }
    hasRemaining(size) {
      return this.view.byteLength - this.pos >= size;
    }
    createExtraByteError(posToShow) {
      const { view, pos } = this;
      return new RangeError(`Extra ${view.byteLength - pos} of ${view.byteLength} byte(s) found at buffer[${posToShow}]`);
    }
    /**
     * @throws {@link DecodeError}
     * @throws {@link RangeError}
     */
    decode(buffer) {
      if (this.entered) {
        const instance = this.clone();
        return instance.decode(buffer);
      }
      try {
        this.entered = true;
        this.reinitializeState();
        this.setBuffer(buffer);
        const object = this.doDecodeSync();
        if (this.hasRemaining(1)) {
          throw this.createExtraByteError(this.pos);
        }
        return object;
      } finally {
        this.entered = false;
      }
    }
    *decodeMulti(buffer) {
      if (this.entered) {
        const instance = this.clone();
        yield* instance.decodeMulti(buffer);
        return;
      }
      try {
        this.entered = true;
        this.reinitializeState();
        this.setBuffer(buffer);
        while (this.hasRemaining(1)) {
          yield this.doDecodeSync();
        }
      } finally {
        this.entered = false;
      }
    }
    async decodeAsync(stream) {
      if (this.entered) {
        const instance = this.clone();
        return instance.decodeAsync(stream);
      }
      try {
        this.entered = true;
        let decoded = false;
        let object;
        for await (const buffer of stream) {
          if (decoded) {
            this.entered = false;
            throw this.createExtraByteError(this.totalPos);
          }
          this.appendBuffer(buffer);
          try {
            object = this.doDecodeSync();
            decoded = true;
          } catch (e) {
            if (!(e instanceof RangeError)) {
              throw e;
            }
          }
          this.totalPos += this.pos;
        }
        if (decoded) {
          if (this.hasRemaining(1)) {
            throw this.createExtraByteError(this.totalPos);
          }
          return object;
        }
        const { headByte, pos, totalPos } = this;
        throw new RangeError(`Insufficient data in parsing ${prettyByte(headByte)} at ${totalPos} (${pos} in the current buffer)`);
      } finally {
        this.entered = false;
      }
    }
    decodeArrayStream(stream) {
      return this.decodeMultiAsync(stream, true);
    }
    decodeStream(stream) {
      return this.decodeMultiAsync(stream, false);
    }
    async *decodeMultiAsync(stream, isArray) {
      if (this.entered) {
        const instance = this.clone();
        yield* instance.decodeMultiAsync(stream, isArray);
        return;
      }
      try {
        this.entered = true;
        let isArrayHeaderRequired = isArray;
        let arrayItemsLeft = -1;
        for await (const buffer of stream) {
          if (isArray && arrayItemsLeft === 0) {
            throw this.createExtraByteError(this.totalPos);
          }
          this.appendBuffer(buffer);
          if (isArrayHeaderRequired) {
            arrayItemsLeft = this.readArraySize();
            isArrayHeaderRequired = false;
            this.complete();
          }
          try {
            while (true) {
              yield this.doDecodeSync();
              if (--arrayItemsLeft === 0) {
                break;
              }
            }
          } catch (e) {
            if (!(e instanceof RangeError)) {
              throw e;
            }
          }
          this.totalPos += this.pos;
        }
      } finally {
        this.entered = false;
      }
    }
    doDecodeSync() {
      DECODE: while (true) {
        const headByte = this.readHeadByte();
        let object;
        if (headByte >= 224) {
          object = headByte - 256;
        } else if (headByte < 192) {
          if (headByte < 128) {
            object = headByte;
          } else if (headByte < 144) {
            const size = headByte - 128;
            if (size !== 0) {
              this.pushMapState(size);
              this.complete();
              continue DECODE;
            } else {
              object = {};
            }
          } else if (headByte < 160) {
            const size = headByte - 144;
            if (size !== 0) {
              this.pushArrayState(size);
              this.complete();
              continue DECODE;
            } else {
              object = [];
            }
          } else {
            const byteLength = headByte - 160;
            object = this.decodeString(byteLength, 0);
          }
        } else if (headByte === 192) {
          object = null;
        } else if (headByte === 194) {
          object = false;
        } else if (headByte === 195) {
          object = true;
        } else if (headByte === 202) {
          object = this.readF32();
        } else if (headByte === 203) {
          object = this.readF64();
        } else if (headByte === 204) {
          object = this.readU8();
        } else if (headByte === 205) {
          object = this.readU16();
        } else if (headByte === 206) {
          object = this.readU32();
        } else if (headByte === 207) {
          if (this.useBigInt64) {
            object = this.readU64AsBigInt();
          } else {
            object = this.readU64();
          }
        } else if (headByte === 208) {
          object = this.readI8();
        } else if (headByte === 209) {
          object = this.readI16();
        } else if (headByte === 210) {
          object = this.readI32();
        } else if (headByte === 211) {
          if (this.useBigInt64) {
            object = this.readI64AsBigInt();
          } else {
            object = this.readI64();
          }
        } else if (headByte === 217) {
          const byteLength = this.lookU8();
          object = this.decodeString(byteLength, 1);
        } else if (headByte === 218) {
          const byteLength = this.lookU16();
          object = this.decodeString(byteLength, 2);
        } else if (headByte === 219) {
          const byteLength = this.lookU32();
          object = this.decodeString(byteLength, 4);
        } else if (headByte === 220) {
          const size = this.readU16();
          if (size !== 0) {
            this.pushArrayState(size);
            this.complete();
            continue DECODE;
          } else {
            object = [];
          }
        } else if (headByte === 221) {
          const size = this.readU32();
          if (size !== 0) {
            this.pushArrayState(size);
            this.complete();
            continue DECODE;
          } else {
            object = [];
          }
        } else if (headByte === 222) {
          const size = this.readU16();
          if (size !== 0) {
            this.pushMapState(size);
            this.complete();
            continue DECODE;
          } else {
            object = {};
          }
        } else if (headByte === 223) {
          const size = this.readU32();
          if (size !== 0) {
            this.pushMapState(size);
            this.complete();
            continue DECODE;
          } else {
            object = {};
          }
        } else if (headByte === 196) {
          const size = this.lookU8();
          object = this.decodeBinary(size, 1);
        } else if (headByte === 197) {
          const size = this.lookU16();
          object = this.decodeBinary(size, 2);
        } else if (headByte === 198) {
          const size = this.lookU32();
          object = this.decodeBinary(size, 4);
        } else if (headByte === 212) {
          object = this.decodeExtension(1, 0);
        } else if (headByte === 213) {
          object = this.decodeExtension(2, 0);
        } else if (headByte === 214) {
          object = this.decodeExtension(4, 0);
        } else if (headByte === 215) {
          object = this.decodeExtension(8, 0);
        } else if (headByte === 216) {
          object = this.decodeExtension(16, 0);
        } else if (headByte === 199) {
          const size = this.lookU8();
          object = this.decodeExtension(size, 1);
        } else if (headByte === 200) {
          const size = this.lookU16();
          object = this.decodeExtension(size, 2);
        } else if (headByte === 201) {
          const size = this.lookU32();
          object = this.decodeExtension(size, 4);
        } else {
          throw new DecodeError(`Unrecognized type byte: ${prettyByte(headByte)}`);
        }
        this.complete();
        const stack = this.stack;
        while (stack.length > 0) {
          const state = stack.top();
          if (state.type === STATE_ARRAY) {
            state.array[state.position] = object;
            state.position++;
            if (state.position === state.size) {
              object = state.array;
              stack.release(state);
            } else {
              continue DECODE;
            }
          } else if (state.type === STATE_MAP_KEY) {
            if (object === "__proto__") {
              throw new DecodeError("The key __proto__ is not allowed");
            }
            state.key = this.mapKeyConverter(object);
            state.type = STATE_MAP_VALUE;
            continue DECODE;
          } else {
            state.map[state.key] = object;
            state.readCount++;
            if (state.readCount === state.size) {
              object = state.map;
              stack.release(state);
            } else {
              state.key = null;
              state.type = STATE_MAP_KEY;
              continue DECODE;
            }
          }
        }
        return object;
      }
    }
    readHeadByte() {
      if (this.headByte === HEAD_BYTE_REQUIRED) {
        this.headByte = this.readU8();
      }
      return this.headByte;
    }
    complete() {
      this.headByte = HEAD_BYTE_REQUIRED;
    }
    readArraySize() {
      const headByte = this.readHeadByte();
      switch (headByte) {
        case 220:
          return this.readU16();
        case 221:
          return this.readU32();
        default: {
          if (headByte < 160) {
            return headByte - 144;
          } else {
            throw new DecodeError(`Unrecognized array type byte: ${prettyByte(headByte)}`);
          }
        }
      }
    }
    pushMapState(size) {
      if (size > this.maxMapLength) {
        throw new DecodeError(`Max length exceeded: map length (${size}) > maxMapLengthLength (${this.maxMapLength})`);
      }
      this.stack.pushMapState(size);
    }
    pushArrayState(size) {
      if (size > this.maxArrayLength) {
        throw new DecodeError(`Max length exceeded: array length (${size}) > maxArrayLength (${this.maxArrayLength})`);
      }
      this.stack.pushArrayState(size);
    }
    decodeString(byteLength, headerOffset) {
      if (!this.rawStrings || this.stateIsMapKey()) {
        return this.decodeUtf8String(byteLength, headerOffset);
      }
      return this.decodeBinary(byteLength, headerOffset);
    }
    /**
     * @throws {@link RangeError}
     */
    decodeUtf8String(byteLength, headerOffset) {
      if (byteLength > this.maxStrLength) {
        throw new DecodeError(`Max length exceeded: UTF-8 byte length (${byteLength}) > maxStrLength (${this.maxStrLength})`);
      }
      if (this.bytes.byteLength < this.pos + headerOffset + byteLength) {
        throw MORE_DATA;
      }
      const offset = this.pos + headerOffset;
      let object;
      if (this.stateIsMapKey() && this.keyDecoder?.canBeCached(byteLength)) {
        object = this.keyDecoder.decode(this.bytes, offset, byteLength);
      } else {
        object = utf8Decode(this.bytes, offset, byteLength);
      }
      this.pos += headerOffset + byteLength;
      return object;
    }
    stateIsMapKey() {
      if (this.stack.length > 0) {
        const state = this.stack.top();
        return state.type === STATE_MAP_KEY;
      }
      return false;
    }
    /**
     * @throws {@link RangeError}
     */
    decodeBinary(byteLength, headOffset) {
      if (byteLength > this.maxBinLength) {
        throw new DecodeError(`Max length exceeded: bin length (${byteLength}) > maxBinLength (${this.maxBinLength})`);
      }
      if (!this.hasRemaining(byteLength + headOffset)) {
        throw MORE_DATA;
      }
      const offset = this.pos + headOffset;
      const object = this.bytes.subarray(offset, offset + byteLength);
      this.pos += headOffset + byteLength;
      return object;
    }
    decodeExtension(size, headOffset) {
      if (size > this.maxExtLength) {
        throw new DecodeError(`Max length exceeded: ext length (${size}) > maxExtLength (${this.maxExtLength})`);
      }
      const extType = this.view.getInt8(this.pos + headOffset);
      const data = this.decodeBinary(
        size,
        headOffset + 1
        /* extType */
      );
      return this.extensionCodec.decode(data, extType, this.context);
    }
    lookU8() {
      return this.view.getUint8(this.pos);
    }
    lookU16() {
      return this.view.getUint16(this.pos);
    }
    lookU32() {
      return this.view.getUint32(this.pos);
    }
    readU8() {
      const value = this.view.getUint8(this.pos);
      this.pos++;
      return value;
    }
    readI8() {
      const value = this.view.getInt8(this.pos);
      this.pos++;
      return value;
    }
    readU16() {
      const value = this.view.getUint16(this.pos);
      this.pos += 2;
      return value;
    }
    readI16() {
      const value = this.view.getInt16(this.pos);
      this.pos += 2;
      return value;
    }
    readU32() {
      const value = this.view.getUint32(this.pos);
      this.pos += 4;
      return value;
    }
    readI32() {
      const value = this.view.getInt32(this.pos);
      this.pos += 4;
      return value;
    }
    readU64() {
      const value = getUint64(this.view, this.pos);
      this.pos += 8;
      return value;
    }
    readI64() {
      const value = getInt64(this.view, this.pos);
      this.pos += 8;
      return value;
    }
    readU64AsBigInt() {
      const value = this.view.getBigUint64(this.pos);
      this.pos += 8;
      return value;
    }
    readI64AsBigInt() {
      const value = this.view.getBigInt64(this.pos);
      this.pos += 8;
      return value;
    }
    readF32() {
      const value = this.view.getFloat32(this.pos);
      this.pos += 4;
      return value;
    }
    readF64() {
      const value = this.view.getFloat64(this.pos);
      this.pos += 8;
      return value;
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/decode.mjs
  function decode(buffer, options) {
    const decoder = new Decoder(options);
    return decoder.decode(buffer);
  }

  // scratch/bundle_input.js
  (function() {
    if (typeof window !== "undefined") {
      window.MessagePack = { decode };
    }
    const generic = {
      id: "generic",
      name: "Generic (Raw Upload)",
      description: "Uploads the selected file as-is, without any parsing. Best for small files.",
      emoji: "\u{1F3AE}",
      defaultIntervalSec: 2,
      files: [
        {
          key: "file1",
          type: "file",
          label: "Game Data File",
          suggestedPath: "(Browse to any game data or save file)",
          description: "Select the game file you want to make available to viewers."
        }
      ]
    };
    const guildRun = {
      id: "guild-run",
      name: "Guild Run",
      description: "Monitors your Guild Run save directory to automatically detect and stream your active run save (`Run`).",
      emoji: "\u{1F6E1}\uFE0F",
      defaultIntervalSec: 2,
      files: [
        {
          key: "data",
          type: "directory",
          label: "Guild Run Save Directory",
          suggestedPath: "C:\\Users\\<user>\\AppData\\LocalLow\\Leyline\\Guildrun\\Saves\\steam-<id>",
          description: "Select your steam save directory (`C:\\Users\\...\\AppData\\LocalLow\\Leyline\\Guildrun\\Saves\\steam-...`). The profile automatically detects the `Run` save file."
        }
      ],
      async processDirectory(fileKey, dirItem) {
        if (!dirItem) return null;

        // NOTE FOR FUTURE MAINTAINERS & DEVELOPERS:
        // 1. SCHEMA VERSIONING: Always increment BridgeSchemaVersion (e.g. '1.1.0') when modifying or adding schema keys.
        // 2. BACKWARDS COMPATIBILITY: In the future, once the updated Twitch extension overlay code (v1.1.0+) is 100% deployed
        //    in production to all viewers, we can change the status string to distinguish "no_active_run" (Profile found, no Run file)
        //    vs "no_file_found" (no save files found at all). Currently, we keep status as "no_file_found" to guarantee 100%
        //    backwards compatibility with older extension overlay builds.
        const createNoRunPayload = (profileDto = null) => JSON.stringify({
          BridgeSchemaVersion: "1.1.0",
          status: "no_file_found",
          message: "No active run file found",
          ProfileDto: profileDto
        });

        let runFile = null;
        let profileFile = null;

        try {
          if (dirItem.type === "directory" && dirItem.handle) {
            try {
              const runHandle = await dirItem.handle.getFileHandle("Run");
              runFile = await runHandle.getFile();
            } catch {}
            try {
              const profileHandle = await dirItem.handle.getFileHandle("Profile");
              profileFile = await profileHandle.getFile();
            } catch {}
          } else if (dirItem.type === "directory-entry" && dirItem.entry) {
            try {
              const entries = await new Promise((resolve) => {
                const dirReader = dirItem.entry.createReader();
                dirReader.readEntries((res) => resolve(res || []), () => resolve([]));
              });
              const runEntry = entries.find((e) => e.isFile && e.name === "Run");
              const profileEntry = entries.find((e) => e.isFile && e.name === "Profile");
              if (runEntry) {
                runFile = await new Promise((res) => runEntry.file((f) => res(f), () => res(null)));
              }
              if (profileEntry) {
                profileFile = await new Promise((res) => profileEntry.file((f) => res(f), () => res(null)));
              }
            } catch {}
          } else if (dirItem.type === "directory-fallback" && Array.isArray(dirItem.allFiles)) {
            runFile = dirItem.allFiles.find((f) => f.name === "Run") || null;
            profileFile = dirItem.allFiles.find((f) => f.name === "Profile") || null;
          } else if (dirItem.file || dirItem.name) {
            if (dirItem.name === "Run" || dirItem.file?.name === "Run") {
              runFile = dirItem.file || dirItem;
            } else if (dirItem.name === "Profile" || dirItem.file?.name === "Profile") {
              profileFile = dirItem.file || dirItem;
            }
          }
        } catch {}

        const decodeFunc = typeof MessagePack !== "undefined" && typeof MessagePack.decode === "function" ? MessagePack.decode : typeof window !== "undefined" && window.MessagePack && window.MessagePack.decode;

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
                if (guid && guid !== "00000000-0000-0000-0000-000000000000") {
                  currentStreak++;
                } else {
                  break;
                }
              }

              let bestStreak = 0;
              let tempStreak = 0;
              for (let i = 0; i < history.length; i++) {
                const guid = history[i];
                if (guid && guid !== "00000000-0000-0000-0000-000000000000") {
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
            console.warn("[GuildRun] Error parsing Profile file:", pErr);
          }
          return null;
        }

        const profileDto = await parseProfileDto(profileFile);

        if (!runFile) {
          return { content: createNoRunPayload(profileDto), fileName: "No Active Run" };
        }

        try {
          const buffer = await runFile.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binaryStr = "";
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
                    BridgeSchemaVersion: "1.1.0",
                    Version: root.Version,
                    ScopeIndex: root.ScopeIndex,
                    DifficultyIndex: root.DifficultyIndex,
                    IsChallengeModeEnabled: root.IsChallengeModeEnabled,
                    ...payload,
                    ProfileDto: profileDto
                  }),
                  fileName: "Run"
                };
              }
            } catch {}
          }
          return { content: binaryStr, fileName: "Run" };
        } catch (err) {
          const isLockError = err.name === "NotReadableError" || err.name === "NotAllowedError" || err.name === "SecurityError";
          if (isLockError) throw err;
          return { content: createNoRunPayload(profileDto), fileName: "No Active Run" };
        }
      },
    };
    const sliceAndDice = {
      id: "slice-and-dice",
      name: "Slice & Dice (In Progress / Not Working)",
      description: "\u26A0\uFE0F IN PROGRESS \u2014 NOT CURRENTLY WORKING. Slice & Dice data parsing is under active development.",
      emoji: "\u{1F3B2}",
      defaultIntervalSec: 2,
      files: [
        {
          key: "data",
          type: "directory",
          label: "Slice & Dice Directory",
          suggestedPath: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Slice_n_Dice",
          description: "Select the `Slice_n_Dice` folder. The game profile will automatically select and process `xsrvc.dll` (or backup save files)."
        }
      ],
      async processDirectory(fileKey, dirItem) {
        if (!dirItem) return null;
        let file = null;
        if (dirItem.type === "directory") {
          try {
            const handle = await dirItem.handle.getFileHandle("xsrvc.dll");
            file = await handle.getFile();
          } catch {
            try {
              const handle = await dirItem.handle.getFileHandle("xsrvcx.dll");
              file = await handle.getFile();
            } catch {
            }
          }
        } else if (dirItem.type === "directory-entry" && dirItem.entry) {
          try {
            const entries = await new Promise((resolve) => {
              const dirReader = dirItem.entry.createReader();
              dirReader.readEntries((res) => resolve(res || []), () => resolve([]));
            });
            let targetEntry = entries.find((e) => e.isFile && e.name.toLowerCase() === "xsrvc.dll") || entries.find((e) => e.isFile && e.name.toLowerCase() === "xsrvcx.dll");
            if (targetEntry) {
              file = await new Promise((res) => targetEntry.file((f) => res(f), () => res(null)));
            }
          } catch {
          }
        } else if (dirItem.type === "file-handle" && dirItem.handle) {
          try {
            file = await dirItem.handle.getFile();
          } catch {
          }
        } else if (dirItem.type === "directory-fallback" && Array.isArray(dirItem.allFiles)) {
          file = dirItem.allFiles.find((f) => f.name.toLowerCase() === "xsrvc.dll") || dirItem.allFiles.find((f) => f.name.toLowerCase() === "xsrvcx.dll") || dirItem.file;
        } else if (dirItem.file || dirItem.name) {
          file = dirItem.file || dirItem;
        }
        if (!file) return null;
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binaryStr = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        if (typeof parseSliceAndDiceData === "function") {
          return {
            content: parseSliceAndDiceData(binaryStr),
            fileName: file.name
          };
        }
        return {
          content: binaryStr,
          fileName: file.name
        };
      }
    };
    window.TLGDB_GAMES = [
      sliceAndDice,
      guildRun,
      generic
    ];
  })();
})();
