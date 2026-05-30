import "./_env.ts";
import { authIsAvailable, authStatus, getOAuthClient } from "../src/lib/anthropic/auth.ts";

(async () => {
  console.log("Auth status:", authStatus());
  console.log("Auth available:", authIsAvailable());
  console.log("\nGetting client...");
  const client = await getOAuthClient();
  console.log("Client OK. Tiny test call to claude-haiku-4-5...\n");
  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 50,
      messages: [{ role: "user", content: "In exactly 5 words: confirm OAuth works." }],
    });
    const text = (resp.content.find((b: any) => b.type === "text") as any)?.text;
    console.log("Response:", text);
    console.log("Tokens — in:", resp.usage.input_tokens, "out:", resp.usage.output_tokens);
    console.log("\nOAuth integration: WORKING.");
  } catch (e: any) {
    console.error("CALL FAILED:", e.message);
    if (e.status) console.error("HTTP status:", e.status);
    process.exit(1);
  }
})();
