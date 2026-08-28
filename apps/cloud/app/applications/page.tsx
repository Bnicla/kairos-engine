import { redirect } from "next/navigation";

/** The board lives on the home page now; keep old links working. */
export default function Applications() {
  redirect("/");
}
