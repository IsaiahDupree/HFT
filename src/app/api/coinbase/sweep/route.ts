import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const raw = await readFile(resolve(process.cwd(), "docs/coinbase-test-results.json"), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, hint: "Run `npm run test:coinbase` first" },
      { status: 404 },
    );
  }
}
