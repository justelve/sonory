import { ProviderRegistry } from "@sonory/core";
import { createDeezerProvider } from "@sonory/provider-deezer";
import { createFixtureProvider } from "@sonory/provider-fixture";

import { parseCommand, runCommand, usage } from "./commands.js";
import { promptCredentials, readCredentials } from "./credentials.js";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(usage);
} else {
  const registry = new ProviderRegistry();
  const registered = registry
    .register(createDeezerProvider())
    .andThen(() => registry.register(createFixtureProvider()));
  const command = parseCommand(args);
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
    const result = await (command.value[0] === "auth"
      ? (process.stdin.isTTY
          ? promptCredentials(command.value[1], process.stdin, process.stderr, context)
          : readCredentials(process.stdin, context)
        ).andThen((credentials) => runCommand(registry, command.value, context, credentials))
      : runCommand(registry, command.value, context));
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
