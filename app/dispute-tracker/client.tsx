"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from "recharts";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  DollarSign,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { DisputeDashboardData, DisputeRow, MerchantAggRow } from "@/lib/db/queries";
import {
  bucketOf,
  classifyTier,
  cn,
  fmt,
  statusBadgeClasses,
  TIER_META,
  type Tier,
} from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  open: "#004AAC",
  needs_response: "#d97706",
  under_review: "#0891b2",
  warning_needs_response: "#d97706",
  warning_under_review: "#0891b2",
  warning_closed: "#7c3aed",
  won: "#16a34a",
  lost: "#dc2626",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status.toLowerCase()] ?? "#6E6E6E";
}

// Resolve the dispute to its provider portal URL. The Stripe account is
// matched on the dispute_id substring rather than d.provider — sheet overrides
// + classifyProvider fallbacks can make d.provider ambiguous, but the dispute
// ID prefix uniquely identifies which Stripe account holds the charge:
//   - acct_1RWHSEI2yvKfCFUI = SellAbroad UAE  → dispute IDs contain "I2yvKfCFUI"
//   - acct_1SbzBXGT489qrT5g = SellAbroad Inc  → everything else with "du_"
function disputeUrl(d: DisputeRow): string | null {
  const id = (d.dispute_id || "").trim();
  if (id.startsWith("du_")) {
    const isUae = id.includes("I2yvKfCFUI");
    const acct = isUae ? "acct_1RWHSEI2yvKfCFUI" : "acct_1SbzBXGT489qrT5g";
    return `https://dashboard.stripe.com/${acct}/disputes/${id}`;
  }
  // Tabby + Tamara portals — Tabby has separate UAE/KSA dashboards (toggle via
  // "Go to KSA"/"Go to UAE"), Tamara serves both from one merchant portal.
  // No public deep-link by dispute UUID, so we link to the disputes list.
  if (/tabby/i.test(d.provider)) {
    return /ksa/i.test(d.provider)
      ? "https://merchants.tabby.ai/ksa/disputes"
      : "https://merchants.tabby.ai/disputes";
  }
  if (/tamara/i.test(d.provider)) {
    // Tamara portal LIMITATION: detail URLs (?merchantId=…) ignore the param
    // and load whichever merchant the session is active on — verified blank
    // page when user is logged into BuyFromAbroad instead of SellAbroad.
    // The LIST URL (?merchantIds=… plural) does respect the param and switches
    // context cleanly. Best-effort deep link until Tamara fixes this: send
    // user to the SellAbroad disputes list filtered to this dispute_id, where
    // they can click into the row in one extra step.
    const merchantId = "d402732d-4592-4ff9-bc17-6cacbf6f5107";
    return `https://partners.tamara.co/#/dispute/list?merchantIds=${merchantId}&search=${encodeURIComponent(id)}`;
  }
  return null;
}

// Label for the "Open in …" button — match the actual processor.
function disputeUrlLabel(d: DisputeRow): string {
  if (/tabby/i.test(d.provider)) return "Open in Tabby";
  if (/tamara/i.test(d.provider)) return "Open in Tamara";
  return "Open in Stripe";
}

// We always show the internal SellAbroad order_id (truncated) regardless of
// whether the merchant is on Shopify or WooCommerce — Shopify order names like
// "#FGUS25875" aren't available for WooCommerce merchants (APR Health, Genetra)
// and switching display per platform looked inconsistent. Full ID is copyable
// from the dispute detail modal.
// Display label for the status badge. Lost + Refunded collapse to "Lost" (same
// outcome — money returned to customer). Won + Cancelled collapse to "Won".
// Open disputes keep their raw substatus (Pending Evidence, Submitted, etc.)
// so the user can see WHERE in the workflow each one sits.
function displayStatus(d: DisputeRow): string {
  if (d.bucket === "lost") return "Lost";
  if (d.bucket === "won") return "Won";
  return d.status;
}

// Display the dispute's evidence deadline. Prefer the parsed date; if the sheet
// only has unparseable text (e.g. "TBC (14-day Tabby SLA)"), surface that text
// so the user sees the original note instead of a meaningless dash.
function displayDeadline(d: DisputeRow): string {
  if (d.evidence_due_at) return fmt.date(d.evidence_due_at);
  if (d.deadline_text) return d.deadline_text;
  return "—";
}

function orderDisplay(d: DisputeRow): string {
  const oid = d.order_id?.trim();
  if (oid) {
    if (oid.length > 14) return oid.slice(0, 10) + "…";
    return oid;
  }
  // Manual / sheet-only disputes don't have a Postgres order_id. For Tabby/
  // Tamara the dispute_id IS the order reference the merchant + payment
  // provider use to look up the case, so fall back to it.
  if (d.is_manual && d.dispute_id) {
    const did = d.dispute_id;
    if (did.length > 14) return did.slice(0, 10) + "…";
    return did;
  }
  return "—";
}

const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #EAEAEA",
  borderRadius: 8,
  color: "#2E2E2E",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
  fontSize: 12,
  padding: "8px 12px",
};

// Static FX rates for USD-normalising dispute amounts. AED + SAR are USD-pegged;
// the others are rough YTD averages — close enough for an exposure summary.
const FX_TO_USD: Record<string, number> = {
  USD: 1,
  AED: 1 / 3.6725,
  SAR: 1 / 3.75,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.74,
  AUD: 0.66,
  KWD: 3.25,
};
function toUsdCents(amountCents: number, currency: string): number {
  const rate = FX_TO_USD[(currency || "USD").toUpperCase()] ?? 1;
  return Math.round(amountCents * rate);
}

// Sort options used across every dispute table on the dashboard.
type SortKey = "newest" | "oldest" | "highest" | "lowest";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "highest", label: "Highest amount" },
  { value: "lowest", label: "Lowest amount" },
];

// USD-normalize the amount so cross-currency comparisons sort fairly
// (SGD 373 vs GBP 105 vs USD 263 all collapse to a common USD scale before
// being compared, otherwise high-magnitude currencies always float to top).
function sortDisputes(rows: DisputeRow[], key: SortKey): DisputeRow[] {
  const sorted = [...rows];
  switch (key) {
    case "newest":
      sorted.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      break;
    case "oldest":
      sorted.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
      break;
    case "highest":
      sorted.sort(
        (a, b) => toUsdCents(b.amount_cents, b.currency) - toUsdCents(a.amount_cents, a.currency)
      );
      break;
    case "lowest":
      sorted.sort(
        (a, b) => toUsdCents(a.amount_cents, a.currency) - toUsdCents(b.amount_cents, b.currency)
      );
      break;
  }
  return sorted;
}

function SortDropdown({
  value, onChange, className = "",
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
  className?: string;
}) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-xs text-[#6E6E6E]", className)}>
      <span className="font-semibold uppercase tracking-wider text-[10px]">Sort by</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="rounded-md border border-[#D2D2D2] bg-white px-2.5 py-1 text-xs text-[#2E2E2E] focus:outline-none focus:border-[#004AAC] focus:ring-1 focus:ring-[#004AAC] cursor-pointer"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// Canonical workflow order for substatus filter. Same ordering as
// STATUS_OPTIONS but lifted here so the dropdown shows statuses in
// pipeline order, not insertion-order from the data.
const SUBSTATUS_WORKFLOW_ORDER = [
  "New",
  "Pending Evidence",
  "Compiling Evidence",
  "Awaiting POD",
  "Evidence Compiled",
  "Submitted",
  "Under Review",
  "Won",
  "Lost",
  "Refunded",
  "Cancelled",
];

// Professional dropdown replacement for the side-by-side substatus pills.
// Lists "All (N)" + every substatus present in `subCounts` with its count,
// rendered in canonical workflow order. Visually mirrors SortDropdown so
// the two sit cleanly next to each other in the modal toolbar.
function SubstatusDropdown({
  value, onChange, subCounts, totalCount, className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  subCounts: Array<[string, number]>;
  totalCount: number;
  className?: string;
}) {
  const titleCase = (s: string) =>
    s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Show substatuses in canonical workflow order. Any status present in
  // the data but not in the workflow list (custom values typed into the
  // sheet) falls back to the end so it remains selectable.
  const ordered = useMemo(() => {
    const presentMap = new Map(subCounts);
    const inOrder: Array<[string, number]> = [];
    for (const s of SUBSTATUS_WORKFLOW_ORDER) {
      if (presentMap.has(s)) {
        inOrder.push([s, presentMap.get(s)!]);
        presentMap.delete(s);
      }
    }
    for (const entry of presentMap.entries()) inOrder.push(entry);
    return inOrder;
  }, [subCounts]);

  return (
    <label className={cn("inline-flex items-center gap-2 text-xs text-[#6E6E6E]", className)}>
      <span className="font-semibold uppercase tracking-wider text-[10px]">Filter by status</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-[#D2D2D2] bg-white px-2.5 py-1 text-xs text-[#2E2E2E] focus:outline-none focus:border-[#004AAC] focus:ring-1 focus:ring-[#004AAC] cursor-pointer min-w-[200px]"
      >
        <option value="all">All ({totalCount})</option>
        {ordered.map(([status, count]) => (
          <option key={status} value={status}>
            {titleCase(status)} ({count})
          </option>
        ))}
      </select>
    </label>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main client                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

export function DisputeTrackerClient({ data }: { data: DisputeDashboardData }) {
  const [selectedDispute, setSelectedDispute] = useState<DisputeRow | null>(null);
  const [selectedMerchant, setSelectedMerchant] = useState<MerchantAggRow | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterProvider, setFilterProvider] = useState<string>("all");
  const [groupedSort, setGroupedSort] = useState<SortKey>("newest");
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMerchants, setExpandedMerchants] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  // Generic filter modal: opens when user clicks a chart slice/bar OR a
  // financial summary card. Shows a flat table of matching disputes; rows are
  // still clickable to drill into the DisputeModal.
  const [filterModal, setFilterModal] = useState<{
    title: string;
    subtitle?: string;
    rows: DisputeRow[];
  } | null>(null);
  const [tierModal, setTierModal] = useState<Tier | null>(null);
  const allDisputesRef = useRef<HTMLDivElement>(null);

  // Categorize all merchants by their dispute-ratio tier for the legend + modal.
  const merchantsByTier = useMemo(() => {
    const map: Record<Tier, MerchantAggRow[]> = {
      "off-board": [], candidate: [], nudge: [], healthy: [], "n/a": [],
    };
    for (const m of data.merchants) {
      map[classifyTier(m.ratio_pct, m.orders)].push(m);
    }
    return map;
  }, [data.merchants]);

  // Per-merchant contribution to the company-wide dispute ratio.
  // For each merchant: compute what the company ratio would be if their
  // disputes + orders were removed from the totals, and how many percentage
  // points they are adding by being on the platform.
  // Auto-updates because data.merchants is server-rendered on every page load.
  const merchantContributions = useMemo(() => {
    const totalDisputes = data.totals.totalDisputes;
    const totalOrders = data.totals.totalOrders;
    const currentRatio = totalOrders > 0 ? (totalDisputes / totalOrders) * 100 : 0;
    return data.merchants
      .filter((m) => m.disputes > 0)
      .map((m) => {
        const remainingDisputes = Math.max(totalDisputes - m.disputes, 0);
        const remainingOrders = Math.max(totalOrders - m.orders, 0);
        const ratioWithoutThem = remainingOrders > 0
          ? (remainingDisputes / remainingOrders) * 100
          : 0;
        const contributionPp = currentRatio - ratioWithoutThem;
        const relativeImpact = currentRatio > 0
          ? (contributionPp / currentRatio) * 100
          : 0;
        return { ...m, ratioWithoutThem, contributionPp, relativeImpact };
      })
      .sort((a, b) => b.contributionPp - a.contributionPp);
  }, [data.merchants, data.totals]);
  const tierCounts: Partial<Record<Tier, number>> = {
    "off-board": merchantsByTier["off-board"].length,
    candidate: merchantsByTier.candidate.length,
    nudge: merchantsByTier.nudge.length,
    healthy: merchantsByTier.healthy.length,
  };

  const filteredDisputes = useMemo(() => {
    return data.disputes.filter((d) => {
      if (filterStatus !== "all" && d.bucket !== filterStatus) return false;
      if (filterProvider !== "all" && d.provider !== filterProvider) return false;
      return true;
    });
  }, [data.disputes, filterStatus, filterProvider]);

  const financial = useMemo(() => {
    let refunded = 0;
    let held = 0;
    for (const d of data.disputes) {
      const usdCents = toUsdCents(d.amount_cents, d.currency);
      if (d.bucket === "lost") refunded += usdCents;
      else if (d.bucket === "open") held += usdCents;
    }
    return { refundedUsdCents: refunded, heldUsdCents: held };
  }, [data.disputes]);

  // Group filtered disputes by merchant. Merchant order (outer) stays by
  // dispute count (highest first), but the rows INSIDE each merchant get
  // sorted per the user's groupedSort choice.
  const disputesByMerchant = useMemo(() => {
    const map = new Map<
      string,
      { merchant_id: string; merchant: string; disputes: DisputeRow[] }
    >();
    for (const d of filteredDisputes) {
      if (!map.has(d.merchant_id)) {
        map.set(d.merchant_id, {
          merchant_id: d.merchant_id,
          merchant: d.merchant,
          disputes: [],
        });
      }
      map.get(d.merchant_id)!.disputes.push(d);
    }
    return Array.from(map.values())
      .map((g) => ({ ...g, disputes: sortDisputes(g.disputes, groupedSort) }))
      .sort((a, b) => b.disputes.length - a.disputes.length);
  }, [filteredDisputes, groupedSort]);

  const handleRefresh = async () => {
    setRefreshing(true);
    window.location.reload();
  };

  // Outcome KPI click → open a modal listing those disputes. Keeps the user
  // on the same view instead of scrolling them to the bottom.
  const handleKpiClick = (bucket: string) => {
    if (bucket === "all") {
      setFilterModal({
        title: "All Disputes",
        subtitle: `${data.disputes.length} dispute${data.disputes.length === 1 ? "" : "s"} across every status and processor`,
        rows: data.disputes,
      });
      return;
    }
    const rows = data.disputes.filter((d) => d.bucket === bucket);
    const label = bucket.charAt(0).toUpperCase() + bucket.slice(1);
    setFilterModal({
      title: `${label} disputes`,
      subtitle: `${rows.length} dispute${rows.length === 1 ? "" : "s"} · click any row for full detail`,
      rows,
    });
  };

  const handleProviderClick = (provider: string) => {
    const rows = data.disputes.filter((d) => d.provider === provider);
    setFilterModal({
      title: provider,
      subtitle: `${rows.length} dispute${rows.length === 1 ? "" : "s"} processed by ${provider}`,
      rows,
    });
  };

  const handleFinancialClick = (kind: "refunded" | "held" | "fees") => {
    if (kind === "refunded") {
      const rows = data.disputes.filter((d) => d.bucket === "lost");
      setFilterModal({
        title: "Refunded — Closed Against Us",
        subtitle: `${rows.length} lost dispute${rows.length === 1 ? "" : "s"} · ${fmt.usd(financial.refundedUsdCents)} returned to customers (USD-normalised)`,
        rows,
      });
    } else if (kind === "held") {
      const rows = data.disputes.filter((d) => d.bucket === "open");
      setFilterModal({
        title: "Held / At Risk",
        subtitle: `${rows.length} open dispute${rows.length === 1 ? "" : "s"} · ${fmt.usd(financial.heldUsdCents)} at risk if every one loses`,
        rows,
      });
    } else {
      const rows = data.disputes.filter((d) => d.fee_usd_cents > 0);
      setFilterModal({
        title: "Dispute Fees Captured",
        subtitle: `${rows.length} lost dispute${rows.length === 1 ? "" : "s"} · ${fmt.usd(data.totals.totalFeesUsdCents)} in $50 fees captured from merchant ledger`,
        rows,
      });
    }
  };

  const toggleMerchant = (id: string) => {
    setExpandedMerchants((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () =>
    setExpandedMerchants(new Set(disputesByMerchant.map((g) => g.merchant_id)));
  const collapseAll = () => setExpandedMerchants(new Set());

  return (
    <div className="min-h-screen p-6 lg:p-8 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="text-3xl lg:text-4xl font-semibold text-[#2E2E2E] tracking-tight">
            Dispute Tracker
          </h1>
          <p className="text-[#6E6E6E] mt-2 text-sm max-w-2xl">
            Live dispute dashboard sourced 100% from production Postgres (
            <span className="font-mono text-[#2E2E2E]">order_info</span>,{" "}
            <span className="font-mono text-[#2E2E2E]">shopify_store</span>,{" "}
            <span className="font-mono text-[#2E2E2E]">ledger_entry</span>). Click any
            KPI or row to drill in.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs text-[#6E6E6E]">
            <div>Last DB update</div>
            <div className="text-[#2E2E2E] font-medium">
              {fmt.relativeTime(data.lastSyncedAt)}
            </div>
          </div>
          <button
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-[#004AAC] bg-white px-4 py-2 text-sm font-medium text-[#004AAC] hover:bg-[#E6EEFA] transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Dispute
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="btn-brand flex items-center gap-2"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Row — outcome tiles (Payment Summary look) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        {/* Outcome tiles open a modal on click; they are no longer "filter
            toggles" so the active ring would just be a stale permanent border.
            Drop active everywhere — the modal itself signals which set is
            being viewed. */}
        <OutcomeKpi
          label="Total Disputes"
          value={fmt.num(data.totals.totalDisputes)}
          tone="blue"
          onClick={() => handleKpiClick("all")}
        />
        <OutcomeKpi
          label="Open"
          value={fmt.num(data.totals.openDisputes)}
          tone="gray"
          onClick={() => handleKpiClick("open")}
        />
        <OutcomeKpi
          label="Won"
          value={fmt.num(data.totals.wonDisputes)}
          tone="green"
          onClick={() => handleKpiClick("won")}
        />
        <OutcomeKpi
          label="Lost"
          value={fmt.num(data.totals.lostDisputes)}
          tone="red"
          onClick={() => handleKpiClick("lost")}
        />
      </div>

      {/* Financial summary — money exposure from disputes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <FinancialCard
          label="Refunded — Closed Against Us"
          value={fmt.usd(financial.refundedUsdCents)}
          hint={`Money returned to customers on disputes we lost. ${data.totals.lostDisputes} lost · USD-normalised at static rates.`}
          tone="red"
          onClick={() => handleFinancialClick("refunded")}
        />
        <FinancialCard
          label="Held / At Risk"
          value={fmt.usd(financial.heldUsdCents)}
          hint={`Maximum we'd refund if all ${data.totals.openDisputes} open disputes lose. Plus ~$${(data.totals.openDisputes * 50).toLocaleString()} in pending Stripe fees. USD-normalised.`}
          tone="amber"
          onClick={() => handleFinancialClick("held")}
        />
        <FinancialCard
          label="Dispute Fees Captured"
          value={fmt.usd(data.totals.totalFeesUsdCents)}
          hint="$50 per lost dispute. Captured from merchant ledger."
          tone="violet"
          onClick={() => handleFinancialClick("fees")}
        />
      </div>

      {/* Secondary KPIs — context */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <Kpi
          label="Total Orders"
          value={fmt.num(data.totals.totalOrders)}
          icon={<DollarSign className="w-4 h-4" />}
          accent="gray"
          hint="excl. canceled/archived/draft"
        />
        <Kpi
          label="Company Ratio"
          value={fmt.pct(data.totals.companyRatioPct)}
          icon={<AlertTriangle className="w-4 h-4" />}
          accent={
            data.totals.companyRatioPct >= 1
              ? "red"
              : data.totals.companyRatioPct >= 0.5
              ? "amber"
              : "emerald"
          }
          hint={data.totals.companyRatioPct >= 1 ? "Above 1% — investigate" : "Healthy — below 1%"}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="sa-card p-6">
          <h3 className="text-sm font-semibold text-[#2E2E2E] mb-1">Status Breakdown</h3>
          <p className="text-xs text-[#6E6E6E] mb-4">
            Click any slice to filter the disputes list below
          </p>
          {data.byStatus.length === 0 ? (
            <EmptyState text="No disputes in DB" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.byStatus}
                    dataKey="count"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    outerRadius={95}
                    innerRadius={55}
                    paddingAngle={2}
                    stroke="#ffffff"
                    strokeWidth={2}
                    style={{ cursor: "pointer", outline: "none" }}
                    onClick={(d: unknown) => {
                      const label = (d as { label?: string } | undefined)?.label;
                      if (label) handleKpiClick(label);
                    }}
                  >
                    {data.byStatus.map((s) => (
                      <Cell key={s.label} fill={statusColor(s.label)} style={{ outline: "none" }} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value, name) => [
                      `${Number(value ?? 0)} disputes`,
                      String(name ?? ""),
                    ]}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 12, color: "#2E2E2E", paddingTop: 8 }}
                    formatter={(v) => <span style={{ color: "#2E2E2E" }}>{v}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="sa-card p-6">
          <h3 className="text-sm font-semibold text-[#2E2E2E] mb-1">By Processor</h3>
          <p className="text-xs text-[#6E6E6E] mb-4">
            Click any bar to filter the disputes list below
          </p>
          {data.byProvider.length === 0 ? (
            <EmptyState text="No disputes in DB" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.byProvider}
                  margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
                >
                  <CartesianGrid stroke="#EAEAEA" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#6E6E6E", fontSize: 11 }}
                    axisLine={{ stroke: "#EAEAEA" }}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: "#6E6E6E", fontSize: 11 }}
                    axisLine={{ stroke: "#EAEAEA" }}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    cursor={false}
                    formatter={(value) => [`${Number(value ?? 0)} disputes`, "Count"]}
                  />
                  <Bar
                    dataKey="count"
                    fill="#004AAC"
                    radius={[6, 6, 0, 0]}
                    style={{ cursor: "pointer" }}
                    activeBar={{ fill: "#003580", stroke: "transparent", strokeWidth: 0 }}
                    onClick={(d: unknown) => {
                      const label = (d as { label?: string } | undefined)?.label;
                      if (label) handleProviderClick(label);
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Per-merchant table */}
      <div className="sa-card p-6 mb-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[#2E2E2E]">Per-Merchant Health</h3>
            <p className="text-xs text-[#6E6E6E]">
              Click any merchant for the full dispute breakdown
            </p>
          </div>
          <TierLegend
            counts={tierCounts}
            onTierClick={(t) => setTierModal(t)}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full sa-table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Last Dispute</th>
                <th className="text-right">Disputes</th>
                <th className="text-right">Open</th>
                <th className="text-right">Lost</th>
                <th className="text-right">Won</th>
                <th className="text-right">Orders</th>
                <th className="text-right">Ratio</th>
                <th>Tier</th>
                <th className="text-right">Fees Paid</th>
              </tr>
            </thead>
            <tbody>
              {data.merchants.map((m) => {
                const tier = classifyTier(m.ratio_pct, m.orders);
                const meta = TIER_META[tier];
                return (
                  <tr key={m.merchant_id} onClick={() => setSelectedMerchant(m)}>
                    <td>
                      <div className="font-medium text-[#2E2E2E]">{m.merchant}</div>
                    </td>
                    <td className="text-[#6E6E6E] text-xs">
                      {fmt.date(m.last_dispute_at)}
                    </td>
                    <td className="text-right font-semibold text-[#2E2E2E]">{m.disputes}</td>
                    <td className="text-right text-[#004AAC]">{m.open || "—"}</td>
                    <td className="text-right text-red-600">{m.lost || "—"}</td>
                    <td className="text-right text-emerald-600">{m.won || "—"}</td>
                    <td className="text-right text-[#6E6E6E]">{fmt.num(m.orders)}</td>
                    <td className="text-right font-semibold text-[#2E2E2E]">
                      {fmt.pct(m.ratio_pct, 2)}
                    </td>
                    <td>
                      <span
                        className={cn(
                          "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border",
                          meta.bg,
                          meta.text,
                          meta.border
                        )}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td className="text-right text-[#6E6E6E]">
                      {m.fees_paid_usd_cents > 0 ? fmt.usd(m.fees_paid_usd_cents) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-merchant contribution to company ratio */}
      <div className="sa-card p-6 mb-6">
        <div className="flex items-start justify-between mb-5 gap-6">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-[#2E2E2E]">
              Merchant Contribution to Company Ratio
            </h3>
            <p className="text-xs text-[#6E6E6E] mt-1 leading-snug">
              Each merchant's percentage-point impact on the company-wide dispute ratio.
              Sorted by biggest contributor first.
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#6E6E6E]">
              Current Company Ratio
            </div>
            <div className="text-2xl font-bold text-[#2E2E2E] tabular-nums leading-tight mt-1">
              {fmt.pct(data.totals.companyRatioPct, 3)}
            </div>
          </div>
        </div>
        {merchantContributions.length === 0 ? (
          <div className="text-center text-[#6E6E6E] py-8 text-sm">
            No merchants with disputes
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full sa-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th className="text-right">Disputes</th>
                  <th className="text-right">Orders</th>
                  <th className="text-right">Their Ratio</th>
                  <th className="text-right">Co. Ratio Without Them</th>
                  <th className="text-right">Contribution (pp)</th>
                  <th className="text-right">% of Co. Ratio</th>
                </tr>
              </thead>
              <tbody>
                {merchantContributions.map((m) => (
                  <tr key={m.merchant_id} onClick={() => setSelectedMerchant(m)}>
                    <td className="text-[#2E2E2E] font-medium">{m.merchant}</td>
                    <td className="text-right text-[#2E2E2E] font-semibold tabular-nums">
                      {m.disputes}
                    </td>
                    <td className="text-right text-[#6E6E6E] tabular-nums">
                      {fmt.num(m.orders)}
                    </td>
                    <td className="text-right text-[#2E2E2E] tabular-nums">
                      {m.orders > 0 ? fmt.pct(m.ratio_pct, 2) : "—"}
                    </td>
                    <td className="text-right text-[#6E6E6E] tabular-nums">
                      {fmt.pct(m.ratioWithoutThem, 3)}
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      <span className={m.contributionPp > 0 ? "text-red-700" : "text-[#6E6E6E]"}>
                        +{m.contributionPp.toFixed(3)}%
                      </span>
                    </td>
                    <td className="text-right tabular-nums text-[#6E6E6E]">
                      {m.relativeImpact >= 0 ? `+${m.relativeImpact.toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold bg-[#FAFAFA] cursor-default">
                  <td className="text-[#2E2E2E]">All merchants combined</td>
                  <td className="text-right text-[#2E2E2E] tabular-nums">
                    {data.totals.totalDisputes}
                  </td>
                  <td className="text-right text-[#6E6E6E] tabular-nums">
                    {fmt.num(data.totals.totalOrders)}
                  </td>
                  <td className="text-right text-[#2E2E2E] tabular-nums">
                    {fmt.pct(data.totals.companyRatioPct, 3)}
                  </td>
                  <td className="text-right text-[#6E6E6E] tabular-nums">—</td>
                  <td className="text-right text-[#6E6E6E] tabular-nums">—</td>
                  <td className="text-right text-[#6E6E6E] tabular-nums">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* All disputes — grouped by merchant */}
      <div ref={allDisputesRef} className="sa-card p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[#2E2E2E]">
              All Disputes — grouped by merchant ({filteredDisputes.length})
            </h3>
            <p className="text-xs text-[#6E6E6E]">
              Click a merchant to expand · click a row to see full dispute detail
            </p>
            {filterProvider !== "all" && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#E6EEFA] px-2.5 py-1 text-[11px] font-semibold text-[#004AAC]">
                Processor: {filterProvider}
                <button
                  onClick={() => setFilterProvider("all")}
                  className="hover:opacity-70"
                  aria-label="Clear processor filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <SortDropdown value={groupedSort} onChange={setGroupedSort} />
            <span className="text-[#D2D2D2] mx-1">·</span>
            <button
              onClick={expandAll}
              className="text-xs text-[#004AAC] hover:underline"
            >
              Expand all
            </button>
            <span className="text-[#D2D2D2]">·</span>
            <button
              onClick={collapseAll}
              className="text-xs text-[#004AAC] hover:underline"
            >
              Collapse all
            </button>
            <span className="text-[#D2D2D2] mx-1">·</span>
            <span className="text-[#6E6E6E]">Filter:</span>
            <FilterPill active={filterStatus === "all"} onClick={() => setFilterStatus("all")}>
              All
            </FilterPill>
            {data.byStatus.map((s) => (
              <FilterPill
                key={s.label}
                active={filterStatus === s.label}
                onClick={() => setFilterStatus(s.label)}
                color={statusColor(s.label)}
              >
                {s.label} ({s.count})
              </FilterPill>
            ))}
          </div>
        </div>

        {disputesByMerchant.length === 0 ? (
          <div className="text-center text-[#6E6E6E] py-8 text-sm">
            No disputes match this filter
          </div>
        ) : (
          <div className="space-y-2">
            {disputesByMerchant.map((g) => {
              const expanded = expandedMerchants.has(g.merchant_id);
              // Use canonical bucket so substatuses (Pending Evidence,
              // Submitted, Compiling Evidence, etc.) all roll up to OPEN.
              const stats = {
                open: g.disputes.filter((d) => d.bucket === "open").length,
                lost: g.disputes.filter((d) => d.bucket === "lost").length,
                won: g.disputes.filter((d) => d.bucket === "won").length,
              };
              return (
                <div
                  key={g.merchant_id}
                  className="border border-[#EAEAEA] rounded-[0.625rem] overflow-hidden"
                >
                  <button
                    onClick={() => toggleMerchant(g.merchant_id)}
                    className="w-full flex items-center justify-between gap-4 px-4 py-3 bg-white hover:bg-[#F7F7F7] transition text-left"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {expanded ? (
                        <ChevronDown className="w-4 h-4 text-[#6E6E6E] flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-[#6E6E6E] flex-shrink-0" />
                      )}
                      <div className="font-medium text-[#2E2E2E] truncate">
                        {g.merchant}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs flex-shrink-0">
                      <span className="text-[#6E6E6E]">
                        {g.disputes.length} dispute{g.disputes.length === 1 ? "" : "s"}
                      </span>
                      {stats.open > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-[#E6EEFA] text-[#004AAC] font-bold text-[10px]">
                          {stats.open} OPEN
                        </span>
                      )}
                      {stats.lost > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-red-50 text-red-700 font-bold text-[10px]">
                          {stats.lost} LOST
                        </span>
                      )}
                      {stats.won > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold text-[10px]">
                          {stats.won} WON
                        </span>
                      )}
                    </div>
                  </button>
                  {expanded && (
                    <div className="bg-[#FAFAFA] border-t border-[#EAEAEA] overflow-x-auto">
                      <table className="w-full sa-table table-fixed min-w-[1100px]">
                        <colgroup>
                          <col className="w-[110px]" />{/* Date */}
                          <col />{/* Customer (flex) */}
                          <col className="w-[110px]" />{/* Provider */}
                          <col className="w-[120px]" />{/* Amount */}
                          <col className="w-[170px]" />{/* Status */}
                          <col className="w-[140px]" />{/* Order */}
                          <col className="w-[180px]" />{/* Dispute ID */}
                          <col className="w-[110px]" />{/* Deadline */}
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Customer</th>
                            <th>Provider</th>
                            <th>Amount</th>
                            <th>Status</th>
                            <th>Order</th>
                            <th>Dispute ID</th>
                            <th>Deadline</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.disputes.map((d) => (
                            <tr
                              key={d.dispute_id}
                              onClick={() => setSelectedDispute(d)}
                            >
                              <td className="text-[#6E6E6E] whitespace-nowrap">
                                {fmt.date(d.created_at)}
                              </td>
                              <td>
                                <div className="text-[#2E2E2E] truncate">
                                  {d.customer_name ?? "—"}
                                </div>
                                {d.customer_email && (
                                  <div className="text-xs text-[#6E6E6E] truncate">
                                    {d.customer_email}
                                  </div>
                                )}
                              </td>
                              <td className="text-[#6E6E6E] whitespace-nowrap">{d.provider}</td>
                              <td className="text-[#2E2E2E] font-semibold whitespace-nowrap">
                                {fmt.money(d.amount_cents, d.currency)}
                              </td>
                              <td>
                                <span
                                  className={cn(
                                    "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase whitespace-nowrap",
                                    statusBadgeClasses(displayStatus(d))
                                  )}
                                >
                                  {displayStatus(d)}
                                </span>
                              </td>
                              <td className="text-[#6E6E6E] font-mono text-xs truncate">
                                {orderDisplay(d)}
                              </td>
                              <td className="font-mono text-[10px] text-[#6E6E6E] max-w-[180px] truncate">
                                {d.dispute_id}
                              </td>
                              <td className="text-[#6E6E6E] whitespace-nowrap">
                                {displayDeadline(d)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedDispute && (
        <DisputeModal
          dispute={selectedDispute}
          onClose={() => setSelectedDispute(null)}
        />
      )}
      {selectedMerchant && (
        <MerchantModal
          merchant={selectedMerchant}
          disputes={data.disputes.filter(
            (d) => d.merchant_id === selectedMerchant.merchant_id
          )}
          onClose={() => setSelectedMerchant(null)}
          onDisputeClick={(d) => {
            setSelectedMerchant(null);
            setSelectedDispute(d);
          }}
        />
      )}
      {addOpen && (
        <AddDisputeModal
          merchants={data.allMerchants}
          onClose={() => setAddOpen(false)}
        />
      )}
      {filterModal && (
        <FilteredDisputesModal
          title={filterModal.title}
          subtitle={filterModal.subtitle}
          rows={filterModal.rows}
          onClose={() => setFilterModal(null)}
          onRowClick={(d) => {
            setFilterModal(null);
            setSelectedDispute(d);
          }}
        />
      )}
      {tierModal && (
        <TierMerchantsModal
          tier={tierModal}
          merchants={merchantsByTier[tierModal]}
          onClose={() => setTierModal(null)}
          onPick={(m) => {
            setTierModal(null);
            setSelectedMerchant(m);
          }}
        />
      )}
    </div>
  );
}

function TierMerchantsModal({
  tier, merchants, onClose, onPick,
}: {
  tier: Tier;
  merchants: MerchantAggRow[];
  onClose: () => void;
  onPick: (m: MerchantAggRow) => void;
}) {
  const meta = TIER_META[tier];
  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 flex items-start justify-center p-4 lg:p-12 overflow-y-auto"
      onClick={onClose}
    >
      <div className="sa-card w-full max-w-3xl p-6 my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "px-2 py-0.5 rounded-full border font-bold text-[10px]",
                  meta.bg, meta.text, meta.border
                )}
              >
                {meta.label}
              </span>
              <div className="text-lg font-semibold text-[#2E2E2E]">
                {merchants.length} merchant{merchants.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="text-xs text-[#6E6E6E] mt-1">
              {tier === "off-board" && "Dispute ratio ≥ 1.5% — investigate / off-board"}
              {tier === "candidate" && "Dispute ratio 1.0–1.5% — review with leadership"}
              {tier === "nudge" && "Dispute ratio 0.5–1.0% — send a chargeback-warning note"}
              {tier === "healthy" && "Dispute ratio < 0.5% — no action required"}
            </div>
          </div>
          <button onClick={onClose} className="text-[#6E6E6E] hover:text-[#2E2E2E] p-1 rounded hover:bg-gray-100 transition flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {merchants.length === 0 ? (
          <div className="text-center text-[#6E6E6E] py-8 text-sm">No merchants in this tier</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-[#EAEAEA] max-h-[60vh] overflow-y-auto">
            <table className="w-full sa-table">
              <thead className="sticky top-0 bg-white z-10">
                <tr>
                  <th>Merchant</th>
                  <th className="text-right">Disputes</th>
                  <th className="text-right">Orders</th>
                  <th className="text-right">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {merchants.map((m) => (
                  <tr key={m.merchant_id} onClick={() => onPick(m)}>
                    <td className="text-[#2E2E2E] font-medium">{m.merchant}</td>
                    <td className="text-right text-[#2E2E2E] font-semibold">{m.disputes}</td>
                    <td className="text-right text-[#6E6E6E]">{fmt.num(m.orders)}</td>
                    <td className="text-right font-semibold text-[#2E2E2E]">{fmt.pct(m.ratio_pct, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Sub-components                                                               */
/* ─────────────────────────────────────────────────────────────────────────── */

const ACCENT_STYLES: Record<string, { icon: string; activeRing: string }> = {
  brand: { icon: "text-[#004AAC] bg-[#E6EEFA]", activeRing: "ring-[#004AAC]" },
  red: { icon: "text-red-700 bg-red-50", activeRing: "ring-red-400" },
  emerald: { icon: "text-emerald-700 bg-emerald-50", activeRing: "ring-emerald-400" },
  amber: { icon: "text-amber-700 bg-amber-50", activeRing: "ring-amber-400" },
  gray: { icon: "text-gray-700 bg-gray-100", activeRing: "ring-gray-400" },
};

// Payment Summary-style outcome tile: tinted background, big colored number.
const OUTCOME_TONES = {
  blue: { bg: "bg-[#EFF4FB]", border: "border-[#D6E2F2]", value: "text-[#004AAC]", ring: "ring-[#004AAC]" },
  gray: { bg: "bg-[#F4F4F5]", border: "border-[#E4E4E7]", value: "text-[#2E2E2E]", ring: "ring-[#6E6E6E]" },
  green: { bg: "bg-emerald-50", border: "border-emerald-200", value: "text-emerald-600", ring: "ring-emerald-500" },
  red: { bg: "bg-red-50", border: "border-red-200", value: "text-red-600", ring: "ring-red-500" },
} as const;

function OutcomeKpi({
  label, value, tone, onClick, active,
}: {
  label: string; value: string;
  tone: keyof typeof OUTCOME_TONES;
  onClick?: () => void; active?: boolean;
}) {
  const t = OUTCOME_TONES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-[0.625rem] border px-6 py-7 text-center transition-shadow hover:shadow-md",
        t.bg, t.border,
        active && `ring-2 ${t.ring}`
      )}
    >
      <div className={cn("text-4xl font-bold tabular-nums tracking-tight", t.value)}>{value}</div>
      <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6E6E6E]">{label}</div>
    </button>
  );
}

const FINANCIAL_TONES = {
  red: { bg: "bg-red-50/60", border: "border-red-200", value: "text-red-700" },
  amber: { bg: "bg-amber-50/60", border: "border-amber-200", value: "text-amber-800" },
  violet: { bg: "bg-violet-50/60", border: "border-violet-200", value: "text-violet-700" },
} as const;

function FinancialCard({
  label, value, hint, tone, onClick,
}: {
  label: string; value: string; hint: string;
  tone: keyof typeof FINANCIAL_TONES;
  onClick?: () => void;
}) {
  const t = FINANCIAL_TONES[tone];
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "rounded-[0.625rem] border p-5 text-left w-full",
        t.bg, t.border,
        onClick && "transition-shadow hover:shadow-md cursor-pointer"
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6E6E6E]">{label}</div>
      <div className={cn("mt-2 text-2xl font-bold tabular-nums tracking-tight", t.value)}>{value}</div>
      <div className="mt-1.5 text-[11px] text-[#6E6E6E] leading-snug">{hint}</div>
    </Tag>
  );
}

function Kpi({
  label,
  value,
  icon,
  accent,
  hint,
  onClick,
  active,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: keyof typeof ACCENT_STYLES;
  hint?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const styles = ACCENT_STYLES[accent];
  const clickable = !!onClick;
  const Tag = clickable ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={cn(
        "kpi-card text-left w-full",
        clickable && "cursor-pointer hover:shadow-md hover:border-[#004AAC]",
        active && `ring-2 ${styles.activeRing} border-[#004AAC]`
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="kpi-label">{label}</span>
        <span className={cn("p-1.5 rounded-md", styles.icon)}>{icon}</span>
      </div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="text-[10px] text-[#6E6E6E] mt-1">{hint}</div>}
    </Tag>
  );
}

function FilterPill({
  children,
  active,
  onClick,
  color,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1 rounded-full border text-xs font-medium transition-all",
        active
          ? "bg-[#E6EEFA] border-[#004AAC] text-[#004AAC]"
          : "bg-white border-[#EAEAEA] text-[#6E6E6E] hover:border-[#004AAC] hover:text-[#2E2E2E]"
      )}
      style={color && !active ? { borderColor: `${color}40` } : undefined}
    >
      {color && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full mr-1.5"
          style={{ background: color }}
        />
      )}
      {children}
    </button>
  );
}

function TierLegend({
  onTierClick,
  counts,
}: {
  onTierClick?: (tier: Tier) => void;
  counts?: Partial<Record<Tier, number>>;
}) {
  const tiers: Tier[] = ["off-board", "candidate", "nudge", "healthy"];
  return (
    <div className="flex items-center gap-2 text-[10px]">
      {tiers.map((t) => {
        const meta = TIER_META[t];
        const count = counts?.[t] ?? 0;
        const clickable = onTierClick && count > 0;
        const Tag = clickable ? "button" : "span";
        return (
          <Tag
            key={t}
            type={clickable ? "button" : undefined}
            onClick={clickable ? () => onTierClick!(t) : undefined}
            className={cn(
              "px-2 py-0.5 rounded-full border font-bold inline-flex items-center gap-1.5",
              meta.bg,
              meta.text,
              meta.border,
              clickable && "hover:shadow-sm cursor-pointer transition-shadow",
              !clickable && count === 0 && "opacity-40"
            )}
          >
            {meta.label}
            {counts && (
              <span className="px-1 rounded-sm bg-white/70 text-[9px] font-bold">
                {count}
              </span>
            )}
          </Tag>
        );
      })}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="h-64 flex items-center justify-center text-[#6E6E6E] text-sm">
      {text}
    </div>
  );
}

function DisputeModal({
  dispute,
  onClose,
}: {
  dispute: DisputeRow;
  onClose: () => void;
}) {
  const url = disputeUrl(dispute);
  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-start justify-center p-4 lg:p-12 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="sa-card max-w-2xl w-full p-6 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <div className="min-w-0">
            <div className="text-xs text-[#6E6E6E] mb-1">Dispute ID</div>
            <CopyableId id={dispute.dispute_id} />
            {dispute.is_manual && (
              <div className="mt-1.5 inline-block px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-bold uppercase tracking-wider">
                Manually added
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-[#6E6E6E] hover:text-[#2E2E2E] p-1 rounded hover:bg-gray-100 transition flex-shrink-0 ml-3"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <Field label="Merchant" value={dispute.merchant} />
          <Field label="Processor" value={dispute.provider} />
          <Field
            label="Customer"
            value={dispute.customer_name ? <CopyableValue value={dispute.customer_name} /> : "—"}
          />
          <Field
            label="Customer Email"
            value={dispute.customer_email ? <CopyableValue value={dispute.customer_email} /> : "—"}
          />
          <Field
            label="Amount"
            value={fmt.money(dispute.amount_cents, dispute.currency)}
            valueClass="text-[#2E2E2E] font-semibold"
          />
          <StatusEditField dispute={dispute} />
          <Field label="Created" value={fmt.date(dispute.created_at)} />
          <Field label="Evidence Deadline" value={displayDeadline(dispute)} />
          <Field
            label="Order ID"
            value={dispute.order_id ? <CopyableId id={dispute.order_id} /> : "—"}
          />
          {dispute.reason && <Field label="Reason" value={dispute.reason} />}
          <Field
            label="Payment Gateway"
            value={
              <div className="flex flex-col gap-1">
                <span>{dispute.payment_gateway || dispute.provider.toLowerCase()}</span>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#004AAC] hover:underline"
                  >
                    {disputeUrlLabel(dispute)} <ExternalLink className="w-3 h-3" />
                  </a>
                ) : null}
              </div>
            }
          />
          {dispute.fee_usd_cents > 0 && (
            <Field
              label="$50 Fee"
              value={fmt.usd(dispute.fee_usd_cents)}
              valueClass="text-red-600 font-semibold"
            />
          )}
        </div>

        <InternalNotesEditor
          disputeId={dispute.dispute_id}
          initial={dispute.internal_notes}
        />
      </div>
    </div>
  );
}

/**
 * Inline status editor. Click the badge → dropdown of all statuses. Saving
 * PATCHes /api/disputes/status which writes back to the sheet (creating a row
 * if the dispute is DB-only).
 */
function StatusEditField({ dispute }: { dispute: DisputeRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(dispute.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async (newStatus: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/disputes/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeId: dispute.dispute_id,
          status: newStatus,
          fallback: {
            provider: dispute.provider,
            merchant: dispute.merchant,
            customer: dispute.customer_name || undefined,
          },
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setCurrent(newStatus);
      setEditing(false);
      // Re-fetch SSR data so the row behind the modal (badges, totals, charts)
      // reflects the new status immediately — no manual reload required.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="text-xs text-[#6E6E6E] flex items-center gap-2">
        Status
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-[10px] text-[#004AAC] hover:underline"
          >
            Change
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-0.5">
          <select
            value={current}
            disabled={saving}
            onChange={(e) => onSave(e.target.value)}
            className="w-full rounded-md border border-[#D2D2D2] bg-white px-2 py-1 text-sm text-[#2E2E2E] focus:outline-none focus:border-[#004AAC] focus:ring-1 focus:ring-[#004AAC]"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <div className="mt-1 flex items-center gap-2">
            {saving && <span className="text-[10px] text-[#6E6E6E]">Saving…</span>}
            {error && <span className="text-[10px] text-red-700">⚠ {error}</span>}
            <button
              onClick={() => { setEditing(false); setError(null); }}
              className="text-[10px] text-[#6E6E6E] hover:underline ml-auto"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        (() => {
          const b = bucketOf(current);
          const label = b === "lost" ? "Lost" : b === "won" ? "Won" : current;
          return (
            <span
              className={cn(
                "inline-block mt-0.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase",
                statusBadgeClasses(label)
              )}
            >
              {label}
            </span>
          );
        })()
      )}
    </div>
  );
}

/**
 * Internal notes block: shows existing note as read-only text, or empty state.
 * Click button → reveals textarea with Save/Cancel. Button label toggles
 * "Add note" ↔ "Update note" based on whether a note exists.
 */
function InternalNotesEditor({
  disputeId,
  initial,
}: {
  disputeId: string;
  initial: string;
}) {
  const router = useRouter();
  const [savedNotes, setSavedNotes] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasNote = savedNotes.trim() !== "";

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/disputes/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disputeId, notes: draft }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setSavedNotes(draft);
      setEditing(false);
      // Re-fetch server data so other surfaces (e.g., notes preview elsewhere)
      // pick up the change without a manual refresh.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const onCancel = () => {
    setDraft(savedNotes);
    setEditing(false);
    setError(null);
  };

  return (
    <div className="mt-6 rounded-[0.625rem] border border-[#EAEAEA] bg-[#FAFAFA] p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6E6E6E]">
          Internal Notes
        </div>
        {!editing && (
          <button
            onClick={() => { setDraft(savedNotes); setEditing(true); }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#004AAC] hover:underline"
          >
            {hasNote ? <Pencil className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
            {hasNote ? "Update note" : "Add note"}
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            autoFocus
            placeholder="What's the latest on this dispute? POD status, customer comms, evidence collected…"
            className="w-full rounded-md border border-[#D2D2D2] bg-white px-3 py-2 text-sm text-[#2E2E2E] focus:outline-none focus:border-[#004AAC] focus:ring-1 focus:ring-[#004AAC]"
          />
          {error && (
            <div className="mt-1.5 text-xs text-red-700">⚠ {error}</div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={onSave}
              disabled={saving || draft === savedNotes}
              className="btn-brand text-xs px-3 py-1.5"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={onCancel}
              disabled={saving}
              className="text-xs px-3 py-1.5 text-[#6E6E6E] hover:text-[#2E2E2E]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : hasNote ? (
        <div className="text-sm text-[#2E2E2E] whitespace-pre-wrap leading-relaxed">
          {savedNotes}
        </div>
      ) : (
        <div className="text-xs text-[#6E6E6E] italic">
          No notes yet. Click <span className="font-semibold text-[#004AAC]">Add note</span> to capture context for this dispute.
        </div>
      )}
    </div>
  );
}

const PROVIDER_OPTIONS = [
  "Stripe USA",
  "Stripe UAE",
  "Tabby UAE",
  "Tabby KSA",
  "Tamara UAE",
  "Tamara KSA",
];
const STATUS_OPTIONS = [
  "New",
  "Pending Evidence",
  "Compiling Evidence",
  "Awaiting POD",
  "Submitted",
  "Evidence Compiled",
  "Under Review",
  "Won",
  "Lost",
  "Refunded",
  "Cancelled",
];
const CURRENCY_OPTIONS = ["USD", "AED", "SAR", "EUR", "GBP", "CAD", "AUD", "KWD"];

/**
 * Generic modal that lists a filtered set of disputes. Used for clicks on chart
 * slices, processor bars, and the Refunded/Held/Fees financial cards.
 */
function FilteredDisputesModal({
  title, subtitle, rows, onClose, onRowClick,
}: {
  title: string;
  subtitle?: string;
  rows: DisputeRow[];
  onClose: () => void;
  onRowClick: (d: DisputeRow) => void;
}) {
  const [subFilter, setSubFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("newest");

  // Compute counts per raw substatus so the chips show "Pending Evidence (5)"
  // etc. Sorted descending by count. Only show the chip bar when there are
  // 2+ distinct substatuses — no point on a single-bucket view (e.g. all Won).
  const subCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = useMemo(() => {
    const base = subFilter === "all" ? rows : rows.filter((r) => r.status === subFilter);
    return sortDisputes(base, sortKey);
  }, [rows, subFilter, sortKey]);

  // Reset the substatus filter + sort when the parent passes a fresh `rows`
  // (e.g. user closes the modal and opens it for a different bucket).
  useEffect(() => {
    setSubFilter("all");
    setSortKey("newest");
  }, [rows]);

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 flex items-start justify-center p-4 lg:p-12 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="sa-card w-full max-w-6xl p-6 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="min-w-0">
            <div className="text-lg font-semibold text-[#2E2E2E]">{title}</div>
            {subtitle && <div className="text-xs text-[#6E6E6E] mt-0.5">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            className="text-[#6E6E6E] hover:text-[#2E2E2E] p-1 rounded hover:bg-gray-100 transition flex-shrink-0 ml-3"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          {subCounts.length > 1 ? (
            <SubstatusDropdown
              value={subFilter}
              onChange={setSubFilter}
              subCounts={subCounts}
              totalCount={rows.length}
              className="shrink-0"
            />
          ) : (
            <div />
          )}
          <SortDropdown value={sortKey} onChange={setSortKey} className="shrink-0" />
        </div>

        {filtered.length === 0 ? (
          <div className="text-center text-[#6E6E6E] py-8 text-sm">No matching disputes</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-[#EAEAEA] max-h-[65vh] overflow-y-auto">
            <table className="w-full sa-table table-fixed min-w-[1200px]">
              <colgroup>
                <col className="w-[110px]" />{/* Date */}
                <col className="w-[160px]" />{/* Merchant */}
                <col />{/* Customer (flex) */}
                <col className="w-[110px]" />{/* Processor */}
                <col className="w-[120px]" />{/* Amount */}
                <col className="w-[170px]" />{/* Status */}
                <col className="w-[140px]" />{/* Order */}
                <col className="w-[180px]" />{/* Dispute ID */}
                <col className="w-[110px]" />{/* Deadline */}
              </colgroup>
              <thead className="sticky top-0 bg-white z-10">
                <tr>
                  <th>Date</th>
                  <th>Merchant</th>
                  <th>Customer</th>
                  <th>Processor</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Order</th>
                  <th>Dispute ID</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.dispute_id} onClick={() => onRowClick(d)}>
                    <td className="text-[#6E6E6E] whitespace-nowrap">{fmt.date(d.created_at)}</td>
                    <td className="text-[#2E2E2E] font-medium truncate">{d.merchant}</td>
                    <td>
                      <div className="text-[#2E2E2E] truncate">{d.customer_name ?? "—"}</div>
                      {d.customer_email && (
                        <div className="text-xs text-[#6E6E6E] truncate">{d.customer_email}</div>
                      )}
                    </td>
                    <td className="text-[#6E6E6E] whitespace-nowrap">{d.provider}</td>
                    <td className="text-[#2E2E2E] font-semibold whitespace-nowrap">
                      {fmt.money(d.amount_cents, d.currency)}
                    </td>
                    <td>
                      <span
                        className={cn(
                          "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase whitespace-nowrap",
                          statusBadgeClasses(displayStatus(d))
                        )}
                      >
                        {displayStatus(d)}
                      </span>
                    </td>
                    <td className="text-[#6E6E6E] font-mono text-xs truncate">{orderDisplay(d)}</td>
                    <td className="font-mono text-[10px] text-[#6E6E6E] truncate">
                      {d.dispute_id}
                    </td>
                    <td className="text-[#6E6E6E] whitespace-nowrap">{displayDeadline(d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AddDisputeModal({
  onClose, merchants,
}: {
  onClose: () => void;
  merchants: Array<{ id: string; name: string }>;
}) {
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    provider: PROVIDER_OPTIONS[0],
    merchant: "",
    disputeId: "",
    customer: "",
    reason: "",
    status: "New",
    amount: "",
    currency: "USD",
    deadline: "",
    notes: "",
    orderId: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof typeof form>(key: K, val: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/disputes/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onClose();
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-start justify-center p-4 lg:p-12 overflow-y-auto"
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="sa-card max-w-2xl w-full p-6 my-8 space-y-4"
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs text-[#6E6E6E] mb-1">Add Dispute</div>
            <div className="text-lg font-semibold text-[#2E2E2E]">
              Manually log a new dispute
            </div>
            <div className="text-xs text-[#6E6E6E] mt-1">
              Use this for Tabby, Tamara, or Stripe USA disputes that don&apos;t sync from Postgres.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#6E6E6E] hover:text-[#2E2E2E] p-1 rounded hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Filed date">
            <input type="date" value={form.date} onChange={(e) => update("date", e.target.value)} className={INPUT_CLS} />
          </FormField>
          <FormField label="Processor" required>
            <select value={form.provider} onChange={(e) => update("provider", e.target.value)} className={INPUT_CLS}>
              {PROVIDER_OPTIONS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </FormField>
          <FormField label="Merchant" required>
            <MerchantCombobox
              value={form.merchant}
              onChange={(v) => update("merchant", v)}
              options={merchants}
            />
          </FormField>
          <FormField label="Dispute ID" required>
            <input value={form.disputeId} onChange={(e) => update("disputeId", e.target.value)} required className={INPUT_CLS} placeholder="du_… or Tabby/Tamara ref" />
          </FormField>
          <FormField label="Customer">
            <input value={form.customer} onChange={(e) => update("customer", e.target.value)} className={INPUT_CLS} />
          </FormField>
          <FormField label="Status">
            <select value={form.status} onChange={(e) => update("status", e.target.value)} className={INPUT_CLS}>
              {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </FormField>
          <FormField label="Amount">
            <input value={form.amount} onChange={(e) => update("amount", e.target.value)} className={INPUT_CLS} placeholder="e.g. 250.00" inputMode="decimal" />
          </FormField>
          <FormField label="Currency">
            <select value={form.currency} onChange={(e) => update("currency", e.target.value)} className={INPUT_CLS}>
              {CURRENCY_OPTIONS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="Evidence deadline">
            <input type="date" value={form.deadline} onChange={(e) => update("deadline", e.target.value)} className={INPUT_CLS} />
          </FormField>
          <FormField label="Reason">
            <input value={form.reason} onChange={(e) => update("reason", e.target.value)} className={INPUT_CLS} placeholder="e.g. product_not_received" />
          </FormField>
          <FormField label="Order ID">
            <input value={form.orderId} onChange={(e) => update("orderId", e.target.value)} className={INPUT_CLS} placeholder="e.g. order_01K… or #FGUS25623" />
          </FormField>
        </div>

        <FormField label="Internal notes">
          <textarea
            value={form.notes}
            onChange={(e) => update("notes", e.target.value)}
            rows={3}
            className={INPUT_CLS}
            placeholder="Any context: POD status, customer comms, exhibits collected…"
          />
        </FormField>

        {error && <div className="text-xs text-red-700">⚠ {error}</div>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={saving} className="text-sm px-4 py-2 text-[#6E6E6E] hover:text-[#2E2E2E]">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="btn-brand">
            {saving ? "Saving…" : "Add dispute"}
          </button>
        </div>
      </form>
    </div>
  );
}

const INPUT_CLS = "w-full rounded-md border border-[#D2D2D2] bg-white px-3 py-2 text-sm text-[#2E2E2E] focus:outline-none focus:border-[#004AAC] focus:ring-1 focus:ring-[#004AAC]";

function FormField({
  label, required, children,
}: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-[0.05em] text-[#6E6E6E] mb-1">
        {label}{required && <span className="text-red-600 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * Combobox for the Add Dispute form's merchant field. Sources from a live
 * Postgres list (filtered + sorted server-side, refreshed on every page render
 * via the force-dynamic page). Free-text input is allowed for brand-new
 * merchants that haven't been onboarded into Postgres yet.
 *
 * Replaces the previous native <datalist> which intentionally bypasses CSS —
 * that rendered as the dark un-styled OS popup in older builds.
 */
function MerchantCombobox({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Filter by current input, case-insensitively. Show all when input is empty.
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options;
    return options.filter((m) => m.name.toLowerCase().includes(q));
  }, [value, options]);

  // Reset highlight when filter changes.
  useEffect(() => setHighlighted(0), [filtered.length]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && open && filtered[highlighted]) {
      e.preventDefault();
      onChange(filtered[highlighted].name);
      setOpen(false);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        required
        className={INPUT_CLS}
        placeholder={`Search ${options.length} merchants…`}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 right-0 z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-[#D2D2D2] bg-white shadow-lg">
          {filtered.slice(0, 200).map((m, idx) => {
            const isHighlighted = idx === highlighted;
            return (
              <button
                key={m.id}
                type="button"
                onMouseDown={(e) => {
                  // Use onMouseDown not onClick so we beat the input's blur
                  e.preventDefault();
                  onChange(m.name);
                  setOpen(false);
                }}
                onMouseEnter={() => setHighlighted(idx)}
                className={cn(
                  "w-full text-left px-3 py-2 text-sm cursor-pointer border-b border-[#F3F3F3] last:border-b-0",
                  isHighlighted ? "bg-[#E6EEFA] text-[#004AAC]" : "text-[#2E2E2E] hover:bg-[#F7F7F7]"
                )}
              >
                {m.name}
              </button>
            );
          })}
          {filtered.length > 200 && (
            <div className="px-3 py-2 text-[11px] text-[#6E6E6E] border-t bg-[#FAFAFA]">
              Showing 200 of {filtered.length} — keep typing to narrow down
            </div>
          )}
        </div>
      )}
      {open && filtered.length === 0 && value.trim() && (
        <div className="absolute left-0 right-0 z-10 mt-1 rounded-md border border-[#D2D2D2] bg-white shadow-lg p-3 text-xs text-[#6E6E6E]">
          No merchant matches <span className="font-mono text-[#2E2E2E]">{value}</span> — it will be added as a new merchant on save.
        </div>
      )}
    </div>
  );
}

function MerchantModal({
  merchant,
  disputes,
  onClose,
  onDisputeClick,
}: {
  merchant: MerchantAggRow;
  disputes: DisputeRow[];
  onClose: () => void;
  onDisputeClick: (d: DisputeRow) => void;
}) {
  const tier = classifyTier(merchant.ratio_pct, merchant.orders);
  const meta = TIER_META[tier];
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const sortedDisputes = useMemo(() => sortDisputes(disputes, sortKey), [disputes, sortKey]);
  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-start justify-center p-4 lg:p-12 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="sa-card max-w-4xl w-full p-6 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="text-xs text-[#6E6E6E] mb-1">Merchant</div>
            <div className="text-xl font-semibold text-[#2E2E2E]">
              {merchant.merchant}
            </div>
            <div className="font-mono text-xs text-[#6E6E6E] mt-1">
              {merchant.merchant_id}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#6E6E6E] hover:text-[#2E2E2E] p-1 rounded hover:bg-gray-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="kpi-card">
            <div className="kpi-label">Disputes</div>
            <div className="text-2xl font-semibold text-[#2E2E2E]">
              {merchant.disputes}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Orders</div>
            <div className="text-2xl font-semibold text-[#2E2E2E]">
              {fmt.num(merchant.orders)}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Ratio</div>
            <div className="text-2xl font-semibold text-[#2E2E2E]">
              {fmt.pct(merchant.ratio_pct)}
            </div>
            <span
              className={cn(
                "inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold border",
                meta.bg,
                meta.text,
                meta.border
              )}
            >
              {meta.label}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h4 className="text-sm font-semibold text-[#2E2E2E]">
            Disputes ({disputes.length}) · click any row for full detail
          </h4>
          <SortDropdown value={sortKey} onChange={setSortKey} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full sa-table table-fixed min-w-[1000px]">
            <colgroup>
              <col className="w-[110px]" />{/* Date */}
              <col />{/* Customer (flex) */}
              <col className="w-[110px]" />{/* Provider */}
              <col className="w-[120px]" />{/* Amount */}
              <col className="w-[170px]" />{/* Status */}
              <col className="w-[140px]" />{/* Order */}
              <col className="w-[180px]" />{/* Dispute ID */}
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Provider</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Order</th>
                <th>Dispute ID</th>
              </tr>
            </thead>
            <tbody>
              {sortedDisputes.map((d) => (
                <tr key={d.dispute_id} onClick={() => onDisputeClick(d)}>
                  <td className="text-[#6E6E6E] whitespace-nowrap">
                    {fmt.date(d.created_at)}
                  </td>
                  <td>
                    <div className="text-[#2E2E2E] truncate">{d.customer_name ?? "—"}</div>
                    {d.customer_email && (
                      <div className="text-xs text-[#6E6E6E] truncate">{d.customer_email}</div>
                    )}
                  </td>
                  <td className="text-[#6E6E6E] whitespace-nowrap">{d.provider}</td>
                  <td className="text-[#2E2E2E] font-semibold whitespace-nowrap">
                    {fmt.money(d.amount_cents, d.currency)}
                  </td>
                  <td>
                    <span
                      className={cn(
                        "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase whitespace-nowrap",
                        statusBadgeClasses(displayStatus(d))
                      )}
                    >
                      {displayStatus(d)}
                    </span>
                  </td>
                  <td className="text-[#6E6E6E] font-mono text-xs truncate">
                    {orderDisplay(d)}
                  </td>
                  <td className="font-mono text-[10px] text-[#6E6E6E] max-w-[160px] truncate">
                    {d.dispute_id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Click-to-copy value with a Copy icon that toggles to a green Check on success.
 * Used in the dispute detail modal for IDs, customer name, and email.
 */
function CopyableValue({
  value,
  mono = false,
  className = "",
}: {
  value: string;
  mono?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      className={cn(
        "inline-flex items-center gap-1.5 text-[#2E2E2E] hover:text-[#004AAC] group",
        mono && "font-mono text-xs",
        className
      )}
      title={`Click to copy: ${value}`}
    >
      <span className="break-all text-left">{value}</span>
      {copied ? (
        <Check className="w-3 h-3 text-emerald-600 flex-shrink-0" />
      ) : (
        <Copy className="w-3 h-3 text-[#6E6E6E] group-hover:text-[#004AAC] flex-shrink-0" />
      )}
    </button>
  );
}

// Back-compat alias for the existing call sites (Dispute ID + Order ID).
function CopyableId({ id }: { id: string }) {
  return <CopyableValue value={id} mono />;
}

function Field({
  label,
  value,
  valueClass,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-[#6E6E6E]">{label}</div>
      <div
        className={cn(
          "text-[#2E2E2E] mt-0.5 break-words",
          mono && "font-mono text-xs",
          valueClass
        )}
      >
        {value}
      </div>
    </div>
  );
}
