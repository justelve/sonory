import { expect, test } from "vitest";

import { decryptChunk, encryptChunk, generateBlowfishKey } from "./crypto.js";

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

// Eric Young's official Blowfish CBC vector from Schneier's test suite.
const CBC_KEY = hex("0123456789ABCDEFF0E1D2C3B4A59687");
const CBC_IV = hex("FEDCBA9876543210");
const CBC_PLAIN = hex("37363534333231204E6F77206973207468652074696D6520666F722000000000");
const CBC_CIPHER = hex("6B77B4D63006DEE605B156E27403979358DEB9E7154616D959F1652BD5FF92CC");

test("decryptChunk recovers the official Blowfish CBC test vector", () => {
  const decrypted = decryptChunk(CBC_CIPHER, CBC_KEY, CBC_IV);
  expect(Buffer.from(decrypted).toString("hex")).toBe(Buffer.from(CBC_PLAIN).toString("hex"));
  expect(Buffer.from(decrypted).toString("ascii")).toBe("7654321 Now is the time for \0\0\0\0");
});

test("encryptChunk reproduces the official Blowfish CBC test vector", () => {
  const encrypted = encryptChunk(CBC_PLAIN, CBC_KEY, CBC_IV);
  expect(Buffer.from(encrypted).toString("hex").toUpperCase()).toBe(
    Buffer.from(CBC_CIPHER).toString("hex").toUpperCase(),
  );
});

test("decryptChunk and encryptChunk round-trip arbitrary chunk sizes", () => {
  const key = generateBlowfishKey("3135556");
  const plain = Uint8Array.from({ length: 8192 }, (_, index) => (index * 7 + 3) & 0xff);
  for (const length of [8, 512, 2048, 8192]) {
    const encrypted = encryptChunk(plain.subarray(0, length), key);
    expect(Buffer.from(decryptChunk(encrypted, key)).equals(plain.subarray(0, length))).toBe(true);
  }
});

test("chunks must align to the block size and the IV must span 8 bytes", () => {
  const key = generateBlowfishKey("3135556");
  expect(() => decryptChunk(Uint8Array.of(1, 2, 3), key)).toThrow(RangeError);
  expect(() => decryptChunk(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), key, Uint8Array.of(1))).toThrow(
    RangeError,
  );
});

test("generateBlowfishKey derives Deezer per-track keys", () => {
  expect(Buffer.from(generateBlowfishKey("3135556")).toString("hex")).toBe(
    "6c6c666b39662c37652575603c643439",
  );
  expect(Buffer.from(generateBlowfishKey("123456789")).toString("hex")).toBe(
    "6d34656061377f31322a7336393f626b",
  );
});

test("generateBlowfishKey returns a 16-byte printable key", () => {
  const key = generateBlowfishKey("42");
  expect(key).toHaveLength(16);
  expect(key.every((byte) => byte >= 0x20 && byte <= 0x7e)).toBe(true);
});
