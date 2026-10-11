import { parseArgs, styleText } from "node:util";

import { spinner } from "@clack/prompts";
import { AccountManager, ProviderRegistry } from "@sonory/core";
import { createDeezerProvider } from "@sonory/provider-deezer";
import { createFixtureProvider } from "@sonory/provider-fixture";
import { TaggedError } from "@sonory/provider-sdk";
import { err, ok, Result } from "neverthrow";

import { runAccountCommand } from "./accounts.js";
import { parseCommand } from "./commands.js";
import { promptChoice, promptCredentials, readCredentials } from "./credentials.js";
import { argumentError, argumentHint, helpTopic, renderHelp } from "./help.js";
import { renderError, terminalText } from "./output.js";

const invocation = Result.fromThrowable(
  () =>
    parseArgs({
      options: {
        account: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        cursor: { type: "string" },
      },
      allowPositionals: true,
    }),
  (cause) =>
    new TaggedError(
      "invalid_input",
      cause instanceof Error ? cause.message : "Invalid command options.",
    ),
)().andThen((value) => {
  const topic = helpTopic(value.positionals);
  if (
    value.values.help === true &&
    value.positionals.length > 0 &&
    (topic === undefined ||
      (value.positionals[0] === "accounts" &&
        value.positionals.length > 1 &&
        topic.name === "accounts"))
  )
    return err(new TaggedError("invalid_input", argumentError(value.positionals)));
  return ok(value);
});
const json = (invocation.isOk() && invocation.value.values.json === true) || !process.stdout.isTTY;
const output = {
  json,
  columns: process.stdout.columns || 80,
  color: !json && styleText("cyan", "test") !== "test",
};
const errorColor = !json && styleText("red", "test", { stream: process.stderr }) !== "test";
if (
  invocation.isOk() &&
  (invocation.value.values.help === true || invocation.value.positionals.length === 0)
) {
  console.log(renderHelp(invocation.value.positionals, output.color));
} else {
  const registry = new ProviderRegistry();
  const registered = registry
    .register(createDeezerProvider())
    .andThen(() => registry.register(createFixtureProvider()));
  const command = invocation.andThen((value) => {
    if (value.positionals[0] === "search" && value.positionals.length > 3)
      return err(new TaggedError("invalid_input", argumentError(value.positionals)));
    if (value.values.cursor !== undefined && value.values.cursor.trim().length === 0)
      return err(new TaggedError("invalid_input", "--cursor requires a nonempty value."));
    if (
      value.values.account !== undefined &&
      ["auth", "accounts", "providers"].includes(value.positionals[0] ?? "")
    )
      return err(
        new TaggedError(
          "invalid_input",
          "--account is only available for catalog and download commands.",
        ),
      );
    if (value.values.cursor !== undefined && value.positionals[0] !== "search")
      return err(new TaggedError("invalid_input", "--cursor is only available for search."));
    return parseCommand(
      value.values.cursor === undefined
        ? value.positionals
        : [...value.positionals, value.values.cursor],
    );
  });
  if (registered.isErr()) {
    console.error(renderError(registered.error, json, errorColor));
    process.exitCode = 1;
  } else if (command.isErr()) {
    console.error(renderError(command.error, json, errorColor));
    if (!json) {
      const hint = invocation.isOk()
        ? argumentHint(invocation.value.positionals, errorColor)
        : "Run sonory --help for available options.";
      if (hint.length > 0) console.error(`\n${hint}`);
    }
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const context = { signal: controller.signal };
    const manager = new AccountManager(registry);
    const interactive = process.stdin.isTTY && process.stderr.isTTY;
    const progress =
      !json && process.stderr.isTTY
        ? spinner({ output: process.stderr, withGuide: false, onCancel: cancel })
        : undefined;
    const labels = {
      search: "Searching music",
      track: "Loading track",
      formats: "Loading formats",
      download: "Downloading file",
      auth: "Verifying account",
      accounts:
        command.value[1] === undefined
          ? "Loading accounts"
          : command.value[1] === "remove"
            ? "Removing account"
            : "Saving default",
      providers: "Loading providers",
    };
    const label = labels[command.value[0]];
    if (command.value[0] !== "auth") progress?.start(label);
    try {
      const result = await runAccountCommand(
        manager,
        command.value,
        {
          requestCredentials: (fields, operationContext) => {
            progress?.clear();
            return (
              interactive
                ? promptCredentials(fields, process.stdin, process.stderr, operationContext)
                : readCredentials(process.stdin, operationContext)
            ).map((credentials) => {
              progress?.start(label);
              return credentials;
            });
          },
        },
        context,
        invocation.isOk() ? invocation.value.values.account : undefined,
        interactive
          ? (choices, message) => {
              progress?.clear();
              return promptChoice(choices, process.stdin, process.stderr, context, message).map(
                (index) => {
                  if (command.value[0] !== "auth") progress?.start(label);
                  return index;
                },
              );
            }
          : undefined,
        output,
      );
      progress?.clear();
      if (result.isErr()) {
        if (!(result.error.tag === "cancelled" && progress?.isCancelled === true))
          console.error(renderError(result.error, json, errorColor));
        if (!json && result.error.tag === "invalid_input") {
          const topic = helpTopic(invocation.isOk() ? invocation.value.positionals : []);
          console.error(`\nHelp\n  sonory ${topic?.name ?? command.value[0]} --help`);
        }
        if (
          !json &&
          (result.error.tag === "account_store_failure" ||
            result.error.tag === "invalid_account_settings")
        )
          console.error(`\nAccount settings\n  ${terminalText(manager.store.path)}`);
        process.exitCode = result.error.tag === "cancelled" ? 130 : 1;
      } else {
        console.log(result.value);
      }
    } finally {
      progress?.clear();
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}
