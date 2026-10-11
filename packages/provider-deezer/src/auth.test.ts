import assert from "node:assert/strict";
import { inspect } from "node:util";

import { expect, test, vi } from "vitest";

import { createDeezerProvider } from "./index.js";

const arl = "a".repeat(192);
const account = {
  error: [],
  results: {
    USER: { USER_ID: 42, BLOG_NAME: "Listener", OPTIONS: { license_token: "private" } },
    checkForm: "private",
  },
};

function setup(body: unknown = account) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(body)));
  const provider = createDeezerProvider(fetch);
  assert(provider.auth !== undefined);
  return { fetch, auth: provider.auth };
}

test("ARL validation posts a cookie over HTTPS and returns only account identity", async () => {
  const { fetch, auth } = setup();
  const result = await auth.authenticate({ arl: `\n ${arl} \n` }, {});
  expect(result._unsafeUnwrap()).toEqual({ id: "42", displayName: "Listener" });
  expect(fetch).toHaveBeenCalledOnce();
  const call = fetch.mock.calls[0];
  assert(call !== undefined);
  expect(call[0]).toBe(
    "https://www.deezer.com/ajax/gw-light.php?api_version=1.0&api_token=null&input=3&method=deezer.getUserData",
  );
  expect(call[1]).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { Cookie: `arl=${arl}`, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  expect(inspect(result, { depth: null })).not.toContain(arl);
  expect(inspect(result, { depth: null })).not.toContain("private");
});

test("string user IDs and empty object errors are accepted", async () => {
  const { auth } = setup({
    error: {},
    results: { USER: { USER_ID: "42", BLOG_NAME: "Listener" } },
  });
  expect((await auth.authenticate({ arl }, {}))._unsafeUnwrap()).toEqual({
    id: "42",
    displayName: "Listener",
  });
});

test.each([
  { arl: "" },
  { arl: "arl=abcdef" },
  { arl: "abc\r\nCookie: injected" },
  { arl: "a".repeat(4097) },
  {},
  { arl: 1 },
])("invalid credentials are rejected before HTTP: %j", async (input) => {
  const { fetch, auth } = setup();
  expect((await auth.authenticate(input, {}))._unsafeUnwrapErr().tag).toBe("invalid_input");
  expect(fetch).not.toHaveBeenCalled();
});

test.each([0, "0"])("anonymous user ID %j means invalid or expired ARL", async (id) => {
  const { auth } = setup({ error: [], results: { USER: { USER_ID: id } } });
  expect((await auth.authenticate({ arl }, {}))._unsafeUnwrapErr().tag).toBe(
    "authentication_failed",
  );
});

test.each([
  { error: { GATEWAY_ERROR: arl }, results: {} },
  { error: [arl], results: {} },
  { error: [], results: { USER: { USER_ID: -1 } } },
  { error: [], results: { USER: { USER_ID: 42 } } },
  { reflected: arl },
])("gateway failures do not expose payloads: %j", async (body) => {
  const { auth } = setup(body);
  const result = await auth.authenticate({ arl }, {});
  expect(result.isErr()).toBe(true);
  expect(inspect(result, { depth: null })).not.toContain(arl);
  expect(result._unsafeUnwrapErr().cause).toBeUndefined();
});

test.each([
  { status: 403, tag: "authentication_failed" },
  { status: 429, tag: "rate_limited" },
  { status: 503, tag: "unavailable" },
])("HTTP $status returns $tag without reflecting the body", async ({ status, tag }) => {
  const { fetch, auth } = setup();
  fetch.mockResolvedValueOnce(new Response(arl, { status }));
  const result = await auth.authenticate({ arl }, {});
  expect(result._unsafeUnwrapErr().tag).toBe(tag);
  expect(inspect(result, { depth: null })).not.toContain(arl);
});

test("invalid JSON cannot expose a reflected credential", async () => {
  const { fetch, auth } = setup();
  fetch.mockResolvedValueOnce(new Response(arl));
  const result = await auth.authenticate({ arl }, {});
  expect(result._unsafeUnwrapErr().tag).toBe("provider_failure");
  expect(inspect(result, { depth: null })).not.toContain(arl);
});

test("transport exceptions cannot expose the Cookie header", async () => {
  const { fetch, auth } = setup();
  fetch.mockRejectedValueOnce(new Error(`Request failed: Cookie arl=${arl}`));
  const result = await auth.authenticate({ arl }, {});
  expect(result._unsafeUnwrapErr().tag).toBe("unavailable");
  expect(inspect(result, { depth: null })).not.toContain(arl);
});

test("pre-cancelled validation never sends the credential", async () => {
  const { fetch, auth } = setup();
  const result = await auth.authenticate({ arl }, { signal: AbortSignal.abort() });
  expect(result._unsafeUnwrapErr().tag).toBe("cancelled");
  expect(fetch).not.toHaveBeenCalled();
});

test("cancellation during validation aborts the request", async () => {
  const { fetch, auth } = setup();
  const controller = new AbortController();
  fetch.mockImplementationOnce(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        assert(init?.signal != null);
        init.signal.addEventListener("abort", () => reject(new Error(arl)), { once: true });
      }),
  );
  const operation = auth.authenticate({ arl }, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  const result = await operation;
  expect(result._unsafeUnwrapErr().tag).toBe("cancelled");
  expect(inspect(result, { depth: null })).not.toContain(arl);
});

test("sign-out is local and sends no credential or gateway logout request", async () => {
  const { fetch, auth } = setup();
  expect((await auth.signOut({})).isOk()).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
