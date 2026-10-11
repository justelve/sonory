import assert from "node:assert/strict";

import type { SearchRequest } from "@sonory/provider-sdk";
import { ResultAsync } from "neverthrow";
import { expect, test, vi } from "vitest";

import { createDeezerProvider } from "./index.js";

const track = {
  id: 3135556,
  title: "Harder, Better, Faster, Stronger",
  artist: { name: "Daft Punk" },
  album: { title: "Discovery" },
  duration: 226,
  isrc: "GBDUW0000059",
  link: "https://www.deezer.com/track/3135556",
};

function setup(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(body)));
  const provider = createDeezerProvider(fetch);
  assert(provider.catalog !== undefined);
  return { fetch, provider, catalog: provider.catalog };
}

test("search normalizes tracks, encodes queries, and produces offset cursors", async () => {
  const { fetch, catalog } = setup({
    data: [track],
    total: 2,
    next: "https://api.deezer.com/search/track?index=1",
    ignored: true,
  });
  const operation = catalog.search({ query: "  Daft Punk & friends  ", limit: 1 }, {});
  expect(operation).toBeInstanceOf(ResultAsync);
  const page = (await operation)._unsafeUnwrap();
  expect(page).toEqual({
    items: [
      {
        ref: { providerId: "deezer", id: "3135556" },
        title: track.title,
        artists: ["Daft Punk"],
        album: "Discovery",
        durationMs: 226000,
        isrc: track.isrc,
        url: track.link,
      },
    ],
    nextCursor: "1",
  });
  assert(page.nextCursor !== undefined);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.deezer.com/search/track?q=Daft+Punk+%26+friends&limit=1&index=0",
    expect.any(Object),
  );
  expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  fetch.mockResolvedValueOnce(Response.json({ data: [track] }));
  expect(
    (
      await catalog.search({ query: "Daft Punk & friends", limit: 1, cursor: page.nextCursor }, {})
    )._unsafeUnwrap().nextCursor,
  ).toBeUndefined();
  expect(fetch).toHaveBeenLastCalledWith(
    "https://api.deezer.com/search/track?q=Daft+Punk+%26+friends&limit=1&index=1",
    expect.any(Object),
  );
});

test("empty searches succeed and the default page limit is 25", async () => {
  const { fetch, catalog } = setup({ data: [] });
  expect((await catalog.search({ query: "unknown" }, {}))._unsafeUnwrap()).toEqual({ items: [] });
  expect(fetch).toHaveBeenCalledWith(
    "https://api.deezer.com/search/track?q=unknown&limit=25&index=0",
    expect.any(Object),
  );
});

test("track lookup preserves all unique contributor names", async () => {
  const { catalog } = setup({ ...track, contributors: [{ name: "Daft Punk" }, { name: "Guest" }] });
  expect((await catalog.getTrack("3135556", {}))._unsafeUnwrap().artists).toEqual([
    "Daft Punk",
    "Guest",
  ]);
});

test("optional track metadata may be absent", async () => {
  const { catalog } = setup({
    id: track.id,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    link: track.link,
  });
  const result = (await catalog.getTrack("3135556", {}))._unsafeUnwrap();
  expect(result).not.toHaveProperty("album");
  expect(result).not.toHaveProperty("isrc");
});

test.each([
  { query: " " },
  { query: "tone", limit: 0 },
  { query: "tone", limit: 101 },
  { query: "tone", limit: 1.5 },
  { query: "tone", cursor: "-1" },
  { query: "tone", cursor: "https://example.com/" },
  { query: "tone", cursor: "9007199254740992" },
])("invalid search requests do not reach the network: %j", async (input: SearchRequest) => {
  const { catalog, fetch } = setup({ data: [] });
  expect((await catalog.search(input, {}))._unsafeUnwrapErr().tag).toBe("invalid_input");
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["0", "-1", "01", "1/../../user/me", "https://example.com", "1?x=y"])(
  "invalid track ID never reaches the network: %s",
  async (id) => {
    const { catalog, fetch } = setup(track);
    expect((await catalog.getTrack(id, {}))._unsafeUnwrapErr().tag).toBe("invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([
  { status: 429, tag: "rate_limited" },
  { status: 404, tag: "not_found" },
  { status: 401, tag: "authentication_failed" },
  { status: 403, tag: "authentication_failed" },
  { status: 503, tag: "unavailable" },
  { status: 400, tag: "provider_failure" },
])("HTTP $status becomes $tag and releases the response body", async ({ status, tag }) => {
  const { fetch, catalog } = setup({});
  const response = new Response("error", { status });
  assert(response.body !== null);
  const cancel = vi.spyOn(response.body, "cancel");
  fetch.mockResolvedValueOnce(response);
  expect((await catalog.search({ query: "tone" }, {}))._unsafeUnwrapErr().tag).toBe(tag);
  expect(cancel).toHaveBeenCalledOnce();
});

test.each([
  { code: 800, tag: "not_found" },
  { code: 999, tag: "provider_failure" },
])("API errors inside HTTP 200 preserve Deezer code $code", async ({ code, tag }) => {
  const error = { code, message: "no data", type: "DataException" };
  const { catalog } = setup({ error });
  expect((await catalog.getTrack("3135556", {}))._unsafeUnwrapErr()).toMatchObject({
    tag,
    cause: error,
  });
});

test.each([
  {},
  { data: [{ ...track, id: "3135556" }] },
  { data: [{ ...track, duration: -1 }] },
  { data: [{ ...track, artist: null }] },
])("invalid catalog responses return schema errors: %j", async (body) => {
  const { catalog } = setup(body);
  const failure = (await catalog.search({ query: "tone" }, {}))._unsafeUnwrapErr();
  expect(failure.tag).toBe("provider_failure");
  expect(failure.cause).toMatchObject({ name: "ZodError" });
});

test("invalid JSON is distinct from a transport failure", async () => {
  const { fetch, catalog } = setup({});
  fetch.mockResolvedValueOnce(new Response("<html>error</html>"));
  expect((await catalog.search({ query: "tone" }, {}))._unsafeUnwrapErr()).toMatchObject({
    tag: "provider_failure",
    message: "Deezer returned invalid JSON.",
  });
});

test.each(["throw", "reject"] as const)("fetch %s returns an unavailable result", async (mode) => {
  const { fetch, catalog } = setup({});
  const cause = new Error("offline");
  fetch.mockImplementationOnce(() => {
    if (mode === "throw") throw cause;
    return Promise.reject(cause);
  });
  expect((await catalog.search({ query: "tone" }, {}))._unsafeUnwrapErr()).toMatchObject({
    tag: "unavailable",
    cause,
  });
});

test("pre-cancelled requests never reach fetch", async () => {
  const { fetch, catalog } = setup({});
  const reason = new Error("cancelled");
  expect(
    (
      await catalog.search({ query: "tone" }, { signal: AbortSignal.abort(reason) })
    )._unsafeUnwrapErr(),
  ).toMatchObject({ tag: "cancelled", cause: reason });
  expect(fetch).not.toHaveBeenCalled();
});

function pendingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      assert(init?.signal != null);
      const signal = init.signal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

test("cancellation aborts an in-flight HTTP request", async () => {
  const controller = new AbortController();
  const provider = createDeezerProvider(pendingFetch());
  assert(provider.catalog !== undefined);
  const operation = provider.catalog.search({ query: "tone" }, { signal: controller.signal });
  await Promise.resolve();
  controller.abort("user cancelled");
  expect((await operation)._unsafeUnwrapErr()).toMatchObject({
    tag: "cancelled",
    cause: "user cancelled",
  });
});

test("timeouts return unavailable rather than user cancellation", async () => {
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(AbortSignal.abort(new DOMException("Timed out", "TimeoutError")));
  const provider = createDeezerProvider(pendingFetch());
  assert(provider.catalog !== undefined);
  expect((await provider.catalog.search({ query: "tone" }, {}))._unsafeUnwrapErr().tag).toBe(
    "unavailable",
  );
  expect(timeout).toHaveBeenCalledWith(15000);
});

test("cancellation during JSON reading returns cancelled", async () => {
  const controller = new AbortController();
  const { fetch, catalog } = setup({});
  const response = Response.json(track);
  vi.spyOn(response, "json").mockImplementationOnce(() => {
    controller.abort();
    return Promise.reject(new Error("Body aborted"));
  });
  fetch.mockResolvedValueOnce(response);
  expect(
    (await catalog.getTrack("3135556", { signal: controller.signal }))._unsafeUnwrapErr().tag,
  ).toBe("cancelled");
});

test("unexpected track IDs and non-advancing pages are rejected", async () => {
  const { fetch, catalog } = setup({ ...track, id: 42 });
  expect((await catalog.getTrack("3135556", {}))._unsafeUnwrapErr().tag).toBe("provider_failure");
  fetch.mockResolvedValueOnce(
    Response.json({ data: [], next: "https://api.deezer.com/search/track?index=0" }),
  );
  expect((await catalog.search({ query: "tone" }, {}))._unsafeUnwrapErr().tag).toBe(
    "provider_failure",
  );
});

test("response next URLs never control the request destination", async () => {
  const { fetch, catalog } = setup({ data: [track], next: "https://example.com/private" });
  const page = (await catalog.search({ query: "tone" }, {}))._unsafeUnwrap();
  expect(page.nextCursor).toBe("1");
  expect(fetch).toHaveBeenCalledWith(
    "https://api.deezer.com/search/track?q=tone&limit=25&index=0",
    expect.any(Object),
  );
});

test("the provider advertises authentication, catalog, formats, and encrypted downloads", () => {
  const { provider, catalog } = setup({});
  expect(provider.auth).toBeDefined();
  expect(provider.download).toBeDefined();
  expect(provider.formats).toBeDefined();
  expect(provider.catalog).toBe(catalog);
});
