# link.drost.us

Short links for Alex Drost's web properties. `https://link.drost.us/{slug}` redirects to a target URL. `https://link.drost.us/` is a link-tree landing page.

The link table is **authored in Notion**, synced nightly into `data/links.json`, validated, committed and deployed to a Cloudflare Worker. Click counts flow back into the same Notion database.

```
Notion DB → sync → data/links.json → QA → git commit → wrangler deploy → Worker
                                                                           ↓
Notion DB ← rollup ← Analytics Engine SQL API ← writeDataPoint ←───────────┘
```

## Day to day

- **Add or change a link:** edit the **Short Links** database in Notion. Set Status to `Active`. It goes live at the next sync, which runs nightly at 05:00 UTC.
- **Sync now:** open [the workflow](https://github.com/alexdrost/link-drost-us/actions/workflows/sync-and-deploy.yml) → **Run workflow**. The Notion page has a link to it (see "Sync button" below).
- **Retire a link:** set Status to `Retired`. The slug then serves a 410 "link expired" page. **This is permanent:** a retired slug can never be made Active again, and the sync will abort if you try. Use a new slug.
- **Stage a link:** leave it as `Draft`. Draft rows don't resolve.
- **If a change doesn't appear:** check the Actions log. One invalid row aborts the whole sync, by design, and the previous links stay live. The log names the row and the reason.

### Rules the sync enforces

| Field | Rule |
|---|---|
| Slug | `^[a-z0-9][a-z0-9-]{0,31}$`: lowercase, digits, hyphens, max 32 characters. No reserved names (`robots.txt`, `styles.css`, `gone`, `404`, `index` …). Unique. |
| Target URL | Must be `https://`. Can't point at `link.drost.us`. |
| Status | `Draft` / `Active` / `Retired`. **Empty counts as Draft.** |
| Redirect | `302` (default) or `301`. **Empty counts as 302.** Use 301 only for a link that will never be repointed. Browsers cache 301s effectively forever. |

The sync also refuses to publish if Notion is unreachable, returns zero rows, or has no Active rows.

## Click counts

The nightly rollup job writes `Clicks (7d)`, `Clicks (30d)`, `Clicks (total)`, `Last clicked` and `Counted through` into Notion. It never touches any other column, and it only writes to rows whose numbers changed.

> Click counts exclude requests identifying as bots, but email and chat link scanners (Outlook Safe Links, Gmail's proxy, Slack and LinkedIn unfurls) are not all detectable. At low volume a single link shared in one email thread can register several non-human hits. Treat these numbers as a relative signal between slugs, not as a count of people.

`Clicks (total)` is accumulated because Analytics Engine keeps only 90 days. `Counted through` is its bookkeeping, so don't edit it. On a row with no clicks yet, `Counted through` stays empty. That's expected.

## Sync button

Notion's webhook automations need a paid plan, so the "button" is a link to GitHub. The Notion page already has a plain link at the top. To add a real button on the database page: type `/button` → action **Open link** → `https://github.com/alexdrost/link-drost-us/actions/workflows/sync-and-deploy.yml`. Then: one click to GitHub, one click on **Run workflow**.

## Setup (one time)

### GitHub Actions secrets

| Secret | Value |
|---|---|
| `NOTION_TOKEN` | Internal integration token. **Share the Short Links database with the integration** (database ⋯ → Connections), or every query returns 404. |
| `NOTION_DATABASE_ID` | `990ba82fda1a4619be7644aa14ba6543` |
| `CLOUDFLARE_ACCOUNT_ID` | The account that owns the `drost.us` zone |
| `CLOUDFLARE_API_TOKEN` | See below |

**Cloudflare API token.** Create a custom token on the account that owns `drost.us` with:
- Account → Workers Scripts → Edit (deploy, and create the Worker on first deploy)
- Account → Account Analytics → Read (Analytics Engine SQL)
- Zone → Workers Routes → Edit, scoped to `drost.us` (needed to attach the `link.drost.us` custom domain)

The "Edit Cloudflare Workers" template covers the first and third; add Account Analytics → Read to it.

### First deploy

1. In Notion, set at least one row to **Active**. The sync refuses to publish an empty table.
2. Actions → **sync-and-deploy** → **Run workflow**.
3. The custom domain in `wrangler.jsonc` creates the DNS record and certificate on first deploy. If `link.drost.us` already has a CNAME record, delete it first, because custom domains refuse to attach over one.

## Local development

```bash
npm install
npx wrangler dev                    # Worker + assets on http://localhost:8787
node tools/qa.mjs                   # structural, ledger and static checks
node tools/qa.mjs --links           # …plus live target checks
```

Running the sync or rollup locally needs the same env vars as the secrets above. Put them in a gitignored `.dev.vars` or export them; never commit them.

## Files

| Path | What it is |
|---|---|
| `src/worker.js` | The redirect logic. Reads only the committed JSON; never calls Notion. |
| `src/shared.js` | Host, slug pattern, reserved names, own-domain list. Shared by the Worker and the tools. |
| `data/links.json` | **Generated. Never hand-edit:** the next sync overwrites it. |
| `data/retired.json` | **Append-only** ledger of retired slugs. QA fails if an entry disappears. |
| `public/index.html` | Link tree. Everything between `<!-- LINKS:START -->` and `<!-- LINKS:END -->` is generated; everything else is hand-written. |
| `tools/sync-from-notion.mjs` | Notion → `links.json`, ledger, link tree. Fails closed. |
| `tools/qa.mjs` | Runs before every deploy. |
| `tools/rollup-clicks.mjs` | Analytics Engine → Notion click columns. |

## Guardrails

- Never read Notion at request time.
- Never accept a redirect target from the query string.
- Never remove an entry from `data/retired.json`.
- Never hand-edit `data/links.json`.
- Never let the analytics write throw into the redirect path.
- Never let the rollup write a human-authored Notion field.
- Never publish an empty or partial link table.
- Never `COUNT(*)` against Analytics Engine. Use `SUM(_sample_interval)`.
- Don't add `Disallow: /` to robots.txt. Crawlers must be able to follow the redirects.
