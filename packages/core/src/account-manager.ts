import { TaggedError } from "@sonory/provider-sdk";
import type { OperationContext, SignInHost } from "@sonory/provider-sdk";
import { errAsync, okAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";

import { selectAccount } from "./accounts.js";
import type { AccountSelectionError, SavedAccount } from "./accounts.js";
import { AccountStore } from "./account-store.js";
import type { AccountStoreError } from "./account-store.js";
import { ProtectedCredentialStore } from "./credential-store.js";
import type { CredentialStore, CredentialStoreError, Credentials } from "./credential-store.js";
import type { OperationError, ProviderRegistry } from "./index.js";

export type AccountError =
  | AccountStoreError
  | CredentialStoreError
  | AccountSelectionError
  | OperationError
  | TaggedError<"credential_missing">
  | TaggedError<"account_recovery_required">;

export class AccountManager {
  constructor(
    readonly registry: ProviderRegistry,
    readonly store = new AccountStore(),
    readonly credentials: CredentialStore = new ProtectedCredentialStore(),
  ) {}

  list(): ResultAsync<readonly SavedAccount[], AccountStoreError> {
    return this.store.load().map((settings) => settings.accounts);
  }

  signIn(
    providerId: string,
    host: SignInHost,
    context: OperationContext = {},
  ): ResultAsync<SavedAccount, AccountError> {
    return this.registry.signIn(providerId, host, context).andThen((session) => {
      if (context.signal?.aborted === true)
        return errAsync(new TaggedError("cancelled", "Sign-in was cancelled."));
      const account = { ...session.account, providerId };
      return this.store.update((settings, save) =>
        this.credentials.get(account).andThen((previous) =>
          this.credentials.set(account, session.credentials).andThen(() => {
            settings.accounts = settings.accounts.filter(
              (item) => item.providerId !== providerId || item.id !== account.id,
            );
            settings.accounts.push(account);
            return save(settings)
              .orElse((error) => this.#restore(account, previous).andThen(() => errAsync(error)))
              .map(() => account);
          }),
        ),
      );
    });
  }

  remove(providerId: string, accountId: string): ResultAsync<void, AccountError> {
    return this.store.update((settings, save) =>
      selectAccount(settings, { providerId, accountId }).asyncAndThen((account) =>
        this.credentials.get(account).andThen((previous) =>
          this.credentials.remove(account).andThen(() => {
            settings.accounts = settings.accounts.filter(
              (item) => item.providerId !== providerId || item.id !== accountId,
            );
            if (settings.defaultAccounts[providerId] === accountId)
              delete settings.defaultAccounts[providerId];
            if (
              settings.defaultProviderId === providerId &&
              !settings.accounts.some((item) => item.providerId === providerId)
            )
              delete settings.defaultProviderId;
            return save(settings).orElse((error) =>
              this.#restore(account, previous).andThen(() => errAsync(error)),
            );
          }),
        ),
      ),
    );
  }

  setDefault(providerId: string, accountId: string): ResultAsync<void, AccountError> {
    return this.store.update((settings, save) =>
      selectAccount(settings, { providerId, accountId }).asyncAndThen(() => {
        settings.defaultAccounts[providerId] = accountId;
        return save(settings);
      }),
    );
  }

  setDefaultProvider(providerId: string): ResultAsync<void, AccountError> {
    return this.store.update<void, AccountError>((settings, save) => {
      if (!settings.accounts.some((account) => account.providerId === providerId))
        return errAsync(new TaggedError("account_required", "Sign in to this provider first."));
      settings.defaultProviderId = providerId;
      return save(settings);
    });
  }

  context(
    requested: { readonly providerId?: string; readonly accountId?: string } = {},
    context: OperationContext = {},
  ): ResultAsync<
    OperationContext & {
      readonly session: NonNullable<OperationContext["session"]>;
      readonly providerId: string;
    },
    AccountError
  > {
    return this.store
      .load()
      .andThen((settings) => selectAccount(settings, requested))
      .andThen((account) =>
        this.credentials.get(account).andThen((credentials) =>
          credentials === null
            ? errAsync(
                new TaggedError(
                  "credential_missing",
                  "Stored credentials are missing. Sign in to this account again.",
                ),
              )
            : okAsync({
                ...context,
                providerId: account.providerId,
                session: {
                  account: { id: account.id, displayName: account.displayName },
                  credentials,
                },
              }),
        ),
      );
  }

  #restore(
    account: SavedAccount,
    previous: Credentials | null,
  ): ResultAsync<void, TaggedError<"account_recovery_required">> {
    return (
      previous === null ? this.credentials.remove(account) : this.credentials.set(account, previous)
    ).mapErr(
      () =>
        new TaggedError(
          "account_recovery_required",
          "Settings could not be saved and credentials could not be restored. Sign in again to recover this account.",
        ),
    );
  }
}
