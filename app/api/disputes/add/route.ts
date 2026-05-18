import { NextResponse } from "next/server";
import { appendDispute, type NewDisputeInput } from "@/lib/sheets/dispute-tracker";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<NewDisputeInput>;
    if (!body.provider || !body.merchant || !body.disputeId) {
      return NextResponse.json(
        { error: "provider, merchant, and disputeId are required" },
        { status: 400 }
      );
    }
    await appendDispute({
      date: body.date,
      provider: body.provider,
      merchant: body.merchant,
      disputeId: body.disputeId,
      customer: body.customer,
      reason: body.reason,
      status: body.status,
      amount: body.amount,
      currency: body.currency,
      deadline: body.deadline,
      notes: body.notes,
      orderId: body.orderId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
