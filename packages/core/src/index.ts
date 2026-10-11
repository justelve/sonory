import { TaggedError } from "@sonory/provider-sdk";
import type {
  Account,
  AudioFormat,
  Capability,
  DownloadSource,
  ExtensionId,
  OperationContext,
  Page,
  Provider,
  ProviderOperationError,
  ProviderSummary,
  SearchRequest,
  Track,
  TrackRef,
} from "@sonory/provider-sdk";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type { z } from "zod";

import { operationResultSchema, providerSchema } from "./provider-schema.js";

export { downloadToFile } from "./download.js";
export type { DownloadError } from "./download.js";

export class InvalidProviderError extends TaggedError<"invalid_provider"> {
  constructor(
    readonly issues: readonly z.core.$ZodIssue[],
    options?: ErrorOptions,
  ) {
    super(
      "invalid_provider",
      "Provider manifest or capabilities are invalid or incompatible.",
      options,
    );
  }
}

export type RegistrationError = InvalidProviderError | TaggedError<"duplicate_provider">;
export type LookupError =
  | TaggedError<"unknown_provider">
  | TaggedError<"unsupported_capability">
  | TaggedError<"unsupported_extension">;
export type OperationError = LookupError | ProviderOperationError;

const capabilities: readonly Capability[] = ["auth", "catalog", "download"];

export class ProviderRegistry {
  readonly #providers = new Map<string, { provider: Provider; summary: ProviderSummary }>();

  register(input: unknown): Result<void, RegistrationError> {
    return Result.fromThrowable(
      (): Result<void, RegistrationError> => {
        const parsed = providerSchema.safeParse(input);
        if (!parsed.success) {
          return err(new InvalidProviderError(parsed.error.issues));
        }
        const provider = parsed.data;
        if (this.#providers.has(provider.id)) {
          return err(
            new TaggedError(
              "duplicate_provider",
              `Provider "${provider.id}" is already registered.`,
            ),
          );
        }
        const summary: ProviderSummary = Object.freeze({
          id: provider.id,
          name: provider.name,
          version: provider.version,
          apiVersion: provider.apiVersion,
          capabilities: Object.freeze(
            capabilities.filter((capability) => provider[capability] !== undefined),
          ),
          extensions: Object.freeze(Object.keys(provider.extensions ?? {})),
        });
        this.#providers.set(summary.id, { provider, summary });
        return ok(undefined);
      },
      (cause) => new InvalidProviderError([], { cause }),
    )().andThen((result) => result);
  }

  list(): readonly ProviderSummary[] {
    return [...this.#providers.values()].map(({ summary }) => summary);
  }

  authenticate(
    providerId: string,
    input: Readonly<Record<string, unknown>>,
    context: OperationContext = {},
  ): ResultAsync<Account, OperationError> {
    return this.#run(context, () =>
      this.#capability(providerId, "auth").asyncAndThen((auth) =>
        auth.authenticate(input, context),
      ),
    );
  }

  signOut(providerId: string, context: OperationContext = {}): ResultAsync<void, OperationError> {
    return this.#run(context, () =>
      this.#capability(providerId, "auth").asyncAndThen((auth) => auth.signOut(context)),
    );
  }

  search(
    providerId: string,
    request: SearchRequest,
    context: OperationContext = {},
  ): ResultAsync<Page<Track>, OperationError> {
    return this.#run(context, () =>
      this.#capability(providerId, "catalog").asyncAndThen((catalog) =>
        catalog.search(request, context),
      ),
    );
  }

  getTrack(ref: TrackRef, context: OperationContext = {}): ResultAsync<Track, OperationError> {
    return this.#run(context, () =>
      this.#capability(ref.providerId, "catalog").asyncAndThen((catalog) =>
        catalog.getTrack(ref.id, context),
      ),
    );
  }

  listFormats(
    ref: TrackRef,
    context: OperationContext = {},
  ): ResultAsync<readonly AudioFormat[], OperationError> {
    return this.#run(context, () =>
      this.#capability(ref.providerId, "download").asyncAndThen((download) =>
        download.listFormats(ref.id, context),
      ),
    );
  }

  openDownload(
    ref: TrackRef,
    formatId: string,
    context: OperationContext = {},
  ): ResultAsync<DownloadSource, OperationError> {
    return this.#run(context, () =>
      this.#capability(ref.providerId, "download").asyncAndThen((download) =>
        download.open(ref.id, formatId, context).map((source) =>
          Object.assign({}, source, {
            stream: {
              read: () => this.#run(context, () => source.stream.read()),
              close: () => this.#run({}, () => source.stream.close()),
            },
          }),
        ),
      ),
    );
  }

  invokeExtension(
    providerId: string,
    extensionId: ExtensionId,
    input: unknown,
    context: OperationContext = {},
  ): ResultAsync<unknown, OperationError> {
    return this.#run(context, () =>
      this.#provider(providerId).asyncAndThen((provider): ResultAsync<unknown, OperationError> => {
        const extension = provider.extensions?.[extensionId];
        if (extension === undefined) {
          return errAsync(
            new TaggedError(
              "unsupported_extension",
              `Provider "${providerId}" does not support extension "${extensionId}".`,
            ),
          );
        }
        return extension.execute(input, context);
      }),
    );
  }

  #run<T, E extends OperationError>(
    context: OperationContext,
    operation: () => Result<T, E> | ResultAsync<T, E>,
  ): ResultAsync<T, E | TaggedError<"cancelled"> | TaggedError<"provider_failure">> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(
        async (): Promise<
          Result<T, E | TaggedError<"cancelled"> | TaggedError<"provider_failure">>
        > => {
          if (context.signal?.aborted === true) {
            return err(
              new TaggedError("cancelled", "Operation was cancelled.", {
                cause: context.signal.reason,
              }),
            );
          }
          const result = await operation();
          const parsed = operationResultSchema.safeParse(result);
          if (!parsed.success) {
            return err(
              new TaggedError("provider_failure", "Provider did not return a tagged Result.", {
                cause: parsed.error,
              }),
            );
          }
          return result;
        },
      ),
      (cause) =>
        new TaggedError("provider_failure", "Provider operation failed unexpectedly.", { cause }),
    ).andThen((result) => result);
  }

  #capability<K extends Capability>(
    providerId: string,
    capability: K,
  ): Result<NonNullable<Provider[K]>, LookupError> {
    return this.#provider(providerId).andThen((provider) => {
      const implementation = provider[capability];
      if (implementation === undefined) {
        return err(
          new TaggedError(
            "unsupported_capability",
            `Provider "${providerId}" does not support "${capability}".`,
          ),
        );
      }
      return ok(implementation);
    });
  }

  #provider(providerId: string): Result<Provider, LookupError> {
    const entry = this.#providers.get(providerId);
    return entry === undefined
      ? err(new TaggedError("unknown_provider", `Provider "${providerId}" is not registered.`))
      : ok(entry.provider);
  }
}
