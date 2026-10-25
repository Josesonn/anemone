# Making your own monitor theme

The monitor's ocean is split into two halves:

- **The engine** (`anemone/ui/static/ocean/`) decides how things *move*: creatures hunting, prey schooling, ripples spreading. You never need to edit it.
- **A theme** (`anemone/ui/static/themes/<name>.js`) decides how everything *looks*: creature shapes, prey characters, colours, the words in the panels, and how the prey schools.

So turning clownfish into dragons, birds or spaceships means writing a theme. You don't have to touch the engine.

## The quick workflow

1. **Start the monitor and give it some work to show.** Run these in two terminals:
   ```bash
   anemone ui
   ```
   ```bash
   anemone batch examples/stress.yaml
   ```
2. **Copy the theme.** `clownfish.js` is the full example, with every shape written out.
3. **Rename it.** Save the copy as `themes/dragons.js`, then change `name: "dragons"` inside it.
4. **Open it:** `http://127.0.0.1:7400/?theme=dragons`. Without `?theme=`, the monitor shows `clownfish`.
5. **Edit, save, reload, repeat.** If the page shows nothing, press F12 and check the **Console** tab for a typo. A theme that fails to load falls back to `clownfish` and logs why.

## What's in a theme

A theme is a JavaScript file that exports one object. The examples below use the fields from `clownfish.js`.

### Words

```js
words: { creature: "clownfish", creatures: "clownfish", prey: "fish", place: "reef" },
```

These are used in the monitor's text, for example "The ocean is quiet". For dragons you might write `{ creature: "dragon", creatures: "dragons", prey: "ember", place: "sky" }`.

### Scene colours

| Field | What it colours |
|---|---|
| `background` | The page behind everything, a CSS colour such as `"#000"` |
| `grid` | The faint cell grid lines |
| `wake` | Ripple dots where things swim, as `[r, g, b]` |
| `prey.glyph` | The character drawn for each prey, such as `"-"` |
| `prey.rgb` | Prey colour |
| `prey.queuedRgb` / `prey.queuedGlyph` | Prey that stand for **queued tasks** |
| `heat` | The flash where a prey gets eaten: `hot`, `warm` and two `glyphs` |
| `bait` | Food dropped in aquarium mode: a `glyph` and an `rgb` colour |
| `label.rgb` | The task label floating above each creature |
| `font` | A monospace font. Every character has to be the same width |

### Creature skin

```js
glyphs: { skin: ":;t%SX8#@", fin: "%;tS:", ridge: "@8%", edgeHeavy: ":;", edgeLight: ".',`", mark: "#%@", eye: "o" },
eyeColor: "#9aa0ad",
accents: ["#e0892c", "#e03a32", ...],
```

- `skin` runs from bright to shadowed. The first characters are used where the body catches the light, and the last ones in shadow, so put sparse characters first and dense ones last.
- `edgeHeavy` and `edgeLight` soften the outline.
- `accents` are the occasional shimmer colours that sparkle on the skin.

### Creature shapes: the fun part

Each task kind is drawn as one of the shapes in `shapes`. The kind name is hashed to pick one, so `tests` always gets the same creature. Add or remove shapes freely, and the hashing adapts.

A creature is a flexible **spine** that the engine animates. The shape describes the body *around* that spine, using two numbers:

- **`s`** is how far along the body, from `0` at the head to `1` at the tail.
- **width** is given as a fraction of the creature's length.

```
s = 0 (head)                                   s = 1 (tail)
   >=============================================-
   |<----------------- length ----------------->|
```

| Field | Meaning |
|---|---|
| `halfWidth(s)` | **The body outline.** A function returning half the body's width at `s`. A typical fish is thin at the snout, widest about a third of the way along, then thin towards the tail. |
| `pectoral: [start, end, tip, reach]` | The big side fins, or *wings*: where their root starts and ends along the body, where the tip points, and how far it reaches out |
| `falcate` | `true` cuts a notch into the back edge of the side fins, giving a sickle shape |
| `pelvic: [start, end, tip, reach]` | A smaller pair of fins further back |
| `caudal` | Size of a forked tail fin. `0` means no tail fin |
| `dorsal: [from, to]` | A bright stripe down the middle of the back. `secondDorsal` is a smaller one |
| `head` | Optional wide bar across the head, like a hammerhead's |
| `eye: [from, to]` | Where the eyes sit along the body. `null` hides them |
| `gills: [from, to]` | A band of darker stripes |
| `tint: [r, g, b]` | Skin colour multipliers. `[1, 1, 1]` is grey; `[1.2, 0.8, 0.6]` is warm orange |
| `marking(s, v, L, across, id)` | Optional. Return `true` to paint a dark marking at that point, for spots or stripes. `across` runs from 0 at the centre line to 1 at the edge |
| `ridges(s, across)` | Optional. Return `true` for pale stripes |
| `band(s, across)` | Optional. Return `true` to paint the skin white whatever the `tint`, like a clownfish's bands. `glyphs.band` sets their characters |

**A dragon, for example:**

```js
dragon: {
  // long thin neck, chunky chest, then a long whip of a tail
  halfWidth: (s) => (s < 0.1 ? 0.03 : s < 0.3 ? 0.03 + 0.08 * ((s - 0.1) / 0.2) : 0.11 * Math.pow(1 - (s - 0.3) / 0.7, 1.6) + 0.004),
  pectoral: [0.22, 0.4, 0.55, 0.45], falcate: true,   // huge swept-back wings
  pelvic: [0.55, 0.6, 0.64, 0.05], caudal: 0.06,
  dorsal: [0.15, 0.7], secondDorsal: [0.8, 0.82],      // spines along the whole back
  eye: [0.03, 0.06], gills: [0.08, 0.1],
  tint: [1.25, 0.7, 0.45],                              // ember red
  marking: (s, v, L, across) => across > 0.5 && Math.sin(s * 80) > 0.6,  // scales
},
```

To check your work, save it, reload, and hover over a creature: the tooltip's **"drawn as"** line shows which shape it's using.

### Prey behaviour

```js
species: [
  { name: "sardine", cruise: 36, maxSpeed: 64, minSpeed: 18, weight: 3, schoolSize: [18, 28], spacing: [1.8, 1.1],
    align: 1.6, cohesion: 1.6, jitter: 40, mill: 70, verticalDrag: 0.5 },
  ...
]
```

Each entry is a kind of school:

- **`cruise`, `maxSpeed`, `minSpeed`:** speeds in pixels per second.
- **`weight`:** how often this school appears compared with the others.
- **`schoolSize`:** the smallest and largest school.
- **`spacing`:** personal space in grid cells.
- **`align`:** high makes neat ribbons.
- **`cohesion`:** high makes tight balls.
- **`jitter`:** high makes buzzing swarms. Good for embers or insects.
- **`mill`:** above `0`, the school spins in a ring.
- **`verticalDrag`:** high keeps them level, like fish. Use `0` for things that fly in any direction, like sparks or birds.

## Reusing another theme

You don't have to copy everything. Spread an existing theme and override only what you change:

```js
import clownfish from "./clownfish.js";
export default { ...clownfish, name: "sunset", background: "#120404", wake: [255, 140, 60] };
```

## Debugging in the browser

Press **F12**, then open **Console**. The page exposes a handle:

```js
anemoneMonitor.theme                       // the active theme object
anemoneMonitor.engine.world.creatures      // every creature: position, size, kind, task id
anemoneMonitor.engine.world.fish.length    // how many prey there are
```

## Sharing your theme

A theme is a single `.js` file. Send it to someone and they drop it into `anemone/ui/static/themes/`, and it appears in the menu.
