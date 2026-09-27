import { cn } from "@/lib/utils";

/**
 * Two stacked copies of a label inside an overflow-hidden window.
 * A `.group:hover` on any ancestor rolls the track up one line.
 */
export function Roll({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={cn("kz-roll", className)}>
      <span className="kz-roll-track">
        <span>{children}</span>
        <span aria-hidden>{children}</span>
      </span>
    </span>
  );
}
