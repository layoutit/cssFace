import {
  validatePolyMorphModel,
  type PolyMorphLoadedResource,
  type PolyMorphModel,
} from "@layoutit/polycss-morph";

import {
  cssGraphicsSha256,
} from "../../../model-package/modelPackage.mjs";
import {
  loadFacesJsComponentAssetBytes,
  loadFacesJsComponentBaseManifest,
  loadFacesJsComponentGraph,
  loadFacesJsComponentManifest,
  type FacesJsComponentGraph,
  type FacesJsResolvedComponentGraph,
} from "../model-package/componentCatalog.js";
import type {
  FacesJsComponentBaseManifest,
  FacesJsComponentCatalogRow,
  FacesJsComponentManifest,
} from "../model-package/componentPackage.js";
import {
  resolveFacesJsFaceConfig,
} from "./faceConfigResolver.js";
import type {
  FacesJsFaceConfig,
} from "./configTransforms.js";

const PREPARED_SCHEMA = "cssface.facesjs-prepared-component@1";
const LIGHTING_SCHEMA = "cssface.facesjs-component-rotation-lighting@3";
const COMPOSED_MODEL_ID = "facesjs-component-face";
const MAXIMUM_MODEL_LEAVES = 2_000;

type JsonRecord = Record<string, unknown>;

export interface FacesJsComponentRotationLightingContract {
  readonly schema: typeof LIGHTING_SCHEMA;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly leafIds: readonly string[];
  readonly runtimeLightingMath: 0;
  readonly runtimeColorWrites: 0;
  readonly runtimeStyleWritesMaximum: number;
  readonly technique: "prepared-yaw-space-time-neutral-texel-matrix";
  readonly state: Readonly<{
    spinSteps: number;
    fieldSourcePx: number;
  }>;
  readonly materials: Readonly<{
    roleIds: readonly string[];
    leafRoleIndicesBase64: string;
  }>;
  readonly visibility: Readonly<{
    encoding: "prepared-space-time-alpha-mask";
    managedLeafCount: number;
    radialLeafCount: number;
    frontLeafCount: number;
  }>;
  readonly atlases: Readonly<{
    layout: "paged-source-order-face-columns-by-yaw-state-rows";
    diffuse: Readonly<{
      asset: "rotation-diffuse";
      encoding: "srgb-multiplier-grayscale";
      width: number;
      height: number;
    }>;
    specular: Readonly<{
      asset: "rotation-specular";
      encoding: "screen-amplitude-grayscale";
      alphaEncoding: "frontface-visibility";
      width: number;
      height: number;
    }>;
  }>;
  readonly runtime: Readonly<{
    rootStateWritesMaximum: 1;
    leafStateWrites: 0;
    faceStateScans: 0;
    operation: "one inherited space-time row offset";
  }>;
}

interface PreparedComponentDocument {
  readonly schema: typeof PREPARED_SCHEMA;
  readonly family: string;
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly empty: boolean;
  readonly model: PolyMorphModel | null;
  readonly materialRoles: Readonly<Record<string, string>>;
  readonly rotationLighting: FacesJsComponentRotationLightingContract | null;
  readonly resources: Readonly<Record<string, string>>;
  readonly contentHash: string;
}

interface LoadedPreparedComponent {
  readonly row: FacesJsComponentCatalogRow;
  readonly manifest: FacesJsComponentManifest;
  readonly prepared: PreparedComponentDocument;
  readonly resourceBytes: ReadonlyMap<string, Uint8Array>;
  readonly diffuseUrl: string | null;
  readonly specularUrl: string | null;
  destroy(): void;
}

export interface FacesJsComposedLightingLayer {
  readonly contract: FacesJsComponentRotationLightingContract;
  readonly diffuseBytes: Uint8Array;
  readonly diffuseUrl: string;
  readonly specularBytes: Uint8Array;
  readonly specularUrl: string;
}

export interface FacesJsComposedComponentProgram {
  readonly id: typeof COMPOSED_MODEL_ID;
  readonly fixtureId: string;
  readonly base: FacesJsComponentBaseManifest;
  readonly model: PolyMorphModel;
  readonly materialRoles: ReadonlyMap<string, string>;
  readonly resources: ReadonlyMap<string, PolyMorphLoadedResource>;
  readonly lighting: readonly FacesJsComposedLightingLayer[];
  readonly selectedKeys: readonly string[];
}

export interface FacesJsComponentRuntime {
  readonly graph: FacesJsComponentGraph;
  composeFaceConfig(
    config: FacesJsFaceConfig,
    selectionId?: string,
  ): Promise<FacesJsComposedComponentProgram>;
  destroy(): void;
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
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has missing or unsupported fields.`);
  }
}

async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const decoded = new Uint8Array(await new Response(stream).arrayBuffer());
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    throw new TypeError("FacesJS prepared component is not gzip UTF-8 JSON.");
  }
}

async function validatePreparedDocument(
  value: unknown,
  row: FacesJsComponentCatalogRow,
): Promise<PreparedComponentDocument> {
  const input = record(value, `FacesJS prepared ${row.family}.${row.sourceId}`);
  exactKeys(input, [
    "schema",
    "family",
    "sourceId",
    "sourceSha256",
    "empty",
    "model",
    "materialRoles",
    "rotationLighting",
    "resources",
    "contentHash",
  ], `FacesJS prepared ${row.family}.${row.sourceId}`);
  if (input.schema !== PREPARED_SCHEMA
    || input.family !== row.family
    || input.sourceId !== row.sourceId
    || input.sourceSha256 !== row.sourceSha256
    || typeof input.empty !== "boolean"
    || typeof input.contentHash !== "string") {
    throw new TypeError(`FacesJS prepared ${row.family}.${row.sourceId} is stale.`);
  }
  const { contentHash, ...payload } = input;
  const payloadHash = await cssGraphicsSha256(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  if (payloadHash !== contentHash) {
    throw new TypeError(`FacesJS prepared ${row.family}.${row.sourceId} content hash is stale.`);
  }
  const materialRoles = record(input.materialRoles, "FacesJS prepared material roles");
  const resources = record(input.resources, "FacesJS prepared resources");
  if (Object.values(materialRoles).some((role) => typeof role !== "string")
    || Object.values(resources).some((role) => typeof role !== "string")) {
    throw new TypeError(`FacesJS prepared ${row.family}.${row.sourceId} bindings are invalid.`);
  }
  if (input.empty) {
    if (input.model !== null || input.rotationLighting !== null
      || Object.keys(materialRoles).length > 0 || Object.keys(resources).length > 0) {
      throw new TypeError(`FacesJS empty ${row.family}.${row.sourceId} has runtime geometry.`);
    }
    return input as unknown as PreparedComponentDocument;
  }
  const model = validatePolyMorphModel(input.model);
  const lighting = record(input.rotationLighting, "FacesJS prepared rotation lighting");
  const visibility = record(lighting.visibility, "FacesJS prepared rotation visibility");
  const atlases = record(lighting.atlases, "FacesJS prepared rotation atlases");
  const specular = record(atlases.specular, "FacesJS prepared specular atlas");
  const runtime = record(lighting.runtime, "FacesJS prepared rotation runtime");
  if (lighting.schema !== LIGHTING_SCHEMA
    || lighting.modelId !== model.identity.id
    || !Array.isArray(lighting.leafIds)
    || lighting.leafIds.length !== model.render.leaves.length
    || lighting.leafIds.some((leafId, index) => leafId !== model.render.leaves[index]?.id)
    || lighting.technique !== "prepared-yaw-space-time-neutral-texel-matrix"
    || lighting.runtimeStyleWritesMaximum !== 1
    || visibility.encoding !== "prepared-space-time-alpha-mask"
    || typeof visibility.managedLeafCount !== "number"
    || typeof visibility.radialLeafCount !== "number"
    || typeof visibility.frontLeafCount !== "number"
    || !Number.isSafeInteger(visibility.managedLeafCount)
    || !Number.isSafeInteger(visibility.radialLeafCount)
    || !Number.isSafeInteger(visibility.frontLeafCount)
    || visibility.managedLeafCount < 0
    || visibility.radialLeafCount < 0
    || visibility.frontLeafCount < 0
    || visibility.managedLeafCount > model.render.leaves.length
    || visibility.radialLeafCount + visibility.frontLeafCount
      !== visibility.managedLeafCount
    || runtime.rootStateWritesMaximum !== 1
    || runtime.leafStateWrites !== 0
    || runtime.faceStateScans !== 0
    || specular.alphaEncoding !== "frontface-visibility") {
    throw new TypeError(`FacesJS prepared ${row.family}.${row.sourceId} lighting is stale.`);
  }
  for (const material of model.materials) {
    if (typeof materialRoles[material.id] !== "string") {
      throw new TypeError(`FacesJS prepared ${row.family}.${row.sourceId} lost a material role.`);
    }
  }
  return Object.freeze({
    ...(input as unknown as PreparedComponentDocument),
    model,
    materialRoles: Object.freeze({ ...materialRoles } as Record<string, string>),
    resources: Object.freeze({ ...resources } as Record<string, string>),
    rotationLighting: lighting as unknown as FacesJsComponentRotationLightingContract,
  });
}

function prefixed(prefix: string, id: string): string {
  return `${prefix}-${id}`;
}

function remapAtlasResource<T extends { readonly resourcePath: string }>(
  prefix: string,
  atlas: T,
): T {
  return { ...atlas, resourcePath: `${prefix}/${atlas.resourcePath}` };
}

function loadedResource(
  path: string,
  asset: FacesJsComponentManifest["assets"][string],
  bytes: Uint8Array,
): PolyMorphLoadedResource {
  return Object.freeze({
    descriptor: Object.freeze({
      path,
      role: "image" as const,
      mediaType: asset.mediaType,
      bytes: asset.bytes,
      sha256: asset.sha256,
    }),
    bytes,
  });
}

function composePreparedComponents(
  fixtureId: string,
  base: FacesJsComponentBaseManifest,
  components: readonly LoadedPreparedComponent[],
): FacesJsComposedComponentProgram {
  const vertices: number[][] = [];
  const normals: number[][] = [];
  const polygons: Array<{ id: string; vertexIndices: number[]; normalIndices: number[] }> = [];
  const materials: Array<{ id: string; color: readonly number[] }> = [];
  const materialRoles = new Map<string, string>();
  const shapes: Array<{ id: string; matrix: readonly number[] }> = [];
  const leaves: JsonRecord[] = [];
  const targets = new Map<string, Array<JsonRecord>>();
  const sources: JsonRecord[] = [];
  const resources = new Map<string, PolyMorphLoadedResource>();
  const lighting: FacesJsComposedLightingLayer[] = [];
  const selectedKeys: string[] = [];

  for (const component of components) {
    const { row, prepared, manifest } = component;
    const prefix = `${row.family}-${row.sourceId}`
      .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
      .toLowerCase();
    selectedKeys.push(`${row.family}:${row.sourceId}`);
    if (prepared.empty || !prepared.model) continue;
    const model = prepared.model;
    const vertexOffset = vertices.length;
    const normalOffset = normals.length;
    vertices.push(...model.topology.vertices.map((position) => [...position]));
    normals.push(...model.topology.normals.map((normal) => [...normal]));
    polygons.push(...model.topology.polygons.map((polygon) => ({
      id: prefixed(prefix, polygon.id),
      vertexIndices: polygon.vertexIndices.map((index) => index + vertexOffset),
      normalIndices: polygon.normalIndices.map((index) => index + normalOffset),
    })));
    materials.push(...model.materials.map((material) => ({
      id: prefixed(prefix, material.id),
      color: material.color,
    })));
    for (const material of model.materials) {
      const role = prepared.materialRoles[material.id];
      if (!role) {
        throw new TypeError(`FacesJS ${prefix} material ${material.id} has no role.`);
      }
      materialRoles.set(prefixed(prefix, material.id), role);
    }
    shapes.push(...model.render.shapes.map((shape) => ({
      id: prefixed(prefix, shape.id),
      matrix: shape.matrix,
    })));
    leaves.push(...model.render.leaves.map((leaf) => ({
      ...leaf,
      id: prefixed(prefix, leaf.id),
      polygonId: prefixed(prefix, leaf.polygonId),
      shapeId: prefixed(prefix, leaf.shapeId),
      materialId: prefixed(prefix, leaf.materialId),
      atlas: leaf.atlas ? remapAtlasResource(prefix, leaf.atlas) : null,
      fallback: leaf.fallback ? {
        ...leaf.fallback,
        atlas: remapAtlasResource(prefix, leaf.fallback.atlas),
      } : null,
    })));
    if (model.deformation.kind === "morph-regions") {
      for (const target of model.deformation.targets) {
        const deltas = targets.get(target.id) ?? [];
        deltas.push(...target.deltas.map((delta) => ({
          ...delta,
          vertexIndex: delta.vertexIndex + vertexOffset,
        })));
        targets.set(target.id, deltas);
      }
    }
    sources.push(...model.provenance.sources.map((source) => ({
      ...source,
      id: prefixed(prefix, source.id),
    })));
    for (const [resourcePath, role] of Object.entries(prepared.resources)) {
      const asset = manifest.assets[role];
      const bytes = component.resourceBytes.get(role);
      if (!asset || !bytes) {
        throw new TypeError(`FacesJS ${prefix} resource ${resourcePath} is absent.`);
      }
      const composedPath = `${prefix}/${resourcePath}`;
      resources.set(composedPath, loadedResource(composedPath, asset, bytes));
    }
    const diffuseBytes = component.resourceBytes.get("rotation-diffuse");
    const specularBytes = component.resourceBytes.get("rotation-specular");
    if (!prepared.rotationLighting || !component.diffuseUrl || !component.specularUrl
      || !diffuseBytes || !specularBytes) {
      throw new TypeError(`FacesJS ${prefix} rotation lighting is absent.`);
    }
    lighting.push(Object.freeze({
      contract: Object.freeze({
        ...prepared.rotationLighting,
        leafIds: Object.freeze(prepared.rotationLighting.leafIds.map((id) =>
          prefixed(prefix, id))),
      }),
      diffuseBytes: Uint8Array.from(diffuseBytes),
      diffuseUrl: component.diffuseUrl,
      specularBytes: Uint8Array.from(specularBytes),
      specularUrl: component.specularUrl,
    }));
  }

  const deformationTargets = [...targets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, deltas]) => ({ id, deltas }));
  const model = validatePolyMorphModel({
    schema: "polycss-morph.model@1",
    identity: {
      id: COMPOSED_MODEL_ID,
      name: "FacesJS Component Face",
      revision: "1.0.0",
    },
    profile: "morph-regions",
    capabilities: ["morph-targets", "retained-render", "sparse-updates"],
    budgets: {
      maxVertices: vertices.length,
      maxPolygons: Math.max(MAXIMUM_MODEL_LEAVES, polygons.length),
      maxLeaves: Math.max(MAXIMUM_MODEL_LEAVES, leaves.length),
      maxFrames: 1,
      maxJoints: 1,
      maxResources: Math.max(1, resources.size),
      maxBytes: 64_000_000,
    },
    topology: { vertices, normals, polygons },
    materials,
    render: {
      modelMatrix: base.modelMatrix,
      shapes,
      leaves,
    },
    deformation: { kind: "morph-regions", targets: deformationTargets },
    controls: [],
    springs: [],
    animations: [],
    playback: null,
    provenance: {
      generator: "cssface-component-composer",
      generatorVersion: "1.0.0",
      sources,
    },
  });
  return Object.freeze({
    id: COMPOSED_MODEL_ID,
    fixtureId,
    base,
    model,
    materialRoles,
    resources,
    lighting: Object.freeze(lighting),
    selectedKeys: Object.freeze(selectedKeys),
  });
}

function imageUrl(bytes: Uint8Array, mediaType: string): string {
  return URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mediaType }));
}

export async function createFacesJsComponentRuntime(
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl = "/facesjs-components/",
): Promise<FacesJsComponentRuntime> {
  const graph = await loadFacesJsComponentGraph(fetchImpl, baseUrl);
  const componentCache = new Map<string, Promise<LoadedPreparedComponent>>();
  const baseCache = new Map<string, Promise<FacesJsComponentBaseManifest>>();
  let destroyed = false;

  const loadComponent = (row: FacesJsComponentCatalogRow): Promise<LoadedPreparedComponent> => {
    const key = `${row.family}:${row.sourceId}:${row.sourceSha256}`;
    let pending = componentCache.get(key);
    if (pending) return pending;
    pending = (async () => {
      const manifest = await loadFacesJsComponentManifest(fetchImpl, row, baseUrl);
      if (!manifest.assets.prepared) {
        throw new TypeError(`FacesJS component ${row.family}.${row.sourceId} is not runtime prepared.`);
      }
      const preparedBytes = await loadFacesJsComponentAssetBytes(
        fetchImpl, row, manifest, "prepared", baseUrl,
      );
      const prepared = await validatePreparedDocument(await gunzipJson(preparedBytes), row);
      const resourceRoles = Object.values(prepared.resources);
      const roles = prepared.empty
        ? []
        : [...new Set([
          ...resourceRoles,
          "rotation-diffuse",
          "rotation-specular",
        ])].sort();
      const loadedAssets = new Map(await Promise.all(roles.map(async (role) => [
        role,
        await loadFacesJsComponentAssetBytes(fetchImpl, row, manifest, role, baseUrl),
      ] as const)));
      const diffuseAsset = manifest.assets["rotation-diffuse"];
      const specularAsset = manifest.assets["rotation-specular"];
      const diffuseUrl = diffuseAsset
        ? imageUrl(loadedAssets.get("rotation-diffuse")!, diffuseAsset.mediaType)
        : null;
      const specularUrl = specularAsset
        ? imageUrl(loadedAssets.get("rotation-specular")!, specularAsset.mediaType)
        : null;
      let released = false;
      return Object.freeze({
        row,
        manifest,
        prepared,
        resourceBytes: loadedAssets,
        diffuseUrl,
        specularUrl,
        destroy(): void {
          if (released) return;
          released = true;
          if (diffuseUrl) URL.revokeObjectURL(diffuseUrl);
          if (specularUrl) URL.revokeObjectURL(specularUrl);
        },
      });
    })();
    componentCache.set(key, pending);
    pending.catch(() => componentCache.delete(key));
    return pending;
  };

  const loadResolved = async (
    fixtureId: string,
    resolved: FacesJsResolvedComponentGraph,
  ): Promise<FacesJsComposedComponentProgram> => {
    let basePending = baseCache.get(resolved.base.id);
    if (!basePending) {
      basePending = loadFacesJsComponentBaseManifest(fetchImpl, resolved.base, baseUrl);
      baseCache.set(resolved.base.id, basePending);
      basePending.catch(() => baseCache.delete(resolved.base.id));
    }
    const [base, components] = await Promise.all([
      basePending,
      Promise.all(resolved.components.map(loadComponent)),
    ]);
    if (destroyed) throw new Error("The FacesJS component runtime was destroyed during loading.");
    return composePreparedComponents(fixtureId, base, components);
  };

  return Object.freeze({
    graph,
    composeFaceConfig(
      config: FacesJsFaceConfig,
      selectionId = "face-config",
    ): Promise<FacesJsComposedComponentProgram> {
      if (destroyed) throw new Error("The FacesJS component runtime is destroyed.");
      const resolved = resolveFacesJsFaceConfig(graph, config);
      return loadResolved(selectionId, resolved.graph);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const pending of componentCache.values()) {
        void pending.then((component) => component.destroy(), () => {});
      }
      componentCache.clear();
      baseCache.clear();
    },
  });
}
