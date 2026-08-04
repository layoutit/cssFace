import type {
  FacesJsComponentGraph,
  FacesJsResolvedComponentGraph,
} from "../model-package/componentCatalog.js";
import {
  FACES_JS_COMPONENT_FAMILIES,
  type FacesJsComponentCatalog,
  type FacesJsComponentCatalogRow,
  type FacesJsComponentFamily,
  type FacesJsComponentSelection,
} from "../model-package/componentPackage.js";
import {
  FACES_JS_TRANSFORM_BOUNDS,
  validateFacesJsFaceConfig,
  type FacesJsFaceConfig,
} from "./configTransforms.js";

export const FACES_JS_DEFAULT_COMPONENT_BASE_ID = "bust";
export const CSSFACE_GENERATOR_ID = "cssface-uniform-catalog-v1";
export const CSSFACE_MAXIMUM_SEED = 9_999;
export const CSSFACE_PREPARED_FACE_CATALOG_SCHEMA =
  "cssface.prepared-face-catalog@2";
export const CSSFACE_SHARE_SCHEMA = "cssface.face-state@1";

const HAT_IDS = new Set(["hat", "hat2", "hat3", "santa-hat"]);
const HAT_SHORT_IDS = new Set([
  "afro",
  "afro2",
  "curly",
  "curly2",
  "curly3",
  "faux-hawk",
  "hair",
  "high",
  "juice",
  "messy-short",
  "messy",
  "middle-part",
  "parted",
  "shaggy1",
  "shaggy2",
  "short3",
  "spike",
  "spike2",
  "spike3",
  "spike4",
]);
const HAT_SHORT_FADE_IDS = new Set([
  "blowoutFade",
  "curlyFade1",
  "curlyFade2",
  "dreads",
  "fauxhawk-fade",
  "tall-fade",
]);

const SKIN_COLORS = Object.freeze([
  "#5f382f", "#714639", "#835441", "#96604b", "#ad6453", "#b96f58",
  "#bd7b5f", "#c68668", "#cf9272", "#d8a17e", "#e0ae8b", "#efc3a2",
]);
const HAIR_COLORS = Object.freeze([
  "#171311", "#1c1715", "#272421", "#33251f", "#442c22", "#573527",
  "#6a3d2a", "#805039", "#936347", "#aa7856", "#c49568", "#d3b17d",
]);
const TEAM_COLORS = Object.freeze([
  "#89bfd3", "#436f8a", "#547f66", "#d9a441", "#712f37", "#183f48",
  "#9c3848", "#e5bd70", "#7a1319", "#07364f", "#5f6db2", "#bd5d38",
]);
const SHAVE_COLORS = Object.freeze([
  "rgba(0, 0, 0, 0)",
  "rgba(0, 0, 0, 0)",
  "rgba(0, 0, 0, 0)",
  "rgba(0, 0, 0, 0.08)",
  "rgba(0, 0, 0, 0.16)",
  "rgba(0, 0, 0, 0.25)",
]);

export type FacesJsFaceConfigResolutionErrorCode =
  | "dependency-mismatch"
  | "missing-base"
  | "unsupported-component";

export class FacesJsFaceConfigResolutionError extends Error {
  readonly code: FacesJsFaceConfigResolutionErrorCode;
  readonly family: FacesJsComponentFamily | null;
  readonly sourceId: string | null;

  constructor(
    code: FacesJsFaceConfigResolutionErrorCode,
    message: string,
    family: FacesJsComponentFamily | null = null,
    sourceId: string | null = null,
  ) {
    super(message);
    this.name = "FacesJsFaceConfigResolutionError";
    this.code = code;
    this.family = family;
    this.sourceId = sourceId;
  }
}

export interface FacesJsResolvedFaceConfig {
  readonly baseId: string;
  readonly config: FacesJsFaceConfig;
  readonly effectiveIds: Readonly<Record<FacesJsComponentFamily, string>>;
  readonly selections: readonly FacesJsComponentSelection[];
  readonly graph: FacesJsResolvedComponentGraph;
  readonly selectedKeys: readonly string[];
}

export interface CssFaceShareState {
  readonly schema: typeof CSSFACE_SHARE_SCHEMA;
  readonly generator: typeof CSSFACE_GENERATOR_ID;
  readonly seed: number;
  readonly face: FacesJsFaceConfig;
}

function normalizeSeed(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > CSSFACE_MAXIMUM_SEED) {
    throw new RangeError(
      `CSSFace seed must be an integer between 0 and ${CSSFACE_MAXIMUM_SEED}.`,
    );
  }
  return seed;
}

function hashLabel(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sample(seed: number, label: string): number {
  let value = (seed ^ hashLabel(label) ^ 0x9e3779b9) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function pick<T>(values: readonly T[], seed: number, label: string): T {
  if (values.length === 0) throw new Error(`CSSFace generator has no ${label} values.`);
  return values[sample(seed, label) % values.length]!;
}

function stepped(
  seed: number,
  label: string,
  bounds: readonly [number, number],
  step: number,
): number {
  const steps = Math.round((bounds[1] - bounds[0]) / step);
  const value = bounds[0] + (sample(seed, label) % (steps + 1)) * step;
  return Number(value.toFixed(4));
}

function rowsByFamily(
  catalog: FacesJsComponentCatalog,
): ReadonlyMap<FacesJsComponentFamily, readonly FacesJsComponentCatalogRow[]> {
  const output = new Map<FacesJsComponentFamily, readonly FacesJsComponentCatalogRow[]>();
  for (const family of FACES_JS_COMPONENT_FAMILIES) {
    const rows = catalog.components
      .filter((row) => row.family === family)
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    if (rows.length === 0) throw new Error(`CSSFace catalog has no ${family} components.`);
    output.set(family, Object.freeze(rows));
  }
  return output;
}

function effectiveHairId(config: FacesJsFaceConfig): string {
  if (!HAT_IDS.has(config.accessories.id)) return config.hair.id;
  if (HAT_SHORT_IDS.has(config.hair.id)) return "short";
  if (HAT_SHORT_FADE_IDS.has(config.hair.id)) return "short-fade";
  return "bald";
}

export function resolveFacesJsFaceConfig(
  componentGraph: FacesJsComponentGraph,
  configInput: unknown,
  baseId = FACES_JS_DEFAULT_COMPONENT_BASE_ID,
): FacesJsResolvedFaceConfig {
  const config = validateFacesJsFaceConfig(configInput);
  if (!componentGraph.catalog.bases.some((row) => row.id === baseId)) {
    throw new FacesJsFaceConfigResolutionError(
      "missing-base",
      `FacesJS component base ${baseId} is unavailable.`,
    );
  }
  const rows = new Map(componentGraph.catalog.components.map((row) => [
    `${row.family}:${row.sourceId}`,
    row,
  ]));
  const effectiveIds = {} as Record<FacesJsComponentFamily, string>;
  const selections: FacesJsComponentSelection[] = [];
  for (const family of FACES_JS_COMPONENT_FAMILIES) {
    const sourceId = family === "hair" ? effectiveHairId(config) : config[family].id;
    effectiveIds[family] = sourceId;
    const row = rows.get(`${family}:${sourceId}`);
    if (!row) {
      throw new FacesJsFaceConfigResolutionError(
        "unsupported-component",
        `FacesJS ${family}.${sourceId} is not supported by this CSSFace catalog.`,
        family,
        sourceId,
      );
    }
    selections.push(Object.freeze({
      family,
      sourceId,
      sourceSha256: row.sourceSha256,
    }));
  }
  const selectedByFamily = new Map(selections.map((selection) => [
    selection.family,
    selection,
  ]));
  for (const selection of selections) {
    const row = rows.get(`${selection.family}:${selection.sourceId}`)!;
    for (const dependency of row.dependencies) {
      const selected = selectedByFamily.get(dependency.family);
      if (selected?.sourceId !== dependency.sourceId) {
        throw new FacesJsFaceConfigResolutionError(
          "dependency-mismatch",
          `FacesJS ${selection.family}.${selection.sourceId} requires ` +
            `${dependency.family}.${dependency.sourceId}.`,
          dependency.family,
          selected?.sourceId ?? null,
        );
      }
    }
  }
  const resolvedGraph = componentGraph.resolve(baseId, selections);
  return Object.freeze({
    baseId,
    config,
    effectiveIds: Object.freeze(effectiveIds),
    selections: Object.freeze(selections),
    graph: resolvedGraph,
    selectedKeys: Object.freeze(resolvedGraph.components.map(
      ({ family, sourceId }) => `${family}:${sourceId}`,
    )),
  });
}

export function generateCssFaceConfig(
  catalog: FacesJsComponentCatalog,
  seedInput: number,
): FacesJsFaceConfig {
  const seed = normalizeSeed(seedInput);
  const families = rowsByFamily(catalog);
  const selected = {} as Record<FacesJsComponentFamily, FacesJsComponentCatalogRow>;
  for (const family of FACES_JS_COMPONENT_FAMILIES) {
    if (family === "hairBg") continue;
    selected[family] = pick(families.get(family)!, seed, `component:${family}`);
  }
  const hairBackground = selected.hair.dependencies.find(
    ({ family }) => family === "hairBg",
  )?.sourceId ?? "none";
  const hairBackgroundRow = families.get("hairBg")!.find(
    ({ sourceId }) => sourceId === hairBackground,
  );
  if (!hairBackgroundRow) {
    throw new Error(`CSSFace generator cannot resolve hairBg.${hairBackground}.`);
  }
  selected.hairBg = hairBackgroundRow;
  const teamStart = sample(seed, "color:team") % TEAM_COLORS.length;
  const face = {
    fatness: stepped(seed, "scalar:fatness", FACES_JS_TRANSFORM_BOUNDS.fatness, 0.01),
    teamColors: [
      TEAM_COLORS[teamStart]!,
      TEAM_COLORS[(teamStart + 5) % TEAM_COLORS.length]!,
      TEAM_COLORS[(teamStart + 9) % TEAM_COLORS.length]!,
    ],
    hairBg: { id: selected.hairBg.sourceId },
    body: {
      id: selected.body.sourceId,
      color: pick(SKIN_COLORS, seed, "color:skin"),
      size: stepped(seed, "scalar:body-size", FACES_JS_TRANSFORM_BOUNDS["body.size"], 0.01),
    },
    jersey: { id: selected.jersey.sourceId },
    ear: {
      id: selected.ear.sourceId,
      size: stepped(seed, "scalar:ear-size", FACES_JS_TRANSFORM_BOUNDS["ear.size"], 0.01),
    },
    head: {
      id: selected.head.sourceId,
      shave: pick(SHAVE_COLORS, seed, "color:shave"),
    },
    eyeLine: { id: selected.eyeLine.sourceId },
    smileLine: {
      id: selected.smileLine.sourceId,
      size: stepped(
        seed,
        "scalar:smile-line-size",
        FACES_JS_TRANSFORM_BOUNDS["smileLine.size"],
        0.01,
      ),
    },
    miscLine: { id: selected.miscLine.sourceId },
    facialHair: { id: selected.facialHair.sourceId },
    eye: {
      id: selected.eye.sourceId,
      angle: stepped(seed, "scalar:eye-angle", FACES_JS_TRANSFORM_BOUNDS["eye.angle"], 1),
    },
    eyebrow: {
      id: selected.eyebrow.sourceId,
      angle: stepped(
        seed,
        "scalar:eyebrow-angle",
        FACES_JS_TRANSFORM_BOUNDS["eyebrow.angle"],
        1,
      ),
    },
    hair: {
      id: selected.hair.sourceId,
      color: pick(HAIR_COLORS, seed, "color:hair"),
      flip: sample(seed, "flip:hair") % 2 === 1,
    },
    mouth: {
      id: selected.mouth.sourceId,
      flip: sample(seed, "flip:mouth") % 2 === 1,
    },
    nose: {
      id: selected.nose.sourceId,
      flip: sample(seed, "flip:nose") % 2 === 1,
      size: stepped(seed, "scalar:nose-size", FACES_JS_TRANSFORM_BOUNDS["nose.size"], 0.01),
    },
    glasses: { id: selected.glasses.sourceId },
    accessories: { id: selected.accessories.sourceId },
  };
  return validateFacesJsFaceConfig(face);
}

export function collectCssFaceCoverageSeeds(
  componentGraph: FacesJsComponentGraph,
): readonly number[] {
  const missing = new Set(componentGraph.catalog.components.map(
    ({ family, sourceId }) => `${family}:${sourceId}`,
  ));
  const seeds: number[] = [];
  for (let seed = 0; seed <= CSSFACE_MAXIMUM_SEED && missing.size > 0; seed += 1) {
    const resolved = resolveFacesJsFaceConfig(
      componentGraph,
      generateCssFaceConfig(componentGraph.catalog, seed),
    );
    const reached = resolved.selectedKeys.filter((key) => missing.has(key));
    if (reached.length === 0) continue;
    seeds.push(seed);
    for (const key of reached) missing.delete(key);
  }
  if (missing.size > 0) {
    throw new Error(
      `CSSFace 10,000-seed sweep misses ${[...missing].sort().join(", ")}.`,
    );
  }
  return Object.freeze(seeds);
}

export function serializeFacesJsFaceConfig(configInput: unknown): string {
  return `${JSON.stringify(validateFacesJsFaceConfig(configInput), null, 2)}\n`;
}

export function parseFacesJsFaceConfigJson(source: string): FacesJsFaceConfig {
  if (typeof source !== "string") {
    throw new TypeError("CSSFace config JSON must be a string.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError("CSSFace config is not valid JSON.");
  }
  return validateFacesJsFaceConfig(value);
}

export function encodeCssFaceShareState(
  configInput: unknown,
  seedInput: number,
): string {
  const state: CssFaceShareState = Object.freeze({
    schema: CSSFACE_SHARE_SCHEMA,
    generator: CSSFACE_GENERATOR_ID,
    seed: normalizeSeed(seedInput),
    face: validateFacesJsFaceConfig(configInput),
  });
  return JSON.stringify(state);
}

export function decodeCssFaceShareState(source: string): CssFaceShareState {
  if (typeof source !== "string") throw new TypeError("CSSFace share state must be a string.");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError("CSSFace share state is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CSSFace share state must be an object.");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = ["face", "generator", "schema", "seed"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("CSSFace share state has missing or unsupported fields.");
  }
  if (input.schema !== CSSFACE_SHARE_SCHEMA || input.generator !== CSSFACE_GENERATOR_ID) {
    throw new TypeError("CSSFace share state is incompatible.");
  }
  return Object.freeze({
    schema: CSSFACE_SHARE_SCHEMA,
    generator: CSSFACE_GENERATOR_ID,
    seed: normalizeSeed(input.seed as number),
    face: validateFacesJsFaceConfig(input.face),
  });
}

export function createCssFaceShareUrl(
  currentUrl: string | URL,
  configInput: unknown,
  seedInput: number,
): URL {
  const url = new URL(currentUrl);
  url.searchParams.set("face", encodeCssFaceShareState(configInput, seedInput));
  return url;
}

export function readCssFaceShareUrl(currentUrl: string | URL): CssFaceShareState | null {
  const source = new URL(currentUrl).searchParams.get("face");
  return source === null ? null : decodeCssFaceShareState(source);
}
