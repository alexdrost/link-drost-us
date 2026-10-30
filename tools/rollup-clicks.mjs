#!/usr/bin/env node
// Cloudflare Analytics Engine → click counts in the Notion "Short Links" database.
//
// Writes only the script-owned columns (Clicks (7d), Clicks (30d), Clicks (total),
// Last clicked, Counted through) and only on rows whose values actually changed.
//
// Lifetime total is accumulated, not recomputed, because Analytics Engine keeps
// 90 days. Per slug: count whole UTC days after "Counted through" up to and
// including yesterday, add them to the total, move "Counted through" to
// yesterday. A second run the same day finds nothing new to count.

import { HOST } from "../src/shared.js";

const NOTION_VERSION = "2022-06-28";
const NOTION_API = process.env.NOTION_API_BASE || "https://api.notion.com";       // override only for local tests
const CF_API = process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com";   // override only for local tests
const DATASET = "link_clicks";
const AE_RETENTION_DAYS = 90;

const { NOTION_TOKEN, NOTION_DATABASE_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = process.env;
for (const [k, v] of Object.entries({ NOTION_TOKEN, NOTION_DATABASE_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID })) {
  if (!v) { console.error(`rollup: ${k} is not set`); process.exit(1); }
}

const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const aeTimeToIso = (s) => s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z");

const now = new Date();
const todayStart = new Date(ymd(now) + "T00:00:00Z");
const yesterday = ymd(new Date(todayStart - DAY));
const retentionFloor = new Date(todayStart - AE_RETENTION_DAYS * DAY);

// --- APIs -------------------------------------------------------------------

async function notion(path, method, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${NOTION_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${NOTION_TOKEN}`,
        "notion-version": NOTION_VERSION,
        "content-type": "application/json"
      },
      body: body && JSON.stringify(body)
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Notion ${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}

async function queryNotion() {
  const rows = [];
  let cursor;
  do {
    const body = await notion(`/v1/databases/${NOTION_DATABASE_ID}/query`, "POST",
      cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 });
    rows.push(...body.results);
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);
  return rows;
}

async function ae(sql) {
  const res = await fetch(`${CF_API}/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "content-type": "text/plain" },
    body: sql
  });
  if (!res.ok) throw new Error(`Analytics Engine → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).data ?? [];
}

// Real redirects by apparent humans only. SUM(_sample_interval), never COUNT(*):
// Analytics Engine samples at volume and each row stands for _sample_interval events.
const HUMAN_REDIRECTS = `blob2 = 'redirect' AND blob3 = 'human'`;

async function clicksSince(since) {
  const rows = await ae(`SELECT blob1 AS slug, SUM(_sample_interval) AS clicks, MAX(timestamp) AS last_click
FROM ${DATASET}
WHERE timestamp >= toDateTime('${sqlTime(since)}')
  AND ${HUMAN_REDIRECTS}
GROUP BY slug
FORMAT JSON`);
  return new Map(rows.map((r) => [r.slug, { clicks: Number(r.clicks), last: r.last_click }]));
}

async function dailyClicks(fromDay) {
  const rows = await ae(`SELECT blob1 AS slug, toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(_sample_interval) AS clicks
FROM ${DATASET}
WHERE timestamp >= toDateTime('${fromDay} 00:00:00')
  AND timestamp < toDateTime('${sqlTime(todayStart)}')
  AND ${HUMAN_REDIRECTS}
GROUP BY slug, day
FORMAT JSON`);
  const bySlug = new Map();
  for (const r of rows) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push({ day: String(r.day).slice(0, 10), clicks: Number(r.clicks) });
  }
  return bySlug;
}

// --- Main -------------------------------------------------------------------

const pages = await queryNotion();

const rows = pages
  .map((page) => {
    const p = page.properties ?? {};
    const slug = (p["Slug"]?.title ?? []).map((t) => t.plain_text).join("").trim().toLowerCase();
    const countedThrough = p["Counted through"]?.date?.start?.slice(0, 10) ?? null;
    // Empty "Counted through" = the day before the row was created, so counting starts on creation day.
    const countFrom = countedThrough
      ? ymd(new Date(Date.parse(countedThrough + "T00:00:00Z") + DAY))
      : page.created_time.slice(0, 10);
    return {
      id: page.id,
      slug,
      c7: p["Clicks (7d)"]?.number ?? null,
      c30: p["Clicks (30d)"]?.number ?? null,
      total: p["Clicks (total)"]?.number ?? null,
      last: p["Last clicked"]?.date?.start ?? null,
      countedThrough,
      countFrom
    };
  })
  .filter((r) => r.slug);

// Rows already counted through yesterday are skipped by the accumulation — that's what makes a re-run safe.
const pending = rows.filter((r) => !r.countedThrough || r.countedThrough < yesterday);
const earliest = pending.reduce((min, r) => (r.countFrom < min ? r.countFrom : min), yesterday);
const accumulateFrom = earliest < ymd(retentionFloor) ? ymd(retentionFloor) : earliest;

// Three read queries, all before any write: a failed query means nothing is written.
const [last7, last30, daily] = await Promise.all([
  clicksSince(new Date(now - 7 * DAY)),
  clicksSince(new Date(now - 30 * DAY)),
  pending.length ? dailyClicks(accumulateFrom) : Promise.resolve(new Map())
]);

let patched = 0, unchanged = 0;
for (const r of rows) {
  const props = {};
  const c7 = last7.get(r.slug)?.clicks ?? 0;
  const c30 = last30.get(r.slug)?.clicks ?? 0;
  if (r.c7 !== c7) props["Clicks (7d)"] = { number: c7 };
  if (r.c30 !== c30) props["Clicks (30d)"] = { number: c30 };

  const seen = last30.get(r.slug)?.last;
  if (seen) {
    const iso = aeTimeToIso(seen);
    // compare at minute precision: Notion stores datetimes to the minute
    if (!r.last || Math.floor(Date.parse(iso) / 60000) > Math.floor(Date.parse(r.last) / 60000)) {
      props["Last clicked"] = { date: { start: iso } };
    }
  }

  if (!r.countedThrough || r.countedThrough < yesterday) {
    const add = (daily.get(r.slug) ?? [])
      .filter((d) => d.day >= r.countFrom && d.day <= yesterday)
      .reduce((s, d) => s + d.clicks, 0);
    if (add > 0) {
      props["Clicks (total)"] = { number: (r.total ?? 0) + add };
      props["Counted through"] = { date: { start: yesterday } };
    } else if (r.total === null) {
      props["Clicks (total)"] = { number: 0 };
    }
    // add === 0: leave "Counted through" where it is. Those zero days get re-counted
    // as zero tomorrow, the total stays correct, and idle rows aren't rewritten nightly.
  }

  if (Object.keys(props).length === 0) { unchanged++; continue; }
  await notion(`/v1/pages/${r.id}`, "PATCH", { properties: props });
  patched++;
  await new Promise((res) => setTimeout(res, 350)); // stay under Notion's ~3 req/s
}

console.log(`rollup: ${rows.length} rows, ${patched} updated, ${unchanged} unchanged (counted through ${yesterday}, ${HOST})`);
