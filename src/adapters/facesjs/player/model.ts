import {
  validatePolyMorphModel,
  type PolyMorphLoadedResource,
  type PolyMorphModel,
} from "@layoutit/polycss-morph";

import type {
  CssGraphicsModelManifest,
} from "../../../model-package/modelPackage.mjs";
import type {
  LoadedCssGraphicsModel,
  LoadedModelAsset,
} from "../../../runtime/shared/loader.js";

export const FACES_JS_PROFILE = "facesjs-face";
const FACES_JS_SCENE_SCHEMA = "cssgraphics.facesjs-scene@1";
const ROTATION_LIGHTING_SCHEMA = "cssgraphics.facesjs-rotation-lighting@3";

type JsonRecord = Record<string, unknown>;

export interface FacesJsFaceConfig {
  readonly fatness: number;
  readonly body: Readonly<{ color: string; size: number }>;
  readonly hair: Readonly<{ color: string }>;
  readonly ear: Readonly<{ size: number }>;
  readonly eyebrow: Readonly<{ angle: number }>;
  readonly nose: Readonly<{ size: number }>;
}

export interface FacesJsMetrics {
  readonly sourceTriangles: number;
  readonly sourceQuadCells: number;
  readonly quadCandidates: number;
  readonly mergedQuads: number;
  readonly retainedTriangles: number;
  readonly preparedLeaves: number;
  readonly leafReduction: number;
  readonly rejectedPlanarity: number;
  readonly rejectedContract: number;
  readonly maximumAcceptedPlanarityErrorCssPx: number;
  readonly maximumPlanarityRepairCssPx: number;
  readonly maximumPlanarityRepairResidualCssPx: number;
  readonly repairedPlanarityVertices: number;
  readonly maximumProfileDepthAdjustmentCssPx: number;
}

export interface FacesJsRotationLightingContract {
  readonly schema: typeof ROTATION_LIGHTING_SCHEMA;
  readonly technique: "prepared-yaw-space-texel-atlas-sparse-transitions";
  readonly runtimeColorWrites: 0;
  readonly runtimeLightingMath: 0;
  readonly runtimeStyleWritesMaximum: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly leafIds: readonly string[];
  readonly state: Readonly<{
    spinSteps: number;
    fieldSourcePx: number;
    temporalMaximumRgbDelta: 4;
    initialRowsBase64: string;
  }>;
  readonly transitions: Readonly<{
    encoding:
      "csr-uint32le-offsets-parallel-uint16le-face-uint8-row-indices-base64";
    stepCount: number;
    offsetCount: number;
    changeCount: number;
    offsetsBase64: string;
    faceIndicesBase64: string;
    forwardRowsBase64: string;
    backwardRowsBase64: string;
    meanChangedFaces: number;
    p50ChangedFaces: number;
    p95ChangedFaces: number;
    maximumChangedFaces: number;
  }>;
  readonly atlas: Readonly<{
    layout: "source-order-face-columns-by-yaw-state-rows";
    asset: "rotation-texels";
    width: number;
    height: number;
  }>;
}

export interface FacesJsProgram {
  readonly manifest: CssGraphicsModelManifest;
  readonly scene: Readonly<{
    id: string;
    faceConfig: FacesJsFaceConfig;
    metrics: FacesJsMetrics;
    model: PolyMorphModel;
    rotationLighting: FacesJsRotationLightingContract;
    rotationAtlas: LoadedModelAsset;
    morphResources: ReadonlyMap<string, PolyMorphLoadedResource>;
  }>;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function base64Bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string") throw new TypeError(`${label} must be base64.`);
  try {
    const decoded = globalThis.atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError(`${label} must be base64.`);
  }
}

function color(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new TypeError(`${label} must be a six-digit hex color.`);
  }
  return value;
}

function faceConfig(value: unknown): FacesJsFaceConfig {
  const input = record(value, "FacesJS FaceConfig");
  const body = record(input.body, "FacesJS FaceConfig.body");
  const hair = record(input.hair, "FacesJS FaceConfig.hair");
  const ear = record(input.ear, "FacesJS FaceConfig.ear");
  const eyebrow = record(input.eyebrow, "FacesJS FaceConfig.eyebrow");
  const nose = record(input.nose, "FacesJS FaceConfig.nose");
  return Object.freeze({
    fatness: finite(input.fatness, "FacesJS FaceConfig.fatness"),
    body: Object.freeze({
      color: color(body.color, "FacesJS FaceConfig.body.color"),
      size: finite(body.size, "FacesJS FaceConfig.body.size"),
    }),
    hair: Object.freeze({ color: color(hair.color, "FacesJS FaceConfig.hair.color") }),
    ear: Object.freeze({ size: finite(ear.size, "FacesJS FaceConfig.ear.size") }),
    eyebrow: Object.freeze({
      angle: finite(eyebrow.angle, "FacesJS FaceConfig.eyebrow.angle"),
    }),
    nose: Object.freeze({ size: finite(nose.size, "FacesJS FaceConfig.nose.size") }),
  });
}

function metrics(value: unknown): FacesJsMetrics {
  const input = record(value, "FacesJS metrics");
  return Object.freeze({
    sourceTriangles: integer(input.sourceTriangles, "FacesJS metrics.sourceTriangles"),
    sourceQuadCells: integer(input.sourceQuadCells, "FacesJS metrics.sourceQuadCells"),
    quadCandidates: integer(input.quadCandidates, "FacesJS metrics.quadCandidates"),
    mergedQuads: integer(input.mergedQuads, "FacesJS metrics.mergedQuads"),
    retainedTriangles: integer(input.retainedTriangles, "FacesJS metrics.retainedTriangles"),
    preparedLeaves: integer(input.preparedLeaves, "FacesJS metrics.preparedLeaves"),
    leafReduction: integer(input.leafReduction, "FacesJS metrics.leafReduction"),
    rejectedPlanarity: integer(
      input.rejectedPlanarity,
      "FacesJS metrics.rejectedPlanarity",
    ),
    rejectedContract: integer(
      input.rejectedContract,
      "FacesJS metrics.rejectedContract",
    ),
    maximumAcceptedPlanarityErrorCssPx: finite(
      input.maximumAcceptedPlanarityErrorCssPx,
      "FacesJS metrics.maximumAcceptedPlanarityErrorCssPx",
    ),
    maximumPlanarityRepairCssPx: finite(
      input.maximumPlanarityRepairCssPx,
      "FacesJS metrics.maximumPlanarityRepairCssPx",
    ),
    maximumPlanarityRepairResidualCssPx: finite(
      input.maximumPlanarityRepairResidualCssPx,
      "FacesJS metrics.maximumPlanarityRepairResidualCssPx",
    ),
    repairedPlanarityVertices: integer(
      input.repairedPlanarityVertices,
      "FacesJS metrics.repairedPlanarityVertices",
    ),
    maximumProfileDepthAdjustmentCssPx: finite(
      input.maximumProfileDepthAdjustmentCssPx,
      "FacesJS metrics.maximumProfileDepthAdjustmentCssPx",
    ),
  });
}

function rotationLighting(
  value: unknown,
  model: PolyMorphModel,
  asset: LoadedModelAsset,
): FacesJsRotationLightingContract {
  const input = record(value, "FacesJS rotation lighting");
  const state = record(input.state, "FacesJS rotation lighting.state");
  const transitions = record(
    input.transitions,
    "FacesJS rotation lighting.transitions",
  );
  const atlas = record(input.atlas, "FacesJS rotation lighting.atlas");
  const leafIds = input.leafIds;
  const spinSteps = integer(state.spinSteps, "FacesJS rotation lighting.state.spinSteps");
  const fieldSourcePx = integer(
    state.fieldSourcePx,
    "FacesJS rotation lighting.state.fieldSourcePx",
  );
  const runtimeStyleWritesMaximum = integer(
    input.runtimeStyleWritesMaximum,
    "FacesJS rotation lighting.runtimeStyleWritesMaximum",
  );
  const stepCount = integer(
    transitions.stepCount,
    "FacesJS rotation lighting.transitions.stepCount",
  );
  const offsetCount = integer(
    transitions.offsetCount,
    "FacesJS rotation lighting.transitions.offsetCount",
  );
  const changeCount = integer(
    transitions.changeCount,
    "FacesJS rotation lighting.transitions.changeCount",
  );
  const p50ChangedFaces = integer(
    transitions.p50ChangedFaces,
    "FacesJS rotation lighting.transitions.p50ChangedFaces",
  );
  const p95ChangedFaces = integer(
    transitions.p95ChangedFaces,
    "FacesJS rotation lighting.transitions.p95ChangedFaces",
  );
  const maximumChangedFaces = integer(
    transitions.maximumChangedFaces,
    "FacesJS rotation lighting.transitions.maximumChangedFaces",
  );
  const meanChangedFaces = finite(
    transitions.meanChangedFaces,
    "FacesJS rotation lighting.transitions.meanChangedFaces",
  );
  const initialRows = base64Bytes(
    state.initialRowsBase64,
    "FacesJS rotation lighting.state.initialRowsBase64",
  );
  const offsetBytes = base64Bytes(
    transitions.offsetsBase64,
    "FacesJS rotation lighting.transitions.offsetsBase64",
  );
  const faceBytes = base64Bytes(
    transitions.faceIndicesBase64,
    "FacesJS rotation lighting.transitions.faceIndicesBase64",
  );
  const forwardRows = base64Bytes(
    transitions.forwardRowsBase64,
    "FacesJS rotation lighting.transitions.forwardRowsBase64",
  );
  const backwardRows = base64Bytes(
    transitions.backwardRowsBase64,
    "FacesJS rotation lighting.transitions.backwardRowsBase64",
  );
  const width = integer(atlas.width, "FacesJS rotation lighting.atlas.width");
  const height = integer(atlas.height, "FacesJS rotation lighting.atlas.height");
  if (
    input.schema !== ROTATION_LIGHTING_SCHEMA
    || input.technique !== "prepared-yaw-space-texel-atlas-sparse-transitions"
    || input.runtimeColorWrites !== 0
    || input.runtimeLightingMath !== 0
    || runtimeStyleWritesMaximum !== maximumChangedFaces
    || input.modelId !== model.identity.id
    || input.modelRevision !== model.identity.revision
    || !Array.isArray(leafIds)
    || leafIds.length !== model.render.leaves.length
    || leafIds.some((id, index) => id !== model.render.leaves[index]?.id)
    || spinSteps < 2
    || fieldSourcePx < 1
    || state.temporalMaximumRgbDelta !== 4
    || initialRows.length !== leafIds.length
    || initialRows.some((row) => row >= spinSteps)
    || transitions.encoding
      !== "csr-uint32le-offsets-parallel-uint16le-face-uint8-row-indices-base64"
    || stepCount !== spinSteps
    || offsetCount !== spinSteps + 1
    || offsetBytes.length !== offsetCount * 4
    || faceBytes.length !== changeCount * 2
    || forwardRows.length !== changeCount
    || backwardRows.length !== changeCount
    || p50ChangedFaces > p95ChangedFaces
    || p95ChangedFaces > maximumChangedFaces
    || meanChangedFaces < 0
    || meanChangedFaces > maximumChangedFaces
    || atlas.layout !== "source-order-face-columns-by-yaw-state-rows"
    || atlas.asset !== "rotation-texels"
    || width !== leafIds.length * fieldSourcePx
    || height !== spinSteps * fieldSourcePx
    || asset.width !== width
    || asset.height !== height
  ) {
    throw new TypeError("The FacesJS rotation-lighting contract is incompatible.");
  }
  const offsets = new DataView(
    offsetBytes.buffer,
    offsetBytes.byteOffset,
    offsetBytes.byteLength,
  );
  let previousOffset = 0;
  let observedMaximum = 0;
  for (let stateIndex = 0; stateIndex < offsetCount; stateIndex += 1) {
    const nextOffset = offsets.getUint32(stateIndex * 4, true);
    if (nextOffset < previousOffset || nextOffset > changeCount) {
      throw new TypeError("The FacesJS rotation-lighting offsets are invalid.");
    }
    if (stateIndex > 0) {
      observedMaximum = Math.max(observedMaximum, nextOffset - previousOffset);
    }
    previousOffset = nextOffset;
  }
  if (previousOffset !== changeCount || observedMaximum !== maximumChangedFaces) {
    throw new TypeError("The FacesJS rotation-lighting transition totals are stale.");
  }
  const faceView = new DataView(
    faceBytes.buffer,
    faceBytes.byteOffset,
    faceBytes.byteLength,
  );
  for (let changeIndex = 0; changeIndex < changeCount; changeIndex += 1) {
    if (
      faceView.getUint16(changeIndex * 2, true) >= leafIds.length
      || forwardRows[changeIndex]! >= spinSteps
      || backwardRows[changeIndex]! >= spinSteps
    ) {
      throw new TypeError("The FacesJS rotation-lighting transition is invalid.");
    }
  }
  return input as unknown as FacesJsRotationLightingContract;
}

function morphResource(asset: LoadedModelAsset): PolyMorphLoadedResource {
  return Object.freeze({
    descriptor: Object.freeze({
      path: asset.path,
      role: "image" as const,
      mediaType: asset.mediaType,
      bytes: asset.bytes,
      sha256: asset.sha256,
    }),
    bytes: asset.sourceBytes,
  });
}

export function decodeFacesJsProgram(
  loaded: LoadedCssGraphicsModel,
): FacesJsProgram {
  if (loaded.manifest.profile !== FACES_JS_PROFILE) {
    throw new TypeError("The loaded package is not a FacesJS face.");
  }
  const input = record(loaded.model.sections.scene, "FacesJS scene");
  if (
    input.schema !== FACES_JS_SCENE_SCHEMA
    || input.artifactMode !== "prepared-polycss-morph"
    || input.id !== loaded.manifest.id
  ) {
    throw new TypeError("The FacesJS scene contract is incompatible.");
  }
  const model = validatePolyMorphModel(input.model);
  if (model.identity.id !== loaded.manifest.id || model.profile !== "morph-regions") {
    throw new TypeError("The FacesJS Morph model does not match its cssGraphics package.");
  }
  const parsedMetrics = metrics(input.metrics);
  const quadLeaves = model.render.leaves.filter(
    ({ strategy }) => strategy === "solid-quad",
  ).length;
  const triangleLeaves = model.render.leaves.filter(
    ({ strategy }) => strategy === "solid-triangle",
  ).length;
  if (
    parsedMetrics.mergedQuads !== quadLeaves
    || parsedMetrics.retainedTriangles !== triangleLeaves
    || parsedMetrics.preparedLeaves !== model.render.leaves.length
    || parsedMetrics.sourceQuadCells < parsedMetrics.quadCandidates
    || parsedMetrics.quadCandidates !== parsedMetrics.mergedQuads
      + parsedMetrics.rejectedPlanarity
      + parsedMetrics.rejectedContract
    || parsedMetrics.leafReduction !== parsedMetrics.mergedQuads
    || parsedMetrics.maximumAcceptedPlanarityErrorCssPx < 0
    || parsedMetrics.maximumAcceptedPlanarityErrorCssPx > 1e-6
    || parsedMetrics.maximumPlanarityRepairCssPx < 0
    || parsedMetrics.maximumPlanarityRepairCssPx > 0.01
    || parsedMetrics.maximumPlanarityRepairResidualCssPx < 0
    || parsedMetrics.maximumPlanarityRepairResidualCssPx > 2e-7
    || parsedMetrics.maximumProfileDepthAdjustmentCssPx < 0
    || parsedMetrics.maximumProfileDepthAdjustmentCssPx > 3
    || parsedMetrics.sourceTriangles - parsedMetrics.leafReduction
      !== parsedMetrics.preparedLeaves
  ) {
    throw new TypeError("The FacesJS preparation metrics are stale.");
  }
  const rotationAtlas = loaded.assetOwner.get("rotation-texels");
  const triangleFallback = loaded.assetOwner.get("triangle-fallback");
  const expectedFallbackPath = model.render.leaves.find(
    ({ fallback }) => fallback !== null,
  )?.fallback?.atlas.resourcePath;
  if (expectedFallbackPath !== triangleFallback.path) {
    throw new TypeError("The FacesJS triangle fallback binding is stale.");
  }
  return Object.freeze({
    manifest: loaded.manifest,
    scene: Object.freeze({
      id: model.identity.id,
      faceConfig: faceConfig(input.faceConfig),
      metrics: parsedMetrics,
      model,
      rotationLighting: rotationLighting(
        input.rotationLighting,
        model,
        rotationAtlas,
      ),
      rotationAtlas,
      morphResources: new Map([
        [triangleFallback.path, morphResource(triangleFallback)],
      ]),
    }),
  });
}
