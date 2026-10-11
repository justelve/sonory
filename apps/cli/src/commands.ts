import { downloadToFile } from "@sonory/core";
import type {
  DownloadError,
  DownloadProgress,
  OperationError,
  ProviderRegistry,
} from "@sonory/core";
import type { OperationContext } from "@sonory/provider-sdk";
import { TaggedError } from "@sonory/provider-sdk";
import { err, errAsync, ok, okAsync } from "neverthrow";
import type { Result, ResultAsync } from "neverthrow";
import { z } from "zod";

import { argumentError, renderHelp } from "./help.js";

import { jsonOutput, renderOutput } from "./output.js";
import type { OutputOptions } from "./output.js";

export const usage = renderHelp();

const nonempty = z.string().min(1);
const commandSchema = z.union([
  z.tuple([z.literal("providers")]),
  z.tuple([z.literal("accounts")]),
  z.tuple([z.literal("accounts"), z.literal("remove"), nonempty, nonempty]),
  z.tuple([z.literal("accounts"), z.literal("default"), nonempty, nonempty]),
  z.tuple([z.literal("accounts"), z.literal("provider"), nonempty]),
  z.tuple([z.literal("search"), nonempty, z.string().trim().min(1), nonempty.optional()]),
  z.tuple([z.literal("track"), nonempty, nonempty]),
  z.tuple([z.literal("auth"), nonempty]),
  z.tuple([z.literal("auth")]),
  z.tuple([z.literal("formats"), nonempty, nonempty]),
  z.tuple([z.literal("download"), nonempty, nonempty, nonempty.optional(), nonempty.optional()]),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandError = DownloadError | OperationError | TaggedError<"invalid_input">;

export interface CommandOptions {
  readonly chooseFormat?: (choices: readonly string[]) => ResultAsync<number, CommandError>;
  readonly onProgress?: (progress: DownloadProgress) => void;
}

export function parseCommand(
  args: readonly string[],
): Result<Command, TaggedError<"invalid_input">> {
  const parsed = commandSchema.safeParse(args);
  return parsed.success
    ? ok(parsed.data)
    : err(new TaggedError("invalid_input", argumentError(args)));
}

export function runCommand(
  registry: ProviderRegistry,
  command: Command,
  context: OperationContext = {},
  credentials: Readonly<Record<string, unknown>> = {},
  output: OutputOptions = jsonOutput,
  options: CommandOptions = {},
): ResultAsync<string, CommandError> {
  switch (command[0]) {
    case "providers":
      return okAsync(renderOutput({ type: "providers", value: registry.list() }, output));
    case "accounts":
      return errAsync(
        new TaggedError("invalid_input", "Account commands require persistent storage."),
      );
    case "auth": {
      const providerId = command[1];
      if (providerId === undefined)
        return errAsync(
          new TaggedError("invalid_input", "Choose a provider or pass its ID to sonory auth."),
        );
      return registry
        .authenticate(providerId, credentials, context)
        .map((account) => renderOutput({ type: "account", value: account, providerId }, output));
    }
    case "search":
      return registry
        .search(
          command[1],
          { query: command[2], ...(command[3] === undefined ? {} : { cursor: command[3] }) },
          context,
        )
        .map((page) => renderOutput({ type: "search", value: page }, output));
    case "formats":
      return registry
        .listFormats({ providerId: command[1], id: command[2] }, context)
        .map((formats) => renderOutput({ type: "formats", value: formats }, output));
    case "track":
      return registry
        .getTrack({ providerId: command[1], id: command[2] }, context)
        .map((track) => renderOutput({ type: "track", value: track }, output));
    case "download": {
      const ref = { providerId: command[1], id: command[2] };
      const chooseFormat = options.chooseFormat;
      const selected =
        command[3] !== undefined
          ? okAsync(command[3])
          : chooseFormat === undefined
            ? errAsync(
                new TaggedError(
                  "invalid_input",
                  "Specify a format when downloading without an interactive terminal.",
                ),
              )
            : registry
                .listFormats(ref, context)
                .andThen((formats): ResultAsync<string, CommandError> => {
                  if (formats.length === 0)
                    return errAsync(
                      new TaggedError("unavailable", "No formats are available for this track."),
                    );
                  const only = formats.length === 1 ? formats[0] : undefined;
                  if (only !== undefined) return okAsync(only.id);
                  return chooseFormat(
                    formats.map((format) =>
                      [
                        format.id,
                        format.lossless === true ? "Lossless" : "",
                        format.bitrateKbps === undefined ? "" : `${format.bitrateKbps} kbps`,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ),
                  ).andThen((index) => {
                    const format = formats[index];
                    return format === undefined
                      ? errAsync(
                          new TaggedError("invalid_input", "No download format was selected."),
                        )
                      : okAsync(format.id);
                  });
                });
      return selected
        .andThen((formatId) =>
          downloadToFile(registry, ref, formatId, command[4], context, options.onProgress),
        )
        .map((path) => renderOutput({ type: "download", value: { path } }, output));
    }
  }
  const unreachable: never = command;
  return unreachable;
}
