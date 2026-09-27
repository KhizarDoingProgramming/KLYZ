import * as React from "react";
import { cn } from "@/lib/utils";

export function Panel({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
  flush = false,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Removes body padding — for list-style content. */
  flush?: boolean;
}) {
  return (
    <section className={cn("border-t border-line", className)}>
      <header className="flex items-start justify-between gap-3 py-3.5">
        <div className="min-w-0">
          <h2 className="kz-display text-[14.5px] font-semibold leading-snug tracking-[-0.01em] text-fg">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 max-w-[62ch] text-[12.5px] leading-snug text-subtle">
              {description}
            </p>
          )}
        </div>
        {action}
      </header>
      <div className={cn(!flush && "pb-4", bodyClassName)}>{children}</div>
    </section>
  );
}
