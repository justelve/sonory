import type { AsyncEntry } from "@napi-rs/keyring";
import { TaggedError } from "@sonory/provider-sdk";
import { ResultAsync } from "neverthrow";
import { z } from "zod";

import type { SavedAccount } from "./accounts.js";

export type Credentials = Readonly<Record<string, unknown>>;
export type CredentialStoreError = TaggedError<"credential_store_failure">;
export interface CredentialStore {
  get(account: SavedAccount): ResultAsync<Credentials | null, CredentialStoreError>;
  set(account: SavedAccount, credentials: Credentials): ResultAsync<void, CredentialStoreError>;
  remove(account: SavedAccount): ResultAsync<void, CredentialStoreError>;
}

export class ProtectedCredentialStore implements CredentialStore {
  constructor(readonly service = "Sonory") {}

  #run<T>(
    account: SavedAccount,
    operation: (entry: AsyncEntry) => Promise<T>,
  ): ResultAsync<T, CredentialStoreError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(async () => {
        const { AsyncEntry } = await import("@napi-rs/keyring");
        // Kernel keyutils storage does not survive reboots; never silently fall back to it.
        const entry = new AsyncEntry(
          this.service,
          JSON.stringify([account.providerId, account.id]),
          { linux: { store: "secret-service" } },
        );
        return operation(entry);
      }),
      () =>
        new TaggedError(
          "credential_store_failure",
          "Could not access protected credential storage. Check that your OS credential store is available and unlocked.",
        ),
    );
  }

  get(account: SavedAccount): ResultAsync<Credentials | null, CredentialStoreError> {
    return this.#run(account, async (entry) => {
      const password = await entry.getPassword();
      if (password === null) return null;
      const parsed: unknown = JSON.parse(password);
      return z.record(z.string(), z.unknown()).parse(parsed);
    });
  }

  set(account: SavedAccount, credentials: Credentials): ResultAsync<void, CredentialStoreError> {
    return this.#run(account, (entry) => entry.setPassword(JSON.stringify(credentials)));
  }

  remove(account: SavedAccount): ResultAsync<void, CredentialStoreError> {
    return this.#run(account, async (entry) => {
      await entry.deleteCredential();
    });
  }
}
