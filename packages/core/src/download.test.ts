import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaggedError } from "@sonory/provider-sdk";
import type { DownloadStream, Provider } from "@sonory/provider-sdk";
import { errAsync, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { downloadToFile } from "./download.js";
import type { DownloadProgress } from "./download.js";
import { ProviderRegistry } from "./index.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sonory-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function setup(
  read: DownloadStream["read"],
  contentLength = 4,
  close: DownloadStream["close"] = () => okAsync(undefined),
) {
  const stream = {
    read: vi.fn<DownloadStream["read"]>(read),
    close: vi.fn<DownloadStream["close"]>(close),
  };
  const format = { id: "raw", extension: "bin", mediaType: "application/octet-stream" };
  const provider: Provider = {
    id: "test",
    name: "Test",
    version: "0",
    apiVersion: 1,
    download: {
      listFormats: () => okAsync([format]),
      open: () => okAsync({ stream, format, contentLength }),
    },
  };
  const registry = new ProviderRegistry();
  expect(registry.register(provider).isOk()).toBe(true);
  return { registry, stream, ref: { providerId: "test", id: "track" } };
}

describe("downloadToFile", () => {
  test("progress reports bytes written in order with the source's total", async () => {
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
    const { registry, ref } = setup(() => okAsync(chunks.shift() ?? null));
    const progress = vi.fn<(value: DownloadProgress) => void>();
    (
      await downloadToFile(registry, ref, "raw", join(directory, "track.bin"), {}, progress)
    )._unsafeUnwrap();
    expect(progress.mock.calls.map(([value]) => value.bytesWritten)).toEqual([0, 2, 4]);
    expect(progress.mock.calls.map(([value]) => value.totalBytes)).toEqual([4, 4, 4]);
    expect(progress.mock.calls.map(([value]) => value.elapsedMs)).toEqual(
      progress.mock.calls.map(([value]) => value.elapsedMs).toSorted((a, b) => a - b),
    );
  });

  test("default filenames stay in the current directory and use encrypted output metadata", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    const chunks = [Uint8Array.of(1, 2, 3, 4)];
    const { registry, stream, ref } = setup(() => okAsync(chunks.shift() ?? null));
    vi.spyOn(registry, "openDownload").mockReturnValueOnce(
      okAsync({
        stream,
        contentLength: 4,
        format: { id: "raw", extension: "mp3", mediaType: "audio/mpeg", encrypted: true },
      }),
    );
    const path = (
      await downloadToFile(registry, { ...ref, id: "../../CON:<track>" }, "raw", undefined)
    )._unsafeUnwrap();
    expect(path).toBe(join(directory, "test-.._.._CON__track_-raw.encrypted"));
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await readdir(directory)).toEqual(["test-.._.._CON__track_-raw.encrypted"]);
  });

  test("decrypted sources name files by audio extension and report indeterminate progress", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
    const { registry, stream, ref } = setup(() => okAsync(chunks.shift() ?? null));
    vi.spyOn(registry, "openDownload").mockReturnValueOnce(
      okAsync({
        stream,
        format: { id: "MP3_128", extension: "mp3", mediaType: "audio/mpeg", encrypted: false },
      }),
    );
    const progress = vi.fn<(value: DownloadProgress) => void>();
    const path = (
      await downloadToFile(registry, ref, "MP3_128", undefined, {}, progress)
    )._unsafeUnwrap();
    expect(path).toBe(join(directory, "test-track-MP3_128.mp3"));
    expect(progress.mock.calls.map(([value]) => value.bytesWritten)).toEqual([0, 2, 4]);
    expect(progress.mock.calls.map(([value]) => value.totalBytes)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await readdir(directory)).toEqual(["test-track-MP3_128.mp3"]);
  });

  test("publishes complete bytes and removes the temporary file", async () => {
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
    const { registry, stream, ref } = setup(() => okAsync(chunks.shift() ?? null));
    const target = join(directory, "track.bin");
    const result = await downloadToFile(registry, ref, "raw", target);
    expect(result._unsafeUnwrap()).toBe(target);
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await readdir(directory)).toEqual(["track.bin"]);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("preserves existing destinations", async () => {
    const chunks = [Uint8Array.of(1, 2, 3, 4)];
    const { registry, stream, ref } = setup(() => okAsync(chunks.shift() ?? null));
    const target = join(directory, "track.bin");
    await writeFile(target, "original");
    const result = await downloadToFile(registry, ref, "raw", target);
    expect(result._unsafeUnwrapErr().tag).toBe("io_failure");
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["track.bin"]);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("truncated streams never publish an output", async () => {
    const chunks = [Uint8Array.of(1, 2)];
    const { registry, stream, ref } = setup(() => okAsync(chunks.shift() ?? null));
    const result = await downloadToFile(registry, ref, "raw", join(directory, "track.bin"));
    expect(result._unsafeUnwrapErr().tag).toBe("incomplete_download");
    expect(await readdir(directory)).toEqual([]);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("read failures preserve the domain error and clean up partial bytes", async () => {
    const failure = new TaggedError("unavailable", "Connection lost.");
    let first = true;
    const { registry, stream, ref } = setup(() => {
      if (!first) return errAsync(failure);
      first = false;
      return okAsync(Uint8Array.of(1, 2));
    });
    const result = await downloadToFile(registry, ref, "raw", join(directory, "track.bin"));
    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(await readdir(directory)).toEqual([]);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("cancellation after a write closes the stream and removes partial bytes", async () => {
    const controller = new AbortController();
    let reads = 0;
    const { registry, stream, ref } = setup(() => {
      reads++;
      if (reads === 2) controller.abort();
      return okAsync(Uint8Array.of(1, 2));
    });
    const result = await downloadToFile(registry, ref, "raw", join(directory, "track.bin"), {
      signal: controller.signal,
    });
    expect(result._unsafeUnwrapErr().tag).toBe("cancelled");
    expect(stream.read).toHaveBeenCalledTimes(2);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  test("already cancelled downloads never open the stream", async () => {
    const { registry, stream, ref } = setup(() => okAsync(null));
    const result = await downloadToFile(registry, ref, "raw", join(directory, "track.bin"), {
      signal: AbortSignal.abort(),
    });
    expect(result._unsafeUnwrapErr().tag).toBe("cancelled");
    expect(stream.read).not.toHaveBeenCalled();
    expect(stream.close).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  test("filesystem open failures still close the provider stream", async () => {
    const { registry, stream, ref } = setup(() => okAsync(null));
    const result = await downloadToFile(
      registry,
      ref,
      "raw",
      join(directory, "missing", "track.bin"),
    );
    expect(result._unsafeUnwrapErr().tag).toBe("io_failure");
    expect(stream.close).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  test("close failures prevent publishing completed bytes", async () => {
    const failure = new TaggedError("unavailable", "Close failed.");
    const { registry, stream, ref } = setup(
      () => okAsync(null),
      0,
      () => errAsync(failure),
    );
    const result = await downloadToFile(registry, ref, "raw", join(directory, "track.bin"));
    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  test("cleanup failures preserve both the read and close errors", async () => {
    const readError = new TaggedError("unavailable", "Read failed.");
    const closeError = new TaggedError("provider_failure", "Close failed.");
    const { registry, stream, ref } = setup(
      () => errAsync(readError),
      4,
      () => errAsync(closeError),
    );
    const result = await downloadToFile(registry, ref, "raw", join(directory, "track.bin"));
    const failure = result._unsafeUnwrapErr();
    expect(failure.tag).toBe("cleanup_failed");
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(failure.cause).toMatchObject({ errors: [readError, closeError] });
    expect(stream.close).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });
});
