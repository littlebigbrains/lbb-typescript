// The stable hash of the data plane: BLAKE3 over parts, each part followed
// by a zero byte, cut to 16 bytes (`lbb_core::stable_hash_hex`). The data
// plane builds deterministic ids and keys with it (a review item's key, a
// request id); a worker that files the same items needs the same hash. The
// BLAKE3 here is the plain hash of the reference implementation, for inputs
// of any length, in one pass: no keyed mode, no extended output.

const IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
const PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

function g(
  s: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  y: number,
) {
  s[a] = (s[a]! + s[b]! + x) >>> 0;
  s[d] = rotr(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotr(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]! + y) >>> 0;
  s[d] = rotr(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotr(s[b]! ^ s[c]!, 7);
}

/** The compression function: 16 words of output. */
function compress(
  cv: Uint32Array,
  block: Uint32Array,
  counter: number,
  blockLen: number,
  flags: number,
): Uint32Array {
  const s = new Uint32Array(16);
  s.set(cv, 0);
  s.set(IV.slice(0, 4), 8);
  s[12] = counter >>> 0;
  s[13] = Math.floor(counter / 0x1_0000_0000) >>> 0;
  s[14] = blockLen;
  s[15] = flags;
  let m = Uint32Array.from(block);
  for (let round = 0; round < 7; round++) {
    g(s, 0, 4, 8, 12, m[0]!, m[1]!);
    g(s, 1, 5, 9, 13, m[2]!, m[3]!);
    g(s, 2, 6, 10, 14, m[4]!, m[5]!);
    g(s, 3, 7, 11, 15, m[6]!, m[7]!);
    g(s, 0, 5, 10, 15, m[8]!, m[9]!);
    g(s, 1, 6, 11, 12, m[10]!, m[11]!);
    g(s, 2, 7, 8, 13, m[12]!, m[13]!);
    g(s, 3, 4, 9, 14, m[14]!, m[15]!);
    if (round < 6) m = Uint32Array.from(PERMUTATION, (i) => m[i]!);
  }
  for (let i = 0; i < 8; i++) {
    s[i] = (s[i]! ^ s[i + 8]!) >>> 0;
    s[i + 8] = (s[i + 8]! ^ cv[i]!) >>> 0;
  }
  return s;
}

/** A block of up to 64 bytes as 16 little-endian words, zero padded. */
function words(bytes: Uint8Array): Uint32Array {
  const out = new Uint32Array(16);
  for (let i = 0; i < bytes.length; i++)
    out[i >> 2]! |= bytes[i]! << ((i & 3) * 8);
  for (let i = 0; i < 16; i++) out[i] = out[i]! >>> 0;
  return out;
}

/** What a node puts out before the caller decides whether it is the root. */
interface Output {
  cv: Uint32Array;
  block: Uint32Array;
  counter: number;
  blockLen: number;
  flags: number;
}

const chainingValue = (o: Output) =>
  compress(o.cv, o.block, o.counter, o.blockLen, o.flags).slice(0, 8);

/** The output of one chunk (at most 1,024 bytes) with its number. */
function chunkOutput(chunk: Uint8Array, counter: number): Output {
  let cv = Uint32Array.from(IV);
  const blocks = Math.max(1, Math.ceil(chunk.length / BLOCK_LEN));
  for (let b = 0; b < blocks - 1; b++)
    cv = compress(
      cv,
      words(chunk.subarray(b * BLOCK_LEN, (b + 1) * BLOCK_LEN)),
      counter,
      BLOCK_LEN,
      b === 0 ? CHUNK_START : 0,
    ).slice(0, 8);
  const last = chunk.subarray((blocks - 1) * BLOCK_LEN);
  return {
    cv,
    block: words(last),
    counter,
    blockLen: last.length,
    flags: (blocks === 1 ? CHUNK_START : 0) | CHUNK_END,
  };
}

function parentOutput(left: Uint32Array, right: Uint32Array): Output {
  const block = new Uint32Array(16);
  block.set(left, 0);
  block.set(right, 8);
  return {
    cv: Uint32Array.from(IV),
    block,
    counter: 0,
    blockLen: BLOCK_LEN,
    flags: PARENT,
  };
}

/** The 32-byte BLAKE3 hash of `input`. */
export function blake3(input: Uint8Array): Uint8Array {
  const chunks = Math.max(1, Math.ceil(input.length / CHUNK_LEN));
  const stack: Uint32Array[] = [];
  for (let i = 0; i < chunks - 1; i++) {
    let cv = chainingValue(
      chunkOutput(input.subarray(i * CHUNK_LEN, (i + 1) * CHUNK_LEN), i),
    );
    // Merge the subtrees this chunk completes: one per trailing zero bit of the count.
    for (let total = i + 1; (total & 1) === 0; total >>= 1)
      cv = chainingValue(parentOutput(stack.pop()!, cv));
    stack.push(cv);
  }
  let output = chunkOutput(
    input.subarray((chunks - 1) * CHUNK_LEN),
    chunks - 1,
  );
  while (stack.length)
    output = parentOutput(stack.pop()!, chainingValue(output));
  const root = compress(
    output.cv,
    output.block,
    0,
    output.blockLen,
    output.flags | ROOT,
  );
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = (root[i >> 2]! >>> ((i & 3) * 8)) & 0xff;
  return out;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The data plane's stable hash of `parts` as 32 hexadecimal characters
 * (`lbb_core::stable_hash_hex`): BLAKE3 over the UTF-8 bytes of each part,
 * each followed by a zero byte, cut to its first 16 bytes. The keys LBB's
 * own workflows give their review items are made with it, so a worker that
 * files the same items under the same keys uses it too:
 *
 * ```ts
 * const key = `starter:${workflow}:value:${stableHashHex([entityId, property, value]).slice(0, 24)}`;
 * ```
 */
export function stableHashHex(parts: readonly string[]): string {
  const encoder = new TextEncoder();
  const encoded = parts.map((part) => encoder.encode(part));
  const input = new Uint8Array(
    encoded.reduce((sum, part) => sum + part.length + 1, 0),
  );
  let at = 0;
  for (const part of encoded) {
    input.set(part, at);
    at += part.length + 1;
  }
  return hex(blake3(input).subarray(0, 16));
}
