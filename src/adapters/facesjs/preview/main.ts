import { display, type FaceConfig } from "facesjs";

import {
  mountCssGraphics,
  type CssGraphicsExperience,
} from "../../../index.js";
import type {
  FacesJsMorphId,
  FacesJsPrototypeController,
} from "../player/scene.js";

import presetsJson from "../presets.json";
import "@fontsource/archivo-black/400.css";
import "../../../style.css";
import "./preview.css";

interface FacePreset {
  readonly id: string;
  readonly name: string;
  readonly modelId: string;
  readonly random?: boolean;
  readonly face: FaceConfig;
}

type ControlId = Exclude<FacesJsMorphId, "brow">;
type ControlValues = Record<ControlId, number>;
type MobileView = "2d" | "3d";

interface SeedState {
  readonly preset: FacePreset;
  readonly values: ControlValues;
}

type DebugGlobal = typeof globalThis & {
  __facesJsPrototype?: FacesJsPrototypeController;
};

const facePresets = (presetsJson as unknown as readonly FacePreset[])
  .filter(({ random }) => random !== false);
const defaultPreset = facePresets[0];
if (!defaultPreset) throw new Error("FacesJS needs at least one prepared preset.");

const DEFAULT_SEED = 0;
const MAXIMUM_SEED = 9999;
const SEED_UPDATE_DELAY_MS = 80;

const controlRanges = Object.freeze({
  fatness: [0, 1],
  "body-size": [0.75, 1.25],
  "ear-size": [0.5, 1.5],
  "nose-size": [0.5, 1.25],
} satisfies Record<ControlId, readonly [number, number]>);

const controlSteps = Object.freeze({
  fatness: 0.01,
  "body-size": 0.01,
  "ear-size": 0.01,
  "nose-size": 0.01,
} satisfies Record<ControlId, number>);

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seededControlValue(id: ControlId, random: () => number): number {
  const [minimum, maximum] = controlRanges[id];
  const step = controlSteps[id];
  const stepCount = Math.round((maximum - minimum) / step);
  const value = minimum + Math.floor(random() * (stepCount + 1)) * step;
  return Number(value.toFixed(2));
}

function stateForSeed(seed: number): SeedState {
  if (seed === DEFAULT_SEED) {
    return {
      preset: defaultPreset,
      values: {
        fatness: defaultPreset.face.fatness,
        "body-size": defaultPreset.face.body.size ?? 1,
        "ear-size": defaultPreset.face.ear.size,
        "nose-size": defaultPreset.face.nose.size,
      },
    };
  }
  const random = seededRandom(seed);
  const preset = facePresets[Math.floor(random() * facePresets.length)]
    ?? defaultPreset;
  const values = Object.fromEntries(
    (Object.keys(controlRanges) as ControlId[]).map(
      (id) => [id, seededControlValue(id, random)],
    ),
  ) as ControlValues;
  return { preset, values };
}

function randomSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] ?? DEFAULT_SEED) % (MAXIMUM_SEED + 1);
}

const stage = requiredElement<HTMLDivElement>("#stage");
const leafCount = requiredElement<HTMLElement>("#leaf-count");
const canvasCount = requiredElement<HTMLElement>("#canvas-count");
const topologyState = requiredElement<HTMLElement>("#topology-state");
const sourceFace = requiredElement<HTMLDivElement>("#source-face");
const faceConfigSummary = requiredElement<HTMLElement>("#face-config-summary");
const facesJsCode = requiredElement<HTMLElement>("#facesjs-code");
const polyCssCode = requiredElement<HTMLElement>("#polycss-code");
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

const initialSeed = randomSeed();
const initialState = stateForSeed(initialSeed);
const values: ControlValues = { ...initialState.values };
let currentPreset = initialState.preset;
let currentSeed = initialSeed;
let controller: FacesJsPrototypeController | null = null;
let experience: CssGraphicsExperience | null = null;
let switching = true;
let mobileView: MobileView = "2d";
let seedUpdateTimer: ReturnType<typeof setTimeout> | undefined;

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

const codeTokenPattern =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(import|from|const|await|if|throw|new)\b|\b(true|false|null|undefined)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\s*:)|\b([A-Za-z_$][\w$]*)(?=\s*\()/g;

function compactSourceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => compactSourceValue(entry)).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, entry]) => `${key}: ${compactSourceValue(entry)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function compactFaceConfig(face: FaceConfig): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(face)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      compact[key] = value;
      continue;
    }

    const feature = value as Record<string, unknown>;
    if (feature.id === "none" && key !== "accessories") continue;

    compact[key] = Object.fromEntries(
      Object.entries(feature).filter(
        ([property, entry]) =>
          !(
            (property === "size" && entry === 1) ||
            (property === "angle" && entry === 0) ||
            (property === "flip" && entry === false)
          ),
      ),
    );
  }
  return compact;
}

function facesJsSnippet(face: FaceConfig): string {
  const properties = Object.entries(compactFaceConfig(face)).map(
    ([key, value]) => `  ${key}: ${compactSourceValue(value)},`,
  );
  return [
    'import { display } from "facesjs";',
    "",
    "const face = {",
    ...properties,
    "};",
    "",
    'display("face", face);',
  ].join("\n");
}

function polyCssSnippet(preset: FacePreset): string {
  return [
    'import { mountCssGraphics } from "./src/index.js";',
    "",
    'const host = document.querySelector("#face");',
    'if (!host) throw new Error("Missing #face");',
    "",
    "await mountCssGraphics(host, {",
    '  baseUrl: "/cssgraphics/",',
    `  modelId: "${preset.modelId}",`,
    "  experienceControls: false,",
    "});",
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

function syncCodeSamples(face: FaceConfig): void {
  setHighlightedCode(facesJsCode, facesJsSnippet(face), true);
  setHighlightedCode(polyCssCode, polyCssSnippet(currentPreset));
}

function syncSourceFace(): void {
  const face = currentFaceConfig();
  display(sourceFace, face);
  syncCodeSamples(face);
  const svg = sourceFace.querySelector<SVGSVGElement>("svg");
  if (!svg) throw new Error("FacesJS did not render an SVG.");
  svg.setAttribute("viewBox", "0 0 400 600");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${currentPreset.name} FacesJS face`);
}

function currentFaceConfig(): FaceConfig {
  const face = structuredClone(currentPreset.face);
  face.fatness = values.fatness;
  face.body.size = values["body-size"];
  face.ear.size = values["ear-size"];
  face.nose.size = values["nose-size"];
  return face;
}

function syncFaceSummary(): void {
  const face = currentPreset.face;
  faceConfigSummary.textContent = [
    currentPreset.id,
    `head.${face.head.id}`,
    `hair.${face.hair.id}`,
    `eye.${face.eye.id}`,
    `eyebrow.${face.eyebrow.id}`,
    `nose.${face.nose.id}`,
    `mouth.${face.mouth.id}`,
    `ear.${face.ear.id}`,
  ].join(" · ");
}

function syncSeedControl(seed = currentSeed): void {
  seedInput.value = String(seed);
  seedInput.style.setProperty(
    "--range-progress",
    `${(seed / MAXIMUM_SEED) * 100}%`,
  );
}

function syncControls(): void {
  syncSeedControl();
  syncSourceFace();
  syncFaceSummary();
}

function setControlsBusy(busy: boolean): void {
  switching = busy;
  randomButton.disabled = busy;
  seedInput.disabled = busy;
}

async function shareCurrentFace(): Promise<void> {
  const data = {
    title: "cssFace",
    text: `seed ${currentSeed}\n${JSON.stringify(currentFaceConfig())}`,
    url: globalThis.location.href,
  };
  if (navigator.share) {
    await navigator.share(data);
    return;
  }
  await navigator.clipboard.writeText(`${data.url}\n${data.text}`);
  actionStatus.textContent = "Face link and config copied.";
}

function downloadCurrentFace(): void {
  const blob = new Blob(
    [JSON.stringify(currentFaceConfig(), null, 2)],
    { type: "application/json" },
  );
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `${currentPreset.id}.json`;
  link.click();
  URL.revokeObjectURL(href);
  actionStatus.textContent = "Face config downloaded.";
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

function applyMorphValues(): void {
  if (!controller) return;
  for (const [id, value] of Object.entries(values)) {
    controller.setMorph(id as FacesJsMorphId, value);
  }
}

async function selectPreset(
  preset: FacePreset,
  nextValues: ControlValues,
  resetOrbit = false,
): Promise<boolean> {
  if (switching || !experience) return false;
  const previousPreset = currentPreset;
  const previousValues = { ...values };
  let didSelect = false;
  setControlsBusy(true);
  currentPreset = preset;
  Object.assign(values, nextValues);
  syncControls();
  try {
    if (experience.currentModelId !== preset.modelId) {
      await experience.switchModel(preset.modelId, "none");
    }
    controller = (globalThis as DebugGlobal).__facesJsPrototype ?? null;
    if (!controller) throw new Error(`FacesJS model ${preset.modelId} did not mount.`);
    applyMorphValues();
    if (resetOrbit) controller.setOrbit(0, 0);
    updateRuntimeProof();
    document.documentElement.dataset.prototypeReady = "true";
    didSelect = true;
  } catch (error) {
    currentPreset = previousPreset;
    Object.assign(values, previousValues);
    syncControls();
    try {
      if (experience.currentModelId !== previousPreset.modelId) {
        await experience.switchModel(previousPreset.modelId, "none");
      }
      controller = (globalThis as DebugGlobal).__facesJsPrototype ?? null;
      applyMorphValues();
      updateRuntimeProof();
    } catch (rollbackError) {
      document.documentElement.dataset.prototypeReady = "error";
      globalThis.console.error(rollbackError);
    }
    globalThis.console.error(error);
  } finally {
    setControlsBusy(false);
  }
  return didSelect;
}

async function selectSeed(seed: number, resetOrbit = false): Promise<void> {
  const normalizedSeed = Math.max(
    DEFAULT_SEED,
    Math.min(MAXIMUM_SEED, Math.round(seed)),
  );
  const previousSeed = currentSeed;
  const state = stateForSeed(normalizedSeed);
  currentSeed = normalizedSeed;
  const didSelect = await selectPreset(state.preset, state.values, resetOrbit);
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

function installControls(): void {
  seedInput.addEventListener("input", () => {
    queueSeed(Number.parseInt(seedInput.value, 10));
  });
  seedInput.addEventListener("change", () => {
    queueSeed(Number.parseInt(seedInput.value, 10), true);
  });
  randomButton.addEventListener("click", () => {
    void selectSeed(randomSeed());
  });
  shareButton.addEventListener("click", () => {
    void shareCurrentFace().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      globalThis.console.error(error);
      actionStatus.textContent = "Could not share this face.";
    });
  });
  downloadButton.addEventListener("click", downloadCurrentFace);
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

async function mountPrototype(): Promise<void> {
  try {
    experience = await mountCssGraphics(stage, {
      baseUrl: "/cssgraphics/",
      modelId: currentPreset.modelId,
      experienceControls: false,
    });
    controller = (globalThis as DebugGlobal).__facesJsPrototype ?? null;
    if (!controller) throw new Error("The FacesJS cssGraphics adapter did not mount.");
    applyMorphValues();
    updateRuntimeProof();
    document.documentElement.dataset.prototypeReady = "true";
  } catch (error) {
    document.documentElement.dataset.prototypeReady = "error";
    globalThis.console.error(error);
  } finally {
    setControlsBusy(false);
  }
}

syncControls();
installControls();
await mountPrototype();
installMobileViewToggle();

addEventListener("pagehide", () => {
  if (seedUpdateTimer !== undefined) clearTimeout(seedUpdateTimer);
  mobileViewMedia.removeEventListener("change", syncMobileView);
  experience?.destroy();
}, { once: true });
