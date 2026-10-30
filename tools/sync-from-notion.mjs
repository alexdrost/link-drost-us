#!/usr/bin/env node
// Notion "Short Links" database → data/links.json (+ data/retired.json, + the
// link list inside public/index.html).
//
// Fails closed: any API error, an empty result, or a single invalid row aborts
// the run before anything is written, leaving the previous map live.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HOST, RESERVED, SLUG_RE } from "../src/shared.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LINKS_PATH = ROOT + "data/links.json";
const RETIRED_PATH = ROOT + "data/retired.json";
const INDEX_PATH = ROOT + "public/index.html";

// Pinned to the classic databases API. Version 2025-09-03 moved queries to
// /v1/data_sources/{id}/query; the property schema is the same either way.
const NOTION_VERSION = "2022-06-28";
const NOTION_API = process.env.NOTION_API_BASE || "https://api.notion.com"; // override only for local tests

function die(msg) {
  console.error(`sync: ABORT — ${msg}`);
  console.error("sync: nothing written; the previous link table stays live.");
  process.exit(1);
}

const { NOTION_TOKEN, NOTION_DATABASE_ID } = process.env;
if (!NOTION_TOKEN) die("NOTION_TOKEN is not set");
if (!NOTION_DATABASE_ID) die("NOTION_DATABASE_ID is not set");

async function queryAll() {
  const rows = [];
  let cursor;
  do {
    let res;
    try {
      res = await fetch(`${NOTION_API}/v1/databases/${NOTION_DATABASE_ID}/query`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${NOTION_TOKEN}`,
          "notion-version": NOTION_VERSION,
          "content-type": "application/json"
        },
        body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 })
      });
    } catch (e) {
      die(`Notion unreachable: ${e.message}`);
    }
    if (!res.ok) die(`Notion returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    if (!Array.isArray(body.results)) die("Notion response has no results array");
    rows.push(...body.results);
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);
  return rows;
}

const text = (p) => (p?.title ?? p?.rich_text ?? []).map((t) => t.plain_text).join("").trim();

function mapRow(page) {
  const p = page.properties ?? {};
  return {
    id: page.id,
    slug: text(p["Slug"]),
    to: (p["Target URL"]?.url ?? "").trim(),
    status: p["Status"]?.select?.name ?? "Draft", // empty Status = Draft, the documented default
    code: p["Redirect"]?.select?.name ?? "302",   // empty Redirect = 302, the documented default
    label: text(p["Label"]),
    tree: p["Show on link tree"]?.checkbox === true
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return fallback;
    die(`${path} is not valid JSON: ${e.message}`);
  }
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------------------

const pages = await queryAll();
if (pages.length === 0) die("Notion returned zero rows");

const ledger = await readJson(RETIRED_PATH, { retired: [] });
const everRetired = new Set(ledger.retired.map((r) => r.slug));
const previous = await readJson(LINKS_PATH, { links: {} });

const errors = [];
const seen = new Map(); // slug -> row id
const links = {};
let drafts = 0;

for (const page of pages) {
  const row = mapRow(page);
  const name = row.slug || `(untitled row ${row.id})`;

  if (!["Active", "Retired", "Draft"].includes(row.status)) {
    errors.push(`${name}: unknown Status "${row.status}"`);
    continue;
  }
  if (row.status === "Draft") {
    // D6: a retired slug can't be quietly parked as Draft either — it would 404 instead of 410
    if (everRetired.has(row.slug)) errors.push(`${name}: slug was retired and must stay Status = Retired (found Draft)`);
    else drafts++;
    continue;
  }

  if (!SLUG_RE.test(row.slug)) { errors.push(`${name}: slug must match ${SLUG_RE} (lowercase letters, digits, hyphens; max 32)`); continue; }
  if (RESERVED.has(row.slug)) { errors.push(`${name}: slug is reserved`); continue; }
  if (seen.has(row.slug)) { errors.push(`${name}: duplicate slug (rows ${seen.get(row.slug)} and ${row.id})`); continue; }
  seen.set(row.slug, row.id);

  let target;
  try { target = new URL(row.to); } catch { errors.push(`${name}: Target URL "${row.to}" does not parse`); continue; }
  if (target.protocol !== "https:") { errors.push(`${name}: Target URL must use https:`); continue; }
  if (target.hostname.toLowerCase() === HOST) { errors.push(`${name}: Target URL points at ${HOST} (redirect loop)`); continue; }
  if (row.code !== "301" && row.code !== "302") { errors.push(`${name}: Redirect must be 301 or 302 (found "${row.code}")`); continue; }
  if (row.status === "Active" && everRetired.has(row.slug)) {
    errors.push(`${name}: slug was retired and can never be reused (D6) — pick a new slug`);
    continue;
  }

  links[row.slug] = {
    to: row.to,
    code: Number(row.code),
    status: row.status.toLowerCase(),
    label: row.label,
    tree: row.tree
  };
}

// A retired slug whose Notion row was deleted keeps its 410 from the previous map.
const carried = [];
for (const slug of everRetired) {
  if (!links[slug] && !seen.has(slug) && previous.links?.[slug]?.status === "retired") {
    links[slug] = previous.links[slug];
    carried.push(slug);
  }
}

if (errors.length) die(`${errors.length} invalid row(s):\n  - ${errors.join("\n  - ")}`);

const active = Object.values(links).filter((l) => l.status === "active").length;
const retired = Object.values(links).filter((l) => l.status === "retired").length;
if (active === 0) die("no Active rows — refusing to publish an empty link table");

// ---------------------------------------------------------------------------
// Everything validated. Build outputs, then write only what changed.

const sorted = Object.fromEntries(Object.keys(links).sort().map((k) => [k, links[k]]));
const next = {
  generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  source: "notion",
  count: { active, retired },
  links: sorted
};

const strip = ({ generated, ...rest }) => JSON.stringify(rest);
const linksChanged = strip(next) !== strip(previous);
if (linksChanged) await writeFile(LINKS_PATH, JSON.stringify(next, null, 2) + "\n");

const today = new Date().toISOString().slice(0, 10);
const newlyRetired = Object.keys(sorted).filter((s) => sorted[s].status === "retired" && !everRetired.has(s));
if (newlyRetired.length) {
  ledger.retired.push(...newlyRetired.map((slug) => ({ slug, retiredOn: today })));
  await writeFile(RETIRED_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

// Link tree: active + tree entries, linked through the short URL so the tree's own clicks count.
const treeItems = Object.entries(sorted)
  .filter(([, l]) => l.status === "active" && l.tree)
  .sort(([a, la], [b, lb]) => (la.label || a).localeCompare(lb.label || b))
  .map(([slug, l]) => `      <li><a href="https://${HOST}/${slug}">${escapeHtml(l.label || slug)}</a></li>`);

const html = await readFile(INDEX_PATH, "utf8");
const START = "<!-- LINKS:START -->", END = "<!-- LINKS:END -->";
const i = html.indexOf(START), j = html.indexOf(END);
if (i === -1 || j === -1 || j < i) die("public/index.html is missing the LINKS:START / LINKS:END markers");
const nextHtml = html.slice(0, i + START.length) + "\n" + treeItems.map((l) => l + "\n").join("") + html.slice(j);
const indexChanged = nextHtml !== html;
if (indexChanged) await writeFile(INDEX_PATH, nextHtml);

console.log(`sync: ${pages.length} rows → ${active} active, ${retired} retired, ${drafts} draft`);
console.log(`sync: links.json ${linksChanged ? "updated" : "unchanged"}; index.html ${indexChanged ? "updated" : "unchanged"}`);
if (newlyRetired.length) console.log(`sync: newly retired → ledger: ${newlyRetired.join(", ")}`);
if (carried.length) console.warn(`sync: WARNING retired slug(s) missing from Notion, kept from previous map: ${carried.join(", ")}`);
