import type {
  CssGraphicsModelManifest,
} from "../../../model-package/modelPackage.mjs";
import type {
  LoadedCssGraphicsModel,
  LoadedModelAsset,
} from "../../../runtime/shared/loader.js";
import {
  validateFacesJsFaceConfig,
  type FacesJsFaceConfig,
} from "./configTransforms.js";
import type {
  FacesJsComponentRotationLightingContract,
} from "./componentRuntime.js";

export type { FacesJsFaceConfig } from "./configTransforms.js";

export const FACES_JS_PROFILE = "facesjs-face";
export const FACES_JS_PREPARED_SCENE_SCHEMA =
  "cssface.facesjs-prepared-scene@2";
const FACES_JS_MODEL_REVISION = "1.0.0";
const ROTATION_DIFFUSE_ROLE = "rotation-diffuse";
const ROTATION_SPECULAR_ROLE = "rotation-specular";

type JsonRecord = Record<string, unknown>;
type Vec3 = readonly [number, number, number];

export interface FacesJsPreparedPolygon {
  readonly vertices: readonly Vec3[];
  readonly color: string;
  readonly doubleSided?: boolean;
}

export interface FacesJsPreparedScene {
  readonly id: string;
  readonly artifactMode: "polycss-polygons";
  readonly fixtureId: string;
  readonly faceConfig: FacesJsFaceConfig;
  readonly polygons: readonly FacesJsPreparedPolygon[];
  readonly rotationLighting: FacesJsComponentRotationLightingContract;
  readonly selectedKeys: readonly string[];
}

export interface FacesJsProgram {
  readonly manifest: CssGraphicsModelManifest;
  readonly scene: FacesJsPreparedScene & Readonly<{
    rotationDiffuse: LoadedModelAsset;
    rotationSpecular: LoadedModelAsset;
  }>;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has missing or unsupported fields.`);
  }
}

function normalizedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError(`${label} must be a normalized id.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be a string array.`);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${label} must not contain duplicates.`);
  }
  return Object.freeze([...value]);
}

function finiteVector(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3
    || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new TypeError(`${label} must contain three finite numbers.`);
  }
  return Object.freeze([...value]) as Vec3;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function rotationLighting(
  value: unknown,
  modelId: string,
  polygonCount: number,
  diffuse: LoadedModelAsset,
  specular: LoadedModelAsset,
): FacesJsComponentRotationLightingContract {
  const input = record(value, "FacesJS rotation lighting");
  const state = record(input.state, "FacesJS rotation lighting.state");
  const materials = record(input.materials, "FacesJS rotation lighting.materials");
  const visibility = record(input.visibility, "FacesJS rotation lighting.visibility");
  const atlases = record(input.atlases, "FacesJS rotation lighting.atlases");
  const diffuseAtlas = record(atlases.diffuse, "FacesJS rotation lighting.diffuse");
  const specularAtlas = record(atlases.specular, "FacesJS rotation lighting.specular");
  const runtime = record(input.runtime, "FacesJS rotation lighting.runtime");
  const leafIds = stringArray(input.leafIds, "FacesJS rotation lighting.leafIds");
  const roleIds = stringArray(materials.roleIds, "FacesJS rotation lighting.roleIds");
  let roleIndices: Uint8Array;
  try {
    if (typeof materials.leafRoleIndicesBase64 !== "string") throw new Error();
    const binary = globalThis.atob(materials.leafRoleIndicesBase64);
    roleIndices = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError("FacesJS rotation lighting material indices must be base64.");
  }
  const spinSteps = positiveInteger(state.spinSteps, "FacesJS rotation lighting.spinSteps");
  const fieldSourcePx = positiveInteger(
    state.fieldSourcePx,
    "FacesJS rotation lighting.fieldSourcePx",
  );
  const width = positiveInteger(diffuseAtlas.width, "FacesJS diffuse atlas width");
  const height = positiveInteger(diffuseAtlas.height, "FacesJS diffuse atlas height");
  if (input.schema !== "cssface.facesjs-component-rotation-lighting@3"
    || input.technique !== "prepared-yaw-space-time-neutral-texel-matrix"
    || input.modelId !== modelId
    || input.modelRevision !== FACES_JS_MODEL_REVISION
    || input.runtimeColorWrites !== 0
    || input.runtimeLightingMath !== 0
    || input.runtimeStyleWritesMaximum !== 1
    || leafIds.length !== polygonCount
    || leafIds.some((leafId, index) =>
      leafId !== `polygon-${String(index).padStart(6, "0")}`)
    || roleIds.length < 1
    || roleIndices.length !== polygonCount
    || roleIndices.some((index) => index >= roleIds.length)
    || visibility.encoding !== "prepared-space-time-alpha-mask"
    || visibility.managedLeafCount !== 0
    || visibility.radialLeafCount !== 0
    || visibility.frontLeafCount !== 0
    || atlases.layout !== "paged-source-order-face-columns-by-yaw-state-rows"
    || diffuseAtlas.asset !== ROTATION_DIFFUSE_ROLE
    || diffuseAtlas.encoding !== "srgb-multiplier-grayscale"
    || specularAtlas.asset !== ROTATION_SPECULAR_ROLE
    || specularAtlas.encoding !== "screen-amplitude-grayscale"
    || specularAtlas.alphaEncoding !== "frontface-visibility"
    || specularAtlas.width !== width
    || specularAtlas.height !== height
    || width !== Math.min(polygonCount, 8192) * fieldSourcePx
    || height !== Math.ceil(polygonCount / (width / fieldSourcePx))
      * spinSteps * fieldSourcePx
    || diffuse.width !== width
    || diffuse.height !== height
    || specular.width !== width
    || specular.height !== height
    || runtime.rootStateWritesMaximum !== 1
    || runtime.leafStateWrites !== 0
    || runtime.faceStateScans !== 0
    || runtime.operation !== "one inherited space-time row offset") {
    throw new TypeError("The FacesJS prepared rotation-lighting field is incompatible.");
  }
  return input as unknown as FacesJsComponentRotationLightingContract;
}

function polygon(value: unknown, index: number): FacesJsPreparedPolygon {
  const label = `FacesJS polygons[${index}]`;
  const input = record(value, label);
  const keys = Object.keys(input);
  if (!keys.includes("vertices") || !keys.includes("color")
    || keys.some((key) => !["vertices", "color", "doubleSided"].includes(key))) {
    throw new TypeError(`${label} has missing or unsupported fields.`);
  }
  if (!Array.isArray(input.vertices) || input.vertices.length < 3) {
    throw new TypeError(`${label}.vertices must contain at least three points.`);
  }
  if (typeof input.color !== "string" || input.color.length === 0) {
    throw new TypeError(`${label}.color must be a non-empty CSS color.`);
  }
  if (input.doubleSided !== undefined && typeof input.doubleSided !== "boolean") {
    throw new TypeError(`${label}.doubleSided must be boolean.`);
  }
  return Object.freeze({
    vertices: Object.freeze(input.vertices.map((vertex, vertexIndex) =>
      finiteVector(vertex, `${label}.vertices[${vertexIndex}]`))),
    color: input.color,
    ...(input.doubleSided === true ? { doubleSided: true } : {}),
  });
}

export function decodeFacesJsProgram(
  loaded: LoadedCssGraphicsModel,
): FacesJsProgram {
  if (loaded.manifest.profile !== FACES_JS_PROFILE) {
    throw new TypeError("The loaded package is not a FacesJS face.");
  }
  const input = record(loaded.model.sections.scene, "FacesJS prepared scene");
  exactKeys(input, [
    "schema",
    "id",
    "artifactMode",
    "fixtureId",
    "faceConfig",
    "polygons",
    "rotationLighting",
    "selectedKeys",
  ], "FacesJS prepared scene");
  if (input.schema !== FACES_JS_PREPARED_SCENE_SCHEMA
    || input.artifactMode !== "polycss-polygons"
    || input.id !== loaded.manifest.id) {
    throw new TypeError("The FacesJS prepared scene contract is incompatible.");
  }
  if (!Array.isArray(input.polygons) || input.polygons.length === 0) {
    throw new TypeError("The FacesJS prepared scene has no polygons.");
  }
  const assetRoles = Object.keys(loaded.manifest.resources.assets).sort();
  if (assetRoles.length !== 2
    || assetRoles[0] !== ROTATION_DIFFUSE_ROLE
    || assetRoles[1] !== ROTATION_SPECULAR_ROLE) {
    throw new TypeError("The FacesJS prepared lighting assets are incomplete.");
  }
  const parsedPolygons = Object.freeze(input.polygons.map(polygon));
  const rotationDiffuse = loaded.assetOwner.get(ROTATION_DIFFUSE_ROLE);
  const rotationSpecular = loaded.assetOwner.get(ROTATION_SPECULAR_ROLE);
  const parsedRotationLighting = rotationLighting(
    input.rotationLighting,
    loaded.manifest.id,
    parsedPolygons.length,
    rotationDiffuse,
    rotationSpecular,
  );

  return Object.freeze({
    manifest: loaded.manifest,
    scene: Object.freeze({
      id: loaded.manifest.id,
      artifactMode: "polycss-polygons" as const,
      fixtureId: normalizedId(input.fixtureId, "FacesJS fixtureId"),
      faceConfig: validateFacesJsFaceConfig(input.faceConfig),
      polygons: parsedPolygons,
      rotationLighting: parsedRotationLighting,
      rotationDiffuse,
      rotationSpecular,
      selectedKeys: stringArray(input.selectedKeys, "FacesJS selected components"),
    }),
  });
}
