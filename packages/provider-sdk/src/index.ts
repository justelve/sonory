import type { ResultAsync } from "neverthrow";

import type { ProviderOperationError } from "./errors.js";

export { TaggedError } from "./errors.js";
export type { ProviderOperationError } from "./errors.js";

export interface ProviderManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1;
}

export interface OperationContext {
  readonly signal?: AbortSignal;
  readonly session?: ProviderSession;
}

export interface Account {
  readonly id: string;
  readonly displayName: string;
}

export interface ProviderSession {
  readonly account: Account;
  readonly credentials: Readonly<Record<string, unknown>>;
}

export interface CredentialField {
  readonly id: string;
  readonly label: string;
  readonly secret: boolean;
}

export interface SignInHost {
  requestCredentials(
    fields: readonly CredentialField[],
    context: OperationContext,
  ): ResultAsync<Readonly<Record<string, unknown>>, ProviderOperationError>;
}

export interface AuthCapability {
  signIn?(
    host: SignInHost,
    context: OperationContext,
  ): ResultAsync<ProviderSession, ProviderOperationError>;
  authenticate(
    input: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): ResultAsync<Account, ProviderOperationError>;
  signOut(context: OperationContext): ResultAsync<void, ProviderOperationError>;
}

export interface TrackRef {
  readonly providerId: string;
  readonly id: string;
}

export interface Track {
  readonly ref: TrackRef;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly durationMs?: number;
  readonly isrc?: string;
  readonly url?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface SearchRequest {
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CatalogCapability {
  search(
    request: SearchRequest,
    context: OperationContext,
  ): ResultAsync<Page<Track>, ProviderOperationError>;
  getTrack(id: string, context: OperationContext): ResultAsync<Track, ProviderOperationError>;
}

export interface AudioFormat {
  readonly id: string;
  readonly extension: string;
  readonly mediaType: string;
  readonly lossless?: boolean;
  readonly bitrateKbps?: number;
  readonly sampleRateHz?: number;
  readonly bitDepth?: number;
  readonly encrypted?: boolean;
}

export interface DownloadStream {
  read(): ResultAsync<Uint8Array | null, ProviderOperationError>;
  close(): ResultAsync<void, ProviderOperationError>;
}

export interface DownloadSource {
  readonly stream: DownloadStream;
  readonly format: AudioFormat;
  readonly contentLength?: number;
}

export interface FormatsCapability {
  listFormats(
    trackId: string,
    context: OperationContext,
  ): ResultAsync<readonly AudioFormat[], ProviderOperationError>;
}

export interface DownloadCapability extends FormatsCapability {
  open(
    trackId: string,
    formatId: string,
    context: OperationContext,
  ): ResultAsync<DownloadSource, ProviderOperationError>;
}

export interface ProviderCapabilities {
  readonly auth: AuthCapability;
  readonly catalog: CatalogCapability;
  readonly formats: FormatsCapability;
  readonly download: DownloadCapability;
}

export type Capability = keyof ProviderCapabilities;

export type ExtensionId = `${string}:${string}`;

export interface ExtensionCapability {
  execute(input: unknown, context: OperationContext): ResultAsync<unknown, ProviderOperationError>;
}

export interface Provider extends ProviderManifest, Partial<ProviderCapabilities> {
  readonly extensions?: Readonly<Record<ExtensionId, ExtensionCapability>>;
}

export interface ProviderSummary extends ProviderManifest {
  readonly capabilities: readonly Capability[];
  readonly extensions: readonly string[];
}
