import { TaggedError } from "@sonory/provider-sdk";
import type {
  OperationContext,
  Provider,
  ProviderOperationError,
  Track,
} from "@sonory/provider-sdk";
import { err, errAsync, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";

import { createDeezerAuth } from "./auth.js";
import { createDeezerFormats } from "./formats.js";

const idSchema = z.string().regex(/^[1-9]\d*$/);
const cursorSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const searchRequestSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: cursorSchema.optional(),
});
const artistSchema = z.object({ name: z.string() });
const trackSchema = z.object({
  id: z.number().int().positive().safe(),
  title: z.string(),
  artist: artistSchema,
  contributors: z.array(artistSchema).optional(),
  album: z.object({ title: z.string() }).optional(),
  duration: z.number().int().nonnegative(),
  isrc: z.string().optional(),
  link: z.url(),
});
const pageSchema = z.object({
  data: z.array(trackSchema),
  next: z.url().optional(),
});
const errorSchema = z.object({
  error: z.object({ code: z.number().int(), message: z.string(), type: z.string() }),
});

function toTrack(track: z.infer<typeof trackSchema>): Track {
  return {
    ref: { providerId: "deezer", id: String(track.id) },
    title: track.title,
    artists: [
      ...new Set([track.artist.name, ...(track.contributors?.map((artist) => artist.name) ?? [])]),
    ],
    durationMs: track.duration * 1000,
    url: track.link,
    ...(track.album === undefined ? {} : { album: track.album.title }),
    ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
  };
}

function transportError(context: OperationContext, cause: unknown): ProviderOperationError {
  return context.signal?.aborted === true
    ? new TaggedError("cancelled", "Deezer request was cancelled.", {
        cause: context.signal.reason,
      })
    : new TaggedError("unavailable", "Deezer request failed or timed out.", { cause });
}

function httpError(status: number): ProviderOperationError {
  const message = `Deezer returned HTTP ${status}.`;
  if (status === 429) return new TaggedError("rate_limited", message);
  if (status === 404) return new TaggedError("not_found", message);
  if (status === 401 || status === 403) return new TaggedError("authentication_failed", message);
  if (status >= 500) return new TaggedError("unavailable", message);
  return new TaggedError("provider_failure", message);
}

export function createDeezerProvider(fetchImplementation: typeof fetch = fetch): Provider {
  function request<T>(
    path: string,
    schema: z.ZodType<T>,
    context: OperationContext,
  ): ResultAsync<T, ProviderOperationError> {
    return ResultAsync.fromPromise(
      Promise.resolve().then(async (): Promise<Result<T, ProviderOperationError>> => {
        if (context.signal?.aborted === true)
          return err(transportError(context, context.signal.reason));
        const timeout = AbortSignal.timeout(15000);
        const signal =
          context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
        const response = await fetchImplementation(`https://api.deezer.com/${path}`, { signal });
        if (!response.ok) {
          await response.body?.cancel();
          return err(httpError(response.status));
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (cause) {
          if (signal.aborted) return err(transportError(context, cause));
          return err(
            new TaggedError("provider_failure", "Deezer returned invalid JSON.", { cause }),
          );
        }
        const apiError = errorSchema.safeParse(body);
        if (apiError.success) {
          const failure = apiError.data.error;
          return err(
            new TaggedError(
              failure.code === 800 ? "not_found" : "provider_failure",
              `Deezer error ${failure.code}: ${failure.message}`,
              { cause: failure },
            ),
          );
        }
        const parsed = schema.safeParse(body);
        return parsed.success
          ? ok(parsed.data)
          : err(
              new TaggedError("provider_failure", "Deezer returned an invalid response.", {
                cause: parsed.error,
              }),
            );
      }),
      (cause) => transportError(context, cause),
    ).andThen((result) => result);
  }

  return {
    id: "deezer",
    name: "Deezer",
    version: "0.0.0",
    apiVersion: 1,
    auth: createDeezerAuth(fetchImplementation),
    formats: createDeezerFormats(fetchImplementation),
    catalog: {
      search(input, context) {
        const parsed = searchRequestSchema.safeParse(input);
        if (!parsed.success)
          return errAsync(
            new TaggedError("invalid_input", "Invalid Deezer search request.", {
              cause: parsed.error,
            }),
          );
        const { query, limit, cursor } = parsed.data;
        const index = Number(cursor ?? "0");
        const params = new URLSearchParams({
          q: query,
          limit: String(limit),
          index: String(index),
        });
        return request(`search/track?${params.toString()}`, pageSchema, context).andThen((page) => {
          const next = index + page.data.length;
          if (page.next !== undefined && (page.data.length === 0 || !Number.isSafeInteger(next))) {
            return err(new TaggedError("provider_failure", "Deezer pagination did not advance."));
          }
          // Reconstruct offsets instead of fetching URLs supplied in API responses or cursors.
          return ok({
            items: page.data.map(toTrack),
            ...(page.next === undefined ? {} : { nextCursor: String(next) }),
          });
        });
      },
      getTrack(id, context) {
        const parsed = idSchema.safeParse(id);
        if (!parsed.success)
          return errAsync(
            new TaggedError(
              "invalid_input",
              "Deezer track IDs must be positive decimal integers.",
              { cause: parsed.error },
            ),
          );
        return request(`track/${parsed.data}`, trackSchema, context).andThen((track) => {
          if (String(track.id) !== id)
            return err(
              new TaggedError("provider_failure", "Deezer returned a different track ID."),
            );
          return ok(toTrack(track));
        });
      },
    },
  };
}
