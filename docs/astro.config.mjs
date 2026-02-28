import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://benjick.js.org",
  base: "/pg-ratelimit",
  integrations: [
    starlight({
      title: "pg-ratelimit",
      credits: false,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/benjick/pg-ratelimit",
        },
      ],
      sidebar: [
        { label: "Getting Started", slug: "getting-started" },
        {
          label: "Algorithms",
          items: [
            { label: "Fixed Window", slug: "algorithms/fixed-window" },
            { label: "Sliding Window", slug: "algorithms/sliding-window" },
            { label: "Token Bucket", slug: "algorithms/token-bucket" },
          ],
        },
        { label: "Database Design", slug: "database" },
        { label: "API Reference", slug: "api-reference" },
        { label: "Testing Guide", slug: "testing" },
      ],
    }),
  ],
});
