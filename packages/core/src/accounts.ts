import { TaggedError } from "@sonory/provider-sdk";
import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";

const providerId = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const savedAccountSchema = z.strictObject({
  providerId,
  id: z.string().min(1),
  displayName: z.string(),
});
export type SavedAccount = z.infer<typeof savedAccountSchema>;

export const accountSettingsSchema = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(1),
    accounts: z.array(savedAccountSchema),
    defaultProviderId: providerId.optional(),
    defaultAccounts: z.record(providerId, z.string().min(1)),
  })
  .superRefine((settings, context) => {
    const identities = new Set<string>();
    for (const account of settings.accounts) {
      const identity = JSON.stringify([account.providerId, account.id]);
      if (identities.has(identity))
        context.addIssue({ code: "custom", message: "Duplicate account identity." });
      identities.add(identity);
    }
    for (const [provider, id] of Object.entries(settings.defaultAccounts)) {
      if (!identities.has(JSON.stringify([provider, id])))
        context.addIssue({ code: "custom", message: "Default account does not exist." });
    }
    if (
      settings.defaultProviderId !== undefined &&
      !settings.accounts.some((account) => account.providerId === settings.defaultProviderId)
    ) {
      context.addIssue({ code: "custom", message: "Default provider has no accounts." });
    }
  });
export type AccountSettings = z.infer<typeof accountSettingsSchema>;

export function emptyAccountSettings(): AccountSettings {
  return {
    $schema: new URL("../accounts.schema.json", import.meta.url).href,
    version: 1,
    accounts: [],
    defaultAccounts: {},
  };
}

export class AccountSelectionRequired extends TaggedError<"account_selection_required"> {
  constructor(readonly accounts: readonly SavedAccount[]) {
    super("account_selection_required", "Choose an account for this provider.");
  }
}

export class ProviderSelectionRequired extends TaggedError<"provider_selection_required"> {
  constructor(readonly providerIds: readonly string[]) {
    super("provider_selection_required", "Choose a provider.");
  }
}

export type AccountSelectionError =
  | AccountSelectionRequired
  | ProviderSelectionRequired
  | TaggedError<"account_required">
  | TaggedError<"unknown_account">;

export function selectAccount(
  settings: AccountSettings,
  requested: { readonly providerId?: string; readonly accountId?: string } = {},
): Result<SavedAccount, AccountSelectionError> {
  const providers = [...new Set(settings.accounts.map((account) => account.providerId))];
  const provider =
    requested.providerId ??
    settings.defaultProviderId ??
    (providers.length === 1 ? providers[0] : undefined);
  if (provider === undefined) {
    return providers.length === 0
      ? err(new TaggedError("account_required", "Sign in to an account first."))
      : err(new ProviderSelectionRequired(providers));
  }
  const accounts = settings.accounts.filter((account) => account.providerId === provider);
  const id = requested.accountId ?? settings.defaultAccounts[provider];
  if (id !== undefined) {
    const account = accounts.find((candidate) => candidate.id === id);
    return account === undefined
      ? err(
          new TaggedError(
            "unknown_account",
            "The selected account does not exist for this provider.",
          ),
        )
      : ok(account);
  }
  const onlyAccount = accounts.length === 1 ? accounts[0] : undefined;
  if (onlyAccount !== undefined) return ok(onlyAccount);
  return accounts.length === 0
    ? err(new TaggedError("account_required", "Sign in to an account for this provider first."))
    : err(new AccountSelectionRequired(accounts));
}
