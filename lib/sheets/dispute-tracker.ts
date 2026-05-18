import { readRange, sheetsClient } from "./client";

const ID = process.env.CONTROL_CENTRE_SHEET_ID || "";
const SHEET = "Dispute Tracker";

export interface SheetDisputeRow {
  rowNumber: number;
  date: string;
  provider: string;
  merchant: string;
  disputeId: string;
  customer: string;
  reason: string;
  status: string;
  amount: string;
  currency: string;
  deadline: string;
  daysLeft: string;
  notes: string;
  lastUpdated: string;
  orderId: string;   // col N — added for manually-added disputes
}

// Normalise the raw provider string into one of the canonical processor names.
// Stripe CA is routed to the actual Stripe account that holds the charge,
// determined by the dispute ID prefix.
function normalizeProvider(raw: string, disputeId: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/stripe\s*ca\b|stripe\s*canada/i.test(s)) {
    if (disputeId.includes("I2yvKfCFUI")) return "Stripe UAE";
    return "Stripe USA";
  }
  return s;
}

export async function getDisputeTrackerSheet(): Promise<SheetDisputeRow[]> {
  if (!ID) return [];
  const rows = await readRange(ID, `${SHEET}!A3:N500`);
  return rows
    .map((r, idx) => {
      let merchant = (r[2] || "").trim();
      const disputeId = (r[3] || "").trim();
      const provider = normalizeProvider(r[1] || "", disputeId);
      if (!merchant && /tamara/i.test(provider)) merchant = "Scarters";
      if (!merchant) merchant = "Unknown";
      return {
        rowNumber: 3 + idx,
        date: r[0] || "",
        provider,
        merchant,
        disputeId,
        customer: r[4] || "",
        reason: r[5] || "",
        status: r[6] || "",
        amount: r[7] || "",
        currency: r[8] || "",
        deadline: r[9] || "",
        daysLeft: r[10] || "",
        notes: r[11] || "",
        lastUpdated: r[12] || "",
        orderId: r[13] || "",
      };
    })
    .filter((r) => r.disputeId !== "");
}

const today = () =>
  new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

/**
 * Write the internal notes (col L) for a dispute by ID. Replaces existing notes
 * — this is the editable field surfaced in the dashboard's note editor.
 */
export async function updateDisputeNotes(disputeId: string, notes: string): Promise<boolean> {
  if (!ID) throw new Error("CONTROL_CENTRE_SHEET_ID not configured");
  const sheets = sheetsClient();
  const rows = await getDisputeTrackerSheet();
  const target = rows.find((r) => r.disputeId === disputeId.trim());
  if (!target) return false;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `${SHEET}!L${target.rowNumber}`, values: [[notes]] },
        { range: `${SHEET}!M${target.rowNumber}`, values: [[today()]] },
      ],
    },
  });
  return true;
}

export interface NewDisputeInput {
  date?: string;
  provider: string;
  merchant: string;
  disputeId: string;
  customer?: string;
  reason?: string;
  status?: string;
  amount?: string;
  currency?: string;
  deadline?: string;
  notes?: string;
  orderId?: string;
}

/**
 * Update or insert a dispute's status (col G) by ID. If the dispute isn't yet
 * in the sheet (DB-only dispute) we append a minimal row so the new status
 * sticks across page reloads.
 */
export async function setDisputeStatus(
  disputeId: string,
  newStatus: string,
  fallback?: { provider?: string; merchant?: string; customer?: string }
): Promise<{ updated: boolean; appended: boolean }> {
  if (!ID) throw new Error("CONTROL_CENTRE_SHEET_ID not configured");
  const sheets = sheetsClient();
  const rows = await getDisputeTrackerSheet();
  const target = rows.find((r) => r.disputeId === disputeId.trim());
  if (target) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: `${SHEET}!G${target.rowNumber}`, values: [[newStatus]] },
          { range: `${SHEET}!M${target.rowNumber}`, values: [[today()]] },
        ],
      },
    });
    return { updated: true, appended: false };
  }
  // No existing sheet row → append minimal placeholder so the override sticks.
  await appendDispute({
    provider: fallback?.provider || "Unknown",
    merchant: fallback?.merchant || "Unknown",
    disputeId,
    customer: fallback?.customer,
    status: newStatus,
  });
  return { updated: false, appended: true };
}

/**
 * Append a manually-entered dispute to the Dispute Tracker sheet.
 * Used for Tabby/Tamara/Stripe USA where MCP/DB integration isn't available.
 */
export async function appendDispute(d: NewDisputeInput): Promise<void> {
  if (!ID) throw new Error("CONTROL_CENTRE_SHEET_ID not configured");
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: ID,
    range: `${SHEET}!A:N`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          d.date || today(),
          d.provider,
          d.merchant,
          d.disputeId,
          d.customer || "",
          d.reason || "",
          d.status || "New",
          d.amount || "",
          d.currency || "USD",
          d.deadline || "",
          "",
          d.notes || "",
          today(),
          d.orderId || "",
        ],
      ],
    },
  });
}
