import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Readable } from "node:stream";

import { TaggedError } from "@sonory/provider-sdk";
import type { OperationContext } from "@sonory/provider-sdk";
import { err, errAsync, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";

const schema = z.record(z.string(), z.unknown());
type CredentialError = TaggedError<"invalid_input"> | TaggedError<"cancelled">;

export function promptCredentials(
  providerId: string,
  input: Readable,
  output: Writable,
  context: OperationContext = {},
): ResultAsync<Readonly<Record<string, unknown>>, CredentialError> {
  if (providerId !== "deezer")
    return errAsync(
      new TaggedError(
        "invalid_input",
        "Interactive credentials are not defined for this provider; supply JSON through standard input.",
      ),
    );
  if (context.signal?.aborted === true)
    return errAsync(new TaggedError("cancelled", "Credential input was cancelled."));
  const controller = new AbortController();
  const signal =
    context.signal === undefined
      ? controller.signal
      : AbortSignal.any([context.signal, controller.signal]);
  const cancel = () => controller.abort();
  return ResultAsync.fromPromise(
    Promise.resolve().then(async () => {
      // Let readline handle editing and raw mode while suppressing all credential echo and history.
      const muted = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const prompt = createInterface({ input, output: muted, terminal: true, historySize: 0 });
      prompt.once("SIGINT", cancel);
      prompt.once("close", cancel);
      try {
        output.write("Deezer ARL: ");
        const arl = await prompt.question("", { signal });
        return { arl };
      } finally {
        prompt.removeListener("SIGINT", cancel);
        prompt.removeListener("close", cancel);
        prompt.close();
        muted.destroy();
        output.write("\n");
      }
    }),
    () =>
      signal.aborted
        ? new TaggedError("cancelled", "Credential input was cancelled.")
        : new TaggedError("invalid_input", "Could not read the ARL."),
  );
}

export function readCredentials(
  input: Readable,
  context: OperationContext = {},
): ResultAsync<
  Readonly<Record<string, unknown>>,
  TaggedError<"invalid_input"> | TaggedError<"cancelled">
> {
  const cancel = () => {
    input.destroy();
  };
  const isCancelled = () => context.signal?.aborted === true;
  return ResultAsync.fromPromise(
    (async (): Promise<
      Result<
        Readonly<Record<string, unknown>>,
        TaggedError<"invalid_input"> | TaggedError<"cancelled">
      >
    > => {
      if (isCancelled())
        return err(new TaggedError("cancelled", "Credential input was cancelled."));
      context.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of input) {
          const data: unknown = chunk;
          if (!Buffer.isBuffer(data) && typeof data !== "string")
            return err(new TaggedError("invalid_input", "Credential input must be text."));
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          bytes += buffer.length;
          if (bytes > 8192)
            return err(new TaggedError("invalid_input", "Credential input exceeds 8 KiB."));
          chunks.push(buffer);
        }
        if (isCancelled())
          return err(new TaggedError("cancelled", "Credential input was cancelled."));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const parsed = schema.safeParse(body);
        return parsed.success
          ? ok(parsed.data)
          : err(new TaggedError("invalid_input", "Credentials must be a JSON object."));
      } finally {
        context.signal?.removeEventListener("abort", cancel);
      }
    })(),
    () =>
      context.signal?.aborted === true
        ? new TaggedError("cancelled", "Credential input was cancelled.")
        : new TaggedError("invalid_input", "Could not read credential JSON."),
  ).andThen((result) => result);
}
