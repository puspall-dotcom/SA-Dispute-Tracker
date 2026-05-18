// Live Stripe dispute fetcher — used to fill in evidence_due_at for disputes
// where Postgres hasn't synced the deadline yet (new disputes typically take a
// few hours to flow into order_info). Each restricted key has scope = Disputes:
// Read on exactly one Stripe account, so we route by dispute_id substring.

const UAE_KEY = process.env.STRIPE_RK_UAE;
const USA_KEY = process.env.STRIPE_RK_USA;

// Pick the right restricted key based on which Stripe account holds the charge.
// du_..I2yvKfCFUI... = SellAbroad (UAE, acct_1RWHSEI2yvKfCFUI)
// everything else with du_                = SellAbroad Inc. (USA, acct_1SbzBXGT489qrT5g)
function keyFor(disputeId: string): string | undefined {
  if (!disputeId.startsWith("du_")) return undefined;
  return disputeId.includes("I2yvKfCFUI") ? UAE_KEY : USA_KEY;
}

export interface StripeDisputeMeta {
  evidence_due_at: string | null;   // yyyy-mm-dd
  resolved_at: string | null;       // yyyy-mm-dd
  status: string | null;            // raw Stripe status (needs_response, under_review, won, lost, …)
}

interface StripeDispute {
  status?: string;
  created?: number;
  evidence_details?: { due_by?: number };
}

const toIsoDate = (unix: number | null | undefined): string | null => {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString().slice(0, 10);
};

// Fetch one dispute. Returns null on any error (missing key, 404, network) —
// callers fall back to the existing deadline source.
async function fetchOne(disputeId: string): Promise<StripeDisputeMeta | null> {
  const key = keyFor(disputeId);
  if (!key) return null;
  try {
    const res = await fetch(`https://api.stripe.com/v1/disputes/${encodeURIComponent(disputeId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      // Force-revalidate so we always see fresh due_by (Stripe occasionally
      // bumps it when a chargeback enters a new sub-state).
      cache: "no-store",
    });
    if (!res.ok) return null;
    const d: StripeDispute = await res.json();
    return {
      evidence_due_at: toIsoDate(d.evidence_details?.due_by),
      resolved_at: null,            // Stripe doesn't surface resolved_at directly; left null
      status: d.status ?? null,
    };
  } catch {
    return null;
  }
}

// Batch fetch in parallel. Returns map keyed by dispute_id (only successful
// fetches are included). Capped at 50 concurrent requests to be polite.
export async function fetchStripeDisputeMeta(
  disputeIds: string[]
): Promise<Map<string, StripeDisputeMeta>> {
  const out = new Map<string, StripeDisputeMeta>();
  if (!UAE_KEY && !USA_KEY) return out;
  const unique = [...new Set(disputeIds.filter((id) => id?.startsWith("du_")))];
  const results = await Promise.all(unique.map((id) => fetchOne(id).then((m) => [id, m] as const)));
  for (const [id, m] of results) {
    if (m) out.set(id, m);
  }
  return out;
}
