# cssFace ☺

[FacesJS](https://github.com/zengm-games/facesjs) face objects rendered side by
side as their original SVG and real low-poly HTML/CSS 3D geometry through
[PolyCSS](https://github.com/LayoutitStudio/polycss). cssFace keeps the face,
hair, features, skin, body, and jersey colors aligned between both views without
a WebGL or canvas renderer.

The current prototype is a focused compatibility slice, not the complete
FacesJS catalog. Its wiggly seed control and Randomize button create
reproducible face configurations; the same seed drives the source SVG and its
prepared 3D bust. The 3D face supports drag rotation, prepared lighting,
sharing, and FaceConfig download.

## Run locally

Use Node.js 22.12+ and pnpm 10.33. The Wii `RFL_Res.dat` used for the low-poly
faceline is not included. Place a user-owned copy at
`.local/facesjs/RFL_Res.dat`, then prepare the browser assets once:

```sh
pnpm install --frozen-lockfile
pnpm prepare:model
pnpm dev
```

`pnpm build` builds the Vite app from the prepared assets. Run
`pnpm prepare:model` again only when the source input, FacesJS presets, or
preparation code changes.

## How it works

FacesJS remains the source of each 2D face and its `FaceConfig`. During
preparation, cssFace flattens and triangulates the selected FacesJS SVG paths,
combines them with the locally extracted faceline, builds connected head and
body geometry, merges eligible cells into PolyCSS quads, and bakes the triangle
fallback and rotation-lighting assets.

The browser loads those prepared packages through
`@layoutit/polycss-morph` and mounts one retained DOM graph. Face controls patch
the prepared model without parsing SVG or rebuilding topology at runtime. The
generated facelines and browser packages stay ignored and local.

The supported slice currently covers the `short`, `short2`, `afro`, and `bald`
hair presets, a small selection of eyes, noses, and mouths, plus shared face and
body proportions. See the [FacesJS adapter notes](src/adapters/facesjs/README.md)
for the exact boundary.

## License

cssFace code is [MIT licensed](LICENSE). FacesJS styles are referenced at
revision `92c91d4b67893dbeef4053c25c04cc01fdd5419a` under Apache-2.0. Nintendo
RFL data and generated derivatives are not included and remain subject to their
original terms.
