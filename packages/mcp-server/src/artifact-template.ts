/**
 * Artifact template for the PIM pod dashboard.
 * Produces a single-file React component designed for Claude.ai's artifact sandbox.
 * Tailwind CSS + lucide-react only — no external packages.
 */

export function buildArtifact(data: unknown): string {
  const json = JSON.stringify(data, null, 2);
  return TEMPLATE.replace("__PIM_DATA__", json);
}

const TEMPLATE = `import { useState, useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Clock,
  GitBranch,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  FileText,
  Search,
  Filter,
  Zap,
  CircleDot,
  Info,
  XCircle,
  MessageSquare,
  HelpCircle,
} from "lucide-react";

// ─── Data ────────────────────────────────────────────────────────────────────
const DATA = __PIM_DATA__;

// ─── Utilities ───────────────────────────────────────────────────────────────

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

function getPressureLevel(p) {
  if (p <= 0.3) return "normal";
  if (p <= 0.6) return "cautious";
  if (p <= 0.8) return "degraded";
  return "critical";
}

function getPressureColor(level) {
  return {
    normal: "bg-emerald-500",
    cautious: "bg-amber-500",
    degraded: "bg-orange-500",
    critical: "bg-red-500",
  }[level];
}

function getPressureTextColor(level) {
  return {
    normal: "text-emerald-400",
    cautious: "text-amber-400",
    degraded: "text-orange-400",
    critical: "text-red-400",
  }[level];
}

function getPressureBgLight(level) {
  return {
    normal: "bg-emerald-500/10 border-emerald-500/30",
    cautious: "bg-amber-500/10 border-amber-500/30",
    degraded: "bg-orange-500/10 border-orange-500/30",
    critical: "bg-red-500/10 border-red-500/30",
  }[level];
}

function getStatusColor(status) {
  return {
    done: "bg-emerald-500",
    in_progress: "bg-blue-500",
    waiting: "bg-gray-500",
    blocked: "bg-red-500",
  }[status] ?? "bg-gray-500";
}

function getStatusLabel(status) {
  return {
    done: "Done",
    in_progress: "In Progress",
    waiting: "Waiting",
    blocked: "Blocked",
  }[status] ?? status;
}

function getTunnelColor(status) {
  return {
    active: "bg-emerald-500",
    idle: "bg-amber-500",
    disconnected: "bg-gray-500",
  }[status] ?? "bg-gray-500";
}

function getTypeIcon(type) {
  const icons = {
    progress: Activity,
    blocker: XCircle,
    spec_change: FileText,
    question: HelpCircle,
    decision: CheckCircle2,
  };
  return icons[type] ?? CircleDot;
}

function getTypeColor(type) {
  return {
    progress: "text-blue-400",
    blocker: "text-red-400",
    spec_change: "text-purple-400",
    question: "text-amber-400",
    decision: "text-emerald-400",
  }[type] ?? "text-gray-400";
}

function getScopeLabel(scope) {
  return {
    frontend: "Frontend",
    backend: "Backend",
    design: "Design",
    qa: "QA",
    infra: "Infra",
    pm: "PM",
  }[scope] ?? scope;
}

function getScopeBadgeColor(scope) {
  return {
    frontend: "bg-blue-500/20 text-blue-300",
    backend: "bg-emerald-500/20 text-emerald-300",
    design: "bg-purple-500/20 text-purple-300",
    qa: "bg-amber-500/20 text-amber-300",
    infra: "bg-orange-500/20 text-orange-300",
    pm: "bg-pink-500/20 text-pink-300",
  }[scope] ?? "bg-gray-500/20 text-gray-300";
}

// ─── Minimal Markdown Renderer ───────────────────────────────────────────────

function renderMarkdown(md) {
  if (!md) return null;
  const lines = md.split("\\n");
  const elements = [];
  let i = 0;
  let inCodeBlock = false;
  let codeLines = [];
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("\\\`\\\`\\\`")) {
      if (inCodeBlock) {
        elements.push(
          <pre key={key++} className="bg-gray-800 rounded p-3 text-sm overflow-x-auto my-2">
            <code className="text-gray-300">{codeLines.join("\\n")}</code>
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      i++;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      elements.push(<h3 key={key++} className="text-lg font-semibold text-gray-100 mt-4 mb-2">{formatInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={key++} className="text-xl font-bold text-gray-100 mt-5 mb-2">{formatInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={key++} className="text-2xl font-bold text-gray-100 mt-6 mb-3">{formatInline(line.slice(2))}</h1>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(<li key={key++} className="text-gray-300">{formatInline(lines[i].slice(2))}</li>);
        i++;
      }
      elements.push(<ul key={key++} className="list-disc list-inside my-2 space-y-1">{items}</ul>);
      continue;
    } else if (line.startsWith("---") || line.startsWith("***")) {
      elements.push(<hr key={key++} className="border-gray-700 my-4" />);
    } else if (line.trim() === "") {
      elements.push(<div key={key++} className="h-2" />);
    } else {
      elements.push(<p key={key++} className="text-gray-300 my-1">{formatInline(line)}</p>);
    }
    i++;
  }
  return elements;
}

function formatInline(text) {
  const parts = [];
  let remaining = text;
  let k = 0;
  const regex = /(\\\*\\\*(.+?)\\\*\\\*|\\\*(.+?)\\\*|\\\`(.+?)\\\`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(remaining)) !== null) {
    if (match.index > lastIndex) {
      parts.push(remaining.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={k++} className="font-semibold text-gray-100">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={k++} className="italic">{match[3]}</em>);
    } else if (match[4]) {
      parts.push(<code key={k++} className="bg-gray-800 px-1.5 py-0.5 rounded text-sm text-gray-200">{match[4]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < remaining.length) {
    parts.push(remaining.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}

// ─── Components ──────────────────────────────────────────────────────────────

function Badge({ children, className = "" }) {
  return (
    <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium " + className}>
      {children}
    </span>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={"bg-gray-900 border border-gray-700 rounded-lg p-4 " + className}>
      {children}
    </div>
  );
}

function StatusDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={"w-2 h-2 rounded-full " + color} />
      <span className="text-sm text-gray-300">{label}</span>
    </span>
  );
}

// ─── Health Banner ───────────────────────────────────────────────────────────

function HealthBanner({ pressure, openConflicts }) {
  const level = getPressureLevel(pressure);
  if (level === "normal") return null;

  const messages = {
    cautious: "Merge caution active — some areas have overlapping updates.",
    degraded: "Contested areas on hold — conflicts need resolution before merging can resume.",
    critical: "Ingestion halted — critical conflicts must be resolved immediately.",
  };

  const icons = {
    cautious: <Info className="w-5 h-5 text-amber-400 shrink-0" />,
    degraded: <AlertTriangle className="w-5 h-5 text-orange-400 shrink-0" />,
    critical: <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />,
  };

  return (
    <div className={"flex items-start gap-3 p-3 rounded-lg border " + getPressureBgLight(level)}>
      {icons[level]}
      <div>
        <p className={"text-sm font-medium " + getPressureTextColor(level)}>{messages[level]}</p>
        <p className="text-xs text-gray-400 mt-0.5">{openConflicts} open conflict{openConflicts !== 1 ? "s" : ""} &middot; Pressure: {(pressure * 100).toFixed(0)}%</p>
      </div>
    </div>
  );
}

// ─── Pod Header ──────────────────────────────────────────────────────────────

function PodHeader({ pod }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">{pod.name}</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {pod.sprint_start} &rarr; {pod.sprint_end}
        </p>
      </div>
      <Badge className="bg-blue-500/20 text-blue-300 text-sm px-3 py-1">
        Day {pod.day_number} / {pod.total_days}
      </Badge>
    </div>
  );
}

// ─── Pressure Gauge ──────────────────────────────────────────────────────────

function PressureGauge({ pressure }) {
  const level = getPressureLevel(pressure);
  const pct = Math.min(pressure * 100, 100);

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-300">Conflict Pressure</h3>
        <span className={"text-sm font-semibold " + getPressureTextColor(level)}>
          {pct.toFixed(0)}% &middot; {level.charAt(0).toUpperCase() + level.slice(1)}
        </span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={"h-full rounded-full transition-all " + getPressureColor(level)}
          style={{ width: pct + "%" }}
        />
      </div>
      <div className="flex justify-between mt-1.5 text-xs text-gray-500">
        <span>0%</span>
        <span>30%</span>
        <span>60%</span>
        <span>80%</span>
        <span>100%</span>
      </div>
    </Card>
  );
}

// ─── Milestone Progress ──────────────────────────────────────────────────────

function MilestoneProgress({ milestone }) {
  const pct = milestone.percent_complete;
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-300">{milestone.name}</h3>
        <span className="text-sm font-semibold text-gray-200">{pct}%</span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-500 transition-all"
          style={{ width: pct + "%" }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1.5">Target: {milestone.target_date}</p>
    </Card>
  );
}

// ─── Status By Area ──────────────────────────────────────────────────────────

function StatusByArea({ areas }) {
  return (
    <Card>
      <h3 className="text-sm font-medium text-gray-300 mb-3">Status by Area</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-2 px-2 text-gray-400 font-medium">Scope</th>
              <th className="text-left py-2 px-2 text-gray-400 font-medium">Owner</th>
              <th className="text-left py-2 px-2 text-gray-400 font-medium">Status</th>
              <th className="text-left py-2 px-2 text-gray-400 font-medium">Last Activity</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => (
              <tr key={a.scope} className="border-b border-gray-800 hover:bg-gray-800/50">
                <td className="py-2 px-2">
                  <Badge className={getScopeBadgeColor(a.scope)}>{getScopeLabel(a.scope)}</Badge>
                </td>
                <td className="py-2 px-2 text-gray-300">{a.owner}</td>
                <td className="py-2 px-2"><StatusDot color={getStatusColor(a.status)} label={getStatusLabel(a.status)} /></td>
                <td className="py-2 px-2 text-gray-500">{a.last_activity ? timeAgo(a.last_activity) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Open Conflicts List ─────────────────────────────────────────────────────

function OpenConflictsList({ conflicts, onSelect }) {
  const open = conflicts.filter((c) => c.status !== "resolved");
  return (
    <Card className="flex-1 min-w-[280px]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-300">Open Conflicts</h3>
        <Badge className="bg-gray-700 text-gray-300">{open.length}</Badge>
      </div>
      {open.length === 0 ? (
        <p className="text-sm text-gray-500">No open conflicts</p>
      ) : (
        <div className="space-y-2">
          {open.slice(0, 5).map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className="w-full text-left p-2 rounded hover:bg-gray-800 transition-colors"
            >
              <div className="flex items-start gap-2">
                {c.severity === "blocking" ? (
                  <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-sm text-gray-200 truncate">{c.summary}</p>
                  <p className="text-xs text-gray-500">{timeAgo(c.created_at)} &middot; {c.status.replace("_", " ")}</p>
                </div>
              </div>
            </button>
          ))}
          {open.length > 5 && (
            <p className="text-xs text-gray-500 pl-2">+ {open.length - 5} more</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Active Tunnels Summary ──────────────────────────────────────────────────

function TunnelsSummary({ tunnels }) {
  return (
    <Card className="flex-1 min-w-[280px]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-300">Tunnels</h3>
        <Badge className="bg-gray-700 text-gray-300">{tunnels.length}</Badge>
      </div>
      {tunnels.length === 0 ? (
        <p className="text-sm text-gray-500">No active tunnels</p>
      ) : (
        <div className="space-y-2">
          {tunnels.map((t) => (
            <div key={t.tunnel_id} className="flex items-center gap-2 p-2 rounded bg-gray-800/50">
              <StatusDot color={getTunnelColor(t.status)} label="" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 truncate">{t.dev_name}</p>
                <div className="flex items-center gap-1.5 text-xs text-gray-500">
                  <GitBranch className="w-3 h-3" />
                  <span className="truncate">{t.branch}</span>
                </div>
              </div>
              <span className="text-xs text-gray-500">{timeAgo(t.last_activity)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Recent Activity ─────────────────────────────────────────────────────────

function RecentActivity({ updates }) {
  const recent = [...updates].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5);
  return (
    <Card>
      <h3 className="text-sm font-medium text-gray-300 mb-3">Recent Activity</h3>
      {recent.length === 0 ? (
        <p className="text-sm text-gray-500">No activity yet</p>
      ) : (
        <div className="space-y-2">
          {recent.map((u) => {
            const Icon = getTypeIcon(u.type);
            return (
              <div key={u.id} className="flex items-start gap-2">
                <Icon className={"w-4 h-4 mt-0.5 shrink-0 " + getTypeColor(u.type)} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-200 truncate">{u.summary}</p>
                  <p className="text-xs text-gray-500">
                    {u.agent_id} &middot; <Badge className={getScopeBadgeColor(u.scope) + " text-[10px] px-1.5 py-0"}>{getScopeLabel(u.scope)}</Badge> &middot; {timeAgo(u.timestamp)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ─── Lint Findings ───────────────────────────────────────────────────────────

function LintFindings({ findings }) {
  if (!findings || findings.length === 0) return null;
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Zap className="w-4 h-4 text-amber-400" />
        <h3 className="text-sm font-medium text-gray-300">Lint Findings</h3>
        <Badge className="bg-gray-700 text-gray-300">{findings.length}</Badge>
      </div>
      <div className="space-y-2">
        {findings.slice(0, 5).map((f) => (
          <div key={f.id} className="flex items-start gap-2 text-sm">
            <span className={f.severity === "warning" ? "text-amber-400" : "text-gray-400"}>
              {f.severity === "warning" ? "⚠" : "ℹ"}
            </span>
            <div>
              <p className="text-gray-300">{f.summary}</p>
              {f.suggestion && <p className="text-xs text-gray-500 mt-0.5">{f.suggestion}</p>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Dashboard Tab ───────────────────────────────────────────────────────────

function DashboardTab({ onConflictSelect }) {
  const openConflicts = DATA.conflicts.filter((c) => c.status !== "resolved").length;
  return (
    <div className="space-y-5">
      <HealthBanner pressure={DATA.pod.conflict_pressure} openConflicts={openConflicts} />
      <PodHeader pod={DATA.pod} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PressureGauge pressure={DATA.pod.conflict_pressure} />
        <MilestoneProgress milestone={DATA.pod.milestone} />
      </div>
      <StatusByArea areas={DATA.pod.areas} />
      <div className="flex gap-4 flex-wrap">
        <OpenConflictsList conflicts={DATA.conflicts} onSelect={onConflictSelect} />
        <TunnelsSummary tunnels={DATA.tunnels} />
      </div>
      <RecentActivity updates={DATA.contextUpdates} />
      <LintFindings findings={DATA.lintFindings} />
    </div>
  );
}

// ─── Conflicts Tab ───────────────────────────────────────────────────────────

function ConflictDetail({ conflict }) {
  return (
    <div className="mt-3 p-4 bg-gray-800/50 rounded-lg border border-gray-700 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-300 mb-2">Positions</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {conflict.sides.map((s, i) => (
            <div key={i} className="p-3 bg-gray-900 rounded border border-gray-700">
              <p className="text-xs font-medium text-blue-400 mb-1">{s.contributor}</p>
              <p className="text-sm text-gray-300">{s.position}</p>
              <p className="text-xs text-gray-500 mt-1">{timeAgo(s.timestamp)}</p>
            </div>
          ))}
        </div>
      </div>
      {conflict.master_analysis && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-1">PIM analysis</h4>
          <p className="text-sm text-gray-400">{conflict.master_analysis}</p>
        </div>
      )}
      {conflict.impact && conflict.impact.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-1">Impact</h4>
          <ul className="list-disc list-inside text-sm text-gray-400 space-y-0.5">
            {conflict.impact.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {conflict.resolution && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded">
          <h4 className="text-sm font-medium text-emerald-400 mb-1">Resolution</h4>
          <p className="text-sm text-gray-300">{conflict.resolution}</p>
          <p className="text-xs text-gray-500 mt-1">By {conflict.resolved_by} &middot; {timeAgo(conflict.resolution_date)}</p>
        </div>
      )}
    </div>
  );
}

function ConflictsTab() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);

  const filtered = DATA.conflicts.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (severityFilter !== "all" && c.severity !== severityFilter) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="in_discussion">In Discussion</option>
            <option value="resolved">Resolved</option>
          </select>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
          >
            <option value="all">All severities</option>
            <option value="blocking">Blocking</option>
            <option value="non_blocking">Non-blocking</option>
          </select>
        </div>
        <span className="text-xs text-gray-500">{filtered.length} conflict{filtered.length !== 1 ? "s" : ""}</span>
      </div>

      {filtered.length === 0 ? (
        <Card><p className="text-sm text-gray-500">No conflicts match filters</p></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <Card key={c.id} className="p-0">
              <button
                onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                className="w-full text-left p-4 flex items-start gap-3 hover:bg-gray-800/30 transition-colors rounded-lg"
              >
                {expandedId === c.id ? (
                  <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-gray-200">{c.summary}</p>
                    <Badge className={c.severity === "blocking" ? "bg-red-500/20 text-red-300" : "bg-gray-600 text-gray-300"}>
                      {c.severity === "blocking" ? "Blocking" : "Non-blocking"}
                    </Badge>
                    <Badge className={
                      c.status === "open" ? "bg-amber-500/20 text-amber-300" :
                      c.status === "in_discussion" ? "bg-blue-500/20 text-blue-300" :
                      "bg-emerald-500/20 text-emerald-300"
                    }>
                      {c.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {c.sides.length} position{c.sides.length !== 1 ? "s" : ""} &middot; {timeAgo(c.created_at)}
                  </p>
                </div>
              </button>
              {expandedId === c.id && (
                <div className="px-4 pb-4">
                  <ConflictDetail conflict={c} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Feed Tab ────────────────────────────────────────────────────────────────

function FeedTab() {
  const [scopeFilter, setScopeFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  const sorted = useMemo(() => {
    return [...DATA.contextUpdates]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .filter((u) => {
        if (scopeFilter !== "all" && u.scope !== scopeFilter) return false;
        if (typeFilter !== "all" && u.type !== typeFilter) return false;
        if (searchText && !u.summary.toLowerCase().includes(searchText.toLowerCase()) && !u.details.toLowerCase().includes(searchText.toLowerCase())) return false;
        return true;
      });
  }, [scopeFilter, typeFilter, searchText]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search updates..."
            className="w-full bg-gray-800 border border-gray-700 rounded pl-8 pr-3 py-1.5 text-sm text-gray-300 placeholder-gray-500"
          />
        </div>
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300"
        >
          <option value="all">All scopes</option>
          <option value="frontend">Frontend</option>
          <option value="backend">Backend</option>
          <option value="design">Design</option>
          <option value="qa">QA</option>
          <option value="infra">Infra</option>
          <option value="pm">PM</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300"
        >
          <option value="all">All types</option>
          <option value="progress">Progress</option>
          <option value="blocker">Blocker</option>
          <option value="spec_change">Spec Change</option>
          <option value="question">Question</option>
          <option value="decision">Decision</option>
        </select>
        <span className="text-xs text-gray-500">{sorted.length} update{sorted.length !== 1 ? "s" : ""}</span>
      </div>

      {sorted.length === 0 ? (
        <Card><p className="text-sm text-gray-500">No updates match filters</p></Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((u) => {
            const Icon = getTypeIcon(u.type);
            const isExpanded = expandedId === u.id;
            return (
              <Card key={u.id} className="p-0">
                <button
                  onClick={() => setExpandedId(isExpanded ? null : u.id)}
                  className="w-full text-left p-3 flex items-start gap-3 hover:bg-gray-800/30 transition-colors rounded-lg"
                >
                  <Icon className={"w-4 h-4 mt-0.5 shrink-0 " + getTypeColor(u.type)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-gray-200">{u.summary}</p>
                      <Badge className={getScopeBadgeColor(u.scope)}>{getScopeLabel(u.scope)}</Badge>
                      <StatusDot
                        color={u.status === "completed" ? "bg-emerald-500" : u.status === "blocked" ? "bg-red-500" : "bg-blue-500"}
                        label={getStatusLabel(u.status) || u.status}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{u.agent_id} &middot; {timeAgo(u.timestamp)}</p>
                  </div>
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                  )}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-3 pt-0 space-y-2 border-t border-gray-800 mx-3">
                    <p className="text-sm text-gray-300 mt-2 whitespace-pre-wrap">{u.details}</p>
                    {u.artifacts && u.artifacts.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-400 mb-1">Artifacts</p>
                        <div className="flex gap-2 flex-wrap">
                          {u.artifacts.map((a, i) => (
                            <Badge key={i} className="bg-gray-700 text-gray-300">{a.type}{a.path ? ": " + a.path : ""}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {u.blocks && u.blocks.length > 0 && (
                      <p className="text-xs text-red-400">Blocks: {u.blocks.join(", ")}</p>
                    )}
                    {u.blocked_by && u.blocked_by.length > 0 && (
                      <p className="text-xs text-amber-400">Blocked by: {u.blocked_by.join(", ")}</p>
                    )}
                    {u.needs_input_from && u.needs_input_from.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-400 mb-1">Needs input from</p>
                        {u.needs_input_from.map((req, i) => (
                          <p key={i} className="text-xs text-gray-400">
                            <Badge className={getScopeBadgeColor(req.role) + " text-[10px] px-1.5 py-0"}>{getScopeLabel(req.role)}</Badge> {req.question}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Live Doc Tab ────────────────────────────────────────────────────────────

function LiveDocTab() {
  return (
    <Card>
      <div className="prose prose-invert max-w-none">
        {renderMarkdown(DATA.livingDoc)}
      </div>
    </Card>
  );
}

// ─── Root Component ──────────────────────────────────────────────────────────

const TABS = [
  { id: "dashboard", label: "Dashboard", icon: Activity },
  { id: "conflicts", label: "Conflicts", icon: AlertTriangle },
  { id: "feed", label: "Feed", icon: MessageSquare },
  { id: "doc", label: "Live Doc", icon: FileText },
];

export default function PimDashboard() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedConflict, setSelectedConflict] = useState(null);

  const handleConflictSelect = (id) => {
    setSelectedConflict(id);
    setActiveTab("conflicts");
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-gray-800 mb-5 pb-0">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={
                "flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px " +
                (isActive
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-gray-400 hover:text-gray-200")
              }
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              {tab.id === "conflicts" && (
                <span className={"ml-1 text-xs px-1.5 py-0 rounded-full " + (
                  DATA.conflicts.filter((c) => c.status !== "resolved").length > 0
                    ? "bg-red-500/20 text-red-300"
                    : "bg-gray-700 text-gray-400"
                )}>
                  {DATA.conflicts.filter((c) => c.status !== "resolved").length}
                </span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        <span className="text-xs text-gray-600 pb-2">Snapshot: {new Date(DATA.generatedAt).toLocaleString()}</span>
      </div>

      {/* Tab content */}
      {activeTab === "dashboard" && <DashboardTab onConflictSelect={handleConflictSelect} />}
      {activeTab === "conflicts" && <ConflictsTab />}
      {activeTab === "feed" && <FeedTab />}
      {activeTab === "doc" && <LiveDocTab />}
    </div>
  );
}
`;
