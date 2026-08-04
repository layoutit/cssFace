# CSSFace seed contract

The browser demo maps integer seeds from 0 through 9999 to one of 332 complete
FacesJS `FaceConfig` entries: the six compatibility fixtures in `presets.json`
plus one component-directed face for each of the 326 supported catalog entries.
It is a deterministic prepared-model selector, not a claim of FacesJS
demographic, probability-distribution, or full component-combination parity.

The seed is mixed as an unsigned 32-bit integer and reduced by the tracked
CSSGraphics package count. Randomize draws another seed whose prepared model id
differs from the currently mounted model when more than one model exists. Each
face was resolved from the validated 326-component catalog during Node
preparation, including coupled hair and FacesJS substitution rules.

Share URLs store the canonical config as well as the seed, so links do not
depend on regenerating it with a future generator version. Downloads export the
current FacesJS and PolyCSS renders as separate PNG images.
