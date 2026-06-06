import "./_env.ts";
import { authIsAvailable, getOAuthClient } from "../src/lib/anthropic/auth.ts";
console.log("authIsAvailable:", authIsAvailable());
if (authIsAvailable()) {
  try {
    const c = await getOAuthClient();
    const r = await c.messages.create({ model: "claude-haiku-4-5", max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly one word: ALIVE" }] } as any);
    const t = (r.content as Array<{type:string;text?:string}>).find(b=>b.type==="text")?.text;
    console.log("haiku replied:", JSON.stringify(t));
  } catch (e) { console.log("haiku call FAILED:", (e as Error).message.slice(0,160)); }
}
