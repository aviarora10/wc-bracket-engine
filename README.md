# WC26 · Bracket Probability Engine

An interactive Monte Carlo simulator for the **2026 FIFA World Cup knockout stage** — from the Round of 32 through the Final and 3rd-place playoff. For any match in the bracket it tells you which teams are most likely to play in it, with what probability, and how each pairing would resolve.

Group-stage strengths are pulled **live from Polymarket's prediction markets**; the rest of the tournament is simulated from those odds.

## Live demo

Static files, no build step — open `index.html` directly in a browser, or deploy anywhere that serves static files (see below).

## Project structure

```text
index.html    markup + <link>/<script> tags
styles.css    all styling
data.js       constants: groups, Polymarket slugs, fallback priors, Annex C table, bracket structure
app.js        logic: Polymarket fetch, Monte Carlo simulation, rendering, controls
```

`data.js` and `app.js` are plain (non-module) scripts loaded in order, so there's no bundler or import/export — they share global scope and work straight from `file://`.

## How it works

- **Group odds** come from Polymarket's `Group X Winner` markets via the public [Gamma API](https://gamma-api.polymarket.com). Each team's market-implied win probability becomes its *strength*. If the API can't be reached, FIFA-ranking-based fallback priors are used.
- **Finish probabilities** (1st / 2nd / 3rd / out) are derived with a [Plackett–Luce](https://en.wikipedia.org/wiki/Plackett%E2%80%93Luce_model) sampling model.
- **Knockout matches** use `P(A wins) = sA^v / (sA^v + sB^v)`, where `v` is the adjustable variance exponent (lower = more upsets, higher = chalk).
- **3rd-place routing** uses the official **Annex C** lookup table — all 495 combinations of the 8 qualifying third-place teams — to assign Round-of-32 matchups deterministically.
- Each **Re-Simulate** runs N full-tournament Monte Carlo simulations (default 10,000) and aggregates results into per-slot probabilities, including the 3rd-place playoff.

## Controls

- **Group sliders** — override any team's strength.
- **Lock a finish** — click a team name to force its group placement (1st / RU / 3rd / out).
- **Force a match winner** — open a match and lock a team to win it; the downstream bracket re-simulates.
- **Variance / Sims** — tune chaos vs. chalk, and precision vs. speed.
- **Refetch odds** — pull the latest Polymarket prices without losing your overrides.

## Deploy for free

No build step, no backend, no API keys — the Polymarket call runs client-side against a CORS-open public API.

### Vercel

1. Push this repo to GitHub.
2. Import it in Vercel → framework preset **Other**, no build command, output directory = root.
3. Deploy. `index.html` is served at the root URL.

### GitHub Pages

1. Push to GitHub.
2. Settings → Pages → deploy from the `main` branch, root folder.

## Caveats

- Third-place *qualification* ranking uses team strength as a proxy (real life uses points → goal difference → goals scored), which slightly favors stronger teams.
- Polymarket group markets stop updating once the group stage ends (~June 27, 2026); after that the app uses the last-fetched values.
- Each match is a single Bernoulli trial — extra time and penalties are absorbed into the win probability.

## Data sources

- Group draw: FIFA official draw, Dec 5 2025
- Bracket structure & Annex C: [Wikipedia — 2026 FIFA World Cup knockout stage](https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage)
- Live odds: [Polymarket FIFA World Cup markets](https://polymarket.com/fifa-world-cup) (Gamma API)

## License

[MIT](LICENSE) © 2026 aviarora10. Covers this project's code; live odds remain Polymarket's and are consumed via their API, not redistributed.
</content>
</invoke>
