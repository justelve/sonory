import { ProviderRegistry } from "@sonory/core";
import { createFixtureProvider } from "@sonory/provider-fixture";

import { parseCommand, runCommand, usage } from "./commands.js";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(usage);
} else {
  const registry = new ProviderRegistry();
  const registered = registry.register(createFixtureProvider());
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
    const result = await runCommand(registry, command.value, { signal: controller.signal });
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
