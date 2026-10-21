import { test } from "node:test";
import assert from "node:assert/strict";
import { blake3, stableHashHex } from "./hash.js";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// The official BLAKE3 test vectors (input byte i is i % 251), across the
// chunk and tree boundaries.
const VECTORS: [number, string][] = [
  [0, "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"],
  [1023, "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11"],
  [1024, "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7"],
  [1025, "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444"],
  [2049, "5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030"],
  [3073, "7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3"],
  [4097, "9b4052b38f1c5fc8b1f9ff7ac7b27cd242487b3d890d15c96a1c25b8aa0fb995"],
  [8193, "bab6c09cb8ce8cf459261398d2e7aef35700bf488116ceb94a36d0f5f1b7bc3b"],
  [31744, "62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47"],
];

test("blake3 gives the reference hashes across chunk and tree boundaries", () => {
  for (const [length, want] of VECTORS)
    assert.equal(
      hex(blake3(Uint8Array.from({ length }, (_, i) => i % 251))),
      want,
      `${length}`,
    );
  assert.equal(
    hex(blake3(new TextEncoder().encode("abc"))),
    "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  );
});

// `lbb_core::stable_hash_hex` of the same parts, from the data plane (the
// template evals record more: sdk/templates/*/samples/eval/rust-path.json).
test("stableHashHex is the data plane's stable hash: each part ends with a zero byte", () => {
  assert.equal(stableHashHex(["a", "b"]), "55a01d7f389c7df5218c21c17594c483");
  assert.equal(stableHashHex([]), hex(blake3(new Uint8Array(0))).slice(0, 32));
  assert.notEqual(stableHashHex(["ab"]), stableHashHex(["a", "b"]));
  assert.equal(stableHashHex(["Größe"]).length, 32);
});
