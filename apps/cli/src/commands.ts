import { downloadToFile } from "@sonory/core";
import type { DownloadError, OperationError, ProviderRegistry } from "@sonory/core";
import type { OperationContext } from "@sonory/provider-sdk";
import { TaggedError } from "@sonory/provider-sdk";
import { err, ok } from "neverthrow";
import type { Result, ResultAsync } from "neverthrow";
import { z } from "zod";

export const usage = `Usage:
  sonory search <provider> <query>
  sonory track <provider> <track>
  sonory auth <provider>
  sonory formats <provider> <track>
  sonory download <provider> <track> <format> <destination>

Quote queries and paths that contain spaces. Ctrl+C cancels operations.
Deezer auth prompts for a hidden ARL, or accepts {"arl":"..."} as JSON stdin.
Credentials are validated without being saved.`;

const nonempty = z.string().min(1);
const commandSchema = z.union([
  z.tuple([z.literal("search"), nonempty, z.string()]),
  z.tuple([z.literal("track"), nonempty, nonempty]),
  z.tuple([z.literal("auth"), nonempty]),
  z.tuple([z.literal("formats"), nonempty, nonempty]),
  z.tuple([z.literal("download"), nonempty, nonempty, nonempty, nonempty]),
]);
type Command = z.infer<typeof commandSchema>;
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
