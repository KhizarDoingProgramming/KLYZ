import type { Metadata } from "next";
import { ExecutionDebugger } from "@/components/execution/execution-debugger";

export const metadata: Metadata = {
  title: "Execution",
  description: "Inspect a KLYZ run step by step, with inputs, outputs and errors.",
};

export default async function ExecutionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  /* No workflow context in this URL: the debugger falls back to the run
     record for its back link and fetches the pinned graph itself. */
  return <ExecutionDebugger id={id} />;
}
