import type { Metadata } from "next";
import { AiBuilder } from "@/components/ai/ai-builder";

export const metadata: Metadata = {
  title: "AI builder",
  description:
    "Turn a plain-language description into a validated KLYZ workflow plan, review it, and apply it to the editor.",
};

export default async function AiBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ workflow?: string; execution?: string }>;
}) {
  const params = await searchParams;
  return <AiBuilder workflowId={params.workflow} executionId={params.execution} />;
}
