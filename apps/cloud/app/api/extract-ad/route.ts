import { NextResponse } from "next/server";
import { getSessionContext, isContextError } from "../../../lib/session";
import { extractResumeText } from "@kairos/engine/extract-text";

export const dynamic = "force-dynamic";

/** Extract readable text from an uploaded job-ad file (PDF/DOCX/TXT). */
export async function POST(req: Request): Promise<NextResponse> {
  const ctx = await getSessionContext();
  if (isContextError(ctx)) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Attach a file." }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (10MB max)." }, { status: 400 });
  }

  try {
    const text = await extractResumeText(file);
    return NextResponse.json({ name: file.name, text: text.slice(0, 30_000) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't read that file." },
      { status: 400 },
    );
  }
}
