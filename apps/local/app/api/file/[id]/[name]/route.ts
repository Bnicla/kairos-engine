import { getStore } from "@/store";

/**
 * Download a document from an application folder. Whitelisted filenames only —
 * never an arbitrary path — so the dashboard can serve the generated resume,
 * cover letter, or the actually-submitted file for download.
 */
const ALLOWED = /^(resume\.docx|resume\.pdf|cover-letter\.docx|cover-letter\.pdf|submitted-resume\.[a-z0-9]+)$/;

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  if (!ALLOWED.test(name)) return new Response("Not found", { status: 404 });

  const buf = await getStore().readBinary(["applications", id, name]);
  if (!buf) return new Response("Not found", { status: 404 });

  const ext = name.split(".").pop() ?? "";
  const company = id.split("_")[1] ?? "application";
  const downloadName = `Resume-${company}-${name}`;

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Content-Length": String(buf.length),
    },
  });
}
