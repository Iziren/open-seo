import type { Fixture } from "./types";
import { htmlResponse, renderPage } from "../lib";
import { article } from "./helpers";

const CAT = "Structured data";

// 28 — a JSON-LD block that stops mid-object, so it cannot be parsed -------
const invalidStructuredData: Fixture = {
  path: "/schema/invalid-structured-data",
  category: CAT,
  name: "Invalid structured data",
  summary:
    "The page's JSON-LD block is cut off mid-object and cannot be parsed.",
  lesson:
    "Broken markup earns no rich result. Run the page through the Rich Results Test and fix the syntax it reports.",
  expectedIssues: ["invalid-structured-data"],
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: invalidStructuredData,
        title: "Copper kettle product page",
        metaDescription:
          "A solid copper kettle with a whistle top, built for daily use and covered by a ten-year warranty.",
        // Truncated mid-object on purpose: the script tag itself is intact
        // (so the page parses normally) but JSON.parse fails on the body.
        headExtra: `<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Product", "name": "Copper kettle", "offers": {"@type": "Offer"}</script>`,
        bodyHtml: article({
          h1: "A copper kettle that lasts",
          lede: "A heavy copper kettle with a whistle top, made for a stove that sees daily use.",
          sections: [
            {
              h2: "Why copper",
              body: "Copper moves heat fast and spreads it evenly, so water comes to a boil quickly and the base never scorches on one hot spot. This kettle pairs a copper body with a steel base that suits induction hobs, plus a handle that stays cool enough to grab without a cloth for a short pour.",
            },
            {
              h2: "Care and warranty",
              body: "Rinse the kettle after each use and dry it on the warm hob to stop spots from forming. A soak with vinegar and salt lifts any dull film. Every kettle ships with a ten-year warranty that covers seams, the whistle cap, and the handle rivets.",
            },
          ],
        }),
      }),
    ),
};

export const schemaFixtures: Fixture[] = [invalidStructuredData];
