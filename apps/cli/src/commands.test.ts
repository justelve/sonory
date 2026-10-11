import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderRegistry } from "@sonory/core";
import { createFixtureProvider } from "@sonory/provider-fixture";
import { createDeezerProvider } from "@sonory/provider-deezer";
import { expect, test } from "vitest";
import { vi } from "vitest";

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
    expect(download._unsafeUnwrap()).toBe(`Downloaded ${target}`);
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
