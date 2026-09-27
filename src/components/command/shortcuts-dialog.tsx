"use client";

import * as React from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { X } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { MOTION } from "@/lib/motion";
import { cn } from "@/lib/utils";

const GROUPS: Array<{ title: string; items: Array<{ keys: string[]; label: string }> }> = [
  {
    title: "Global",
    items: [
      { keys: ["⌘", "K"], label: "Command palette" },
      { keys: ["?"], label: "Keyboard shortcuts" },
      { keys: ["Esc"], label: "Close panel or dialog" },
    ],
  },
  {
    title: "Workflow editor",
    items: [
      { keys: ["⌘", "↵"], label: "Run workflow" },
      { keys: ["⌘", "S"], label: "Save workflow" },
      { keys: ["N"], label: "Add node" },
      { keys: ["⌘", "Z"], label: "Undo" },
      { keys: ["⇧", "⌘", "Z"], label: "Redo" },
      { keys: ["⌘", "D"], label: "Duplicate selected node" },
      { keys: ["⌫"], label: "Delete selection" },
      { keys: ["0"], label: "Fit workflow to view" },
      { keys: ["Scroll"], label: "Zoom canvas" },
    ],
  },
];

export function ShortcutsDialog() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      if (typing) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("klyz:shortcuts", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("klyz:shortcuts", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-70 flex items-center justify-center px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MOTION.micro}
          >
            <button
              type="button"
              aria-label="Close shortcuts"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="kz-scrim absolute inset-0"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Keyboard shortcuts"
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.99 }}
              transition={MOTION.standard}
              className="relative w-full max-w-[560px] overflow-hidden rounded-xl border border-line bg-overlay shadow-lg"
            >
              <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
                <div>
                  <h2 className="text-h3 text-fg">Keyboard shortcuts</h2>
                  <p className="mt-0.5 text-[12px] text-subtle">
                    KLYZ is built to be driven from the keyboard.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
                {GROUPS.map((group) => (
                  <section key={group.title} className="mb-5 last:mb-0">
                    <h3 className="kz-eyebrow mb-2">{group.title}</h3>
                    <dl className="flex flex-col">
                      {group.items.map((item) => (
                        <div
                          key={item.label}
                          className={cn(
                            "flex items-center justify-between gap-4 py-2",
                            "border-b border-hairline last:border-b-0",
                          )}
                        >
                          <dt className="text-[13px] text-muted">{item.label}</dt>
                          <dd className="flex items-center gap-1">
                            {item.keys.map((key, index) => (
                              <Kbd key={`${key}-${index}`}>{key}</Kbd>
                            ))}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

