# Cloud lane — security notes

## Encryption-key rotation (user Anthropic keys)

User API keys are AES-256-GCM encrypted app-side and stored in the **user's**
Drive (`Kairos/.secrets/anthropic.json`). Ciphertexts are versioned:
`v1.<keyId>.<iv>.<tag>.<ct>`, where `keyId` is the first 8 hex chars of the
encryption key's SHA-256. Legacy `<iv>.<tag>.<ct>` payloads decrypt by trying
every configured key.

**To rotate:**
1. Generate a new key: `openssl rand -base64 32`.
2. Prepend it to `KAIROS_ENCRYPTION_KEYS` (comma-separated; **first entry
   encrypts**, all entries decrypt). Keep the old key in the list.
3. Deploy. Every successful decrypt under a non-primary key lazily re-encrypts
   the stored ciphertext under the new primary (`getAnthropicKey` in
   `lib/session.ts`).
4. After enough time for active users to have cycled (weeks), drop the old key
   from the list. Users whose ciphertext still references a dropped key see a
   clear error and re-enter their key in Settings — no data loss beyond that
   one secret, which they own anyway.

The legacy singular `KAIROS_ENCRYPTION_KEY` is still honored (treated as the
last list entry) so existing deployments keep working before migration.

## Drive quota (multi-user risk)

All users' Drive traffic bills against ONE Google Cloud project's quota
(per-user OAuth tokens don't shard project quota). A heavy user can degrade
everyone. Before any real beta: request a quota increase for the project and
add a per-user request budget at the app layer. Backoff on 429/5xx is handled
in the DriveStore wrapper.

## Attribution guard (prompt-injection containment)

Agent contexts include untrusted text (job-ad snapshots fetched from arbitrary
URLs). Any tool that WRITES durable user data (`save_confirmed_fact`,
`save_application_answer`) is gated by `packages/engine/tools/attribution.ts`:
content must trace to candidate-authored chat messages (token overlap + strict
number attribution), and no write is honored before the candidate has sent at
least one message. The snapshot is additionally delimited as untrusted data in
the prompt, but the mechanical guard is the control; the prompt note is only
defense in depth.

## Drive API quota (REQ-7)

Google Drive API quota is granted **per Google Cloud project**, shared across
every Kairos user — one heavy user (or a runaway loop) degrades all tenants.
Mitigations in place and planned:

- All Drive calls run through `withBackoff` (`store/drive-ops.ts`): up to 3
  attempts on 429/500/502/503, exponential backoff + jitter, `Retry-After`
  honored (capped 10s).
- Before any multi-user rollout: file a Drive API quota-increase request for
  the project, and add a per-user request budget at the route layer (the
  in-memory rate limit from REQ-9 is the seed of this).
- The `_index.json` fast-path and per-request id caching keep dashboard loads
  from fanning out into many small reads.
