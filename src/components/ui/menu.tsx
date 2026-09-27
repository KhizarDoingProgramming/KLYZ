"use client";

import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onSelect: () => void;
}

/**
 * Compact dropdown used for row actions and the workflow status menu.
 * Implements the WAI-ARIA menu-button pattern: opening moves focus into
 * the menu, ArrowUp/ArrowDown/Home/End move between items, Escape closes
 * and returns focus to the trigger, Tab dismisses.
 */
export function Menu({
  trigger,
  items,
  align = "end",
  label = "More actions",
}: {
  trigger: (props: {
    onClick: () => void;
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
    ref: React.Ref<HTMLButtonElement>;
  }) => React.ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      const first = rootRef.current?.querySelector<HTMLButtonElement>(
        'button:not([disabled])',
      );
      first?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <MotionConfig reducedMotion="user">
      <div ref={rootRef} className="relative">
      {trigger({
        onClick: () => setOpen((value) => !value),
        "aria-expanded": open,
        "aria-haspopup": "menu",
        ref: triggerRef,
      })}

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label={label}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -3, scale: 0.99 }}
            transition={MOTION.micro}
            className={cn(
              "absolute z-30 mt-1.5 min-w-[188px] overflow-hidden rounded-md border border-line bg-overlay p-1 shadow-md",
              align === "end" ? "right-0" : "left-0",
            )}
            onKeyDown={(event) => {
              const menu = event.currentTarget;
              const buttons = Array.from(
                menu.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
              );
              if (buttons.length === 0) return;
              const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const focusAt = (index: number) => {
                event.preventDefault();
                buttons[(index + buttons.length) % buttons.length]?.focus();
              };
              if (event.key === "ArrowDown") focusAt(current + 1);
              else if (event.key === "ArrowUp") focusAt(current - 1);
              else if (event.key === "Home") focusAt(0);
              else if (event.key === "End") focusAt(buttons.length - 1);
              else if (event.key === "Tab") setOpen(false);
            }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  triggerRef.current?.focus();
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
                  item.danger
                    ? "text-danger hover:bg-danger-soft"
                    : "text-muted hover:bg-raised hover:text-fg",
                  item.disabled && "pointer-events-none opacity-45",
                )}
              >
                {item.icon && <span className="shrink-0">{item.icon}</span>}
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="kz-num shrink-0 text-[10px] text-subtle">
                    {item.shortcut}
                  </span>
                )}
              </button>
            ))}
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
