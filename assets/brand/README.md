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

## How these were made

Cut from **Instrument Sans** (Regular, 400) — the typeface the bible names the
wordmark as derived from — using its real glyph outlines, not a redrawing. In
Instrument Sans the `A` is built from three contours (left leg, right leg,
crossbar), so opening the A is an exact operation: the crossbar contour is
dropped and the clay is placed at its centre. Letterfit measures 4.95:1
(width:cap-height) against the brand sheet's ~5.0:1.

They are still not the master artwork: the sheet's cut has visibly lighter
strokes than Instrument Sans ships at 400, which is the lightest weight
published. If the master is a custom-thinned cut, drop it in here and it
replaces these with no code change.

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
