import { rawQuery } from "./client";
import { getDisputeTrackerSheet, type SheetDisputeRow } from "../sheets/dispute-tracker";
import { fetchStripeDisputeMeta } from "../stripe/disputes";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Types                                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

export type ProviderName =
  | "Stripe UAE"
  | "Stripe USA"
  | "Stripe Inc"
  | "Tabby UAE"
  | "Tabby KSA"
  | "Tamara UAE"
  | "Tamara KSA"
  | "Tabby/Tamara"
  | "Unknown";

export type StatusBucket = "open" | "lost" | "won";

export interface DisputeRow {
  dispute_id: string;
  provider: ProviderName;
  merchant_id: string;
  merchant: string;
  customer_name: string | null;
  customer_email: string | null;
  status: string;            // raw status (sheet wins if present)
  bucket: StatusBucket;       // canonical bucket (open / lost / won)
  amount_cents: number;
  currency: string;
  created_at: string | null;
  evidence_due_at: string | null;
  // Raw deadline text from the sheet — surfaces unparseable values like
  // "TBC (14-day Tabby SLA)" when we can't extract a real date. Empty when
  // the sheet had nothing OR we have a parsed date in evidence_due_at.
  deadline_text: string;
  resolved_at: string | null;
  shopify_order_name: string | null;
  shopify_order_id: string | null;
  order_id: string | null;
  payment_gateway: string | null;
  fee_usd_cents: number;
  // Editable internal notes from the sheet (col L). Empty string when no note set.
  internal_notes: string;
  // Reason as captured in the sheet (col F), separate from the editable note.
  reason: string;
  // Sheet row number (3+) for write-back. Null if dispute is DB-only and has
  // never been written to the sheet.
  sheet_row: number | null;
  // True if the dispute exists ONLY in the sheet (manually added, not in Postgres).
  is_manual: boolean;
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
  // Every active (non-test) merchant in Postgres, ordered by name. Surfaced
  // for the "Add Dispute" form dropdown so the user can pick any merchant —
  // not just ones that currently have disputes.
  allMerchants: Array<{ id: string; name: string }>;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

function classifyProvider(disputeId: string): ProviderName {
  if (disputeId.startsWith("du_")) {
    return disputeId.includes("I2yvKfCFUI") ? "Stripe UAE" : "Stripe Inc";
  }
  return "Tabby/Tamara";
}

// Map any raw status string (from sheet OR DB) to the canonical 3-bucket model.
// Lost/Refunded collapse into "lost"; Won/Cancelled collapse into "won";
// everything else (incl. Submitted, Pending Evidence, Compiling Evidence,
// Evidence Compiled, Awaiting POD, Under Review, needs_response, etc.) is "open".
export function statusBucket(status: string): StatusBucket {
  const s = (status || "").toLowerCase().trim();
  if (s === "lost" || s === "refunded" || s === "loss") return "lost";
  if (s === "won" || s === "cancelled" || s === "canceled") return "won";
  return "open";
}

// Parse sheet amount string ("1,234.56" or "1234.56") into integer cents.
function parseAmountToCents(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  const f = parseFloat(cleaned);
  if (isNaN(f)) return 0;
  return Math.round(f * 100);
}

// Parse a sheet date like "06 May 2026" or "10 May, 2026" to ISO yyyy-mm-dd.
function parseSheetDate(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, "").trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Sheet stores the customer field as "Full Name (email@domain.com)" — or
// sometimes just a name, just an email, or "Name <email>". Split into the two
// distinct fields so the dashboard can show name + email separately AND so we
// can match against Postgres `customer.email` for order enrichment.
export function parseSheetCustomer(raw: string): { name: string; email: string } {
  const s = (raw || "").trim();
  if (!s) return { name: "", email: "" };
  // "Name (email)" or "Name <email>" — accepts trailing/leading whitespace
  const m1 = s.match(/^(.+?)\s*[\(<]\s*([^\s@]+@[^\s@]+\.[^\s@)>]+)\s*[\)>]?\s*$/);
  if (m1) return { name: m1[1].trim(), email: m1[2].trim().toLowerCase() };
  // Bare email
  if (/^\S+@\S+\.\S+$/.test(s)) return { name: "", email: s.toLowerCase() };
  // Otherwise treat as a plain name
  return { name: s, email: "" };
}

// Recognise sheet "deadline" entries that are ops notes rather than dates, so
// we don't leak strings like "Not yet converted to formal dispute" or
// "TBC (14-day Tabby SLA)" into a date column. Used as a guard before
// surfacing raw text as a deadline.
function isDeadlinePlaceholder(raw: string): boolean {
  const s = (raw || "").toLowerCase();
  if (!s) return true;
  return (
    s.includes("not yet") ||
    s.includes("tbc") ||
    s.includes("n/a") ||
    s.includes("na ") ||
    s === "na" ||
    s.includes("sla") ||
    s.includes("pending")
  );
}

// Add N days to an ISO date (yyyy-mm-dd or any Date-parseable string). Returns
// yyyy-mm-dd or null if the input is bad. Used to compute Tabby/Tamara SLA
// deadlines (14 days from dispute creation) when the sheet has unparseable
// placeholder text instead of a real date.
function addDays(isoDate: string | null, days: number): string | null {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Tabby and Tamara both run a 14-day merchant response SLA. When the sheet's
// Response Deadline column has placeholder text like "TBC (14-day Tabby SLA)"
// we compute the real date from the dispute's created_at.
// We do NOT do this for Stripe — Stripe gives an exact evidence_due_at per
// dispute, so any estimated date would be misleading. Stripe disputes pull
// the real deadline from Postgres / Stripe API.
const SLA_DAYS: Record<string, number> = {
  "Tabby UAE": 14,
  "Tabby KSA": 14,
  "Tamara UAE": 14,
  "Tamara KSA": 14,
};

// Normalise merchant names so "Fizzy Goblet" (sheet) and "Fizzy Goblet Global"
// (Postgres shopify_store.store_name) collapse into one merchant. Without this,
// sheet-only disputes split off into orphan groups with N/A tier and 0% ratio.
function normalizeMerchantName(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/\.(io|com|co|net)\b/g, "") // genetra.io → genetra
    .replace(/\b(global|inc|corp|ltd|pvt|llc|fz-llc|fz)\b\.?/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Sheet rows that aren't real disputes — exclude from the dashboard so KPIs
// and per-merchant counts only reflect real disputes. Filters out:
//   - "Customer Acknowledged" / "to be taken down" notes (EFW that never escalated)
//   - "Cancelled" / "Canceled" status (proactively refunded / EFW pulled back)
//   - dispute_id is a charge ID ("ch_..." instead of "du_..." or a Tabby UUID)
//     → that's an Early Fraud Warning still pending conversion; not a real
//     dispute yet, so it doesn't belong on the dispute dashboard.
function isRealDispute(row: { status: string; disputeId: string }): boolean {
  const s = (row.status || "").toLowerCase().trim();
  if (s.includes("taken down")) return false;
  if (s.includes("customer acknowledged")) return false;
  if (s === "cancelled" || s === "canceled") return false;
  if ((row.disputeId || "").startsWith("ch_")) return false;
  return true;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main loader                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function getDisputeDashboardData(): Promise<DisputeDashboardData> {
  // 0. Sheet rows fetched in parallel with DB. Sheet read is best-effort —
  // dashboard still renders if Google Sheets API is unreachable.
  const sheetRowsPromise: Promise<SheetDisputeRow[]> = getDisputeTrackerSheet().catch((e) => {
    console.error("Dispute Tracker sheet read failed:", e);
    return [];
  });

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
    shopify_order_id: string | null;
    order_id: string | null;
    payment_gateway: string | null;
    dispute_fee_ledger_entry_id: string | null;
    updated_at: string;
  }>(
    `SELECT
       oi.dispute_id,
       m.id::text AS merchant_id,
       COALESCE(NULLIF(TRIM(ss.store_name), ''), m.name) AS merchant,
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
       oi.shopify_order_id,
       oi.order_id,
       oi.payment_gateway,
       oi.dispute_fee_ledger_entry_id,
       oi.updated_at::text AS updated_at
     FROM order_info oi
     JOIN merchant m ON m.id = oi.merchant_id
     LEFT JOIN shopify_store ss ON ss.merchant_id = m.id AND ss.deleted_at IS NULL
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

  // 3. Per-merchant order counts (excludes canceled/archived/draft, plus the
  // full test-data exclusion set from CLAUDE.md so the dispute-ratio
  // denominator isn't inflated by internal/QA/dev orders).
  //
  // Mirrors Awais's #wise-payouts unfulfilled-orders alert (m.is_test = false)
  // and additionally drops:
  //   - hardcoded test merchant IDs
  //   - merchant/store names matching test/qa/demo/sample/staging/claude
  //   - test customer emails (anything containing @test, or curtsoyaks@gmail.com)
  //     checked on BOTH the order's checkout email and the linked customer's email
  //   - test customer names (first_name or last_name = test/testing, case-insensitive)
  //     catches QA / dev orders that use real-looking emails but TEST as the name
  //
  // Exposes BOTH the displayed name (shopify_store override) and the raw
  // merchant.name so sheet entries can match either ("Zariin Jewelry" sheet
  // entry needs to match merchant.name even though display is "Zariin").
  const orderRows = await rawQuery<{
    merchant_id: string;
    merchant: string;
    raw_name: string;
    orders: string;
  }>(
    `SELECT m.id::text AS merchant_id,
            COALESCE(NULLIF(TRIM(ss.store_name), ''), m.name) AS merchant,
            m.name AS raw_name,
            COUNT(DISTINCT oi.order_id)::text AS orders
     FROM order_info oi
     JOIN merchant m ON m.id = oi.merchant_id
     LEFT JOIN shopify_store ss ON ss.merchant_id = m.id AND ss.deleted_at IS NULL
     JOIN merchant_merchant_order_order mmoo ON mmoo.order_id = oi.order_id
     JOIN "order" o ON o.id = mmoo.order_id
     LEFT JOIN customer c ON c.id = o.customer_id
     WHERE m.is_test = false
       AND m.id NOT IN ('01KHE4FRNNDDY6YBRZE28Q361S', '01K1G6CDB2EBVR31DS72Y4XYVX')
       AND m.name !~* '\\m(test|qa|demo|sample|staging|claude)\\M'
       AND COALESCE(ss.store_name, '') !~* '\\m(test|qa|demo|sample|staging|claude)\\M'
       AND oi.deleted_at IS NULL
       AND o.status NOT IN ('canceled', 'archived', 'draft')
       AND (o.email IS NULL OR (LOWER(o.email) NOT LIKE '%@test%' AND LOWER(o.email) <> 'curtsoyaks@gmail.com'))
       AND (c.email IS NULL OR (LOWER(c.email) NOT LIKE '%@test%' AND LOWER(c.email) <> 'curtsoyaks@gmail.com'))
       AND (c.first_name IS NULL OR LOWER(c.first_name) NOT IN ('test', 'testing'))
       AND (c.last_name IS NULL OR LOWER(c.last_name) NOT IN ('test', 'testing'))
       -- Per-merchant owner / family / internal-staff exclusion list.
       -- Orders placed by these emails at the named merchant are not real
       -- customer-facing transactions (merchant testing their own checkout,
       -- placing house orders, etc.) and would inflate the dispute-ratio
       -- denominator. Extend this list as more merchants surface — keep
       -- scoped by merchant name so we don't accidentally exclude real
       -- customers at other merchants who happen to share an email.
       AND NOT (
         m.name = 'Research Chemical'
         AND (
           LOWER(o.email) IN ('anweinbe@gmail.com', 'info@researchchemical.com')
           OR LOWER(c.email) IN ('anweinbe@gmail.com', 'info@researchchemical.com')
         )
       )
     GROUP BY m.id, m.name, ss.store_name`
  );
  const ordersByMerchant = new Map<string, { merchant: string; raw_name: string; orders: number }>();
  let totalOrders = 0;
  for (const r of orderRows) {
    const o = Number(r.orders || 0);
    ordersByMerchant.set(r.merchant_id, { merchant: r.merchant, raw_name: r.raw_name, orders: o });
    totalOrders += o;
  }

  // 3b. Resolve sheet read + index by dispute_id for fast merge.
  // Drop sheet rows that aren't real disputes (EFW flagged for removal, etc.)
  const rawSheetRows = await sheetRowsPromise;
  const sheetRows = rawSheetRows.filter((r) => isRealDispute(r));
  const sheetByDisputeId = new Map<string, SheetDisputeRow>();
  for (const s of sheetRows) {
    if (s.disputeId) sheetByDisputeId.set(s.disputeId.trim(), s);
  }

  // 3c. Build normalized-name → DB merchant lookup so sheet-only disputes
  // attach to the correct Postgres merchant (matching order count + ratio).
  // We index by BOTH the displayed name AND the raw merchant.name. The two
  // names diverge for several stores:
  //   - "Zariin" (display) / "Zariin Jewelry" (raw) — sheet has the raw
  //   - "Sage By Mala" (display) / "Earth Trend Fashions Pvt Ltd" (raw)
  //   - "Fizzy Goblet Global" (display) / "Fizzy Goblet" (raw)
  // The sheet uses the consumer-facing store name in some places and the
  // entity name in others, so accepting either makes the merge resilient.
  //
  // When multiple merchants normalize to the same key (e.g. "Genetra.io" and
  // "Genetra " both normalize to "genetra"), pick the one with the MOST orders.
  // Older / duplicate / stale merchant entries always have fewer orders, so
  // this naturally selects the live one without needing an explicit alias map.
  const dbMerchantsByNormName = new Map<
    string,
    { merchant_id: string; merchant: string; orders: number }
  >();
  const addAlias = (rawKey: string, merchant_id: string, displayName: string, orders: number) => {
    const key = normalizeMerchantName(rawKey);
    if (!key) return;
    const existing = dbMerchantsByNormName.get(key);
    if (!existing || orders > existing.orders) {
      dbMerchantsByNormName.set(key, { merchant_id, merchant: displayName, orders });
    }
  };
  for (const r of disputeRows) {
    const o = ordersByMerchant.get(r.merchant_id)?.orders ?? 0;
    addAlias(r.merchant, r.merchant_id, r.merchant, o);
  }
  // Also pull in every merchant with orders (may have no disputes yet).
  for (const [merchant_id, info] of ordersByMerchant.entries()) {
    addAlias(info.merchant, merchant_id, info.merchant, info.orders);
    addAlias(info.raw_name, merchant_id, info.merchant, info.orders);
  }

  // 3d. Live Stripe fetch for the real evidence_details.due_by on every Stripe
  // dispute we know about. We hit Stripe for:
  //   - DB rows with a du_… dispute_id but missing evidence_due_at (sync lag)
  //   - sheet-only rows with a du_… dispute_id (Stripe USA disputes that never
  //     land in order_info — without this, we'd display stale or manually-
  //     entered "bank decision" dates from the sheet instead of the authoritative
  //     evidence_due_by from Stripe).
  // The restricted keys are scoped to Disputes: Read on each Stripe account, so
  // calls without a charge expand are safe.
  const dbDisputeIdSet = new Set(disputeRows.map((r) => r.dispute_id));
  const stripeIdsToFetch = new Set<string>();
  for (const r of disputeRows) {
    if (r.dispute_id.startsWith("du_") && !r.evidence_due_at) {
      stripeIdsToFetch.add(r.dispute_id);
    }
  }
  for (const s of sheetRows) {
    if (
      s.disputeId.startsWith("du_") &&
      !dbDisputeIdSet.has(s.disputeId)
    ) {
      stripeIdsToFetch.add(s.disputeId);
    }
  }
  const stripeMeta = stripeIdsToFetch.size
    ? await fetchStripeDisputeMeta([...stripeIdsToFetch]).catch((e) => {
        console.error("Stripe disputes fetch failed:", e);
        return new Map();
      })
    : new Map();

  // 3e. Postgres customer-match: for every sheet dispute that's missing an
  // order_id in Postgres, try to find the actual order by customer email
  // (most reliable) or first+last name within the matched merchant. The match
  // gives us the canonical order_id AND backfills missing customer_email when
  // the sheet only had the name. One bulk query for the whole page.
  interface CustomerMatch {
    dispute_id: string;
    order_id: string;
    shopify_order_name: string | null;
    db_email: string | null;
    db_first_name: string | null;
    db_last_name: string | null;
  }
  const customerMatches = new Map<string, CustomerMatch>();
  {
    interface MatchInput {
      dispute_id: string;
      merchant_id: string;
      email: string;
      first_name: string;
      last_name: string;
      amount_cents: number;
      currency: string;
    }
    const inputs: MatchInput[] = [];
    for (const s of sheetRows) {
      if (!s.disputeId || dbDisputeIdSet.has(s.disputeId)) continue;
      const normKey = normalizeMerchantName(s.merchant);
      const dbMatch = normKey ? dbMerchantsByNormName.get(normKey) : null;
      if (!dbMatch) continue;
      const parsed = parseSheetCustomer(s.customer);
      const [first, ...rest] = parsed.name.split(/\s+/);
      const last = rest.join(" ");
      if (!parsed.email && !first) continue;
      inputs.push({
        dispute_id: s.disputeId,
        merchant_id: dbMatch.merchant_id,
        email: parsed.email,
        first_name: first || "",
        last_name: last || "",
        amount_cents: parseAmountToCents(s.amount),
        currency: (s.currency || "").toUpperCase(),
      });
    }
    if (inputs.length > 0) {
      const merchantIds = [...new Set(inputs.map((i) => i.merchant_id))];
      const emails = inputs.map((i) => i.email).filter(Boolean).map((e) => e.toLowerCase());
      const firstNames = inputs.map((i) => i.first_name).filter(Boolean).map((n) => n.toLowerCase());
      const lastNames = inputs.map((i) => i.last_name).filter(Boolean).map((n) => n.toLowerCase());
      // One query returns every order in those merchants whose customer matches
      // any input by email or by (first_name + last_name). Narrowed down in JS.
      const candidates = await rawQuery<{
        merchant_id: string;
        order_id: string;
        shopify_order_name: string | null;
        amount_cents: string | null;
        currency: string | null;
        order_email: string | null;
        customer_email: string | null;
        first_name: string | null;
        last_name: string | null;
      }>(
        `SELECT mmoo.merchant_id::text AS merchant_id,
                oi.order_id,
                oi.shopify_order_name,
                oi.transaction_amount_cents::text AS amount_cents,
                oi.transaction_currency AS currency,
                LOWER(o.email) AS order_email,
                LOWER(c.email) AS customer_email,
                LOWER(c.first_name) AS first_name,
                LOWER(c.last_name) AS last_name
         FROM merchant_merchant_order_order mmoo
         JOIN order_info oi ON oi.order_id = mmoo.order_id AND oi.deleted_at IS NULL
         LEFT JOIN "order" o ON o.id = mmoo.order_id
         LEFT JOIN customer c ON c.id = o.customer_id
         WHERE mmoo.merchant_id = ANY($1::varchar[])
           AND (
             LOWER(o.email) = ANY($2::text[])
             OR LOWER(c.email) = ANY($2::text[])
             OR (LOWER(c.first_name) = ANY($3::text[]) AND LOWER(c.last_name) = ANY($4::text[]))
           )`,
        [merchantIds, emails, firstNames, lastNames]
      );
      // Score each candidate against each input. Take the best match per dispute.
      for (const inp of inputs) {
        let best: { row: typeof candidates[0]; score: number } | null = null;
        for (const c of candidates) {
          if (c.merchant_id !== inp.merchant_id) continue;
          let score = 0;
          const inpEmail = inp.email.toLowerCase();
          if (inpEmail && (c.order_email === inpEmail || c.customer_email === inpEmail)) score += 100;
          if (
            inp.first_name &&
            inp.last_name &&
            c.first_name === inp.first_name.toLowerCase() &&
            c.last_name === inp.last_name.toLowerCase()
          ) {
            score += 50;
          }
          // Amount + currency boost — strong signal when the customer has many orders
          if (
            inp.amount_cents > 0 &&
            Number(c.amount_cents || 0) === inp.amount_cents &&
            (c.currency || "").toUpperCase() === inp.currency
          ) {
            score += 25;
          }
          if (score > 0 && (!best || score > best.score)) {
            best = { row: c, score };
          }
        }
        if (best) {
          customerMatches.set(inp.dispute_id, {
            dispute_id: inp.dispute_id,
            order_id: best.row.order_id,
            shopify_order_name: best.row.shopify_order_name,
            db_email: best.row.customer_email || best.row.order_email,
            db_first_name: best.row.first_name,
            db_last_name: best.row.last_name,
          });
        }
      }
    }
  }

  // 4. Build disputes array with provider + fee + sheet overlay
  // Sheet wins for status + notes; DB wins for amount/customer/deadline/order.
  // Fee captured rule: only count the $50 dispute fee on LOST disputes — Stripe
  // charges the fee at creation but refunds it on a win, so anything still in
  // open/won state isn't truly "captured" by Stripe yet.
  const disputes: DisputeRow[] = disputeRows.map((r) => {
    const sheet = sheetByDisputeId.get(r.dispute_id);
    const match = customerMatches.get(r.dispute_id);
    // Parse the sheet's customer field — handles "Name (email)" style. Sheet
    // values are proper-case (human-curated) so we prefer them over the
    // lowercased DB values.
    const sheetParsed = parseSheetCustomer(sheet?.customer || "");
    const dbName =
      [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ") || null;
    const customerName = sheetParsed.name || dbName;
    const customerEmail =
      r.customer_email ||
      sheetParsed.email ||
      match?.db_email ||
      null;
    // Sheet status wins if present, falls back to DB.
    const rawStatus = (sheet?.status && sheet.status.trim()) || r.status || "open";
    const status = rawStatus.toLowerCase();
    const bucket = statusBucket(rawStatus);
    const fee_usd_cents = bucket === "lost" && r.dispute_fee_ledger_entry_id
      ? feeById.get(r.dispute_fee_ledger_entry_id) ?? 5000
      : 0;
    // Fall back to sheet values for any field the DB has as null/empty.
    // Stripe USA disputes often sync into order_info with sparse data
    // (no transaction_amount_cents, no dispute_processed_at, no email) —
    // the sheet has the human-curated values, so prefer them when DB is empty.
    const dbAmount = Number(r.amount_cents || 0);
    const amount_cents = dbAmount > 0 ? dbAmount : parseAmountToCents(sheet?.amount || "");
    const currency = (r.currency && r.currency.trim()) || sheet?.currency || "USD";
    const created_at = r.created_at || parseSheetDate(sheet?.date || "");
    const providerName = (sheet?.provider as ProviderName) || classifyProvider(r.dispute_id);
    // Deadline precedence:
    //   1. Postgres dispute_evidence_due_at (synced from Stripe, source of truth)
    //   2. Live Stripe API (for brand-new disputes Postgres hasn't synced yet)
    //   3. Sheet's parsed deadline (manual Tabby/Tamara entries)
    //   4. Tabby/Tamara 14-day SLA, or EFW (ch_… ID) 14-day response window
    const stripeLive = stripeMeta.get(r.dispute_id);
    let evidence_due_at =
      r.evidence_due_at ||
      stripeLive?.evidence_due_at ||
      parseSheetDate(sheet?.deadline || "");
    if (!evidence_due_at && created_at && SLA_DAYS[providerName]) {
      evidence_due_at = addDays(created_at, SLA_DAYS[providerName]);
    }
    // Keep the raw sheet deadline text only if we still couldn't derive a date
    // AND the text looks like real free-form deadline info (not a placeholder
    // like "Not yet converted to formal dispute" or "N/A"). Otherwise display
    // an em-dash, which is cleaner than leaking ops notes into the date column.
    const rawDeadlineSheet = (sheet?.deadline || "").trim();
    const deadline_text =
      !evidence_due_at && rawDeadlineSheet && !isDeadlinePlaceholder(rawDeadlineSheet)
        ? rawDeadlineSheet
        : "";
    // Order ID precedence: DB order_id → Postgres customer-match → sheet col N
    // (manual entry) → null.
    const order_id = r.order_id || match?.order_id || sheet?.orderId || null;
    return {
      dispute_id: r.dispute_id,
      provider: providerName,
      merchant_id: r.merchant_id,
      merchant: r.merchant,
      customer_name: customerName,
      customer_email: customerEmail,
      status,
      bucket,
      amount_cents,
      currency,
      created_at,
      evidence_due_at,
      deadline_text,
      resolved_at: r.resolved_at,
      shopify_order_name: r.shopify_order_name,
      shopify_order_id: r.shopify_order_id,
      order_id,
      payment_gateway: r.payment_gateway,
      fee_usd_cents,
      internal_notes: sheet?.notes || "",
      reason: sheet?.reason || "",
      sheet_row: sheet?.rowNumber ?? null,
      is_manual: false,
    };
  });

  // 4b. Sheet-only disputes (manual entries for Tabby/Tamara/Stripe-USA where
  // there's no Postgres counterpart). These come purely from the sheet.
  const dbDisputeIds = new Set(disputeRows.map((r) => r.dispute_id));
  for (const s of sheetRows) {
    if (!s.disputeId || dbDisputeIds.has(s.disputeId)) continue;
    const status = (s.status || "open").toLowerCase();
    const bucket = statusBucket(s.status);
    const fee_usd_cents = bucket === "lost" ? 5000 : 0;
    // Resolve to a real DB merchant by normalized name so this dispute's
    // ratio + tier picks up the merchant's actual order count from Postgres.
    const normKey = normalizeMerchantName(s.merchant);
    const dbMatch = normKey ? dbMerchantsByNormName.get(normKey) : null;
    const provider = (s.provider as ProviderName) || "Unknown";
    const createdIso = parseSheetDate(s.date);
    // For Stripe disputes (du_…) the API is the source of truth; override any
    // manual sheet entry. Sheet sometimes carries "bank decision expected by"
    // dates which differ from Stripe's authoritative evidence_due_by.
    const stripeLiveSheet = stripeMeta.get(s.disputeId);
    let dueAt = stripeLiveSheet?.evidence_due_at || parseSheetDate(s.deadline);
    if (!dueAt && createdIso && SLA_DAYS[provider]) {
      dueAt = addDays(createdIso, SLA_DAYS[provider]);
    }
    // Parse the sheet's customer cell into clean name + email pieces, then
    // overlay anything we learned from the Postgres customer-match lookup.
    const sheetParsed = parseSheetCustomer(s.customer);
    const match = customerMatches.get(s.disputeId);
    disputes.push({
      dispute_id: s.disputeId,
      provider,
      merchant_id: dbMatch?.merchant_id ?? `manual:${normKey || s.merchant}`,
      merchant: dbMatch?.merchant ?? (s.merchant || "Unknown"),
      customer_name: sheetParsed.name || s.customer || null,
      customer_email: sheetParsed.email || match?.db_email || null,
      status,
      bucket,
      amount_cents: parseAmountToCents(s.amount),
      currency: s.currency || "USD",
      created_at: createdIso,
      evidence_due_at: dueAt,
      deadline_text:
        !dueAt && s.deadline && s.deadline.trim() && !isDeadlinePlaceholder(s.deadline)
          ? s.deadline.trim()
          : "",
      resolved_at: null,
      shopify_order_name: match?.shopify_order_name ?? null,
      shopify_order_id: null,
      order_id: match?.order_id ?? s.orderId ?? null,
      payment_gateway: null,
      fee_usd_cents,
      internal_notes: s.notes || "",
      reason: s.reason || "",
      sheet_row: s.rowNumber,
      is_manual: true,
    });
  }
  // Sort by created_at desc so newest disputes float to the top.
  disputes.sort((a, b) => {
    if (!a.created_at && !b.created_at) return 0;
    if (!a.created_at) return 1;
    if (!b.created_at) return -1;
    return b.created_at.localeCompare(a.created_at);
  });

  // 5. Per-merchant aggregation (canonical buckets)
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
    if (d.bucket === "lost") row.lost += 1;
    else if (d.bucket === "won") row.won += 1;
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

  // 6. Status + provider breakdowns (canonical buckets so chart slices = KPI counts)
  const byStatusMap = new Map<string, number>();
  const byProviderMap = new Map<string, number>();
  for (const d of disputes) {
    byStatusMap.set(d.bucket, (byStatusMap.get(d.bucket) ?? 0) + 1);
    byProviderMap.set(d.provider, (byProviderMap.get(d.provider) ?? 0) + 1);
  }
  const byStatus = Array.from(byStatusMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
  const byProvider = Array.from(byProviderMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // 7. Totals — canonical buckets
  const totalDisputes = disputes.length;
  const openDisputes = disputes.filter((d) => d.bucket === "open").length;
  const lostDisputes = disputes.filter((d) => d.bucket === "lost").length;
  const wonDisputes = disputes.filter((d) => d.bucket === "won").length;
  const totalFeesUsdCents = disputes.reduce((s, d) => s + d.fee_usd_cents, 0);
  const companyRatioPct = totalOrders > 0 ? (totalDisputes / totalOrders) * 100 : 0;

  // 8. Last synced at = max updated_at across dispute rows
  const lastSyncedAt = disputeRows
    .map((r) => r.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  // 9. Every non-test merchant (for the Add Dispute dropdown). Uses the same
  // shopify_store override pattern so the displayed name matches the rest of
  // the dashboard. Filters out internal/test merchants that slipped past the
  // is_test flag (names containing "test", "qa", "demo", "sample", "staging").
  const merchantRows = await rawQuery<{ id: string; name: string }>(
    `SELECT m.id::text AS id,
            COALESCE(NULLIF(TRIM(ss.store_name), ''), m.name) AS name
     FROM merchant m
     LEFT JOIN shopify_store ss ON ss.merchant_id = m.id AND ss.deleted_at IS NULL
     WHERE m.is_test = false
       AND m.name !~* '\\m(test|qa|demo|sample|staging|claude)\\M'
       AND COALESCE(ss.store_name, '') !~* '\\m(test|qa|demo|sample|staging|claude)\\M'
     ORDER BY name ASC`
  );
  // Deduplicate (a merchant can have multiple stores → multiple rows after join)
  const allMerchantsMap = new Map<string, { id: string; name: string }>();
  for (const r of merchantRows) {
    const trimmed = (r.name || "").trim();
    if (!trimmed) continue;
    if (!allMerchantsMap.has(trimmed)) allMerchantsMap.set(trimmed, { id: r.id, name: trimmed });
  }
  const allMerchants = Array.from(allMerchantsMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );

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
    allMerchants,
  };
}
