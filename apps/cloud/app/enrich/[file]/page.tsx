import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext, isContextError } from "../../../lib/session";
import { loadExperiences } from "@kairos/engine/kb/store";
import type { HealthReport } from "@kairos/engine/health";
import EnrichChat from "../../../components/EnrichChat";

export const dynamic = "force-dynamic";

export default async function Enrich({ params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const fileName = decodeURIComponent(file);

  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");

  const experiences = await loadExperiences(ctx.store);
  const exp = experiences.find((e) => e.fileName === fileName);
  if (!exp) redirect("/kb");

  const health = await ctx.store.readJson<HealthReport>(["knowledge-base", "_health.json"]);
  const confirmed = (exp!.body.match(/\[C\]/g) ?? []).length;

  return (
    <main>
      <div className="hero">
        <h1>Go deeper: {exp!.frontmatter.company}</h1>
        <p className="lede">
          Your résumé compressed this role down. Kairos interviews you to recover the real
          material — context, numbers, stories — and stores each answer as a confirmed fact in
          your Drive.{" "}
          {confirmed > 0 ? `${confirmed} confirmed fact${confirmed === 1 ? "" : "s"} so far.` : ""}
        </p>
      </div>

      <EnrichChat
        fileName={exp!.fileName}
        roleLabel={`${exp!.frontmatter.title} · ${exp!.frontmatter.company} (${exp!.frontmatter.start}–${exp!.frontmatter.end})`}
        initialHealth={health?.overall ?? null}
      />

      <p className="footnote">
        Answer in your own words — plain and specific beats polished. Stop any time; your
        answers are already saved. <Link href="/kb">← Back to your knowledge base</Link>
      </p>
    </main>
  );
}
