import Link from "next/link";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import { KlyzLogo, KlyzMark } from "@/components/brand";
import { Glyph } from "@/components/icons";
import { Hero } from "@/components/marketing/hero";
import { Instrument } from "@/components/marketing/instrument";
import { FadeUp, SplitHeading } from "@/components/marketing/reveal";
import { Story } from "@/components/marketing/story";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { buttonClassName } from "@/components/ui/button";
import { Roll } from "@/components/ui/roll";
import { NODE_DEFINITIONS } from "@/lib/workflow/registry";
import { NODE_CATEGORIES } from "@/lib/workflow/types";
import { CATEGORY_LABEL, CATEGORY_STYLE } from "@/lib/workflow/category";

const NAV_LINKS = [
  { href: "#manifesto", label: "Manifesto" },
  { href: "#story", label: "The run" },
  { href: "#nodes", label: "Nodes" },
  { href: "#execution", label: "Execution" },
  { href: "#errors", label: "Failures" },
];

const TRIGGERS = [
  { icon: "webhook", title: "Webhook", detail: "POST /hooks/github" },
  { icon: "clock", title: "Schedule", detail: "every 15 minutes" },
  { icon: "github", title: "GitHub", detail: "issue opened" },
  { icon: "globe", title: "Stripe", detail: "invoice.paid" },
];

const PRINCIPLES = [
  "Every node is data, not markup.",
  "Every run is a record, not a log line.",
  "Every failure carries its own remediation.",
];

const errorCard = {
  code: "STRIPE_402",
  step: "stripe.createCustomer",
  message: "Your card was declined.",
  detail:
    "The attached payment method requires authentication before it can be charged.",
  fix: "Reconnect the Stripe account with a 3-D Secure enabled card, then re-run from this step.",
};

export default function LandingPage() {
  const definitions = Object.values(NODE_DEFINITIONS);
  let entryIndex = 0;

  return (
    <div className="min-h-dvh bg-app">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-100 focus:rounded-md focus:border focus:border-line focus:bg-panel focus:px-3 focus:py-2 focus:text-[13px] focus:text-fg"
      >
        Skip to content
      </a>

      {/* ------------------------------------------------------ nav */}
      <header className="sticky top-0 z-30 border-b border-edge bg-app/85 backdrop-blur-md">
        <div className="kz-frame flex h-14 items-center gap-9">
          <Link href="/" className="shrink-0" aria-label="KLYZ home">
            <KlyzLogo />
          </Link>

          <nav className="hidden flex-1 items-center gap-7 md:flex" aria-label="Primary">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle transition-colors duration-micro hover:text-fg"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <ThemeToggle />
            <Link
              href="/dashboard"
              className={buttonClassName("primary", "sm", "group")}
            >
              <Roll>Open dashboard</Roll>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="outline-none">
        {/* --------------------------------------------------- hero */}
        <Hero />

        {/* ----------------------------------------------- manifesto */}
        <section id="manifesto" className="border-b border-edge">
          <div className="kz-frame grid gap-10 py-20 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-16 lg:py-28">
            <div className="lg:border-r lg:border-hairline lg:pr-8">
              <p className="kz-eyebrow">01 — Manifesto</p>
            </div>

            <div>
              <SplitHeading
                text="Most automation hides. KLYZ shows its work."
                className="max-w-[20ch] text-display-sm font-semibold text-fg"
              />
              <FadeUp delay={0.15}>
                <p className="mt-8 max-w-[64ch] text-[16px] leading-relaxed text-muted">
                  Point-and-click builders give you a flowchart and a prayer.
                  KLYZ gives you an execution record: every input, every branch
                  taken, every millisecond, every token. When something breaks
                  you know what broke, where and why — and you fix it by editing
                  the step, not by re-running blind.
                </p>

                <ul className="mt-10 border-t border-edge">
                  {PRINCIPLES.map((principle, index) => (
                    <li
                      key={principle}
                      className="flex items-baseline gap-5 border-b border-hairline py-4"
                    >
                      <span className="kz-num text-[11.5px] text-signal-text">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="kz-display text-[17px] font-medium text-fg sm:text-[19px]">
                        {principle}
                      </span>
                    </li>
                  ))}
                </ul>
              </FadeUp>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------- story */}
        <Story />

        {/* -------------------------------------------- node index */}
        <section id="nodes" className="border-b border-edge">
          <div className="kz-frame py-20 lg:py-24">
            <div className="grid items-end gap-8 border-b border-line pb-10 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div>
                <p className="kz-eyebrow mb-5">The node system</p>
                <SplitHeading
                  text="Every node is data, not markup."
                  className="max-w-[18ch] text-display-sm font-semibold text-fg"
                />
                <FadeUp delay={0.15}>
                  <p className="mt-6 max-w-[62ch] text-[15px] leading-relaxed text-muted">
                    One registry declares each node&apos;s fields, credentials,
                    outputs and cost. The palette, the config panel, validation,
                    the data picker and the execution plan all read from it — so
                    adding a connector means adding a single entry, and the whole
                    app learns about it.
                  </p>
                </FadeUp>
              </div>

              <div className="flex items-baseline gap-4 lg:justify-end">
                <span className="kz-display text-display-md font-semibold leading-none text-fg [font-variant-numeric:tabular-nums]">
                  {String(definitions.length).padStart(2, "0")}
                </span>
                <span className="kz-eyebrow pb-2">Entries in the registry</span>
              </div>
            </div>

            {NODE_CATEGORIES.map((category) => {
              const entries = definitions.filter(
                (definition) => definition.category === category,
              );
              if (entries.length === 0) return null;

              return (
                <div key={category} className="mt-12 first:mt-12">
                  <div className="flex items-center justify-between border-b border-line pb-3">
                    <h3 className="flex items-center gap-2.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${CATEGORY_STYLE[category].dot}`}
                        aria-hidden
                      />
                      <span className="kz-eyebrow text-fg">
                        {CATEGORY_LABEL[category]}
                      </span>
                    </h3>
                    <span className="kz-num text-[11px] text-subtle">
                      {String(entries.length).padStart(2, "0")}
                    </span>
                  </div>

                  <ul>
                    {entries.map((definition) => {
                      entryIndex += 1;
                      const style = CATEGORY_STYLE[definition.category];
                      const number = String(entryIndex).padStart(2, "0");

                      return (
                        <li key={definition.type} className="group">
                          <div className="grid grid-cols-[36px_30px_minmax(0,1fr)_auto] items-center gap-x-4 border-b border-hairline py-3.5 transition-colors duration-micro group-hover:bg-raised/55 sm:grid-cols-[44px_30px_minmax(0,0.9fr)_minmax(0,1fr)_36px] sm:gap-x-5">
                            <span className="kz-num text-[11px] text-subtle transition-colors duration-micro group-hover:text-signal-text">
                              {number}
                            </span>
                            <span
                              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${style.border} ${style.chip} ${style.text}`}
                            >
                              <Glyph name={definition.icon} className="h-4 w-4" />
                            </span>
                            <span className="kz-display truncate text-[16px] font-medium text-fg">
                              {definition.title}
                            </span>
                            <span className="hidden truncate text-[13.5px] text-muted sm:block">
                              {definition.summary}
                            </span>
                            <span className="justify-self-end text-subtle opacity-0 transition-all duration-standard ease-out group-hover:translate-x-0.5 group-hover:text-fg group-hover:opacity-100">
                              <ArrowRight className="h-4 w-4" aria-hidden />
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        {/* --------------------------------------------- execution */}
        <Instrument />

        {/* ------------------------------------------------ triggers */}
        <section className="border-b border-edge bg-canvas">
          <div className="kz-frame grid items-start gap-10 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16 lg:py-20">
            <div>
              <p className="kz-eyebrow mb-4">Triggers</p>
              <SplitHeading
                text="Start from whatever already happened."
                className="max-w-[16ch] text-display-sm font-semibold text-fg"
              />
              <FadeUp delay={0.12}>
                <p className="mt-5 max-w-[52ch] text-[15px] leading-relaxed text-muted">
                  An inbound webhook, a cron expression, an issue opened, an
                  invoice paid. Triggers are ordinary nodes with the same config
                  surface as everything else — nothing special to learn.
                </p>
                <ul className="mt-6 space-y-2.5">
                  {[
                    "Endpoint paths with HMAC or shared-secret auth",
                    "Cron and interval schedules with timezone control",
                    "Event filters before a single step runs",
                  ].map((point) => (
                    <li key={point} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                      <span className="text-[13.5px] leading-snug text-muted">
                        {point}
                      </span>
                    </li>
                  ))}
                </ul>
              </FadeUp>
            </div>

            <FadeUp y={22}>
              <ul className="border-t border-line">
                {TRIGGERS.map((trigger) => (
                  <li
                    key={trigger.title}
                    className="group flex items-center gap-4 border-b border-hairline py-4 transition-colors duration-micro hover:bg-raised/55"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-cat-trigger/35 bg-cat-trigger/12 text-cat-trigger">
                      <Glyph name={trigger.icon} className="h-4 w-4" />
                    </span>
                    <span className="kz-display min-w-0 flex-1 text-[15.5px] font-medium text-fg">
                      {trigger.title}
                    </span>
                    <span className="kz-num hidden truncate text-[12px] text-subtle sm:block">
                      {trigger.detail}
                    </span>
                    <span className="kz-eyebrow text-[9px]">Trigger</span>
                  </li>
                ))}
              </ul>
            </FadeUp>
          </div>
        </section>

        {/* ------------------------------------------------- failures */}
        <section id="errors" className="border-b border-edge">
          <div className="kz-frame grid items-start gap-12 py-20 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-20 lg:py-24">
            <div>
              <p className="kz-eyebrow mb-5">Failures</p>
              <SplitHeading
                text="An error that tells you what to do next."
                className="max-w-[16ch] text-display-sm font-semibold text-fg"
              />
              <FadeUp delay={0.15}>
                <p className="mt-6 max-w-[54ch] text-[15px] leading-relaxed text-muted">
                  Failures carry a code, the response detail and a concrete
                  remediation — not a stack trace you have to decode. Stop at the
                  failed step, fix it, and re-run from there.
                </p>
              </FadeUp>
            </div>

            <FadeUp y={24}>
              <div className="border border-danger/40 bg-panel">
                <div className="flex items-center gap-2.5 border-b border-danger/25 bg-danger-soft px-4 py-3">
                  <TriangleAlert className="h-4 w-4 text-danger" />
                  <span className="kz-display text-[13.5px] font-medium text-danger">
                    Step failed
                  </span>
                  <span className="kz-num ml-auto text-[11px] text-danger/80">
                    {errorCard.code}
                  </span>
                </div>

                <dl className="divide-y divide-hairline px-4">
                  {[
                    ["Step", errorCard.step, "kz-num break-all text-muted"],
                    ["Error", errorCard.message, "text-fg"],
                    ["Detail", errorCard.detail, "text-muted"],
                    ["Fix", errorCard.fix, "text-ok"],
                  ].map(([label, value, tone]) => (
                    <div key={label} className="flex gap-4 py-3">
                      <dt className="kz-eyebrow w-16 shrink-0 pt-0.5 text-[9px]">
                        {label}
                      </dt>
                      <dd className={`min-w-0 text-[12.5px] leading-snug ${tone}`}>
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </FadeUp>
          </div>
        </section>

        {/* ------------------------------------------------------ cta */}
        <section className="border-b border-edge bg-canvas">
          <div className="kz-frame py-24 lg:py-32">
            <SplitHeading
              text="Open the editor and drop a node."
              className="max-w-[16ch] text-display-md font-semibold text-fg"
            />
            <FadeUp delay={0.15}>
              <p className="mt-7 max-w-[58ch] text-[15.5px] leading-relaxed text-muted">
                The demo runs entirely in your browser — no account, no deploy,
                no config files. Draft workflows and execution history are stored
                locally until the backend connects.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Link
                  href="/workflows?new=1"
                  className={buttonClassName("primary", "lg", "group")}
                >
                  <Roll>Start building</Roll>
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/integrations"
                  className={buttonClassName("secondary", "lg", "group")}
                >
                  <Roll>See the connectors</Roll>
                </Link>
              </div>
            </FadeUp>
          </div>
        </section>
      </main>

      {/* ----------------------------------------------------- footer */}
      <footer className="overflow-hidden">
        <div className="kz-frame pt-12">
          <div className="flex flex-col gap-8 border-b border-hairline pb-10 sm:flex-row sm:items-start">
            <div className="flex items-center gap-3">
              <Link href="/" aria-label="KLYZ home">
                <KlyzMark className="h-6 w-6 text-fg" />
              </Link>
              <p className="text-[12.5px] text-subtle">
                Local build — workflow drafts stay in this browser.
              </p>
            </div>

            <nav
              className="flex flex-wrap items-center gap-x-6 gap-y-3 sm:ml-auto"
              aria-label="Footer"
            >
              {["Dashboard", "Workflows", "Integrations", "Settings"].map(
                (label) => (
                  <Link
                    key={label}
                    href={`/${label.toLowerCase()}`}
                    className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle transition-colors duration-micro hover:text-fg"
                  >
                    {label}
                  </Link>
                ),
              )}
            </nav>
          </div>
        </div>

        <div className="kz-frame" aria-hidden>
          <span className="kz-display block select-none text-center text-[clamp(5rem,21vw,22rem)] font-semibold uppercase leading-[0.78] tracking-[-0.045em] text-transparent [-webkit-text-stroke:1px_var(--kz-line)] translate-y-[0.14em]">
            KLYZ
          </span>
        </div>
      </footer>
    </div>
  );
}
