import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { TaggedError } from "@sonory/provider-sdk";
import type { DownloadSource, OperationContext, TrackRef } from "@sonory/provider-sdk";
import { err, ok, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";

import type { OperationError, ProviderRegistry } from "./index.js";

export type DownloadError =
  | OperationError
  | TaggedError<"io_failure">
  | TaggedError<"incomplete_download">
  | TaggedError<"cleanup_failed">;

export interface DownloadProgress {
  readonly bytesWritten: number;
  readonly totalBytes?: number;
  readonly elapsedMs: number;
}

function defaultFilename(ref: TrackRef, source: DownloadSource): string {
  const parts = [ref.providerId, ref.id, source.format.id].map((part) =>
    part.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60),
  );
  const extension =
    source.format.encrypted === true
      ? "encrypted"
      : source.format.extension.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "bin";
  return `${parts.join("-")}.${extension}`;
}

export function downloadToFile(
  registry: ProviderRegistry,
  ref: TrackRef,
  formatId: string,
  destination: string | undefined,
  context: OperationContext = {},
  onProgress?: (progress: DownloadProgress) => void,
): ResultAsync<string, DownloadError> {
  return ResultAsync.fromPromise(
    (async (): Promise<Result<string, DownloadError>> => {
      let temporary: string | undefined;
      let file: FileHandle | undefined;
      let source: DownloadSource | undefined;
      let created = false;
      let result: Result<string, DownloadError>;
      try {
        result = await (async (): Promise<Result<string, DownloadError>> => {
          const opened = await registry.openDownload(ref, formatId, context);
          if (opened.isErr()) return err(opened.error);
          source = opened.value;
          const target = resolve(destination ?? defaultFilename(ref, source));
          temporary = join(dirname(target), `.sonory-${randomUUID()}.part`);
          file = await open(temporary, "wx");
          created = true;
          let bytes = 0;
          const started = performance.now();
          const report = () =>
            onProgress?.({
              bytesWritten: bytes,
              ...(source?.contentLength === undefined ? {} : { totalBytes: source.contentLength }),
              elapsedMs: performance.now() - started,
            });
          report();
          while (true) {
            // eslint-disable-next-line no-await-in-loop -- Read only after writing the previous chunk to bound memory.
            const chunk = await source.stream.read();
            if (chunk.isErr()) return err(chunk.error);
            if (chunk.value === null) break;
            let offset = 0;
            while (offset < chunk.value.byteLength) {
              if (context.signal?.aborted === true) return err(cancelled(context.signal));
              // eslint-disable-next-line no-await-in-loop -- Partial writes must finish in byte order.
              const written = await file.write(
                chunk.value,
                offset,
                chunk.value.byteLength - offset,
              );
              if (written.bytesWritten === 0)
                return err(new TaggedError("io_failure", "File write made no progress."));
              offset += written.bytesWritten;
              bytes += written.bytesWritten;
            }
            report();
          }
          if (source.contentLength !== undefined && bytes !== source.contentLength) {
            return err(
              new TaggedError(
                "incomplete_download",
                `Expected ${source.contentLength} bytes, received ${bytes}.`,
              ),
            );
          }
          const closed = await source.stream.close();
          source = undefined;
          if (closed.isErr()) return err(closed.error);
          await file.close();
          file = undefined;
          if (context.signal?.aborted === true) return err(cancelled(context.signal));
          // A hard link publishes the complete file atomically without replacing an existing target.
          await link(temporary, target);
          return ok(target);
        })();
      } catch (cause) {
        result = err(new TaggedError("io_failure", "Could not write the download.", { cause }));
      }
      const failures: unknown[] = [];
      if (source !== undefined) {
        const closed = await source.stream.close();
        if (closed.isErr()) failures.push(closed.error);
      }
      if (file !== undefined) {
        const closed = await ResultAsync.fromPromise(file.close(), (cause) => cause);
        if (closed.isErr()) failures.push(closed.error);
      }
      if (created && temporary !== undefined) {
        const removed = await ResultAsync.fromPromise(unlink(temporary), (cause) => cause);
        if (removed.isErr()) failures.push(removed.error);
      }
      if (failures.length > 0) {
        if (result.isErr()) failures.unshift(result.error);
        return err(
          new TaggedError("cleanup_failed", "Download cleanup failed.", {
            cause: new AggregateError(failures),
          }),
        );
      }
      return result;
    })(),
    (cause) => new TaggedError("io_failure", "Download failed unexpectedly.", { cause }),
  ).andThen((result) => result);
}

function cancelled(signal: AbortSignal): TaggedError<"cancelled"> {
  return new TaggedError("cancelled", "Download was cancelled.", { cause: signal.reason });
}
