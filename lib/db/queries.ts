import { rawQuery } from "./client";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Types                                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

export interface DisputeRow {
  dispute_id: string;
  provider: "Stripe UAE" | "Stripe Inc" | "Tabby/Tamara";
  merchant_id: string;
  merchant: string;
  customer_name: string | null;
  customer_email: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  created_at: string | null;
  evidence_due_at: string | null;
  resolved_at: string | null;
  shopify_order_name: string | null;
  order_id: string | null;
  payment_gateway: string | null;
  fee_usd_cents: number;
}

export interface MerchantAggRow {
  merchant_id: string;
  merchant: string;
  disputes: number;
  open: number;
  lost: number;
  won: number;
  orders: number;
  ratio_pct: number;
  fees_paid_usd_cents: number;
  last_dispute_at: string | null;
}

export interface DisputeDashboardData {
  disputes: DisputeRow[];
  merchants: MerchantAggRow[];
  totals: {
    totalDisputes: number;
    openDisputes: number;
    lostDisputes: number;
    wonDisputes: number;
    totalOrders: number;
    companyRatioPct: number;
    totalFeesUsdCents: number;
  };
  byStatus: Array<{ label: string; count: number }>;
  byProvider: Array<{ label: string; count: number }>;
  recentDisputes: DisputeRow[];
  lastSyncedAt: string | null;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

function classifyProvider(disputeId: string): DisputeRow["provider"] {
  if (disputeId.startsWith("du_")) {
    return disputeId.includes("I2yvKfCFUI") ? "Stripe UAE" : "Stripe Inc";
  }
  return "Tabby/Tamara";
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main loader                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function getDisputeDashboardData(): Promise<DisputeDashboardData> {
  // 1. Pull every dispute from order_info, joined with merchant + customer
  const disputeRows = await rawQuery<{
    dispute_id: string;
    merchant_id: string;
    merchant: string;
    customer_email: string | null;
    customer_first_name: string | null;
    customer_last_name: string | null;
    status: string;
    amount_cents: string;
    currency: string;
    created_at: string | null;
    evidence_due_at: string | null;
    resolved_at: string | null;
    shopify_order_name: string | null;
    order_id: string | null;
    payment_gateway: string | null;
    dispute_fee_ledger_entry_id: string | null;
    updated_at: string;
  }>(
    `SELECT
       oi.dispute_id,
       m.id::text AS merchant_id,
       m.name AS merchant,
       o.email AS customer_email,
       c.first_name AS customer_first_name,
       c.last_name AS customer_last_name,
       COALESCE(oi.dispute_status, 'open') AS status,
       oi.transaction_amount_cents::text AS amount_cents,
       oi.transaction_currency AS currency,
       oi.dispute_processed_at::text AS created_at,
       oi.dispute_evidence_due_at::text AS evidence_due_at,
       oi.dispute_resolved_at::text AS resolved_at,
       oi.shopify_order_name,
       oi.order_id,
       oi.payment_gateway,
       oi.dispute_fee_ledger_entry_id,
       oi.updated_at::text AS updated_at
     FROM order_info oi
     JOIN merchant m ON m.id = oi.merchant_id
     LEFT JOIN merchant_merchant_order_order mmoo ON mmoo.order_id = oi.order_id
     LEFT JOIN "order" o ON o.id = mmoo.order_id
     LEFT JOIN customer c ON c.id = o.customer_id
     WHERE oi.dispute_id IS NOT NULL
       AND m.is_test = false
       AND oi.deleted_at IS NULL
     ORDER BY oi.dispute_processed_at DESC NULLS LAST`
  );

  // 2. Pull dispute fees keyed by dispute_fee_ledger_entry_id
  const feeIds = disputeRows
    .map((r) => r.dispute_fee_ledger_entry_id)
    .filter((x): x is string => !!x);
  const feeRows = feeIds.length
    ? await rawQuery<{ id: string; usd_amount_cents: string | null }>(
        `SELECT id, usd_amount_cents::text AS usd_amount_cents
         FROM ledger_entry
         WHERE id = ANY($1::text[])`,
        [feeIds]
      )
    : [];
  const feeById = new Map<string, number>();
  for (const r of feeRows) {
    const cents = r.usd_amount_cents ? Number(r.usd_amount_cents) : 5000;
    feeById.set(r.id, cents);
  }

  // 3. Per-merchant order counts (excludes canceled/archived/draft)
  const orderRows = await rawQuery<{
    merchant_id: string;
    merchant: string;
    orders: string;
  }>(
    `SELECT m.id::text AS merchant_id, m.name AS merchant,
            COUNT(DISTINCT oi.order_id)::text AS orders
     FROM order_info oi
     JOIN merchant m ON m.id = oi.merchant_id
     JOIN merchant_merchant_order_order mmoo ON mmoo.order_id = oi.order_id
     JOIN "order" o ON o.id = mmoo.order_id
     WHERE m.is_test = false
       AND oi.deleted_at IS NULL
       AND o.status NOT IN ('canceled', 'archived', 'draft')
     GROUP BY m.id, m.name`
  );
  const ordersByMerchant = new Map<string, { merchant: string; orders: number }>();
  let totalOrders = 0;
  for (const r of orderRows) {
    const o = Number(r.orders || 0);
    ordersByMerchant.set(r.merchant_id, { merchant: r.merchant, orders: o });
    totalOrders += o;
  }

  // 4. Build disputes array with provider + fee
  const disputes: DisputeRow[] = disputeRows.map((r) => {
    const customerName = [r.customer_first_name, r.customer_last_name]
      .filter(Boolean)
      .join(" ") || null;
    const fee_usd_cents = r.dispute_fee_ledger_entry_id
      ? feeById.get(r.dispute_fee_ledger_entry_id) ?? 5000
      : 0;
    return {
      dispute_id: r.dispute_id,
      provider: classifyProvider(r.dispute_id),
      merchant_id: r.merchant_id,
      merchant: r.merchant,
      customer_name: customerName,
      customer_email: r.customer_email,
      status: (r.status || "open").toLowerCase(),
      amount_cents: Number(r.amount_cents || 0),
      currency: r.currency || "USD",
      created_at: r.created_at,
      evidence_due_at: r.evidence_due_at,
      resolved_at: r.resolved_at,
      shopify_order_name: r.shopify_order_name,
      order_id: r.order_id,
      payment_gateway: r.payment_gateway,
      fee_usd_cents,
    };
  });

  // 5. Per-merchant aggregation
  const aggMap = new Map<string, MerchantAggRow>();
  for (const d of disputes) {
    if (!aggMap.has(d.merchant_id)) {
      const o = ordersByMerchant.get(d.merchant_id);
      aggMap.set(d.merchant_id, {
        merchant_id: d.merchant_id,
        merchant: d.merchant,
        disputes: 0,
        open: 0,
        lost: 0,
        won: 0,
        orders: o?.orders ?? 0,
        ratio_pct: 0,
        fees_paid_usd_cents: 0,
        last_dispute_at: null,
      });
    }
    const row = aggMap.get(d.merchant_id)!;
    row.disputes += 1;
    if (d.status === "lost") row.lost += 1;
    else if (d.status === "won") row.won += 1;
    else row.open += 1;
    row.fees_paid_usd_cents += d.fee_usd_cents;
    if (!row.last_dispute_at || (d.created_at && d.created_at > row.last_dispute_at)) {
      row.last_dispute_at = d.created_at;
    }
  }
  const merchants = Array.from(aggMap.values()).map((m) => ({
    ...m,
    ratio_pct: m.orders > 0 ? (m.disputes / m.orders) * 100 : 0,
  }));
  merchants.sort((a, b) => b.ratio_pct - a.ratio_pct);

  // 6. Status + provider breakdowns
  const byStatusMap = new Map<string, number>();
  const byProviderMap = new Map<string, number>();
  for (const d of disputes) {
    byStatusMap.set(d.status, (byStatusMap.get(d.status) ?? 0) + 1);
    byProviderMap.set(d.provider, (byProviderMap.get(d.provider) ?? 0) + 1);
  }
  const byStatus = Array.from(byStatusMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
  const byProvider = Array.from(byProviderMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // 7. Totals
  const totalDisputes = disputes.length;
  const openDisputes = disputes.filter((d) => d.status === "open").length;
  const lostDisputes = disputes.filter((d) => d.status === "lost").length;
  const wonDisputes = disputes.filter((d) => d.status === "won").length;
  const totalFeesUsdCents = disputes.reduce((s, d) => s + d.fee_usd_cents, 0);
  const companyRatioPct = totalOrders > 0 ? (totalDisputes / totalOrders) * 100 : 0;

  // 8. Last synced at = max updated_at across dispute rows
  const lastSyncedAt = disputeRows
    .map((r) => r.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    disputes,
    merchants,
    totals: {
      totalDisputes,
      openDisputes,
      lostDisputes,
      wonDisputes,
      totalOrders,
      companyRatioPct,
      totalFeesUsdCents,
    },
    byStatus,
    byProvider,
    recentDisputes: disputes.slice(0, 10),
    lastSyncedAt,
  };
}
