import "next-auth";

declare module "next-auth" {
  interface Session {
    /** Google access token for Drive (drive.file scope). Server-side use only. */
    access_token?: string;
    /** Token refresh failure marker — treat as signed-out and re-authenticate. */
    error?: string;
    /** Space-separated OAuth scopes the user actually granted. */
    scope?: string;
  }
}
