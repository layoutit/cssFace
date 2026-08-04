import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import sharp from "sharp";

import {
  FACES_JS_MATERIAL_ROLES,
  facesJsShaveOpacity,
  facesJsMaterialVariable,
  resolveFacesJsMaterialColors,
  resolveFacesJsMaterialRole,
  writeFacesJsMaterialVariables,
} from "../.build/prepare/src/adapters/facesjs/player/materialColors.js";

test("material ids resolve to independent FacesJS color roles", () => {
  assert.equal(resolveFacesJsMaterialRole("material-0000-skin-base"), "skin");
  assert.equal(resolveFacesJsMaterialRole("material-0001-skin-shadow"), "skin");
  assert.equal(resolveFacesJsMaterialRole("material-0002-ear-cap"), "skin");
  assert.equal(resolveFacesJsMaterialRole("material-0003-hair-base"), "hair");
  assert.equal(resolveFacesJsMaterialRole("overlay-facial-hair"), "hair");
  assert.equal(resolveFacesJsMaterialRole("material-head-shave"), "head-shave");
  assert.equal(resolveFacesJsMaterialRole("material-0006-jersey-base"), "team-primary");
  assert.equal(resolveFacesJsMaterialRole("jersey-team-secondary"), "team-secondary");
  assert.equal(resolveFacesJsMaterialRole("jersey-team-accent"), "team-accent");
  assert.equal(resolveFacesJsMaterialRole("material-0004-eye-white"), "eye-white");
  assert.equal(resolveFacesJsMaterialRole("material-0005-ink"), "ink");
  assert.equal(resolveFacesJsMaterialRole("glasses-frame-dark"), "frame-dark");
  assert.equal(resolveFacesJsMaterialRole("glasses-lens"), "lens");
  assert.equal(resolveFacesJsMaterialRole("hair-hair-fade"), "hair-fade");
  assert.throws(() => resolveFacesJsMaterialRole("material-unknown"), /no material role/u);
});

test("arbitrary FaceConfig colors become one root variable per material role", () => {
  const colors = resolveFacesJsMaterialColors({
    skin: "#A1B2C3",
    hair: "#123456",
    headShave: "#654321",
    teamColors: ["#112233", "#445566", "#778899"],
  });
  assert.deepEqual(colors, {
    "accessory-red": "#e50002",
    "accessory-translucent-ink": "#000000",
    "accessory-white": "#eeeaef",
    blush: "#a15757",
    "eye-off-white": "#f5f2ed",
    "eye-white": "#ffffff",
    "face-shave": "#654321",
    "frame-dark": "#333333",
    freckle: "#8b6135",
    "hair-fade": "#123456",
    skin: "#a1b2c3",
    hair: "#123456",
    "head-shave": "#654321",
    highlight: "#ffffff",
    ink: "#000000",
    "jersey-white": "#ffffff",
    lens: "#9696b0",
    "mouth-dark": "#501414",
    "team-primary": "#112233",
    "team-secondary": "#445566",
    "team-accent": "#778899",
  });

  const properties = new Map();
  writeFacesJsMaterialVariables({
    setProperty(name, value) {
      properties.set(name, value);
    },
  }, colors);
  assert.equal(properties.size, FACES_JS_MATERIAL_ROLES.length + 1);
  for (const role of FACES_JS_MATERIAL_ROLES) {
    assert.equal(properties.get(facesJsMaterialVariable(role)), colors[role]);
  }
  assert.equal(properties.get("--cssface-material-head-shave-opacity"), "1");
});

test("color validation rejects malformed and incomplete runtime updates", () => {
  const valid = {
    skin: "#abcdef",
    hair: "#123456",
    headShave: "rgba(0, 0, 0, 0)",
    teamColors: ["#111111", "#222222", "#333333"],
  };
  assert.equal(resolveFacesJsMaterialColors(valid)["head-shave"], "#000000");
  assert.equal(facesJsShaveOpacity(valid.headShave), 0);
  assert.equal(facesJsShaveOpacity("rgba(0, 0, 0, 0.2)"), 0.2);
  assert.equal(facesJsShaveOpacity("#123456"), 1);
  assert.throws(
    () => resolveFacesJsMaterialColors({ ...valid, skin: "red" }),
    /six-digit hex color/u,
  );
  assert.throws(
    () => resolveFacesJsMaterialColors({ ...valid, headShave: "transparent" }),
    /six-digit hex or black rgba color/u,
  );
  assert.throws(
    () => resolveFacesJsMaterialColors({ ...valid, teamColors: ["#111111"] }),
    /exactly three colors/u,
  );
});

test("all prepared components bind neutral lighting atlases to exact leaf roles", async () => {
  const root = new URL("../public/facesjs-components/", import.meta.url);
  const catalog = JSON.parse(await readFile(new URL("catalog.json", root), "utf8"));
  const selectedKeys = new Set(catalog.components.map(
    ({ family, sourceId }) => `${family}:${sourceId}`,
  ));
  let managedLeafCount = 0;
  for (const key of [...selectedKeys].sort()) {
    const [family, sourceId] = key.split(":");
    const componentRoot = new URL(`components/${family}/${sourceId}/`, root);
    const manifest = JSON.parse(await readFile(new URL("manifest.json", componentRoot), "utf8"));
    if (!manifest.assets.prepared) continue;
    const prepared = JSON.parse(gunzipSync(
      await readFile(new URL(manifest.assets.prepared.path, componentRoot)),
    ));
    if (prepared.empty) continue;
    const { model, rotationLighting: lighting } = prepared;
    assert.equal(lighting.schema, "cssface.facesjs-component-rotation-lighting@3");
    assert.equal(
      lighting.technique,
      "prepared-yaw-space-time-neutral-texel-matrix",
    );
    assert.equal(lighting.runtimeColorWrites, 0);
    assert.equal(lighting.runtimeLightingMath, 0);
    assert.equal(lighting.runtimeStyleWritesMaximum, 1);
    assert.deepEqual(lighting.runtime, {
      rootStateWritesMaximum: 1,
      leafStateWrites: 0,
      faceStateScans: 0,
      operation: "one inherited space-time row offset",
    });
    assert.equal(
      lighting.atlases.layout,
      "paged-source-order-face-columns-by-yaw-state-rows",
    );
    assert.ok(lighting.materials.roleIds.every((role) =>
      FACES_JS_MATERIAL_ROLES.includes(role)));
    const leafRoles = Buffer.from(
      lighting.materials.leafRoleIndicesBase64,
      "base64",
    );
    assert.equal(leafRoles.length, model.render.leaves.length);
    const materialById = new Map(
      model.materials.map((material) => [material.id, material]),
    );
    const polygonById = new Map(
      model.topology.polygons.map((polygon) => [polygon.id, polygon]),
    );
    const specularAsset = manifest.assets[lighting.atlases.specular.asset];
    const { data: specularRgba, info: specularInfo } = await sharp(
      await readFile(new URL(specularAsset.path, componentRoot)),
    ).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(specularInfo.width, lighting.atlases.specular.width);
    assert.equal(specularInfo.height, lighting.atlases.specular.height);
    const initialVisible = model.render.leaves.map((_, index) => {
      const column = index % specularInfo.width;
      const page = Math.floor(index / specularInfo.width);
      const row = page * lighting.state.spinSteps;
      return specularRgba[((row * specularInfo.width) + column) * 4 + 3] === 255 ? 1 : 0;
    });
    for (const [index, leaf] of model.render.leaves.entries()) {
      const material = materialById.get(leaf.materialId);
      assert.ok(material, `${key} leaf ${leaf.id} has a material`);
      assert.equal(
        lighting.materials.roleIds[leafRoles[index]],
        prepared.materialRoles[material.id],
      );
      if (material.id.endsWith("-front")) {
        assert.equal(initialVisible[index], 1, `${key} front leaf starts visible`);
      }
      if (material.id.endsWith("-radial")) {
        const polygon = polygonById.get(leaf.polygonId);
        assert.ok(polygon, `${key} radial leaf ${leaf.id} has a polygon`);
        const centroid = polygon.vertexIndices.reduce((sum, vertexIndex) => {
          const vertex = model.topology.vertices[vertexIndex];
          return sum.map((value, axis) => value + vertex[axis] / polygon.vertexIndices.length);
        }, [0, 0, 0]);
        const expected = Math.hypot(centroid[0], centroid[2]) <= 1e-9
          || centroid[2] >= 0 ? 1 : 0;
        assert.equal(
          initialVisible[index],
          expected,
          `${key} radial leaf ${leaf.id} starts on the source-facing hemisphere`,
        );
      }
    }
    assert.equal(
      lighting.atlases.diffuse.encoding,
      "srgb-multiplier-grayscale",
    );
    assert.equal(
      lighting.atlases.specular.encoding,
      "screen-amplitude-grayscale",
    );
    assert.equal(
      lighting.atlases.specular.alphaEncoding,
      "frontface-visibility",
    );
    assert.equal(
      lighting.visibility.encoding,
      "prepared-space-time-alpha-mask",
    );
    assert.equal(initialVisible.length, model.render.leaves.length);
    assert.ok(model.render.leaves.length <= 2_000, `${key} stays within the leaf ceiling`);
    for (const count of [
      lighting.visibility.managedLeafCount,
      lighting.visibility.radialLeafCount,
      lighting.visibility.frontLeafCount,
    ]) {
      assert.ok(Number.isSafeInteger(count));
      assert.ok(count >= 0 && count <= model.render.leaves.length);
    }
    assert.equal(
      lighting.visibility.radialLeafCount + lighting.visibility.frontLeafCount,
      lighting.visibility.managedLeafCount,
    );
    if (["head", "ear", "body"].includes(family)) {
      assert.ok(lighting.visibility.radialLeafCount > 0);
    }
    if (family === "body") {
      assert.ok(lighting.visibility.frontLeafCount > 0);
    }
    if (family === "jersey") {
      assert.equal(lighting.visibility.radialLeafCount, 0);
      assert.ok(lighting.visibility.frontLeafCount > 0);
    }
    if ([
      "eyeLine", "smileLine", "miscLine", "facialHair", "eye", "eyebrow",
      "mouth", "nose", "glasses",
    ].includes(family)) {
      assert.equal(lighting.visibility.radialLeafCount, 0);
      assert.ok(lighting.visibility.frontLeafCount > 0);
    }
    if (family === "hairBg") {
      assert.ok(lighting.visibility.radialLeafCount > 0);
      assert.equal(lighting.visibility.frontLeafCount, 0);
    }
    managedLeafCount += lighting.visibility.managedLeafCount;
    for (const atlas of [lighting.atlases.diffuse, lighting.atlases.specular]) {
      assert.ok(atlas.width <= 8192 && atlas.height <= 8192);
      const asset = manifest.assets[atlas.asset];
      assert.ok(asset, `${key} binds ${atlas.asset}`);
      assert.equal(
        (await readFile(new URL(asset.path, componentRoot))).byteLength,
        asset.bytes,
      );
    }
    assert.equal(manifest.assets["rotation-texels"], undefined);
  }
  assert.ok(managedLeafCount > 0);
});
