import { NextResponse } from "next/server";
import { cb } from "@/lib/coinbase/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const productType = (url.searchParams.get("product_type") ?? undefined) as "SPOT" | "FUTURE" | undefined;
  try {
    const data = await cb.listProducts({ limit, product_type: productType });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
