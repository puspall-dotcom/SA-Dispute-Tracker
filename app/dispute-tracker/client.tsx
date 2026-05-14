"use client";

import { useMemo, useState, useRef } from "react";
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
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  TrendingDown,
  X,
} from "lucide-react";
import type { DisputeDashboardData, DisputeRow, MerchantAggRow } from "@/lib/db/queries";
import {
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

function disputeUrl(d: DisputeRow): string | null {
  if (d.dispute_id.startsWith("du_")) {
    const acct = d.provider === "Stripe UAE" ? "acct_1RWHSEI2yvKfCFUI" : "acct_1SbzBXGT489qrT5g";
    return `https://dashboard.stripe.com/${acct}/disputes/${d.dispute_id}`;
  }
  return null;
}

function orderDisplay(d: DisputeRow): string {
  return (
    d.shopify_order_name?.trim() ||
    d.shopify_order_id ||
    d.order_id ||
    "—"
  );
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main client                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

export function DisputeTrackerClient({ data }: { data: DisputeDashboardData }) {
  const [selectedDispute, setSelectedDispute] = useState<DisputeRow | null>(null);
  const [selectedMerchant, setSelectedMerchant] = useState<MerchantAggRow | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMerchants, setExpandedMerchants] = useState<Set<string>>(new Set());
  const allDisputesRef = useRef<HTMLDivElement>(null);

  const filteredDisputes = useMemo(() => {
    if (filterStatus === "all") return data.disputes;
    return data.disputes.filter((d) => d.status === filterStatus);
  }, [data.disputes, filterStatus]);

  // Group filtered disputes by merchant
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
    return Array.from(map.values()).sort((a, b) => b.disputes.length - a.disputes.length);
  }, [filteredDisputes]);

  const handleRefresh = async () => {
    setRefreshing(true);
    window.location.reload();
  };

  const handleKpiClick = (status: string) => {
    setFilterStatus(status);
    // Auto-expand all merchants when filtering
    if (status !== "all") {
      const all = new Set(data.disputes.filter((d) => d.status === status).map((d) => d.merchant_id));
      setExpandedMerchants(all);
    }
    setTimeout(() => allDisputesRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
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
            onClick={handleRefresh}
            disabled={refreshing}
            className="btn-brand flex items-center gap-2"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Row — clickable */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <Kpi
          label="Total Disputes"
          value={fmt.num(data.totals.totalDisputes)}
          icon={<ShieldAlert className="w-4 h-4" />}
          accent="red"
          onClick={() => handleKpiClick("all")}
          active={filterStatus === "all"}
        />
        <Kpi
          label="Open"
          value={fmt.num(data.totals.openDisputes)}
          icon={<Clock className="w-4 h-4" />}
          accent="brand"
          onClick={() => handleKpiClick("open")}
          active={filterStatus === "open"}
        />
        <Kpi
          label="Lost"
          value={fmt.num(data.totals.lostDisputes)}
          icon={<TrendingDown className="w-4 h-4" />}
          accent="red"
          onClick={() => handleKpiClick("lost")}
          active={filterStatus === "lost"}
        />
        <Kpi
          label="Won"
          value={fmt.num(data.totals.wonDisputes)}
          icon={<CheckCircle2 className="w-4 h-4" />}
          accent="emerald"
          onClick={() => handleKpiClick("won")}
          active={filterStatus === "won"}
        />
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
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="sa-card p-6">
          <h3 className="text-sm font-semibold text-[#2E2E2E] mb-1">Status Breakdown</h3>
          <p className="text-xs text-[#6E6E6E] mb-4">
            Hover for details · sourced from{" "}
            <span className="font-mono">order_info.dispute_status</span>
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
                  >
                    {data.byStatus.map((s) => (
                      <Cell key={s.label} fill={statusColor(s.label)} />
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
          <h3 className="text-sm font-semibold text-[#2E2E2E] mb-1">By Provider</h3>
          <p className="text-xs text-[#6E6E6E] mb-4">
            Provider classified from dispute_id format
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
                    cursor={{ fill: "rgba(0, 74, 172, 0.06)" }}
                    formatter={(value) => [`${Number(value ?? 0)} disputes`, "Count"]}
                  />
                  <Bar dataKey="count" fill="#004AAC" radius={[6, 6, 0, 0]} />
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
          <TierLegend />
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
          </div>
          <div className="flex items-center gap-2 text-xs flex-wrap">
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
              const stats = {
                open: g.disputes.filter((d) => d.status === "open").length,
                lost: g.disputes.filter((d) => d.status === "lost").length,
                won: g.disputes.filter((d) => d.status === "won").length,
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
                      <table className="w-full sa-table">
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
                                <div className="text-[#2E2E2E]">
                                  {d.customer_name ?? "—"}
                                </div>
                                {d.customer_email && (
                                  <div className="text-xs text-[#6E6E6E]">
                                    {d.customer_email}
                                  </div>
                                )}
                              </td>
                              <td className="text-[#6E6E6E]">{d.provider}</td>
                              <td className="text-[#2E2E2E] font-semibold whitespace-nowrap">
                                {fmt.money(d.amount_cents, d.currency)}
                              </td>
                              <td>
                                <span
                                  className={cn(
                                    "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase",
                                    statusBadgeClasses(d.status)
                                  )}
                                >
                                  {d.status}
                                </span>
                              </td>
                              <td className="text-[#6E6E6E] font-mono text-xs">
                                {orderDisplay(d)}
                              </td>
                              <td className="font-mono text-[10px] text-[#6E6E6E] max-w-[180px] truncate">
                                {d.dispute_id}
                              </td>
                              <td className="text-[#6E6E6E] whitespace-nowrap">
                                {fmt.date(d.evidence_due_at)}
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

function TierLegend() {
  const tiers: Tier[] = ["off-board", "candidate", "nudge", "healthy"];
  return (
    <div className="flex items-center gap-2 text-[10px]">
      {tiers.map((t) => {
        const meta = TIER_META[t];
        return (
          <span
            key={t}
            className={cn(
              "px-2 py-0.5 rounded-full border font-bold",
              meta.bg,
              meta.text,
              meta.border
            )}
          >
            {meta.label}
          </span>
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
            <div className="font-mono text-sm text-[#2E2E2E] break-all">
              {dispute.dispute_id}
            </div>
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
          <Field label="Provider" value={dispute.provider} />
          <Field label="Customer" value={dispute.customer_name ?? "—"} />
          <Field label="Customer Email" value={dispute.customer_email ?? "—"} />
          <Field
            label="Amount"
            value={fmt.money(dispute.amount_cents, dispute.currency)}
            valueClass="text-[#2E2E2E] font-semibold"
          />
          <Field
            label="Status"
            value={
              <span
                className={cn(
                  "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase",
                  statusBadgeClasses(dispute.status)
                )}
              >
                {dispute.status}
              </span>
            }
          />
          <Field label="Created" value={fmt.date(dispute.created_at)} />
          <Field label="Evidence Deadline" value={fmt.date(dispute.evidence_due_at)} />
          <Field label="Resolved" value={fmt.date(dispute.resolved_at)} />
          <Field label="Order" value={orderDisplay(dispute)} />
          <Field label="Order ID" value={dispute.order_id ?? "—"} mono />
          <Field label="Payment Gateway" value={dispute.payment_gateway ?? "—"} />
          {dispute.fee_usd_cents > 0 && (
            <Field
              label="$50 Fee"
              value={fmt.usd(dispute.fee_usd_cents)}
              valueClass="text-red-600 font-semibold"
            />
          )}
        </div>

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="btn-brand mt-6 inline-flex items-center gap-2"
          >
            Open in Stripe <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
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

        <h4 className="text-sm font-semibold text-[#2E2E2E] mb-3">
          Disputes ({disputes.length}) · click any row for full detail
        </h4>
        <div className="overflow-x-auto">
          <table className="w-full sa-table">
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
              {disputes.map((d) => (
                <tr key={d.dispute_id} onClick={() => onDisputeClick(d)}>
                  <td className="text-[#6E6E6E] whitespace-nowrap">
                    {fmt.date(d.created_at)}
                  </td>
                  <td>
                    <div className="text-[#2E2E2E]">{d.customer_name ?? "—"}</div>
                    {d.customer_email && (
                      <div className="text-xs text-[#6E6E6E]">{d.customer_email}</div>
                    )}
                  </td>
                  <td className="text-[#6E6E6E]">{d.provider}</td>
                  <td className="text-[#2E2E2E] font-semibold whitespace-nowrap">
                    {fmt.money(d.amount_cents, d.currency)}
                  </td>
                  <td>
                    <span
                      className={cn(
                        "inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase",
                        statusBadgeClasses(d.status)
                      )}
                    >
                      {d.status}
                    </span>
                  </td>
                  <td className="text-[#6E6E6E] font-mono text-xs">
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
