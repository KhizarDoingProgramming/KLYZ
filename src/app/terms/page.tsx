import { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { KlyzLogo, KlyzMark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { buttonClassName } from "@/components/ui/button";
import { Roll } from "@/components/ui/roll";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms of Service and Acceptable Use Policy for KLYZ.",
};

export default function TermsPage() {
  return (
    <div className="min-h-dvh bg-app text-fg">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-edge bg-app/85 backdrop-blur-md">
        <div className="kz-frame flex h-14 items-center gap-9">
          <Link href="/" className="shrink-0" aria-label="KLYZ home">
            <KlyzLogo />
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Link href="/dashboard" className={buttonClassName("primary", "sm", "group")}>
              <Roll>Dashboard</Roll>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="kz-frame py-20 lg:py-28">
        <div className="max-w-3xl">
          <h1 className="text-display-sm font-semibold mb-2">Terms of Service</h1>
          <p className="text-muted text-sm mb-12">Last updated: October 2026</p>

          <div className="prose prose-invert prose-p:text-[15px] prose-p:leading-relaxed prose-p:text-muted prose-headings:text-fg prose-headings:font-medium max-w-none">
            <p>
              Welcome to KLYZ. By accessing or using our workflow automation platform, you agree to comply with and be bound by these Terms of Service. If you do not agree with these terms, please do not use our services.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">1. Use of the Service</h2>
            <p>
              KLYZ provides a platform for building, executing, and monitoring automated workflows. You must be at least 18 years old to use the Service. You are responsible for maintaining the security of your account and workspace credentials.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">2. OAuth and Integrations</h2>
            <p>
              KLYZ connects to third-party services on your behalf via OAuth and API keys. By authorizing an integration, you grant KLYZ permission to interact with those services according to the logic defined in your workflows.
            </p>
            <p>
              You are entirely responsible for the actions your workflows take in third-party systems. KLYZ is not liable for data loss, accidental deletions, rate limiting, or unintended actions executed by your workflows on connected platforms like GitHub, Google Workspace, Notion, or Slack.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">3. Acceptable Use Policy</h2>
            <p>You agree not to use KLYZ to:</p>
            <ul className="list-disc pl-5 text-[15px] text-muted space-y-2 mt-3">
              <li>Violate the terms of service of any integrated third-party platform.</li>
              <li>Execute malicious code, spam, or denial-of-service attacks.</li>
              <li>Process highly sensitive regulated data (e.g., PHI or cardholder data) unless explicitly supported by your specific agreement with us.</li>
              <li>Intentionally bypass rate limits, quotas, or billing mechanisms.</li>
            </ul>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">4. Service Availability and Execution Guarantees</h2>
            <p>
              We strive for high availability, but the Service is provided &quot;as is&quot; and &quot;as available.&quot; We do not guarantee that workflows will execute without delay, error, or interruption, as execution is heavily dependent on the availability of third-party APIs.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">5. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, KLYZ and its affiliates shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits, data, or goodwill, arising from your use of or inability to use the Service.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">6. Termination</h2>
            <p>
              We reserve the right to suspend or terminate your access to the Service at any time, with or without cause, including for violations of our Acceptable Use Policy.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">7. Changes to the Terms</h2>
            <p>
              We may modify these Terms occasionally. We will notify you of material changes via the platform or email. Continued use of the Service after changes constitutes acceptance of the modified Terms.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">8. Contact</h2>
            <p>
              For legal inquiries regarding these Terms, please contact legal@klyz.example.com.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-edge bg-app mt-20">
        <div className="kz-frame py-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
            <div className="flex flex-col gap-1">
              <Link href="/" aria-label="KLYZ home">
                <KlyzMark className="h-5 w-5 text-fg" />
              </Link>
              <p className="text-[11px] text-subtle/70 mt-1">
                Created by <strong>MUSTAFA</strong>
              </p>
            </div>
            <nav className="flex items-center gap-6 sm:ml-auto">
              <Link href="/terms" className="text-[12px] text-subtle hover:text-fg transition-colors">
                Terms of Service
              </Link>
              <Link href="/privacy" className="text-[12px] text-subtle hover:text-fg transition-colors">
                Privacy Policy
              </Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
