import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { TaggedError } from "@sonory/provider-sdk";
import envPaths from "env-paths";
import { err, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";

import { accountSettingsSchema, emptyAccountSettings } from "./accounts.js";
import type { AccountSettings } from "./accounts.js";

export type AccountStoreError =
  | TaggedError<"account_store_failure">
  | TaggedError<"invalid_account_settings">
  | TaggedError<"account_store_busy">;
const ioError = () =>
  new TaggedError("account_store_failure", "Could not read or update account settings.");
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AccountStore {
  constructor(readonly path = join(envPaths("Sonory", { suffix: "" }).config, "accounts.json")) {}

  load(): ResultAsync<AccountSettings, AccountStoreError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(async (): Promise<Result<AccountSettings, AccountStoreError>> => {
        let text: string;
        try {
          text = await readFile(this.path, "utf8");
        } catch (error) {
          if (hasCode(error, "ENOENT")) return ok(emptyAccountSettings());
          return err(ioError());
        }
        try {
          const value: unknown = JSON.parse(text);
          const parsed = accountSettingsSchema.safeParse(value);
          return parsed.success
            ? ok(parsed.data)
            : err(
                new TaggedError(
                  "invalid_account_settings",
                  "Account settings are invalid or use an unsupported version.",
                ),
              );
        } catch {
          return err(
            new TaggedError("invalid_account_settings", "Account settings contain invalid JSON."),
          );
        }
      }),
      ioError,
    ).andThen((result) => result);
  }

  // Hold the cross-process lock across both credential updates and JSON commits.
  update<T, E>(
    operation: (
      settings: AccountSettings,
      save: (settings: AccountSettings) => ResultAsync<void, AccountStoreError>,
    ) => ResultAsync<T, E>,
  ): ResultAsync<T, E | AccountStoreError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(async (): Promise<Result<T, E | AccountStoreError>> => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const lockPath = `${this.path}.lock`;
        let lock;
        try {
          lock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          return err(
            hasCode(error, "EEXIST")
              ? new TaggedError(
                  "account_store_busy",
                  `Account settings are locked. If no Sonory process is running, remove ${lockPath}.`,
                )
              : ioError(),
          );
        }
        try {
          const loaded = await this.load();
          if (loaded.isErr()) return err(loaded.error);
          return await operation(loaded.value, (settings) => this.#save(settings));
        } finally {
          try {
            await lock.close();
          } finally {
            await rm(lockPath, { force: true });
          }
        }
      }),
      ioError,
    ).andThen((result) => result);
  }

  #save(settings: AccountSettings): ResultAsync<void, AccountStoreError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(async (): Promise<Result<void, AccountStoreError>> => {
        const parsed = accountSettingsSchema.safeParse(settings);
        if (!parsed.success)
          return err(new TaggedError("invalid_account_settings", "Account settings are invalid."));
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        let committed = false;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`);
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, this.path);
          committed = true;
          return ok(undefined);
        } finally {
          if (!committed) await rm(temporary, { force: true });
        }
      }),
      ioError,
    ).andThen((result) => result);
  }
}
