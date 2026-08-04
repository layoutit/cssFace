import { display, type FaceConfig } from "facesjs";
import { toBlob } from "html-to-image";

import {
  mountCssGraphics,
  type CssGraphicsExperience,
} from "../../../index.js";
import {
  CSSFACE_MAXIMUM_SEED,
  CSSFACE_GENERATOR_ID,
  CSSFACE_PREPARED_FACE_CATALOG_SCHEMA,
  createCssFaceShareUrl,
  readCssFaceShareUrl,
  serializeFacesJsFaceConfig,
} from "../player/faceConfigResolver.js";
import type {
  FacesJsPrototypeController,
} from "../player/scene.js";
import {
  facesJsSnippet,
  facesJsSnippetBody,
} from "./facesJsSnippet.js";

import "@fontsource/archivo-black/400.css";
import "../../../style.css";
import "./preview.css";

type MobileView = "2d" | "3d";

interface FacePreset {
  readonly id: number;
  readonly name: string;
  readonly modelId: string;
  readonly random?: boolean;
  readonly face: FaceConfig;
}

interface PreparedFaceCatalog {
  readonly schema: typeof CSSFACE_PREPARED_FACE_CATALOG_SCHEMA;
  readonly generator: typeof CSSFACE_GENERATOR_ID;
  readonly models: readonly FacePreset[];
}

type DebugGlobal = typeof globalThis & {
  __facesJsPrototype?: FacesJsPrototypeController;
  __cssFacePreview?: Readonly<{
    renderSource(config: FaceConfig): readonly string[];
    setFaceConfig(config: FaceConfig): Promise<boolean>;
    setOrbit(yawDegrees: number): void;
  }>;
};

interface FaceLoadingState {
  hideTimer: ReturnType<typeof setTimeout> | undefined;
  startedAt: number;
}

const DEFAULT_SEED = 0;
const SEED_UPDATE_DELAY_MS = 80;
const SPINNER_MINIMUM_VISIBLE_MS = 700;

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

function faceKey(face: FaceConfig): string {
  return serializeFacesJsFaceConfig(face);
}

function modelIndexForSeed(seed: number, count: number): number {
  let value = seed >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) % count;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

async function loadPreparedModels(): Promise<readonly FacePreset[]> {
  const response = await fetch("/cssgraphics/faces.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`CSSFace prepared face catalog returned ${response.status}.`);
  }
  const catalog = await response.json() as PreparedFaceCatalog;
  if (catalog.schema !== CSSFACE_PREPARED_FACE_CATALOG_SCHEMA
    || catalog.generator !== CSSFACE_GENERATOR_ID
    || !Array.isArray(catalog.models)) {
    throw new TypeError("CSSFace prepared face catalog is incompatible.");
  }
  return Object.freeze(catalog.models.map((model) => {
    if (!model || typeof model !== "object"
      || !Number.isSafeInteger(model.id) || model.id < 0
      || typeof model.name !== "string" || model.name.length === 0
      || typeof model.modelId !== "string" || model.modelId.length === 0) {
      throw new TypeError("CSSFace prepared face catalog has an invalid model row.");
    }
    faceKey(model.face);
    return Object.freeze(model);
  }));
}

const preparedModels = await loadPreparedModels();
if (preparedModels.length === 0) {
  throw new Error("CSSFace has no prepared model packages.");
}
const modelsByFace = new Map(
  preparedModels.map((model) => [faceKey(model.face), model]),
);

function modelForSeed(seed: number): FacePreset {
  return preparedModels[
    modelIndexForSeed(seed, preparedModels.length)
  ]!;
}

function modelForFace(face: FaceConfig): FacePreset | undefined {
  return modelsByFace.get(faceKey(face));
}

function randomSeed(excludedModelId?: string): number {
  const value = new Uint32Array(1);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    crypto.getRandomValues(value);
    const seed = (value[0] ?? DEFAULT_SEED) % (CSSFACE_MAXIMUM_SEED + 1);
    if (preparedModels.length === 1
      || modelForSeed(seed).modelId !== excludedModelId) return seed;
  }
  return (DEFAULT_SEED + 1) % (CSSFACE_MAXIMUM_SEED + 1);
}

const outputCanvas = requiredElement<HTMLDivElement>(".stage");
const stage = requiredElement<HTMLDivElement>("#stage");
const leafCount = requiredElement<HTMLElement>("#leaf-count");
const canvasCount = requiredElement<HTMLElement>("#canvas-count");
const topologyState = requiredElement<HTMLElement>("#topology-state");
const sourceCanvas = requiredElement<HTMLDivElement>(".source-canvas");
const sourceFace = requiredElement<HTMLDivElement>("#source-face");
const sourceLoadingSpinner = requiredElement<HTMLDivElement>(
  "#source-loading-spinner",
);
const polyCssLoadingSpinner = requiredElement<HTMLDivElement>(
  "#polycss-loading-spinner",
);
const faceConfigSummary = requiredElement<HTMLElement>("#face-config-summary");
const facesJsCode = requiredElement<HTMLElement>("#facesjs-code");
const polyCssCode = requiredElement<HTMLElement>("#polycss-code");
const codePenForm = requiredElement<HTMLFormElement>("#codepen-form");
const codePenData = requiredElement<HTMLInputElement>("#codepen-data");
const codePenButton = requiredElement<HTMLButtonElement>("#codepen-button");
const randomButton = requiredElement<HTMLButtonElement>("#random-button");
const seedInput = requiredElement<HTMLInputElement>("#seed-input");
const shareButton = requiredElement<HTMLButtonElement>("#share-button");
const downloadButton = requiredElement<HTMLButtonElement>("#download-button");
const actionStatus = requiredElement<HTMLElement>("#action-status");
const comparisonLab = requiredElement<HTMLElement>("#comparison-lab");
const mobileViewToggle = requiredElement<HTMLElement>("#mobile-view-toggle");
const sourcePanel = requiredElement<HTMLElement>(".source-panel");
const outputPanel = requiredElement<HTMLElement>(".output-panel");
const mobileViewButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-mobile-view]"),
];
const mobileViewMedia = matchMedia("(max-width: 720px)");

const faceLoadingStates = new Map<HTMLElement, FaceLoadingState>([
  [sourceLoadingSpinner, { hideTimer: undefined, startedAt: performance.now() }],
  [polyCssLoadingSpinner, { hideTimer: undefined, startedAt: performance.now() }],
]);

const sharedState = readCssFaceShareUrl(globalThis.location.href);
const initialSeed = sharedState?.seed ?? randomSeed();
const initialModel = sharedState
  ? modelForFace(sharedState.face as FaceConfig) ?? modelForSeed(initialSeed)
  : modelForSeed(initialSeed);
let currentFace = structuredClone(initialModel.face);
let currentModel = initialModel;
let currentSeed = initialSeed;
let experience: CssGraphicsExperience | null = null;
let controller: FacesJsPrototypeController | null = null;
let switching = true;
let downloading = false;
let mobileView: MobileView = "2d";
let seedUpdateTimer: ReturnType<typeof setTimeout> | undefined;
let orbitYaw = 0;

const codeTokenPattern =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(import|from|const|await|if|throw|new|return)\b|\b(true|false|null|undefined)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\s*:)|\b([A-Za-z_$][\w$]*)(?=\s*\()/g;

function polyCssSceneSnippet(
  faceDeclaration: readonly string[],
  faceVariable = "face",
): string {
  return [
    ...faceDeclaration,
    "",
    'const scene = createPolyScene(document.querySelector("#face-3d"), {',
    "  camera: createPolyCamera({ rotX: 0, rotY: 0, zoom: 49 }),",
    "  ambientLight: { intensity: 0.46 },",
    "  directionalLight: {",
    '    direction: [-0.18, -0.22, 0.96], color: "#fff6ec", intensity: 1.05,',
    "  },",
    "  seamBleed: 0,",
    "});",
    "",
    `scene.add({ ...${faceVariable}, dispose() {} }, { merge: false });`,
  ].join("\n");
}

function polyCssSnippet(model: FacePreset): string {
  return [
    'import { createPolyCamera, createPolyScene } from "@layoutit/polycss";',
    "",
    polyCssSceneSnippet([
      "const face = await fetch(",
      `  "https://cssface.com/f/${model.id}.json",`,
      ").then((response) => response.json());",
    ]),
  ].join("\n");
}

function highlightedCode(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const match of source.matchAll(codeTokenPattern)) {
    const index = match.index ?? 0;
    fragment.append(document.createTextNode(source.slice(offset, index)));
    const token = document.createElement("span");
    const kind = match[1]
      ? "comment"
      : match[2]
        ? "string"
        : match[3]
          ? "keyword"
          : match[4]
            ? "literal"
            : match[5]
              ? "number"
              : match[6]
                ? "property"
                : "function";
    token.className = `code-token code-token-${kind}`;
    token.textContent = match[0];
    fragment.append(token);
    offset = index + match[0].length;
  }
  fragment.append(document.createTextNode(source.slice(offset)));
  return fragment;
}

function setHighlightedCode(
  element: HTMLElement,
  source: string,
  numbered = false,
): void {
  if (!numbered) {
    element.replaceChildren(highlightedCode(source));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const [index, sourceLine] of source.split("\n").entries()) {
    const line = document.createElement("span");
    line.className = "code-line";
    const number = document.createElement("span");
    number.className = "code-line-number";
    number.setAttribute("aria-hidden", "true");
    number.textContent = String(index + 1);
    const content = document.createElement("span");
    content.className = "code-line-content";
    content.append(highlightedCode(sourceLine));
    line.append(number, content);
    fragment.append(line);
  }
  element.replaceChildren(fragment);
}

function syncCodeSamples(): void {
  setHighlightedCode(facesJsCode, facesJsSnippet(currentFace), true);
  setHighlightedCode(polyCssCode, polyCssSnippet(currentModel));
}

function currentFaceConfig(): FaceConfig {
  return structuredClone(currentFace);
}

function syncSourceFace(): void {
  syncCodeSamples();
  display(sourceFace, currentFaceConfig());
  const svg = sourceFace.querySelector<SVGSVGElement>("svg");
  if (!svg) throw new Error("FacesJS did not render an SVG.");
  svg.setAttribute("viewBox", "0 0 400 600");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `CSSFace seed ${currentSeed}`);
  requestAnimationFrame(() => {
    setFaceLoading(sourceCanvas, sourceLoadingSpinner, false);
  });
}

function syncFaceSummary(): void {
  faceConfigSummary.textContent = [
    `seed.${currentSeed}`,
    `model.${currentModel.id}`,
    `head.${currentFace.head.id}`,
    `hair.${currentFace.hair.id}`,
    `eye.${currentFace.eye.id}`,
    `eyebrow.${currentFace.eyebrow.id}`,
    `nose.${currentFace.nose.id}`,
    `mouth.${currentFace.mouth.id}`,
    `ear.${currentFace.ear.id}`,
  ].join(" · ");
}

function syncSeedControl(seed = currentSeed): void {
  seedInput.value = String(seed);
  seedInput.style.setProperty(
    "--range-progress",
    `${(seed / CSSFACE_MAXIMUM_SEED) * 100}%`,
  );
}

function syncControls(): void {
  syncSeedControl();
  syncSourceFace();
  syncFaceSummary();
}

function codePenHtml(): string {
  return [
    "<!-- FacesJS: the original 2D face. -->",
    '<section class="face-panel"><div id="face-2d"></div></section>',
    "",
    "<!-- PolyCSS: the same face rendered in 3D. -->",
    '<section class="face-panel"><div id="face-3d"></div></section>',
  ].join("\n");
}

function codePenCss(): string {
  return [
    "* { box-sizing: border-box; }",
    "html, body { width: 100%; min-height: 100%; margin: 0; }",
    "body { display: grid; min-height: 100vh; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 12px; background: #1e1e1e; }",
    ".face-panel { display: grid; min-width: 0; min-height: calc(100vh - 24px); place-items: center; overflow: hidden; border-radius: 12px; background: radial-gradient(circle at 50% 46%, #1a6b68 0 10%, #1d7774 50% 100%); }",
    "#face-2d { width: min(67%, 400px); aspect-ratio: 2 / 3; }",
    "#face-2d > svg { width: 100%; height: 100%; }",
    "#face-3d { position: relative; width: min(92%, 700px); aspect-ratio: 1; cursor: grab; touch-action: none; }",
    "#face-3d > .polycss-camera { width: 100%; height: 100%; overflow: visible; }",
    "@media (max-width: 700px) { body { grid-template-columns: 1fr; } .face-panel { min-height: min(100vw, 600px); } #face-3d { width: min(88%, 540px); } }",
  ].join("\n");
}

function codePenFaceDocumentUrl(model: FacePreset): string {
  const hostname = globalThis.location.hostname;
  const publicOrigin = hostname === "cssface.com"
    || hostname.endsWith(".cssface.com")
    || hostname.endsWith(".netlify.app")
    ? globalThis.location.origin
    : "https://cssface.com";
  return `${publicOrigin}/f/${model.id}.json`;
}

function codePenSnippet(model: FacePreset): string {
  return [
    'import { display } from "https://esm.sh/facesjs@5.0.3";',
    'import { createPolyCamera, createPolyScene, queryPolyLeaves } from "https://esm.sh/@layoutit/polycss@0.2.10";',
    "",
    "// FacesJS: render the original face in 2D.",
    facesJsSnippetBody(currentFaceConfig(), "face2d", "face-2d"),
    "",
    "// PolyCSS: render the same face in 3D.",
    `const face3dUrl = ${JSON.stringify(codePenFaceDocumentUrl(model))};`,
    "const face3d = await fetch(face3dUrl).then((response) => response.json());",
    "const face3dHost = document.querySelector(\"#face-3d\");",
    "const scene = createPolyScene(face3dHost, {",
    "  camera: createPolyCamera({ rotX: 0, rotY: 0, zoom: 49 }),",
    '  ambientLight: { color: "#fff", intensity: 1 },',
    '  directionalLight: { direction: [0, 0, 1], color: "#fff", intensity: 0 },',
    '  textureLighting: "baked",',
    "  seamBleed: 0,",
    "});",
    "const mesh = scene.add({ ...face3d, dispose() {} }, { merge: false });",
    "",
    "// Apply cssFace's prepared lighting atlas once to the retained PolyCSS leaves.",
    "const imageReady = (url) => new Promise((resolve, reject) => {",
    "  const image = new Image();",
    "  image.onload = resolve;",
    "  image.onerror = reject;",
    "  image.src = url;",
    "});",
    "const diffuseUrl = new URL(face3d.lighting.diffuse, face3dUrl).href;",
    "const specularUrl = new URL(face3d.lighting.specular, face3dUrl).href;",
    "await Promise.all([",
    "  mesh.whenTexturesReady(),",
    "  imageReady(diffuseUrl),",
    "  imageReady(specularUrl),",
    "]);",
    "const leaves = new Array(face3d.polygons.length).fill(null);",
    "for (const leaf of queryPolyLeaves(mesh.element, leaves.length)) {",
    "  leaves[leaf.polygonIndex] = leaf;",
    "}",
    "if (leaves.some((leaf) => !leaf)) throw new Error(\"Incomplete PolyCSS face\");",
    "const columns = face3d.lighting.width / face3d.lighting.sourcePx;",
    "for (const [index, leaf] of leaves.entries()) {",
    "  const computed = getComputedStyle(leaf.element);",
    "  const fallback = { quad: 64, clippedSolid: 16, stableTriangle: 32, atlas: 128 }[leaf.strategy];",
    "  const width = Number.parseFloat(computed.width) || fallback;",
    "  const height = Number.parseFloat(computed.height) || fallback;",
    "  const column = index % columns;",
    "  const page = Math.floor(index / columns);",
    "  const x = -column * width;",
    "  const y = -page * face3d.lighting.spinSteps * height;",
    "  const position = `${x}px calc(${y}px + var(--cssface-light-row) * ${-height}px)`;",
    "  const atlasWidth = face3d.lighting.width / face3d.lighting.sourcePx * width;",
    "  const atlasHeight = face3d.lighting.height / face3d.lighting.sourcePx * height;",
    "  const size = `${atlasWidth}px ${atlasHeight}px`;",
    "  const style = leaf.element.style;",
    "  style.setProperty(\"color\", face3d.polygons[index].color, \"important\");",
    "  style.setProperty(\"background-image\", `url(\"${specularUrl}\"), url(\"${diffuseUrl}\"), linear-gradient(currentcolor, currentcolor)`, \"important\");",
    "  style.setProperty(\"background-color\", \"transparent\", \"important\");",
    "  style.setProperty(\"background-position\", `${position}, ${position}, 0 0`, \"important\");",
    "  style.setProperty(\"background-size\", `${size}, ${size}, auto`, \"important\");",
    "  style.setProperty(\"background-repeat\", \"no-repeat, no-repeat, no-repeat\", \"important\");",
    "  style.setProperty(\"background-blend-mode\", \"screen, multiply, normal\", \"important\");",
    "  style.setProperty(\"image-rendering\", \"pixelated\", \"important\");",
    "  if (leaf.strategy === \"clippedSolid\") style.setProperty(\"background-clip\", \"border-area\", \"important\");",
    "}",
    "",
    "// Drag horizontally: one mesh transform plus one inherited lighting-state write.",
    "let yaw = 0;",
    "let dragX;",
    "mesh.element.style.setProperty(\"--cssface-light-row\", \"0\");",
    "face3dHost.addEventListener(\"pointerdown\", (event) => {",
    "  dragX = event.clientX;",
    "  face3dHost.setPointerCapture(event.pointerId);",
    "});",
    "face3dHost.addEventListener(\"pointermove\", (event) => {",
    "  if (!face3dHost.hasPointerCapture(event.pointerId)) return;",
    "  yaw -= (event.clientX - dragX) * 0.32;",
    "  dragX = event.clientX;",
    "  mesh.setTransform({ rotation: [yaw, 0, 0] });",
    "  const normalized = ((yaw % 360) + 360) % 360;",
    "  const row = Math.round(normalized * face3d.lighting.spinSteps / 360) % face3d.lighting.spinSteps;",
    "  mesh.element.style.setProperty(\"--cssface-light-row\", String(row));",
    "});",
  ].join("\n");
}

function codePenPayload(model: FacePreset): string {
  return JSON.stringify({
    title: `cssFace — seed ${currentSeed}`,
    description: `FacesJS and PolyCSS comparison for cssFace seed ${currentSeed}`,
    private: false,
    editors: "001",
    layout: "left",
    html: codePenHtml(),
    html_pre_processor: "none",
    css: codePenCss(),
    css_pre_processor: "none",
    css_prefix: "neither",
    js: codePenSnippet(model),
    js_pre_processor: "none",
    js_module: true,
  });
}

function setFaceLoading(
  container: HTMLElement,
  spinner: HTMLElement,
  loading: boolean,
): void {
  let state = faceLoadingStates.get(spinner);
  if (!state) {
    state = { hideTimer: undefined, startedAt: performance.now() };
    faceLoadingStates.set(spinner, state);
  }
  if (state.hideTimer !== undefined) {
    clearTimeout(state.hideTimer);
    state.hideTimer = undefined;
  }
  if (loading) {
    state.startedAt = performance.now();
    container.setAttribute("aria-busy", "true");
    spinner.hidden = false;
    return;
  }
  const hide = (): void => {
    container.setAttribute("aria-busy", "false");
    spinner.hidden = true;
    state.hideTimer = undefined;
  };
  const remaining = Math.max(
    0,
    SPINNER_MINIMUM_VISIBLE_MS - (performance.now() - state.startedAt),
  );
  if (remaining === 0) hide();
  else state.hideTimer = setTimeout(hide, remaining);
}

function syncCodePenButtonState(): void {
  codePenButton.disabled = switching;
  codePenButton.setAttribute("aria-busy", "false");
}

function syncDownloadButtonState(): void {
  const busy = switching || downloading;
  downloadButton.disabled = busy;
  downloadButton.setAttribute("aria-busy", String(downloading));
  randomButton.disabled = busy;
  seedInput.disabled = busy;
}

function setControlsBusy(busy: boolean): void {
  switching = busy;
  if (busy) {
    setFaceLoading(sourceCanvas, sourceLoadingSpinner, true);
    setFaceLoading(outputCanvas, polyCssLoadingSpinner, true);
  } else {
    setFaceLoading(outputCanvas, polyCssLoadingSpinner, false);
  }
  syncCodePenButtonState();
  syncDownloadButtonState();
}

function updateRuntimeProof(): void {
  if (!controller) return;
  const snapshot = controller.snapshot();
  leafCount.textContent = String(snapshot.leaves);
  canvasCount.textContent = String(snapshot.canvases);
  topologyState.textContent = snapshot.topologyConstructions === 1
    ? "stable"
    : "changed";
}

async function mountModel(model: FacePreset): Promise<void> {
  if (!experience) {
    experience = await mountCssGraphics(stage, {
      modelId: model.modelId,
      experienceControls: false,
    });
  } else {
    await experience.switchModel(model.modelId, "none");
  }
  const nextController = (globalThis as DebugGlobal).__facesJsPrototype;
  if (!nextController) {
    throw new Error(`CSSFace model ${model.modelId} exposed no prepared controller.`);
  }
  controller = nextController;
  controller.setOrbit(orbitYaw);
  updateRuntimeProof();
}

async function selectModel(
  nextModel: FacePreset,
  resetOrbit = false,
): Promise<boolean> {
  if (switching) return false;
  const previousFace = currentFace;
  const previousModel = currentModel;
  const previousYaw = orbitYaw;
  setControlsBusy(true);
  if (resetOrbit) {
    orbitYaw = 0;
  }
  currentModel = nextModel;
  currentFace = structuredClone(nextModel.face);
  syncControls();
  try {
    await mountModel(nextModel);
    document.documentElement.dataset.prototypeReady = "true";
    return true;
  } catch (error) {
    globalThis.console.error(error);
    currentModel = previousModel;
    currentFace = previousFace;
    orbitYaw = previousYaw;
    syncControls();
    try {
      await mountModel(previousModel);
      document.documentElement.dataset.prototypeReady = "true";
    } catch (rollbackError) {
      document.documentElement.dataset.prototypeReady = "error";
      globalThis.console.error(rollbackError);
    }
    return false;
  } finally {
    setControlsBusy(false);
  }
}

async function selectFaceConfig(
  nextFace: FaceConfig,
  resetOrbit = false,
): Promise<boolean> {
  const nextModel = modelForFace(nextFace);
  if (!nextModel) return false;
  if (nextModel.modelId === currentModel.modelId) {
    currentFace = structuredClone(nextModel.face);
    if (resetOrbit) controller?.setOrbit(0);
    syncControls();
    return true;
  }
  return selectModel(nextModel, resetOrbit);
}

async function selectSeed(seed: number, resetOrbit = false): Promise<void> {
  const normalizedSeed = clamp(
    Math.round(seed),
    DEFAULT_SEED,
    CSSFACE_MAXIMUM_SEED,
  );
  if (switching) return;
  const previousSeed = currentSeed;
  const nextModel = modelForSeed(normalizedSeed);
  currentSeed = normalizedSeed;
  if (nextModel.modelId === currentModel.modelId) {
    if (resetOrbit) controller?.setOrbit(0);
    syncControls();
    return;
  }
  const didSelect = await selectModel(nextModel, resetOrbit);
  if (!didSelect) {
    currentSeed = previousSeed;
    syncSeedControl();
  }
}

function queueSeed(seed: number, immediate = false): void {
  if (seedUpdateTimer !== undefined) clearTimeout(seedUpdateTimer);
  syncSeedControl(seed);
  if (immediate) {
    seedUpdateTimer = undefined;
    void selectSeed(seed);
    return;
  }
  seedUpdateTimer = setTimeout(() => {
    seedUpdateTimer = undefined;
    void selectSeed(seed);
  }, SEED_UPDATE_DELAY_MS);
}

async function shareCurrentFace(): Promise<void> {
  const face = currentFaceConfig();
  const data = {
    title: "cssFace",
    text: `seed ${currentSeed}\n${JSON.stringify(face)}`,
    url: createCssFaceShareUrl(location.href, face, currentSeed).href,
  };
  if (navigator.share) {
    await navigator.share(data);
    return;
  }
  await navigator.clipboard.writeText(`${data.url}\n${data.text}`);
  actionStatus.textContent = "Face link and config copied.";
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function captureFaceImage(
  container: HTMLElement,
  panel: HTMLElement,
): Promise<Blob> {
  const wasHidden = getComputedStyle(panel).display === "none";
  if (wasHidden) {
    panel.classList.add("download-capture-panel");
    await waitForPaint();
  }

  try {
    const { width, height } = container.getBoundingClientRect();
    if (width <= 0 || height <= 0) {
      throw new Error("The face image has no rendered dimensions.");
    }
    const blob = await toBlob(container, {
      width,
      height,
      pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
      skipFonts: true,
      filter: (node) => {
        const classList = (node as Partial<Element>).classList;
        return !classList?.contains("face-spinner")
          && !classList?.contains("runtime-proof");
      },
    });
    if (!blob) throw new Error("The face image could not be encoded.");
    return blob;
  } finally {
    if (wasHidden) panel.classList.remove("download-capture-panel");
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

async function downloadCurrentFace(): Promise<void> {
  if (switching || downloading) return;
  downloading = true;
  syncDownloadButtonState();
  actionStatus.textContent = "Preparing both face images.";
  try {
    const facesJsImage = await captureFaceImage(sourceCanvas, sourcePanel);
    const polyCssImage = await captureFaceImage(outputCanvas, outputPanel);
    downloadBlob(facesJsImage, `cssface-${currentSeed}-facesjs.png`);
    downloadBlob(polyCssImage, `cssface-${currentSeed}-polycss.png`);
    actionStatus.textContent = "Downloaded FacesJS and PolyCSS images.";
  } finally {
    downloading = false;
    syncDownloadButtonState();
  }
}

function installControls(): void {
  seedInput.addEventListener("input", () => {
    queueSeed(Number.parseInt(seedInput.value, 10));
  });
  seedInput.addEventListener("change", () => {
    queueSeed(Number.parseInt(seedInput.value, 10), true);
  });
  randomButton.addEventListener("click", () => {
    void selectSeed(randomSeed(currentModel.modelId));
  });
  codePenForm.addEventListener("submit", (event) => {
    if (switching) {
      event.preventDefault();
      return;
    }
    codePenData.value = codePenPayload(currentModel);
    actionStatus.textContent = "Opening both faces in a new Classic Pen.";
  });
  shareButton.addEventListener("click", () => {
    void shareCurrentFace().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      globalThis.console.error(error);
      actionStatus.textContent = "Could not share this face.";
    });
  });
  downloadButton.addEventListener("click", () => {
    void downloadCurrentFace().catch((error: unknown) => {
      globalThis.console.error(error);
      actionStatus.textContent = "Could not download the face images.";
    });
  });
}

function syncMobileView(): void {
  const isMobile = mobileViewMedia.matches;
  comparisonLab.dataset.mobileView = mobileView;
  mobileViewToggle.hidden = !isMobile;
  for (const button of mobileViewButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mobileView === mobileView),
    );
  }
  sourcePanel.inert = isMobile && mobileView === "3d";
  outputPanel.inert = isMobile && mobileView === "2d";
  if (sourcePanel.inert) sourcePanel.setAttribute("aria-hidden", "true");
  else sourcePanel.removeAttribute("aria-hidden");
  if (outputPanel.inert) outputPanel.setAttribute("aria-hidden", "true");
  else outputPanel.removeAttribute("aria-hidden");
}

function installMobileViewToggle(): void {
  for (const button of mobileViewButtons) {
    button.addEventListener("click", () => {
      mobileView = button.dataset.mobileView as MobileView;
      syncMobileView();
    });
  }
  mobileViewMedia.addEventListener("change", syncMobileView);
  syncMobileView();
}

function installOrbitTracking(): () => void {
  let pointerId: number | null = null;
  let previousX = 0;
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || pointerId !== null) return;
    pointerId = event.pointerId;
    previousX = event.clientX;
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    const deltaX = event.clientX - previousX;
    previousX = event.clientX;
    if (deltaX === 0) return;
    orbitYaw -= deltaX * 0.32;
  };
  const onPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) pointerId = null;
  };
  const onDoubleClick = (): void => {
    orbitYaw = 0;
  };
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerRelease);
  stage.addEventListener("pointercancel", onPointerRelease);
  stage.addEventListener("dblclick", onDoubleClick);
  return (): void => {
    stage.removeEventListener("pointerdown", onPointerDown);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerup", onPointerRelease);
    stage.removeEventListener("pointercancel", onPointerRelease);
    stage.removeEventListener("dblclick", onDoubleClick);
  };
}

async function mountPrototype(): Promise<void> {
  try {
    await mountModel(currentModel);
    document.documentElement.dataset.prototypeReady = "true";
  } catch (error) {
    document.documentElement.dataset.prototypeReady = "error";
    globalThis.console.error(error);
  } finally {
    setControlsBusy(false);
  }
}

const debugGlobal = globalThis as DebugGlobal;
debugGlobal.__cssFacePreview = Object.freeze({
  renderSource(config: FaceConfig): readonly string[] {
    const scratch = document.createElement("div");
    display(scratch, structuredClone(config));
    return [...scratch.querySelectorAll<SVGGElement>(":scope > svg > g")]
      .map((group) => group.getAttribute("transform") ?? "");
  },
  setFaceConfig(config: FaceConfig): Promise<boolean> {
    return selectFaceConfig(config);
  },
  setOrbit(yawDegrees: number): void {
    orbitYaw = yawDegrees;
    controller?.setOrbit(yawDegrees);
  },
});

setControlsBusy(true);
syncControls();
installControls();
const removeOrbitTracking = installOrbitTracking();
await mountPrototype();
installMobileViewToggle();

addEventListener("pagehide", () => {
  if (seedUpdateTimer !== undefined) clearTimeout(seedUpdateTimer);
  for (const state of faceLoadingStates.values()) {
    if (state.hideTimer !== undefined) clearTimeout(state.hideTimer);
  }
  mobileViewMedia.removeEventListener("change", syncMobileView);
  removeOrbitTracking();
  experience?.destroy();
  delete debugGlobal.__facesJsPrototype;
  delete debugGlobal.__cssFacePreview;
}, { once: true });
