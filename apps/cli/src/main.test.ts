import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execute = promisify(execFile);
const run = (args: readonly string[]) =>
  execute(process.execPath, ["apps/cli/dist/main.js", ...args], {
    env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: "1" },
  });

test("piped catalog output is JSON even when colors are forced", async () => {
  const { stdout, stderr } = await run(["search", "fixture", "tone"]);
  const parsed: unknown = JSON.parse(stdout);
  expect(parsed).toMatchObject({ items: [{ title: "440 Hz test tone" }] });
  expect(stdout).not.toContain("\x1b");
  expect(stderr).toBe("");
});

test("explicit JSON output keeps track data suitable for scripts", async () => {
  const { stdout, stderr } = await run(["track", "fixture", "tone", "--json"]);
  const parsed: unknown = JSON.parse(stdout);
  expect(parsed).toMatchObject({ ref: { providerId: "fixture", id: "tone" } });
  expect(stderr).toBe("");
});

test("piped operational errors are structured on stderr", async () => {
  const result: unknown = await run(["track", "fixture", "missing"]).catch(
    (error: unknown) => error,
  );
  expect(result).toMatchObject({ code: 1, stdout: "" });
  const stderr =
    result !== null && typeof result === "object" && "stderr" in result ? result.stderr : undefined;
  expect(stderr).toContain('"tag":"not_found"');
});

test.each([
  "auth",
  "providers",
  "search",
  "track",
  "formats",
  "download",
  "accounts",
  "accounts remove",
  "accounts default",
  "accounts provider",
])("%s --help shows contextual help", async (name) => {
  const { stdout, stderr } = await run([...name.split(" "), "--help"]);
  expect(stdout).toContain(`sonory ${name}\n`);
  expect(stdout).not.toContain("Start here\n");
  expect(stderr).toBe("");
});

test.each([
  { args: ["search", "deezer"], text: "Missing query." },
  { args: ["track", "deezer"], text: "Missing track." },
  { args: ["formats", "deezer"], text: "Missing track." },
  { args: ["download", "deezer", "1", "flac"], text: "Missing destination." },
  { args: ["accounts", "remove", "deezer"], text: "Missing account." },
  { args: ["accounts", "default", "deezer"], text: "Missing account." },
  { args: ["accounts", "provider"], text: "Missing provider." },
  { args: ["search", "deezer", "Daft", "Punk"], text: "Put quotes around search text" },
  { args: ["accounts", "--account", "1"], text: "--account is only available" },
  { args: ["auth", "deezer", "--account", "1"], text: "--account is only available" },
  { args: ["track", "deezer", "1", "--cursor", "25"], text: "--cursor is only available" },
  { args: ["search", "deezer", "song", "--cursor", ""], text: "--cursor requires" },
  { args: ["unknown", "--help"], text: "Unknown command" },
  { args: ["accounts", "unknown", "--help"], text: "Unknown accounts command" },
])("$args fails with actionable feedback", async ({ args, text }) => {
  const result: unknown = await run(args).catch((error: unknown) => error);
  expect(result).toMatchObject({ code: 2, stdout: "" });
  const stderr =
    result !== null && typeof result === "object" && "stderr" in result ? result.stderr : undefined;
  expect(stderr).toContain(text);
  expect(stderr).not.toContain("Start here");
});
