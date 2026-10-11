import { TaggedError } from "@sonory/provider-sdk";
import type { AudioFormat, OperationContext, ProviderOperationError } from "@sonory/provider-sdk";
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
  {
    id: "MP3_128",
    extension: "mp3",
    mediaType: "audio/mpeg",
    lossless: false,
    bitrateKbps: 128,
    encrypted: true,
  },
  {
    id: "MP3_320",
    extension: "mp3",
    mediaType: "audio/mpeg",
    lossless: false,
    bitrateKbps: 320,
    encrypted: true,
  },
  { id: "FLAC", extension: "flac", mediaType: "audio/flac", lossless: true, encrypted: true },
] as const satisfies readonly AudioFormat[];

export function createDeezerFormats(fetchImplementation: typeof fetch) {
  function trackAccess(trackId: string, context: OperationContext) {
    if (!idSchema.safeParse(trackId).success)
      return errAsync(
        new TaggedError("invalid_input", "Deezer track IDs must be positive decimal integers."),
      );
    if (context.session === undefined)
      return errAsync(
        new TaggedError("authentication_failed", "Sign in to Deezer before accessing track media."),
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
          return err(new TaggedError("provider_failure", "Deezer returned invalid account data."));
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
              new TaggedError("provider_failure", "Deezer returned invalid account entitlements."),
            );
      })
      .andThen((account) => {
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
          .andThen((track) => {
            if (track.SNG_ID !== trackId)
              return err(
                new TaggedError("provider_failure", "Deezer returned a different track ID."),
              );
            const candidates = formats.filter((format) => {
              if (track[`FILESIZE_${format.id}`] === 0) return false;
              if (format.id === "MP3_320") return options.web_hq || options.mobile_hq;
              if (format.id === "FLAC") return options.web_lossless || options.mobile_lossless;
              return true;
            });
            return ok({ options, track, candidates });
          });
      });
  }

  function resolveMedia(
    license: string,
    trackToken: string,
    format: AudioFormat,
    context: OperationContext,
  ) {
    return requestJson(
      fetchImplementation,
      "https://media.deezer.com/v1/get_url",
      {
        license_token: license,
        media: [{ type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format: format.id }] }],
        track_tokens: [trackToken],
      },
      mediaSchema,
      context,
    ).andThen(
      (
        response,
      ): Result<
        NonNullable<z.infer<typeof mediaSchema>["data"][number]["media"]>,
        ProviderOperationError
      > => {
        const entry = response.data[0];
        if (entry?.errors !== undefined && entry.errors.length > 0) {
          const regional = entry.errors.some((error) => error.code === 2002);
          return err(
            new TaggedError(
              regional ? "unavailable" : "provider_failure",
              regional
                ? "This Deezer track is unavailable in the account's region."
                : "Deezer rejected full-track format access.",
            ),
          );
        }
        if (entry?.media === undefined)
          return err(
            new TaggedError("provider_failure", "Deezer returned no format access information."),
          );
        return ok(entry.media);
      },
    );
  }

  return {
    listFormats(
      trackId: string,
      context: OperationContext,
    ): ResultAsync<readonly AudioFormat[], ProviderOperationError> {
      return trackAccess(trackId, context).andThen(({ options, track, candidates }) =>
        ResultAsync.combine(
          candidates.map((format) =>
            resolveMedia(options.license_token, track.TRACK_TOKEN, format, context).map((media) =>
              media.some(
                (item) =>
                  item.media_type === "FULL" &&
                  item.format === format.id &&
                  item.sources.length > 0,
              )
                ? format
                : null,
            ),
          ),
        ).map((available) => available.filter((format) => format !== null)),
      );
    },
    resolveSource(
      trackId: string,
      formatId: string,
      context: OperationContext,
    ): ResultAsync<
      { url: string; contentLength: number; format: AudioFormat },
      ProviderOperationError
    > {
      const format = formats.find((candidate) => candidate.id === formatId);
      if (format === undefined)
        return errAsync(
          new TaggedError(
            "invalid_input",
            "Unknown Deezer format. Use the formats command to list supported format IDs.",
          ),
        );
      return trackAccess(trackId, context).andThen(({ options, track, candidates }) => {
        if (!candidates.includes(format))
          return errAsync(
            new TaggedError(
              "unavailable",
              "The selected format is unavailable for this account or track.",
            ),
          );
        return resolveMedia(options.license_token, track.TRACK_TOKEN, format, context).andThen(
          (media) => {
            const source = media.find(
              (item) => item.media_type === "FULL" && item.format === formatId,
            )?.sources[0];
            if (source === undefined)
              return err(
                new TaggedError("unavailable", "Deezer did not provide the requested format."),
              );
            return ok({ url: source.url, contentLength: track[`FILESIZE_${format.id}`], format });
          },
        );
      });
    },
  };
}
