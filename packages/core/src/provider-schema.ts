import { TaggedError } from "@sonory/provider-sdk";
import type { Provider } from "@sonory/provider-sdk";
import { Err, Ok } from "neverthrow";
import { z } from "zod";

const shape = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  apiVersion: z.literal(1),
  auth: z
    .object({ authenticate: z.function(), signOut: z.function(), signIn: z.function().optional() })
    .optional(),
  catalog: z.object({ search: z.function(), getTrack: z.function() }).optional(),
  download: z.object({ listFormats: z.function(), open: z.function() }).optional(),
  extensions: z
    .record(
      z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/),
      z.object({ execute: z.function() }),
    )
    .optional(),
});

// Preserve capability instances and their private state instead of using Zod's object copies.
export const providerSchema = z.custom<Provider>().superRefine((provider, context) => {
  const result = shape.safeParse(provider);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ ...issue });
    }
  }
});

export const operationResultSchema = z.union([
  z.instanceof(Ok),
  z.instanceof(Err).refine((result) => result.error instanceof TaggedError),
]);

export const sessionSchema = z.object({
  account: z.object({ id: z.string().min(1), displayName: z.string() }),
  credentials: z.record(z.string(), z.unknown()),
});
