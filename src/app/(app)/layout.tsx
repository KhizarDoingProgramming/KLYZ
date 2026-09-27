import { AppShell } from "@/components/shell/app-shell";
import { CommandPalette } from "@/components/command/command-palette";
import { ShortcutsDialog } from "@/components/command/shortcuts-dialog";
import { ImportDialog } from "@/components/workflow/import-dialog";
import { requireCurrentActor } from "@/lib/server/session";

/**
 * The authenticated shell.
 *
 * Every page under `(app)` inherits this gate: no live session means a
 * redirect to `/login` before a single byte of workspace data is read.
 * Authorization still happens per route — this only guarantees there is
 * a real actor to authorize.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireCurrentActor();

  return (
    <>
      <AppShell>{children}</AppShell>
      <CommandPalette />
      <ShortcutsDialog />
      {/* Shared so "Import…" works from any page in the shell, not just
          the ones that happen to render their own copy. */}
      <ImportDialog />
    </>
  );
}
