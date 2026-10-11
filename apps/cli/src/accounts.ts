import { AccountSelectionRequired, ProviderSelectionRequired } from "@sonory/core";
import type { AccountError, AccountManager } from "@sonory/core";
import type { OperationContext, SignInHost } from "@sonory/provider-sdk";
import { errAsync, okAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";

import { parseCommand as parseResolved, runCommand } from "./commands.js";
import type { Command, CommandError } from "./commands.js";

type Choose = (choices: readonly string[]) => ResultAsync<number, CommandError>;

export function runAccountCommand(
  manager: AccountManager,
  command: Command,
  host: SignInHost,
  context: OperationContext,
  accountId?: string,
  choose?: Choose,
): ResultAsync<string, AccountError | CommandError> {
  if (command[0] === "auth")
    return manager
      .signIn(command[1], host, context)
      .map((account) => JSON.stringify(account, null, 2));
  if (command[0] === "accounts") {
    if (command.length === 1)
      return manager.store.load().map((settings) => JSON.stringify(settings, null, 2));
    if (command[1] === "provider")
      return manager.setDefaultProvider(command[2]).map(() => "Default provider saved.");
    if (command[1] === "default")
      return manager.setDefault(command[2], command[3]).map(() => "Default account saved.");
    return manager.remove(command[2], command[3]).map(() => "Account removed.");
  }
  const requested = {
    ...(command[1] === "default" ? {} : { providerId: command[1] }),
    ...(accountId === undefined ? {} : { accountId }),
  };
  const resolve = (
    selection: typeof requested,
  ): ResultAsync<OperationContext & { providerId: string }, AccountError | CommandError> =>
    manager.context(selection, context).orElse((error) => {
      if (choose !== undefined && error instanceof AccountSelectionRequired) {
        return choose(
          error.accounts.map((account) => `${account.displayName} (${account.id})`),
        ).andThen((index) => {
          const account = error.accounts[index];
          return account === undefined
            ? errAsync(error)
            : resolve({ providerId: account.providerId, accountId: account.id });
        });
      }
      if (choose !== undefined && error instanceof ProviderSelectionRequired) {
        return choose(error.providerIds).andThen((index) => {
          const providerId = error.providerIds[index];
          return providerId === undefined ? errAsync(error) : resolve({ ...selection, providerId });
        });
      }
      if (
        error.tag === "account_required" &&
        selection.providerId !== undefined &&
        accountId === undefined
      )
        return okAsync({ ...context, providerId: selection.providerId });
      return errAsync(error);
    });
  return resolve(requested).andThen((selected) => {
    const resolved = [...command];
    resolved[1] = selected.providerId;
    // Only the provider argument changes; validate the resulting command through the parser.
    return parseResolved(resolved).asyncAndThen((value) =>
      runCommand(manager.registry, value, selected),
    );
  });
}
