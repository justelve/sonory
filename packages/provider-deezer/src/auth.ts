import { TaggedError } from "@sonory/provider-sdk";
import type { AuthCapability } from "@sonory/provider-sdk";
import { err, errAsync, ok, okAsync } from "neverthrow";

import { createGateway, credentialsSchema, userSchema } from "./gateway.js";

export function createDeezerAuth(fetchImplementation: typeof fetch): AuthCapability {
  const auth: AuthCapability = {
    signIn(host, context) {
      return host
        .requestCredentials([{ id: "arl", label: "Deezer ARL", secret: true }], context)
        .andThen((credentials) =>
          auth.authenticate(credentials, context).map((account) => ({ account, credentials })),
        );
    },
    authenticate(input, context) {
      const credentials = credentialsSchema.safeParse(input);
      if (!credentials.success)
        return errAsync(
          new TaggedError(
            "invalid_input",
            "Provide a Deezer ARL cookie value containing only hexadecimal characters.",
          ),
        );
      return createGateway(fetchImplementation, credentials.data.arl, context)
        .request("deezer.getUserData", "null", {}, userSchema)
        .andThen((parsedUser) => {
          const user = parsedUser.USER;
          if (/^0+$/.test(user.USER_ID))
            return err(
              new TaggedError("authentication_failed", "The Deezer ARL is invalid or expired."),
            );
          if (user.BLOG_NAME === undefined)
            return err(
              new TaggedError(
                "provider_failure",
                "Deezer returned an account without a display name.",
              ),
            );
          return ok({ id: user.USER_ID, displayName: user.BLOG_NAME });
        });
    },
    // This capability validates credentials only. Hosts own retention and deletion.
    signOut() {
      return okAsync(undefined);
    },
  };
  return auth;
}
