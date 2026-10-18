import "./_env";
import { runAutoPromote } from "../src/lib/arena/auto-promote";

const r = runAutoPromote();
console.log(JSON.stringify(r, null, 2));
