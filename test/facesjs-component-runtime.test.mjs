import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  validatePolyMorphModel,
} from "@layoutit/polycss-morph";
import {
  createFacesJsComponentRuntime,
} from "../.build/prepare/src/adapters/facesjs/player/componentRuntime.js";

const publicRoot = resolve(import.meta.dirname, "../public");
const presets = JSON.parse(await readFile(resolve(
  import.meta.dirname,
  "../src/adapters/facesjs/presets.json",
), "utf8"));
const presetById = new Map(presets.map((preset) => [preset.id, preset]));

function localFetch(requests) {
  return async (input) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push(url);
    if (!url.startsWith("/facesjs-components/")) {
      return new Response("outside component root", { status: 404 });
    }
    try {
      const bytes = await readFile(resolve(publicRoot, url.slice(1)));
      return new Response(bytes, { status: 200 });
    } catch {
      return new Response("missing", { status: 404 });
    }
  };
}

test("six compatibility faces compose only from the reusable component graph", async () => {
  const requests = [];
  const runtime = await createFacesJsComponentRuntime(
    localFetch(requests),
    "/facesjs-components/",
  );
  try {
    const classic = await runtime.composeFaceConfig(
      presetById.get("classic").face,
      "classic",
    );
    assert.equal(classic.base.id, "bust");
    assert.equal(classic.selectedKeys.length, 16);
    assert.equal(classic.model.identity.id, "facesjs-component-face");
    validatePolyMorphModel(classic.model);
    assert.ok(classic.model.render.leaves.length > 0);
    assert.ok(classic.lighting.length > 0);
    assert.ok(requests.every((url) => !url.includes("facesjs-lowpoly-head")));

    const afterClassic = requests.length;
    await runtime.composeFaceConfig(presetById.get("classic").face, "classic");
    assert.equal(requests.length, afterClassic, "a cached fixture refetched assets");

    const beforeEyeSwap = requests.length;
    const eyeSwap = structuredClone(presetById.get("classic").face);
    eyeSwap.eye.id = "eye3";
    await runtime.composeFaceConfig(eyeSwap, "eye-swap");
    assert.deepEqual(
      [...new Set(requests.slice(beforeEyeSwap).map((url) => {
        const match = /\/components\/([^/]+)\/([^/]+)\//u.exec(url);
        return match ? `${match[1]}:${match[2]}` : url;
      }))],
      ["eye:eye3"],
      "changing one id fetched more than its selected component delta",
    );

    const beforeAfro = requests.length;
    const afro = await runtime.composeFaceConfig(presetById.get("afro").face, "afro");
    const afroDelta = requests.slice(beforeAfro);
    assert.deepEqual(
      [...new Set(afroDelta.map((url) => {
        const match = /\/components\/([^/]+)\/([^/]+)\//u.exec(url);
        return match ? `${match[1]}:${match[2]}` : url;
      }))].sort(),
      ["eye:eye2", "hair:afro", "head:head3", "nose:nose1"],
    );
    assert.ok(afro.selectedKeys.includes("hair:afro"));
    assert.ok(!afro.selectedKeys.includes("hair:short"));

    const bald = await runtime.composeFaceConfig(presetById.get("bald").face, "bald");
    const short2 = await runtime.composeFaceConfig(
      presetById.get("short2").face,
      "short2",
    );
    const bright = await runtime.composeFaceConfig(
      presetById.get("bright").face,
      "bright",
    );
    const steady = await runtime.composeFaceConfig(
      presetById.get("steady").face,
      "steady",
    );
    assert.ok(bald.selectedKeys.includes("hair:bald"));
    assert.ok(short2.selectedKeys.includes("hair:short2"));
    assert.ok(bright.selectedKeys.includes("eye:eye3"));
    assert.ok(bright.selectedKeys.includes("eyebrow:eyebrow2"));
    assert.ok(bright.selectedKeys.includes("mouth:smile2"));
    assert.ok(bright.selectedKeys.includes("nose:nose2"));
    assert.ok(steady.selectedKeys.includes("eye:eye4"));
    assert.ok(steady.selectedKeys.includes("eyebrow:eyebrow3"));
    assert.ok(steady.selectedKeys.includes("mouth:straight"));
    assert.ok(steady.selectedKeys.includes("nose:nose4"));
    for (const program of [afro, bald, short2, bright, steady]) {
      validatePolyMorphModel(program.model);
      assert.equal(program.selectedKeys.length, 16);
    }
  } finally {
    runtime.destroy();
  }
});
