# Stashpad project website

Buildless GitHub Pages source. Preview from the repository root:

```sh
python3 -m http.server 8091 --directory docs/site
node scripts/check-site.mjs
```

The Project website workflow validates pull requests and deploys docs/site from main.
Production: https://laaielichter.github.io/Stashpad/ (Pages source: GitHub Actions).

The cards and review buttons are explicitly labelled illustrations. They do not run Stashpad, access a store or write memory files. The recorded terminal SVG is copied from docs/demo/demo.svg; the website shows a static PNG rendered from it with reduced motion for immediate readability; regenerate that recording with npm run demo when the CLI demonstration changes, then update the website copy.

Assets include the generated icon and a 1200 × 630 social-sharing card. The card's source is in assets/social-card-source.html. No telemetry, external fonts or runtime dependencies. The website is excluded from the npm package with !docs/site.
