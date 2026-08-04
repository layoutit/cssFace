import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FACES_JS_DISPLAY_LAYERS,
  FACES_JS_TRANSFORM_BOUNDS,
  resolveFacesJsDisplayTransforms,
  resolveFacesJsMorphWeights,
  validateFacesJsFaceConfig,
} from "../.build/prepare/src/adapters/facesjs/player/configTransforms.js";

const presets = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/presets.json", import.meta.url),
  "utf8",
));
const classic = presets.find(({ id }) => id === "classic")?.face;
assert.ok(classic, "classic FacesJS fixture is required");

function faceWith(overrides = {}) {
  const face = structuredClone(classic);
  for (const [key, value] of Object.entries(overrides)) {
    face[key] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...face[key], ...value }
      : value;
  }
  return face;
}

function transformsFor(config, family) {
  return resolveFacesJsDisplayTransforms(config)
    .filter((transform) => transform.family === family);
}

test("the strict FaceConfig contract accepts every tracked fixture", () => {
  assert.deepEqual(FACES_JS_DISPLAY_LAYERS, [
    "hairBg", "body", "jersey", "ear", "head", "eyeLine", "smileLine",
    "miscLine", "facialHair", "eye", "eyebrow", "mouth", "nose", "hair",
    "glasses", "accessories",
  ]);
  for (const preset of presets) {
    assert.deepEqual(validateFacesJsFaceConfig(preset.face), preset.face);
  }
  assert.deepEqual(FACES_JS_TRANSFORM_BOUNDS, {
    fatness: [0, 1],
    "body.size": [0.8, 1.05],
    "ear.size": [0.5, 1.5],
    "eye.angle": [-10, 15],
    "eyebrow.angle": [-15, 20],
    "nose.size": [0.5, 1.25],
    "smileLine.size": [0.25, 2.25],
  });
});

test("display transforms reproduce FacesJS paired, size, and fatness semantics", () => {
  const config = faceWith({
    fatness: 0,
    body: { size: 0.8 },
    ear: { size: 1.5 },
    eye: { angle: -10 },
    eyebrow: { angle: 20 },
    smileLine: { size: 2.25 },
  });
  assert.deepEqual(transformsFor(config, "body")[0].scale, [0.8, 1]);
  assert.deepEqual(transformsFor(config, "jersey")[0].scale, [0.8, 1]);

  const ears = transformsFor(config, "ear");
  assert.deepEqual(ears.map(({ position }) => position), [[55, 325], [345, 325]]);
  assert.deepEqual(ears.map(({ mirrorX }) => mirrorX), [false, true]);
  assert.deepEqual(ears.map(({ scale }) => scale), [[1.5, 1.5], [-1.5, 1.5]]);
  assert.deepEqual(ears.map(({ fatnessEdgeDistance }) => fatnessEdgeDistance), [31, 31]);

  const eyes = transformsFor(config, "eye");
  assert.deepEqual(eyes.map(({ angle }) => angle), [-10, 10]);
  assert.deepEqual(eyes.map(({ mirrorX }) => mirrorX), [false, true]);
  assert.deepEqual(
    transformsFor(config, "eyebrow").map(({ angle }) => angle),
    [20, -20],
  );
  assert.deepEqual(
    transformsFor(config, "smileLine").map(({ scale }) => scale),
    [[2.25, 2.25], [-2.25, 2.25]],
  );
  assert.equal(transformsFor(config, "head")[0].fatnessScaleX, 0.8);
  assert.equal(transformsFor(faceWith({ fatness: 1 }), "head")[0].fatnessScaleX, 1);
});

test("explicit flips and the Pinocchio alignment exception match FacesJS", () => {
  const flipped = faceWith({
    hair: { flip: true },
    mouth: { flip: true },
    nose: { id: "nose4", flip: true },
  });
  assert.equal(transformsFor(flipped, "hair")[0].mirrorX, true);
  assert.deepEqual(transformsFor(flipped, "hair")[0].scale, [-1, 1]);
  assert.equal(transformsFor(flipped, "mouth")[0].mirrorX, true);
  assert.equal(transformsFor(flipped, "nose")[0].xAlign, "right");
  assert.equal(
    transformsFor(faceWith({ nose: { id: "pinocchio", flip: false } }), "nose")[0].xAlign,
    "left",
  );
  assert.equal(transformsFor(faceWith({ nose: { id: "nose3" } }), "nose")[0].xAlign, "center");
});

test("morph weights cover scalar endpoints, signed angles, and flip states", () => {
  const minimum = resolveFacesJsMorphWeights(faceWith({
    fatness: 0,
    body: { size: 0.8 },
    ear: { size: 0.5 },
    eye: { angle: -10 },
    eyebrow: { angle: -15 },
    nose: { size: 0.5, flip: false },
    smileLine: { size: 0.25 },
  }));
  assert.equal(minimum.fatness, 0);
  assert.equal(minimum["body-size"], 0);
  assert.equal(minimum["ear-size"], 0);
  assert.equal(minimum["eye-angle-negative"], 1);
  assert.equal(minimum["eye-angle-positive"], 0);
  assert.equal(minimum["brow-up"], 1);
  assert.equal(minimum["brow-down"], 0);
  assert.equal(minimum["nose-size-min"], 1);
  assert.equal(minimum["nose-size-max"], 0);
  assert.equal(minimum["smile-line-size-min"], 1);
  assert.equal(minimum["smile-line-size-max"], 0);

  const maximum = resolveFacesJsMorphWeights(faceWith({
    fatness: 1,
    body: { size: 1.05 },
    ear: { size: 1.5 },
    eye: { angle: 15 },
    eyebrow: { angle: 20 },
    nose: { size: 1.25, flip: true },
    smileLine: { size: 2.25 },
    hair: { flip: true },
    mouth: { flip: true },
  }));
  for (const id of [
    "fatness", "body-size", "ear-size", "eye-angle-positive", "brow-down",
    "nose-size-max", "smile-line-size-max", "hair-flip", "mouth-flip", "nose-flip",
    "eye-angle-positive-fatness", "brow-down-fatness", "nose-size-max-fatness",
  ]) assert.equal(maximum[id], 1, `${id} reaches its maximum`);
  for (const id of [
    "eye-angle-negative", "brow-up", "nose-size-min", "smile-line-size-min",
  ]) assert.equal(maximum[id], 0, `${id} keeps its opposite endpoint inactive`);

  assert.deepEqual(
    resolveFacesJsMorphWeights(faceWith(), new Set(["fatness", "nose-flip"])),
    { fatness: classic.fatness, "nose-flip": 0 },
  );
});

test("invalid and ambiguous FaceConfig values fail explicitly", () => {
  assert.throws(() => validateFacesJsFaceConfig(faceWith({ fatness: -0.01 })), /between 0 and 1/u);
  assert.throws(() => validateFacesJsFaceConfig(faceWith({ body: { size: 1.051 } })), /body\.size/u);
  assert.throws(() => validateFacesJsFaceConfig(faceWith({ eye: { angle: "0" } })), /eye\.angle must be finite/u);
  assert.throws(() => validateFacesJsFaceConfig(faceWith({ hair: { flip: 1 } })), /hair\.flip must be boolean/u);
  assert.throws(
    () => validateFacesJsFaceConfig({ ...faceWith(), surprise: true }),
    /must contain exactly/u,
  );
  assert.throws(
    () => validateFacesJsFaceConfig(faceWith({ head: { shave: "transparent" } })),
    /black rgba color/u,
  );
});
