import assert from "node:assert/strict";

import { TaggedError } from "@sonory/provider-sdk";
import type {
  AudioFormat,
  AuthCapability,
  CatalogCapability,
  DownloadCapability,
  DownloadStream,
  ExtensionCapability,
  Page,
  Provider,
  ProviderOperationError,
  Track,
} from "@sonory/provider-sdk";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { InvalidProviderError, ProviderRegistry } from "./index.js";

const track: Track = {
  ref: { providerId: "catalog-only", id: "native-track" },
  title: "Fixture track",
  artists: ["Fixture artist"],
};
const format: AudioFormat = {
  id: "original",
  extension: "wav",
  mediaType: "audio/wav",
  lossless: true,
};

function catalogProvider() {
  return {
    id: "catalog-only",
    name: "Catalog fixture",
    version: "0.0.0",
    apiVersion: 1,
    catalog: {
      search: vi.fn<CatalogCapability["search"]>(() =>
        okAsync({ items: [track], nextCursor: "next-page" }),
      ),
      getTrack: vi.fn<CatalogCapability["getTrack"]>(() => okAsync(track)),
    },
    extensions: {
      "fixture:lyrics": {
        execute: vi.fn<ExtensionCapability["execute"]>(() => okAsync("Fixture lyrics")),
      },
    },
  } satisfies Provider;
}

function downloadProvider() {
  const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
  const stream = {
    read: vi.fn<DownloadStream["read"]>(() => okAsync(chunks.shift() ?? null)),
    close: vi.fn<DownloadStream["close"]>(() => okAsync(undefined)),
  };
  return {
    id: "download-only",
    name: "Download fixture",
    version: "0.0.0",
    apiVersion: 1,
    download: {
      listFormats: vi.fn<DownloadCapability["listFormats"]>(() => okAsync([format])),
      open: vi.fn<DownloadCapability["open"]>(() => okAsync({ stream, format, contentLength: 4 })),
    },
  } satisfies Provider;
}

describe("ProviderRegistry", () => {
  test("catalog and download providers register independently without authentication", () => {
    const registry = new ProviderRegistry();
    expect(registry.register(catalogProvider())).toEqual(ok(undefined));
    expect(registry.register(downloadProvider())).toEqual(ok(undefined));
    expect(registry.list()).toEqual([
      {
        id: "catalog-only",
        name: "Catalog fixture",
        version: "0.0.0",
        apiVersion: 1,
        capabilities: ["catalog"],
        extensions: ["fixture:lyrics"],
      },
      {
        id: "download-only",
        name: "Download fixture",
        version: "0.0.0",
        apiVersion: 1,
        capabilities: ["download"],
        extensions: [],
      },
    ]);
  });

  test.each([
    null,
    {},
    { ...catalogProvider(), id: "Invalid provider ID" },
    { ...catalogProvider(), apiVersion: 2 },
    { ...catalogProvider(), catalog: { search: () => okAsync({ items: [] }) } },
    { ...catalogProvider(), auth: {} },
    { ...catalogProvider(), download: {} },
    { ...catalogProvider(), extensions: { lyrics: "Unnamespaced extension" } },
    { ...catalogProvider(), extensions: { "fixture:lyrics": {} } },
  ])("invalid providers return tagged validation issues: %j", (provider) => {
    const registry = new ProviderRegistry();
    const result = registry.register(provider);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    assert(error.tag === "invalid_provider");
    expectTypeOf(error).toEqualTypeOf<InvalidProviderError>();
    expect(error).toBeInstanceOf(InvalidProviderError);
    expect(error.issues.length).toBeGreaterThan(0);
    expect(registry.list()).toEqual([]);
  });

  test("duplicate IDs return an error without replacing the existing provider", async () => {
    const registry = new ProviderRegistry();
    const provider = catalogProvider();
    expect(registry.register(provider).isOk()).toBe(true);

    const result = registry.register({ ...provider, name: "Replacement" });
    expect(result._unsafeUnwrapErr().tag).toBe("duplicate_provider");
    expect((await registry.search(provider.id, { query: "Fixture" })).isOk()).toBe(true);
    expect(provider.catalog.search).toHaveBeenCalledOnce();
  });

  test("search preserves pagination and forwards the cancellation signal", async () => {
    const registry = new ProviderRegistry();
    const provider = catalogProvider();
    expect(registry.register(provider).isOk()).toBe(true);
    const request = { query: "Fixture", cursor: "current-page", limit: 10 };
    const context = { signal: new AbortController().signal };

    expect(await registry.search(provider.id, request, context)).toEqual(
      ok({
        items: [track],
        nextCursor: "next-page",
      }),
    );
    expect(provider.catalog.search).toHaveBeenCalledWith(request, context);
    expect((await registry.getTrack(track.ref, context))._unsafeUnwrap()).toBe(track);
    expect(provider.catalog.getTrack).toHaveBeenCalledWith(track.ref.id, context);
  });

  test("download dispatch preserves the source ID and reads byte results through EOF", async () => {
    const registry = new ProviderRegistry();
    const provider = downloadProvider();
    expect(registry.register(catalogProvider()).isOk()).toBe(true);
    expect(registry.register(provider).isOk()).toBe(true);
    const ref = { providerId: provider.id, id: "source-track" };
    const context = { signal: new AbortController().signal };

    expect(await registry.listFormats(ref, context)).toEqual(ok([format]));
    const source = (await registry.openDownload(ref, format.id, context))._unsafeUnwrap();
    expect((await source.stream.read())._unsafeUnwrap()).toEqual(Uint8Array.of(1, 2));
    expect((await source.stream.read())._unsafeUnwrap()).toEqual(Uint8Array.of(3, 4));
    expect(await source.stream.read()).toEqual(ok(null));
    expect(await source.stream.close()).toEqual(ok(undefined));
    expect(source.format).toBe(format);
    expect(source.contentLength).toBe(4);
    expect(provider.download.listFormats).toHaveBeenCalledWith(ref.id, context);
    expect(provider.download.open).toHaveBeenCalledWith(ref.id, format.id, context);
  });

  test("authentication input and account handling stay with the provider", async () => {
    const registry = new ProviderRegistry();
    const account = { id: "account-1", displayName: "Fixture user" };
    const provider = {
      id: "auth-only",
      name: "Auth fixture",
      version: "0.0.0",
      apiVersion: 1,
      auth: {
        authenticate: vi.fn<AuthCapability["authenticate"]>(() => okAsync(account)),
        signOut: vi.fn<AuthCapability["signOut"]>(() => okAsync(undefined)),
      },
    } satisfies Provider;
    expect(registry.register(provider).isOk()).toBe(true);
    const input = { token: "fixture-token" };
    const context = { signal: new AbortController().signal };

    expect((await registry.authenticate(provider.id, input, context))._unsafeUnwrap()).toBe(
      account,
    );
    expect(provider.auth.authenticate).toHaveBeenCalledWith(input, context);
    expect(await registry.signOut(provider.id, context)).toEqual(ok(undefined));
    expect(provider.auth.signOut).toHaveBeenCalledWith(context);
  });

  test("missing capabilities return an error without selecting another provider", async () => {
    const registry = new ProviderRegistry();
    const provider = downloadProvider();
    expect(registry.register(catalogProvider()).isOk()).toBe(true);
    expect(registry.register(provider).isOk()).toBe(true);

    expect((await registry.openDownload(track.ref, format.id))._unsafeUnwrapErr().tag).toBe(
      "unsupported_capability",
    );
    expect(provider.download.open).not.toHaveBeenCalled();
    expect((await registry.search("missing", { query: "Fixture" }))._unsafeUnwrapErr().tag).toBe(
      "unknown_provider",
    );
  });

  test("already cancelled operations return the reason without reaching the provider", async () => {
    const registry = new ProviderRegistry();
    const provider = catalogProvider();
    expect(registry.register(provider).isOk()).toBe(true);
    const controller = new AbortController();
    const reason = new Error("Cancelled by the caller");
    controller.abort(reason);

    const result = await registry.search(
      provider.id,
      { query: "Fixture" },
      { signal: controller.signal },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ tag: "cancelled", cause: reason });
    expect(provider.catalog.search).not.toHaveBeenCalled();
  });

  test("declared provider errors preserve their identity", async () => {
    const registry = new ProviderRegistry();
    const provider = catalogProvider();
    const error = new TaggedError("rate_limited", "Try again later.");
    provider.catalog.search.mockReturnValueOnce(errAsync(error));
    expect(registry.register(provider).isOk()).toBe(true);

    expect((await registry.search(provider.id, { query: "Fixture" }))._unsafeUnwrapErr()).toBe(
      error,
    );
  });

  test.each(["throw", "reject"] as const)(
    "unexpected provider %s becomes an error result",
    async (failure) => {
      const registry = new ProviderRegistry();
      const provider = catalogProvider();
      const cause = new Error("Unexpected provider failure");
      provider.catalog.search.mockImplementationOnce(() => {
        if (failure === "throw") {
          throw cause;
        }
        return new ResultAsync<Page<Track>, ProviderOperationError>(Promise.reject(cause));
      });
      expect(registry.register(provider).isOk()).toBe(true);

      const result = await registry.search(provider.id, { query: "Fixture" });
      expect(result._unsafeUnwrapErr()).toMatchObject({ tag: "provider_failure", cause });
    },
  );

  test("provider-specific extensions return results without becoming standard capabilities", async () => {
    const registry = new ProviderRegistry();
    const provider = catalogProvider();
    expect(registry.register(provider).isOk()).toBe(true);
    const input = { trackId: track.ref.id };
    const context = { signal: new AbortController().signal };

    expect(await registry.invokeExtension(provider.id, "fixture:lyrics", input, context)).toEqual(
      ok("Fixture lyrics"),
    );
    expect(provider.extensions["fixture:lyrics"].execute).toHaveBeenCalledWith(input, context);
    expect(
      (await registry.invokeExtension(provider.id, "fixture:missing", input))._unsafeUnwrapErr()
        .tag,
    ).toBe("unsupported_extension");
  });

  test.each([() => ({ items: [track] }), () => err(new Error("Untagged provider error"))])(
    "invalid provider return contracts become tagged errors",
    async (search) => {
      const registry = new ProviderRegistry();
      const provider = catalogProvider();
      expect(
        registry.register({ ...provider, catalog: { ...provider.catalog, search } }).isOk(),
      ).toBe(true);

      const result = await registry.search(provider.id, { query: "Fixture" });
      expect(result._unsafeUnwrapErr().tag).toBe("provider_failure");
    },
  );

  test("schema validation preserves class capabilities and their private state", async () => {
    class Catalog implements CatalogCapability {
      #queries = 0;

      search(): ResultAsync<Page<Track>, ProviderOperationError> {
        this.#queries += 1;
        return okAsync({ items: [], nextCursor: String(this.#queries) });
      }

      getTrack(): ResultAsync<Track, ProviderOperationError> {
        return okAsync(track);
      }
    }
    const registry = new ProviderRegistry();
    const provider = { ...catalogProvider(), catalog: new Catalog() };
    expect(registry.register(provider).isOk()).toBe(true);
    expect(
      (await registry.search(provider.id, { query: "Fixture" }))._unsafeUnwrap().nextCursor,
    ).toBe("1");
    expect(
      (await registry.search(provider.id, { query: "Fixture" }))._unsafeUnwrap().nextCursor,
    ).toBe("2");
  });

  test("throwing getters during validation return an invalid-provider result", () => {
    const cause = new Error("Broken manifest getter");
    const provider = {
      ...catalogProvider(),
      get id(): string {
        throw cause;
      },
    };
    const registry = new ProviderRegistry();
    expect(registry.register(provider)._unsafeUnwrapErr()).toMatchObject({
      tag: "invalid_provider",
      cause,
    });
    expect(registry.list()).toEqual([]);
  });

  test("provider summaries stay stable if the original manifest changes", () => {
    const registry = new ProviderRegistry();
    const provider = catalogProvider();
    expect(registry.register(provider).isOk()).toBe(true);
    provider.name = "Changed after registration";
    expect(registry.list()[0]?.name).toBe("Catalog fixture");
  });

  test("stream failures and cancellation return errors while cleanup remains available", async () => {
    const registry = new ProviderRegistry();
    const provider = downloadProvider();
    const cause = new Error("Connection closed");
    const stream = {
      read: vi.fn<DownloadStream["read"]>(() => new ResultAsync(Promise.reject(cause))),
      close: vi.fn<DownloadStream["close"]>(() => okAsync(undefined)),
    };
    provider.download.open.mockReturnValueOnce(okAsync({ stream, format }));
    expect(registry.register(provider).isOk()).toBe(true);
    const controller = new AbortController();
    const source = (
      await registry.openDownload({ providerId: provider.id, id: "source-track" }, format.id, {
        signal: controller.signal,
      })
    )._unsafeUnwrap();

    expect((await source.stream.read())._unsafeUnwrapErr()).toMatchObject({
      tag: "provider_failure",
      cause,
    });
    controller.abort();
    expect((await source.stream.read())._unsafeUnwrapErr().tag).toBe("cancelled");
    expect(stream.read).toHaveBeenCalledOnce();
    expect(await source.stream.close()).toEqual(ok(undefined));
    expect(stream.close).toHaveBeenCalledOnce();
  });

  test("ResultAsync operations can be composed without exposing raw promises", async () => {
    const registry = new ProviderRegistry();
    expect(registry.register(catalogProvider()).isOk()).toBe(true);
    const operation = registry.search("catalog-only", { query: "Fixture" });
    expect(operation).toBeInstanceOf(ResultAsync);
    expect(await operation.map((page) => page.items.length)).toEqual(ok(1));
  });
});
