import { NextResponse } from "next/server";
import { z } from "zod";
import { insertResearchNote, listResearchNotes } from "@/lib/db/queries";

const noteSchema = z.object({
  agent_id: z.number().int().optional(),
  strategy_id: z.number().int().optional(),
  market_condition_id: z.string().optional(),
  topic: z.string().min(1),
  body: z.string().min(1),
  source_urls: z.array(z.string().url()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

export async function GET() {
  return NextResponse.json(listResearchNotes(200));
}

export async function POST(req: Request) {
  const parsed = noteSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const n = parsed.data;
  const result = insertResearchNote({
    agent_id: n.agent_id,
    strategy_id: n.strategy_id,
    market_condition_id: n.market_condition_id,
    topic: n.topic,
    body: n.body,
    source_urls_json: JSON.stringify(n.source_urls ?? []),
    confidence: n.confidence,
    tags_json: JSON.stringify(n.tags ?? []),
  });
  return NextResponse.json({ id: result.lastInsertRowid });
}
