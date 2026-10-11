import { downloadToFile } from "@sonory/core";
import type { DownloadError, OperationError, ProviderRegistry } from "@sonory/core";
import type { OperationContext } from "@sonory/provider-sdk";
import { TaggedError } from "@sonory/provider-sdk";
import { err, errAsync, ok } from "neverthrow";
import type { Result, ResultAsync } from "neverthrow";
import { z } from "zod";

export const usage = `Usage:
  sonory search <provider> <query>
  sonory track <provider> <track>
  sonory auth <provider>
  sonory accounts
  sonory accounts remove <provider> <account>
  sonory accounts default <provider> <account>
  sonory accounts provider <provider>
  sonory formats <provider> <track>
  sonory download <provider> <track> <format> <destination>

Quote queries and paths that contain spaces. Ctrl+C cancels operations.
Deezer auth prompts for a hidden ARL, or accepts {"arl":"..."} as JSON stdin.
Sign-in persists in protected OS credential storage.
Use --account <id> to select an account, or use "default" as the provider.
Without a default, multiple accounts require an interactive selection.`;

const nonempty = z.string().min(1);
const commandSchema = z.union([
  z.tuple([z.literal("accounts")]),
  z.tuple([z.literal("accounts"), z.literal("remove"), nonempty, nonempty]),
  z.tuple([z.literal("accounts"), z.literal("default"), nonempty, nonempty]),
  z.tuple([z.literal("accounts"), z.literal("provider"), nonempty]),
  z.tuple([z.literal("search"), nonempty, z.string()]),
  z.tuple([z.literal("track"), nonempty, nonempty]),
  z.tuple([z.literal("auth"), nonempty]),
  z.tuple([z.literal("formats"), nonempty, nonempty]),
  z.tuple([z.literal("download"), nonempty, nonempty, nonempty, nonempty]),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandError = DownloadError | OperationError | TaggedError<"invalid_input">;

export function parseCommand(
  args: readonly string[],
): Result<Command, TaggedError<"invalid_input">> {
  const parsed = commandSchema.safeParse(args);
  return parsed.success
    ? ok(parsed.data)
    : err(new TaggedError("invalid_input", usage, { cause: parsed.error }));
}

export function runCommand(
  registry: ProviderRegistry,
  command: Command,
  context: OperationContext = {},
  credentials: Readonly<Record<string, unknown>> = {},
): ResultAsync<string, CommandError> {
  switch (command[0]) {
    case "accounts":
      return errAsync(
        new TaggedError("invalid_input", "Account commands require persistent storage."),
      );
    case "auth":
      return registry
        .authenticate(command[1], credentials, context)
        .map((account) => JSON.stringify(account, null, 2));
    case "search":
      return registry
        .search(command[1], { query: command[2] }, context)
        .map((page) => JSON.stringify(page, null, 2));
    case "formats":
      return registry
        .listFormats({ providerId: command[1], id: command[2] }, context)
        .map((formats) => JSON.stringify(formats, null, 2));
    case "track":
      return registry
        .getTrack({ providerId: command[1], id: command[2] }, context)
        .map((track) => JSON.stringify(track, null, 2));
    case "download":
      return downloadToFile(
        registry,
        { providerId: command[1], id: command[2] },
        command[3],
        command[4],
        context,
      ).map((path) => `Downloaded ${path}`);
  }
  const unreachable: never = command;
  return unreachable;
}
