import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "quiet" | "danger";
type Size = "sm" | "md" | "lg" | "icon" | "iconSm";

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-signal text-on-signal font-medium hover:bg-signal-hover disabled:bg-disabled disabled:text-panel/60 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]",
  secondary:
    "bg-surface text-fg border border-line hover:bg-raised hover:border-strong disabled:text-disabled disabled:hover:bg-surface",
  ghost:
    "text-muted hover:text-fg hover:bg-raised border border-transparent hover:border-edge disabled:text-disabled",
  quiet:
    "text-subtle hover:text-fg hover:bg-raised border border-transparent disabled:text-disabled",
  danger:
    "bg-danger-soft text-danger border border-danger/30 hover:bg-danger/15 hover:border-danger/50",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-2 rounded-md",
  lg: "h-10 px-4 text-sm gap-2 rounded-md",
  icon: "h-8 w-8 rounded-md",
  iconSm: "h-7 w-7 rounded-sm",
};

const BASE =
  "inline-flex select-none items-center justify-center whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-micro ease-out " +
  "disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

/** Shared classes so links can be styled identically to a Button. */
export function buttonClassName(
  variant: Variant = "secondary",
  size: Size = "md",
  className?: string,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "secondary", size = "md", type = "button", ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClassName(variant, size, className)}
        {...props}
      />
    );
  },
);

