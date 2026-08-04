# FacesJS Compatibility Closure

Repo: `/Users/ekrof/fed/cssface`

## Goal

Replace the current four-preset FacesJS compatibility slice with a source-derived, componentized adapter that can render arbitrary `facesjs@5.0.3` `FaceConfig` objects wherever the upstream SVGs and display semantics permit a defensible 3D interpretation.

The frozen starting point is 326 SVG ids across 16 FacesJS feature families. The current preparation allowlist names 35 of those ids, the four shipped presets exercise 18 distinct ids, and Randomize uses only three presets. The current four generated model packages total 7,009,325 bytes. Closure means every upstream id and every `FaceConfig` property is either:

- supported by source-derived prepared geometry with browser proof; or
- explicitly classified as unsupported, with the exact source limitation and a rendered counterexample.

No id may silently disappear, substitute another id, or inherit a support claim from an untested family.

## Guardrails

- Treat `facesjs@5.0.3`, its exported SVG catalog, `build/display.js`, `build/common.d.ts`, and the already pinned FacesJS source revision as the semantic authority.
- Preserve FacesJS layer order, positions, paired-feature mirroring, angles, flips, sizes, fatness behavior, color substitutions, hat/hair substitutions, and body/jersey coupling. Do not guess field meanings.
- Record adapter-authored depth rules as adapter behavior. A 2D SVG silhouette is not evidence that FacesJS supplied 3D depth.
- Parse, flatten, triangulate, classify, weld, light, and package SVG geometry during Node preparation. The browser must not parse SVG paths, triangulate, redraw atlases, or generate topology.
- Do not prebuild the Cartesian product of feature choices. Prepare reusable base and component assets, load only the selected components, and keep unrelated variants off the network path.
- Preserve retained DOM during orbit, morph, and rotation-lighting updates. A deliberate `FaceConfig` change may swap component groups; per-frame topology rebuilds remain forbidden.
- Keep the current Classic, Afro, Bald, and Short2 results as named regression fixtures until the replacement passes source, visual, and performance gates.
- Keep generated packages and captures ignored. Track contracts, deterministic preparation code, compact fixtures, reports, and tests.
- Solve CSSFace-specific needs in `/Users/ekrof/fed/cssface` first. If a genuinely generic PolyCSS or Morph capability is missing, stop and write the minimal upstream requirement before touching `/Users/ekrof/fed/polycss`; its architectural and cross-package rules require separate approval and a separate PR.
- Preserve the existing unrelated edits to `README.md` and `src/adapters/facesjs/preview/main.ts`. Stop before editing either file if those changes still overlap the active item.
- This Burnlist does not authorize commits, pushes, pull requests, deployments, package publication, or other external side effects.

## Proof Authority

- Catalog proof: a deterministic checker compares the tracked compatibility matrix with the exact 326 ids exported by the installed FacesJS version and fails on missing, extra, or duplicate ids.
- Semantic proof: generated fixtures compare selected source fragment ids, source hashes, layer order, transforms, color roles, and hat/hair rules with FacesJS `display` / SVG output for the same `FaceConfig`.
- Preparation proof: two clean preparations from identical inputs produce identical manifests, model hashes, component hashes, and compact reports.
- Geometry proof: supported components have front-silhouette evidence plus clearance, seam, winding, and closed-surface checks appropriate to their strategy. Oblique and rear views are required for anything claiming volume.
- Painted proof: real Chromium captures show the FacesJS SVG and PolyCSS result for representative front, oblique, side, and rear views; every strategy family is represented and the browser has no Canvas/WebGL renderer, console errors, clipped face features, or missing leaves.
- Runtime proof: orbit and morph keep leaf identity stable, rotation lighting keeps its prepared sparse-transition behavior, and a face fetch does not load unselected component assets.
- Budget proof: selected-face transfer and rotation performance are checked against the frozen current baseline, not against an unrecorded subjective impression.

## Ordering Intent

Freeze the source/catalog and current runtime baseline first. Introduce the non-Cartesian component contract next, then make colors and scalar transforms independent of preset preparation. Expand support from generic face-surface features to shells and bodies, classify hair before implementing its topology families, add accessories only after hair coupling exists, then expose arbitrary `FaceConfig` resolution and seeded randomization. Close with source differentials, painted browser evidence, performance/package gates, and exact documentation.

## Stop Conditions

- The installed FacesJS version, exported catalog, or pinned source revision differs from the frozen compatibility contract.
- A requested mapping depends on missing or provenance-mismatched source data, or would require presenting an invented 3D interpretation as FacesJS-authored geometry.
- A generic strategy opens seams, clips a face feature, changes upstream layer semantics, or requires a per-combination prepared model.
- The runtime begins parsing original SVG data, triangulating, rebuilding topology per frame, redrawing atlases during orbit, or loading the whole catalog for one face.
- A required capability would materially change PolyCSS or Morph architecture without explicit user approval.
- An active item would overwrite or reinterpret unrelated dirty work in the checkout.
- Browser evidence is unavailable or invalid; build/HTTP success alone cannot burn a visual item.

## Handoff

Move this folder to `notes/burnlists/inprogress/260802-001/` before execution. Start with B1 and burn exactly one validated item at a time by deleting it from the active checklist and appending a terse completion entry. B1 owns the exact support denominator and baseline, so later items must consume its tracked matrix rather than hard-code a second catalog. Feature-family items may proceed only after B2-B4 establish the shared component, color, and transform contracts. Do not begin public release work from this queue.
