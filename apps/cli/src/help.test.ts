import { expect, test } from "vitest";

import { parseCommand } from "./commands.js";
import { argumentHint, renderHelp } from "./help.js";

test("root help gives an overview without mixing in provider-specific instructions", () => {
  const text = renderHelp();
  expect(text).toContain("Commands\n");
  expect(text).toContain("Start here\n");
  expect(text).not.toContain("ARL");
  expect(text).not.toContain("credential store");
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
])("%s help is scoped to that command", (name) => {
  const text = renderHelp(name.split(" "));
  expect(text).toContain(`sonory ${name}\n`);
  expect(text).toContain("Usage\n");
  expect(text).toContain("Example\n");
  expect(text).not.toContain("Start here\n");
});

test.each([
  { args: ["search"], missing: "provider" },
  { args: ["search", "deezer"], missing: "query" },
  { args: ["track", "deezer"], missing: "track" },
  { args: ["formats", "deezer"], missing: "track" },
  { args: ["download", "deezer"], missing: "track" },
  { args: ["accounts", "remove", "deezer"], missing: "account" },
  { args: ["accounts", "default", "deezer"], missing: "account" },
  { args: ["accounts", "provider"], missing: "provider" },
])("missing $missing is identified for $args", ({ args, missing }) => {
  expect(parseCommand(args)._unsafeUnwrapErr().message).toBe(`Missing ${missing}.`);
  expect(argumentHint(args)).toContain("--help for details");
  expect(argumentHint(args)).not.toContain("Commands\n");
});

test("unquoted queries explain how to correct extra arguments", () => {
  expect(
    parseCommand(["search", "deezer", "Daft", "Punk", "extra"])._unsafeUnwrapErr().message,
  ).toContain("Put quotes around search text");
});

test("account and provider IDs are explained in their relevant help", () => {
  expect(renderHelp(["accounts", "remove"])).toContain("Account ID shown by sonory accounts");
  expect(renderHelp(["auth"])).toContain("signed-in Deezer browser session");
  expect(renderHelp(["auth"])).not.toContain("--account");
});
