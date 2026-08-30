import type { NextRequest } from "next/server";
import { getStore } from "@/store";
import { loadExperiences } from "@kairos/engine/kb/store";
import { loadIndex } from "@kairos/engine/applications";

/**
 * Shared building blocks for the autofill extension endpoints
 * (/api/autofill-profile serves the profile; /api/autofill-map maps form fields
 * to it via Claude). Kept out of the route files because Next.js route modules
 * may only export request handlers.
 */

export interface AutofillJson {
  contact?: Record<string, string>;
  address?: Record<string, string>;
  links?: Record<string, string>;
  work_authorization?: Record<string, unknown>;
  eeo?: Record<string, string>;
  /** EEO/demographic data is served ONLY when this is explicitly true. */
  share_eeo?: boolean;
  common_answers?: Record<string, string>;
  defaults?: Record<string, unknown>;
}

// Only reflect a chrome-extension:// origin back — never a web page's http(s)
// origin. That keeps this personal data readable by the extension alone.
export function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Kairos-Token",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

/**
 * Shared-token auth for the autofill endpoints (defense against DNS rebinding
 * and other local processes: CORS only constrains browsers, and the profile
 * endpoint serves contact/address/work-authorization data). The token lives at
 * ~/Kairos/.secrets/autofill-token, generated on first use; the extension sends
 * it as X-Kairos-Token after a one-time paste in its popup settings.
 */
export async function getOrCreateAutofillToken(store: Store): Promise<string> {
  const path = [".secrets", "autofill-token"];
  const existing = (await store.readFile(path).catch(() => null))?.trim();
  if (existing) return existing;
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  await store.writeFile(path, token);
  return token;
}

const ALLOWED_HOSTS = new Set(["localhost:3000", "127.0.0.1:3000", "localhost", "127.0.0.1"]);

/** Null when the request is authorized; otherwise an error message + status. */
export async function rejectUnauthorized(
  req: NextRequest,
  store: Store,
): Promise<{ status: number; message: string } | null> {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return { status: 403, message: "Bad Host header." };
  }
  const token = await getOrCreateAutofillToken(store);
  const sent = req.headers.get("x-kairos-token") ?? "";
  if (sent !== token) {
    return {
      status: 401,
      message:
        "Missing or invalid X-Kairos-Token. Paste the token from ~/Kairos/.secrets/autofill-token into the extension's settings.",
    };
  }
  return null;
}

type Store = ReturnType<typeof getStore>;

/**
 * Assemble the normalized autofill profile from ~/Kairos. Shared so the profile
 * endpoint and the field-map endpoint see exactly the same facts.
 */
export async function buildAutofillProfile(store: Store) {
  const [autofill, experiences, index] = await Promise.all([
    store.readJson<AutofillJson>(["autofill.json"]).catch(() => null),
    loadExperiences(store).catch(() => []),
    loadIndex(store).catch(() => ({ applications: [] as { id: string; company: string; role: string; status: string; updated_at?: string }[] })),
  ]);

  const work_history = experiences
    .map((e) => {
      const fm = e.frontmatter as unknown as Record<string, unknown>;
      return {
        company: String(fm.company ?? ""),
        title: String(fm.title ?? ""),
        location: String(fm.location ?? ""),
        start: String(fm.start ?? ""),
        end: String(fm.end ?? ""),
        current: String(fm.end ?? "").toLowerCase() === "present",
      };
    })
    .filter((w) => w.company && w.title);

  const resumes = (index.applications ?? [])
    .filter((a) => ["drafted", "applied", "interviewing", "offer"].includes(a.status))
    .slice(0, 40)
    .map((a) => ({
      appId: a.id,
      company: a.company,
      role: a.role,
      // Prefer the PDF; the background worker falls back to .docx if a PDF
      // hasn't been rendered for this app yet.
      resume_url: `/api/file/${encodeURIComponent(a.id)}/resume.pdf`,
      cover_letter_url: `/api/file/${encodeURIComponent(a.id)}/cover-letter.pdf`,
    }));

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    contact: autofill?.contact ?? {},
    address: autofill?.address ?? {},
    links: autofill?.links ?? {},
    work_authorization: autofill?.work_authorization ?? {},
    // EEO/demographics are the most sensitive category here: served only on
    // explicit opt-in ("share_eeo": true in autofill.json).
    eeo: autofill?.share_eeo === true ? (autofill?.eeo ?? {}) : {},
    common_answers: autofill?.common_answers ?? {},
    defaults: autofill?.defaults ?? { never_auto_submit: true },
    work_history,
    resumes,
  };
}

// --- Field-mapping helpers (extracted from the map route for testability, REQ-18) ---

export interface MapField {
  id: string;
  label: string;
  type: "text" | "select" | "combobox" | "radio" | "toggle";
  options?: string[];
}

export interface FieldMapping {
  id: string;
  value: string;
}

/** Pull the first JSON array out of model output (fenced, prose-wrapped, or bare). */
export function extractMappingArray(text: string): FieldMapping[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && typeof m.id === "string" && m.value != null)
      .map((m) => ({ id: String(m.id), value: String(m.value) }));
  } catch {
    return [];
  }
}

/**
 * Mechanical guard on model mappings: only ids that were actually sent, and for
 * choice fields only values copied VERBATIM from that field's options — a
 * hallucinated option must never be clicked into a form.
 */
export function filterSafeMappings(fields: MapField[], mappings: FieldMapping[]): FieldMapping[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return mappings.filter((m) => {
    const f = byId.get(m.id);
    if (!f) return false;
    if (f.options && f.options.length) return f.options.some((o) => o === m.value);
    return true;
  });
}
