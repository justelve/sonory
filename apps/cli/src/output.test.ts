import { stripVTControlCharacters } from "node:util";

import type { Track } from "@sonory/provider-sdk";
import { expect, test } from "vitest";

import { jsonOutput, renderError, renderOutput } from "./output.js";

const human = { json: false, columns: 80, color: false };
const track: Track = {
  ref: { providerId: "deezer", id: "42" },
  title: "A song",
  artists: ["Artist"],
  album: "Album",
  durationMs: 185000,
};

test("human search renders useful columns and duration", () => {
  const result = renderOutput({ type: "search", value: { items: [track] } }, human);
  expect(result).toContain("A song");
  expect(result).toContain("Artist");
  expect(result).toContain("42");
  expect(result).toContain("3:05");
  expect(result).toBe(stripVTControlCharacters(result));
});

test("long titles wrap within the terminal width", () => {
  const result = renderOutput(
    { type: "search", value: { items: [{ ...track, title: "A long song title ".repeat(30) }] } },
    human,
  );
  expect(result).toContain("A long song");
  expect(result.split("\n").every((line) => line.length <= human.columns)).toBe(true);
});

test("narrow terminals show labelled rows", () => {
  const result = renderOutput(
    { type: "search", value: { items: [track] } },
    { ...human, columns: 40 },
  );
  expect(result).toContain("Title: A song");
  expect(result).toContain("Track ID: 42");
  expect(result).not.toContain("┌");
});

test("terminal metadata cannot inject escape sequences, lines, or control bytes", () => {
  const unsafe = { ...track, title: "Song\x1b[2J\x1b]8;;https://example.com\x07Title\n\t\x00" };
  const result = renderOutput({ type: "track", value: unsafe }, human);
  expect(result).not.toContain("\x1b");
  expect(result).not.toContain("\x00");
  expect(result.split("\n")[0]).toContain("SongTitle");
  const json = renderOutput({ type: "track", value: unsafe }, jsonOutput);
  const parsed: unknown = JSON.parse(json);
  expect(parsed).toEqual(unsafe);
});

test("JSON output preserves catalog shape without presentation fields", () => {
  const value = { items: [track], nextCursor: "25" };
  const parsed: unknown = JSON.parse(renderOutput({ type: "search", value }, jsonOutput));
  expect(parsed).toEqual(value);
});

test("account table marks both default types", () => {
  const result = renderOutput(
    {
      type: "accounts",
      value: {
        version: 1,
        accounts: [{ providerId: "deezer", id: "1", displayName: "Listener" }],
        defaultAccounts: { deezer: "1" },
        defaultProviderId: "deezer",
      },
    },
    human,
  );
  expect(result).toContain("Listener");
  expect(result).toContain("Default provider\n  deezer");
  expect(result).toContain("Selected");
  expect(result).toContain("Provider");
});

test("empty results provide an actionable message", () => {
  expect(
    renderOutput(
      { type: "accounts", value: { version: 1, accounts: [], defaultAccounts: {} } },
      human,
    ),
  ).toContain("sonory auth");
  expect(renderOutput({ type: "search", value: { items: [] } }, human)).toContain(
    "Try a different search",
  );
  expect(renderOutput({ type: "formats", value: [] }, human)).toContain("No download formats");
});

test("format lists include meaningful quality information", () => {
  const result = renderOutput(
    {
      type: "formats",
      value: [
        {
          id: "flac",
          extension: "flac",
          mediaType: "audio/flac",
          lossless: true,
          sampleRateHz: 44100,
          bitDepth: 16,
        },
      ],
    },
    human,
  );
  expect(result).toContain("Lossless");
  expect(result).toContain("44.1 kHz");
  expect(result).toContain("16-bit");
});

test("errors retain a machine-readable tag and offer account-selection help", () => {
  const error = { tag: "account_selection_required", message: "Choose an account." };
  expect(renderError(error, false, false)).toContain("--account <id>");
  const parsed: unknown = JSON.parse(renderError(error, true, false));
  expect(parsed).toEqual({ error });
});
