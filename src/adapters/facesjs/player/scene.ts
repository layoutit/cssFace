import {
  collectPolyRenderStats,
  createPolyOrthographicCamera,
  createPolyScene,
  queryPolyLeaves,
  type ParseResult,
  type PolyMeshHandle,
  type PolySceneHandle,
} from "@layoutit/polycss";

import type {
  FacesJsFaceConfig,
  FacesJsProgram,
} from "./model.js";
import {
  resolveFacesJsMorphWeights,
  validateFacesJsFaceConfig,
} from "./configTransforms.js";

export interface FacesJsPrototypeSnapshot {
  readonly ready: boolean;
  readonly renderer: "dom-css";
  readonly faceConfig: FacesJsFaceConfig;
  readonly modelId: string;
  readonly fixtureId: string;
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
  readonly materialVariableWrites: number;
  readonly leafIdentity: string;
  readonly selectedComponents: readonly string[];
  readonly weights: Readonly<Record<string, number>>;
}

export interface FacesJsPrototypeController {
  setFaceConfig(config: FacesJsFaceConfig): Promise<void>;
  setOrbit(yawDegrees: number): void;
  snapshot(): FacesJsPrototypeSnapshot;
}

export interface FacesJsMountedScene {
  readonly scene: PolySceneHandle;
  readonly mesh: PolyMeshHandle;
  readonly controller: FacesJsPrototypeController;
  stop(): void;
  destroy(): void;
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

type DebugGlobal = typeof globalThis & {
  __facesJsPrototype?: FacesJsPrototypeController;
};

const ROTATION_ROW_VARIABLE = "--cssface-rotation-row";

interface VerticalPixelBounds {
  readonly top: number;
  readonly bottom: number;
}

interface VerticalFramingReference {
  readonly centerWorldX: number;
  readonly heightWorld: number;
}

function verticalBounds(elements: readonly Element[]): VerticalPixelBounds | undefined {
  let top = Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    const bounds = element.getBoundingClientRect();
    if ((!bounds.width && !bounds.height)
      || !Number.isFinite(bounds.top)
      || !Number.isFinite(bounds.bottom)) continue;
    top = Math.min(top, bounds.top);
    bottom = Math.max(bottom, bounds.bottom);
  }
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom > top
    ? Object.freeze({ top, bottom })
    : undefined;
}

function sourcePaintFrame(host: HTMLElement): VerticalPixelBounds | undefined {
  const sourceFace = host.ownerDocument.querySelector<HTMLElement>("#source-face");
  const sourceCanvas = sourceFace?.closest<HTMLElement>(".source-canvas");
  const svg = sourceFace?.querySelector<SVGSVGElement>("svg");
  if (!sourceCanvas || !svg) return undefined;
  const canvasBounds = sourceCanvas.getBoundingClientRect();
  if (canvasBounds.height <= 0) return undefined;
  const paintedBounds = verticalBounds([...svg.querySelectorAll<SVGGraphicsElement>(
    "path,circle,ellipse,rect,polygon,polyline,line",
  )]);
  if (!paintedBounds) return undefined;
  return Object.freeze({
    top: (paintedBounds.top - canvasBounds.top) / canvasBounds.height,
    bottom: (paintedBounds.bottom - canvasBounds.top) / canvasBounds.height,
  });
}

function captureVerticalFraming(
  host: HTMLElement,
  polygonCount: number,
  zoom: number,
  targetWorldX: number,
): VerticalFramingReference | undefined {
  if (!(zoom > 0)) return undefined;
  const hostBounds = host.getBoundingClientRect();
  if (hostBounds.height <= 0) return undefined;
  const leafBounds = verticalBounds(
    queryPolyLeaves(host, polygonCount).map(({ element }) => element),
  );
  if (!leafBounds) return undefined;
  const centerPx = (leafBounds.top + leafBounds.bottom) / 2;
  return Object.freeze({
    centerWorldX: targetWorldX
      + ((centerPx - (hostBounds.top + hostBounds.height / 2)) / zoom),
    heightWorld: (leafBounds.bottom - leafBounds.top) / zoom,
  });
}

function alignedCameraFrame(
  host: HTMLElement,
  reference: VerticalFramingReference,
): Readonly<{ zoom: number; targetWorldX: number }> | undefined {
  const sourceFrame = sourcePaintFrame(host);
  const hostBounds = host.getBoundingClientRect();
  if (!sourceFrame || hostBounds.height <= 0 || !(reference.heightWorld > 0)) {
    return undefined;
  }
  const paintedHeight = (sourceFrame.bottom - sourceFrame.top) * hostBounds.height;
  const zoom = paintedHeight / reference.heightWorld;
  if (!(zoom > 0) || !Number.isFinite(zoom)) return undefined;
  const paintedCenterOffset = (
    ((sourceFrame.top + sourceFrame.bottom) / 2) - 0.5
  ) * hostBounds.height;
  return Object.freeze({
    zoom,
    targetWorldX: reference.centerWorldX - (paintedCenterOffset / zoom),
  });
}

function resolveZoom(host: HTMLElement): number {
  const sourceFace = host.ownerDocument.querySelector<HTMLElement>("#source-face");
  if (sourceFace) {
    const sourceBounds = sourceFace.getBoundingClientRect();
    const sourceWidth = Math.min(sourceBounds.width, sourceBounds.height * 2 / 3);
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

function parseResult(program: FacesJsProgram): ParseResult {
  return {
    polygons: program.scene.polygons.map((polygon) => ({
      vertices: polygon.vertices.map((vertex) => [...vertex]),
      color: polygon.color,
      doubleSided: polygon.doubleSided,
    })),
    objectUrls: [],
    warnings: [],
    dispose: () => {},
  };
}

function identity(root: ParentNode, polygonCount: number): string {
  let hash = 2166136261;
  const leaves = queryPolyLeaves(root, polygonCount);
  for (const [index, leaf] of leaves.entries()) {
    const value = `${index}:${leaf.element.tagName}:${leaf.strategy}`;
    for (let offset = 0; offset < value.length; offset += 1) {
      hash ^= value.charCodeAt(offset);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${leaves.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sameFaceConfig(left: FacesJsFaceConfig, right: FacesJsFaceConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function imageReady(document: Document, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = document.createElement("img");
    image.decoding = "async";
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("FacesJS prepared lighting atlas failed to load."));
    image.src = url;
  });
}

function leafPrimitiveSize(
  element: HTMLElement,
  strategy: "quad" | "clippedSolid" | "atlas" | "stableTriangle",
): readonly [number, number] {
  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element);
  const width = Number.parseFloat(computed?.width ?? "");
  const height = Number.parseFloat(computed?.height ?? "");
  const fallback = strategy === "quad"
    ? 64
    : strategy === "clippedSolid"
      ? 16
      : strategy === "stableTriangle"
        ? 32
        : 128;
  return Object.freeze([
    Number.isFinite(width) && width > 0 ? width : fallback,
    Number.isFinite(height) && height > 0 ? height : fallback,
  ]);
}

async function createRotationLightingRuntime(
  mesh: PolyMeshHandle,
  program: FacesJsProgram,
): Promise<RotationLightingRuntime> {
  const contract = program.scene.rotationLighting;
  const diffuse = program.scene.rotationDiffuse;
  const specular = program.scene.rotationSpecular;
  await Promise.all([
    mesh.whenTexturesReady(),
    imageReady(mesh.element.ownerDocument, diffuse.url),
    imageReady(mesh.element.ownerDocument, specular.url),
  ]);
  const queried = queryPolyLeaves(mesh.element, contract.leafIds.length);
  const leaves = new Array<(typeof queried)[number] | null>(
    contract.leafIds.length,
  ).fill(null);
  for (const leaf of queried) {
    if (leaf.polygonIndex === undefined
      || leaf.polygonIndex < 0
      || leaf.polygonIndex >= leaves.length
      || leaves[leaf.polygonIndex]) {
      throw new TypeError("FacesJS prepared lighting lost PolyCSS polygon identity.");
    }
    leaves[leaf.polygonIndex] = leaf;
  }
  if (leaves.some((leaf) => leaf === null)) {
    throw new TypeError("FacesJS prepared lighting has an incomplete PolyCSS leaf set.");
  }
  const fieldSourcePx = contract.state.fieldSourcePx;
  const columns = contract.atlases.diffuse.width / fieldSourcePx;
  for (const [index, leaf] of leaves.entries()) {
    if (!leaf) throw new TypeError("FacesJS prepared lighting lost a PolyCSS leaf.");
    const [width, height] = leafPrimitiveSize(leaf.element, leaf.strategy);
    const column = index % columns;
    const page = Math.floor(index / columns);
    const x = -column * width;
    const baseY = -page * contract.state.spinSteps * height;
    const backgroundPosition = [
      `${x}px calc(${baseY}px + var(${ROTATION_ROW_VARIABLE}) * ${-height}px)`,
      `${x}px calc(${baseY}px + var(${ROTATION_ROW_VARIABLE}) * ${-height}px)`,
      "0 0",
    ].join(", ");
    const atlasWidth = contract.atlases.diffuse.width / fieldSourcePx * width;
    const atlasHeight = contract.atlases.diffuse.height / fieldSourcePx * height;
    const backgroundSize = [
      `${atlasWidth}px ${atlasHeight}px`,
      `${atlasWidth}px ${atlasHeight}px`,
      "auto",
    ].join(", ");
    const style = leaf.element.style;
    style.setProperty("color", program.scene.polygons[index]!.color, "important");
    style.setProperty(
      "background-image",
      `url("${specular.url}"), url("${diffuse.url}"), linear-gradient(currentcolor, currentcolor)`,
      "important",
    );
    style.setProperty("background-color", "transparent", "important");
    style.setProperty("background-position", backgroundPosition, "important");
    style.setProperty("background-size", backgroundSize, "important");
    style.setProperty("background-repeat", "no-repeat, no-repeat, no-repeat", "important");
    style.setProperty("background-blend-mode", "screen, multiply, normal", "important");
    style.setProperty("image-rendering", "pixelated", "important");
    if (leaf.strategy === "clippedSolid") {
      style.setProperty("background-clip", "border-area", "important");
    }
  }
  mesh.element.style.setProperty(ROTATION_ROW_VARIABLE, "0");
  let currentState = 0;
  let stateWrites = 0;
  let statePublications = 0;
  let maximumBatch = 0;
  let destroyed = false;
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
      if (destroyed) throw new Error("FacesJS prepared lighting is destroyed.");
      const normalized = ((yawDegrees % 360) + 360) % 360;
      const nextState = Math.round(
        normalized * contract.state.spinSteps / 360,
      ) % contract.state.spinSteps;
      if (nextState === currentState) return;
      mesh.element.style.setProperty(ROTATION_ROW_VARIABLE, String(nextState));
      currentState = nextState;
      stateWrites += 1;
      statePublications += 1;
      maximumBatch = 1;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      mesh.element.style.removeProperty(ROTATION_ROW_VARIABLE);
    },
  });
}

export async function mountFacesJsScene(
  host: HTMLElement,
  program: FacesJsProgram,
  faceConfig: FacesJsFaceConfig = program.scene.faceConfig,
): Promise<FacesJsMountedScene> {
  host.replaceChildren();
  const initialFaceConfig = validateFacesJsFaceConfig(faceConfig);
  if (!sameFaceConfig(initialFaceConfig, program.scene.faceConfig)) {
    throw new TypeError("This CSSFace package contains a different prebaked FaceConfig.");
  }
  const initialZoom = resolveZoom(host);
  const camera = createPolyOrthographicCamera({
    distance: 0,
    rotX: 0,
    rotY: 0,
    target: [0, 0, 0],
    zoom: initialZoom,
  });
  const scene = createPolyScene(host, {
    camera,
    ambientLight: { color: "#ffffff", intensity: 1 },
    directionalLight: {
      direction: [0, 0, 1],
      color: "#ffffff",
      intensity: 0,
    },
    textureLighting: "baked",
    seamBleed: 0,
  });
  const mesh = scene.add(parseResult(program), {
    id: program.scene.id,
    merge: false,
    meshResolution: "lossless",
  });
  scene.applyCamera();
  const verticalFraming = captureVerticalFraming(
    host,
    program.scene.polygons.length,
    initialZoom,
    0,
  );
  if (verticalFraming) {
    const frame = alignedCameraFrame(host, verticalFraming);
    if (frame) {
      camera.update({
        zoom: frame.zoom,
        target: [frame.targetWorldX, 0, 0],
      });
      scene.applyCamera();
    }
  }
  let rotationLighting: RotationLightingRuntime;
  try {
    rotationLighting = await createRotationLightingRuntime(mesh, program);
  } catch (error) {
    scene.destroy();
    throw error;
  }

  let currentConfig = initialFaceConfig;
  let yaw = 0;
  let pointerId: number | null = null;
  let previousX = 0;
  let stopped = false;
  let destroyed = false;
  let applyCount = 0;

  const assertActive = (): void => {
    if (destroyed) throw new Error("The FacesJS scene is destroyed.");
  };
  const applyOrbit = (): void => {
    mesh.setTransform({ rotation: [yaw, 0, 0] });
    rotationLighting.apply(yaw);
    applyCount += 1;
  };
  const controller: FacesJsPrototypeController = Object.freeze({
    async setFaceConfig(config: FacesJsFaceConfig): Promise<void> {
      assertActive();
      const validated = validateFacesJsFaceConfig(config);
      if (!sameFaceConfig(validated, program.scene.faceConfig)) {
        throw new TypeError("Switch the prepared model to render a different FaceConfig.");
      }
      currentConfig = validated;
    },
    setOrbit(yawDegrees: number): void {
      assertActive();
      if (!Number.isFinite(yawDegrees)) {
        throw new TypeError("FacesJS orbit angle must be finite.");
      }
      yaw = yawDegrees;
      applyOrbit();
    },
    snapshot(): FacesJsPrototypeSnapshot {
      const stats = collectPolyRenderStats(host, program.scene.polygons.length);
      return Object.freeze({
        ready: !destroyed,
        renderer: "dom-css",
        faceConfig: currentConfig,
        modelId: program.scene.id,
        fixtureId: program.scene.fixtureId,
        profile: program.manifest.profile,
        generationHash: program.manifest.generationHash,
        leaves: stats.mountedPolygonLeafCount,
        canvases: host.querySelectorAll("canvas").length,
        solidQuads: stats.surfaceLeafCounts.quad,
        solidTriangles: stats.surfaceLeafCounts.stableTriangle,
        topologyConstructions: 1,
        applyCount,
        rotationLightingState: rotationLighting.stats.currentState,
        rotationLightingWrites: rotationLighting.stats.stateWrites,
        rotationLightingPublications: rotationLighting.stats.statePublications,
        rotationLightingMaximumBatch: rotationLighting.stats.maximumBatch,
        rotationLightingTexels: rotationLighting.stats.texelLeaves,
        materialVariableWrites: 0,
        leafIdentity: identity(host, program.scene.polygons.length),
        selectedComponents: program.scene.selectedKeys,
        weights: resolveFacesJsMorphWeights(currentConfig),
      });
    },
  });

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || pointerId !== null) return;
    pointerId = event.pointerId;
    previousX = event.clientX;
    host.setPointerCapture(pointerId);
    host.dataset.dragging = "true";
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    const deltaX = event.clientX - previousX;
    previousX = event.clientX;
    if (deltaX === 0) return;
    yaw -= deltaX * 0.32;
    applyOrbit();
  };
  const onPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    if (host.hasPointerCapture(pointerId)) host.releasePointerCapture(pointerId);
    pointerId = null;
    delete host.dataset.dragging;
  };
  const onDoubleClick = (): void => {
    yaw = 0;
    applyOrbit();
  };
  const onResize = (): void => {
    const frame = verticalFraming && alignedCameraFrame(host, verticalFraming);
    if (frame) {
      camera.update({
        zoom: frame.zoom,
        target: [frame.targetWorldX, 0, 0],
      });
    } else {
      camera.update({ zoom: resolveZoom(host) });
    }
    scene.applyCamera();
  };
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerRelease);
  host.addEventListener("pointercancel", onPointerRelease);
  host.addEventListener("dblclick", onDoubleClick);
  globalThis.addEventListener("resize", onResize);

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
    scene,
    mesh,
    controller,
    stop,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stop();
      rotationLighting.destroy();
      scene.destroy();
      delete host.dataset.facesJsReady;
      if (debugGlobal.__facesJsPrototype === controller) {
        delete debugGlobal.__facesJsPrototype;
      }
    },
  });
}
