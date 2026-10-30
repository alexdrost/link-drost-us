import data from "../data/links.json" with { type: "json" };
import { RESERVED } from "./shared.js";

const BOT_RE = /bot|crawler|spider|slurp|preview|fetch|curl|wget|headless|monitor|scan|safelinks|proofpoint|mimecast|slackbot|discordbot|whatsapp|facebookexternalhit|linkedinbot|twitterbot/i;

function classify(ua) {
  return BOT_RE.test(ua || "") ? "bot" : "human";
}

function log(env, slug, outcome, request) {
  try {
    env.AE.writeDataPoint({
      indexes: [slug.slice(0, 90)],
      blobs: [
        slug,
        outcome,                                           // redirect | gone | notfound
        classify(request.headers.get("user-agent")),       // human | bot
        request.headers.get("cf-ipcountry") || "XX",
        (() => {
          try { return new URL(request.headers.get("referer") || "").host; }
          catch { return ""; }
        })()
      ],
      doubles: [1]
    });
  } catch { /* analytics must never break a redirect */ }
}

function decodePath(pathname) {
  try { return decodeURIComponent(pathname); }
  catch { return pathname; } // malformed %-escape: treat literally, it will 404
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const raw = decodePath(url.pathname.slice(1)).replace(/\/+$/, "");
    const slug = raw.toLowerCase();

    if (RESERVED.has(slug)) return env.ASSETS.fetch(request);

    const entry = Object.hasOwn(data.links, slug) ? data.links[slug] : undefined;

    if (!entry) {
      log(env, slug, "notfound", request);
      return env.ASSETS.fetch(request); // falls through to 404.html
    }

    if (entry.status === "retired") {
      log(env, slug, "gone", request);
      const res = await env.ASSETS.fetch(new URL("/gone.html", url));
      return new Response(res.body, {
        status: 410,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }

    const target = new URL(entry.to);
    // carry the caller's query params through without clobbering the target's own
    for (const [k, v] of url.searchParams) {
      if (!target.searchParams.has(k)) target.searchParams.append(k, v);
    }

    log(env, slug, "redirect", request);

    return new Response(null, {
      status: entry.code ?? 302,
      headers: {
        location: target.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer-when-downgrade"
      }
    });
  }
};
