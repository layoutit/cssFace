import {
  validateFacesJsHexColor,
  validateFacesJsShaveColor,
} from "./materialColors.js";

export const FACES_JS_DISPLAY_LAYERS = Object.freeze([
  "hairBg",
  "body",
  "jersey",
  "ear",
  "head",
  "eyeLine",
  "smileLine",
  "miscLine",
  "facialHair",
  "eye",
  "eyebrow",
  "mouth",
  "nose",
  "hair",
  "glasses",
  "accessories",
] as const);

export type FacesJsFeatureFamily = typeof FACES_JS_DISPLAY_LAYERS[number];

export interface FacesJsFaceConfig {
  readonly fatness: number;
  readonly teamColors: readonly [string, string, string];
  readonly hairBg: Readonly<{ id: string }>;
  readonly body: Readonly<{ id: string; color: string; size: number }>;
  readonly jersey: Readonly<{ id: string }>;
  readonly ear: Readonly<{ id: string; size: number }>;
  readonly head: Readonly<{ id: string; shave: string }>;
  readonly eyeLine: Readonly<{ id: string }>;
  readonly smileLine: Readonly<{ id: string; size: number }>;
  readonly miscLine: Readonly<{ id: string }>;
  readonly facialHair: Readonly<{ id: string }>;
  readonly eye: Readonly<{ id: string; angle: number }>;
  readonly eyebrow: Readonly<{ id: string; angle: number }>;
  readonly hair: Readonly<{ id: string; color: string; flip: boolean }>;
  readonly mouth: Readonly<{ id: string; flip: boolean }>;
  readonly nose: Readonly<{ id: string; flip: boolean; size: number }>;
  readonly glasses: Readonly<{ id: string }>;
  readonly accessories: Readonly<{ id: string }>;
}

export const FACES_JS_TRANSFORM_BOUNDS = Object.freeze({
  fatness: Object.freeze([0, 1] as const),
  "body.size": Object.freeze([0.8, 1.05] as const),
  "ear.size": Object.freeze([0.5, 1.5] as const),
  "eye.angle": Object.freeze([-10, 15] as const),
  "eyebrow.angle": Object.freeze([-15, 20] as const),
  "nose.size": Object.freeze([0.5, 1.25] as const),
  "smileLine.size": Object.freeze([0.25, 2.25] as const),
});

export interface FacesJsDisplayTransform {
  readonly family: FacesJsFeatureFamily;
  readonly instance: number;
  readonly position: readonly [number, number] | null;
  readonly xAlign: "center" | "left" | "right";
  readonly angle: number;
  readonly mirrorX: boolean;
  readonly scale: readonly [number, number];
  readonly fatnessScaleX: number;
  readonly fatnessEdgeDistance: number;
}

type JsonRecord = Record<string, unknown>;

const FEATURE_INFO = Object.freeze({
  hairBg: Object.freeze({ positions: [null], scaleFatness: true }),
  body: Object.freeze({ positions: [null], scaleFatness: false }),
  jersey: Object.freeze({ positions: [null], scaleFatness: false }),
  ear: Object.freeze({
    positions: [[55, 325] as const, [345, 325] as const],
    scaleFatness: true,
  }),
  head: Object.freeze({ positions: [null], scaleFatness: true }),
  eyeLine: Object.freeze({ positions: [null], scaleFatness: false }),
  smileLine: Object.freeze({
    positions: [[150, 435] as const, [250, 435] as const],
    scaleFatness: false,
  }),
  miscLine: Object.freeze({ positions: [null], scaleFatness: false }),
  facialHair: Object.freeze({ positions: [null], scaleFatness: true }),
  eye: Object.freeze({
    positions: [[140, 310] as const, [260, 310] as const],
    scaleFatness: false,
  }),
  eyebrow: Object.freeze({
    positions: [[140, 270] as const, [260, 270] as const],
    scaleFatness: false,
  }),
  mouth: Object.freeze({ positions: [[200, 440] as const], scaleFatness: false }),
  nose: Object.freeze({ positions: [[200, 370] as const], scaleFatness: false }),
  hair: Object.freeze({ positions: [null], scaleFatness: true }),
  glasses: Object.freeze({ positions: [null], scaleFatness: true }),
  accessories: Object.freeze({ positions: [null], scaleFatness: true }),
} satisfies Record<FacesJsFeatureFamily, {
  readonly positions: readonly (readonly [number, number] | null)[];
  readonly scaleFatness: boolean;
}>);

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(", ")}.`);
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}

function bounded(
  value: unknown,
  bounds: readonly [number, number],
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
  if (value < bounds[0] || value > bounds[1]) {
    throw new RangeError(`${label} must be between ${bounds[0]} and ${bounds[1]}.`);
  }
  return value;
}

function idFeature(value: unknown, label: string): Readonly<{ id: string }> {
  const input = record(value, label);
  exactKeys(input, ["id"], label);
  return Object.freeze({ id: id(input.id, `${label}.id`) });
}

function teamColors(value: unknown): readonly [string, string, string] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError("FacesJS FaceConfig.teamColors must contain exactly three colors.");
  }
  return Object.freeze([
    validateFacesJsHexColor(value[0], "FacesJS FaceConfig.teamColors[0]"),
    validateFacesJsHexColor(value[1], "FacesJS FaceConfig.teamColors[1]"),
    validateFacesJsHexColor(value[2], "FacesJS FaceConfig.teamColors[2]"),
  ]) as readonly [string, string, string];
}

export function validateFacesJsFaceConfig(value: unknown): FacesJsFaceConfig {
  const input = record(value, "FacesJS FaceConfig");
  exactKeys(input, ["fatness", "teamColors", ...FACES_JS_DISPLAY_LAYERS], "FacesJS FaceConfig");
  const body = record(input.body, "FacesJS FaceConfig.body");
  const ear = record(input.ear, "FacesJS FaceConfig.ear");
  const head = record(input.head, "FacesJS FaceConfig.head");
  const smileLine = record(input.smileLine, "FacesJS FaceConfig.smileLine");
  const eye = record(input.eye, "FacesJS FaceConfig.eye");
  const eyebrow = record(input.eyebrow, "FacesJS FaceConfig.eyebrow");
  const hair = record(input.hair, "FacesJS FaceConfig.hair");
  const mouth = record(input.mouth, "FacesJS FaceConfig.mouth");
  const nose = record(input.nose, "FacesJS FaceConfig.nose");
  exactKeys(body, ["id", "color", "size"], "FacesJS FaceConfig.body");
  exactKeys(ear, ["id", "size"], "FacesJS FaceConfig.ear");
  exactKeys(head, ["id", "shave"], "FacesJS FaceConfig.head");
  exactKeys(smileLine, ["id", "size"], "FacesJS FaceConfig.smileLine");
  exactKeys(eye, ["id", "angle"], "FacesJS FaceConfig.eye");
  exactKeys(eyebrow, ["id", "angle"], "FacesJS FaceConfig.eyebrow");
  exactKeys(hair, ["id", "color", "flip"], "FacesJS FaceConfig.hair");
  exactKeys(mouth, ["id", "flip"], "FacesJS FaceConfig.mouth");
  exactKeys(nose, ["id", "flip", "size"], "FacesJS FaceConfig.nose");
  return Object.freeze({
    fatness: bounded(input.fatness, FACES_JS_TRANSFORM_BOUNDS.fatness, "FacesJS FaceConfig.fatness"),
    teamColors: teamColors(input.teamColors),
    hairBg: idFeature(input.hairBg, "FacesJS FaceConfig.hairBg"),
    body: Object.freeze({
      id: id(body.id, "FacesJS FaceConfig.body.id"),
      color: validateFacesJsHexColor(body.color, "FacesJS FaceConfig.body.color"),
      size: bounded(body.size, FACES_JS_TRANSFORM_BOUNDS["body.size"], "FacesJS FaceConfig.body.size"),
    }),
    jersey: idFeature(input.jersey, "FacesJS FaceConfig.jersey"),
    ear: Object.freeze({
      id: id(ear.id, "FacesJS FaceConfig.ear.id"),
      size: bounded(ear.size, FACES_JS_TRANSFORM_BOUNDS["ear.size"], "FacesJS FaceConfig.ear.size"),
    }),
    head: Object.freeze({
      id: id(head.id, "FacesJS FaceConfig.head.id"),
      shave: validateFacesJsShaveColor(head.shave, "FacesJS FaceConfig.head.shave"),
    }),
    eyeLine: idFeature(input.eyeLine, "FacesJS FaceConfig.eyeLine"),
    smileLine: Object.freeze({
      id: id(smileLine.id, "FacesJS FaceConfig.smileLine.id"),
      size: bounded(smileLine.size, FACES_JS_TRANSFORM_BOUNDS["smileLine.size"], "FacesJS FaceConfig.smileLine.size"),
    }),
    miscLine: idFeature(input.miscLine, "FacesJS FaceConfig.miscLine"),
    facialHair: idFeature(input.facialHair, "FacesJS FaceConfig.facialHair"),
    eye: Object.freeze({
      id: id(eye.id, "FacesJS FaceConfig.eye.id"),
      angle: bounded(eye.angle, FACES_JS_TRANSFORM_BOUNDS["eye.angle"], "FacesJS FaceConfig.eye.angle"),
    }),
    eyebrow: Object.freeze({
      id: id(eyebrow.id, "FacesJS FaceConfig.eyebrow.id"),
      angle: bounded(eyebrow.angle, FACES_JS_TRANSFORM_BOUNDS["eyebrow.angle"], "FacesJS FaceConfig.eyebrow.angle"),
    }),
    hair: Object.freeze({
      id: id(hair.id, "FacesJS FaceConfig.hair.id"),
      color: validateFacesJsHexColor(hair.color, "FacesJS FaceConfig.hair.color"),
      flip: boolean(hair.flip, "FacesJS FaceConfig.hair.flip"),
    }),
    mouth: Object.freeze({
      id: id(mouth.id, "FacesJS FaceConfig.mouth.id"),
      flip: boolean(mouth.flip, "FacesJS FaceConfig.mouth.flip"),
    }),
    nose: Object.freeze({
      id: id(nose.id, "FacesJS FaceConfig.nose.id"),
      flip: boolean(nose.flip, "FacesJS FaceConfig.nose.flip"),
      size: bounded(nose.size, FACES_JS_TRANSFORM_BOUNDS["nose.size"], "FacesJS FaceConfig.nose.size"),
    }),
    glasses: idFeature(input.glasses, "FacesJS FaceConfig.glasses"),
    accessories: idFeature(input.accessories, "FacesJS FaceConfig.accessories"),
  });
}

function featureAngle(config: FacesJsFaceConfig, family: FacesJsFeatureFamily): number {
  if (family === "eye") return config.eye.angle;
  if (family === "eyebrow") return config.eyebrow.angle;
  return 0;
}

function featureFlip(config: FacesJsFaceConfig, family: FacesJsFeatureFamily): boolean {
  if (family === "hair") return config.hair.flip;
  if (family === "mouth") return config.mouth.flip;
  if (family === "nose") return config.nose.flip;
  return false;
}

function featureScale(config: FacesJsFaceConfig, family: FacesJsFeatureFamily): number {
  if (family === "ear") return config.ear.size;
  if (family === "nose") return config.nose.size;
  if (family === "smileLine") return config.smileLine.size;
  return 1;
}

export function resolveFacesJsDisplayTransforms(
  configInput: unknown,
): readonly FacesJsDisplayTransform[] {
  const config = validateFacesJsFaceConfig(configInput);
  const fatnessScaleX = 0.8 + (0.2 * config.fatness);
  const fatnessEdgeDistance = 31 * (1 - config.fatness);
  return Object.freeze(FACES_JS_DISPLAY_LAYERS.flatMap((family) => {
    const info = FEATURE_INFO[family];
    return info.positions.map((position, instance) => {
      const flip = featureFlip(config, family);
      const scale = featureScale(config, family);
      const bodyScale = family === "body" || family === "jersey"
        ? config.body.size
        : scale;
      const pinocchio = family === "nose"
        && (config.nose.id === "nose4" || config.nose.id === "pinocchio");
      return Object.freeze({
        family,
        instance,
        position,
        xAlign: pinocchio ? (flip ? "right" : "left") : "center",
        angle: (instance === 0 ? 1 : -1) * featureAngle(config, family),
        mirrorX: flip || instance === 1,
        scale: Object.freeze([
          (flip || instance === 1 ? -1 : 1) * bodyScale,
          family === "body" || family === "jersey" ? 1 : bodyScale,
        ] as const),
        fatnessScaleX: info.scaleFatness && position === null ? fatnessScaleX : 1,
        fatnessEdgeDistance:
          info.scaleFatness && position !== null ? fatnessEdgeDistance : 0,
      });
    });
  }));
}

function piecewise(
  value: number,
  minimum: number,
  neutral: number,
  maximum: number,
): readonly [number, number] {
  return value < neutral
    ? [(neutral - value) / (neutral - minimum), 0]
    : [0, (value - neutral) / (maximum - neutral)];
}

export function resolveFacesJsMorphWeights(
  configInput: unknown,
  availableTargetIds?: ReadonlySet<string>,
): Readonly<Record<string, number>> {
  const config = validateFacesJsFaceConfig(configInput);
  const [noseMinimum, noseMaximum] = piecewise(config.nose.size, 0.5, 1, 1.25);
  const [smileMinimum, smileMaximum] = piecewise(
    config.smileLine.size,
    0.25,
    1,
    2.25,
  );
  const values: Record<string, number> = {
    fatness: config.fatness,
    "body-size": (config.body.size - 0.8) / 0.25,
    "ear-size": (config.ear.size - 0.5) / 1,
    "eye-angle-negative": Math.max(0, -config.eye.angle / 10),
    "eye-angle-positive": Math.max(0, config.eye.angle / 15),
    "brow-up": Math.max(0, -config.eyebrow.angle / 15),
    "brow-down": Math.max(0, config.eyebrow.angle / 20),
    "nose-size-min": noseMinimum,
    "nose-size-max": noseMaximum,
    "smile-line-size-min": smileMinimum,
    "smile-line-size-max": smileMaximum,
    "hair-flip": Number(config.hair.flip),
    "mouth-flip": Number(config.mouth.flip),
    "nose-flip": Number(config.nose.flip),
  };
  values["eye-angle-negative-fatness"] = values["eye-angle-negative"] * config.fatness;
  values["eye-angle-positive-fatness"] = values["eye-angle-positive"] * config.fatness;
  values["brow-up-fatness"] = values["brow-up"] * config.fatness;
  values["brow-down-fatness"] = values["brow-down"] * config.fatness;
  values["nose-size-min-fatness"] = values["nose-size-min"] * config.fatness;
  values["nose-size-max-fatness"] = values["nose-size-max"] * config.fatness;
  if (!availableTargetIds) return Object.freeze(values);
  return Object.freeze(Object.fromEntries(
    Object.entries(values).filter(([targetId]) => availableTargetIds.has(targetId)),
  ));
}
