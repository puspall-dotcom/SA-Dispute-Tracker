import { getDisputeDashboardData } from "@/lib/db/queries";
import { DisputeTrackerClient } from "./client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DisputeTrackerPage() {
  const data = await getDisputeDashboardData();
  return <DisputeTrackerClient data={data} />;
}
