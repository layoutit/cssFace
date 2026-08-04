# cssFace

[cssFace](https://cssface.com) renders one FacesJS `FaceConfig` twice: the
original [FacesJS](https://github.com/zengm-games/facesjs) SVG and a prepared
[PolyCSS](https://github.com/LayoutitStudio/polycss) low-poly bust. Both views
use the same feature ids, transforms, colors, body, and jersey. The 3D renderer
is retained HTML/CSS: no Canvas or WebGL renderer.

The offline adapter accepts all 326 component ids exposed by `facesjs@5.0.3`
across 16 families, including its eight intentional empty choices, and
validates all 30 tracked `FaceConfig` property paths. The browser demo is a
bounded honest surface: it ships six compatibility fixtures plus one complete,
deterministic face for every supported component, all prepared from that
catalog rather than composing arbitrary configs at runtime.

Use the seed control or Random to create a reproducible 2D/3D pair. Drag the
PolyCSS face to rotate it, share the exact config, download both rendered faces
as PNG images, or open the pair in a new Classic CodePen draft.

## Run locally

Use Node.js 22.12+ and pnpm 10.33. Generated browser packages are ignored by
Git and must be prepared before the app starts:

```sh
pnpm install --frozen-lockfile
pnpm build:facesjs-components
pnpm prepare:model
pnpm dev
```

`build:facesjs-components` writes the reusable base and 326 independently
selectable preparation inputs to `public/facesjs-components/`. `prepare:model`
writes 332 validated CSSGraphics model packages to `public/cssgraphics/` and
332 numeric, copy-pasteable face documents to `public/f/`. Each document keeps
its polygons and prepared rotation-lighting atlas together; for example,
`https://cssface.com/f/6.json` is prepared face `6`. The generated directories
are ignored. Run preparation again after changing FacesJS, geometry, presets,
or package code; `pnpm build` then builds the Vite app from those prepared
faces.

## How it works

FacesJS remains authoritative for the front-view SVG fragments, display order,
paint, and `FaceConfig` semantics. Node-only preparation composes each of the
six tracked presets plus a component-directed face for each supported catalog
entry, applies its morph values, triangulates the real source contours, adds
adapter-authored depth and rear closures, resolves the selected paint, converts
the authored CSS coordinates to PolyCSS world coordinates, and asks PolyCSS to
optimize the resulting polygons.

Each result is a `cssgraphics.model@1` JSON package using the `facesjs-face`
profile. Its model JSON carries the selected `FaceConfig`, source provenance,
and an ordinary colored `Polygon[]`; it does not carry renderer leaves, tags,
atlases, or a CSSFace rendering runtime.

The browser uses the shared CSSGraphics loader, fetches `catalog.json` and only
the selected package, then passes those polygons to `createPolyScene` from
`@layoutit/polycss`. PolyCSS alone selects and emits its DOM render strategies.
Dragging changes one PolyCSS mesh-root transform; the browser never loads
`/facesjs-components/`, parses SVG, or rebuilds topology.

CSSFace itself is a private site project, not an npm package. The code sample
and editable Classic CodePen draft import `@layoutit/polycss` directly.

Seeds 0–9999 deterministically select among the 332 prepared models. Every
supported component appears in at least one complete face, but this is not
FacesJS population parity or arbitrary component-combination generation. Share
URLs store the canonical selected `FaceConfig`; downloads export the current
FacesJS and PolyCSS renders as separate PNG images.

See the [FacesJS adapter notes](src/adapters/facesjs/README.md) for the exact
support matrix, source boundary, prepared-runtime contract, and limitations.

## License

cssFace code is [MIT licensed](LICENSE). FacesJS styles are referenced from
`facesjs@5.0.3`, revision
`92c91d4b67893dbeef4053c25c04cc01fdd5419a`, under Apache-2.0. The compact
faceline preparation artifact is included; the original `RFL_Res.dat` is not.
