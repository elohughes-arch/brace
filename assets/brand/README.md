# Brace — brand assets

Per the brand bible, the logo is a **vector file**, never typeset in a font and
never redrawn per-surface. Everything on the site references these files, so
replacing a file updates every surface at once.

| File | Use |
|------|-----|
| `brace-wordmark-white.svg`    | On charcoal / dark photography — the default |
| `brace-wordmark-charcoal.svg` | On white / light grounds |
| `brace-a-mark-white.svg`      | Small dark contexts (below ~90px wide) |
| `brace-a-mark-charcoal.svg`   | Small light contexts |
| `brace-icon-tile.svg`         | Favicon, social avatar, app icon |

## ⚠️ These are stand-ins

These were reconstructed from the brand sheet because the official exports were
not in the repo. They match the geometry closely but they are **not** the
master artwork.

**To install the real thing:** drop the official exports in here under the same
filenames. Every surface picks them up with no code change, with one exception —
the splash animation smokes the clay out of the A, and locates it with two
variables in `styles.css`:

```css
--dot-x: 47.3%;   /* centre of the clay, as a % of the wordmark's width  */
--dot-y: 63.6%;   /* ...and of its height                                */
```

If the official wordmark places the clay differently, adjust those two values
and nothing else.
