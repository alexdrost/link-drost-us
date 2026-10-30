// Constants shared by the Worker and the tools, so the rules can't drift apart.

export const HOST = "link.drost.us";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Paths served as static assets, never as slugs. "gone", "404" and "index" are
// the extensionless forms the asset handler also answers to.
export const RESERVED = new Set([
  "", "robots.txt", "sitemap.xml", "favicon.ico", "styles.css",
  "404.html", "gone.html", "index.html", "404", "gone", "index"
]);

// A dead target on one of these is a hard QA failure; anywhere else it's a warning.
export const OWN_DOMAINS = [
  "drost.us", "drost.group", "alexdrost.com",
  "thebusinessofaccounting.com", "connection.builders"
];

export function isOwnDomain(host) {
  host = host.toLowerCase();
  return OWN_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}
