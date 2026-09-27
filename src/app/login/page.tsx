import Link from "next/link";
import { redirect } from "next/navigation";
import { KlyzMark } from "@/components/brand";
import { LoginForm } from "@/components/account/login-form";
import { currentActor } from "@/lib/server/session";

export const metadata = { title: "Sign in" };

/**
 * Sign in / create account.
 *
 * A live session short-circuits to the app so a signed-in tab never
 * sees the form again; everything else is a client form posting to
 * `/api/auth/login` or `/api/auth/register`.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const actor = await currentActor();
  if (actor) redirect("/dashboard");

  const { next } = await searchParams;
  /* Only ever a same-site path — never an absolute URL. */
  const redirectTo = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  return (
    <div className="flex min-h-dvh flex-col bg-app text-fg">
      <header className="kz-frame flex h-14 items-center border-b border-edge">
        <Link href="/" className="flex items-center gap-2.5" aria-label="KLYZ home">
          <KlyzMark className="h-6 w-6 text-fg" />
          <span className="kz-display text-[15px] font-semibold tracking-[-0.01em]">
            KLYZ
          </span>
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-14">
        <div className="w-full max-w-[380px]">
          <p className="kz-eyebrow mb-4">Access</p>
          <h1 className="kz-display text-[26px] font-semibold leading-tight tracking-[-0.02em]">
            Sign in to your workspace
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
            Sessions are server-side and expire on their own. Signing in from a
            new device replaces the session you are using now.
          </p>

          <div className="mt-8">
            <LoginForm redirectTo={redirectTo} />
          </div>

          <p className="mt-8 border-t border-hairline pt-5 text-[12.5px] text-subtle">
            Workflows, runs and credentials are stored in this KLYZ
            instance&apos;s own database.
          </p>
        </div>
      </main>
    </div>
  );
}
