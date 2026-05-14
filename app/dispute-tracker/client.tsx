"use client";

import { useMemo, useState } from "react";
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
} from "recharts";
import {
  AlertTriangle,
  CheckCircle2,
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
  open: "#3b82f6",
  needs_response: "#f59e0b",
  under_review: "#06b6d4",
  warning_needs_response: "#f59e0b",
  warning_under_review: "#06b6d4",
  warning_closed: "#a78bfa",
  won: "#10b981",
  lost: "#ef4444",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status.toLowerCase()] ?? "#94a3b8";
}

function disputeUrl(d: DisputeRow): string | null {
  if (d.dispute_id.startsWith("du_")) {
    const acct = d.provider === "Stripe UAE" ? "acct_1RWHSEI2yvKfCFUI" : "acct_1SbzBXGT489qrT5g";
    return `https://dashboard.stripe.com/${acct}/disputes/${d.dispute_id}`;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main client                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

export function DisputeTrackerClient({ data }: { data: DisputeDashboardData }) {
  const [selectedDispute, setSelectedDispute] = useState<DisputeRow | null>(null);
  const [selectedMerchant, setSelectedMerchant] = useState<MerchantAggRow | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [refreshing, setRefreshing] = useState(false);

  const filteredDisputes = useMemo(() => {
    if (filterStatus === "all") return data.disputes;
    return data.disputes.filter((d) => d.status === filterStatus);
  }, [data.disputes, filterStatus]);

  const handleRefresh = async () => {
    setRefreshing(true);
    window.location.reload();
  };

  return (
    <div className="min-h-screen p-6 lg:p-8 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="text-3xl lg:text-4xl font-bold text-white tracking-tight">
            Dispute Tracker
          </h1>
          <p className="text-slate-400 mt-2 text-sm max-w-2xl">
            Live dispute dashboard sourced 100% from production Postgres (
            <span className="font-mono text-slate-300">order_info</span>,{" "}
            <span className="font-mono text-slate-300">merchant</span>,{" "}
            <span className="font-mono text-slate-300">ledger_entry</span>). No sheet
            dependency, no manual entry.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs text-slate-400">
            <div>Last DB update</div>
            <div className="text-slate-200 font-medium">
              {fmt.relativeTime(data.lastSyncedAt)}
            </div>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:bg-blue-800 disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-all shadow-md"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <Kpi
          label="Total Disputes"
          value={fmt.num(data.totals.totalDisputes)}
          icon={<ShieldAlert className="w-4 h-4" />}
          accent="rose"
        />
        <Kpi
          label="Open"
          value={fmt.num(data.totals.openDisputes)}
          icon={<Clock className="w-4 h-4" />}
          accent="blue"
        />
        <Kpi
          label="Lost"
          value={fmt.num(data.totals.lostDisputes)}
          icon={<TrendingDown className="w-4 h-4" />}
          accent="rose"
        />
        <Kpi
          label="Won"
          value={fmt.num(data.totals.wonDisputes)}
          icon={<CheckCircle2 className="w-4 h-4" />}
          accent="emerald"
        />
        <Kpi
          label="Total Orders"
          value={fmt.num(data.totals.totalOrders)}
          icon={<DollarSign className="w-4 h-4" />}
          accent="slate"
          hint="excl. canceled/archived/draft"
        />
        <Kpi
          label="Company Ratio"
          value={fmt.pct(data.totals.companyRatioPct)}
          icon={<AlertTriangle className="w-4 h-4" />}
          accent={
            data.totals.companyRatioPct >= 1
              ? "rose"
              : data.totals.companyRatioPct >= 0.5
              ? "amber"
              : "emerald"
          }
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="glass-card p-6">
          <h3 className="text-sm font-semibold text-white mb-1">Status Breakdown</h3>
          <p className="text-xs text-slate-400 mb-4">
            Live values from <span className="font-mono">order_info.dispute_status</span>
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
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                    label={(entry: { label?: string; count?: number }) =>
                      `${entry.label ?? ""} (${entry.count ?? 0})`
                    }
                    labelLine={false}
                  >
                    {data.byStatus.map((s) => (
                      <Cell key={s.label} fill={statusColor(s.label)} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "#0b1220",
                      border: "1px solid #334155",
                      borderRadius: 8,
                      color: "#e2e8f0",
                    }}
                    formatter={(value: number, name: string) => [`${value} disputes`, name]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="glass-card p-6">
          <h3 className="text-sm font-semibold text-white mb-1">By Provider</h3>
          <p className="text-xs text-slate-400 mb-4">
            Provider classified from dispute_id format
          </p>
          {data.byProvider.length === 0 ? (
            <EmptyState text="No disputes in DB" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.byProvider} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={{ stroke: "#334155" }}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={{ stroke: "#334155" }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0b1220",
                      border: "1px solid #334155",
                      borderRadius: 8,
                      color: "#e2e8f0",
                    }}
                    formatter={(value: number) => [`${value} disputes`, "Count"]}
                  />
                  <Bar dataKey="count" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Per-merchant table */}
      <div className="glass-card p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Per-Merchant Health</h3>
            <p className="text-xs text-slate-400">
              Order counts from live Postgres (excl. canceled/archived/draft). Click a row
              for merchant detail.
            </p>
          </div>
          <TierLegend />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full dispute-table">
            <thead>
              <tr>
                <th>Merchant</th>
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
                      <div className="font-medium text-white">{m.merchant}</div>
                      {m.last_dispute_at && (
                        <div className="text-xs text-slate-400 mt-0.5">
                          last dispute {fmt.date(m.last_dispute_at)}
                        </div>
                      )}
                    </td>
                    <td className="text-right font-semibold text-white">{m.disputes}</td>
                    <td className="text-right text-blue-300">{m.open || "—"}</td>
                    <td className="text-right text-rose-300">{m.lost || "—"}</td>
                    <td className="text-right text-emerald-300">{m.won || "—"}</td>
                    <td className="text-right text-slate-300">{fmt.num(m.orders)}</td>
                    <td className="text-right font-semibold text-white">
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
                    <td className="text-right text-slate-300">
                      {m.fees_paid_usd_cents > 0 ? fmt.usd(m.fees_paid_usd_cents) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* All disputes table */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              All Disputes ({filteredDisputes.length})
            </h3>
            <p className="text-xs text-slate-400">Click a row to see full detail</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">Filter:</span>
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
        <div className="overflow-x-auto">
          <table className="w-full dispute-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Merchant</th>
                <th>Customer</th>
                <th>Provider</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Order</th>
                <th>Deadline</th>
              </tr>
            </thead>
            <tbody>
              {filteredDisputes.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center text-slate-400 py-8">
                    No disputes match this filter
                  </td>
                </tr>
              ) : (
                filteredDisputes.map((d) => (
                  <tr key={d.dispute_id} onClick={() => setSelectedDispute(d)}>
                    <td className="text-slate-300">{fmt.date(d.created_at)}</td>
                    <td className="text-white font-medium">{d.merchant}</td>
                    <td>
                      <div className="text-white">{d.customer_name ?? "—"}</div>
                      {d.customer_email && (
                        <div className="text-xs text-slate-400">{d.customer_email}</div>
                      )}
                    </td>
                    <td className="text-slate-300">{d.provider}</td>
                    <td className="text-white font-semibold">
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
                    <td className="text-slate-300 font-mono text-xs">
                      {d.shopify_order_name?.trim() || "—"}
                    </td>
                    <td className="text-slate-300">{fmt.date(d.evidence_due_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedDispute && (
        <DisputeModal dispute={selectedDispute} onClose={() => setSelectedDispute(null)} />
      )}
      {selectedMerchant && (
        <MerchantModal
          merchant={selectedMerchant}
          disputes={data.disputes.filter((d) => d.merchant_id === selectedMerchant.merchant_id)}
          onClose={() => setSelectedMerchant(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Sub-components                                                               */
/* ─────────────────────────────────────────────────────────────────────────── */

const ACCENT_STYLES: Record<string, { ring: string; icon: string }> = {
  rose: { ring: "ring-rose-500/30", icon: "text-rose-400 bg-rose-500/15" },
  blue: { ring: "ring-blue-500/30", icon: "text-blue-400 bg-blue-500/15" },
  emerald: { ring: "ring-emerald-500/30", icon: "text-emerald-400 bg-emerald-500/15" },
  amber: { ring: "ring-amber-500/30", icon: "text-amber-400 bg-amber-500/15" },
  slate: { ring: "ring-slate-500/30", icon: "text-slate-400 bg-slate-500/15" },
};

function Kpi({
  label,
  value,
  icon,
  accent,
  hint,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: keyof typeof ACCENT_STYLES;
  hint?: string;
}) {
  const styles = ACCENT_STYLES[accent];
  return (
    <div className={cn("brand-card p-4 ring-1", styles.ring)}>
      <div className="flex items-center justify-between mb-2">
        <span className="kpi-label">{label}</span>
        <span className={cn("p-1.5 rounded-md", styles.icon)}>{icon}</span>
      </div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="text-[10px] text-slate-500 mt-1">{hint}</div>}
    </div>
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
          ? "bg-white/10 border-white/30 text-white"
          : "bg-transparent border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20"
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
    <div className="h-64 flex items-center justify-center text-slate-500 text-sm">{text}</div>
  );
}

function DisputeModal({ dispute, onClose }: { dispute: DisputeRow; onClose: () => void }) {
  const url = disputeUrl(dispute);
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-start justify-center p-4 lg:p-12 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="glass-card max-w-2xl w-full p-6 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="text-xs text-slate-400 mb-1">Dispute ID</div>
            <div className="font-mono text-sm text-white">{dispute.dispute_id}</div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10 transition"
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
            valueClass="text-white font-semibold"
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
          <Field label="Order" value={dispute.shopify_order_name?.trim() || "—"} />
          <Field label="Order ID" value={dispute.order_id ?? "—"} mono />
          <Field label="Payment Gateway" value={dispute.payment_gateway ?? "—"} />
          {dispute.fee_usd_cents > 0 && (
            <Field
              label="$50 Fee"
              value={fmt.usd(dispute.fee_usd_cents)}
              valueClass="text-rose-300 font-semibold"
            />
          )}
        </div>

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-white font-medium transition"
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
}: {
  merchant: MerchantAggRow;
  disputes: DisputeRow[];
  onClose: () => void;
}) {
  const tier = classifyTier(merchant.ratio_pct, merchant.orders);
  const meta = TIER_META[tier];
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-start justify-center p-4 lg:p-12 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="glass-card max-w-3xl w-full p-6 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="text-xs text-slate-400 mb-1">Merchant</div>
            <div className="text-xl font-bold text-white">{merchant.merchant}</div>
            <div className="font-mono text-xs text-slate-500 mt-1">{merchant.merchant_id}</div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/10 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="brand-card p-3">
            <div className="kpi-label">Disputes</div>
            <div className="text-2xl font-bold text-white">{merchant.disputes}</div>
          </div>
          <div className="brand-card p-3">
            <div className="kpi-label">Orders</div>
            <div className="text-2xl font-bold text-white">{fmt.num(merchant.orders)}</div>
          </div>
          <div className="brand-card p-3">
            <div className="kpi-label">Ratio</div>
            <div className="text-2xl font-bold text-white">{fmt.pct(merchant.ratio_pct)}</div>
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

        <h4 className="text-sm font-semibold text-white mb-3">Disputes ({disputes.length})</h4>
        <div className="overflow-x-auto">
          <table className="w-full dispute-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <tr key={d.dispute_id}>
                  <td className="text-slate-300">{fmt.date(d.created_at)}</td>
                  <td className="text-white">{d.customer_name ?? "—"}</td>
                  <td className="text-white font-semibold">
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
      <div className="text-xs text-slate-400">{label}</div>
      <div className={cn("text-slate-200 mt-0.5", mono && "font-mono text-xs", valueClass)}>
        {value}
      </div>
    </div>
  );
}
