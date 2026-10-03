import { test } from "node:test";
import assert from "node:assert/strict";
import { googleDrive } from "./index.js";
import type { FetchLike } from "./types.js";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const INPUT = {
  clientId: "client-1.apps.googleusercontent.com",
  clientSecret: "secret-1",
  redirectUri: "https://app.example.com/google/callback",
  code: "code-1",
};

/** A fake Google token endpoint that answers `answers` in turn. */
function tokenEndpoint(answers: { status?: number; body: unknown }[]) {
  const requests: { url: string; body: string | undefined }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, body: init?.body });
    const answer = answers.shift()!;
    const status = answer.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () =>
        typeof answer.body === "string"
          ? answer.body
          : JSON.stringify(answer.body),
    };
  };
  return { fetch, requests };
}

test("the consent URL asks for offline read access to Drive", () => {
  const url = new URL(
    googleDrive.authorizeUrl({
      clientId: INPUT.clientId,
      redirectUri: INPUT.redirectUri,
      state: "state-1",
      loginHint: "ana@example.com",
      codeChallenge: "challenge-1",
    }),
  );
  assert.equal(
    `${url.origin}${url.pathname}`,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: INPUT.clientId,
    redirect_uri: INPUT.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: "state-1",
    login_hint: "ana@example.com",
    code_challenge: "challenge-1",
    code_challenge_method: "S256",
  });
  const plain = new URL(
    googleDrive.authorizeUrl({
      clientId: "c",
      redirectUri: "https://a.example/cb",
      state: "s",
    }),
  );
  assert.equal(plain.searchParams.has("login_hint"), false);
  assert.equal(plain.searchParams.has("code_challenge"), false);
});

test("the code becomes a google_drive connection's credentials", async () => {
  const google = tokenEndpoint([
    {
      body: {
        access_token: "a",
        refresh_token: "r-1",
        scope: `openid ${SCOPE}`,
      },
    },
  ]);
  const grant = await googleDrive.exchangeCode({
    ...INPUT,
    codeVerifier: "verifier-1",
    fetch: google.fetch,
  });
  assert.deepEqual(grant, {
    credentials: {
      GOOGLE_CLIENT_ID: INPUT.clientId,
      GOOGLE_CLIENT_SECRET: "secret-1",
      GOOGLE_REFRESH_TOKEN: "r-1",
    },
    scope: `openid ${SCOPE}`,
  });
  assert.equal(google.requests[0]!.url, "https://oauth2.googleapis.com/token");
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(google.requests[0]!.body)),
    {
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: INPUT.redirectUri,
      client_id: INPUT.clientId,
      client_secret: "secret-1",
      code_verifier: "verifier-1",
    },
  );
});

test("a refused code, a missing refresh token and a missing scope fail with their code", async () => {
  const google = tokenEndpoint([
    {
      status: 400,
      body: { error: "invalid_grant", error_description: "Bad Request" },
    },
    { status: 500, body: "<html>oops</html>" },
    { body: { access_token: "a", scope: SCOPE } },
    { body: { access_token: "a", refresh_token: "r", scope: "openid" } },
  ]);
  const expect = async (code: string, message: RegExp) =>
    assert.rejects(
      googleDrive.exchangeCode({ ...INPUT, fetch: google.fetch }),
      (error: Error) => {
        assert.ok(error instanceof googleDrive.GoogleOAuthError);
        assert.equal(error.code, code);
        assert.match(error.message, message);
        return true;
      },
    );
  await expect("invalid_grant", /refused the code \(400\): Bad Request/);
  await expect("http_error", /refused the code \(500\)$/);
  await expect("no_refresh_token", /no refresh token/);
  await expect("scope_not_granted", /did not grant read access/);
});
