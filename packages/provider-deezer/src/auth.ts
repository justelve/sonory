import { TaggedError } from "@sonory/provider-sdk";
import type {
  Account,
  AuthCapability,
  OperationContext,
  ProviderOperationError,
} from "@sonory/provider-sdk";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";

const credentialsSchema = z.object({
  arl: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(/^[a-f0-9]+$/i),
});
const responseSchema = z.object({
  error: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
  results: z.unknown(),
});
const userSchema = z.object({
  USER: z.object({
    USER_ID: z
      .union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)])
      .transform(String),
    BLOG_NAME: z.string().optional(),
  }),
});
const endpoint =
  "https://www.deezer.com/ajax/gw-light.php?api_version=1.0&api_token=null&input=3&method=deezer.getUserData";

function transportError(context: OperationContext): ProviderOperationError {
  // Transport errors and gateway payloads can contain credentials. Do not expose them as causes.
  return context.signal?.aborted === true
    ? new TaggedError("cancelled", "Deezer authentication was cancelled.")
    : new TaggedError("unavailable", "Deezer authentication failed or timed out.");
}

export function createDeezerAuth(fetchImplementation: typeof fetch): AuthCapability {
  return {
    authenticate(input, context) {
      return ResultAsync.fromPromise(
        Promise.resolve().then(async (): Promise<Result<Account, ProviderOperationError>> => {
          const credentials = credentialsSchema.safeParse(input);
          if (!credentials.success)
            return err(
              new TaggedError(
                "invalid_input",
                "Provide a Deezer ARL cookie value containing only hexadecimal characters.",
              ),
            );
          if (context.signal?.aborted === true) return err(transportError(context));
          const timeout = AbortSignal.timeout(15000);
          const signal =
            context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
          const response = await fetchImplementation(endpoint, {
            method: "POST",
            redirect: "error",
            signal,
            headers: { "Content-Type": "application/json", Cookie: `arl=${credentials.data.arl}` },
            body: "{}",
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 429)
              return err(
                new TaggedError("rate_limited", "Deezer authentication was rate limited."),
              );
            if (response.status >= 500)
              return err(new TaggedError("unavailable", "Deezer authentication is unavailable."));
            return err(new TaggedError("authentication_failed", "Deezer rejected authentication."));
          }
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            return err(
              signal.aborted
                ? transportError(context)
                : new TaggedError(
                    "provider_failure",
                    "Deezer returned invalid authentication JSON.",
                  ),
            );
          }
          if (signal.aborted) return err(transportError(context));
          const parsed = responseSchema.safeParse(body);
          if (!parsed.success)
            return err(
              new TaggedError(
                "provider_failure",
                "Deezer returned an invalid authentication response.",
              ),
            );
          if (Object.keys(parsed.data.error).length > 0) {
            return err(
              new TaggedError("authentication_failed", "The Deezer ARL is invalid or expired."),
            );
          }
          const parsedUser = userSchema.safeParse(parsed.data.results);
          if (!parsedUser.success)
            return err(
              new TaggedError("provider_failure", "Deezer returned invalid account data."),
            );
          const user = parsedUser.data.USER;
          if (/^0+$/.test(user.USER_ID))
            return err(
              new TaggedError("authentication_failed", "The Deezer ARL is invalid or expired."),
            );
          if (user.BLOG_NAME === undefined)
            return err(
              new TaggedError(
                "provider_failure",
                "Deezer returned an account without a display name.",
              ),
            );
          return ok({ id: user.USER_ID, displayName: user.BLOG_NAME });
        }),
        () => transportError(context),
      ).andThen((result) => result);
    },
    // This capability validates credentials only. Hosts own retention and deletion.
    signOut() {
      return okAsync(undefined);
    },
  };
}
