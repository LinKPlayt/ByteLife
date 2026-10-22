// Finds or creates the D1 database and KV namespace on your Cloudflare account,
// then writes their IDs into wrangler.toml. Used by the GitHub Action before deploying.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const D1_NAME = "social-hub";
const KV_NAME = "social-hub-media";

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
// Wrangler can print warnings (which contain brackets) before the JSON
function parseJson(out) {
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[[{]/.test(lines[i])) continue;
    try { return JSON.parse(lines.slice(i).join("\n")); } catch (e) { /* not the JSON yet */ }
  }
  throw new Error("Couldn't read wrangler output:\n" + out);
}

function d1Id() {
  const find = () => parseJson(wrangler("d1", "list", "--json")).find((d) => d.name === D1_NAME);
  let db = find();
  if (!db) { console.log(`Creating D1 database ${D1_NAME}`); wrangler("d1", "create", D1_NAME); db = find(); }
  return db.uuid;
}

function kvId() {
  const find = () => parseJson(wrangler("kv", "namespace", "list")).find((n) => n.title === KV_NAME || n.title.endsWith(`-${KV_NAME}`));
  let ns = find();
  if (!ns) { console.log(`Creating KV namespace ${KV_NAME}`); wrangler("kv", "namespace", "create", KV_NAME); ns = find(); }
  return ns.id;
}

const toml = readFileSync("wrangler.toml", "utf8");
const d1 = d1Id(), kv = kvId();
writeFileSync("wrangler.toml", toml.replace("__D1_ID__", d1).replace("__KV_ID__", kv));
console.log(`D1 ${d1}, KV ${kv}`);
