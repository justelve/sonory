import { TaggedError } from "@sonory/provider-sdk";
import type {
  AudioFormat,
  DownloadSource,
  OperationContext,
  ProviderOperationError,
} from "@sonory/provider-sdk";
import { err, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";

export function openEncryptedDownload(
  fetchImplementation: typeof fetch,
  source: { readonly url: string; readonly contentLength: number; readonly format: AudioFormat },
  context: OperationContext,
): ResultAsync<DownloadSource, ProviderOperationError> {
  const controller = new AbortController();
  const signal =
    context.signal === undefined
      ? controller.signal
      : AbortSignal.any([context.signal, controller.signal]);
  const failure = (): ProviderOperationError =>
    context.signal?.aborted === true
      ? new TaggedError("cancelled", "Deezer download was cancelled.")
      : new TaggedError("unavailable", "Deezer download failed or timed out.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startTimeout = () => {
    timer = setTimeout(() => controller.abort(), 15000);
    timer.unref();
  };
  const clearTimeoutTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return ResultAsync.fromPromise(
    Promise.resolve().then(async (): Promise<Result<DownloadSource, ProviderOperationError>> => {
      if (signal.aborted) return err(failure());
      const url = new URL(source.url);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        !["deezer.com", "dzcdn.net"].some(
          (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
        )
      )
        return err(
          new TaggedError("provider_failure", "Deezer returned an unsupported media host."),
        );
      startTimeout();
      let response: Response;
      try {
        response = await fetchImplementation(url.href, {
          signal,
          redirect: "error",
          headers: { "Accept-Encoding": "identity" },
        });
      } finally {
        clearTimeoutTimer();
      }
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel();
        return err(
          new TaggedError(
            response.status === 429 ? "rate_limited" : "unavailable",
            `Deezer media returned HTTP ${response.status}.`,
          ),
        );
      }
      const length = response.headers.get("Content-Length");
      if (
        length !== null &&
        (!/^\d+$/.test(length) ||
          !Number.isSafeInteger(Number(length)) ||
          Number(length) !== source.contentLength)
      ) {
        await response.body.cancel();
        return err(
          new TaggedError(
            "provider_failure",
            "Deezer media length does not match the requested track.",
          ),
        );
      }
      const encoding = response.headers.get("Content-Encoding");
      if (encoding !== null && encoding !== "identity") {
        await response.body.cancel();
        return err(
          new TaggedError("provider_failure", "Deezer returned an unexpected content encoding."),
        );
      }
      const reader = response.body.getReader();
      let closed = false;
      let ended = false;
      return ok({
        format: {
          ...source.format,
          encrypted: true,
          extension: "encrypted",
          mediaType: "application/octet-stream",
        },
        contentLength: source.contentLength,
        stream: {
          read() {
            return ResultAsync.fromPromise(
              Promise.resolve().then(async () => {
                if (closed)
                  return err(new TaggedError("unavailable", "Deezer download stream is closed."));
                if (signal.aborted) return err(failure());
                if (ended) return ok(null);
                startTimeout();
                try {
                  const chunk = await reader.read();
                  if (signal.aborted) return err(failure());
                  ended = chunk.done;
                  return ok(chunk.done ? null : chunk.value);
                } finally {
                  clearTimeoutTimer();
                }
              }),
              failure,
            ).andThen((result) => result);
          },
          close() {
            return ResultAsync.fromPromise(
              Promise.resolve().then(async () => {
                if (closed) return;
                closed = true;
                clearTimeoutTimer();
                try {
                  await reader.cancel();
                } catch (error) {
                  if (!signal.aborted) throw error;
                } finally {
                  reader.releaseLock();
                  controller.abort();
                }
              }),
              () =>
                new TaggedError("provider_failure", "Could not close the Deezer download stream."),
            );
          },
        },
      });
    }),
    failure,
  ).andThen((result) => result);
}
