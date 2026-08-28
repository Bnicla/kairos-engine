import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { auth } from "../auth";
import ThemeToggle from "../components/ThemeToggle";

// Apply the saved theme before paint to avoid a flash. Defaults to dark.
const themeScript = `(function(){try{var t=localStorage.getItem('kairos-theme');if(t==='light'){document.documentElement.dataset.theme='light';}}catch(e){}})();`;

export const metadata: Metadata = {
  title: "Kairos: résumés that fit the job, built from what you've actually done",
  description:
    "A free tool for students and early job seekers: paste a job ad, get an honest fit score and a résumé tailored from your real experience. Your data stays in your own Google Drive.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="logo">
              <span className="dot" />
              Kairos
            </Link>
            <nav>
              {session?.user ? (
                <>
                  <Link href="/kb">Knowledge base</Link>
                  <Link href="/settings">Settings</Link>
                </>
              ) : null}
              <ThemeToggle />
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
