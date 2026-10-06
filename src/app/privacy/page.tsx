import { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { KlyzLogo, KlyzMark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { buttonClassName } from "@/components/ui/button";
import { Roll } from "@/components/ui/roll";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How KLYZ handles your data, integrations, and privacy.",
};

export default function PrivacyPage() {
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
          <h1 className="text-display-sm font-semibold mb-2">Privacy Policy</h1>
          <p className="text-muted text-sm mb-12">Last updated: October 2026</p>

          <div className="prose prose-invert prose-p:text-[15px] prose-p:leading-relaxed prose-p:text-muted prose-headings:text-fg prose-headings:font-medium max-w-none">
            <p>
              KLYZ (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) respects your privacy. This Privacy Policy explains what data we collect, how it is used, and how it is secured when you use the KLYZ workflow automation platform.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">1. Data We Collect</h2>
            <h3 className="text-[16px] mt-6 mb-2">Account and Workspace Data</h3>
            <p>
              When you sign up, we collect your email address, name, and workspace details. We use this to provision your account, manage billing (via third-party payment processors), and communicate important service updates.
            </p>

            <h3 className="text-[16px] mt-6 mb-2">Connected Integrations (OAuth)</h3>
            <p>
              KLYZ connects to third-party services (e.g., GitHub, Gmail, Google Sheets, Notion, Slack). When you authorize these integrations, we securely store the required OAuth tokens. We only request the scopes necessary for the nodes you use. <strong>We do not read, process, or store your third-party data except as explicitly instructed by your workflow configurations.</strong>
            </p>

            <h3 className="text-[16px] mt-6 mb-2">Execution Logs and Data in Transit</h3>
            <p>
              As your workflows run, KLYZ temporarily processes data flowing between your connected apps. We store execution logs (which may contain partial data from these runs) to provide you with debugging and remediation tools. These logs are retained according to your workspace plan and are automatically purged upon expiration.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">2. How We Use Your Data</h2>
            <p>We use your information exclusively to:</p>
            <ul className="list-disc pl-5 text-[15px] text-muted space-y-2 mt-3">
              <li>Execute the workflows you have explicitly defined.</li>
              <li>Provide debugging tools and execution histories.</li>
              <li>Improve platform performance and reliability.</li>
              <li>Ensure security and prevent abuse.</li>
            </ul>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">3. Security and Storage</h2>
            <p>
              We implement strict access controls and encryption at rest and in transit. OAuth tokens and secrets are encrypted in our database using industry-standard cryptography. We do not sell your personal information or workflow data to third parties.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">4. Third-Party Services</h2>
            <p>
              Our infrastructure relies on trusted third-party providers for hosting (e.g., Vercel, AWS) and data persistence (e.g., Upstash, Neon). These sub-processors are bound by strict confidentiality agreements.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">5. Cookies and Tracking</h2>
            <p>
              KLYZ uses essential cookies solely for session management and authentication. We do not use third-party tracking cookies for targeted advertising.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">6. Retention and Deletion</h2>
            <p>
              You can revoke integration access at any time via your KLYZ dashboard or directly through the third-party provider. Deleting your workspace immediately purges your workflows, credentials, and execution logs from our active databases.
            </p>

            <h2 className="text-[19px] mt-10 mb-4 border-b border-hairline pb-2">7. Contact Us</h2>
            <p>
              If you have any questions or requests regarding your data, please contact us at <a href="mailto:gmkhizar9@gmail.com" className="text-fg underline hover:text-signal transition-colors">gmkhizar9@gmail.com</a>.
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
              <p className="text-[11px] text-subtle/70 mt-0.5">
                Tested by <a href="https://umersmx.vercel.app" target="_blank" rel="noopener noreferrer" className="font-semibold hover:text-fg transition-colors">UMER</a>
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
