import { NextResponse } from "next/server";
import { poly } from "@/lib/polymarket/client";

export async function GET() {
  try {
    const data = await poly.samplingMarkets(20);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
