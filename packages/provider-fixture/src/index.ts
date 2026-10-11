import { setTimeout } from "node:timers/promises";

import { TaggedError } from "@sonory/provider-sdk";
import type { AudioFormat, Provider, Track } from "@sonory/provider-sdk";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { z } from "zod";

const track: Track = {
  ref: { providerId: "fixture", id: "tone" },
  title: "440 Hz test tone",
  artists: ["Sonory"],
  durationMs: 2000,
};
const format: AudioFormat = {
  id: "wav",
  extension: "wav",
  mediaType: "audio/wav",
  lossless: true,
  sampleRateHz: 16000,
  bitDepth: 16,
};
const searchSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.undefined().optional(),
});

function tone(): Buffer {
  const samples = 32000;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) {
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * sample) / 16000) * 4096),
      44 + sample * 2,
    );
  }
  return data;
}

export function createFixtureProvider(): Provider {
  const data = tone();
  return {
    id: "fixture",
    name: "Local fixture",
    version: "0.0.0",
    apiVersion: 1,
    catalog: {
      search(request) {
        const parsed = searchSchema.safeParse(request);
        if (!parsed.success)
          return errAsync(
            new TaggedError("invalid_input", "Invalid fixture search.", { cause: parsed.error }),
          );
        const query = parsed.data.query.toLowerCase();
        const matches = `${track.title} ${track.artists.join(" ")}`.toLowerCase().includes(query);
        return okAsync({ items: matches ? [track] : [] });
      },
      getTrack(id) {
        return id === track.ref.id
          ? okAsync(track)
          : errAsync(new TaggedError("not_found", `Unknown fixture track "${id}".`));
      },
    },
    download: {
      listFormats(id) {
        return id === track.ref.id
          ? okAsync([format])
          : errAsync(new TaggedError("not_found", `Unknown fixture track "${id}".`));
      },
      open(id, formatId, context) {
        if (id !== track.ref.id)
          return errAsync(new TaggedError("not_found", `Unknown fixture track "${id}".`));
        if (formatId !== format.id)
          return errAsync(
            new TaggedError("invalid_input", `Unknown fixture format "${formatId}".`),
          );
        let offset = 0;
        let closed = false;
        return okAsync({
          format,
          contentLength: data.length,
          stream: {
            read() {
              if (closed)
                return errAsync(new TaggedError("unavailable", "Fixture stream is closed."));
              // Pace chunks so Ctrl+C can exercise cancellation without a network service.
              return ResultAsync.fromPromise(
                setTimeout(25, undefined, { signal: context.signal }),
                (cause) => new TaggedError("cancelled", "Fixture read was cancelled.", { cause }),
              ).map(() => {
                if (closed || offset >= data.length) return null;
                const chunk = data.subarray(offset, offset + 4096);
                offset += chunk.length;
                return chunk;
              });
            },
            close() {
              closed = true;
              return okAsync(undefined);
            },
          },
        });
      },
    },
  };
}
