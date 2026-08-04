import { createHash } from "node:crypto";

import {
  buildFacesJsHeadMountedSource,
} from "./hairComponentCompiler.mjs";

export const FACES_JS_ACCESSORY_COMPONENT_SCHEMA = "cssface.facesjs-accessory-component@1";
export const FACES_JS_ACCESSORY_IDS = Object.freeze([
  "eye-black",
  "hat",
  "hat2",
  "hat3",
  "headband",
  "headband-high",
  "none",
  "santa-hat",
]);
export const FACES_JS_HAT_ACCESSORY_IDS = Object.freeze([
  "hat",
  "hat2",
  "hat3",
  "santa-hat",
]);

const PROJECTED_IDS = new Set(["eye-black"]);
const HEADBAND_IDS = new Set(["headband", "headband-high"]);
const HAT_IDS = new Set(FACES_JS_HAT_ACCESSORY_IDS);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedVertex(vertex) {
  return Object.freeze({
    source: vertex.source,
    position: vertex.position,
    states: Object.freeze({ fatness: vertex.states.fatness }),
  });
}

function normalizedVolume(volume) {
  return Object.freeze({
    ...volume,
    attachmentProfile: Object.freeze({
      ...volume.attachmentProfile,
      minimumFrontClearanceCssPx: 2.64,
    }),
    mesh: Object.freeze({
      ...volume.mesh,
      vertices: Object.freeze(volume.mesh.vertices.map(normalizedVertex)),
    }),
    frontPaint: Object.freeze(volume.frontPaint.map((triangle) => Object.freeze({
      ...triangle,
      vertices: Object.freeze(triangle.vertices.map(normalizedVertex)),
    }))),
  });
}

function kindFor(sourceId) {
  if (sourceId === "none") return "empty";
  if (PROJECTED_IDS.has(sourceId)) return "projected";
  if (HEADBAND_IDS.has(sourceId)) return "headband";
  if (HAT_IDS.has(sourceId)) return "hat";
  throw new TypeError(`FacesJS accessory ${sourceId} is unclassified.`);
}

function hairInteraction(sourceId, hairStrategyDocument) {
  if (!HAT_IDS.has(sourceId)) {
    return Object.freeze({ applies: false, source: "facesjs-display", rules: null });
  }
  const rows = hairStrategyDocument.entries.filter(({ family }) => family === "hair");
  const selected = (action, replacementSourceId = null) => rows
    .filter((row) => row.accessorySubstitution.action === action
      && row.accessorySubstitution.replacementSourceId === replacementSourceId)
    .map(({ sourceId: id }) => id)
    .sort();
  const rules = Object.freeze({
    hide: Object.freeze(selected("hide")),
    substituteShort: Object.freeze(selected("substitute", "short")),
    substituteShortFade: Object.freeze(selected("substitute", "short-fade")),
  });
  const covered = new Set(Object.values(rules).flat());
  if (covered.size !== rows.length) {
    throw new RangeError(`FacesJS hat ${sourceId} hair rules cover ${covered.size}/${rows.length}.`);
  }
  return Object.freeze({ applies: true, source: "facesjs-display", rules });
}

function emptyGeometry({ sourceId, sourceSha256, hairStrategyDocument }) {
  return {
    layer: 15,
    attachment: "raised",
    materialRoles: [],
    empty: true,
    stateIds: [],
    kind: "empty",
    dependencies: [],
    hairInteraction: hairInteraction(sourceId, hairStrategyDocument),
    provenance: {
      frontSilhouette: "facesjs-empty-source",
      depthProfile: "none",
      rearClosure: "none",
    },
    attachmentProfile: {
      family: "head",
      compatibleSourceIds: [],
      headProfiles: [],
      minimumFrontClearanceCssPx: null,
      minimumOverlapPoints: 0,
      minimumShoulderClearanceCssPx: null,
      seam: "none",
    },
    mesh: { vertices: [], triangles: [], frontBoundary: [], rearBoundary: [], sourceRows: 0 },
    frontPaint: [],
    metrics: {
      boundaryEdgeCount: 0,
      connected: true,
      frontPaintTriangleCount: 0,
      minimumTriangleArea: 0,
      nonManifoldEdgeCount: 0,
      signedVolume: 0,
      triangleCount: 0,
      vertexCount: 0,
    },
  };
}

export function compileFacesJsAccessoryComponent({
  sourceId,
  fragment,
  sourceSha256,
  headFragments,
  hairStrategyDocument,
}) {
  if (!FACES_JS_ACCESSORY_IDS.includes(sourceId)) {
    throw new TypeError(`FacesJS accessory ${sourceId} is unsupported.`);
  }
  if (sha256(fragment) !== sourceSha256) {
    throw new TypeError(`FacesJS accessories.${sourceId} source hash is stale.`);
  }
  const kind = kindFor(sourceId);
  const compiled = kind === "empty"
    ? emptyGeometry({ sourceId, sourceSha256, hairStrategyDocument })
    : (() => {
      const volume = normalizedVolume(buildFacesJsHeadMountedSource({
        fragment,
        headFragments,
        family: "accessories",
        depthStrategy: kind === "hat" ? "accessory-hat" : "accessory-band",
        includeShell: kind !== "projected",
      }));
      if (volume.attachmentProfile.minimumOverlapPoints <= 0
        || volume.attachmentProfile.minimumFrontClearanceCssPx < 2.6) {
        throw new RangeError(`FacesJS accessory ${sourceId} loses head clearance.`);
      }
      return {
        layer: 15,
        attachment: kind === "projected" ? "raised" : "head-shell",
        materialRoles: volume.materialRoles,
        empty: false,
        stateIds: ["fatness"],
        kind,
        dependencies: [],
        hairInteraction: hairInteraction(sourceId, hairStrategyDocument),
        provenance: {
          frontSilhouette: "facesjs-svg-fill-and-stroke-contours",
          depthProfile: kind === "projected"
            ? "adapter-authored-raised-head-projection"
            : kind === "hat"
              ? "adapter-authored-volumetric-hat-sweep"
              : "adapter-authored-headband-sweep",
          rearClosure: kind === "projected" ? "none" : "adapter-authored-closed-sweep",
        },
        attachmentProfile: volume.attachmentProfile,
        mesh: volume.mesh,
        frontPaint: volume.frontPaint,
        metrics: volume.metrics,
      };
    })();
  const payload = {
    schema: FACES_JS_ACCESSORY_COMPONENT_SCHEMA,
    family: "accessories",
    sourceId,
    sourceSha256,
    ...compiled,
  };
  return Object.freeze({
    ...payload,
    contentHash: sha256(JSON.stringify(payload)),
  });
}
