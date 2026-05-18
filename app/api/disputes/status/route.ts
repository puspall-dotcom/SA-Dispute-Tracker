import { NextResponse } from "next/server";
import { setDisputeStatus } from "@/lib/sheets/dispute-tracker";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      disputeId?: string;
      status?: string;
      fallback?: { provider?: string; merchant?: string; customer?: string };
    };
    const disputeId = body.disputeId?.trim();
    const status = body.status?.trim();
    if (!disputeId || !status) {
      return NextResponse.json(
        { error: "disputeId and status are required" },
        { status: 400 }
      );
    }
    const result = await setDisputeStatus(disputeId, status, body.fallback);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
