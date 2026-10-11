import { TaggedError } from "@sonory/provider-sdk";
import type { OperationContext, ProviderOperationError } from "@sonory/provider-sdk";
import { err, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";

export const credentialsSchema = z.object({
  arl: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(/^[a-f0-9]+$/i),
});
export const userSchema = z.object({
  USER: z.object({
    USER_ID: z
      .union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)])
      .transform(String),
    BLOG_NAME: z.string().optional(),
  }),
});
const envelopeSchema = z.object({
  error: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
  results: z.unknown(),
});

export function requestJson<T>(
  fetchImplementation: typeof fetch,
  url: string,
  input: unknown,
  schema: z.ZodType<T>,
  context: OperationContext,
  cookie?: string,
  onResponse?: (response: Response) => void,
): ResultAsync<T, ProviderOperationError> {
  const transportError = (): ProviderOperationError =>
    context.signal?.aborted === true
      ? new TaggedError("cancelled", "Deezer request was cancelled.")
      : new TaggedError("unavailable", "Deezer request failed or timed out.");
  return ResultAsync.fromPromise(
    Promise.resolve().then(async (): Promise<Result<T, ProviderOperationError>> => {
      if (context.signal?.aborted === true) return err(transportError());
      const timeout = AbortSignal.timeout(15000);
      const signal =
        context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
      const response = await fetchImplementation(url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(cookie === undefined ? {} : { Cookie: cookie }),
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429)
          return err(new TaggedError("rate_limited", "Deezer request was rate limited."));
        if (response.status >= 500)
          return err(new TaggedError("unavailable", "Deezer is unavailable."));
        if (response.status === 401 || response.status === 403)
          return err(new TaggedError("authentication_failed", "Deezer rejected authentication."));
        if (response.status === 404)
          return err(new TaggedError("not_found", "Deezer track was not found."));
        return err(new TaggedError("provider_failure", `Deezer returned HTTP ${response.status}.`));
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return err(
          signal.aborted
            ? transportError()
            : new TaggedError("provider_failure", "Deezer returned invalid JSON."),
        );
      }
      if (signal.aborted) return err(transportError());
      const parsed = schema.safeParse(body);
      if (!parsed.success)
        return err(new TaggedError("provider_failure", "Deezer returned an invalid response."));
      onResponse?.(response);
      return ok(parsed.data);
    }),
    // These requests and their responses carry ARLs and temporary access tokens.
    transportError,
  ).andThen((result) => result);
}

export function createGateway(
  fetchImplementation: typeof fetch,
  arl: string,
  context: OperationContext,
) {
  let sid: string | undefined;
  return {
    request<T>(
      method: "deezer.getUserData" | "song.getData",
      token: string,
      input: unknown,
      schema: z.ZodType<T>,
    ): ResultAsync<T, ProviderOperationError> {
      const params = new URLSearchParams({
        api_version: "1.0",
        api_token: token,
        input: "3",
        method,
      });
      return requestJson(
        fetchImplementation,
        `https://www.deezer.com/ajax/gw-light.php?${params.toString()}`,
        input,
        envelopeSchema,
        context,
        `arl=${arl}${sid === undefined ? "" : `; sid=${sid}`}`,
        (response) => {
          for (const cookie of response.headers.getSetCookie()) {
            const match = /^sid=([a-zA-Z0-9._-]+)(?:;|$)/.exec(cookie);
            if (match?.[1] !== undefined) sid = match[1];
          }
        },
      ).andThen((envelope) => {
        if (Object.keys(envelope.error).length > 0) {
          if (method === "deezer.getUserData")
            return err(
              new TaggedError("authentication_failed", "The Deezer ARL is invalid or expired."),
            );
          if ("VALID_TOKEN_REQUIRED" in envelope.error || "GATEWAY_ERROR" in envelope.error)
            return err(
              new TaggedError(
                "authentication_failed",
                "Deezer rejected the session. Sign in again.",
              ),
            );
          if ("DATA_ERROR" in envelope.error)
            return err(
              new TaggedError("not_found", "Deezer track was not found or is unavailable."),
            );
          return err(new TaggedError("provider_failure", "Deezer could not resolve the track."));
        }
        const parsed = schema.safeParse(envelope.results);
        return parsed.success
          ? ok(parsed.data)
          : err(new TaggedError("provider_failure", "Deezer returned invalid gateway data."));
      });
    },
  };
}
