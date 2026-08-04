# FacesJS adapter

This adapter targets `facesjs@5.0.3` at source revision
`92c91d4b67893dbeef4053c25c04cc01fdd5419a` (Apache-2.0). The tracked
[`compatibility.json`](./compatibility.json) matrix is authoritative: all 326
catalog ids are supported, none are unsupported, and eight are intentional
source-empty choices.

| Family | Supported | Unsupported | Source-empty |
| --- | ---: | ---: | ---: |
| accessories | 8 | 0 | 1 |
| body | 5 | 0 | 0 |
| ear | 3 | 0 | 0 |
| eye | 35 | 0 | 0 |
| eyeLine | 7 | 0 | 1 |
| eyebrow | 30 | 0 | 0 |
| facialHair | 83 | 0 | 1 |
| glasses | 7 | 0 | 1 |
| hair | 51 | 0 | 1 |
| hairBg | 8 | 0 | 1 |
| head | 21 | 0 | 0 |
| jersey | 18 | 0 | 0 |
| miscLine | 11 | 0 | 1 |
| mouth | 17 | 0 | 0 |
| nose | 17 | 0 | 0 |
| smileLine | 5 | 0 | 1 |
| **Total** | **326** | **0** | **8** |

`presets.json` contains the six compatibility fixtures. `prepare:model` also
builds one component-directed complete face for every supported catalog entry,
then writes all 332 optimized faces to `public/cssgraphics/`. The browser loads
`public/cssgraphics/faces.json`; Random therefore selects final prepared face
packages instead of composing geometry or lighting at runtime. The component
catalog remains a Node-only preparation and differential testing boundary; it
is not a claim that every possible combination is available as a prebuilt model.
Each catalog row also has a deterministic numeric id, and its standalone face
document is published at `/f/<id>.json` with its prepared rotation-lighting
atlas files beside it.

## FaceConfig boundary

The adapter validates and applies these 30 paths:

```text
fatness, teamColors,
hairBg.id,
body.id, body.color, body.size,
jersey.id,
ear.id, ear.size,
head.id, head.shave,
eyeLine.id,
smileLine.id, smileLine.size,
miscLine.id,
facialHair.id,
eye.id, eye.angle,
eyebrow.id, eyebrow.angle,
hair.id, hair.color, hair.flip,
mouth.id, mouth.flip,
nose.id, nose.flip, nose.size,
glasses.id,
accessories.id
```

Unknown ids, incomplete objects, unsupported fields, invalid colors, and
out-of-range scalar values fail with structured config-resolution errors. Hat
selection follows FacesJS's exact substitute-short, substitute-short-fade, or
hide rule. Coupled long hair resolves its declared `hairBg` dependency.

## Preparation architecture

`component-catalog.json` records one source-hash-bound package for every id.
The component graph contains one reusable bust base plus independently loadable
parts. It is consumed by Node preparation only. For each entry in
`presets.json` and each supported component, the producer resolves a complete
selected graph, applies FaceConfig morphs and material colors, converts the
resulting geometry to canonical PolyCSS world coordinates, and emits one
complete CSSGraphics JSON package.

Offline preparation preserves FacesJS's front contours, paint, gradients,
layer order, transforms, and empty outcomes. Projected eyes, brows, noses,
mouths, linework, facial hair, and glasses are raised above the attachment
surface. Heads, ears, bodies, jerseys, hair masses, rear hair, headbands, and
hats receive connected or closed low-poly volume according to their tracked
strategy.

Depth, side surfaces, and rear closures are CSSFace adapter geometry; FacesJS
does not provide them. The adapter therefore claims source fidelity for the
front SVG semantics and measured front silhouette, not an upstream 3D model.

## Runtime behavior

The producer uses the shared CSSGraphics package writer. Every model directory
contains `manifest.json`, gzip-compressed JSON `model.json`, and `model.css`.
The model uses the `cssgraphics.model@1` standard and `facesjs-face` profile.
Its JSON carries the selected FaceConfig, preparation provenance, and plain
colored `Polygon[]`. PolyCSS's lossless optimizer is used during preparation;
CSSFace does not prepare or emit `<b>`, `<i>`, `<s>`, `<u>`, or any other
renderer leaf.

The site's private loader validates `catalog.json`, the selected manifest, and
its model JSON, then passes the polygons to `createPolyScene` from
`@layoutit/polycss`. It is application code, not a CSSFace package API.
PolyCSS chooses and mounts the DOM render strategies. A drag writes one
transform to the PolyCSS mesh root.
Switching a seed destroys the previous lifecycle and mounts another complete
package. The browser never requests `/facesjs-components/`; that catalog is
preparation input only.

The preview's FacesJS sample still imports `display` directly from `facesjs`.
The 3D sample imports `@layoutit/polycss` directly and passes the selected face
document to `createPolyScene`. Its editable Classic CodePen draft fetches the
selected numeric document and prepared lighting URLs, then uses the public
PolyCSS ESM build; it does not import CSSFace or depend on localhost.

## Randomization

[`GENERATOR.md`](./GENERATOR.md) defines the demo seed selector. Seeds 0–9999
deterministically select one of the 332 prepared models. Every supported
component is reachable in at least one complete face. This is not FacesJS
population, probability-distribution, or full combination coverage. Share URLs
embed the selected canonical config and seed. Downloads export separate PNG
images of the current FacesJS and PolyCSS renders.

## Build and verification

Generated browser packages remain ignored by Git:

```sh
pnpm build:facesjs-components
pnpm prepare:model
pnpm dev
```

The current prepared-model gate is:

```sh
pnpm prepare:model -- --check
pnpm test:facesjs
pnpm check
```

The catalog/corpus/oracle tools remain preparation evidence for the
326-component graph. Runtime accepts only the final prepared face catalog;
component composition and package optimization remain Node-only gates.

## Current limitations

- Support is pinned to the exact FacesJS version and revision above; a newer
  catalog must be re-frozen and re-proved.
- CSSFace-authored depth is an interpretation of the 2D source, not FacesJS
  canonical 3D data.
- The demo selector covers every supported component in at least one complete
  prepared face, not every possible combination of the 326 component ids.
- Prepared output is intentionally generated locally; one rendered face loads
  one JSON model package containing only its face data.
- Runtime rendering requires browser support for DOM/CSS 3D transforms,
  `DecompressionStream`, and the PolyCSS strategies selected for its polygons.
