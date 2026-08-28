import { NextResponse } from "next/server";
import { getSessionContext, isContextError } from "../../../lib/session";

export const dynamic = "force-dynamic";

/** Files a student may pull out of their own application folders. */
const ALLOWED: Record<string, string> = {
  "resume.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "cover-letter.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Plus the recorded as-sent file ("submitted-<name>.docx|pdf"). */
const SUBMITTED = /^submitted-[\w. -]+\.(docx|pdf)$/;
const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await getSessionContext();
  if (isContextError(ctx)) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const url = new URL(req.url);
  const appId = url.searchParams.get("app") ?? "";
  const file = url.searchParams.get("file") ?? "";
  const submittedMatch = SUBMITTED.exec(file);
  const mime = file in ALLOWED ? ALLOWED[file] : submittedMatch ? MIME[submittedMatch[1]] : null;
  if (!appId || appId.includes("/") || appId.includes("..") || !mime) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const buffer = await ctx.store.readBinary(["applications", appId, file]);
  if (!buffer) return NextResponse.json({ error: "Not found." }, { status: 404 });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="${appId}-${file}"`,
    },
  });
}
