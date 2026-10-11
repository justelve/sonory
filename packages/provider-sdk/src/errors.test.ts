import { expect, expectTypeOf, test } from "vitest";

import { TaggedError } from "./errors.js";

class ValidationError extends TaggedError<"validation"> {
  constructor(readonly issues: readonly string[]) {
    super("validation", "Input is invalid.");
  }
}

class RateLimitError extends TaggedError<"rate_limit"> {
  constructor(readonly retryAfterMs: number) {
    super("rate_limit", "Try again later.");
  }
}

function describeError(error: ValidationError | RateLimitError): string {
  switch (error.tag) {
    case "validation":
      expectTypeOf(error).toEqualTypeOf<ValidationError>();
      return error.issues.join(", ");
    case "rate_limit":
      expectTypeOf(error).toEqualTypeOf<RateLimitError>();
      return String(error.retryAfterMs);
  }
  const unreachable: never = error;
  return unreachable;
}

test("tags retain literal types and errors preserve their cause", () => {
  const cause = new Error("Original failure");
  const error = new TaggedError("not_found", "Track is missing.", { cause });

  expectTypeOf(error.tag).toEqualTypeOf<"not_found">();
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe("Track is missing.");
  expect(error.cause).toBe(cause);
});

test("switching on tags narrows subclasses and their specific fields", () => {
  expect(describeError(new ValidationError(["Missing title"]))).toBe("Missing title");
  expect(describeError(new RateLimitError(1000))).toBe("1000");
});
