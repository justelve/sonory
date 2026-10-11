import { TaggedError } from "@sonory/provider-sdk";
import type { AudioFormat, FormatsCapability, ProviderOperationError } from "@sonory/provider-sdk";
import { err, errAsync, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";

import { createGateway, credentialsSchema, requestJson, userSchema } from "./gateway.js";

const idSchema = z.string().regex(/^[1-9]\d*$/);
const flag = z.boolean().optional().default(false);
const accountSchema = userSchema.extend({
  checkForm: z.string().min(1),
  USER: userSchema.shape.USER.extend({
    OPTIONS: z.object({
      license_token: z.string(),
      web_hq: flag,
      mobile_hq: flag,
      web_lossless: flag,
      mobile_lossless: flag,
    }),
  }),
});
const size = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().safe()),
]);
const trackSchema = z.object({
  SNG_ID: z.union([z.number().int().positive().safe(), idSchema]).transform(String),
  TRACK_TOKEN: z.string().min(1),
  FILESIZE_MP3_128: size,
  FILESIZE_MP3_320: size,
  FILESIZE_FLAC: size,
});
const mediaSchema = z.object({
  data: z
    .array(
      z.object({
        errors: z.array(z.object({ code: z.number().int() })).optional(),
        media: z
          .array(
            z.object({
              media_type: z.string(),
              format: z.string(),
              sources: z.array(z.object({ url: z.url() })),
            }),
          )
          .optional(),
      }),
    )
    .length(1),
});
const formats = [
  { id: "MP3_128", extension: "mp3", mediaType: "audio/mpeg", lossless: false, bitrateKbps: 128 },
  { id: "MP3_320", extension: "mp3", mediaType: "audio/mpeg", lossless: false, bitrateKbps: 320 },
  { id: "FLAC", extension: "flac", mediaType: "audio/flac", lossless: true },
] as const satisfies readonly AudioFormat[];

export function createDeezerFormats(fetchImplementation: typeof fetch): FormatsCapability {
  return {
    listFormats(trackId, context) {
      if (!idSchema.safeParse(trackId).success)
        return errAsync(
          new TaggedError("invalid_input", "Deezer track IDs must be positive decimal integers."),
        );
      if (context.session === undefined)
        return errAsync(
          new TaggedError("authentication_failed", "Sign in to Deezer before listing formats."),
        );
      const credentials = credentialsSchema.safeParse(context.session.credentials);
      if (!credentials.success)
        return errAsync(
          new TaggedError(
            "authentication_failed",
            "The saved Deezer credentials are invalid. Sign in again.",
          ),
        );
      const gateway = createGateway(fetchImplementation, credentials.data.arl, context);
      return gateway
        .request("deezer.getUserData", "null", {}, z.unknown())
        .andThen((body): Result<z.infer<typeof accountSchema>, ProviderOperationError> => {
          const identity = userSchema.safeParse(body);
          if (!identity.success)
            return err(
              new TaggedError("provider_failure", "Deezer returned invalid account data."),
            );
          if (
            /^0+$/.test(identity.data.USER.USER_ID) ||
            identity.data.USER.USER_ID !== context.session?.account.id
          )
            return err(
              new TaggedError(
                "authentication_failed",
                "The Deezer session has expired or belongs to a different account. Sign in again.",
              ),
            );
          const parsed = accountSchema.safeParse(body);
          return parsed.success
            ? ok(parsed.data)
            : err(
                new TaggedError(
                  "provider_failure",
                  "Deezer returned invalid account entitlements.",
                ),
              );
        })
        .andThen((account): ResultAsync<readonly AudioFormat[], ProviderOperationError> => {
          const options = account.USER.OPTIONS;
          if (options.license_token.length === 0)
            return errAsync(
              new TaggedError(
                "unavailable",
                "This Deezer account has no full-track playback access.",
              ),
            );
          return gateway
            .request("song.getData", account.checkForm, { SNG_ID: trackId }, trackSchema)
            .andThen((track): ResultAsync<readonly AudioFormat[], ProviderOperationError> => {
              if (track.SNG_ID !== trackId)
                return errAsync(
                  new TaggedError("provider_failure", "Deezer returned a different track ID."),
                );
              const candidates = formats.filter((format) => {
                if (track[`FILESIZE_${format.id}`] === 0) return false;
                if (format.id === "MP3_320") return options.web_hq || options.mobile_hq;
                if (format.id === "FLAC") return options.web_lossless || options.mobile_lossless;
                return true;
              });
              return ResultAsync.combine(
                candidates.map((format) =>
                  requestJson(
                    fetchImplementation,
                    "https://media.deezer.com/v1/get_url",
                    {
                      license_token: options.license_token,
                      media: [
                        { type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format: format.id }] },
                      ],
                      track_tokens: [track.TRACK_TOKEN],
                    },
                    mediaSchema,
                    context,
                  ).andThen((response): Result<AudioFormat | null, ProviderOperationError> => {
                    const entry = response.data[0];
                    if (entry?.errors !== undefined && entry.errors.length > 0)
                      return err<AudioFormat | null, ProviderOperationError>(
                        new TaggedError(
                          entry.errors.some((error) => error.code === 2002)
                            ? "unavailable"
                            : "provider_failure",
                          entry.errors.some((error) => error.code === 2002)
                            ? "This Deezer track is unavailable in the account's region."
                            : "Deezer rejected full-track format access.",
                        ),
                      );
                    if (entry?.media === undefined)
                      return err(
                        new TaggedError(
                          "provider_failure",
                          "Deezer returned no format access information.",
                        ),
                      );
                    // Verify the exact requested format; never advertise a fallback as a higher quality.
                    return ok(
                      entry.media.some(
                        (media) =>
                          media.media_type === "FULL" &&
                          media.format === format.id &&
                          media.sources.length > 0,
                      )
                        ? format
                        : null,
                    );
                  }),
                ),
              ).map((available) =>
                available.filter((format): format is AudioFormat => format !== null),
              );
            });
        });
    },
  };
}
