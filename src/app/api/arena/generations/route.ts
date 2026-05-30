import { NextResponse } from "next/server";
import { listGenerations } from "@/lib/arena/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ generations: listGenerations(50) });
}
