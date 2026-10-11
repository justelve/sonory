import type { Readable, Writable } from "node:stream";

import { isCancel, password, select, text } from "@clack/prompts";
import type { CANCEL_SYMBOL, CommonOptions } from "@clack/prompts";

import { TaggedError } from "@sonory/provider-sdk";
import type { CredentialField, OperationContext } from "@sonory/provider-sdk";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";

import { terminalText } from "./output.js";

const schema = z.record(z.string(), z.unknown());
type CredentialError = TaggedError<"invalid_input"> | TaggedError<"cancelled">;

function ask<T>(
  input: Readable,
  output: Writable,
  context: OperationContext,
  question: (options: CommonOptions) => Promise<T | typeof CANCEL_SYMBOL>,
): ResultAsync<T, CredentialError> {
  if (context.signal?.aborted === true || input.readableEnded || input.destroyed)
    return errAsync(new TaggedError("cancelled", "Input was cancelled."));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  return ResultAsync.fromPromise(
    Promise.resolve().then(async () => {
      context.signal?.addEventListener("abort", cancel, { once: true });
      input.once("end", cancel);
      input.once("close", cancel);
      if (context.signal?.aborted === true || input.readableEnded || input.destroyed) cancel();
      try {
        const answer = await question({
          input,
          output,
          signal: controller.signal,
          withGuide: false,
        });
        return isCancel(answer)
          ? err(new TaggedError("cancelled", "Input was cancelled."))
          : ok(answer);
      } finally {
        context.signal?.removeEventListener("abort", cancel);
        input.removeListener("end", cancel);
        input.removeListener("close", cancel);
      }
    }),
    () => new TaggedError("invalid_input", "Could not read terminal input."),
  ).andThen((result) => result);
}

const required = (value: string | undefined) =>
  value === undefined || value.trim().length === 0 ? "Enter a value to continue." : undefined;

export function promptCredentials(
  fields: readonly CredentialField[],
  input: Readable,
  output: Writable,
  context: OperationContext = {},
): ResultAsync<Readonly<Record<string, unknown>>, CredentialError> {
  return fields.reduce<ResultAsync<Record<string, unknown>, CredentialError>>(
    (operation, field) =>
      operation.andThen((credentials) =>
        ask<string>(input, output, context, (options) =>
          (field.secret ? password : text)({
            ...options,
            message: terminalText(field.label),
            validate: required,
          }),
        ).map((value) => {
          credentials[field.id] = value;
          return credentials;
        }),
      ),
    okAsync({}),
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

export function promptChoice(
  choices: readonly string[],
  input: Readable,
  output: Writable,
  context: OperationContext = {},
  message = "Choose an account or provider",
): ResultAsync<number, CredentialError> {
  if (choices.length === 0)
    return errAsync(
      new TaggedError("invalid_input", "No accounts or providers are available to select."),
    );
  return ask<number>(input, output, context, (options) =>
    select({
      ...options,
      message,
      options: choices.map((label, value) => ({ value, label: terminalText(label) })),
    }),
  );
}
