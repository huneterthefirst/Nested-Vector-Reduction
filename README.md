# 🦇 NVR — Nested Vector Reduction
*No Vampires Related.*

A small, self-hosted HTTP service that compresses text/JSON into a compact
Base88-encoded string, and decompresses it back — losslessly, with a
built-in integrity check, and now with a choice of compression backends.

---

## What changed in this version

| Area | Before | Now |
|---|---|---|
| **Decode output** | Ran the decompressed string through `JSON.parse` "to look nicer." Silently dropped data whenever the content was valid JSON with duplicate keys (e.g. repeated log-style objects). | Always returns the exact original string, byte for byte. Content is never reinterpreted based on what it looks like. |
| **Tampering / corruption** | Undetectable. Editing a compressed string could produce a different, perfectly plausible-looking decoded result with no signal anything was wrong. | Every payload carries a checksum. Decode reports `"integrity": "verified"` or `"integrity": "mismatch"` (with a warning), so corruption is visible instead of silent. |
| **Method info** | Implicit — decode assumed one fixed algorithm, and adding a second one would have broken old encoded strings. | The method used is embedded in the payload itself. Decode auto-detects it. You can hold onto an encoded string indefinitely and it'll still decode correctly, regardless of which method produced it. |
| **Compression backends** | One custom LZ77 + RLE + JSON-token algorithm. | Five: `nvr`, `gzip`, `brotli`, `deflate`, `store`, plus `auto` (tries all, keeps the smallest). |
| **Truncated input** | A malformed trailing fragment was silently dropped. | Now throws a clear error instead of quietly losing the tail of the data. |
| **Text encoding alphabet** | Custom "Base88" alphabet included 7 characters reserved in URLs (`& = # + % ? ;`). Any client that builds a GET request without explicitly percent-encoding the value — very common (e.g. Roblox's `HttpService`) — got silently corrupted requests whenever one of those characters happened to land in the output. | Switched to standard `base64url` (`A-Z a-z 0-9 - _` only). None of those characters are ever reserved in a URL, so no client, ever, needs to encode them. This isn't a workaround — it makes the whole bug class impossible, not just documented. Slightly larger output (~1.33x expansion vs. ~1.25x before) in exchange for "can never silently corrupt in transit." |
| **Compression at scale** | `gzip`/`brotli`/`deflate` used the `*Sync` zlib functions, which run on Node's single JS thread. On a large payload at high brotli quality this could take multiple **seconds** — during which the entire server was frozen for every other user, not just the one with the big request. The `MAX_CONCURRENT` queue gave a false sense of protection: it can't help with CPU-bound work that blocks the one thread it all runs on. | Switched to the async zlib functions (`gzip`/`brotliCompress`/`deflateRaw`), which hand the work to libuv's thread pool instead of blocking the main thread. Verified directly: 5 trivial requests fired alongside a 2.4MB request went from **~1,800ms each** (stuck waiting) to **~25ms each** (unaffected). |
| **Compression quality vs. size** | Brotli always ran at max quality (11), which takes ~6 seconds on a 2MB+ payload. | Quality now scales down as input grows (11 → 9 → 6) so large payloads stay fast instead of taking seconds, while the common case (small/medium payloads) still gets maximum compression. |
| **Compression ratio at scale** | The `nvr` method never applied any entropy coding — it just tokenized and Base64-encoded the result. Benchmarks showed it losing to brotli by 40%+ on anything past a few hundred bytes. | Added a `hybrid` method: NVR's own tokenizer runs first (domain-specific JSON/repetition wins), then brotli entropy-codes the result. It now beats plain brotli outright on small/structured/repetitive payloads, and closes most of the gap elsewhere. `auto` mode picks it automatically when it wins. |
| **`auto` mode performance** | Tried every method **sequentially**, and included the slow, blocking, hand-rolled tokenizer (twice — once for `nvr`, once inside `hybrid`) even on huge payloads where it can't win anyway. | Candidates now run **concurrently** (`auto` costs roughly "the slowest single method," not "the sum of all of them"), and on payloads over 300KB, `auto` stops considering `nvr`/`hybrid` at all — they're the part that blocks the event loop, and they don't win at that size regardless, so skipping them is a pure win: faster *and* non-blocking. |

The core `nvr` algorithm itself (LZ77 hash-chain matching, run-length
encoding, JSON structural tokens, Base88 packing) is unchanged — it was
already solid. Everything above was in the response-handling layer around
it.

---

## Quick start

```bash
node server.js
# 🦇 NVR Server running at http://<host>:5001
```

Open `http://localhost:5001` in a browser for the web UI, or hit it
programmatically as below.

---

## API

**GET** `/?Attachment=YOUR_DATA&Decode=0&Method=nvr`
**POST** `/` with JSON body `{"Attachment": "...", "Decode": 0, "Method": "nvr"}`

| Field | Required | Notes |
|---|---|---|
| `Attachment` | yes | The string to encode, or the Base88 string to decode. |
| `Decode` | no (default `0`) | `0` = compress/encode. `1` = decompress/decode. |
| `Method` | no (default `nvr`) | Only used when encoding — see below. Ignored (and unnecessary) when decoding, since the method is read from the payload itself. |

### Methods (`Decode=0` only)

| Value | What it does | Good for |
|---|---|---|
| `nvr` *(default)* | Custom LZ77 + RLE + JSON-token compressor, no entropy coding | Very small payloads (roughly under ~150 bytes) where its lower fixed overhead beats gzip/brotli's header cost. Loses to brotli by a wide margin past that. |
| `gzip` | Standard zlib gzip | General-purpose, widely compatible if you ever need to decompress outside NVR. |
| `brotli` | Standard zlib brotli | The strongest general-purpose option in almost every benchmark past ~150 bytes — repetitive text, structured JSON, natural language, all of it. Quality auto-scales down on large inputs to stay fast. |
| `deflate` | Raw DEFLATE, no gzip/zlib framing | Slightly less overhead than gzip for the same algorithm. Usually 2nd place behind brotli. |
| `store` | No compression at all | Baseline/debugging — lets you see the Base64url + checksum overhead in isolation. |
| `hybrid` | NVR's tokenizer, then brotli entropy-codes the result | Small/structured/repetitive JSON — beats plain brotli in several benchmarks by giving it an already-shrunk, more regular stream to work with. |
| `auto` | Tries the methods above, keeps whichever produces the smallest output | Recommended default when you don't know the shape of your data in advance. On payloads over 300KB it skips `nvr`/`hybrid` (see performance notes below) since they don't win at that size and are the one part of this API that isn't fully non-blocking. |

### Benchmark summary (see table below for exact numbers)

Real numbers from testing across tiny strings, short/medium JSON, repetitive
logs, pure repetition, natural language, random noise, and realistic game-save
data:

- **`nvr` wins** only on very small payloads (roughly under 150 bytes) — its ~5-byte header beats gzip/brotli's larger framing overhead at that size.
- **`brotli` wins** almost everywhere else, often by 40%+ over `nvr` alone once payloads get past a couple hundred bytes — it ships with a pre-trained dictionary of common text/JSON/web patterns that a hand-rolled tokenizer can't match.
- **`hybrid` narrows or closes that gap**, and outright beats plain brotli on some structured/repetitive cases, by combining NVR's domain-specific tokenizing with brotli's entropy coding.
- **`auto`** is the practical recommendation for most use cases — it removes the need to know in advance which of the above will win for a given payload.

### Response fields

```json
{
  "success": true,
  "Decode": 0,
  "original_size": 113,
  "output_size": 29,
  "reduction": "74.3%",
  "method": "nvr",
  "result": "04~FTH&.y&VF0|xWnGUbWGVr81XZr"
}
```

On decode (`Decode=1`), two more fields appear:

```json
{
  "...": "...",
  "integrity": "verified",
  "warning": "only present if integrity is \"mismatch\""
}
```

- **`integrity: "verified"`** — the checksum embedded in the payload matches. The result is exactly what was originally encoded.
- **`integrity: "mismatch"`** — the payload was altered or corrupted after encoding (bit-flipped, truncated, hand-edited, etc). NVR still attempts to decode and returns what it gets, so you can debug — but treat the result as untrustworthy when this fires.

---

## Wire format (what's actually inside an encoded string)

```
[ 1 byte  ] method tag        (0=nvr, 1=gzip, 2=brotli, 3=deflate, 4=store)
[ 4 bytes ] Adler-32 checksum of the compressed payload, big-endian
[ N bytes ] compressed payload, per the method above
```
...then the whole thing is encoded with `base64url` (RFC 4648 §5 — the
same URL-safe variant used by JWTs, only `A-Z`, `a-z`, `0-9`, `-`, `_`,
no padding).

This is why decode never needs a `Method` parameter: the string is
self-describing. It also means two encoded strings for the same input
can differ in length depending on which method won — that's expected,
not a bug. And because the output alphabet is fully URL-safe, the
result can always be dropped straight into a query string with zero
encoding, by any client, in any language.

---

## Known behavior / limitations

- **Short or non-repetitive input tends to expand, not shrink**, on the `nvr`
  method — there's a fixed ~5-byte header plus base64url's inherent ~1.33x
  expansion. This is normal for basically any compression scheme; `gzip`
  has the same shape of overhead, just a bigger constant.
- **`nvr` and `hybrid` are synchronous, CPU-bound JavaScript** with no
  thread-offload path (unlike `gzip`/`brotli`/`deflate`, which run on
  libuv's thread pool and don't block anything else). Expect roughly
  ~350ms of blocking time per MB of input when using them explicitly on
  large payloads. `auto` mode protects you from this automatically by
  excluding them once a payload crosses 300KB — but if you explicitly
  request `Method=nvr` or `Method=hybrid` on a multi-MB payload, that
  request (and only that request, since it happens inside the queued task)
  will take a while and briefly hold up the event loop while its
  synchronous portion runs.
- **No encryption.** The checksum detects accidental corruption and
  intentional tampering, but it does not hide or authenticate the data —
  anyone with the encoded string can decode it. Don't use this as a
  security boundary.
- **Rate limits / caps:** up to 50 requests processed concurrently (rest
  queue, cap 200), 30 requests / 10s per IP, 150 requests / 10s per
  subnet, 5MB request body max.

---

## Testing it yourself

```bash
# Encode
curl -s -G "http://localhost:5001/" \
  --data-urlencode 'Attachment=Hello, World!' \
  --data-urlencode "Decode=0"

# Decode (paste the "result" value back in — no Method needed)
curl -s -G "http://localhost:5001/" \
  --data-urlencode 'Attachment=PASTE_RESULT_HERE' \
  --data-urlencode "Decode=1"
```

For anything with special characters in your **input** data (`{`, `}`, `!`,
`#`, `&`, etc.), always use `curl -G --data-urlencode` rather than
hand-building the query string — it handles escaping for you and avoids
both shell history-expansion issues (bash treats a bare `!` specially even
in double quotes) and URL-encoding mistakes. The **output** (the encoded
`result` value) no longer needs any of this — base64url is safe to drop
straight into a URL unencoded.

### Roblox / Lua example

```lua
local HttpService = game:GetService("HttpService")

-- Encoding: POST is the most robust option since it sidesteps query-string
-- construction entirely.
local function nvrEncode(text)
    local response = HttpService:PostAsync(
        "http://YOUR_SERVER:5001/",
        HttpService:JSONEncode({ Attachment = text, Decode = 0 }),
        Enum.HttpContentType.ApplicationJson
    )
    return HttpService:JSONDecode(response).result
end

local function nvrDecode(encoded)
    local response = HttpService:PostAsync(
        "http://YOUR_SERVER:5001/",
        HttpService:JSONEncode({ Attachment = encoded, Decode = 1 }),
        Enum.HttpContentType.ApplicationJson
    )
    local parsed = HttpService:JSONDecode(response)
    if parsed.integrity == "mismatch" then
        warn("NVR integrity check failed:", parsed.warning)
    end
    return parsed.result
end
```

If you do need `GetAsync`/GET instead: as of this version the `result`
value is always base64url, so it's safe to concatenate into a query
string directly with no `HttpService:UrlEncode()` needed on the way
*out*. Your **input** data going *in* may still contain characters that
need encoding — encode that side with `HttpService:UrlEncode(text)` before
building the URL, or just use POST and skip the question entirely.
