# SA Dispute Tracker

A self-contained dispute dashboard for SellAbroad — sources every metric **directly
from production Postgres**. No Google Sheets dependency, no manual entry, no Stripe
API call at request time.

## What it shows

- Total / open / lost / won dispute counts
- Total orders + company-wide dispute ratio
- Status breakdown (donut)
- Provider breakdown — Stripe UAE / Stripe Inc / Tabby/Tamara (bar)
- Per-merchant health table with off-board / candidate / nudge / healthy tiers
- Full dispute log with status filters
- Per-dispute detail modal with deep-link to the right Stripe account
- Per-merchant detail modal with all related disputes
- Manual "Refresh" button (page reload — DB is read fresh on every load)

## Data sources (read-only)

| Field | Source |
|---|---|
| Disputes | `order_info.dispute_id IS NOT NULL` |
| Status | `order_info.dispute_status` |
| Created / deadline / resolved | `order_info.dispute_processed_at` / `_evidence_due_at` / `_resolved_at` |
| Amount + currency | `order_info.transaction_amount_cents` + `_currency` |
| Customer | `order` + `customer` joined via `merchant_merchant_order_order` |
| $50 fees | `ledger_entry` row pointed to by `order_info.dispute_fee_ledger_entry_id` |
| Order count (denominator) | `order_info` ⨝ `order` excluding canceled/archived/draft |
| Provider | derived from `dispute_id` format: `du_…I2yvKfCFUI` = Stripe UAE, `du_…GT489qrT5g` = Stripe Inc, UUID = Tabby/Tamara |

**No new tables. No new columns.**

## Running locally

1. Copy `.env.example` to `.env.local` and set `DATABASE_URL` to the Postgres
   production connection string.
2. Install + start:

```bash
npm install
npm run dev
```

3. Open http://localhost:3000.

## Deploying to Vercel

```bash
vercel --prod --yes
```

Set `DATABASE_URL` in the Vercel project's Environment Variables.

## Tier thresholds

- ≥ 1.5% → **OFF-BOARD**
- ≥ 1.0% → **CANDIDATE**
- ≥ 0.5% → **NUDGE**
- &lt; 0.5% → **HEALTHY**
- &lt; 5 orders → **N/A** (too small a sample)

## Known data gaps (Postgres-side)

These will be visible as missing rows on the dashboard until a tech fix lands:

1. **`dispute.updated` webhooks don't update `order_info.dispute_status`** — Stripe disputes that move from `open` → `under_review` / `won` / `lost` are not reflected in Postgres until the next manual update.
2. **Stripe USA blocked-account disputes** — webhooks land unverified and skip DB writes (per Slack alert *"No ledger debit or order_info update was performed."*). Those disputes never make it into `order_info`.
3. **`dispute_evidence_due_at` is NULL** for most rows — `dispute.created` payload doesn't always carry the deadline.

When tech wires up the missing webhook handlers, the dashboard will pick them up automatically with no code change.
