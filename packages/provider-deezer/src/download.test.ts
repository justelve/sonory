import assert from "node:assert/strict";
import { inspect } from "node:util";

import { expect, test, vi } from "vitest";

import { openEncryptedDownload } from "./download.js";

const source = {
  url: "https://e-cdns-proxy-1.dzcdn.net/private-signed-url",
  contentLength: 6,
  format: { id: "MP3_128", extension: "mp3", mediaType: "audio/mpeg" },
};

function setup(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));
  return { fetch, open: () => openEncryptedDownload(fetch, source, {}) };
}

test("streams encrypted bytes unchanged with the requested format metadata", async () => {
  const chunks = [Uint8Array.of(255, 0), Uint8Array.of(13, 17, 254), Uint8Array.of(128)];
  const cancel = vi.fn<() => void>();
  const { fetch, open } = setup(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
        cancel,
      }),
      { headers: { "Content-Length": "6" } },
    ),
  );
  const download = (await open())._unsafeUnwrap();
  expect(download.format).toEqual(source.format);
  expect(download.contentLength).toBe(6);
  const received: number[] = [];
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Consume chunks in stream order.
    const chunk = (await download.stream.read())._unsafeUnwrap();
    if (chunk === null) break;
    received.push(...chunk);
  }
  expect(received).toEqual([255, 0, 13, 17, 254, 128]);
  expect((await download.stream.read())._unsafeUnwrap()).toBeNull();
  (await download.stream.close())._unsafeUnwrap();
  (await download.stream.close())._unsafeUnwrap();
  expect(fetch).toHaveBeenCalledWith(
    source.url,
    expect.objectContaining({
      redirect: "error",
      headers: { "Accept-Encoding": "identity" },
    }),
  );
  expect(inspect(download, { depth: null })).not.toContain("private-signed-url");
});

test("early close cancels the response and rejects subsequent reads", async () => {
  const cancel = vi.fn<() => void>();
  const { open } = setup(new Response(new ReadableStream<Uint8Array>({ cancel })));
  const download = (await open())._unsafeUnwrap();
  (await download.stream.close())._unsafeUnwrap();
  (await download.stream.close())._unsafeUnwrap();
  expect(cancel).toHaveBeenCalledOnce();
  expect((await download.stream.read())._unsafeUnwrapErr().tag).toBe("unavailable");
});

test.each([
  "http://e-cdns-proxy-1.dzcdn.net/audio",
  "https://dzcdn.net.example.com/audio",
  "https://example.com/audio",
  "https://user:password@cdn.deezer.com/audio",
  "https://cdn.deezer.com:8443/audio",
])("unsupported media URL is rejected before HTTP: %s", async (url) => {
  const { fetch } = setup(new Response());
  expect((await openEncryptedDownload(fetch, { ...source, url }, {}))._unsafeUnwrapErr().tag).toBe(
    "provider_failure",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["5", "7", "invalid", "9007199254740992"])(
  "invalid content length %s cancels the body",
  async (length) => {
    const response = new Response(Uint8Array.of(1), { headers: { "Content-Length": length } });
    assert(response.body !== null);
    const cancel = vi.spyOn(response.body, "cancel");
    const { open } = setup(response);
    expect((await open())._unsafeUnwrapErr().tag).toBe("provider_failure");
    expect(cancel).toHaveBeenCalledOnce();
  },
);

test("unexpected compression is rejected instead of changing encrypted bytes", async () => {
  const { open } = setup(
    new Response(Uint8Array.of(1), { headers: { "Content-Encoding": "gzip" } }),
  );
  expect((await open())._unsafeUnwrapErr().tag).toBe("provider_failure");
});

test.each([206, 403, 404, 429, 503])("HTTP %s never creates a stream", async (status) => {
  const response = new Response("private-signed-url", { status });
  assert(response.body !== null);
  const cancel = vi.spyOn(response.body, "cancel");
  const { open } = setup(response);
  const result = await open();
  expect(result._unsafeUnwrapErr().tag).toBe(status === 429 ? "rate_limited" : "unavailable");
  expect(cancel).toHaveBeenCalledOnce();
  expect(inspect(result, { depth: null })).not.toContain("private-signed-url");
});

test("pre-cancelled download never reaches HTTP", async () => {
  const { fetch } = setup(new Response());
  expect(
    (await openEncryptedDownload(fetch, source, { signal: AbortSignal.abort() }))._unsafeUnwrapErr()
      .tag,
  ).toBe("cancelled");
  expect(fetch).not.toHaveBeenCalled();
});

test("read failures hide transport details and close the reader", async () => {
  const { open } = setup(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("private-signed-url"));
        },
      }),
    ),
  );
  const download = (await open())._unsafeUnwrap();
  const result = await download.stream.read();
  expect(result._unsafeUnwrapErr().tag).toBe("unavailable");
  expect(result._unsafeUnwrapErr().cause).toBeUndefined();
  expect((await download.stream.close())._unsafeUnwrapErr().tag).toBe("provider_failure");
});

test("cancellation interrupts a pending read and cleanup remains successful", async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
    assert(init?.signal != null);
    const signal = init.signal;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            signal.addEventListener("abort", () => stream.error(new Error("private-signed-url")), {
              once: true,
            });
          },
        }),
      ),
    );
  });
  const download = (
    await openEncryptedDownload(fetch, source, { signal: controller.signal })
  )._unsafeUnwrap();
  const pending = download.stream.read();
  await Promise.resolve();
  controller.abort();
  expect((await pending)._unsafeUnwrapErr().tag).toBe("cancelled");
  (await download.stream.close())._unsafeUnwrap();
});

test("a stalled read times out with a safe error", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      assert(init?.signal != null);
      const signal = init.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              signal.addEventListener(
                "abort",
                () => stream.error(new Error("private-signed-url")),
                { once: true },
              );
            },
          }),
        ),
      );
    });
    const download = (await openEncryptedDownload(fetch, source, {}))._unsafeUnwrap();
    const pending = download.stream.read();
    await vi.advanceTimersByTimeAsync(15000);
    expect((await pending)._unsafeUnwrapErr().tag).toBe("unavailable");
    (await download.stream.close())._unsafeUnwrap();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
