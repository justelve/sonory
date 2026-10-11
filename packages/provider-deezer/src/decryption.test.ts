import { expect, test } from "vitest";
import { okAsync } from "neverthrow";
import type { Result, ResultAsync } from "neverthrow";

import type { DownloadSource, ProviderOperationError } from "@sonory/provider-sdk";

import { encryptChunk, generateBlowfishKey } from "./crypto.js";
import { decryptDownloadSource } from "./decryption.js";

const TRACK_ID = "3135556";

// Reproduces Deezer's wire format: zero padding on the front so the length is a
// multiple of 2048, and the first 2048 bytes of every 6144-byte segment encrypted.
function stripeEncrypt(plaintext: Uint8Array, trackId: string): Uint8Array {
  const padding = (2048 - (plaintext.length % 2048)) % 2048;
  const padded = new Uint8Array(padding + plaintext.length);
  padded.set(plaintext, padding);
  const key = generateBlowfishKey(trackId);
  const encrypted = Uint8Array.from(padded);
  for (let offset = 0; offset + 2048 <= encrypted.length; offset += 6144) {
    encrypted.set(encryptChunk(encrypted.subarray(offset, offset + 2048), key), offset);
  }
  return encrypted;
}

function byteSource(
  bytes: Uint8Array,
  sizes: readonly number[],
  contentLength: number = bytes.length,
): DownloadSource {
  let offset = 0;
  let index = 0;
  let closed = false;
  return {
    format: { id: "MP3_128", extension: "mp3", mediaType: "audio/mpeg", encrypted: true },
    contentLength,
    stream: {
      read(): ResultAsync<Uint8Array | null, ProviderOperationError> {
        if (closed) return okAsync(null);
        if (offset >= bytes.length) return okAsync(null);
        const size = Math.min(sizes[index++ % sizes.length] ?? 1, bytes.length - offset);
        const chunk = bytes.subarray(offset, offset + size);
        offset += size;
        return okAsync(chunk);
      },
      close() {
        closed = true;
        return okAsync(undefined);
      },
    },
  };
}

function makePlain(length: number, offset: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 7 + offset * 13 + 3) & 0xff);
}

async function collect(source: DownloadSource): Promise<Uint8Array> {
  const received: number[] = [];
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Consume chunks in stream order.
    const chunk = await source.stream.read();
    if (chunk.isErr()) throw chunk.error;
    if (chunk.value === null) return Uint8Array.from(received);
    received.push(...chunk.value);
  }
}

test.each([
  { length: 6144, label: "exactly one stripe" },
  { length: 9144, label: "tail of 3000 bytes mixes decryption and passthrough" },
  { length: 6096, label: "short tail passes through without decryption" },
  { length: 0, label: "empty payloads end immediately" },
])("decrypts Deezer streams with $label", async ({ length }) => {
  const plain = makePlain(length, 1);
  const cipher = stripeEncrypt(plain, TRACK_ID);
  const source = decryptDownloadSource(
    byteSource(cipher, [1, 2, 6143, 5, 2047, 4096, 10000]),
    TRACK_ID,
  );
  expect(await collect(source)).toEqual(plain);
  expect(source.format).toEqual({
    id: "MP3_128",
    extension: "mp3",
    mediaType: "audio/mpeg",
    encrypted: false,
  });
  expect(source.contentLength).toBeUndefined();
});

test("large streams decrypt in large single chunks without byte loss", async () => {
  const plain = makePlain(6144 * 4 + 2048 * 2, 2);
  const cipher = stripeEncrypt(plain, TRACK_ID);
  const source = decryptDownloadSource(byteSource(cipher, [cipher.length]), TRACK_ID);
  expect(await collect(source)).toEqual(plain);
});

test("leading zero padding is stripped from the first decrypted chunk", async () => {
  const plain = makePlain(3000, 3);
  const source = decryptDownloadSource(
    byteSource(stripeEncrypt(plain, TRACK_ID), [8192]),
    TRACK_ID,
  );
  const output = await collect(source);
  expect(output.length).toBe(plain.length);
  expect(output).toEqual(plain);
});

test("an MP4 header beginning with zero bytes is not stripped", async () => {
  const plain = new Uint8Array(6144);
  plain.set([0, 0, 0, 24]);
  plain.set([0x66, 0x74, 0x79, 0x70], 4);
  for (let index = 8; index < plain.length; index++) plain[index] = index & 0xff;
  const source = decryptDownloadSource(
    byteSource(stripeEncrypt(plain, TRACK_ID), [6144]),
    TRACK_ID,
  );
  expect(await collect(source)).toEqual(plain);
});

test("truncated encrypted streams report an incomplete download", async () => {
  const cipher = stripeEncrypt(makePlain(9144, 4), TRACK_ID);
  const source = decryptDownloadSource(
    byteSource(cipher.subarray(0, 4096), [1024], cipher.length),
    TRACK_ID,
  );
  const results: Array<Result<Uint8Array | null, ProviderOperationError>> = [];
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Consume chunks in stream order.
    const chunk = await source.stream.read();
    results.push(chunk);
    if (chunk.isErr() || chunk.value === null) break;
  }
  const last = results.at(-1);
  expect(last?.isErr()).toBe(true);
  const error = last?.isErr() === true ? last.error : undefined;
  expect(error?.tag).toBe("incomplete_download");
  expect(error?.message).toBe(`Expected ${cipher.length} encrypted bytes, received 4096.`);
  expect(results.filter((result) => result.isOk() && result.value !== null)).toHaveLength(1);
});

test("sources without encrypted formats pass through untouched", () => {
  const source: DownloadSource = {
    format: { id: "MP3_128", extension: "mp3", mediaType: "audio/mpeg" },
    contentLength: 8,
    stream: { read: () => okAsync(null), close: () => okAsync(undefined) },
  };
  expect(decryptDownloadSource(source, TRACK_ID)).toBe(source);
});

test("read failures from the underlying stream propagate unchanged", async () => {
  const source = decryptDownloadSource(
    {
      format: { id: "FLAC", extension: "flac", mediaType: "audio/flac", encrypted: true },
      stream: {
        read: () => {
          throw new Error("transport died");
        },
        close: () => okAsync(undefined),
      },
    },
    TRACK_ID,
  );
  const chunk = await source.stream.read();
  expect(chunk._unsafeUnwrapErr().tag).toBe("provider_failure");
});
