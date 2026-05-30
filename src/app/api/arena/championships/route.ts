import { NextResponse } from "next/server";
import { listEligibleChampionships } from "@/lib/arena/championship";
import { listChampionships } from "@/lib/arena/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const onlyEligible = url.searchParams.get("eligible") === "1";
  if (onlyEligible) return NextResponse.json({ championships: listEligibleChampionships() });
  return NextResponse.json({ championships: listChampionships(50) });
}
