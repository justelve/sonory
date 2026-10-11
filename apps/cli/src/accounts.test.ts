import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountManager, AccountStore, ProviderRegistry } from "@sonory/core";
import type { Credentials, CredentialStore, SavedAccount } from "@sonory/core";
import type { OperationContext, Provider, SignInHost } from "@sonory/provider-sdk";
import type { ResultAsync } from "neverthrow";
import { okAsync } from "neverthrow";
import { afterEach, expect, test, vi } from "vitest";

import { runAccountCommand } from "./accounts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const host: SignInHost = { requestCredentials: () => okAsync({ token: "private" }) };
const key = (account: SavedAccount) => `${account.providerId}:${account.id}`;
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "sonory-cli-accounts-"));
  directories.push(directory);
  const registry = new ProviderRegistry();
  const contexts: OperationContext[] = [];
  const provider: Provider = {
    id: "alpha",
    name: "Alpha",
    apiVersion: 1,
    version: "1",
    auth: {
      authenticate: () => okAsync({ id: "1", displayName: "One" }),
      signIn: (ui, context) =>
        ui
          .requestCredentials([{ id: "token", label: "Token", secret: true }], context)
          .map((credentials) => ({ account: { id: "1", displayName: "One" }, credentials })),
      signOut: () => okAsync(undefined),
    },
    catalog: {
      search: (_request, context) => {
        contexts.push(context);
        return okAsync({ items: [] });
      },
      getTrack: (id) => okAsync({ ref: { providerId: "alpha", id }, title: "Track", artists: [] }),
    },
  };
  registry.register(provider)._unsafeUnwrap();
  const values = new Map<string, Credentials>();
  const credentials: CredentialStore = {
    get: (account) => okAsync(values.get(key(account)) ?? null),
    set: (account, value) => {
      values.set(key(account), value);
      return okAsync(undefined);
    },
    remove: (account) => {
      values.delete(key(account));
      return okAsync(undefined);
    },
  };
  const store = new AccountStore(join(directory, "accounts.json"));
  const manager = new AccountManager(registry, store, credentials);
  return { manager, store, contexts, values };
}

test("CLI sign-in persists credentials and operations receive the selected session", async () => {
  const { manager, contexts } = await setup();
  (await runAccountCommand(manager, ["auth", "alpha"], host, {}))._unsafeUnwrap();
  const listed = (await runAccountCommand(manager, ["accounts"], host, {}))._unsafeUnwrap();
  expect(listed).toContain("One");
  expect(listed).not.toContain("private");
  (await runAccountCommand(manager, ["search", "alpha", "query"], host, {}))._unsafeUnwrap();
  expect(contexts[0]?.session?.credentials).toEqual({ token: "private" });
  (await runAccountCommand(manager, ["accounts", "provider", "alpha"], host, {}))._unsafeUnwrap();
  (await runAccountCommand(manager, ["search", "default", "query"], host, {}))._unsafeUnwrap();
  expect(contexts[1]?.session?.account.id).toBe("1");
  (
    await runAccountCommand(manager, ["accounts", "remove", "alpha", "1"], host, {})
  )._unsafeUnwrap();
  expect((await manager.list())._unsafeUnwrap()).toEqual([]);
});

test("anonymous catalog remains usable but explicit unknown accounts never fall back", async () => {
  const { manager, contexts } = await setup();
  (await runAccountCommand(manager, ["search", "alpha", "query"], host, {}))._unsafeUnwrap();
  expect(contexts[0]?.session).toBeUndefined();
  expect(
    (
      await runAccountCommand(manager, ["search", "alpha", "query"], host, {}, "missing")
    )._unsafeUnwrapErr().tag,
  ).toBe("unknown_account");
});

test("multiple accounts ask the host unless explicitly selected or defaulted", async () => {
  const { manager, store, contexts, values } = await setup();
  (
    await store.update((settings, save) => {
      settings.accounts = [
        { providerId: "alpha", id: "1", displayName: "One" },
        { providerId: "alpha", id: "2", displayName: "Two" },
      ];
      return save(settings);
    })
  )._unsafeUnwrap();
  values.set("alpha:1", { token: "one" });
  values.set("alpha:2", { token: "two" });
  expect(
    (await runAccountCommand(manager, ["search", "alpha", "query"], host, {}))._unsafeUnwrapErr()
      .tag,
  ).toBe("account_selection_required");
  const choose = vi.fn<(choices: readonly string[]) => ResultAsync<number, never>>(() =>
    okAsync(1),
  );
  (
    await runAccountCommand(manager, ["search", "alpha", "query"], host, {}, undefined, choose)
  )._unsafeUnwrap();
  expect(choose).toHaveBeenCalledWith(["One (1)", "Two (2)"], "Which account do you want to use?");
  expect(contexts[0]?.session?.account.id).toBe("2");
  (await manager.setDefault("alpha", "1"))._unsafeUnwrap();
  (await runAccountCommand(manager, ["search", "alpha", "query"], host, {}, "2"))._unsafeUnwrap();
  expect(contexts[1]?.session?.account.id).toBe("2");
});

test("bare auth asks for a provider before requesting credentials", async () => {
  const { manager } = await setup();
  const choose = vi.fn<
    (choices: readonly string[], message?: string) => ResultAsync<number, never>
  >(() => okAsync(0));
  (await runAccountCommand(manager, ["auth"], host, {}, undefined, choose))._unsafeUnwrap();
  expect(choose).toHaveBeenCalledWith(
    ["Alpha (alpha)"],
    "Which provider do you want to sign in to?",
  );
  expect((await manager.list())._unsafeUnwrap()).toHaveLength(1);
});

test("bare auth in scripts returns a specific error without reading credentials", async () => {
  const { manager } = await setup();
  const requestCredentials = vi.fn<SignInHost["requestCredentials"]>(() =>
    okAsync({ token: "private" }),
  );
  const result = await runAccountCommand(manager, ["auth"], { requestCredentials }, {});
  expect(result._unsafeUnwrapErr().message).toBe(
    "Specify a provider when signing in without an interactive terminal.",
  );
  expect(requestCredentials).not.toHaveBeenCalled();
});
