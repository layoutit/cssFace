import sharp from "sharp";

export const FACES_JS_COMPONENT_ROTATION_LIGHTING_SCHEMA =
  "cssface.facesjs-component-rotation-lighting@3";
export const FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE = "rotation-diffuse";
export const FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE = "rotation-specular";

const SPIN_STEPS = 120;
const FIELD_SOURCE_PX = 1;
const MAXIMUM_ATLAS_EDGE_PX = 8192;
const AMBIENT = 0.28;
const KEY = Object.freeze({
  direction: Object.freeze([-0.62, -0.35, -0.70]),
  intensity: 0.92,
});
const FILL = Object.freeze({
  direction: Object.freeze([0.55, -0.10, -0.55]),
  intensity: 0.06,
});
const VIEW_DIRECTION = Object.freeze([0, 0, -1]);

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + (value * right[index]), 0);
}

function normalize(value) {
  const length = Math.hypot(...value);
  if (length <= 1e-12) throw new RangeError("FacesJS lighting vector is degenerate.");
  return value.map((component) => component / length);
}

function average(vectors) {
  const result = [0, 0, 0];
  for (const vector of vectors) {
    for (let axis = 0; axis < 3; axis += 1) {
      result[axis] += vector[axis] / vectors.length;
    }
  }
  return result;
}

function linearChannelToSrgb(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function specularForRole(role) {
  if (["eye-white", "eye-off-white", "highlight", "lens", "accessory-white"].includes(role)) {
    return Object.freeze({ strength: 0.16, shininess: 36 });
  }
  if (["skin", "face-shave", "head-shave", "blush", "freckle"].includes(role)) {
    return Object.freeze({ strength: 0.13, shininess: 14 });
  }
  if (["team-primary", "team-secondary", "team-accent", "jersey-white"].includes(role)) {
    return Object.freeze({ strength: 0.03, shininess: 10 });
  }
  return Object.freeze({ strength: 0, shininess: 1 });
}

function samplesForModel(model, materialRoles, visibilityModes) {
  const polygonById = new Map(
    model.topology.polygons.map((polygon) => [polygon.id, polygon]),
  );
  return model.render.leaves.map((leaf) => {
    const polygon = polygonById.get(leaf.polygonId);
    const role = materialRoles[leaf.materialId];
    if (!polygon || !role || ![3, 4].includes(polygon.normalIndices.length)) {
      throw new TypeError(`FacesJS prepared leaf ${leaf.id} has no lighting source.`);
    }
    const normal = normalize(average(
      polygon.normalIndices.map((index) =>
        model.topology.normals[index].map((component) => -component)),
    ));
    const centroid = average(polygon.vertexIndices.map((index) =>
      model.topology.vertices[index]));
    const visibilityRadius = Math.hypot(centroid[0], centroid[2]);
    const visibilityMode = visibilityModes.get(leaf.materialId) ?? "none";
    if (!["front", "none", "radial"].includes(visibilityMode)) {
      throw new TypeError(`FacesJS prepared leaf ${leaf.id} has no visibility mode.`);
    }
    return Object.freeze({
      leafId: leaf.id,
      materialRole: role,
      normal: Object.freeze(normal),
      specular: specularForRole(role),
      visibilityMode,
      visibilityDirection: visibilityMode === "front"
        ? VIEW_DIRECTION
        : visibilityMode === "radial" && visibilityRadius > 1e-9
          ? Object.freeze([-centroid[0] / visibilityRadius, 0, -centroid[2] / visibilityRadius])
          : null,
    });
  });
}

function polygonNormal(vertices) {
  const normal = [0, 0, 0];
  for (const [index, current] of vertices.entries()) {
    const next = vertices[(index + 1) % vertices.length];
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return normalize(normal);
}

function samplesForPolygons(polygons, materialRoles) {
  if (polygons.length !== materialRoles.length) {
    throw new TypeError("FacesJS prepared polygons and material roles differ in length.");
  }
  return polygons.map((polygon, index) => {
    if (!polygon || !Array.isArray(polygon.vertices)
      || polygon.vertices.length < 3) {
      throw new TypeError(`FacesJS prepared polygon ${index} has no lighting source.`);
    }
    const worldNormal = polygonNormal(polygon.vertices);
    const role = materialRoles[index];
    if (typeof role !== "string" || role.length === 0) {
      throw new TypeError(`FacesJS prepared polygon ${index} has no material role.`);
    }
    return Object.freeze({
      leafId: `polygon-${String(index).padStart(6, "0")}`,
      materialRole: role,
      normal: Object.freeze([
        -worldNormal[1],
        -worldNormal[0],
        -worldNormal[2],
      ]),
      specular: specularForRole(role),
      visibilityMode: "none",
      visibilityDirection: null,
    });
  });
}

function shade(sample, yawRadians, keyDirection, fillDirection, halfDirection) {
  const cosine = Math.cos(yawRadians);
  const sine = Math.sin(yawRadians);
  const normal = [
    (cosine * sample.normal[0]) + (sine * sample.normal[2]),
    sample.normal[1],
    (-sine * sample.normal[0]) + (cosine * sample.normal[2]),
  ];
  const keyDiffuse = Math.max(0, dot(normal, keyDirection));
  const intensity = AMBIENT
    + (KEY.intensity * keyDiffuse)
    + (FILL.intensity * Math.max(0, dot(normal, fillDirection)));
  const specular = keyDiffuse > 0
    ? KEY.intensity * sample.specular.strength
      * Math.max(0, dot(normal, halfDirection)) ** sample.specular.shininess
    : 0;
  const visibilityDirection = sample.visibilityDirection
    ? [
      (cosine * sample.visibilityDirection[0]) + (sine * sample.visibilityDirection[2]),
      0,
      (-sine * sample.visibilityDirection[0]) + (cosine * sample.visibilityDirection[2]),
    ]
    : null;
  const visible = sample.visibilityMode === "none"
    || visibilityDirection === null
    || visibilityDirection[2] <= 0;
  return [
    Math.round(linearChannelToSrgb(intensity) * 255),
    Math.round(Math.max(0, Math.min(1, specular)) * 255),
    visible ? 255 : 0,
  ];
}

async function compileSamples(samples, modelId, modelRevision) {
  const columns = Math.min(samples.length, MAXIMUM_ATLAS_EDGE_PX);
  const pageCount = Math.ceil(samples.length / columns);
  const width = columns * FIELD_SOURCE_PX;
  const height = pageCount * SPIN_STEPS * FIELD_SOURCE_PX;
  if (height > MAXIMUM_ATLAS_EDGE_PX) {
    throw new RangeError(`FacesJS component rotation atlas height ${height} exceeds 8192.`);
  }
  const keyDirection = normalize(KEY.direction);
  const fillDirection = normalize(FILL.direction);
  const viewDirection = normalize(VIEW_DIRECTION);
  const halfDirection = normalize(keyDirection.map(
    (value, index) => value + viewDirection[index],
  ));
  const diffuseRgba = Buffer.alloc(width * height * 4);
  const specularRgba = Buffer.alloc(width * height * 4);
  for (let spinIndex = 0; spinIndex < SPIN_STEPS; spinIndex += 1) {
    const yawRadians = spinIndex * Math.PI * 2 / SPIN_STEPS;
    for (let leafIndex = 0; leafIndex < samples.length; leafIndex += 1) {
      const [diffuse, specular, visibility] = shade(
        samples[leafIndex], yawRadians, keyDirection, fillDirection, halfDirection,
      );
      const column = leafIndex % columns;
      const page = Math.floor(leafIndex / columns);
      const row = (page * SPIN_STEPS) + spinIndex;
      const offset = ((row * width) + column) * 4;
      diffuseRgba.set([diffuse, diffuse, diffuse, 255], offset);
      specularRgba.set([specular, specular, specular, visibility], offset);
    }
  }
  const [diffuseImageBytes, specularImageBytes] = await Promise.all([
    sharp(diffuseRgba, { raw: { width, height, channels: 4 } })
      .webp({ lossless: true, effort: 6 }).toBuffer(),
    sharp(specularRgba, { raw: { width, height, channels: 4 } })
      .webp({ lossless: true, effort: 6 }).toBuffer(),
  ]);
  const roleIds = [...new Set(samples.map(({ materialRole }) => materialRole))].sort();
  const roleIndices = samples.map(({ materialRole }) => roleIds.indexOf(materialRole));
  return Object.freeze({
    contract: Object.freeze({
      schema: FACES_JS_COMPONENT_ROTATION_LIGHTING_SCHEMA,
      technique: "prepared-yaw-space-time-neutral-texel-matrix",
      runtimeColorWrites: 0,
      runtimeLightingMath: 0,
      runtimeStyleWritesMaximum: 1,
      modelId,
      modelRevision,
      leafIds: Object.freeze(samples.map(({ leafId }) => leafId)),
      state: Object.freeze({
        spinSteps: SPIN_STEPS,
        fieldSourcePx: FIELD_SOURCE_PX,
      }),
      materials: Object.freeze({
        roleIds: Object.freeze(roleIds),
        leafRoleIndicesBase64: Buffer.from(roleIndices).toString("base64"),
      }),
      visibility: Object.freeze({
        encoding: "prepared-space-time-alpha-mask",
        managedLeafCount: samples.filter(({ visibilityMode }) =>
          visibilityMode !== "none").length,
        radialLeafCount: samples.filter(({ visibilityMode }) =>
          visibilityMode === "radial").length,
        frontLeafCount: samples.filter(({ visibilityMode }) =>
          visibilityMode === "front").length,
      }),
      atlases: Object.freeze({
        layout: "paged-source-order-face-columns-by-yaw-state-rows",
        diffuse: Object.freeze({
          asset: FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE,
          encoding: "srgb-multiplier-grayscale",
          width,
          height,
        }),
        specular: Object.freeze({
          asset: FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE,
          encoding: "screen-amplitude-grayscale",
          alphaEncoding: "frontface-visibility",
          width,
          height,
        }),
      }),
      lighting: Object.freeze({
        ambient: AMBIENT,
        key: KEY,
        fill: FILL,
        viewDirection: VIEW_DIRECTION,
      }),
      runtime: Object.freeze({
        rootStateWritesMaximum: 1,
        leafStateWrites: 0,
        faceStateScans: 0,
        operation: "one inherited space-time row offset",
      }),
    }),
    diffuseImageBytes,
    specularImageBytes,
  });
}

export async function compileFacesJsComponentRotationLighting(
  model,
  materialRoles,
  visibilityModes = new Map(),
) {
  return compileSamples(
    samplesForModel(model, materialRoles, visibilityModes),
    model.identity.id,
    model.identity.revision,
  );
}

export async function compileFacesJsPolygonRotationLighting({
  modelId,
  modelRevision,
  polygons,
  materialRoles,
}) {
  return compileSamples(
    samplesForPolygons(polygons, materialRoles),
    modelId,
    modelRevision,
  );
}
