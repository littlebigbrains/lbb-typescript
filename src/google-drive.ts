import type { FetchLike } from "./types.js";

/**
 * Google Drive for a developer's end customers: the two OAuth steps a
 * developer's server runs with its own Google app, before it creates a
 * `google_drive` connection with `integrations.create`.
 *
 * ```ts
 * import { googleDrive } from "@littlebigbrain/client";
 *
 * const url = googleDrive.authorizeUrl({ clientId, redirectUri, state });
 * // On the callback, after `state` matches:
 * const { credentials } = await googleDrive.exchangeCode({
 *   clientId, clientSecret, redirectUri, code,
 * });
 * await lbb.integrations.create({ graph, id: "google-drive", kind: "google_drive", credentials });
 * ```
 *
 * The connection renews its access token from the refresh token before each
 * sync. Nothing here talks to LBB.
 */

/** Read access to every file the person can read: the scope the connector needs. */
export const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A `google_drive` connection's credentials, keyed by their field names. */
export interface Credentials {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
}

/** What `exchangeCode` returns. */
export interface Grant {
  /** Send these to `integrations.create` with `kind: "google_drive"`. */
  credentials: Credentials;
  /** The scopes the person granted, space-separated. */
  scope: string;
}

export interface AuthorizeInput {
  clientId: string;
  /** Your callback URL, registered on the OAuth client. */
  redirectUri: string;
  /** An unguessable value you keep with the person's session and check on the callback. */
  state: string;
  /** The person's email, to preselect their Google account. */
  loginHint?: string;
  /** A PKCE S256 code challenge; send its verifier to `exchangeCode`. */
  codeChallenge?: string;
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The `code` of the callback. */
  code: string;
  /** The PKCE verifier of `codeChallenge`. */
  codeVerifier?: string;
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * The exchange failed. `code` is Google's OAuth error (`invalid_grant` for
 * a used or expired code), or `no_refresh_token` or `scope_not_granted`.
 */
export class GoogleOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

/**
 * The Google consent URL for one person. It asks for `drive.readonly` with
 * offline access and a consent prompt, so the code always gives a refresh
 * token, also to a person who granted access before.
 */
export function authorizeUrl(input: AuthorizeInput): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", input.state);
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/**
 * Exchange the callback's code for the connection's credentials. Fails with
 * a `GoogleOAuthError` when Google refuses the code, returns no refresh
 * token, or the person did not grant `drive.readonly`.
 */
export async function exchangeCode(input: ExchangeInput): Promise<Grant> {
  const fetchImpl =
    input.fetch ??
    ((globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis) as
      FetchLike | undefined);
  if (!fetchImpl)
    throw new Error("no fetch implementation available; pass input.fetch");
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  };
  if (input.codeVerifier) form.code_verifier = input.codeVerifier;
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
    signal: input.signal,
  });
  const text = await response.text();
  let body: {
    refresh_token?: unknown;
    scope?: unknown;
    error?: unknown;
    error_description?: unknown;
  } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // A body that is not JSON: the status says what happened.
  }
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "http_error";
    const said =
      typeof body.error_description === "string" ? body.error_description : "";
    throw new GoogleOAuthError(
      code,
      `Google refused the code (${response.status})${said ? `: ${said}` : ""}`,
      response.status,
    );
  }
  const scope = typeof body.scope === "string" ? body.scope : "";
  if (!scope.split(/\s+/).includes(SCOPE))
    throw new GoogleOAuthError(
      "scope_not_granted",
      "The person did not grant read access to Google Drive",
    );
  if (typeof body.refresh_token !== "string" || !body.refresh_token)
    throw new GoogleOAuthError(
      "no_refresh_token",
      "Google returned no refresh token: ask with access_type=offline and prompt=consent",
    );
  return {
    credentials: {
      GOOGLE_CLIENT_ID: input.clientId,
      GOOGLE_CLIENT_SECRET: input.clientSecret,
      GOOGLE_REFRESH_TOKEN: body.refresh_token,
    },
    scope,
  };
}
