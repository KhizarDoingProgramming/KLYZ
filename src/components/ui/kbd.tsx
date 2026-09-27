import * as React from "react";
import { cn } from "@/lib/utils";

export function Kbd({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-raised px-1 text-[10px] font-medium text-subtle",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
