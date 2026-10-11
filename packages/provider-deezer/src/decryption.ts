import { TaggedError } from "@sonory/provider-sdk";
import type { DownloadSource, DownloadStream, ProviderOperationError } from "@sonory/provider-sdk";
import { err, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";

import { decryptChunk, generateBlowfishKey } from "./crypto.js";

// Deezer encrypts the first 2048 bytes of every 6144-byte segment and left-pads
// the stream with zero bytes so its length is a multiple of 2048.
const SEGMENT = 2048;
const STRIPE = 3 * SEGMENT;

export function decryptDownloadSource(source: DownloadSource, trackId: string): DownloadSource {
  if (source.format.encrypted !== true) return source;
  const key = generateBlowfishKey(trackId);
  const expected = source.contentLength;
  let queue: Uint8Array[] = [];
  let start = 0;
  let queued = 0;
  let consumed = 0;
  let ended = false;
  let stripped = false;

  function take(length: number): Uint8Array | undefined {
    if (queued < length) return undefined;
    const output = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const head = queue[start];
      if (head === undefined) break;
      const remaining = length - filled;
      if (head.length <= remaining) {
        output.set(head, filled);
        filled += head.length;
        start += 1;
        queued -= head.length;
      } else {
        output.set(head.subarray(0, remaining), filled);
        queue[start] = head.subarray(remaining);
        queued -= remaining;
        filled = length;
      }
    }
    if (start > 64) {
      queue = queue.slice(start);
      start = 0;
    }
    return output;
  }

  // Decrypts the leading 2048-byte block of a segment and keeps the rest as-is.
  function decryptSegment(segment: Uint8Array): Uint8Array {
    const decrypted = decryptChunk(segment.subarray(0, SEGMENT), key);
    if (segment.length === SEGMENT) return decrypted;
    const output = new Uint8Array(segment.length);
    output.set(decrypted);
    output.set(segment.subarray(SEGMENT), SEGMENT);
    return output;
  }

  function produce(): Uint8Array | undefined {
    const stripe = take(STRIPE);
    if (stripe !== undefined) return decryptSegment(stripe);
    if (!ended) return undefined;
    const rest = take(queued);
    if (rest === undefined || rest.length === 0) return undefined;
    if (rest.length >= SEGMENT) return decryptSegment(rest);
    return rest;
  }

  // Removes the zero padding Deezer prepends, unless the chunk starts a "ftyp"
  // MP4 header whose zero bytes are real content.
  function stripPadding(chunk: Uint8Array): Uint8Array {
    stripped = true;
    if ((chunk[0] ?? 1) !== 0) return chunk;
    const marker = String.fromCharCode(chunk[4] ?? 0, chunk[5] ?? 0, chunk[6] ?? 0, chunk[7] ?? 0);
    if (marker === "ftyp") return chunk;
    let index = 0;
    while (index < chunk.length && (chunk[index] ?? 1) === 0) index++;
    return chunk.subarray(index);
  }

  const stream: DownloadStream = {
    read() {
      return ResultAsync.fromPromise(
        Promise.resolve().then(
          async (): Promise<Result<Uint8Array | null, ProviderOperationError>> => {
            while (true) {
              const output = produce();
              if (output !== undefined) {
                return ok(stripped ? output : stripPadding(output));
              }
              if (ended) {
                if (expected !== undefined && consumed !== expected) {
                  return err(
                    new TaggedError(
                      "incomplete_download",
                      `Expected ${expected} encrypted bytes, received ${consumed}.`,
                    ),
                  );
                }
                return ok(null);
              }
              // Stream decryption must wait for each chunk before producing output.
              // oxlint-disable-next-line eslint/no-await-in-loop -- Read only after producing the previous chunk.
              const chunk = await source.stream.read();
              if (chunk.isErr()) return err(chunk.error);
              if (chunk.value === null) {
                ended = true;
                continue;
              }
              consumed += chunk.value.byteLength;
              queue.push(chunk.value);
              queued += chunk.value.byteLength;
            }
          },
        ),
        (cause) =>
          new TaggedError("provider_failure", "Decryption failed unexpectedly.", { cause }),
      ).andThen((result) => result);
    },
    close() {
      queue = [];
      start = 0;
      queued = 0;
      return source.stream.close();
    },
  };

  return {
    format: { ...source.format, encrypted: false },
    stream,
  };
}
