import type { Metadata } from "next";
import { ExecutionDebugger } from "@/components/execution/execution-debugger";

export const metadata: Metadata = {
  title: "Execution debugger",
  description:
    "Watch a KLYZ run on the canvas, step through its timeline and inspect every input, output and error.",
};

export default async function WorkflowExecutionPage({
  params,
}: {
  params: Promise<{ id: string; executionId: string }>;
}) {
  const { id, executionId } = await params;
  return <ExecutionDebugger id={executionId} workflowId={id} />;
}
