import { NextResponse } from "next/server";
import { listAgents } from "@/lib/db/queries";

export async function GET() {
  return NextResponse.json(listAgents());
}
