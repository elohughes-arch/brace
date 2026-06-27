# Brace app — the private game book

The authenticated **Brace** product: a member's private shooting log. Self-contained
static SPA (no build step) that reuses the landing-page design system. Lives at `/app`
on the deployed site; separate from the existing Opus app in the repo root.

## What it does

- **Auth** — sign-in / create-account front door (demo: any email signs you in).
- **Season** dashboard — days in the line, season bag, your bag & shots-to-bag, best day,
  and a bag-by-species breakdown for the whole season.
- **Game Book** — every recorded day as a card → a full game-book entry (drives, the bag
  by species, conditions, the line, a footage timeline with the auto-detected moments).
- **Add a day** — drop in footage and watch *"Brace is reading your day"* turn it into a
  finished entry that's saved to your book.
- **Settings** — your details, kit & cameras, and privacy controls.

## Data

A mock data layer (`data.js`) stands in for the backend; session + any days you add are
kept in `localStorage`. The shapes mirror a real game-book record so a live API (e.g.
Supabase) can drop in later.

## Files

| File | Purpose |
|------|---------|
| `index.html` | SPA shell + SVG icon sprite |
| `app.js` | Hash router + all views + interactions (ES module) |
| `data.js` | Mock data + session/persistence helpers |
| `app.css` | App shell + screens (reuses the Brace tokens) |

## Preview

```bash
cd app && python3 -m http.server 8000   # open http://localhost:8000
```
