import { parseArgs } from "node:util";

import { Result } from "neverthrow";
import { TaggedError } from "@sonory/provider-sdk";
import { AccountManager, ProviderRegistry } from "@sonory/core";
import { createDeezerProvider } from "@sonory/provider-deezer";
import { createFixtureProvider } from "@sonory/provider-fixture";

import { runAccountCommand } from "./accounts.js";
import { parseCommand, usage } from "./commands.js";
import { promptChoice, promptCredentials, readCredentials } from "./credentials.js";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(usage);
} else {
  const registry = new ProviderRegistry();
  const registered = registry
    .register(createDeezerProvider())
    .andThen(() => registry.register(createFixtureProvider()));
  const invocation = Result.fromThrowable(
    () => parseArgs({ args, options: { account: { type: "string" } }, allowPositionals: true }),
    () => new TaggedError("invalid_input", usage),
  )();
  const command = invocation.andThen((value) => parseCommand(value.positionals));
  if (registered.isErr()) {
    console.error(`${registered.error.tag}: ${registered.error.message}`);
    process.exitCode = 1;
  } else if (command.isErr()) {
    console.error(command.error.message);
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const context = { signal: controller.signal };
    const manager = new AccountManager(registry);
    const result = await runAccountCommand(
      manager,
      command.value,
      {
        requestCredentials: (fields, operationContext) =>
          process.stdin.isTTY
            ? promptCredentials(fields, process.stdin, process.stderr, operationContext)
            : readCredentials(process.stdin, operationContext),
      },
      context,
      invocation.isOk() ? invocation.value.values.account : undefined,
      process.stdin.isTTY
        ? (choices) => promptChoice(choices, process.stdin, process.stderr, context)
        : undefined,
    );
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (result.isErr()) {
      console.error(`${result.error.tag}: ${result.error.message}`);
      process.exitCode = result.error.tag === "cancelled" ? 130 : 1;
    } else {
      console.log(result.value);
    }
  }
}
