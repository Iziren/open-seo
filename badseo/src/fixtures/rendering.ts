import type { Fixture } from "./types";
import { htmlResponse } from "../lib";

const CAT = "Rendering";

// A client-rendered app: the server answers every user agent (Googlebot
// included) with an empty mount element plus a script bundle, so the audit's
// Googlebot re-fetch finds nothing to improve on and keeps the shell verdict.
const spaShell: Fixture = {
  path: "/rendering/spa-shell",
  category: CAT,
  name: "JavaScript app shell",
  summary:
    'The HTML is an empty <div id="root"> plus a script bundle; the page only exists after JavaScript runs.',
  lesson:
    "Serve the page's real content and links in the initial HTML — server-side rendering, static generation, or a prerendering service. A search engine that does not run JavaScript sees this empty shell and indexes nothing.",
  expectedIssues: [
    "spa-shell",
    "thin-content",
    "missing-h1",
    "no-outgoing-links",
  ],
  handler: () =>
    htmlResponse(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Live dashboard — Acme analytics app</title>
<meta name="description" content="A client-rendered analytics dashboard whose charts, tables, and navigation exist only after the JavaScript bundle executes in the browser.">
<link rel="stylesheet" href="/styles.css">
<script defer src="/assets/dashboard.4f2a91c.js"></script>
</head>
<body>
<div id="root"></div>
</body>
</html>`,
    ),
};

export const renderingFixtures: Fixture[] = [spaShell];
