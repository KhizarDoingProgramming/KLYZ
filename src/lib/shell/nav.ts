export interface NavItem {
  label: string;
  href: string;
  icon: string;
  /** Matches nested routes, e.g. /workflows/abc matches /workflows. */
  match?: (pathname: string) => boolean;
  shortcut?: string;
}

interface NavSection {
  label?: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { label: "Dashboard", href: "/dashboard", icon: "dashboard" },
      { label: "Workflows", href: "/workflows", icon: "workflow", match: (p) => p.startsWith("/workflows") },
      { label: "Templates", href: "/templates", icon: "layers", match: (p) => p.startsWith("/templates") },
      { label: "AI builder", href: "/ai", icon: "network", match: (p) => p === "/ai" },
      { label: "Executions", href: "/executions", icon: "runs", match: (p) => p.startsWith("/executions") },
    ],
  },
  {
    label: "Workspace",
    items: [
      { label: "Integrations", href: "/integrations", icon: "integrations" },
      { label: "Members", href: "/members", icon: "team" },
      { label: "Audit log", href: "/audit", icon: "runs" },
      { label: "Settings", href: "/settings", icon: "settings" },
    ],
  },
];

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match(pathname);
  return pathname === item.href;
}
