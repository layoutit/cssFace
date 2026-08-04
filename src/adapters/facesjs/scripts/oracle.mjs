import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { chromium } from "playwright";
import { svgs } from "facesjs";
import sharp from "sharp";
import { createServer } from "vite";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const corpusPath = resolve(repoRoot, "test/fixtures/facesjs-corpus/corpus.json");
const oracleContractPath = resolve(
  repoRoot,
  "test/fixtures/facesjs-oracle-contract.json",
);
const catalogPath = resolve(repoRoot, "public/facesjs-components/catalog.json");
const compatibilityPath = resolve(repoRoot, "src/adapters/facesjs/compatibility.json");
const hairStrategiesPath = resolve(repoRoot, "src/adapters/facesjs/hairStrategies.json");
const componentRoot = resolve(repoRoot, "public/facesjs-components");
const outputRoot = resolve(repoRoot, "output/facesjs-oracle");
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const BACKGROUND = Object.freeze([26, 107, 104]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rounded(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function componentKey(row) {
  return `${row.family}:${row.sourceId}`;
}

function transformNumbers(value) {
  return [...value.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/giu)]
    .map(([number]) => Number(number));
}

function transformShape(value) {
  return value.replace(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/giu, "#");
}

function equivalentBrowserTransformShapes(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    const target = expected[index];
    return transformShape(value) === transformShape(target)
      && transformNumbers(value).length === transformNumbers(target).length;
  });
}

function browserTransformDelta(actual, expected) {
  if (transformShape(actual) !== transformShape(expected)) return Infinity;
  const left = transformNumbers(actual);
  const right = transformNumbers(expected);
  if (left.length !== right.length) return Infinity;
  return left.reduce((maximum, number, index) =>
    Math.max(maximum, Math.abs(number - right[index])), 0);
}

function greedyCoverage(cases, componentKeys) {
  const missing = new Set(componentKeys);
  const selected = [];
  while (missing.size > 0) {
    const winner = cases
      .map((row) => ({
        row,
        gain: row.selectedKeys.filter((key) => missing.has(key)).length,
      }))
      .filter(({ gain }) => gain > 0)
      .sort((left, right) => right.gain - left.gain
        || left.row.id.localeCompare(right.row.id))[0];
    assert(winner, `FacesJS oracle cannot cover ${[...missing].join(", ")}.`);
    selected.push(winner.row);
    for (const key of winner.row.selectedKeys) missing.delete(key);
  }
  return selected;
}

function distinctCases(rows) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function xml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]);
}

async function labelledTile(label, captures, width = 220, height = 158) {
  const header = 24;
  const gap = 2;
  const tileWidth = (width * captures.length) + (gap * (captures.length - 1));
  const images = await Promise.all(captures.map((capture) =>
    sharp(capture).resize(width, height, { fit: "fill" }).png().toBuffer()));
  const title = Buffer.from(
    `<svg width="${tileWidth}" height="${header}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="100%" height="100%" fill="#151515"/>` +
    `<text x="7" y="17" fill="#d8d8d8" font-family="monospace" font-size="12">` +
    `${xml(label)}</text></svg>`,
  );
  return sharp({
    create: {
      width: tileWidth,
      height: header + height,
      channels: 4,
      background: "#151515",
    },
  }).composite([
    { input: title, left: 0, top: 0 },
    ...images.map((input, index) => ({
      input,
      left: index * (width + gap),
      top: header,
    })),
  ]).png().toBuffer();
}

async function contactSheet(tiles, columns, path) {
  assert(tiles.length > 0, `FacesJS contact sheet ${path} has no tiles.`);
  const metadata = await sharp(tiles[0]).metadata();
  const width = metadata.width;
  const height = metadata.height;
  assert(width && height, "FacesJS contact tile has no dimensions.");
  const rows = Math.ceil(tiles.length / columns);
  await sharp({
    create: {
      width: width * columns,
      height: height * rows,
      channels: 4,
      background: "#151515",
    },
  }).composite(tiles.map((input, index) => ({
    input,
    left: (index % columns) * width,
    top: Math.floor(index / columns) * height,
  }))).png().toFile(path);
}

async function imageMask(bytes) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  let count = 0;
  let minimumX = info.width;
  let minimumY = info.height;
  let maximumX = -1;
  let maximumY = -1;
  let sumX = 0;
  let sumY = 0;
  let lightFeaturePixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixel = (y * info.width) + x;
      const offset = pixel * info.channels;
      const difference = Math.max(
        Math.abs(data[offset] - BACKGROUND[0]),
        Math.abs(data[offset + 1] - BACKGROUND[1]),
        Math.abs(data[offset + 2] - BACKGROUND[2]),
      );
      if (data[offset + 3] === 0 || difference <= 10) continue;
      mask[pixel] = 1;
      count += 1;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      sumX += x;
      sumY += y;
      const minimumChannel = Math.min(
        data[offset],
        data[offset + 1],
        data[offset + 2],
      );
      const maximumChannel = Math.max(
        data[offset],
        data[offset + 1],
        data[offset + 2],
      );
      if (x > info.width * 0.2 && x < info.width * 0.8
        && y > info.height * 0.22 && y < info.height * 0.72
        && minimumChannel >= 100 && maximumChannel - minimumChannel <= 20) {
        lightFeaturePixels += 1;
      }
    }
  }
  assert(count > 0, "FacesJS oracle capture has no foreground pixels.");
  return Object.freeze({
    data,
    channels: info.channels,
    width: info.width,
    height: info.height,
    mask,
    count,
    lightFeaturePixels,
    bounds: Object.freeze({ minimumX, minimumY, maximumX, maximumY }),
    centroid: Object.freeze({ x: sumX / count, y: sumY / count }),
  });
}

function hexRgb(value) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  assert(match, `FacesJS oracle skin color ${value} is invalid.`);
  return match.slice(1).map((channel) => Number.parseInt(channel, 16));
}

function dilatedMask(mask, width, height, radius) {
  if (radius === 0) return mask;
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    let active = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x += 1) {
      active += mask[offset + x];
    }
    for (let x = 0; x < width; x += 1) {
      if (active > 0) horizontal[offset + x] = 1;
      const added = x + radius + 1;
      const removed = x - radius;
      if (added < width) active += mask[offset + added];
      if (removed >= 0) active -= mask[offset + removed];
    }
  }
  const output = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let active = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y += 1) {
      active += horizontal[(y * width) + x];
    }
    for (let y = 0; y < height; y += 1) {
      if (active > 0) output[(y * width) + x] = 1;
      const added = y + radius + 1;
      const removed = y - radius;
      if (added < height) active += horizontal[(added * width) + x];
      if (removed >= 0) active -= horizontal[(removed * width) + x];
    }
  }
  return output;
}

async function pairedMetrics(sourceBytes, outputBytes, face, tolerances) {
  const [source, output] = await Promise.all([
    imageMask(sourceBytes),
    imageMask(outputBytes),
  ]);
  assert(source.width === output.width && source.height === output.height,
    "FacesJS paired captures have different dimensions.");
  let intersection = 0;
  let union = 0;
  let colorDifference = 0;
  let colorSamples = 0;
  let sourceSkinPixels = 0;
  let darkSkinOcclusionCandidates = 0;
  let darkSkinOcclusions = 0;
  const skin = hexRgb(face.body.color);
  const sourceFeatures = new Uint8Array(source.mask.length);
  for (let pixel = 0; pixel < source.mask.length; pixel += 1) {
    if (source.mask[pixel] === 0) continue;
    const sourceOffset = pixel * source.channels;
    if (Math.max(
      Math.abs(source.data[sourceOffset] - skin[0]),
      Math.abs(source.data[sourceOffset + 1] - skin[1]),
      Math.abs(source.data[sourceOffset + 2] - skin[2]),
    ) > 18) sourceFeatures[pixel] = 1;
  }
  const nearSourceFeature = dilatedMask(
    sourceFeatures,
    source.width,
    source.height,
    tolerances.maximumDarkFeatureRegistrationPx,
  );
  for (let pixel = 0; pixel < source.mask.length; pixel += 1) {
    const left = source.mask[pixel] === 1;
    const right = output.mask[pixel] === 1;
    if (left || right) union += 1;
    if (left && right) {
      intersection += 1;
      const sourceOffset = pixel * source.channels;
      const outputOffset = pixel * output.channels;
      for (let channel = 0; channel < 3; channel += 1) {
        colorDifference += Math.abs(
          source.data[sourceOffset + channel] - output.data[outputOffset + channel],
        );
        colorSamples += 1;
      }
    }
    if (!left) continue;
    const sourceOffset = pixel * source.channels;
    if (Math.max(
      Math.abs(source.data[sourceOffset] - skin[0]),
      Math.abs(source.data[sourceOffset + 1] - skin[1]),
      Math.abs(source.data[sourceOffset + 2] - skin[2]),
    ) > 18) continue;
    sourceSkinPixels += 1;
    const outputOffset = pixel * output.channels;
    const sourceLight = source.data[sourceOffset]
      + source.data[sourceOffset + 1]
      + source.data[sourceOffset + 2];
    const outputLight = output.data[outputOffset]
      + output.data[outputOffset + 1]
      + output.data[outputOffset + 2];
    if (outputLight < sourceLight * 0.42) {
      darkSkinOcclusionCandidates += 1;
      if (nearSourceFeature[pixel] === 0) darkSkinOcclusions += 1;
    }
  }
  const boundsDelta = Object.fromEntries(Object.keys(source.bounds).map((key) => [
    key,
    output.bounds[key] - source.bounds[key],
  ]));
  const metrics = Object.freeze({
    silhouetteIoU: rounded(intersection / union),
    foregroundRatio: rounded(output.count / source.count),
    boundsDelta,
    centroidDelta: Object.freeze({
      x: rounded(output.centroid.x - source.centroid.x),
      y: rounded(output.centroid.y - source.centroid.y),
    }),
    lightFeatureRatio: rounded(
      output.lightFeaturePixels / Math.max(1, source.lightFeaturePixels),
    ),
    darkSkinOcclusionCandidateRatio: rounded(
      darkSkinOcclusionCandidates / Math.max(1, sourceSkinPixels),
    ),
    darkSkinOcclusionRatio: rounded(
      darkSkinOcclusions / Math.max(1, sourceSkinPixels),
    ),
    intersectionRgbMae: rounded(colorDifference / Math.max(1, colorSamples)),
  });
  const failures = [];
  if (metrics.silhouetteIoU < tolerances.minimumSilhouetteIoU) {
    failures.push(`silhouette IoU ${metrics.silhouetteIoU}`);
  }
  if (metrics.foregroundRatio < tolerances.minimumForegroundRatio
    || metrics.foregroundRatio > tolerances.maximumForegroundRatio) {
    failures.push(`foreground ratio ${metrics.foregroundRatio}`);
  }
  if (Object.values(metrics.boundsDelta).some(
    (delta) => Math.abs(delta) > tolerances.maximumBoundsDeltaPx,
  )) failures.push("bounds delta");
  if (Math.abs(metrics.centroidDelta.x) > tolerances.maximumCentroidDeltaPx
    || Math.abs(metrics.centroidDelta.y) > tolerances.maximumCentroidDeltaPx) {
    failures.push("centroid delta");
  }
  if (source.lightFeaturePixels > tolerances.minimumSourceLightFeaturePixels
    && (metrics.lightFeatureRatio < tolerances.minimumLightFeatureRatio
      || metrics.lightFeatureRatio > tolerances.maximumLightFeatureRatio)) {
    failures.push(`light feature ratio ${metrics.lightFeatureRatio}`);
  }
  if (metrics.darkSkinOcclusionRatio > tolerances.maximumDarkSkinOcclusionRatio) {
    failures.push(`dark skin occlusion ${metrics.darkSkinOcclusionRatio}`);
  }
  return Object.freeze({ metrics, failures: Object.freeze(failures) });
}

async function auditGeometry(catalog) {
  const projectedFamilies = new Set([
    "eyeLine", "smileLine", "miscLine", "facialHair", "eye", "eyebrow",
    "mouth", "nose", "glasses",
  ]);
  let closedShells = 0;
  let clearedFeatures = 0;
  for (const row of catalog.components) {
    const manifest = await readJson(resolve(componentRoot, row.manifestPath));
    const asset = manifest.assets.geometry;
    assert(asset, `FacesJS ${componentKey(row)} has no geometry audit asset.`);
    const geometry = JSON.parse(gunzipSync(await readFile(resolve(
      dirname(resolve(componentRoot, row.manifestPath)),
      asset.path,
    ))));
    if (geometry.empty) continue;
    if (projectedFamilies.has(row.family)) {
      assert(geometry.metrics.minimumClearanceCssPx >= 0.72,
        `FacesJS ${componentKey(row)} clips into its head surface.`);
      clearedFeatures += 1;
    }
    if (geometry.mesh?.triangles?.length > 0) {
      assert(geometry.metrics.boundaryEdgeCount === 0
        && geometry.metrics.nonManifoldEdgeCount === 0
        && geometry.metrics.minimumTriangleArea > 0,
      `FacesJS ${componentKey(row)} shell is open or non-manifold.`);
      closedShells += 1;
    }
  }
  return Object.freeze({ clearedFeatures, closedShells });
}

function strategyCases(corpus, hairStrategies) {
  const rows = [];
  const hairKinds = ["cap", "fade", "raised-mass", "background-coupled", "rear-long"];
  for (const strategy of hairKinds) {
    const component = hairStrategies.entries.find((row) =>
      row.family === "hair" && row.strategy === strategy);
    assert(component, `FacesJS oracle has no ${strategy} hair component.`);
    const selected = corpus.cases.find((row) =>
      row.selectedKeys.includes(`hair:${component.sourceId}`));
    assert(selected, `FacesJS oracle has no case for hair.${component.sourceId}.`);
    rows.push({ id: `hair-${strategy}`, case: selected });
  }
  for (const [id, sourceId] of [["accessory-band", "headband"], ["accessory-hat", "hat"]]) {
    const selected = corpus.cases.find((row) =>
      row.selectedKeys.includes(`accessories:${sourceId}`));
    assert(selected, `FacesJS oracle has no case for accessories.${sourceId}.`);
    rows.push({ id, case: selected });
  }
  rows.push({ id: "head-ear-body-shells", case: corpus.cases[0] });
  return rows;
}

async function runBrowserOracle(corpus, contract, hairStrategies) {
  const vite = await createServer({
    configFile: resolve(repoRoot, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  try {
    await vite.listen();
    const url = vite.resolvedUrls?.local?.[0];
    assert(url, "FacesJS oracle Vite server has no local URL.");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript(() => {
      globalThis.__cssFaceRenderContextCalls = [];
      const originalContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(kind, ...args) {
        globalThis.__cssFaceRenderContextCalls.push(String(kind));
        return originalContext.call(this, kind, ...args);
      };
      const originalRandom = crypto.getRandomValues.bind(crypto);
      Object.defineProperty(crypto, "getRandomValues", {
        configurable: true,
        value(array) {
          if (array instanceof Uint32Array && array.length === 1) {
            array[0] = 0;
            return array;
          }
          return originalRandom(array);
        },
      });
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const requestFailures = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("requestfailed", (request) => requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    ));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.documentElement.dataset.prototypeReady === "true"
      && globalThis.__cssFacePreview
      && globalThis.__facesJsPrototype?.snapshot().ready === true,
    null, { timeout: 180_000 });
    await page.addStyleTag({ content: [
      ".source-canvas, #stage { background: #1a6b68 !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }",
      ".face-spinner { display: none !important; }",
    ].join("\n") });

    const allKeys = Object.keys(corpus.components);
    let maximumPathLiveTransformDelta = 0;
    let maximumPathLiveTransformCase = "";
    let maximumMixedLiveTransformDelta = 0;
    let maximumMixedLiveTransformCase = "";
    for (const row of corpus.cases) {
      const actual = await page.evaluate((face) =>
        globalThis.__cssFacePreview.renderSource(face), row.face);
      assert(actual.length === row.upstream.groups.length,
        `FacesJS live SVG ${row.id} changed display group count.`);
      for (const [index, group] of row.upstream.groups.entries()) {
        const delta = browserTransformDelta(actual[index], group.transform);
        assert(Number.isFinite(delta),
          `FacesJS live SVG ${row.id} changed ${group.family}.${group.sourceId} transform shape.`);
        const fragment = svgs[group.family]?.[group.sourceId] ?? "";
        const mixedPrimitive = /<(?:circle|ellipse|line|polygon|polyline|rect)\b/iu.test(fragment);
        if (mixedPrimitive) {
          if (delta > maximumMixedLiveTransformDelta) {
            maximumMixedLiveTransformDelta = delta;
            maximumMixedLiveTransformCase = `${row.id}:${group.family}.${group.sourceId}`;
          }
        } else if (delta > maximumPathLiveTransformDelta) {
          maximumPathLiveTransformDelta = delta;
          maximumPathLiveTransformCase = `${row.id}:${group.family}.${group.sourceId}`;
        }
      }
    }
    assert(maximumPathLiveTransformDelta <= contract.maximumPathLiveTransformDeltaSourcePx,
      `FacesJS path-only live SVG transform delta ${maximumPathLiveTransformDelta} in ` +
      `${maximumPathLiveTransformCase} exceeds the source-pixel contract.`);
    console.log(
      `FacesJS live SVG transform preflight passed: path-only ` +
      `${rounded(maximumPathLiveTransformDelta)} source px; mixed-primitive ` +
      `${rounded(maximumMixedLiveTransformDelta)} source px.`,
    );
    const coverage = greedyCoverage(
      corpus.cases.filter(({ kind }) => kind === "catalog-coverage"),
      allKeys,
    );
    const requiredNamed = [
      "transform-minimum", "transform-maximum", "color-contract", "layer-collision",
    ].map((id) => {
      const row = corpus.cases.find((entry) => entry.id === id);
      assert(row, `FacesJS oracle required case ${id} is absent.`);
      return row;
    });
    const frontCases = distinctCases([...coverage, ...requiredNamed]);
    const covered = new Set(frontCases.flatMap(({ selectedKeys }) => selectedKeys));
    assert(allKeys.every((key) => covered.has(key)),
      "FacesJS oracle front cases do not cover every component id.");

    const setFace = async (row) => {
      const selected = await page.evaluate(async (face) =>
        globalThis.__cssFacePreview.setFaceConfig(face), row.face);
      assert(selected, `FacesJS oracle could not select ${row.id}.`);
      await page.evaluate(() => new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
      const runtime = await page.evaluate(() => {
        const snapshot = globalThis.__facesJsPrototype.snapshot();
        const sourceGroups = [...document.querySelectorAll("#source-face > svg > g")]
          .map((group) => group.getAttribute("transform") ?? "");
        const leaves = [...document.querySelectorAll("#stage .polycss-morph-leaf")];
        return {
          snapshot,
          sourceGroups,
          domLeaves: leaves.length,
          backfaces: [...new Set(leaves.map((leaf) =>
            getComputedStyle(leaf).backfaceVisibility))],
          visibleLeaves: leaves.filter((leaf) =>
            getComputedStyle(leaf).visibility === "visible").length,
          hiddenLeaves: leaves.filter((leaf) =>
            getComputedStyle(leaf).visibility === "hidden").length,
        };
      });
      assert(JSON.stringify(runtime.snapshot.faceConfig) === JSON.stringify(row.face),
        `FacesJS oracle ${row.id} mounted the wrong FaceConfig.`);
      assert(JSON.stringify(runtime.snapshot.selectedComponents)
        === JSON.stringify(row.selectedKeys),
      `FacesJS oracle ${row.id} selected the wrong component graph.`);
      assert(runtime.snapshot.renderer === "dom-css"
        && runtime.snapshot.canvases === 0
        && runtime.domLeaves === runtime.snapshot.leaves,
      `FacesJS oracle ${row.id} did not retain a DOM/CSS-only scene.`);
      assert(runtime.snapshot.leaves === row.selectedKeys.reduce(
        (sum, key) => sum + corpus.components[key].leaves,
        0,
      ), `FacesJS oracle ${row.id} lost selected component leaves.`);
      assert(runtime.backfaces.length === 1 && runtime.backfaces[0] === "visible"
        && runtime.visibleLeaves > 0 && runtime.hiddenLeaves > 0
        && runtime.visibleLeaves + runtime.hiddenLeaves === runtime.domLeaves,
      `FacesJS oracle ${row.id} did not apply prepared shell/feature visibility.`);
      assert(equivalentBrowserTransformShapes(
        runtime.sourceGroups,
        row.upstream.groups.map(({ transform }) => transform),
      ),
      `FacesJS oracle ${row.id} changed upstream SVG groups: ` +
      `${JSON.stringify(runtime.sourceGroups)} != ` +
      `${JSON.stringify(row.upstream.groups.map(({ transform }) => transform))}.`);
      return runtime.snapshot;
    };

    const frontTiles = [];
    const frontResults = [];
    for (const [index, row] of frontCases.entries()) {
      const snapshot = await setFace(row);
      const [source, output] = await Promise.all([
        page.locator(".source-canvas").screenshot({ animations: "disabled" }),
        page.locator("#stage").screenshot({ animations: "disabled" }),
      ]);
      const comparison = await pairedMetrics(
        source,
        output,
        row.face,
        contract.tolerances,
      );
      frontResults.push(Object.freeze({
        id: row.id,
        kind: row.kind,
        selectedKeys: row.selectedKeys,
        leaves: snapshot.leaves,
        leafIdentity: snapshot.leafIdentity,
        ...comparison,
      }));
      frontTiles.push(await labelledTile(`${index + 1}. ${row.id} | 2D / 3D`, [source, output]));
      console.log(`FacesJS oracle front capture ${index + 1}/${frontCases.length}: ${row.id}.`);
    }

    const volumeTiles = [];
    const volumeResults = [];
    for (const row of strategyCases(corpus, hairStrategies)) {
      await setFace(row.case);
      const captures = [];
      for (const yaw of contract.views.yawDegrees) {
        await page.evaluate((value) => globalThis.__cssFacePreview.setOrbit(value), yaw);
        await page.evaluate(() => new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
        captures.push(await page.locator("#stage").screenshot({ animations: "disabled" }));
      }
      volumeTiles.push(await labelledTile(
        `${row.id} | ${contract.views.yawDegrees.join(" / ")}`,
        captures,
        176,
        126,
      ));
      volumeResults.push(Object.freeze({
        id: row.id,
        caseId: row.case.id,
        yawDegrees: contract.views.yawDegrees,
      }));
    }

    const retainedCase = frontCases.find(({ selectedKeys }) =>
      selectedKeys.every((key) => !corpus.components[key].empty));
    assert(retainedCase, "FacesJS oracle has no fully painted retained-DOM case.");
    const before = await setFace(retainedCase);
    await page.evaluate(() => {
      globalThis.__cssFaceOracleLeafRefs = [
        ...document.querySelectorAll("#stage .polycss-morph-leaf"),
      ];
    });
    for (const yaw of [28, 55, -35, 0]) {
      await page.evaluate((value) => globalThis.__cssFacePreview.setOrbit(value), yaw);
    }
    const morphFace = structuredClone(retainedCase.face);
    morphFace.fatness = morphFace.fatness < 0.5 ? 0.82 : 0.18;
    morphFace.eye.angle = morphFace.eye.angle === 0 ? 7 : 0;
    const didMorph = await page.evaluate(async (face) =>
      globalThis.__cssFacePreview.setFaceConfig(face), morphFace);
    assert(didMorph, "FacesJS oracle same-component morph failed.");
    const retained = await page.evaluate(() => {
      const current = [...document.querySelectorAll("#stage .polycss-morph-leaf")];
      const refs = globalThis.__cssFaceOracleLeafRefs;
      const snapshot = globalThis.__facesJsPrototype.snapshot();
      return {
        snapshot,
        exactIdentity: refs.length === current.length
          && refs.every((leaf, index) => leaf === current[index] && leaf.isConnected),
      };
    });
    assert(retained.exactIdentity
      && retained.snapshot.leafIdentity === before.leafIdentity
      && retained.snapshot.topologyConstructions === before.topologyConstructions
      && retained.snapshot.rotationLightingPublications > before.rotationLightingPublications
      && retained.snapshot.rotationLightingWrites > before.rotationLightingWrites,
    "FacesJS orbit/morph rebuilt leaves or froze prepared lighting.");

    const replacementCase = frontCases.find(({ selectedKeys }) =>
      JSON.stringify(selectedKeys) !== JSON.stringify(retainedCase.selectedKeys));
    assert(replacementCase, "FacesJS oracle has no component-switch case.");
    await setFace(replacementCase);
    const replacement = await page.evaluate(() => ({
      snapshot: globalThis.__facesJsPrototype.snapshot(),
      oldLeavesConnected: globalThis.__cssFaceOracleLeafRefs.some((leaf) => leaf.isConnected),
    }));
    assert(!replacement.oldLeavesConnected
      && replacement.snapshot.topologyConstructions === 1,
    "FacesJS component switch retained stale leaves or rebuilt one scene twice.");

    const browserState = await page.evaluate(() => ({
      canvases: document.querySelectorAll("canvas").length,
      contexts: globalThis.__cssFaceRenderContextCalls,
      webglElements: document.querySelectorAll(
        "canvas, model-viewer, [data-renderer='webgl'], [data-renderer='canvas']",
      ).length,
    }));
    assert(browserState.canvases === 0 && browserState.webglElements === 0,
      "FacesJS oracle found a Canvas/WebGL renderer element.");
    assert(!browserState.contexts.some((kind) =>
      kind === "webgl" || kind === "webgl2" || kind === "webgpu"),
    "FacesJS oracle observed a WebGL/WebGPU context request.");
    assert(consoleErrors.length === 0,
      `FacesJS oracle console errors: ${consoleErrors.join(" | ")}`);
    assert(requestFailures.length === 0,
      `FacesJS oracle request failures: ${requestFailures.join(" | ")}`);

    await contactSheet(frontTiles, 2, resolve(outputRoot, "front-contact-sheet.png"));
    await contactSheet(volumeTiles, 1, resolve(outputRoot, "volume-contact-sheet.png"));
    return Object.freeze({
      frontCases: frontResults,
      volumeCases: volumeResults,
      retainedDom: Object.freeze({
        caseId: retainedCase.id,
        leaves: before.leaves,
        leafIdentity: before.leafIdentity,
        rotationLightingWrites: retained.snapshot.rotationLightingWrites - before.rotationLightingWrites,
        rotationLightingPublications: retained.snapshot.rotationLightingPublications
          - before.rotationLightingPublications,
      }),
      browserState,
      consoleErrors,
      requestFailures,
      maximumPathLiveTransformDelta: rounded(maximumPathLiveTransformDelta),
      maximumPathLiveTransformCase,
      maximumMixedLiveTransformDelta: rounded(maximumMixedLiveTransformDelta),
      maximumMixedLiveTransformCase,
    });
  } finally {
    await browser?.close();
    await vite.close();
  }
}

const check = process.argv.includes("--check") || process.argv.length === 2;
assert(check, "FacesJS oracle supports only --check.");
const [corpus, contract, catalog, compatibility, hairStrategies] = await Promise.all([
  readJson(corpusPath),
  readJson(oracleContractPath),
  readJson(catalogPath),
  readJson(compatibilityPath),
  readJson(hairStrategiesPath),
]);
assert(contract.schema === "cssface.facesjs-painted-oracle-contract@1",
  "FacesJS oracle contract schema is stale.");
assert(Number.isSafeInteger(contract.tolerances.maximumDarkFeatureRegistrationPx)
  && contract.tolerances.maximumDarkFeatureRegistrationPx >= 0,
"FacesJS oracle dark-feature registration tolerance is invalid.");
assert(corpus.facesJs.sourceRevision === compatibility.facesJs.sourceRevision,
  "FacesJS oracle corpus source revision is stale.");
assert(corpus.componentCount === catalog.components.length,
  "FacesJS oracle corpus catalog count is stale.");
await mkdir(outputRoot, { recursive: true });
const geometry = await auditGeometry(catalog);
const browser = await runBrowserOracle(corpus, contract, hairStrategies);
const failures = browser.frontCases.flatMap((row) =>
  row.failures.map((failure) => `${row.id}: ${failure}`));
const reportPayload = Object.freeze({
  schema: "cssface.facesjs-painted-oracle-report@1",
  capturedAt: new Date().toISOString(),
  sourceRevision: corpus.facesJs.sourceRevision,
  corpusContentHash: corpus.contentHash,
  componentCatalogContentHash: catalog.contentHash,
  componentCount: corpus.componentCount,
  supportedCount: Object.values(compatibility.families).reduce(
    (sum, family) => sum + family.ids.filter(({ support }) => support === "supported").length,
    0,
  ),
  geometry,
  ...browser,
  failures,
});
await writeFile(
  resolve(outputRoot, "report.json"),
  `${JSON.stringify({
    ...reportPayload,
    contentHash: sha256(JSON.stringify(reportPayload)),
  }, null, 2)}\n`,
);
assert(failures.length === 0,
  `FacesJS painted oracle failed:\n${failures.join("\n")}`);
console.log(
  `FacesJS painted oracle passed: ${browser.frontCases.length} paired fronts, ` +
  `${browser.volumeCases.length} four-view volume cases, ${corpus.componentCount} components.`,
);
