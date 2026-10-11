export class TaggedError<const Tag extends string> extends Error {
  constructor(
    readonly tag: Tag,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = tag;
  }
}

export type ProviderOperationError =
  | TaggedError<"invalid_input">
  | TaggedError<"authentication_failed">
  | TaggedError<"not_found">
  | TaggedError<"rate_limited">
  | TaggedError<"unavailable">
  | TaggedError<"cancelled">
  | TaggedError<"incomplete_download">
  | TaggedError<"provider_failure">;
