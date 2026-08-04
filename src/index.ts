import {
  loadCssGraphicsPackageCatalog,
  normalizeCssGraphicsPackageBaseUrl,
} from "./runtime/shared/catalog.mjs";
import {
  startCssGraphicsSession,
  type CssGraphicsRuntimeAdapter,
} from "./runtime/shared/session.js";
import {
  resolveCssGraphicsRoute,
} from "./runtime/shared/route.js";
import {
  facesJsPlayerAdapter,
} from "./adapters/facesjs/player/adapter.js";
import {
  CSSGRAPHICS_DEFAULT_BASE_URL,
  type CssGraphicsExperience,
  type CssGraphicsMountOptions,
  type CssGraphicsPackageCatalog,
} from "./public-contract.js";

const CSSFACE_RUNTIME_ADAPTERS: ReadonlyMap<string, CssGraphicsRuntimeAdapter> =
  new Map([[facesJsPlayerAdapter.profile, facesJsPlayerAdapter]]);

export * from "./public-contract.js";
export {
  CSSFACE_GENERATOR_ID,
  CSSFACE_MAXIMUM_SEED,
  FacesJsFaceConfigResolutionError,
  collectCssFaceCoverageSeeds,
  createCssFaceShareUrl,
  decodeCssFaceShareState,
  encodeCssFaceShareState,
  generateCssFaceConfig,
  parseFacesJsFaceConfigJson,
  readCssFaceShareUrl,
  resolveFacesJsFaceConfig,
  serializeFacesJsFaceConfig,
} from "./adapters/facesjs/player/faceConfigResolver.js";
export type {
  FacesJsFaceConfig,
} from "./adapters/facesjs/player/configTransforms.js";
export {
  resolveFacesJsMorphWeights,
} from "./adapters/facesjs/player/configTransforms.js";
export {
  createFacesJsComponentRuntime,
} from "./adapters/facesjs/player/componentRuntime.js";
export type {
  FacesJsComposedComponentProgram,
  FacesJsComponentRuntime,
} from "./adapters/facesjs/player/componentRuntime.js";

export async function loadCssGraphicsCatalog(
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl: string = CSSGRAPHICS_DEFAULT_BASE_URL,
): Promise<CssGraphicsPackageCatalog> {
  return loadCssGraphicsPackageCatalog(fetchImpl, baseUrl);
}

export async function mountCssGraphics(
  host: HTMLElement,
  options: CssGraphicsMountOptions = {},
): Promise<CssGraphicsExperience> {
  if (!host || !host.ownerDocument) {
    throw new TypeError("cssFace requires an HTMLElement host.");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = normalizeCssGraphicsPackageBaseUrl(
    options.baseUrl ?? CSSGRAPHICS_DEFAULT_BASE_URL,
  );
  const catalog = await loadCssGraphicsCatalog(fetchImpl, base);
  const selected = options.modelId ?? resolveCssGraphicsRoute(
    new URL(globalThis.location.href),
    catalog.defaultId,
  ).modelId;
  return startCssGraphicsSession({
    host,
    catalog,
    initialModelId: selected,
    adapters: CSSFACE_RUNTIME_ADAPTERS,
    fetchImpl,
    baseUrl: base,
    experienceControls: options.experienceControls,
    initialRuntimeInput: options.faceConfig,
  });
}
