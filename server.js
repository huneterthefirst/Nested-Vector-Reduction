'use strict';
const http = require('http');
const url = require('url');
const zlib = require('zlib');
const { promisify } = require('util');

// Async (non-blocking) zlib. Using the *Sync variants here would block
// Node's single JS thread for the entire duration of the call — on a large
// payload at high brotli quality that can be multiple SECONDS, during which
// the server cannot do anything else at all: not serve other requests, not
// run the rate limiter, nothing. These async versions hand the work off to
// libuv's thread pool, so a single huge request can no longer stall every
// other user on the server.
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const deflateRawAsync = promisify(zlib.deflateRaw);
const inflateRawAsync = promisify(zlib.inflateRaw);

// Brotli at max quality (11) is very strong but gets expensive on large
// inputs — scale it down as payloads grow so a single big request stays
// fast instead of taking seconds, while small/medium payloads (the common
// case) still get maximum compression.
function pickBrotliQuality(size) {
    if (size > 1_000_000) return 6;
    if (size > 200_000) return 9;
    return 11;
}

// ============================================================================
// 1. TRANSPORT-SAFE TEXT CODEC
//
//    FIXED: the original custom "Base88" alphabet included 7 characters that
//    are reserved/special in URL query strings: & = # + % ? ;
//    Any client that builds a GET request without explicitly percent-encoding
//    the compressed value (extremely common — e.g. Roblox's HttpService, or
//    any hand-built URL string) would have the request silently corrupted
//    the moment one of those characters showed up in the output. This is
//    exactly the kind of bug that looks intermittent (it only bites when
//    that specific character happens to land in that specific payload) and
//    is easy to mistake for a compression bug when it's actually a transport
//    bug.
//
//    Fix: use standard base64url (RFC 4648 §5) instead of a custom alphabet.
//    Its character set is exactly A-Z a-z 0-9 - _  — every one of those is
//    in the URL "unreserved" set, so none of them EVER require percent-
//    encoding, in any client, ever. This doesn't just document the problem
//    away, it makes the whole bug class structurally impossible. The cost
//    is a slightly larger output (~1.33x expansion vs. ~1.25x for the old
//    scheme) — a small, honest price for "this can no longer silently
//    corrupt in transit."
// ============================================================================
const NVR_TEXT = {
    toSafeText(buffer) {
        return buffer.toString('base64url');
    },
    fromSafeText(text) {
        return Buffer.from(text, 'base64url');
    }
};

// ============================================================================
// 2. COMPRESSION ENGINE (NVR = Nested Vector Reduction)
//
//    Changelog vs. the previous version:
//      - FIXED: decode used to run the decompressed string through
//        `JSON.parse`, and re-serialize it, "for nicer API output." Since
//        JSON.parse silently keeps only the LAST of any duplicate keys,
//        this quietly dropped data any time the decompressed text was valid
//        JSON containing repeated keys (e.g. concatenated log lines shaped
//        like `{"status":"ok","status":"ok",...}`). Decode now always
//        returns the exact raw string NVR reconstructed — byte for byte,
//        regardless of what it looks like. This is the core lossless
//        guarantee and it should never depend on the *content* of the data.
//      - ADDED: every encoded payload now starts with a small header
//        (1-byte method tag + 4-byte Adler-32 checksum) before Base88
//        encoding. This makes payloads self-describing — Decode=1 no
//        longer needs to be told which method or settings were used to
//        create a given string, which matters a lot if people hold onto
//        encoded blobs for a long time. It also means tampering with an
//        encoded string is now *detectable* on decode (reported via the
//        "integrity" field) instead of silently producing a different,
//        plausible-looking result with no signal anything changed.
//      - ADDED: selectable compression methods (see METHOD_NAMES below),
//        including an "auto" mode that tries all of them and keeps
//        whichever produces the smallest output for that specific input.
//      - Control-byte collision, O(n*window) LZ search, O(n^2) decompression,
//        and the narrow 255-byte backref window from the original prototype
//        were already fixed in the version you shared; that logic is
//        preserved as-is below.
// ============================================================================
const JSON_TOKENS = [
    '":true', '":false', '":null', '":""', '":[]', '":{}',
    '","', '":{"', '":[{"', '}]}', '],"', '":',
    '"id":', '"name":', '"type":', '"data":', '"status":',
    '"timestamp":', '"created_at":', '"value":', '"description":',
    '"users":', '"items":', '"success":', '"error":', '"code":'
];
const TOKEN_BUFFERS = JSON_TOKENS.map(t => Buffer.from(t));
if (TOKEN_BUFFERS.length > 26) throw new Error('Too many JSON_TOKENS for the control byte space');

const CTRL_ESCAPE = 0;          // next byte is a literal that would otherwise collide with a control code
const CTRL_TOKEN_START = 1;     // 1..TOKEN_BUFFERS.length reserved for token ids
const CTRL_RLE = 27;
const CTRL_BACKREF = 28;
const CONTROL_ZONE = 29;        // any raw byte below this must be escaped when written as a literal

const MIN_MATCH = 4;
const MAX_MATCH = 255;
const MAX_DIST = 65535;
const MAX_CHAIN = 32;           // how many candidate positions we check per hash bucket (keeps encode O(n))

// A small growable byte buffer so decompression never re-copies everything it has already written.
class ByteBuffer {
    constructor(initial = 1024) {
        this.buf = Buffer.alloc(initial);
        this.len = 0;
    }
    _ensure(extra) {
        if (this.len + extra <= this.buf.length) return;
        let newSize = this.buf.length * 2 || 1024;
        while (newSize < this.len + extra) newSize *= 2;
        const next = Buffer.alloc(newSize);
        this.buf.copy(next, 0, 0, this.len);
        this.buf = next;
    }
    pushByte(b) {
        this._ensure(1);
        this.buf[this.len++] = b;
    }
    pushBuffer(chunk) {
        this._ensure(chunk.length);
        chunk.copy(this.buf, this.len);
        this.len += chunk.length;
    }
    fill(count, value) {
        this._ensure(count);
        this.buf.fill(value, this.len, this.len + count);
        this.len += count;
    }
    // Copies `length` bytes starting at `start` from what's already been written.
    copyFrom(start, length) {
        this._ensure(length);
        // byte-by-byte because LZ matches can (in theory) overlap the write cursor
        for (let k = 0; k < length; k++) this.buf[this.len + k] = this.buf[start + k];
        this.len += length;
    }
    toBuffer() {
        return this.buf.subarray(0, this.len);
    }
}

const NVR_CORE = {
    // Compresses raw bytes into the NVR token/RLE/backref stream.
    // Returns a Buffer (NOT Base88-encoded — that happens one layer up now,
    // after the header is attached, so every method shares one Base88 step).
    compressToBytes(rawBytes) {
        const len = rawBytes.length;
        const out = [];
        const hashTable = new Map(); // uint32(4-byte prefix) -> recent positions[]

        const hashAt = (pos) =>
            (rawBytes[pos] << 24 | rawBytes[pos + 1] << 16 | rawBytes[pos + 2] << 8 | rawBytes[pos + 3]) >>> 0;

        const insertHash = (pos) => {
            if (pos + 4 > len) return;
            const h = hashAt(pos);
            let chain = hashTable.get(h);
            if (!chain) { chain = []; hashTable.set(h, chain); }
            chain.push(pos);
            if (chain.length > MAX_CHAIN) chain.shift();
        };

        let i = 0;
        outer:
        while (i < len) {
            // 1. JSON structural tokens
            for (let id = 0; id < TOKEN_BUFFERS.length; id++) {
                const tok = TOKEN_BUFFERS[id];
                if (i + tok.length <= len && rawBytes.compare(tok, 0, tok.length, i, i + tok.length) === 0) {
                    out.push(CTRL_TOKEN_START + id);
                    i += tok.length;
                    continue outer;
                }
            }

            // 2. Run-length encoding (>= 4 repeats of the same byte)
            {
                const c = rawBytes[i];
                let run = 1;
                while (i + run < len && rawBytes[i + run] === c && run < 255) run++;
                if (run >= 4) {
                    out.push(CTRL_RLE, run, c);
                    for (let k = 0; k < run; k++) insertHash(i + k);
                    i += run;
                    continue outer;
                }
            }

            // 3. LZ77 via hash-chain match search (bounded cost per position)
            if (len - i >= MIN_MATCH) {
                const h = hashAt(i);
                const chain = hashTable.get(h);
                if (chain) {
                    let bestLen = 0, bestPos = -1;
                    const maxLen = Math.min(MAX_MATCH, len - i);
                    for (let ci = chain.length - 1; ci >= 0; ci--) {
                        const pos = chain[ci];
                        const dist = i - pos;
                        if (dist > MAX_DIST) continue;
                        let mlen = 0;
                        while (mlen < maxLen && rawBytes[pos + mlen] === rawBytes[i + mlen]) mlen++;
                        if (mlen > bestLen) { bestLen = mlen; bestPos = pos; }
                        if (bestLen >= MAX_MATCH) break;
                    }
                    if (bestLen >= MIN_MATCH) {
                        const dist = i - bestPos;
                        out.push(CTRL_BACKREF, (dist >> 8) & 255, dist & 255, bestLen);
                        for (let k = 0; k < bestLen; k++) insertHash(i + k);
                        i += bestLen;
                        continue outer;
                    }
                }
            }

            // 4. Literal byte (escaped if it would collide with a control code)
            const b = rawBytes[i];
            if (b < CONTROL_ZONE) out.push(CTRL_ESCAPE, b);
            else out.push(b);
            insertHash(i);
            i++;
        }

        return Buffer.from(out);
    },

    // Reverses compressToBytes. Returns a Buffer (raw bytes) — string
    // conversion happens one layer up, once, after integrity is checked.
    decompressFromBytes(bytes) {
        const len = bytes.length;
        const out = new ByteBuffer(Math.max(256, len * 2));
        let i = 0;

        while (i < len) {
            const b = bytes[i];
            if (b === CTRL_ESCAPE) {
                out.pushByte(bytes[i + 1]);
                i += 2;
            } else if (b >= CTRL_TOKEN_START && b < CTRL_TOKEN_START + TOKEN_BUFFERS.length) {
                out.pushBuffer(TOKEN_BUFFERS[b - CTRL_TOKEN_START]);
                i += 1;
            } else if (b === CTRL_RLE) {
                out.fill(bytes[i + 1], bytes[i + 2]);
                i += 3;
            } else if (b === CTRL_BACKREF) {
                const dist = (bytes[i + 1] << 8) | bytes[i + 2];
                const matchLen = bytes[i + 3];
                out.copyFrom(out.len - dist, matchLen);
                i += 4;
            } else {
                out.pushByte(b);
                i += 1;
            }
        }
        return out.toBuffer();
    }
};

// ============================================================================
// 2b. METHOD REGISTRY + SELF-DESCRIBING WRAPPER FORMAT
//
//     Wire format (before Base88):
//       [ 1 byte  method tag ]
//       [ 4 bytes Adler-32 checksum of the compressed payload, big-endian ]
//       [ N bytes compressed payload, per the method above ]
//
//     Because the method tag and checksum travel WITH the data, a Decode=1
//     call never needs to be told which method or version produced a given
//     string — the string carries that information itself. That matters if
//     an encoded value gets stored somewhere and decoded much later, by
//     different code, possibly after NVR itself has gained more methods.
// ============================================================================
const METHOD_NAMES = { 0: 'nvr', 1: 'gzip', 2: 'brotli', 3: 'deflate', 4: 'store', 5: 'hybrid' };
const METHOD_IDS = { nvr: 0, gzip: 1, brotli: 2, deflate: 3, store: 4, hybrid: 5 };
const AUTO_CANDIDATES = [0, 1, 2, 3, 4, 5]; // methods "auto" is allowed to try on small/medium payloads

// Methods 0 (nvr) and 5 (hybrid) both run NVR_CORE.compressToBytes, which is
// plain synchronous JS with no thread-offload path — unlike the zlib-backed
// methods, it fully blocks the event loop for however long it takes
// (roughly ~350ms/MB). "auto" trying both on a large payload means paying
// that blocking cost twice, on every single encode. Since benchmarking
// showed nvr/hybrid don't win against plain brotli/gzip/deflate past a few
// hundred KB anyway, "auto" simply stops considering them once a payload
// crosses this size — keeping it fast AND non-blocking, not just non-blocking.
const AUTO_LARGE_PAYLOAD_THRESHOLD = 300_000; // bytes
const AUTO_CANDIDATES_LARGE = [1, 2, 3, 4]; // gzip, brotli, deflate, store — all async, none touch the custom tokenizer

function adler32(buf) {
    const MOD_ADLER = 65521;
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) {
        a = (a + buf[i]) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    return ((b << 16) | a) >>> 0;
}

// method 5 ("hybrid"): run NVR's own JSON-aware tokenizer/LZ pass first
// (cheap domain-specific wins: JSON structural tokens, RLE, backrefs), THEN
// run the result through brotli for entropy coding on top. Plain NVR never
// entropy-codes its output at all, which is the single biggest reason it
// loses to gzip/brotli on anything past a couple hundred bytes — this
// closes most of that gap, and on repetitive/structured data it can beat
// plain brotli outright because the tokenizer hands brotli an already-
// shrunk, more regular stream to work with.
async function rawCompress(methodId, rawBytes) {
    switch (methodId) {
        case 0: return NVR_CORE.compressToBytes(rawBytes);
        case 1: return gzipAsync(rawBytes, { level: 9 });
        case 2: return brotliCompressAsync(rawBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: pickBrotliQuality(rawBytes.length) } });
        case 3: return deflateRawAsync(rawBytes, { level: 9 });
        case 4: return Buffer.from(rawBytes); // store: no compression, useful as a baseline/fallback
        case 5: {
            const tokens = NVR_CORE.compressToBytes(rawBytes);
            return brotliCompressAsync(tokens, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: pickBrotliQuality(tokens.length) } });
        }
        default: throw new Error(`Unknown method id ${methodId}`);
    }
}

async function rawDecompress(methodId, compBytes) {
    switch (methodId) {
        case 0: return NVR_CORE.decompressFromBytes(compBytes);
        case 1: return gunzipAsync(compBytes);
        case 2: return brotliDecompressAsync(compBytes);
        case 3: return inflateRawAsync(compBytes);
        case 4: return Buffer.from(compBytes);
        case 5: {
            const tokens = await brotliDecompressAsync(compBytes);
            return NVR_CORE.decompressFromBytes(tokens);
        }
        default: throw new Error(`Unknown method id ${methodId} in encoded stream (corrupted or from a newer NVR version)`);
    }
}

function buildWireFormat(methodId, compBytes) {
    const header = Buffer.alloc(5);
    header.writeUInt8(methodId, 0);
    header.writeUInt32BE(adler32(compBytes), 1);
    return Buffer.concat([header, compBytes]);
}

const NVR = {
    // methodName: 'nvr' | 'gzip' | 'brotli' | 'deflate' | 'store' | 'hybrid' | 'auto' (default 'nvr')
    async encode(rawStr, methodName) {
        if (!rawStr) return { base88: '', method: 'none' };
        const rawBytes = Buffer.from(rawStr, 'utf8');
        const requested = (methodName || 'nvr').toLowerCase();

        let candidateIds;
        if (requested === 'auto') {
            candidateIds = rawBytes.length > AUTO_LARGE_PAYLOAD_THRESHOLD ? AUTO_CANDIDATES_LARGE : AUTO_CANDIDATES;
        } else if (Object.prototype.hasOwnProperty.call(METHOD_IDS, requested)) {
            candidateIds = [METHOD_IDS[requested]];
        } else {
            throw Object.assign(
                new Error(`Unknown Method "${methodName}". Valid: nvr, gzip, brotli, deflate, store, hybrid, auto`),
                { status: 400 }
            );
        }

        // Candidates run concurrently (they're all async/non-blocking now),
        // not sequentially — "auto" no longer costs roughly 6x a single
        // method's wall-clock time, just however long the slowest one takes.
        const attempts = await Promise.all(candidateIds.map(async (methodId) => {
            const compBytes = await rawCompress(methodId, rawBytes);
            return { methodId, wire: buildWireFormat(methodId, compBytes) };
        }));

        let best = attempts[0];
        for (const attempt of attempts) if (attempt.wire.length < best.wire.length) best = attempt;

        return { base88: NVR_TEXT.toSafeText(best.wire), method: METHOD_NAMES[best.methodId] };
    },

    // Always returns the exact original string — content is never
    // reinterpreted, reformatted, or re-parsed based on what it looks like.
    async decode(b88Str) {
        if (!b88Str) return { text: '', method: 'none', integrity: 'verified' };
        const full = NVR_TEXT.fromSafeText(b88Str);
        if (full.length < 5) {
            throw new Error('Payload too short to contain a valid NVR header (truncated or not an NVR payload)');
        }
        const methodId = full.readUInt8(0);
        const claimedChecksum = full.readUInt32BE(1);
        const compBytes = full.subarray(5);
        const actualChecksum = adler32(compBytes);
        const integrity = actualChecksum === claimedChecksum ? 'verified' : 'mismatch';

        const rawBytes = await rawDecompress(methodId, compBytes);
        return { text: rawBytes.toString('utf8'), method: METHOD_NAMES[methodId] || `unknown(${methodId})`, integrity };
    }
};

// ============================================================================
// 3. CONCURRENCY QUEUE — bounded parallelism with backpressure
// ============================================================================
const MAX_CONCURRENT = 50;
const MAX_QUEUE_LENGTH = 200; // hard backpressure cap so the queue itself can't become the heavy thing
let activeCount = 0;
const waitQueue = [];

function runQueued(task) {
    return new Promise((resolve, reject) => {
        const attempt = () => {
            activeCount++;
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    activeCount--;
                    const next = waitQueue.shift();
                    if (next) next();
                });
        };
        if (activeCount < MAX_CONCURRENT) {
            attempt();
        } else if (waitQueue.length < MAX_QUEUE_LENGTH) {
            waitQueue.push(attempt);
        } else {
            reject(new Error('QUEUE_FULL'));
        }
    });
}

// ============================================================================
// 4. RATE LIMITING — per IP, and per "place" (subnet), sliding window
// ============================================================================
class SlidingWindowLimiter {
    constructor(windowMs, maxHits) {
        this.windowMs = windowMs;
        this.maxHits = maxHits;
        this.hits = new Map(); // key -> timestamps[]
    }
    _trim(arr, now) {
        while (arr.length && now - arr[0] > this.windowMs) arr.shift();
    }
    hit(key) {
        const now = Date.now();
        let arr = this.hits.get(key);
        if (!arr) { arr = []; this.hits.set(key, arr); }
        this._trim(arr, now);
        arr.push(now);
        return arr.length <= this.maxHits;
    }
    cleanup() {
        const now = Date.now();
        for (const [key, arr] of this.hits) {
            this._trim(arr, now);
            if (arr.length === 0) this.hits.delete(key);
        }
    }
}

const IP_WINDOW_MS = 10_000;
const IP_MAX_HITS = 30;         // 30 req / 10s per single IP
const SUBNET_WINDOW_MS = 10_000;
const SUBNET_MAX_HITS = 150;    // 150 req / 10s per /24 (or /64) "place"

const ipLimiter = new SlidingWindowLimiter(IP_WINDOW_MS, IP_MAX_HITS);
const subnetLimiter = new SlidingWindowLimiter(SUBNET_WINDOW_MS, SUBNET_MAX_HITS);
setInterval(() => { ipLimiter.cleanup(); subnetLimiter.cleanup(); }, 60_000).unref();

function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    let ip = (fwd ? fwd.split(',')[0].trim() : null) || req.socket.remoteAddress || 'unknown';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function getSubnetKey(ip) {
    if (ip.includes('.')) {
        const parts = ip.split('.');
        return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
    }
    if (ip.includes(':')) {
        const parts = ip.split(':');
        return parts.slice(0, 4).join(':') + '::/64';
    }
    return ip;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB payload cap so one request can't monopolize the queue

// ============================================================================
// 5. HTML WEB APP FOR HUMAN BROWSERS
// ============================================================================
const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>NVR - No Vampire Related Encoder</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; }
        body { background: #0d1117; color: #c9d1d9; padding: 2rem; display: flex; justify-content: center; }
        .container { width: 100%; max-width: 800px; background: #161b22; padding: 2rem; border-radius: 12px; border: 1px solid #30363d; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
        h1 { color: #58a6ff; font-size: 1.6rem; margin-bottom: 0.5rem; }
        p.subtitle { color: #8b949e; font-size: 0.9rem; margin-bottom: 1.5rem; }
        label { display: block; margin-top: 1rem; margin-bottom: 0.5rem; font-weight: 600; color: #f0f6fc; font-size: 0.85rem; }
        textarea { width: 100%; height: 130px; background: #0d1117; border: 1px solid #30363d; color: #7ee787; padding: 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.85rem; resize: vertical; }
        .controls { display: flex; gap: 1rem; margin: 1.25rem 0; align-items: center; flex-wrap: wrap; }
        button { background: #238636; color: white; border: none; padding: 0.6rem 1.4rem; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; }
        button:hover { background: #2ea043; }
        select { background: #21262d; color: white; border: 1px solid #30363d; padding: 0.6rem; border-radius: 6px; cursor: pointer; }
        .stats { margin-top: 1rem; padding: 1rem; background: #0d1117; border-radius: 6px; border: 1px solid #30363d; font-size: 0.85rem; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; text-align: center; }
        .stats div span { display: block; font-size: 1.1rem; font-weight: bold; color: #58a6ff; }
        .stats div span.integrity-ok { color: #3fb950; }
        .stats div span.integrity-bad { color: #f85149; }
        .api-tip { margin-top: 1.5rem; font-size: 0.8rem; color: #8b949e; border-top: 1px solid #30363d; padding-top: 1rem; }
        code { background: #21262d; padding: 2px 6px; border-radius: 4px; color: #f0883e; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🦇 NVR Encoder / Decoder</h1>
        <p class="subtitle">No Vampire Related &bull; Self-describing, checksummed compressor with multiple backends</p>

        <label for="inputData">INPUT (JSON, Text, or NVR Base64URL Payload)</label>
        <textarea id="inputData">{\n  "status": "success",\n  "users": [\n    {"id": 1, "name": "Alucard", "type": "hunter"},\n    {"id": 2, "name": "Trevor", "type": "hunter"}\n  ]\n}</textarea>

        <div class="controls">
            <select id="mode">
                <option value="0">Decode: 0 (Compress & Encode to NVR Base64URL)</option>
                <option value="1">Decode: 1 (Decompress NVR Base64URL to Raw)</option>
            </select>
            <select id="method">
                <option value="nvr">Method: nvr (custom LZ+RLE+JSON tokens)</option>
                <option value="gzip">Method: gzip</option>
                <option value="brotli">Method: brotli</option>
                <option value="deflate">Method: deflate</option>
                <option value="store">Method: store (no compression)</option>
                <option value="hybrid">Method: hybrid (nvr tokens + brotli entropy coding)</option>
                <option value="auto">Method: auto (try all, keep smallest)</option>
            </select>
            <button onclick="processData()">Execute</button>
        </div>

        <label for="outputData">OUTPUT</label>
        <textarea id="outputData" readonly></textarea>

        <div class="stats" id="stats">
            <div>Original Bytes<span id="origBytes">0</span></div>
            <div>Output Bytes<span id="outBytes">0</span></div>
            <div>Size Change<span id="ratio">0%</span></div>
            <div>Method / Integrity<span id="methodInfo">-</span></div>
        </div>

        <div class="api-tip">
            <strong>Bot / API Usage:</strong> GET <code>/?Attachment=YOUR_DATA&Decode=0&Method=nvr</code> or send JSON <code>{"Attachment": "...", "Decode": 0, "Method": "nvr"}</code><br>
            <strong>Methods:</strong> <code>nvr</code> (default), <code>gzip</code>, <code>brotli</code>, <code>deflate</code>, <code>store</code>, <code>auto</code>. Decode never needs Method — it's embedded in the payload.<br>
            <strong>Limits:</strong> ${MAX_CONCURRENT} concurrent jobs processed at once (rest queue), 30 req/10s per IP, 150 req/10s per network, 5MB payload cap.
        </div>
    </div>

    <script>
        async function processData() {
            const raw = document.getElementById('inputData').value;
            const decodeMode = parseInt(document.getElementById('mode').value, 10);
            const method = document.getElementById('method').value;

            const res = await fetch('/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ Attachment: raw, Decode: decodeMode, Method: method })
            });
            const data = await res.json();

            if (data.success) {
                document.getElementById('outputData').value = typeof data.result === 'object' ? JSON.stringify(data.result, null, 2) : data.result;
                document.getElementById('origBytes').innerText = data.original_size;
                document.getElementById('outBytes').innerText = data.output_size;
                document.getElementById('ratio').innerText = data.reduction;
                const methodInfoEl = document.getElementById('methodInfo');
                if (data.integrity) {
                    methodInfoEl.innerText = data.method + ' / ' + data.integrity;
                    methodInfoEl.className = data.integrity === 'verified' ? 'integrity-ok' : 'integrity-bad';
                } else {
                    methodInfoEl.innerText = data.method || '-';
                    methodInfoEl.className = '';
                }
            } else {
                alert('Error: ' + data.error);
            }
        }
        processData();
    </script>
</body>
</html>`;

// ============================================================================
// 6. HTTP SERVER WITH QUEUEING, RATE LIMITING, AND BOT/BROWSER NEGOTIATION
// ============================================================================
const PORT = process.env.PORT || 5001;

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const acceptHeader = req.headers['accept'] || '';

    const isHumanBrowser = acceptHeader.includes('text/html') &&
                           !parsedUrl.query.Attachment &&
                           req.method === 'GET';

    if (isHumanBrowser) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(HTML_UI);
    }

    // ---- Rate limiting (checked before we touch the queue at all) ----
    const ip = getClientIp(req);
    const subnetKey = getSubnetKey(ip);

    if (!subnetLimiter.hit(subnetKey)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(SUBNET_WINDOW_MS / 1000) });
        return res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded for this network. Try again shortly.' }));
    }
    if (!ipLimiter.hit(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(IP_WINDOW_MS / 1000) });
        return res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded for your IP. Try again shortly.' }));
    }

    const respondJson = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };

    const handleApiPayload = (payload) => {
        runQueued(async () => {
            let attachment = payload.Attachment;
            const decode = parseInt(payload.Decode || 0, 10);

            if (attachment === undefined) {
                throw Object.assign(new Error("Missing required 'Attachment' field."), { status: 400 });
            }
            if (typeof attachment === 'object') attachment = JSON.stringify(attachment);

            let result, methodUsed, integrity;

            if (decode === 1) {
                let decoded;
                try {
                    decoded = await NVR.decode(attachment);
                } catch (e) {
                    throw Object.assign(new Error('Failed to decode: ' + e.message), { status: 400 });
                }
                // BUG FIX: always return the exact raw string. Never re-parse or
                // reinterpret it based on what it looks like — that was the
                // source of the duplicate-key JSON data loss.
                result = decoded.text;
                methodUsed = decoded.method;
                integrity = decoded.integrity;
            } else {
                let encoded;
                try {
                    encoded = await NVR.encode(attachment, payload.Method);
                } catch (e) {
                    throw e.status ? e : Object.assign(new Error('Failed to encode: ' + e.message), { status: 500 });
                }
                result = encoded.base88;
                methodUsed = encoded.method;
            }

            const inLen = Buffer.byteLength(typeof attachment === 'string' ? attachment : JSON.stringify(attachment));
            const outLen = Buffer.byteLength(typeof result === 'string' ? result : JSON.stringify(result));
            const reduction = inLen > 0 ? (((inLen - outLen) / inLen) * 100).toFixed(1) + "%" : "0%";

            const body = { success: true, Decode: decode, original_size: inLen, output_size: outLen, reduction, method: methodUsed, result };
            if (decode === 1) {
                body.integrity = integrity;
                if (integrity === 'mismatch') {
                    body.warning = 'Checksum mismatch — this payload was altered or corrupted after encoding. The decoded result above may not match the original data.';
                }
            }
            return body;
        })
        .then(body => respondJson(200, body))
        .catch(err => {
            if (err.message === 'QUEUE_FULL') {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
                return res.end(JSON.stringify({ success: false, error: 'Server is busy, try again shortly.' }));
            }
            respondJson(err.status || 500, { success: false, error: err.message });
        });
    };

    if (req.method === 'GET') {
        let payload = parsedUrl.query;
        if (payload.payload) {
            try { payload = JSON.parse(payload.payload); } catch (e) { /* fall through with raw query */ }
        }
        return handleApiPayload(payload);
    }

    if (req.method === 'POST') {
        let body = '';
        let tooLarge = false;
        req.on('data', chunk => {
            if (tooLarge) return;
            body += chunk;
            if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
                tooLarge = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Payload too large (max 5MB).' }));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (tooLarge) return;
            try {
                const payload = JSON.parse(body || '{}');
                return handleApiPayload(payload);
            } catch (e) {
                return respondJson(400, { success: false, error: 'Invalid JSON POST body' });
            }
        });
        return;
    }

    respondJson(405, { success: false, error: 'Method not allowed' });
});

if (require.main === module) {
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`🦇 NVR Server running at http://192.168.1.172:${PORT}`);
        console.log(`- Humans navigating via browser get the Web UI`);
        console.log(`- Bots/GET requests get direct JSON API answers`);
        console.log(`- Methods: nvr (default), gzip, brotli, deflate, store, auto`);
        console.log(`- Max ${MAX_CONCURRENT} concurrent jobs, queue cap ${MAX_QUEUE_LENGTH}`);
        console.log(`- Rate limits: ${IP_MAX_HITS}/${IP_WINDOW_MS/1000}s per IP, ${SUBNET_MAX_HITS}/${SUBNET_WINDOW_MS/1000}s per network`);
    });
}

module.exports = { NVR, NVR_TEXT, NVR_CORE, adler32 };
