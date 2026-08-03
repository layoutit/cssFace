# FacesJS adapter

[`presets.json`](./presets.json) defines the four supported FacesJS faces and
their matching prepared PolyCSS model IDs. This is intentionally a small
compatibility slice rather than the full FacesJS catalog: `short`, `short2`,
`afro`, and `bald` hair with two eye, two nose, and two mouth styles. The source
panel renders each preset with `facesjs@5.0.3`; its source revision is
`92c91d4b67893dbeef4053c25c04cc01fdd5419a` and is Apache-2.0 licensed.

The preparation script imports the selected fragments from FacesJS's exported
`svgs` catalog, flattens their paths, and triangulates their actual contours.
Those source-derived polygons define the front head and hair silhouettes,
eyes, eyebrows, nose, mouth, and ears. The body contour supplies the bust's
profile rows, while the jersey contour splits those rows into connected skin
and jersey cells with shared boundary vertices, preserving the FacesJS tank-top
opening without a second overlapping shell. Accepted planar triangle pairs are
merged into PolyCSS quads, and the triangle fallback plus 120-state yaw-lighting
atlas are baked. For every
non-bald preset, preparation cuts the faceline to the front hairline and
triangulates a style-specific rear closure between the remaining faceline
boundary and the untouched back hair arc. Afro owns that closure as a lower
hair skirt; the shorter styles retain skin beneath their existing hairline.
Every skin/hair seam has identical base and morph vertices. Runtime deformation
retains the same DOM leaves; it does not parse SVG or rebuild topology. Random
switches to a different prepared identity, then varies the four shared morph
controls.

The compact eight-faceline preparation artifact is stored in Git. Prepared
browser packages are generated locally and remain ignored.

```sh
pnpm prepare:model
pnpm dev
```
