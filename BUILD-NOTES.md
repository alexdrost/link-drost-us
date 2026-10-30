# Build notes — link.drost.us

Built 2026-10-30 in a cloud session that **could not reach `api.notion.com`, `api.cloudflare.com`, or the open web**, and could not create GitHub repositories. Read §2 before assuming anything is live.

## 1. What was built

- **Repo contents** (this directory), exactly the structure in the handoff, plus one file: `src/shared.js` (see §3).
- **Notion:** private page **Short Links — link.drost.us** (https://app.notion.com/p/4099af547eb381799ba4f0ccda359c09), with the **Short Links** database inside it.
  - Database ID for `NOTION_DATABASE_ID`: `990ba82fda1a4619be7644aa14ba6543`
  - All 12 properties exist with the exact names and types. Each has a description; `Counted through` reads "Do not edit — managed by the sync job."
  - Database description = the click-count caveat, verbatim.
  - View **Active — by clicks**: Status = Active, sorted by Clicks (30d) descending.
  - One seeded row, `boa` → https://thebusinessofaccounting.com/ (taken from the handoff's own example), left as **Draft**.
- **Live URL:** none yet. `https://link.drost.us` is **not deployed** (see §2).

## 2. Not completed — stated plainly

| Item | Status | What unblocks it |
|---|---|---|
| GitHub repo | **Not created.** The session can't create repos. Code is committed locally only. | Alex creates an empty private repo `alexdrost/link-drost-us`; then it's attached and pushed. |
| Actions secrets | **Not set.** No token values were available. | Alex adds the 4 secrets (README → Setup). |
| Notion integration sharing | **Not done.** Can't be done via API. | Database ⋯ → Connections → add the integration that owns `NOTION_TOKEN`. |
| Notion sync button | **Not created.** Notion's API can't create button blocks. A plain link to the workflow is at the top of the page instead. | Optional: `/button` → Open link (README → Sync button). |
| Deploy / DNS (§13) | **Not done.** `api.cloudflare.com` is blocked here. `wrangler deploy --dry-run` passes. | First Actions run after secrets are set. |
| Acceptance tests against the live host | **Not run.** Tests 1–10 ran against the Worker locally (workerd via `wrangler dev`); 11–17 ran against a mock Notion + Analytics Engine API. | Re-run §5 against `https://link.drost.us` after first deploy. |
| Test 18 (LinkedIn/Slack previews) | **Not run.** Manual. | Paste a live short link after deploy. |
| Real Notion API response shape | **Not verified live.** The sync and rollup were tested against a mock built to the documented 2022-06-28 shapes. | First Actions run. If it 400s on the Notion version, see §3 item 1. |
| Real Analytics Engine response shape | **Not verified live.** Numbers are coerced with `Number()`, so string- or number-typed sums both work. | First rollup run. |
| `QA --links` against real targets | **Ran, but couldn't reach any target** (sandbox egress). It still showed the classification works: own-domain dead = FAIL, third-party dead = WARN. | Runs on GitHub's runners every night. |

## 3. Where current API behaviour or the handoff differed — corrections for the source

**Fix these in the handoff itself.** Exact replacement text is given for each.

1. **§3 Prerequisites, `CLOUDFLARE_API_TOKEN` row: the token is under-scoped.** Current Cloudflare docs (Workers → Authorization) say a deploy that adds a custom domain needs *Zone → Workers Routes → Write* on the zone, and creating a Worker that doesn't exist yet needs admin-level Workers access.
   Replace the Notes cell with:
   > Needs **three** permissions: `Account → Workers Scripts → Edit` (deploy, including creating the Worker on first deploy), `Account → Account Analytics → Read` (Analytics Engine SQL), and `Zone → Workers Routes → Edit` scoped to `drost.us` (attaching the custom domain). The "Edit Cloudflare Workers" token template plus Account Analytics → Read covers it.

2. **§11 workflow, "Commit if changed" step: it didn't commit the generated link tree.** §12 makes the sync write into `public/index.html`, but the step only staged `data/`. The deploy would still ship the updated page, but git would never record it, so §D1's audit log would be incomplete. Fixed in the repo.
   Replace `git add data/links.json data/retired.json` with:
   > `git add data/links.json data/retired.json public/index.html`

   (This does not cause a trigger loop: pushes made with `GITHUB_TOKEN` don't start new workflow runs.)

3. **§5 Status / Redirect "Default `Draft`" / "Default `302`": Notion select properties have no default value.** A new row has an empty Status and an empty Redirect. The sync treats empty Status as Draft and empty Redirect as 302.
   Add under §5's table:
   > Notion selects can't carry a default. The sync treats an empty Status as `Draft` and an empty Redirect as `302`.

4. **§9 step 5, "Set `Counted through = yesterday`": done literally, this PATCHes every row every night**, contradicting the "only PATCH a row whose values changed" rule two paragraphs later. The implementation advances `Counted through` only when the window had clicks. When the window is all zeros, the field stays put and those days are re-counted (as zero) the next night. Totals stay exact and idempotent: past days never gain clicks, and days older than 90 days that were already seen as zero stay zero. Idle rows are never rewritten.
   Replace step 5 with:
   > 5. If that sum is greater than zero, set `Counted through = yesterday`. If it is zero, leave `Counted through` unchanged — those zero days are re-counted as zero next run, and idle rows aren't rewritten nightly. (A row with no clicks yet therefore has an empty `Counted through`.)

   The three queries are also shaped slightly differently from §9's text. Each slug has its own `Counted through`, so the accumulation query isn't one global lower bound with one sum. It runs once from the earliest pending date (clamped to the 90-day retention floor), grouped by `slug, toStartOfInterval(timestamp, INTERVAL '1' DAY)`, upper-bounded at today 00:00 UTC. Each slug then sums only its own days. It's still 3 queries per night.

5. **§7 `RESERVED`: extensionless asset paths were missing.** With `html_handling`, the asset layer also answers `/gone`, `/404` and `/index`. Without reserving them, a request to `/gone` fell through as an unknown slug and served the expired page with a 200. I added `"404", "gone", "index"` to `RESERVED`, so those names can't be used as slugs either.

6. **§7 worker: `decodeURIComponent` throws on a malformed escape** (`/%E0%A4%A`), which would make the request fail with a 500. It is now wrapped, so the raw path is used and resolves to a 404. Also, `data.links[slug]` was looked up with `Object.hasOwn`, so `/__proto__` and `/constructor` can't match inherited properties. Both 404 (tested).

7. **§4 "Create exactly this": one added file, `src/shared.js`.** HOST, the slug regex, RESERVED and OWN_DOMAINS each appear in the Worker, the sync and QA. One shared module stops the three copies from drifting apart, which is itself a guardrail. No new directories were added.

8. **Verified as the handoff states (no change needed):**
   - `run_worker_first: true`. Checked against the wrangler 4.156 config schema; it accepts a boolean or an array of patterns.
   - Analytics Engine SQL endpoint `/accounts/{id}/analytics_engine/sql`, raw-SQL body, mandatory lower time bound, `SUM(_sample_interval)`.
   - `env.ASSETS.fetch(new URL("/gone.html", url))` returns the page body under `drop-trailing-slash`. I suspected a 307 here, tested it, and found the handoff's line is correct. It is kept as written.
   - Notion API version `2022-06-28` and `/v1/databases/{id}/query`. **Not verifiable from this sandbox.** The database was created through Notion's current tooling, which uses the data-sources model; it has exactly one data source (`a52d6c3d-de76-4d2b-ac94-4f795f9ff3fc`), so the classic endpoint should work against the database ID. If the first run fails on this, switch to `Notion-Version: 2025-09-03` and `POST /v1/data_sources/a52d6c3d-de76-4d2b-ac94-4f795f9ff3fc/query`. The property shapes are unchanged.

9. **Other implementation calls, not in the handoff:**
   - A retired slug whose Notion row is **deleted** is carried forward from the previous `links.json`, with a warning, so it keeps serving 410. QA also fails if a ledger slug is missing from `links.json`.
   - A retired slug set back to **Draft** aborts the sync, the same as setting it to Active. Draft would silently turn the 410 into a 404.
   - Slugs are **not** silently lowercased by the sync. An uppercase slug in Notion aborts with a clear message, which is fail-closed. Requests are case-insensitive, as specified.
   - The link tree is ordered alphabetically by Label. Notion has no order field to honour.
   - Design: accent `#d97a34` is used for borders, rules and focus rings. Link **text** uses a darker `#9c4f16`, because `#d97a34` on a light background is about 2.9:1 contrast, which fails WCAG AA for body text. There's a dark-mode variant, no webfonts, and no external requests.
   - The 404 and expired pages list drost.us, alexdrost.com, thebusinessofaccounting.com, connection.builders and drost.group by domain name only. I didn't invent descriptions.

## 4. Objections to §2 decisions

None that I'd change. One clarification on **D4**: `?url=` on a *valid* slug is passed through to the target as an ordinary query parameter (`/boa?url=x` → `thebusinessofaccounting.com/?url=x`). That is the §7 query-carry behaviour, not an open redirect, because the destination host is always the committed target. If a target site itself has an open redirect on `?url=`, that becomes a chained risk; QA can't see that.

## 5. Acceptance test results (§14)

**Environment caveat:** "local" means `wrangler dev` (workerd + real asset handling) with a test `links.json`. "Mock" means a local mock of the Notion and Analytics Engine HTTP APIs. **Nothing below was run against `https://link.drost.us`.**

| # | Test | Result |
|---|---|---|
| 1 | Active slug → 302, location, `cache-control: no-store` | **PASS (local)**. A 301 entry also returns 301. |
| 2 | `?utm_source=test` carried through | **PASS (local)** |
| 3 | Target `?x=1` + request `?x=2&y=3` → `x=1&y=3` | **PASS (local)** |
| 4 | Uppercase slug → same 302 | **PASS (local)** |
| 5 | Trailing slash → same 302 | **PASS (local)** |
| 6 | Retired → 410 + gone page | **PASS (local)**, 916-byte body |
| 7 | Unknown → 404 + 404 page | **PASS (local)** |
| 8 | robots.txt present, no `Disallow: /` | **PASS (local)** |
| 9 | `/` has `noindex` | **PASS (local)** |
| 10 | `/?url=https://evil.example` → root page, no redirect | **PASS (local)**, 200 |
| 11 | Draft row → 404 | **PASS (mock + local)**. Draft `wip` excluded from links.json and 404s. |
| 12 | Retired row → 410, appended to ledger | **PASS (mock + local)** |
| 13 | Retired → Active → refused | **PASS (mock)**. Sync exits 1 naming the slug; QA independently fails on a hand-edited `links.json`. |
| 14 | Empty database → exit 1, nothing written | **PASS (mock)**. Also tested: Notion HTTP 502, and zero Active rows. |
| 15 | Invalid URL → exit 1 naming slug, nothing written | **PASS (mock)**. Also tested: http://, self-loop, duplicate, reserved, uppercase, Redirect 307. |
| 16 | Clicks appear in Notion | **PASS (mock)**. Includes a sampled row (`_sample_interval` = 10), bot / 404 / 410 events excluded, today excluded from total. |
| 17 | Second rollup run → totals unchanged | **PASS (mock)**. 0 PATCHes on the second run; 0 writes to human-authored fields across both runs. |
| 18 | LinkedIn / Slack preview | **NOT RUN** (manual, needs live host) |

Also verified: pagination (mock pages of 2 rows), unchanged-content runs write nothing, HTML escaping of labels on the link tree, append-only ledger enforcement against `git show HEAD`, QA fails on `Disallow: /` and on a missing `noindex`, and `/__proto__` and a malformed `%`-escape both resolve safely.
