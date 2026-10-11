import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { okAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";
import { afterEach, expect, test, vi } from "vitest";

import { AccountStore } from "./account-store.js";
import { emptyAccountSettings } from "./accounts.js";
import type { AccountSettings } from "./accounts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "sonory-config-golden-"));
  directories.push(directory);
  return { directory, store: new AccountStore(join(directory, "accounts.json")) };
}

function fixture(name: string) {
  return readFile(new URL(`./fixtures/accounts/${name}.json`, import.meta.url), "utf8");
}

test.each(["v1-empty", "v1-single", "v1-multiple"])(
  "%s config loads and round-trips without losing fields",
  async (name) => {
    const { store } = await setup();
    const golden = await fixture(name);
    const expected: unknown = JSON.parse(golden);
    await writeFile(store.path, golden);

    expect((await store.load())._unsafeUnwrap()).toEqual(expected);
    (await store.update((settings, save) => save(settings)))._unsafeUnwrap();
    expect(await readFile(store.path, "utf8")).toBe(golden);
    expect((await new AccountStore(store.path).load())._unsafeUnwrap()).toEqual(expected);
  },
);

test("new config serialization matches the empty v1 golden", async () => {
  const { store } = await setup();
  const initial = emptyAccountSettings();
  expect((await store.load())._unsafeUnwrap()).toEqual(initial);
  (await store.update((settings, save) => save(settings)))._unsafeUnwrap();

  // The generated schema URL depends on the checkout/install location.
  const text = await readFile(store.path, "utf8");
  expect(initial.$schema).toBe(new URL("../accounts.schema.json", import.meta.url).href);
  expect(text.replace(JSON.stringify(initial.$schema), '"../../../accounts.schema.json"')).toBe(
    await fixture("v1-empty"),
  );
});

test("populated config serialization matches the multi-provider v1 golden", async () => {
  const { store } = await setup();
  const settings: AccountSettings = {
    $schema: "../../../accounts.schema.json",
    version: 1,
    accounts: [
      { providerId: "deezer", id: "123", displayName: "Renée 🎵" },
      { providerId: "deezer", id: "456", displayName: "Second account" },
      { providerId: "tidal", id: "123", displayName: "Same ID, different provider" },
    ],
    defaultProviderId: "deezer",
    defaultAccounts: { deezer: "456", tidal: "123" },
  };
  (await store.update((_current, save) => save(settings)))._unsafeUnwrap();
  expect(await readFile(store.path, "utf8")).toBe(await fixture("v1-multiple"));
});

test("v1 config without an editor schema remains readable and preserves its shape", async () => {
  const { store } = await setup();
  const golden = (await fixture("v1-single")).replace(
    '  "$schema": "../../../accounts.schema.json",\n',
    "",
  );
  await writeFile(store.path, golden);
  expect((await store.load())._unsafeUnwrap().accounts).toEqual([
    { providerId: "deezer", id: "123", displayName: "Renée 🎵" },
  ]);
  (await store.update((settings, save) => save(settings)))._unsafeUnwrap();
  expect(await readFile(store.path, "utf8")).toBe(golden);
});

test("a future version of a complete config is rejected without changing the file", async () => {
  const { directory, store } = await setup();
  const golden = (await fixture("v1-multiple")).replace('"version": 1', '"version": 2');
  await writeFile(store.path, golden);
  const operation = vi.fn<(settings: AccountSettings) => ResultAsync<void, never>>(() =>
    okAsync(undefined),
  );

  expect((await store.load())._unsafeUnwrapErr().tag).toBe("invalid_account_settings");
  expect((await store.update(operation))._unsafeUnwrapErr().tag).toBe("invalid_account_settings");
  expect(operation).not.toHaveBeenCalled();
  expect(await readFile(store.path, "utf8")).toBe(golden);
  expect(await readdir(directory)).toEqual(["accounts.json"]);
});
