import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Surfaces the last endpoint-sweep result so the UI can show "what's working".
export async function GET() {
  try {
    const raw = await readFile(resolve(process.cwd(), "docs/test-results.json"), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message, hint: "Run `npm run test:endpoints` first" }, { status: 404 });
  }
}
