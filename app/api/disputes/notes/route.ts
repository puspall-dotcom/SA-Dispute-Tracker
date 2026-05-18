import { NextResponse } from "next/server";
import { updateDisputeNotes } from "@/lib/sheets/dispute-tracker";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as { disputeId?: string; notes?: string };
    const disputeId = body.disputeId?.trim();
    if (!disputeId) {
      return NextResponse.json({ error: "disputeId required" }, { status: 400 });
    }
    const notes = (body.notes ?? "").toString();
    const ok = await updateDisputeNotes(disputeId, notes);
    if (!ok) {
      return NextResponse.json(
        { error: "dispute not found in sheet" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
