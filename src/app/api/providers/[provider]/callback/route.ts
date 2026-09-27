import { HttpError } from "@/lib/server/http";
import { completeConnect } from "@/lib/server/oauth";
import { parseProvider } from "@/lib/server/providers";

export const dynamic = "force-dynamic";

/**
 * OAuth callback.
 *
 * A plain browser navigation from the provider, so it answers with a
 * redirect rather than JSON. Failures are never rendered here: the
 * browser lands on the Integrations page with a short, safe reason.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirect") ?? "/integrations";

  let id;
  try {
    id = parseProvider(provider);
  } catch {
    return redirect("/integrations", { error: "UNKNOWN_PROVIDER" });
  }

  const denied = url.searchParams.get("error");
  if (denied) {
    return redirect(redirectTo, {
      error: "ACCESS_DENIED",
      message: url.searchParams.get("error_description") || "Authorization was declined.",
    });
  }

  try {
    const result = await completeConnect(
      id,
      url.searchParams.get("code"),
      url.searchParams.get("state"),
    );
    return redirect(result.redirectPath, {
      connected: id,
      account: result.account,
    });
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "CONNECTION_FAILED";
    const message =
      error instanceof HttpError
        ? error.message
        : "The connection could not be completed.";
    return redirect(redirectTo, { error: code, message });
  }
}

function redirect(path: string, query: Record<string, string>): Response {
  const target = new URL(path, "http://internal");
  for (const [key, value] of Object.entries(query)) {
    if (value) target.searchParams.set(key, value);
  }
  return Response.redirect(`${target.pathname}${target.search}`, 302);
}
