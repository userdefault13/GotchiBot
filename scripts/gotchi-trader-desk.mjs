#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URL = process.env.GOTCHIBOT_TRADER_URL || "http://127.0.0.1:4000";
const Q = "query{paperCronSummary{status lastRunAt totalFills skippedFills realizedPnlUsdc openMarkPnlUsdc quoteBackedPct ethBetaWarning bots{strategyId realizedPnlUsdc roundTrips pnlUsdc}}}";
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const cmd = argv.find((a) => ["monitor","improve","news"].includes(a)) || "monitor";
const host = argv.includes("--host") || argv.includes("imac") ? "imac" : "auto";
function remoteGet(path) {
  const r = spawnSync(process.execPath, [ROOT + "/scripts/remote-ssh.mjs", "--", "curl", "-sS", "-m", "12", URL + path], { encoding: "utf8", cwd: ROOT });
  return r.stdout || r.stderr || "";
}
function remotePost(path, body) {
  const b64 = Buffer.from(body).toString("base64");
  const sh = `echo ${b64} | base64 -d | curl -sS -m 12 -H content-type:application/json -H x-apollo-operation-name:PaperCron --data-binary @- ${URL}${path}`;
  const r = spawnSync(process.execPath, [ROOT + "/scripts/remote-ssh.mjs", "--", sh], { encoding: "utf8", cwd: ROOT });
  return r.stdout || r.stderr || "";
}
async function news() {
  const feeds = ["https://www.coindesk.com/arc/outboundfeeds/rss/","https://cointelegraph.com/rss","https://decrypt.co/feed"];
  const keys = /eth|bitcoin|btc|aave|uniswap|chainlink|sec|etf|hack|exploit/i;
  const items = [];
  for (const f of feeds) { try { const t = await (await fetch(f)).text(); for (const b of t.split(/<item/i).slice(1, 8)) { const title = (b.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i)||[])[1]||""; const clean = title.replace(/<[^>]+>/g,"").trim(); if (clean && keys.test(clean)) items.push(clean); } } catch {} }
  const blob = items.join(" ").toLowerCase();
  const regime = /hack|exploit|sec sues|halt/.test(blob) ? "risk-off" : /etf inflow|etf approved/.test(blob) ? "risk-on" : "neutral";
  return { regime, items: [...new Set(items)].slice(0, 8) };
}
const newsOut = cmd === "news" ? await news() : null;
if (cmd === "news") { if (json) console.log(JSON.stringify(newsOut)); else { console.log("regime " + newsOut.regime); for (const i of newsOut.items) console.log("- " + i); } process.exit(0); }
let use = host;
if (use === "auto") { try { const h = JSON.parse(await (await fetch(URL + "/health")).text()); use = h.ok ? "local" : "imac"; } catch { use = "imac"; } }
const healthTxt = use === "imac" ? remoteGet("/health") : await (await fetch(URL + "/health")).text();
let healthOk = false; try { healthOk = JSON.parse(healthTxt).ok === true; } catch {}
const gqlBody = JSON.stringify({ query: Q });
const gqlTxt = use === "imac" ? remotePost("/graphql", gqlBody) : await (await fetch(URL + "/graphql", { method: "POST", headers: { "content-type": "application/json", "x-apollo-operation-name": "PaperCron" }, body: gqlBody })).text();
let s = null; try { s = JSON.parse(gqlTxt).data.paperCronSummary; } catch {}
const alerts = [];
if (!healthOk) alerts.push("API down");
if (s && s.lastRunAt && (Date.now() - new Date(s.lastRunAt).getTime()) / 36e5 > 26) alerts.push("cron stale");
if (s && s.ethBetaWarning) alerts.push(s.ethBetaWarning);
if (cmd === "improve" && s) {
  const rec = (s.bots || []).map((b) => { const trips = b.roundTrips || 0, real = b.realizedPnlUsdc || 0; let action = "hold"; if (trips >= 3 && real < 0) action = "cut"; if (trips >= 3 && real > 0) action = "add"; if (trips === 0) action = "hold-unproven"; return { strategyId: b.strategyId, trips, real, action }; });
  mkdirSync(ROOT + "/sessions", { recursive: true });
  writeFileSync(ROOT + "/sessions/.trader-improve.json", JSON.stringify({ at: new Date().toISOString(), rec }, null, 2));
  if (json) console.log(JSON.stringify({ healthOk, summary: s, rec })); else rec.forEach((r) => console.log(r.action + " " + r.strategyId));
  process.exit(0);
}
if (json) console.log(JSON.stringify({ healthOk, host: use, summary: s, alerts }));
else { console.log("health " + (healthOk ? "ok" : "DOWN") + " host " + use); if (s) console.log("realized " + s.realizedPnlUsdc + " mark " + s.openMarkPnlUsdc + " qb " + s.quoteBackedPct + "%"); for (const a of alerts) console.log("ALERT " + a); if (!alerts.length) console.log("READY"); }
process.exit(healthOk && !alerts.includes("API down") ? 0 : 1);
