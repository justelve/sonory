import { TaggedError } from "@sonory/provider-sdk";
import { AccountSelectionRequired, ProviderSelectionRequired } from "@sonory/core";
import type { AccountError, AccountManager } from "@sonory/core";
import type { OperationContext, SignInHost } from "@sonory/provider-sdk";
import { errAsync, okAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";

import { parseCommand as parseResolved, runCommand } from "./commands.js";
import type { Command, CommandError, CommandOptions } from "./commands.js";

import { jsonOutput, renderOutput } from "./output.js";
import type { OutputOptions } from "./output.js";

type Choose = (choices: readonly string[], message?: string) => ResultAsync<number, CommandError>;

export function runAccountCommand(
  manager: AccountManager,
  command: Command,
  host: SignInHost,
  context: OperationContext,
  accountId?: string,
  choose?: Choose,
  output: OutputOptions = jsonOutput,
  options: Pick<CommandOptions, "onProgress"> = {},
): ResultAsync<string, AccountError | CommandError> {
  if (command[0] === "auth") {
    const providers = manager.registry
      .list()
      .filter((provider) => provider.capabilities.includes("auth"));
    if (providers.length === 0)
      return errAsync(
        new TaggedError("unsupported_capability", "No installed provider supports sign-in."),
      );
    const selected =
      command[1] !== undefined
        ? okAsync(command[1])
        : choose === undefined
          ? errAsync(
              new TaggedError(
                "invalid_input",
                "Specify a provider when signing in without an interactive terminal.",
              ),
            )
          : choose(
              providers.map((provider) => `${provider.name} (${provider.id})`),
              "Which provider do you want to sign in to?",
            ).andThen((index) => {
              const provider = providers[index];
              return provider === undefined
                ? errAsync(new TaggedError("invalid_input", "No sign-in provider was selected."))
                : okAsync(provider.id);
            });
    return selected.andThen((providerId) =>
      manager
        .signIn(providerId, host, context)
        .map((account) => renderOutput({ type: "account", value: account, providerId }, output)),
    );
  }
  if (command[0] === "providers") return runCommand(manager.registry, command, context, {}, output);
  if (command[0] === "accounts") {
    if (command.length === 1)
      return manager.store
        .load()
        .map((settings) => renderOutput({ type: "accounts", value: settings }, output));
    if (command[1] === "provider")
      return manager
        .setDefaultProvider(command[2])
        .map(() =>
          renderOutput(
            { type: "message", value: { message: `Default provider: ${command[2]}.` } },
            output,
          ),
        );
    if (command[1] === "default")
      return manager.setDefault(command[2], command[3]).map(() =>
        renderOutput(
          {
            type: "message",
            value: { message: `Default account for ${command[2]}: ${command[3]}.` },
          },
          output,
        ),
      );
    return manager.remove(command[2], command[3]).map(() =>
      renderOutput(
        {
          type: "message",
          value: { message: `Removed account ${command[3]} from ${command[2]}.` },
        },
        output,
      ),
    );
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
          "Which account do you want to use?",
        ).andThen((index) => {
          const account = error.accounts[index];
          return account === undefined
            ? errAsync(error)
            : resolve({ providerId: account.providerId, accountId: account.id });
        });
      }
      if (choose !== undefined && error instanceof ProviderSelectionRequired) {
        return choose(error.providerIds, "Which provider do you want to use?").andThen((index) => {
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
    const resolved = [...command].filter((value): value is string => typeof value === "string");
    resolved[1] = selected.providerId;
    // Only the provider argument changes; validate the resulting command through the parser.
    return parseResolved(resolved).asyncAndThen((value) =>
      runCommand(manager.registry, value, selected, {}, output, {
        ...options,
        ...(choose === undefined
          ? {}
          : {
              chooseFormat: (choices: readonly string[]) =>
                choose(choices, "Which format do you want to download?"),
            }),
      }),
    );
  });
}
