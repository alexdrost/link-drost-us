#!/usr/bin/env node
// Validates the link table, the retired ledger and the static pages.
// Exit 0 = safe to deploy, exit 1 = don't.
//
//   node tools/qa.mjs           structural, ledger and static checks
//   node tools/qa.mjs --links   …plus a live check of every target URL

import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOST, RESERVED, SLUG_RE, isOwnDomain } from "../src/shared.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECK_LINKS = process.argv.includes("--links");

const failures = [];
const warnings = [];
const fail = (m) => failures.push(m);
const warn = (m) => warnings.push(m);

async function loadJson(rel) {
  try { return JSON.parse(await readFile(ROOT + rel, "utf8")); }
  catch (e) { fail(`${rel}: ${e.code === "ENOENT" ? "missing" : "does not parse — " + e.message}`); return null; }
}

// --- Structural -------------------------------------------------------------

const data = await loadJson("data/links.json");
const links = data?.links;
let active = 0, retired = 0;

if (data) {
  if (typeof data.generated !== "string" || data.source !== "notion" || typeof data.count !== "object")
    fail("links.json: missing generated / source / count");
  if (!links || typeof links !== "object" || Array.isArray(links)) fail("links.json: links must be an object");
}

if (links && typeof links === "object") {
  const lower = new Set();
  for (const [slug, l] of Object.entries(links)) {
    if (!SLUG_RE.test(slug)) fail(`${slug}: slug does not match ${SLUG_RE}`);
    if (RESERVED.has(slug)) fail(`${slug}: collides with a reserved path`);
    if (lower.has(slug.toLowerCase())) fail(`${slug}: duplicate slug`);
    lower.add(slug.toLowerCase());

    if (l.status === "active") active++;
    else if (l.status === "retired") retired++;
    else fail(`${slug}: status must be "active" or "retired" (found ${JSON.stringify(l.status)})`);

    let u;
    try { u = new URL(l.to); } catch { fail(`${slug}: target "${l.to}" is not a valid URL`); }
    if (u && u.protocol !== "https:") fail(`${slug}: target must be https://`);
    if (u && u.hostname.toLowerCase() === HOST) fail(`${slug}: target points at ${HOST} (redirect loop)`);
    if (l.code !== 301 && l.code !== 302) fail(`${slug}: code must be 301 or 302 (found ${JSON.stringify(l.code)})`);
    if (typeof l.label !== "string" || typeof l.tree !== "boolean") fail(`${slug}: label must be a string and tree a boolean`);
  }
  if (data.count?.active !== active || data.count?.retired !== retired)
    fail(`links.json: count says ${JSON.stringify(data.count)} but entries are active=${active}, retired=${retired}`);
  if (active === 0) fail("links.json: no active entries — refusing to deploy an empty link table");
}

// --- Ledger -----------------------------------------------------------------

const ledger = await loadJson("data/retired.json");
if (ledger && !Array.isArray(ledger.retired)) fail("retired.json: retired must be an array");

if (ledger?.retired) {
  const now = new Set(ledger.retired.map((r) => r.slug));

  let before = null;
  try {
    before = JSON.parse(execFileSync("git", ["show", "HEAD:data/retired.json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch { /* no commit yet, or file not yet committed: nothing to compare against */ }
  for (const r of before?.retired ?? []) {
    if (!now.has(r.slug)) fail(`retired.json: "${r.slug}" was removed — the ledger is append-only`);
  }

  for (const slug of now) {
    if (links?.[slug]?.status === "active") fail(`${slug}: retired slug is active again — retired slugs can never be reused (D6)`);
    else if (links && !links[slug]) fail(`${slug}: in the retired ledger but missing from links.json — it would 404 instead of 410`);
  }
}

// --- Static -----------------------------------------------------------------

const readPublic = (f) => readFile(ROOT + "public/" + f, "utf8").catch(() => null);
const index = await readPublic("index.html");
if (index === null) fail("public/index.html is missing");
else {
  if (!index.includes('<meta name="robots" content="noindex">')) fail("public/index.html: noindex meta tag missing (D9)");
  if (!index.includes("<!-- LINKS:START -->") || !index.includes("<!-- LINKS:END -->")) fail("public/index.html: LINKS sentinel comments missing");
}
const robots = await readPublic("robots.txt");
if (robots === null) fail("public/robots.txt is missing");
else if (/^\s*Disallow:\s*\/\s*$/im.test(robots)) fail("public/robots.txt contains Disallow: / (D8)");
for (const f of ["404.html", "gone.html"]) {
  await access(ROOT + "public/" + f).catch(() => fail(`public/${f} is missing`));
}

// --- Live targets -----------------------------------------------------------

async function probe(url) {
  const opts = { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": `link-qa (+https://${HOST})` } };
  try {
    let res = await fetch(url, { ...opts, method: "HEAD" });
    if (res.status === 405 || res.status === 403 || res.status === 501) res = await fetch(url, { ...opts, method: "GET" });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    return e.cause?.code || e.cause?.message || e.message;
  }
}

let checked = 0;
if (CHECK_LINKS && links) {
  const actives = Object.entries(links).filter(([, l]) => l.status === "active");
  const results = await Promise.all(actives.map(async ([slug, l]) => [slug, l, await probe(l.to)]));
  for (const [slug, l, err] of results) {
    checked++;
    if (!err) continue;
    const host = new URL(l.to).hostname;
    if (isOwnDomain(host)) fail(`${slug}: target ${l.to} is dead (${err}) — own domain`);
    else warn(`${slug}: target ${l.to} is dead (${err}) — third-party, not blocking`);
  }
}

// --- Summary ----------------------------------------------------------------

const rows = [
  ["active", active],
  ["retired", retired],
  ["draft", "n/a (excluded from links.json)"],
  ["targets checked", CHECK_LINKS ? checked : "skipped (no --links)"],
  ["warnings", warnings.length],
  ["failures", failures.length]
];
for (const w of warnings) console.warn(`WARN  ${w}`);
for (const f of failures) console.error(`FAIL  ${f}`);
console.log("\nQA summary");
for (const [k, v] of rows) console.log(`  ${k.padEnd(16)} ${v}`);
console.log(failures.length ? "\nQA FAILED" : "\nQA passed");
process.exit(failures.length ? 1 : 0);
