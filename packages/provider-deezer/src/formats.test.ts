import assert from "node:assert/strict";
import { inspect } from "node:util";

import type { OperationContext } from "@sonory/provider-sdk";
import { expect, test, vi } from "vitest";

import { createDeezerProvider } from "./index.js";

const arl = "a".repeat(192);
const context: OperationContext = {
  session: { account: { id: "42", displayName: "Listener" }, credentials: { arl } },
};
const account = {
  USER: {
    USER_ID: 42,
    BLOG_NAME: "Listener",
    OPTIONS: {
      license_token: "private-license",
      web_hq: true,
      web_lossless: true,
    },
  },
  checkForm: "private-csrf",
};
const track = {
  SNG_ID: "3135556",
  TRACK_TOKEN: "private-track",
  FILESIZE_MP3_128: "1000",
  FILESIZE_MP3_320: 2000,
  FILESIZE_FLAC: "3000",
};

function media(format: string) {
  return {
    data: [
      {
        media: [
          {
            media_type: "FULL",
            format,
            sources: [{ url: "https://cdn.deezer.com/private-audio" }],
          },
        ],
      },
    ],
  };
}

function setup(userData: unknown = account, trackData: unknown = track) {
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    assert(typeof input === "string");
    const url = new URL(input);
    if (url.searchParams.get("method") === "deezer.getUserData")
      return Promise.resolve(
        Response.json(
          { error: [], results: userData },
          { headers: { "Set-Cookie": "sid=private-session; Path=/; Secure" } },
        ),
      );
    if (url.searchParams.get("method") === "song.getData")
      return Promise.resolve(Response.json({ error: {}, results: trackData }));
    assert.equal(url.href, "https://media.deezer.com/v1/get_url");
    assert(typeof init?.body === "string");
    const body: unknown = JSON.parse(init.body);
    assert(typeof body === "object" && body !== null && "media" in body);
    const requested = body.media;
    assert(Array.isArray(requested));
    const first: unknown = requested[0];
    assert(typeof first === "object" && first !== null && "formats" in first);
    assert(Array.isArray(first.formats));
    const entry: unknown = first.formats[0];
    assert(typeof entry === "object" && entry !== null && "format" in entry);
    return Promise.resolve(Response.json(media(String(entry.format))));
  });
  const provider = createDeezerProvider(fetch);
  assert(provider.formats !== undefined);
  return { fetch, formats: provider.formats };
}

test("formats verify exact media access and expose only audio metadata", async () => {
  const { fetch, formats } = setup();
  const result = await formats.listFormats("3135556", context);
  expect(result._unsafeUnwrap()).toEqual([
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
  ]);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(fetch.mock.calls[1]?.[0]).toBe(
    "https://www.deezer.com/ajax/gw-light.php?api_version=1.0&api_token=private-csrf&input=3&method=song.getData",
  );
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    redirect: "error",
    method: "POST",
    body: '{"SNG_ID":"3135556"}',
    headers: { Cookie: `arl=${arl}; sid=private-session` },
  });
  for (const call of fetch.mock.calls.slice(2)) {
    expect(call[1]?.headers).not.toHaveProperty("Cookie");
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    assert(typeof call[1]?.body === "string");
    const body: unknown = JSON.parse(call[1].body);
    expect(body).toMatchObject({
      license_token: "private-license",
      track_tokens: ["private-track"],
    });
  }
  expect(inspect(result, { depth: null })).not.toContain("private-");
  expect(inspect(result, { depth: null })).not.toContain(arl);
});

test("basic playback accounts never probe higher qualities", async () => {
  const { fetch, formats } = setup({
    ...account,
    USER: { ...account.USER, OPTIONS: { license_token: "private-license" } },
  });
  expect(
    (await formats.listFormats("3135556", context))._unsafeUnwrap().map((format) => format.id),
  ).toEqual(["MP3_128"]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("download resolution rejects unknown formats before sending credentials", async () => {
  const { fetch } = setup();
  const provider = createDeezerProvider(fetch);
  assert(provider.download !== undefined);
  expect((await provider.download.open("3135556", "unknown", context))._unsafeUnwrapErr().tag).toBe(
    "invalid_input",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("download resolution refuses a format outside the account entitlement", async () => {
  const { fetch } = setup({
    ...account,
    USER: { ...account.USER, OPTIONS: { license_token: "private-license" } },
  });
  const provider = createDeezerProvider(fetch);
  assert(provider.download !== undefined);
  expect((await provider.download.open("3135556", "FLAC", context))._unsafeUnwrapErr().tag).toBe(
    "unavailable",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("mobile entitlements and numeric user/track IDs are supported", async () => {
  const { formats } = setup(
    {
      ...account,
      USER: {
        ...account.USER,
        USER_ID: "42",
        OPTIONS: {
          license_token: "private-license",
          mobile_hq: true,
          mobile_lossless: true,
          encrypted: true,
        },
      },
    },
    { ...track, SNG_ID: 3135556 },
  );
  expect((await formats.listFormats("3135556", context))._unsafeUnwrap()).toHaveLength(3);
});

test("zero-sized encodings are not probed and no encodings returns an empty list", async () => {
  const { fetch, formats } = setup(account, {
    ...track,
    FILESIZE_MP3_128: 0,
    FILESIZE_MP3_320: "0",
    FILESIZE_FLAC: 0,
  });
  expect((await formats.listFormats("3135556", context))._unsafeUnwrap()).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(["FULL", "PREVIEW"])(
  "%s fallback responses never advertise higher qualities",
  async (type) => {
    const { fetch, formats } = setup();
    const implementation = fetch.getMockImplementation();
    assert(implementation !== undefined);
    fetch.mockImplementation((input, init) =>
      typeof input === "string" && input.startsWith("https://media.deezer.com/")
        ? Promise.resolve(
            Response.json({
              data: [
                {
                  media: [
                    {
                      media_type: type,
                      format: "MP3_128",
                      sources: [{ url: "https://cdn.deezer.com/preview" }],
                    },
                  ],
                },
              ],
            }),
          )
        : implementation(input, init),
    );
    expect(
      (await formats.listFormats("3135556", context))._unsafeUnwrap().map((format) => format.id),
    ).toEqual(type === "FULL" ? ["MP3_128"] : []);
  },
);

test.each([
  { error: { DATA_ERROR: "private-track" }, tag: "not_found" },
  { error: { VALID_TOKEN_REQUIRED: "private-csrf" }, tag: "authentication_failed" },
])("gateway track errors map to $tag without exposing payloads", async ({ error, tag }) => {
  const { fetch, formats } = setup();
  fetch.mockResolvedValueOnce(Response.json({ error: [], results: account }));
  fetch.mockResolvedValueOnce(Response.json({ error, results: {} }));
  const result = await formats.listFormats("3135556", context);
  expect(result._unsafeUnwrapErr().tag).toBe(tag);
  expect(inspect(result, { depth: null })).not.toContain("private-");
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("timeouts report unavailable without leaking credentials", async () => {
  const { fetch, formats } = setup();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(
    AbortSignal.abort(new Error("private-timeout")),
  );
  fetch.mockImplementationOnce((_input, init) => {
    assert(init?.signal?.aborted === true);
    return Promise.reject(new Error(arl));
  });
  const result = await formats.listFormats("3135556", context);
  expect(result._unsafeUnwrapErr().tag).toBe("unavailable");
  expect(result._unsafeUnwrapErr().cause).toBeUndefined();
});

test.each([0, "0", 99])(
  "expired or mismatched account %j stops before track lookup",
  async (id) => {
    const { fetch, formats } = setup({ USER: { USER_ID: id } });
    expect((await formats.listFormats("3135556", context))._unsafeUnwrapErr().tag).toBe(
      "authentication_failed",
    );
    expect(fetch).toHaveBeenCalledOnce();
  },
);

test.each(["0", "-1", "01", "1?url=https://example.com"])(
  "invalid track %s never reaches HTTP",
  async (id) => {
    const { fetch, formats } = setup();
    expect((await formats.listFormats(id, context))._unsafeUnwrapErr().tag).toBe("invalid_input");
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([
  {},
  {
    session: {
      account: { id: "42", displayName: "Listener" },
      credentials: { arl: "bad\r\nCookie: injected" },
    },
  },
])("missing or invalid credentials never reach HTTP", async (input: OperationContext) => {
  const { fetch, formats } = setup();
  expect((await formats.listFormats("3135556", input))._unsafeUnwrapErr().tag).toBe(
    "authentication_failed",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("an account without a playback license fails clearly", async () => {
  const { fetch, formats } = setup({
    ...account,
    USER: { ...account.USER, OPTIONS: { license_token: "" } },
  });
  expect((await formats.listFormats("3135556", context))._unsafeUnwrapErr().tag).toBe(
    "unavailable",
  );
  expect(fetch).toHaveBeenCalledOnce();
});

test.each([
  { ...track, SNG_ID: "99" },
  { ...track, TRACK_TOKEN: "" },
  { ...track, FILESIZE_FLAC: -1 },
  { ...track, FILESIZE_MP3_320: "9007199254740992" },
])("invalid track metadata is rejected without exposing tokens", async (data) => {
  const { formats } = setup(account, data);
  const result = await formats.listFormats("3135556", context);
  expect(result._unsafeUnwrapErr().tag).toBe("provider_failure");
  expect(inspect(result, { depth: null })).not.toContain("private-");
});

test.each([
  { body: { data: [{ errors: [{ code: 2002, message: arl }] }] }, tag: "unavailable" },
  {
    body: { data: [{ errors: [{ code: 9999, message: "private-license" }] }] },
    tag: "provider_failure",
  },
  { body: { data: [] }, tag: "provider_failure" },
  { body: { data: [{}] }, tag: "provider_failure" },
])("media errors return $tag without leaking access data", async ({ body, tag }) => {
  const { fetch, formats } = setup();
  const implementation = fetch.getMockImplementation();
  assert(implementation !== undefined);
  fetch.mockImplementation((input, init) =>
    typeof input === "string" && input.startsWith("https://media.deezer.com/")
      ? Promise.resolve(Response.json(body))
      : implementation(input, init),
  );
  const result = await formats.listFormats("3135556", context);
  expect(result._unsafeUnwrapErr().tag).toBe(tag);
  expect(inspect(result, { depth: null })).not.toContain(arl);
  expect(inspect(result, { depth: null })).not.toContain("private-");
});

test.each([
  { status: 401, tag: "authentication_failed" },
  { status: 429, tag: "rate_limited" },
  { status: 503, tag: "unavailable" },
])("HTTP $status maps to $tag", async ({ status, tag }) => {
  const { fetch, formats } = setup();
  fetch.mockResolvedValueOnce(new Response(arl, { status }));
  expect((await formats.listFormats("3135556", context))._unsafeUnwrapErr().tag).toBe(tag);
});

test("pre-cancelled discovery sends no requests", async () => {
  const { fetch, formats } = setup();
  expect(
    (
      await formats.listFormats("3135556", { ...context, signal: AbortSignal.abort() })
    )._unsafeUnwrapErr().tag,
  ).toBe("cancelled");
  expect(fetch).not.toHaveBeenCalled();
});

test("cancellation during discovery stops before subsequent requests", async () => {
  const { fetch, formats } = setup();
  const controller = new AbortController();
  fetch.mockImplementationOnce(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        assert(init?.signal != null);
        init.signal.addEventListener("abort", () => reject(new Error(arl)), { once: true });
      }),
  );
  const operation = formats.listFormats("3135556", { ...context, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  const result = await operation;
  expect(result._unsafeUnwrapErr().tag).toBe("cancelled");
  expect(inspect(result, { depth: null })).not.toContain(arl);
  expect(fetch).toHaveBeenCalledOnce();
});

test("transport exceptions cannot expose cookies or tokens", async () => {
  const { fetch, formats } = setup();
  fetch.mockRejectedValueOnce(new Error(`Cookie: arl=${arl}; private-license`));
  const result = await formats.listFormats("3135556", context);
  expect(result._unsafeUnwrapErr().tag).toBe("unavailable");
  expect(result._unsafeUnwrapErr().cause).toBeUndefined();
});
