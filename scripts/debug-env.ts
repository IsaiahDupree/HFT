import "./_env";
console.log("POLYMARKET_SIGNATURE_TYPE raw:", JSON.stringify(process.env.POLYMARKET_SIGNATURE_TYPE));
console.log("Number cast:", Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "1"));
console.log("FUNDER:", process.env.POLYMARKET_FUNDER_ADDRESS);
console.log("RELAYER ADDR:", process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS);
