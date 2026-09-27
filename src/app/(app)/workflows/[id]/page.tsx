import type { Metadata } from "next";
import { WorkflowEditor } from "@/components/workflow/editor";

export const metadata: Metadata = {
  title: "Workflow editor",
  description:
    "Design, test and inspect a KLYZ workflow on the visual canvas.",
};

export default async function WorkflowEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WorkflowEditor id={id} />;
}
