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
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
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
    eeo: autofill?.eeo ?? {},
    common_answers: autofill?.common_answers ?? {},
    defaults: autofill?.defaults ?? { never_auto_submit: true },
    work_history,
    resumes,
  };
}
