import type * as FileSystem from "node:fs/promises";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaggedError } from "@sonory/provider-sdk";
import type { Provider, SignInHost } from "@sonory/provider-sdk";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";

import { AccountManager } from "./account-manager.js";
import { AccountStore } from "./account-store.js";
import { accountSettingsSchema, emptyAccountSettings, selectAccount } from "./accounts.js";
import type { SavedAccount } from "./accounts.js";
import type { Credentials, CredentialStore, CredentialStoreError } from "./credential-store.js";
import { ProviderRegistry } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, Credentials>();
  unavailable = false;
  #key(account: SavedAccount) {
    return JSON.stringify([account.providerId, account.id]);
  }
  get(account: SavedAccount) {
    return this.unavailable
      ? errAsync<Credentials | null, CredentialStoreError>(
          new TaggedError("credential_store_failure", "Unavailable"),
        )
      : okAsync(this.values.get(this.#key(account)) ?? null);
  }
  set(account: SavedAccount, credentials: Credentials) {
    if (this.unavailable)
      return errAsync<void, CredentialStoreError>(
        new TaggedError("credential_store_failure", "Unavailable"),
      );
    this.values.set(this.#key(account), credentials);
    return okAsync(undefined);
  }
  remove(account: SavedAccount) {
    this.values.delete(this.#key(account));
    return okAsync(undefined);
  }
}

const host = (id: string): SignInHost => ({
  requestCredentials: () => okAsync({ id, token: `private-${id}` }),
});
function provider(id: string): Provider {
  return {
    id,
    name: id,
    version: "1",
    apiVersion: 1,
    auth: {
      authenticate: (credentials) =>
        okAsync({
          id: String(credentials["id"]),
          displayName: `User ${String(credentials["id"])}`,
        }),
      signIn: (ui, context) =>
        ui
          .requestCredentials([{ id: "id", label: "Account", secret: false }], context)
          .map((credentials) => ({
            account: {
              id: String(credentials["id"]),
              displayName: `User ${String(credentials["id"])}`,
            },
            credentials,
          })),
      signOut: () => okAsync(undefined),
    },
  };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "sonory-accounts-"));
  directories.push(directory);
  const registry = new ProviderRegistry();
  registry.register(provider("alpha"))._unsafeUnwrap();
  registry.register(provider("beta"))._unsafeUnwrap();
  const store = new AccountStore(join(directory, "accounts.json"));
  const credentials = new MemoryCredentials();
  return {
    directory,
    registry,
    store,
    credentials,
    manager: new AccountManager(registry, store, credentials),
  };
}

test("account selection uses explicit, default, sole, then asks the host", () => {
  const settings = emptyAccountSettings();
  settings.accounts = [
    { providerId: "alpha", id: "1", displayName: "One" },
    { providerId: "alpha", id: "2", displayName: "Two" },
    { providerId: "beta", id: "1", displayName: "Other" },
  ];
  expect(selectAccount(settings)._unsafeUnwrapErr().tag).toBe("provider_selection_required");
  expect(selectAccount(settings, { providerId: "alpha" })._unsafeUnwrapErr().tag).toBe(
    "account_selection_required",
  );
  expect(selectAccount(settings, { providerId: "beta" })._unsafeUnwrap().id).toBe("1");
  settings.defaultProviderId = "alpha";
  settings.defaultAccounts["alpha"] = "2";
  expect(selectAccount(settings)._unsafeUnwrap().id).toBe("2");
  expect(selectAccount(settings, { accountId: "1" })._unsafeUnwrap().id).toBe("1");
  expect(selectAccount(settings, { accountId: "missing" })._unsafeUnwrapErr().tag).toBe(
    "unknown_account",
  );
});

test("schema rejects duplicates and dangling defaults", () => {
  const account = { providerId: "alpha", id: "1", displayName: "One" };
  expect(
    accountSettingsSchema.safeParse({ ...emptyAccountSettings(), accounts: [account, account] })
      .success,
  ).toBe(false);
  expect(
    accountSettingsSchema.safeParse({ ...emptyAccountSettings(), defaultAccounts: { alpha: "1" } })
      .success,
  ).toBe(false);
  expect(
    accountSettingsSchema.safeParse({ ...emptyAccountSettings(), defaultProviderId: "alpha" })
      .success,
  ).toBe(false);
});

test("accounts, defaults, and protected sign-in survive new manager instances", async () => {
  const { manager, store, credentials, registry } = await setup();
  (await manager.signIn("alpha", host("1")))._unsafeUnwrap();
  (await manager.signIn("alpha", host("2")))._unsafeUnwrap();
  (await manager.signIn("beta", host("1")))._unsafeUnwrap();
  (await manager.setDefault("alpha", "2"))._unsafeUnwrap();
  (await manager.setDefaultProvider("alpha"))._unsafeUnwrap();
  const restarted = new AccountManager(registry, new AccountStore(store.path), credentials);
  expect((await restarted.list())._unsafeUnwrap()).toHaveLength(3);
  expect((await restarted.context())._unsafeUnwrap().session.credentials["token"]).toBe(
    "private-2",
  );
  expect((await restarted.context({ providerId: "beta" }))._unsafeUnwrap().session.account.id).toBe(
    "1",
  );
  const text = await readFile(store.path, "utf8");
  expect(text).not.toContain("private-");
  expect(text).not.toContain('"credentials"');
  expect(process.platform === "win32" || ((await stat(store.path)).mode & 0o777) === 0o600).toBe(
    true,
  );
});

test("reauthentication updates one account without duplicating it", async () => {
  const { manager } = await setup();
  (await manager.signIn("alpha", host("1")))._unsafeUnwrap();
  (await manager.signIn("alpha", host("1")))._unsafeUnwrap();
  expect((await manager.list())._unsafeUnwrap()).toHaveLength(1);
});

test("removal deletes credentials and clears related defaults", async () => {
  const { manager, store, credentials } = await setup();
  (await manager.signIn("alpha", host("1")))._unsafeUnwrap();
  (await manager.setDefault("alpha", "1"))._unsafeUnwrap();
  (await manager.setDefaultProvider("alpha"))._unsafeUnwrap();
  (await manager.remove("alpha", "1"))._unsafeUnwrap();
  const settings = (await store.load())._unsafeUnwrap();
  expect(settings.accounts).toEqual([]);
  expect(settings.defaultAccounts).toEqual({});
  expect(settings.defaultProviderId).toBeUndefined();
  expect(credentials.values.size).toBe(0);
});

test("missing credentials require signing in again", async () => {
  const { manager, credentials } = await setup();
  (await manager.signIn("alpha", host("1")))._unsafeUnwrap();
  credentials.values.clear();
  expect((await manager.context({ providerId: "alpha" }))._unsafeUnwrapErr().tag).toBe(
    "credential_missing",
  );
});

test("unavailable protected storage never saves an account", async () => {
  const { manager, credentials } = await setup();
  credentials.unavailable = true;
  expect((await manager.signIn("alpha", host("1")))._unsafeUnwrapErr().tag).toBe(
    "credential_store_failure",
  );
  expect((await manager.list())._unsafeUnwrap()).toEqual([]);
});

test.each(['{"version":2}', "invalid-json"])(
  "invalid settings remain untouched: %s",
  async (text) => {
    const { manager, store, credentials, directory } = await setup();
    await writeFile(store.path, text);
    expect((await manager.signIn("alpha", host("1")))._unsafeUnwrapErr().tag).toBe(
      "invalid_account_settings",
    );
    expect(await readFile(store.path, "utf8")).toBe(text);
    expect(credentials.values.size).toBe(0);
    expect(await readdir(directory)).toEqual(["accounts.json"]);
  },
);

test("concurrent writers return busy instead of losing updates", async () => {
  const { manager, store } = await setup();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const held = store.update(() => {
    entered();
    return ResultAsync.fromSafePromise(gate);
  });
  await started;
  const result = await manager.signIn("alpha", host("1"));
  release();
  (await held)._unsafeUnwrap();
  expect(result._unsafeUnwrapErr().tag).toBe("account_store_busy");
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, rename: vi.fn<typeof actual.rename>(actual.rename) };
});

test("failed JSON commit restores existing credentials and leaves metadata unchanged", async () => {
  const { manager, credentials, store, directory } = await setup();
  (await manager.signIn("alpha", host("1")))._unsafeUnwrap();
  const before = await readFile(store.path, "utf8");
  vi.mocked(rename).mockRejectedValueOnce(new Error("disk failure"));
  const replacement: SignInHost = {
    requestCredentials: () => okAsync({ id: "1", token: "replacement" }),
  };
  expect((await manager.signIn("alpha", replacement))._unsafeUnwrapErr().tag).toBe(
    "account_store_failure",
  );
  expect([...credentials.values.values()]).toEqual([{ id: "1", token: "private-1" }]);
  expect(await readFile(store.path, "utf8")).toBe(before);
  expect(await readdir(directory)).toEqual(["accounts.json"]);
});

test("failed new-account commit removes its credentials", async () => {
  const { manager, credentials } = await setup();
  vi.mocked(rename).mockRejectedValueOnce(new Error("disk failure"));
  expect((await manager.signIn("alpha", host("1")))._unsafeUnwrapErr().tag).toBe(
    "account_store_failure",
  );
  expect(credentials.values.size).toBe(0);
  expect((await manager.list())._unsafeUnwrap()).toEqual([]);
});

test("failed removal commit restores credentials", async () => {
  const { manager, credentials } = await setup();
  (await manager.signIn("alpha", host("1")))._unsafeUnwrap();
  vi.mocked(rename).mockRejectedValueOnce(new Error("disk failure"));
  expect((await manager.remove("alpha", "1"))._unsafeUnwrapErr().tag).toBe("account_store_failure");
  expect(credentials.values.size).toBe(1);
  expect((await manager.list())._unsafeUnwrap()).toHaveLength(1);
});

test("the bundled JSON schema matches the runtime schema", async () => {
  const value: unknown = JSON.parse(
    await readFile(new URL("../accounts.schema.json", import.meta.url), "utf8"),
  );
  expect(value).toEqual(z.toJSONSchema(accountSettingsSchema));
});
