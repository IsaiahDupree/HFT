import "./_env.ts";
import { authIsAvailable, authStatus, getOAuthClient } from "../src/lib/anthropic/auth.ts";

async function main() {
  console.log("authIsAvailable():", authIsAvailable());
  console.log("authStatus():", JSON.stringify(authStatus(), null, 2));
  if (!authIsAvailable()) {
    console.log("No auth — cannot test API call.");
    process.exit(1);
  }
  try {
    const client = await getOAuthClient();
    console.log("Making test API call...");
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 30,
      messages: [{ role: "user", content: "Say 'oracle is alive' and nothing else." }],
    });
    const text = resp.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
    console.log("Response:", text);
    console.log("Usage:", JSON.stringify(resp.usage));
  } catch (e) {
    console.log("Call failed:", (e as Error).message);
    if ((e as { status?: number }).status) console.log("status:", (e as { status: number }).status);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
