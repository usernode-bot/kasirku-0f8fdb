# KasirKU icon

The app's icon is a cream cash register with a yellow receipt curling out of
the top, on a black tile. It is the motif Homeroom suggested for this app
("a receipt curling out of a simple cash register"), drawn in the Homeroom
brand framework's flat style: one bold mark, no text, no gradients or
shadows.

## Files

| File | Size | What it is |
| --- | --- | --- |
| `icon.svg` | 1024×1024 | Source of the app icon. Rendered to `icon.png`. |
| `icon.png` | 1024×1024 | The app icon, declared as `dapp.json` `icon.image`. The platform crops and rounds it onto the home-screen tile; the square corners are full bleed on purpose. |
| `featured-light.svg` / `featured-light.png` | 1600×900 | Featured illustration, light: Black register on Cream `#FFFEEA`, Yellow receipt outlined in Black so it reads on the light ground. |
| `featured-dark.svg` / `featured-dark.png` | 1600×900 | Featured illustration, dark: Cream register on Black `#000000`, Yellow receipt. |

The featured files use the same mark as the app icon, scaled about ×1.15 and
centred. The mark stays inside a centred square about 736 px wide, so a card
that crops the 1600×900 image to a square still shows it whole.

## Colours

Homeroom brand palette only, in the Black + Yellow and Cream + Black
pairings:

- Black `#000000`
- Cream `#FFFEEA`
- Yellow `#FFEE6F` (the receipt, the one splash of colour)

## Re-rendering the PNGs

The PNGs are committed artefacts; nothing in the app builds them. To change
the mark, edit the SVG, then render with resvg:

```sh
npx --yes @resvg/resvg-js-cli brand/icon.svg brand/icon.png
npx --yes @resvg/resvg-js-cli brand/featured-light.svg brand/featured-light.png
npx --yes @resvg/resvg-js-cli brand/featured-dark.svg brand/featured-dark.png
```

`icon.png` must stay under 256 KB and be an opaque PNG (the platform
validates it at deploy time; if it fails, the tile falls back to the 🧾
emoji kept in `dapp.json`).

## Featured icon status

`dapp.json` has no field the Homeroom directory reads for a featured image
(the directory API exposes only `icon_emoji` and `icon_url`), so the two
featured files are committed here ready to use, and are not wired into the
app's settings.
