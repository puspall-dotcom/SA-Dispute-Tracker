import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fmt = {
  num(n: number): string {
    return new Intl.NumberFormat("en-US").format(n);
  },
  usd(cents: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  },
  money(amountCents: number, currency: string): string {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: 2,
      }).format(amountCents / 100);
    } catch {
      return `${(amountCents / 100).toFixed(2)} ${currency}`;
    }
  },
  pct(n: number, digits = 2): string {
    return `${n.toFixed(digits)}%`;
  },
  date(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  },
  relativeTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const diffMs = Date.now() - d.getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  },
};

export type Tier = "off-board" | "candidate" | "nudge" | "healthy" | "n/a";

export function classifyTier(ratioPct: number, orders: number): Tier {
  if (orders < 5) return "n/a";
  if (ratioPct >= 1.5) return "off-board";
  if (ratioPct >= 1.0) return "candidate";
  if (ratioPct >= 0.5) return "nudge";
  return "healthy";
}

export const TIER_META: Record<
  Tier,
  { label: string; bg: string; text: string; border: string }
> = {
  "off-board": {
    label: "OFF-BOARD",
    bg: "bg-rose-100",
    text: "text-rose-700",
    border: "border-rose-200",
  },
  candidate: {
    label: "CANDIDATE",
    bg: "bg-amber-100",
    text: "text-amber-700",
    border: "border-amber-200",
  },
  nudge: {
    label: "NUDGE",
    bg: "bg-yellow-50",
    text: "text-yellow-700",
    border: "border-yellow-200",
  },
  healthy: {
    label: "HEALTHY",
    bg: "bg-emerald-100",
    text: "text-emerald-700",
    border: "border-emerald-200",
  },
  "n/a": {
    label: "N/A",
    bg: "bg-slate-100",
    text: "text-slate-600",
    border: "border-slate-200",
  },
};

export function statusBadgeClasses(status: string): string {
  const s = status.toLowerCase();
  if (s === "won") return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (s === "lost") return "bg-rose-100 text-rose-700 border-rose-200";
  if (s === "under_review" || s === "submitted")
    return "bg-blue-100 text-blue-700 border-blue-200";
  if (s === "needs_response" || s.includes("warning"))
    return "bg-amber-100 text-amber-700 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}
