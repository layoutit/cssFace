import {
  createPolyOrthographicCamera,
} from "@layoutit/polycss";
import {
  createPolyMorphDeformationRuntime,
  mountPolyMorphModel,
  type PolyMorphMat4,
  type PolyMorphMountedModel,
} from "@layoutit/polycss-morph";

import type {
  FacesJsProgram,
} from "./model.js";

export type FacesJsMorphId =
  | "fatness"
  | "body-size"
  | "ear-size"
  | "nose-size"
  | "brow";

export interface FacesJsPrototypeSnapshot {
  readonly ready: boolean;
  readonly modelId: string;
  readonly profile: string;
  readonly generationHash: string;
  readonly leaves: number;
  readonly canvases: number;
  readonly solidQuads: number;
  readonly solidTriangles: number;
  readonly topologyConstructions: number;
  readonly applyCount: number;
  readonly rotationLightingState: number;
  readonly rotationLightingWrites: number;
  readonly rotationLightingPublications: number;
  readonly rotationLightingMaximumBatch: number;
  readonly rotationLightingTexels: number;
  readonly weights: Readonly<Record<string, number>>;
}

export interface FacesJsPrototypeController {
  setMorph(id: FacesJsMorphId, value: number): void;
  setOrbit(yawDegrees: number, pitchDegrees?: number): void;
  snapshot(): FacesJsPrototypeSnapshot;
}

interface RotationLightingRuntime {
  readonly stats: Readonly<{
    currentState: number;
    stateWrites: number;
    statePublications: number;
    maximumBatch: number;
    texelLeaves: number;
  }>;
  apply(yawDegrees: number): void;
  destroy(): void;
}

interface FacesJsModelFraming {
  readonly translationY: number;
  readonly scaleY: number;
}

const MODEL_FRAMING_BY_ID: Readonly<Record<string, FacesJsModelFraming>> =
  Object.freeze({
    "facesjs-lowpoly-head": Object.freeze({ translationY: 34.5, scaleY: 0.98 }),
    "facesjs-lowpoly-head-afro": Object.freeze({ translationY: 24.5, scaleY: 0.974 }),
    "facesjs-lowpoly-head-bald": Object.freeze({ translationY: 34.5, scaleY: 0.98 }),
    "facesjs-lowpoly-head-short2": Object.freeze({ translationY: 34.5, scaleY: 0.98 }),
  });

export interface FacesJsMountedScene {
  readonly mounted: PolyMorphMountedModel;
  readonly controller: FacesJsPrototypeController;
  stop(): void;
  destroy(): void;
}

type DebugGlobal = typeof globalThis & {
  __facesJsPrototype?: FacesJsPrototypeController;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function translationY(value: number): PolyMorphMat4 {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, value, 0, 1,
  ];
}

function scaleY(value: number): PolyMorphMat4 {
  return [
    1, 0, 0, 0,
    0, value, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

function multiply(left: PolyMorphMat4, right: PolyMorphMat4): PolyMorphMat4 {
  const output = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let axis = 0; axis < 4; axis += 1) {
        output[(column * 4) + row] +=
          left[(axis * 4) + row]! * right[(column * 4) + axis]!;
      }
    }
  }
  return output as unknown as PolyMorphMat4;
}

function rotationX(degrees: number): PolyMorphMat4 {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    1, 0, 0, 0,
    0, cosine, sine, 0,
    0, -sine, cosine, 0,
    0, 0, 0, 1,
  ];
}

function rotationY(degrees: number): PolyMorphMat4 {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    cosine, 0, -sine, 0,
    0, 1, 0, 0,
    sine, 0, cosine, 0,
    0, 0, 0, 1,
  ];
}

function resolveZoom(host: HTMLElement): number {
  const sourceFace = host.ownerDocument.querySelector<HTMLElement>("#source-face");
  if (sourceFace) {
    const sourceBounds = sourceFace.getBoundingClientRect();
    const sourceWidth = Math.min(
      sourceBounds.width,
      sourceBounds.height * 2 / 3,
    );
    if (sourceWidth > 0) return sourceWidth * 0.172;
  }
  const width = host.clientWidth || globalThis.innerWidth * 0.55;
  const height = host.clientHeight || globalThis.innerHeight * 0.58;
  const viewportWidth = globalThis.innerWidth || width;
  const stacked = width / viewportWidth > 0.72;
  const compact = stacked && width <= 410;
  const minimum = compact ? 38 : 42;
  const maximum = compact ? 42 : stacked ? 46 : 49;
  return Math.max(minimum, Math.min(maximum, width * 0.135, height * 0.135));
}

function base64Bytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function uint16(value: string): Uint16Array {
  const bytes = base64Bytes(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint16Array.from(
    { length: bytes.byteLength / 2 },
    (_, index) => view.getUint16(index * 2, true),
  );
}

function uint32(value: string): Uint32Array {
  const bytes = base64Bytes(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from(
    { length: bytes.byteLength / 4 },
    (_, index) => view.getUint32(index * 4, true),
  );
}

function backgroundOffset(row: number, height: number): string {
  const offset = -row * height;
  return `${Object.is(offset, -0) ? 0 : offset}px`;
}

function createRotationLightingRuntime(
  target: PolyMorphMountedModel,
  program: FacesJsProgram,
): RotationLightingRuntime {
  const contract = program.scene.rotationLighting;
  const imageUrl = program.scene.rotationAtlas.url;
  const transitions = contract.transitions;
  const initialRows = base64Bytes(contract.state.initialRowsBase64);
  const offsets = uint32(transitions.offsetsBase64);
  const faceIndices = uint16(transitions.faceIndicesBase64);
  const forwardRows = base64Bytes(transitions.forwardRowsBase64);
  const backwardRows = base64Bytes(transitions.backwardRowsBase64);
  const elements = new Array<HTMLElement>(contract.leafIds.length);
  const heights = new Float64Array(contract.leafIds.length);
  for (const [index, leafId] of contract.leafIds.entries()) {
    const handle = target.leafHandles.get(leafId);
    if (!handle) throw new TypeError(`FacesJS rotation lighting has no leaf ${leafId}.`);
    const width = handle.plan.width;
    const height = handle.plan.height;
    const style = handle.element.style;
    style.setProperty("background-image", `url("${imageUrl}")`, "important");
    style.setProperty("background-color", "transparent", "important");
    style.backgroundPositionX = `${-index * width}px`;
    style.backgroundPositionY = backgroundOffset(initialRows[index]!, height);
    style.backgroundRepeat = "no-repeat";
    style.backgroundSize =
      `${contract.leafIds.length * width}px ${contract.state.spinSteps * height}px`;
    style.imageRendering = "pixelated";
    elements[index] = handle.element;
    heights[index] = height;
  }
  const dirtyFlags = new Uint8Array(contract.leafIds.length);
  const dirtyRows = new Uint8Array(contract.leafIds.length);
  const dirtyFaces = new Uint16Array(contract.leafIds.length);
  let currentState = 0;
  let stateWrites = 0;
  let statePublications = 0;
  let maximumBatch = 0;
  let destroyed = false;
  const collect = (
    edge: number,
    rows: Uint8Array,
    initialDirtyCount: number,
  ): number => {
    let dirtyCount = initialDirtyCount;
    for (let cursor = offsets[edge]!; cursor < offsets[edge + 1]!; cursor += 1) {
      const face = faceIndices[cursor]!;
      if (dirtyFlags[face] === 0) {
        dirtyFlags[face] = 1;
        dirtyFaces[dirtyCount] = face;
        dirtyCount += 1;
      }
      dirtyRows[face] = rows[cursor]!;
    }
    return dirtyCount;
  };
  return Object.freeze({
    get stats() {
      return Object.freeze({
        currentState,
        stateWrites,
        statePublications,
        maximumBatch,
        texelLeaves: contract.leafIds.length,
      });
    },
    apply(yawDegrees: number): void {
      if (destroyed) throw new Error("FacesJS rotation lighting is destroyed.");
      const normalized = ((yawDegrees % 360) + 360) % 360;
      const nextState = Math.round(
        normalized * contract.state.spinSteps / 360,
      ) % contract.state.spinSteps;
      if (nextState === currentState) return;
      const forwardDistance = (
        nextState - currentState + contract.state.spinSteps
      ) % contract.state.spinSteps;
      const backwardDistance = (
        currentState - nextState + contract.state.spinSteps
      ) % contract.state.spinSteps;
      let dirtyCount = 0;
      let state = currentState;
      if (forwardDistance <= backwardDistance) {
        for (let step = 0; step < forwardDistance; step += 1) {
          state = (state + 1) % contract.state.spinSteps;
          dirtyCount = collect(state, forwardRows, dirtyCount);
        }
      } else {
        for (let step = 0; step < backwardDistance; step += 1) {
          const edge = state;
          state = (state + contract.state.spinSteps - 1)
            % contract.state.spinSteps;
          dirtyCount = collect(edge, backwardRows, dirtyCount);
        }
      }
      for (let index = 0; index < dirtyCount; index += 1) {
        const face = dirtyFaces[index]!;
        elements[face]!.style.backgroundPositionY = backgroundOffset(
          dirtyRows[face]!,
          heights[face]!,
        );
        dirtyFlags[face] = 0;
      }
      currentState = nextState;
      stateWrites += dirtyCount;
      statePublications += 1;
      maximumBatch = Math.max(maximumBatch, dirtyCount);
    },
    destroy(): void {
      destroyed = true;
    },
  });
}

export function mountFacesJsScene(
  host: HTMLElement,
  program: FacesJsProgram,
): FacesJsMountedScene {
  host.replaceChildren();
  const framing = MODEL_FRAMING_BY_ID[program.scene.id]
    ?? MODEL_FRAMING_BY_ID["facesjs-lowpoly-head"]!;
  const camera = createPolyOrthographicCamera({
    distance: 0,
    rotX: 0,
    rotY: 0,
    target: [0, 0, 0],
    zoom: resolveZoom(host),
  });
  const mounted = mountPolyMorphModel(host, program.scene.model, {
    camera,
    resources: program.scene.morphResources,
  });
  const deformation = createPolyMorphDeformationRuntime(program.scene.model);
  const rotationLighting = createRotationLightingRuntime(mounted, program);
  const values: Record<FacesJsMorphId, number> = {
    fatness: program.scene.faceConfig.fatness,
    "body-size": program.scene.faceConfig.body.size,
    "ear-size": program.scene.faceConfig.ear.size,
    "nose-size": program.scene.faceConfig.nose.size,
    brow: program.scene.faceConfig.eyebrow.angle,
  };
  const ranges = Object.freeze({
    fatness: [0, 1],
    "body-size": [0.75, 1.25],
    "ear-size": [0.5, 1.5],
    "nose-size": [0.5, 1.25],
    brow: [-15, 20],
  } satisfies Record<FacesJsMorphId, readonly [number, number]>);
  let tick = 0;
  let pitch = 0;
  let yaw = 0;
  let pointerId: number | null = null;
  let previousX = 0;
  let previousY = 0;
  let stopped = false;
  let destroyed = false;

  const morphWeights = (): Readonly<Record<string, number>> => Object.freeze({
    fatness: values.fatness,
    "body-size": (values["body-size"] - 0.75) / 0.5,
    "ear-size": (values["ear-size"] - 0.5) / 1,
    "nose-size": (values["nose-size"] - 0.5) / 0.75,
    "brow-up": Math.max(0, -values.brow / 15),
    "brow-down": Math.max(0, values.brow / 20),
  });
  const renderMorph = (): void => {
    const frame = deformation.sample({ tick, morphWeights: morphWeights() });
    tick += 1;
    mounted.apply({ leaves: frame.leafUpdates });
    mounted.assertStableDomIdentity();
  };
  const applyOrbit = (): void => {
    mounted.apply({
      modelMatrix: multiply(
        translationY(framing.translationY),
        multiply(
          multiply(rotationX(pitch), rotationY(yaw)),
          scaleY(framing.scaleY),
        ),
      ),
    });
    rotationLighting.apply(yaw);
  };
  const assertActive = (): void => {
    if (destroyed) throw new Error("The FacesJS scene is destroyed.");
  };
  const controller: FacesJsPrototypeController = Object.freeze({
    setMorph(id: FacesJsMorphId, value: number): void {
      assertActive();
      if (!Number.isFinite(value)) throw new TypeError("FacesJS morph values must be finite.");
      const [minimum, maximum] = ranges[id];
      values[id] = clamp(value, minimum, maximum);
      renderMorph();
    },
    setOrbit(yawDegrees: number, pitchDegrees: number = pitch): void {
      assertActive();
      if (!Number.isFinite(yawDegrees) || !Number.isFinite(pitchDegrees)) {
        throw new TypeError("FacesJS orbit angles must be finite.");
      }
      yaw = yawDegrees;
      pitch = clamp(pitchDegrees, -28, 28);
      applyOrbit();
    },
    snapshot(): FacesJsPrototypeSnapshot {
      const leaves = [...mounted.leafHandles.values()];
      return Object.freeze({
        ready: !destroyed,
        modelId: program.scene.id,
        profile: program.manifest.profile,
        generationHash: program.manifest.generationHash,
        leaves: leaves.length,
        canvases: host.querySelectorAll("canvas").length,
        solidQuads: leaves.filter(({ plan }) => plan.strategy === "solid-quad").length,
        solidTriangles: leaves.filter(
          ({ plan }) => plan.strategy === "solid-triangle",
        ).length,
        topologyConstructions: mounted.stats.topologyConstructions,
        applyCount: mounted.stats.applyCount,
        rotationLightingState: rotationLighting.stats.currentState,
        rotationLightingWrites: rotationLighting.stats.stateWrites,
        rotationLightingPublications: rotationLighting.stats.statePublications,
        rotationLightingMaximumBatch: rotationLighting.stats.maximumBatch,
        rotationLightingTexels: rotationLighting.stats.texelLeaves,
        weights: morphWeights(),
      });
    },
  });

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || pointerId !== null) return;
    pointerId = event.pointerId;
    previousX = event.clientX;
    previousY = event.clientY;
    host.setPointerCapture(pointerId);
    host.dataset.dragging = "true";
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    yaw += (event.clientX - previousX) * 0.32;
    pitch = clamp(pitch - (event.clientY - previousY) * 0.24, -28, 28);
    previousX = event.clientX;
    previousY = event.clientY;
    applyOrbit();
  };
  const onPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    if (host.hasPointerCapture(pointerId)) host.releasePointerCapture(pointerId);
    pointerId = null;
    delete host.dataset.dragging;
  };
  const onDoubleClick = (): void => {
    pitch = -4;
    yaw = 0;
    applyOrbit();
  };
  const onResize = (): void => {
    camera.update({ zoom: resolveZoom(host) });
    mounted.updateCamera();
  };
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerRelease);
  host.addEventListener("pointercancel", onPointerRelease);
  host.addEventListener("dblclick", onDoubleClick);
  globalThis.addEventListener("resize", onResize);

  renderMorph();
  applyOrbit();
  host.dataset.facesJsReady = "true";
  const debugGlobal = globalThis as DebugGlobal;
  debugGlobal.__facesJsPrototype = controller;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerRelease);
    host.removeEventListener("pointercancel", onPointerRelease);
    host.removeEventListener("dblclick", onDoubleClick);
    globalThis.removeEventListener("resize", onResize);
    delete host.dataset.dragging;
  };
  return Object.freeze({
    mounted,
    controller,
    stop,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stop();
      rotationLighting.destroy();
      mounted.destroy();
      delete host.dataset.facesJsReady;
      if (debugGlobal.__facesJsPrototype === controller) {
        delete debugGlobal.__facesJsPrototype;
      }
    },
  });
}
