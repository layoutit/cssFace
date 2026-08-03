# cssFace ☺

A [FacesJS](https://github.com/zengm-games/facesjs) to
[PolyCSS](https://github.com/LayoutitStudio/polycss) experiment that renders the
same `FaceConfig` as the original SVG and as a low-poly 3D bust made from real
HTML/CSS polygons. Both views share the same face, hair, features, skin, body,
and jersey colors. The 3D side uses no WebGL or canvas renderer.

Try it: [cssface.com](https://cssface.com)

## Run Locally

Use Node.js 22.12+ and pnpm 10.33. The compact faceline preparation artifact is
stored in Git; generated browser assets are not. Prepare those assets once:

```sh
pnpm install --frozen-lockfile
pnpm prepare:model
pnpm dev
```

`pnpm build` builds the Vite app from the prepared assets. Run
`pnpm prepare:model` again only when the source input, FacesJS presets, or
preparation code changes.

## How It Works

FacesJS remains the source of each 2D face and its `FaceConfig`. During
preparation, cssFace imports the selected SVG fragments, flattens and
triangulates their real contours, combines them with the tracked faceline
geometry, builds connected head and body geometry, merges eligible cells into
PolyCSS quads, and bakes the triangle fallback and 120-state yaw-lighting atlas.

The browser loads those prepared packages through
`@layoutit/polycss-morph` and mounts one retained DOM graph. Face controls patch
the prepared model without parsing SVG, rebuilding topology, or redrawing its
prepared assets at runtime. Generated browser packages stay ignored by Git. See
the [FacesJS adapter notes](src/adapters/facesjs/README.md) for the exact source,
geometry, and compatibility boundary.

## License

cssFace code is [MIT licensed](LICENSE). FacesJS styles are referenced at
revision `92c91d4b67893dbeef4053c25c04cc01fdd5419a` under Apache-2.0. The compact
faceline preparation artifact is included in the repository.
