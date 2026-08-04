import type {
  FacesJsCompatibilityFixtureRow,
  FacesJsComponentCatalog,
  FacesJsComponentCatalogBaseRow,
  FacesJsComponentCatalogRow,
  FacesJsComponentSelection,
  FacesJsComponentBaseManifest,
  FacesJsComponentManifest,
  FacesJsSourceIndex,
} from "./componentPackage.js";
import {
  validateFacesJsComponentCatalog,
  validateFacesJsComponentBaseManifest,
  validateFacesJsComponentManifest,
} from "./componentPackage.js";
import {
  cssGraphicsSha256,
} from "../../../model-package/modelPackage.mjs";

export const FACES_JS_COMPONENT_DEFAULT_BASE_URL = "/facesjs-components/";

export interface FacesJsResolvedComponentGraph {
  readonly base: FacesJsComponentCatalogBaseRow;
  readonly components: readonly FacesJsComponentCatalogRow[];
}

export interface FacesJsComponentGraph {
  readonly catalog: FacesJsComponentCatalog;
  getCompatibilityFixture(id: string): FacesJsCompatibilityFixtureRow;
  resolve(
    baseId: string,
    selections: readonly FacesJsComponentSelection[],
  ): FacesJsResolvedComponentGraph;
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes(":")
    || value.includes("\\") || value.includes("?") || value.includes("#")
    || value.split("/").includes("..")) {
    throw new TypeError("The FacesJS component base URL must be root-relative and normalized.");
  }
  return value.endsWith("/") ? value : `${value}/`;
}

async function requestBytes(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store" });
  } catch {
    throw new Error(`FacesJS component request ${url} failed.`);
  }
  if (!response.ok) throw new Error(`FacesJS component request ${url} returned HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

function key(value: Readonly<{ family: string; sourceId: string }>): string {
  return `${value.family}:${value.sourceId}`;
}

export function createFacesJsComponentGraph(
  catalog: FacesJsComponentCatalog,
): FacesJsComponentGraph {
  const bases = new Map(catalog.bases.map((row) => [row.id, row]));
  const components = new Map(catalog.components.map((row) => [key(row), row]));
  const fixtures = new Map(catalog.compatibilityFixtures.map((row) => [row.id, row]));
  return Object.freeze({
    catalog,
    getCompatibilityFixture(id: string): FacesJsCompatibilityFixtureRow {
      const fixture = fixtures.get(id);
      if (!fixture) throw new Error(`FacesJS compatibility fixture ${id} is unavailable.`);
      return fixture;
    },
    resolve(
      baseId: string,
      selections: readonly FacesJsComponentSelection[],
    ): FacesJsResolvedComponentGraph {
      const base = bases.get(baseId);
      if (!base) throw new Error(`FacesJS component base ${baseId} is unavailable.`);
      const selectedByFamily = new Map<string, FacesJsComponentCatalogRow>();
      for (const selection of selections) {
        if (selectedByFamily.has(selection.family)) {
          throw new Error(`FacesJS family ${selection.family} is selected more than once.`);
        }
        const row = components.get(key(selection));
        if (!row || row.sourceSha256 !== selection.sourceSha256) {
          throw new Error(`FacesJS component ${key(selection)} is unavailable or stale.`);
        }
        selectedByFamily.set(selection.family, row);
      }
      for (const row of selectedByFamily.values()) {
        for (const dependency of row.dependencies) {
          const selected = selectedByFamily.get(dependency.family);
          if (!selected || selected.sourceId !== dependency.sourceId) {
            throw new Error(
              `FacesJS component ${key(row)} requires selected ${key(dependency)}.`,
            );
          }
        }
      }
      return Object.freeze({
        base,
        components: Object.freeze(
          [...selectedByFamily.values()].sort((left, right) => left.layer - right.layer),
        ),
      });
    },
  });
}

export async function loadFacesJsComponentGraph(
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl: string = FACES_JS_COMPONENT_DEFAULT_BASE_URL,
  sourceIndex?: FacesJsSourceIndex,
): Promise<FacesJsComponentGraph> {
  if (typeof fetchImpl !== "function") throw new TypeError("A component fetch function is required.");
  const bytes = await requestBytes(fetchImpl, `${normalizeBaseUrl(baseUrl)}catalog.json`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("FacesJS component catalog is not UTF-8 JSON.");
  }
  return createFacesJsComponentGraph(
    await validateFacesJsComponentCatalog(value, sourceIndex),
  );
}

export async function loadFacesJsComponentManifest(
  fetchImpl: typeof fetch,
  row: FacesJsComponentCatalogRow,
  baseUrl: string = FACES_JS_COMPONENT_DEFAULT_BASE_URL,
  sourceIndex?: FacesJsSourceIndex,
): Promise<FacesJsComponentManifest> {
  if (typeof fetchImpl !== "function") throw new TypeError("A component fetch function is required.");
  const bytes = await requestBytes(
    fetchImpl,
    `${normalizeBaseUrl(baseUrl)}${row.manifestPath}`,
  );
  if (await cssGraphicsSha256(bytes) !== row.manifestSha256) {
    throw new Error(`FacesJS component ${key(row)} manifest hash is stale.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`FacesJS component ${key(row)} manifest is not UTF-8 JSON.`);
  }
  const manifest = await validateFacesJsComponentManifest(value, sourceIndex);
  if (manifest.family !== row.family || manifest.sourceId !== row.sourceId
    || manifest.sourceSha256 !== row.sourceSha256 || manifest.layer !== row.layer
    || JSON.stringify(manifest.dependencies) !== JSON.stringify(row.dependencies)) {
    throw new Error(`FacesJS component ${key(row)} manifest does not match its catalog row.`);
  }
  return manifest;
}

export async function loadFacesJsComponentBaseManifest(
  fetchImpl: typeof fetch,
  row: FacesJsComponentCatalogBaseRow,
  baseUrl: string = FACES_JS_COMPONENT_DEFAULT_BASE_URL,
): Promise<FacesJsComponentBaseManifest> {
  if (typeof fetchImpl !== "function") throw new TypeError("A component fetch function is required.");
  const bytes = await requestBytes(
    fetchImpl,
    `${normalizeBaseUrl(baseUrl)}${row.manifestPath}`,
  );
  if (await cssGraphicsSha256(bytes) !== row.manifestSha256) {
    throw new Error(`FacesJS component base ${row.id} manifest hash is stale.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`FacesJS component base ${row.id} manifest is not UTF-8 JSON.`);
  }
  const manifest = await validateFacesJsComponentBaseManifest(value);
  if (manifest.id !== row.id) {
    throw new Error(`FacesJS component base ${row.id} manifest does not match its catalog row.`);
  }
  return manifest;
}

export async function loadFacesJsComponentAssetBytes(
  fetchImpl: typeof fetch,
  row: FacesJsComponentCatalogRow,
  manifest: FacesJsComponentManifest,
  role: string,
  baseUrl: string = FACES_JS_COMPONENT_DEFAULT_BASE_URL,
): Promise<Uint8Array> {
  const asset = manifest.assets[role];
  if (!asset) throw new Error(`FacesJS component ${key(row)} has no asset role ${role}.`);
  const bytes = await requestBytes(
    fetchImpl,
    resolveFacesJsComponentAssetUrl(row, manifest, role, baseUrl),
  );
  if (bytes.byteLength !== asset.bytes || await cssGraphicsSha256(bytes) !== asset.sha256) {
    throw new Error(`FacesJS component ${key(row)} asset ${role} is stale.`);
  }
  return bytes;
}

export function resolveFacesJsComponentAssetUrl(
  row: FacesJsComponentCatalogRow,
  manifest: FacesJsComponentManifest,
  role: string,
  baseUrl: string = FACES_JS_COMPONENT_DEFAULT_BASE_URL,
): string {
  const asset = manifest.assets[role];
  if (!asset) throw new Error(`FacesJS component ${key(row)} has no asset role ${role}.`);
  const packageRoot = row.manifestPath.slice(0, -"manifest.json".length);
  return `${normalizeBaseUrl(baseUrl)}${packageRoot}${asset.path}`;
}
