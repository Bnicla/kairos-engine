"use client";

import { useFormStatus } from "react-dom";
import { sourceJobsAction } from "@/app/actions";

function Inner() {
  const { pending } = useFormStatus();
  return (
    <button
      className="btn-secondary whitespace-nowrap !py-1.5 text-sm disabled:opacity-60"
      disabled={pending}
      title="Sweep 6,000+ company job boards for roles posted this week, triage them, and fill the Sourced column"
    >
      {pending ? "Sourcing…" : "⌁ Source jobs"}
    </button>
  );
}

export default function SourceJobsButton() {
  return (
    <form action={sourceJobsAction}>
      <Inner />
    </form>
  );
}
