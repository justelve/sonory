import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderRegistry } from "@sonory/core";
import { createFixtureProvider } from "@sonory/provider-fixture";
import { createDeezerProvider } from "@sonory/provider-deezer";
import { okAsync } from "neverthrow";
import { expect, test } from "vitest";
import { vi } from "vitest";
import type { OperationContext } from "@sonory/provider-sdk";

import { parseCommand, runCommand } from "./commands.js";

function setup() {
  const registry = new ProviderRegistry();
  expect(registry.register(createFixtureProvider()).isOk()).toBe(true);
  return registry;
}

test("fixture search, formats, and download produce a valid PCM WAV", async () => {
  const registry = setup();
  const search = await runCommand(
    registry,
    parseCommand(["search", "fixture", "tone"])._unsafeUnwrap(),
  );
  expect(search._unsafeUnwrap()).toContain('"id": "tone"');
  const track = await runCommand(
    registry,
    parseCommand(["track", "fixture", "tone"])._unsafeUnwrap(),
  );
  expect(track._unsafeUnwrap()).toContain('"title": "440 Hz test tone"');
  const formats = await runCommand(
    registry,
    parseCommand(["formats", "fixture", "tone"])._unsafeUnwrap(),
  );
  expect(formats._unsafeUnwrap()).toContain('"mediaType": "audio/wav"');
  const directory = await mkdtemp(join(tmpdir(), "sonory-cli-"));
  try {
    const target = join(directory, "tone.wav");
    const download = await runCommand(
      registry,
      parseCommand(["download", "fixture", "tone", "wav", target])._unsafeUnwrap(),
    );
    expect(JSON.parse(download._unsafeUnwrap())).toEqual({ path: target });
    const wav = await readFile(target);
    expect(wav.length).toBe(64044);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(await readdir(directory)).toEqual(["tone.wav"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(
  [
    [],
    ["unknown"],
    ["search", "fixture"],
    ["formats", "fixture", "tone", "extra"],
    ["download", "fixture", "tone", "wav", ""],
  ].map((args) => ({ args })),
)("invalid command arguments return usage: $args", ({ args }) => {
  expect(parseCommand(args)._unsafeUnwrapErr().tag).toBe("invalid_input");
});

test("unknown providers, tracks, and formats preserve tagged errors", async () => {
  const registry = setup();
  expect((await runCommand(registry, ["search", "missing", "tone"]))._unsafeUnwrapErr().tag).toBe(
    "unknown_provider",
  );
  expect(
    (await runCommand(registry, ["formats", "fixture", "missing"]))._unsafeUnwrapErr().tag,
  ).toBe("not_found");
  expect(
    (await registry.openDownload({ providerId: "fixture", id: "tone" }, "mp3"))._unsafeUnwrapErr()
      .tag,
  ).toBe("invalid_input");
});

test("fixture search filters tracks and rejects unsupported cursors", async () => {
  const registry = setup();
  expect((await registry.search("fixture", { query: "absent" }))._unsafeUnwrap().items).toEqual([]);
  expect(
    (await registry.search("fixture", { query: "tone", cursor: "invalid" }))._unsafeUnwrapErr().tag,
  ).toBe("invalid_input");
});

test("auth dispatch returns account identity without credentials", async () => {
  const registry = new ProviderRegistry();
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      Response.json({ error: [], results: { USER: { USER_ID: 42, BLOG_NAME: "Listener" } } }),
    ),
  );
  expect(registry.register(createDeezerProvider(fetch)).isOk()).toBe(true);
  const result = await runCommand(
    registry,
    parseCommand(["auth", "deezer"])._unsafeUnwrap(),
    {},
    { arl: "a".repeat(192) },
  );
  expect(result._unsafeUnwrap()).toBe(
    JSON.stringify({ id: "42", displayName: "Listener" }, null, 2),
  );
});

test("search cursor is passed to the provider", async () => {
  const registry = setup();
  const search = vi.spyOn(registry, "search").mockReturnValue(okAsync({ items: [] }));
  (await runCommand(registry, ["search", "fixture", "tone", "25"]))._unsafeUnwrap();
  expect(search).toHaveBeenCalledWith("fixture", { query: "tone", cursor: "25" }, {});
});

test("Deezer formats dispatch uses the signed-in session and returns JSON metadata", async () => {
  const registry = new ProviderRegistry();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        error: [],
        results: {
          USER: { USER_ID: 42, OPTIONS: { license_token: "private-license" } },
          checkForm: "private-csrf",
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        error: [],
        results: {
          SNG_ID: "3135556",
          TRACK_TOKEN: "private-track",
          FILESIZE_MP3_128: "1000",
          FILESIZE_MP3_320: "0",
          FILESIZE_FLAC: "0",
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: [
          {
            media: [
              {
                media_type: "FULL",
                format: "MP3_128",
                sources: [{ url: "https://cdn.deezer.com/private-audio" }],
              },
            ],
          },
        ],
      }),
    );
  registry.register(createDeezerProvider(fetch))._unsafeUnwrap();
  const result = (
    await runCommand(registry, ["formats", "deezer", "3135556"], {
      session: {
        account: { id: "42", displayName: "Listener" },
        credentials: { arl: "a".repeat(192) },
      },
    })
  )._unsafeUnwrap();
  expect(JSON.parse(result)).toEqual([
    {
      id: "MP3_128",
      extension: "mp3",
      mediaType: "audio/mpeg",
      lossless: false,
      bitrateKbps: 128,
      encrypted: true,
    },
  ]);
  expect(result).not.toContain("private-");
  expect(registry.list()[0]?.capabilities).toEqual(["auth", "catalog", "formats", "download"]);
});

test.each(["complete", "truncated", "cancelled"] as const)(
  "encrypted Deezer download %s exercises file publication and cleanup",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "sonory-deezer-download-"));
    try {
      const registry = new ProviderRegistry();
      const controller = new AbortController();
      const context: OperationContext = {
        signal: controller.signal,
        session: {
          account: { id: "42", displayName: "Listener" },
          credentials: { arl: "a".repeat(192) },
        },
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          Response.json({
            error: [],
            results: {
              USER: { USER_ID: 42, OPTIONS: { license_token: "private-license" } },
              checkForm: "private-csrf",
            },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            error: [],
            results: {
              SNG_ID: "3135556",
              TRACK_TOKEN: "private-track",
              FILESIZE_MP3_128: "4",
              FILESIZE_MP3_320: "0",
              FILESIZE_FLAC: "0",
            },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            data: [
              {
                media: [
                  {
                    media_type: "FULL",
                    format: "MP3_128",
                    sources: [{ url: "https://cdn.deezer.com/private-audio" }],
                  },
                ],
              },
            ],
          }),
        )
        .mockImplementationOnce(() => {
          let first = true;
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(stream) {
                  if (first) {
                    first = false;
                    stream.enqueue(Uint8Array.of(255, 0));
                  } else {
                    if (mode === "complete") stream.enqueue(Uint8Array.of(254, 128));
                    if (mode === "cancelled") controller.abort();
                    stream.close();
                  }
                },
              }),
              { headers: { "Content-Length": "4" } },
            ),
          );
        });
      registry.register(createDeezerProvider(fetch))._unsafeUnwrap();
      const target = join(directory, "track.MP3_128.encrypted");
      const result = await runCommand(
        registry,
        ["download", "deezer", "3135556", "MP3_128", target],
        context,
      );
      const outcome = result.match(
        (value) => {
          const receipt: unknown = JSON.parse(value);
          return receipt;
        },
        (error) => ({ error: error.tag }),
      );
      expect(outcome).toEqual(
        mode === "complete"
          ? { path: target }
          : {
              error: mode === "cancelled" ? "cancelled" : "incomplete_download",
            },
      );
      expect(await readdir(directory)).toEqual(
        mode === "complete" ? ["track.MP3_128.encrypted"] : [],
      );
      const bytes = mode === "complete" ? await readFile(target) : null;
      expect(bytes).toEqual(mode === "complete" ? Buffer.from([255, 0, 254, 128]) : null);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
