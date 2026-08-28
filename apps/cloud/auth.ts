import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Kairos auth — one Google login provides BOTH identity and Drive access.
 *
 * Scope is deliberately `drive.file` ONLY (plus openid/email/profile):
 *   - `drive.file` is a NON-SENSITIVE scope: the app can only ever see files it
 *     itself created. This is what lets Kairos avoid Google's restricted-scope
 *     security assessment. Do NOT widen this to full `drive`.
 *
 * We request `access_type: offline` + `prompt: consent` so Google returns a
 * refresh token, and we refresh the access token server-side when it expires.
 * Session strategy is JWT (no database) — no personal data touches our server.
 */

// Scopes: identity + create/read files the app owns in the user's Drive.
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function refreshGoogleAccessToken(refreshToken: string) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`token_refresh_failed: ${JSON.stringify(data)}`);

  return {
    access_token: data.access_token as string,
    // Google may or may not return a new refresh_token; keep the old one if not.
    refresh_token: (data.refresh_token as string | undefined) ?? refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in as number),
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // Initial sign-in: persist the Google tokens onto the JWT.
      if (account) {
        token.access_token = account.access_token;
        token.refresh_token = account.refresh_token;
        token.expires_at = account.expires_at;
        // Google's granular consent lets users grant sign-in but DENY Drive.
        // Record what was actually granted so the app can explain, not crash.
        token.scope = account.scope;
        return token;
      }

      // Still valid (60s early margin) → use as-is.
      const expiresAt = (token.expires_at as number | undefined) ?? 0;
      if (Date.now() < expiresAt * 1000 - 60_000) return token;

      // Expired → refresh, if we have a refresh token.
      if (!token.refresh_token) {
        token.error = "NoRefreshToken";
        return token;
      }
      try {
        const refreshed = await refreshGoogleAccessToken(
          token.refresh_token as string,
        );
        token.access_token = refreshed.access_token;
        token.refresh_token = refreshed.refresh_token;
        token.expires_at = refreshed.expires_at;
        delete token.error;
      } catch (err) {
        console.error("Failed to refresh Google access token", err);
        token.error = "RefreshAccessTokenError";
      }
      return token;
    },
    async session({ session, token }) {
      // Expose the access token + any refresh error to the server (used by the
      // Drive service layer). We do NOT expose the refresh token to the client.
      session.access_token = token.access_token as string | undefined;
      session.error = token.error as string | undefined;
      session.scope = token.scope as string | undefined;
      return session;
    },
  },
});
