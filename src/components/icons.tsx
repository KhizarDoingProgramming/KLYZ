import * as React from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleMinus,
  CirclePause,
  CircleX,
  Clock,
  Command,
  Copy,
  Database,
  Ellipsis,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  GitBranch,
  Globe,
  Inbox,
  Layers,
  LayoutDashboard,
  ListChecks,
  Loader,
  Mail,
  Maximize2,
  Minus,
  Moon,
  MoreHorizontal,
  Network,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Plug,
  Redo2,
  RefreshCw,
  Repeat,
  ScanLine,
  Search,
  Send,
  Settings,
  Share2,
  SlidersHorizontal,
  Split,
  Sparkles,
  Sun,
  Tags,
  Terminal,
  Timer,
  Undo2,
  Variable,
  Webhook,
  Workflow,
  X,
  Zap,
  Users,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Integration marks                                                   */
/*                                                                     */
/* Brand glyphs are filled so they stay legible at 16px inside the     */
/* category chip; everything else uses Lucide's stroke language.       */
/* ------------------------------------------------------------------ */

type IconProps = React.SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  viewBox: "0 0 24 24",
  width: 24,
  height: 24,
  fill: "none",
  ...props,
});

function GitHubMark(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" aria-hidden>
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.29 0 .32.21.7.82.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
    </svg>
  );
}

function SlackMark(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" aria-hidden>
      <path d="M5.04 15.17a2.53 2.53 0 0 1-2.52 2.52A2.53 2.53 0 0 1 0 15.17a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52ZM6.31 15.17a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.31A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.31ZM8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52H8.83ZM8.83 6.31a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31ZM18.96 8.83a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52V8.83ZM17.69 8.83a2.53 2.53 0 0 1-2.53 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 15.16 0a2.53 2.53 0 0 1 2.53 2.52v6.31ZM15.16 18.96a2.53 2.53 0 0 1 2.53 2.52A2.53 2.53 0 0 1 15.16 24a2.53 2.53 0 0 1-2.52-2.52v-2.52h2.52ZM15.16 17.69a2.53 2.53 0 0 1-2.52-2.53 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 15.16a2.53 2.53 0 0 1-2.52 2.53h-6.32Z" />
    </svg>
  );
}

function NotionMark(props: IconProps) {
  return (
    <svg
      {...base(props)}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="3.4" />
      <path d="M8.6 16.4V7.6l6.8 8.8V7.6" />
    </svg>
  );
}

function SheetsMark(props: IconProps) {
  return (
    <svg
      {...base(props)}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3.4h7.4L18.6 8.6V20.6H6z" />
      <path d="M13.4 3.4v5.2h5.2" />
      <path d="M9 12.4h6.6M9 15.6h6.6M12.3 12.4v7" />
    </svg>
  );
}

function PostgresMark(props: IconProps) {
  return (
    <svg
      {...base(props)}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <ellipse cx="12" cy="6.4" rx="7.2" ry="3" />
      <path d="M4.8 6.4v11.2c0 1.66 3.22 3 7.2 3s7.2-1.34 7.2-3V6.4" />
      <path d="M4.8 12c0 1.66 3.22 3 7.2 3s7.2-1.34 7.2-3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Registry-driven icon lookup                                         */
/* ------------------------------------------------------------------ */

type AnyIcon = React.ComponentType<React.SVGProps<SVGSVGElement>>;

const ICONS: Record<string, AnyIcon> = {
  webhook: Webhook,
  clock: Clock,
  play: Play,
  mail: Mail,
  slack: SlackMark,
  sheet: SheetsMark,
  notion: NotionMark,
  github: GitHubMark,
  postgres: PostgresMark,
  database: Database,
  globe: Globe,
  "git-branch": GitBranch,
  split: Split,
  timer: Timer,
  filter: Filter,
  repeat: Repeat,
  braces: Braces,
  scan: ScanLine,
  sparkle: Sparkles,
  tags: Tags,
  wand: Sparkles,
  variable: Variable,

  /* shell + chrome */
  dashboard: LayoutDashboard,
  workflow: Workflow,
  runs: Activity,
  integrations: Plug,
  team: Users,
  settings: Settings,
  search: Search,
  command: Command,
  plus: Plus,
  sun: Sun,
  moon: Moon,
  panelLeft: PanelLeft,
  panelRight: PanelRight,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  check: Check,
  close: X,
  minus: Minus,
  copy: Copy,
  undo: Undo2,
  redo: Redo2,
  fit: Maximize2,
  more: MoreHorizontal,
  dots: Ellipsis,
  arrowRight: ArrowRight,
  circleCheck: CircleCheck,
  circleX: CircleX,
  circleMinus: CircleMinus,
  circlePause: CirclePause,
  circleDot: CircleDot,
  circle: Circle,
  spinner: Loader,
  alert: AlertTriangle,
  zap: Zap,
  inbox: Inbox,
  send: Send,
  layers: Layers,
  network: Network,
  share: Share2,
  terminal: Terminal,
  file: FileText,
  eye: Eye,
  external: ExternalLink,
  refresh: RefreshCw,
  sliders: SlidersHorizontal,
  list: ListChecks,
  border: SlidersHorizontal,
};

interface NodeIconProps extends React.SVGProps<SVGSVGElement> {
  name: string;
}

/** Resolves a registry icon key to a rendered icon. */
export function Glyph({ name, className, ...props }: NodeIconProps) {
  const Icon = ICONS[name] ?? Circle;
  return <Icon className={className} {...props} />;
}

/** Same lookup but non-null — for the shell where names are compile-time. */
export function ShellGlyph({
  name,
  className,
  ...props
}: NodeIconProps) {
  const Icon = ICONS[name] ?? Circle;
  return <Icon className={className} aria-hidden {...props} />;
}
