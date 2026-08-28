"use client";

import { useFormStatus } from "react-dom";

/**
 * The ONE submit button for every form on the site. While its form's server
 * action runs (Drive writes, uploads, key encryption) it disables itself and
 * shows a spinner + progress label — so slow actions never look dead. The
 * confirmation side is the flash message each action redirects back with.
 */
export default function SubmitButton({
  children,
  pendingLabel = "Working…",
  secondary = false,
  name,
  value,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  secondary?: boolean;
  /** Optional submitted name/value pair — lets one form carry several actions. */
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={secondary ? "secondary" : undefined}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <span className="spinner" aria-hidden />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
