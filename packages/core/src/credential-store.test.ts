import { inspect } from "node:util";

import { AsyncEntry } from "@napi-rs/keyring";
import { beforeEach, expect, test, vi } from "vitest";

import { ProtectedCredentialStore } from "./credential-store.js";

const backend = vi.hoisted(() => ({
  get: vi.fn<() => Promise<string | null>>(),
  set: vi.fn<(value: string) => Promise<void>>(),
  remove: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@napi-rs/keyring", () => {
  class FakeEntry {
    getPassword = backend.get;
    setPassword = backend.set;
    deleteCredential = backend.remove;
  }
  return { AsyncEntry: vi.fn<typeof FakeEntry>(FakeEntry) };
});
beforeEach(() => {
  backend.get.mockResolvedValue(null);
  backend.set.mockResolvedValue(undefined);
  backend.remove.mockResolvedValue(true);
});
const account = { providerId: "alpha", id: "1", displayName: "One" };

test("protected credentials require the persistent Linux backend", async () => {
  const store = new ProtectedCredentialStore("Sonory test");
  (await store.set(account, { token: "secret" }))._unsafeUnwrap();
  expect(AsyncEntry).toHaveBeenCalledWith("Sonory test", '["alpha","1"]', {
    linux: { store: "secret-service" },
  });
  expect(backend.set).toHaveBeenCalledWith('{"token":"secret"}');
  backend.get.mockResolvedValue('{"token":"secret"}');
  expect((await store.get(account))._unsafeUnwrap()).toEqual({ token: "secret" });
  (await store.remove(account))._unsafeUnwrap();
  expect(backend.remove).toHaveBeenCalledOnce();
});

test("absent credentials are distinct from backend failures", async () => {
  const store = new ProtectedCredentialStore();
  expect((await store.get(account))._unsafeUnwrap()).toBeNull();
  backend.get.mockRejectedValue(new Error("private credential"));
  const result = await store.get(account);
  expect(result._unsafeUnwrapErr().tag).toBe("credential_store_failure");
  expect(inspect(result, { depth: null })).not.toContain("private credential");
});

test.each(["not-json", "[]", "null"])(
  "malformed protected credential data returns a safe error: %s",
  async (value) => {
    backend.get.mockResolvedValue(value);
    expect((await new ProtectedCredentialStore().get(account))._unsafeUnwrapErr().tag).toBe(
      "credential_store_failure",
    );
  },
);
