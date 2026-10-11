import { stripVTControlCharacters, styleText } from "node:util";

import type { AccountSettings } from "@sonory/core";
import type { Account, AudioFormat, Page, ProviderSummary, Track } from "@sonory/provider-sdk";
import Table from "cli-table3";

export interface OutputOptions {
  readonly json: boolean;
  readonly columns: number;
  readonly color: boolean;
}
export const jsonOutput: OutputOptions = { json: true, columns: 80, color: false };
export type CommandOutput =
  | { readonly type: "providers"; readonly value: readonly ProviderSummary[] }
  | { readonly type: "search"; readonly value: Page<Track> }
  | { readonly type: "track"; readonly value: Track }
  | { readonly type: "formats"; readonly value: readonly AudioFormat[] }
  | { readonly type: "accounts"; readonly value: AccountSettings }
  | { readonly type: "account"; readonly value: Account; readonly providerId: string }
  | { readonly type: "download"; readonly value: { readonly path: string } }
  | { readonly type: "message"; readonly value: { readonly message: string } };

// Provider metadata is untrusted terminal text; preserve original values only in JSON.
export function terminalText(value: string): string {
  // Remove control bytes so metadata cannot send terminal commands.
  // oxlint-disable-next-line eslint/no-control-regex
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
const duration = (milliseconds?: number): string => {
  if (milliseconds === undefined) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function renderOutput(output: CommandOutput, options: OutputOptions = jsonOutput): string {
  if (options.json) return JSON.stringify(output.value, null, 2);
  const paint = (format: "bold" | "cyan" | "green" | "dim", value: string) =>
    options.color ? styleText(format, value, { validateStream: false }) : value;
  const table = (
    headers: readonly string[],
    rows: readonly (readonly string[])[],
    weights: readonly number[],
  ): string => {
    if (options.columns < 60) {
      return rows
        .map((row) =>
          headers
            .map((header, index) => `${paint("dim", header)}: ${terminalText(row[index] ?? "")}`)
            .join("\n"),
        )
        .join("\n\n");
    }
    const width = Math.min(options.columns, 140) - headers.length - 1;
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map((weight) => Math.floor((width * weight) / total));
    const rendered = new Table({
      head: headers.map((header) => paint("cyan", header)),
      colWidths: widths,
      wordWrap: true,
      style: { head: [], border: [], compact: true },
    });
    rendered.push(...rows.map((row) => row.map(terminalText)));
    return rendered.toString();
  };
  switch (output.type) {
    case "providers":
      return output.value.length === 0
        ? "No providers are installed."
        : table(
            ["Provider", "ID", "Features"],
            output.value.map((provider) => [
              provider.name,
              provider.id,
              provider.capabilities
                .map(
                  (capability) =>
                    ({ auth: "Sign-in", catalog: "Catalog", download: "Downloads" })[capability],
                )
                .join(", ") || "None",
            ]),
            [2, 2, 5],
          );
    case "search": {
      if (output.value.items.length === 0) return "No tracks found. Try a different search.";
      const rows = output.value.items.map((track) => [
        track.ref.id,
        track.title,
        track.artists.join(", "),
        duration(track.durationMs),
      ]);
      const next =
        output.value.nextCursor === undefined
          ? ""
          : `\n${paint("dim", `More results: repeat this search with --cursor ${terminalText(output.value.nextCursor)}.`)}`;
      return `${paint("bold", `${rows.length} ${rows.length === 1 ? "track" : "tracks"}`)}\n${table(["Track ID", "Title", "Artist", "Time"], rows, [2, 5, 4, 1])}${next}`;
    }
    case "track": {
      const track = output.value;
      return [
        paint("bold", terminalText(track.title)),
        terminalText(track.artists.join(", ")),
        `Provider: ${terminalText(track.ref.providerId)}`,
        `ID: ${terminalText(track.ref.id)}`,
        ...(track.album === undefined ? [] : [`Album: ${terminalText(track.album)}`]),
        `Time: ${duration(track.durationMs)}`,
        ...(track.isrc === undefined ? [] : [`ISRC: ${terminalText(track.isrc)}`]),
        ...(track.url === undefined ? [] : [terminalText(track.url)]),
      ].join("\n");
    }
    case "formats":
      return output.value.length === 0
        ? "No download formats are available for this track."
        : table(
            ["Format", "Type", "Quality"],
            output.value.map((format) => [
              format.id,
              format.mediaType,
              [
                format.lossless === true ? "Lossless" : "",
                format.bitrateKbps === undefined ? "" : `${format.bitrateKbps} kbps`,
                format.sampleRateHz === undefined ? "" : `${format.sampleRateHz / 1000} kHz`,
                format.bitDepth === undefined ? "" : `${format.bitDepth}-bit`,
              ]
                .filter(Boolean)
                .join(" · ") || "—",
            ]),
            [2, 3, 5],
          );
    case "accounts": {
      const settings = output.value;
      if (settings.accounts.length === 0) return "No saved accounts.\n\nSign in\n  sonory auth";
      const providerDefault =
        settings.defaultProviderId === undefined
          ? "Not set"
          : terminalText(settings.defaultProviderId);
      const counts = new Map<string, number>();
      for (const account of settings.accounts)
        counts.set(account.providerId, (counts.get(account.providerId) ?? 0) + 1);
      const rows = settings.accounts.map((account) => [
        account.providerId,
        account.displayName || "Unnamed account",
        account.id,
        settings.defaultAccounts[account.providerId] === account.id
          ? "Selected"
          : counts.get(account.providerId) === 1
            ? "Automatic"
            : "—",
      ]);
      return `${paint("bold", "Default provider")}\n  ${providerDefault}\n\n${table(["Provider", "Account", "Account ID", "Default account"], rows, [2, 4, 3, 3])}`;
    }
    case "account":
      return paint(
        "green",
        `Signed in as ${terminalText(output.value.displayName)} on ${terminalText(output.providerId)} (${terminalText(output.value.id)}).`,
      );
    case "download":
      return paint("green", `Downloaded ${terminalText(output.value.path)}`);
    case "message":
      return paint("green", terminalText(output.value.message));
  }
  const unreachable: never = output;
  return unreachable;
}

export function renderError(
  error: { readonly tag: string; readonly message: string },
  json: boolean,
  color: boolean,
): string {
  if (json) return JSON.stringify({ error: { tag: error.tag, message: error.message } });
  if (error.tag === "cancelled")
    return color ? styleText("red", "Cancelled.", { validateStream: false }) : "Cancelled.";
  const label = "Error";
  const heading = color ? styleText("red", label, { validateStream: false }) : label;
  const hint =
    error.tag === "authentication_failed"
      ? "\n\nSign in again\n  sonory auth"
      : error.tag === "rate_limited"
        ? "\n\nRetry\n  Wait before repeating this command."
        : error.tag === "unavailable"
          ? "\n\nRetry\n  Check your connection and try again."
          : error.tag === "io_failure"
            ? "\n\nDestination\n  Check that the directory is writable and the output file does not already exist."
            : error.tag === "unknown_provider"
              ? "\n\nAvailable providers\n  sonory providers"
              : error.tag === "unsupported_capability"
                ? "\n\nProvider features\n  sonory providers"
                : error.tag === "provider_selection_required"
                  ? "\n\nChoose a provider\n  Replace default with a provider ID from sonory accounts."
                  : error.tag === "unknown_account" ||
                      error.tag === "account_required" ||
                      error.tag === "credential_missing"
                    ? "\n\nSaved accounts\n  sonory accounts\n\nSign in\n  sonory auth"
                    : error.tag === "account_selection_required"
                      ? "\n\nChoose an account\n  --account <id>\n\nSet a default\n  sonory accounts default <provider> <account>"
                      : "";
  return `${heading}: ${terminalText(error.message)}${hint}`;
}
