# Architecture

Sonory is a provider-neutral music workbench. A CLI talks to music providers
through one small SDK, so a new provider never changes the CLI. This document
explains how the pieces fit and what it takes to add a provider. The README
covers setup and account storage.

## Workspace

**`packages/provider-sdk`.** The contract. It defines the provider interfaces
and `TaggedError`, the only error type providers may return. It depends on
neverthrow and nothing else.

**`packages/core`.** The registry. It validates provider manifests with Zod,
routes capability calls, checks every provider result, and owns downloads to
disk. It knows nothing about any specific provider.

**`packages/provider-deezer`.** A provider implementation. It signs in with an
ARL cookie, searches the catalog, discovers formats, and decrypts Blowfish
media while streaming.

**`packages/provider-fixture`.** A deterministic fake provider for tests. Its
download is a 440 Hz tone as a real WAV file, so tests exercise actual file
publication.

**`apps/cli`.** Argument parsing, help text, prompts, and output. Renderers
turn results into JSON for pipes or tables for terminals.

## Request flow

A command such as `sonory search deezer "Daft Punk"` reaches `runCommand` in
`apps/cli/src/commands.ts`, which calls `ProviderRegistry.search`. The registry
finds the provider by ID, then calls its `catalog.search` capability.

Every provider call passes through one wrapper, `#run` in
`packages/core/src/index.ts`. The wrapper aborts cancelled operations before
the provider runs, awaits the call, and checks the returned value against
`operationResultSchema`. A provider must return `ok(...)` or
`err(new TaggedError(...))`. A thrown exception becomes a `provider_failure`
error with the exception as the cause. The registry also re-wraps each download
stream so that cancelled operations surface as errors on every read.

## Downloads

Downloads cross three layers. The CLI resolves the format, either from an
explicit argument or from an interactive chooser that lists the provider
formats. `downloadToFile` in `packages/core/src/download.ts` then opens a
source through `registry.openDownload`, which delegates to the provider. The
provider returns a `DownloadSource`: a `read`/`close` stream plus format
metadata.

`downloadToFile` writes each chunk to a `.sonory-<uuid>.part` file and hard
links that file to the target when the stream ends. Hard links never replace an
existing file. On any failure the code closes the stream, closes the file, and
removes the temp file. It reports progress as written bytes and elapsed time
through an optional callback.

For Deezer, the media itself is encrypted on the wire. `openEncryptedDownload`
fetches the CDN URL over HTTPS from deezer.com or dzcdn.net hosts only, then
`decryptDownloadSource` wraps the stream. The wrapper decrypts the first 2048
bytes of every 6144-byte segment with Blowfish CBC. It also strips the zero
padding Deezer adds at the front, and it checks the wire byte count itself.
Decrypted sources carry `encrypted: false` and no content length, because the
padding length is unknown until the stream ends. A short stream therefore
reports `incomplete_download` from the wrapper instead of from the file writer.
The Blowfish implementation lives in `packages/provider-deezer/src/crypto.ts`
and passes the official test vectors from Eric Young's suite.

## Errors

Fallible operations return `Result` or `ResultAsync` from neverthrow. Raw
values are for operations that cannot fail. Errors are `TaggedError` instances
with tags from a fixed union, such as `unavailable`, `rate_limited`, and
`incomplete_download`. The tags are the real contract. The CLI maps them to
messages and exit codes, and tests assert on them. Keep the union small and add
a tag only when a consumer must react to it differently.

## Adding a provider

1. Create `packages/provider-<id>` with a `create<Name>Provider` factory. Take
   a `fetchImplementation` parameter so tests can inject responses.
2. Implement the capabilities you support. The registry advertises what exists,
   and every capability is optional.
3. Validate every network response with Zod. Turn a parse failure into
   `provider_failure` with the Zod error as the cause.
4. Register the provider with `registry.register(provider)` and add tests next
   to the source. Mock `fetch` with `vi.fn` and `Response.json`.

Two rules keep providers safe. Send credentials only to the provider's own API
hosts. Media and CDN requests carry no cookies, and the Deezer provider asserts
this in tests. Never fetch a URL that an API response supplied, such as a
pagination link or a media source. Reconstruct the request from IDs instead, so
a compromised API response cannot redirect credentials.

## Conventions

Colocated `*.test.ts` files cover each package. `pnpm check` runs formatting,
linting, typechecking, and the full test suite in one command. Commits use
present-tense titles. See CONTRIBUTING.md.
