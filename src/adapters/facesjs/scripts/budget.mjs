import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const publicRoot = resolve(repoRoot, "public/facesjs-components");
const sceneRoot = resolve(repoRoot, "public/cssgraphics");
const catalogPath = resolve(publicRoot, "catalog.json");
const corpusPath = resolve(repoRoot, "test/fixtures/facesjs-corpus/corpus.json");
const presetsPath = resolve(repoRoot, "src/adapters/facesjs/presets.json");
const baselinePath = resolve(repoRoot, "test/fixtures/facesjs-baseline.json");
const contractPath = resolve(repoRoot, "test/fixtures/facesjs-budget-contract.json");
const outputPath = resolve(repoRoot, "output/facesjs-budget/report.json");
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const SCENE_RESOURCE_PATHS = new Set([
  "/cssgraphics/catalog.json",
  "/cssgraphics/models/facesjs-component-face/manifest.json",
  "/cssgraphics/models/facesjs-component-face/model.css",
  "/cssgraphics/models/facesjs-component-face/model.json",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function componentKey(row) {
  return `${row.family}:${row.sourceId}`;
}

function componentKeyFromPath(pathname) {
  const match = /\/facesjs-components\/components\/([^/]+)\/([^/]+)\//u.exec(pathname);
  return match ? `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}` : null;
}

async function staticReport(catalog, corpus) {
  const files = await listFiles(publicRoot);
  const totalBytes = (await Promise.all(files.map(fileSize)))
    .reduce((sum, bytes) => sum + bytes, 0);
  const rows = new Map(catalog.components.map((row) => [componentKey(row), row]));
  const packageBytes = new Map();
  for (const row of catalog.components) {
    const manifestPath = resolve(publicRoot, row.manifestPath);
    const manifest = await readJson(manifestPath);
    const packageRoot = dirname(manifestPath);
    const runtimeAssets = Object.entries(manifest.assets)
      .filter(([role]) => role !== "geometry");
    const bytes = await Promise.all(runtimeAssets.map(([, asset]) =>
      fileSize(resolve(packageRoot, asset.path))));
    packageBytes.set(
      componentKey(row),
      (await fileSize(manifestPath)) + bytes.reduce((sum, value) => sum + value, 0),
    );
  }
  const catalogBytes = await fileSize(catalogPath);
  const componentBaseBytes = (await Promise.all(catalog.bases.map(({ manifestPath }) =>
    fileSize(resolve(publicRoot, manifestPath)))))
    .reduce((sum, bytes) => sum + bytes, 0);
  const sceneBytes = (await Promise.all([...SCENE_RESOURCE_PATHS].map((pathname) =>
    fileSize(resolve(repoRoot, `public${pathname}`)))))
    .reduce((sum, bytes) => sum + bytes, 0);
  const baseBytes = componentBaseBytes + sceneBytes;
  const selectedCases = corpus.cases.map((row) => {
    const selectedBytes = row.selectedKeys.reduce((sum, key) => {
      assert(rows.has(key), `FacesJS budget corpus selects absent component ${key}.`);
      return sum + packageBytes.get(key);
    }, catalogBytes + baseBytes);
    return Object.freeze({ id: row.id, selectedBytes, componentCount: row.selectedKeys.length });
  }).sort((left, right) => right.selectedBytes - left.selectedBytes
    || left.id.localeCompare(right.id));
  const relativePaths = files.map((path) => relative(publicRoot, path));
  assert(new Set(catalog.components.map(componentKey)).size === catalog.components.length,
    "FacesJS budget catalog contains duplicate reusable ids.");
  assert(relativePaths.every((path) => !/combinations?|presets?\//iu.test(path)),
    "FacesJS output contains a preset or combination package.");
  assert(relativePaths.every((path) => !corpus.cases.some(({ id }) => path.includes(id))),
    "FacesJS output contains a corpus-case package.");
  assert(catalog.components.every(({ sourceId }) => !sourceId.includes("+")),
    "FacesJS catalog contains a feature-combination id.");
  return Object.freeze({
    totalBytes,
    fileCount: files.length,
    componentCount: catalog.components.length,
    baseCount: catalog.bases.length,
    corpusCaseCount: corpus.cases.length,
    largestSelectedCase: selectedCases[0],
  });
}

function assertSelectedRequests(paths, selectedKeys, label) {
  const selected = new Set(selectedKeys);
  for (const pathname of paths) {
    if (pathname.startsWith("/cssgraphics/")) {
      if (!SCENE_RESOURCE_PATHS.has(pathname)) {
        throw new Error(`${label} fetched unexpected scene resource ${pathname}.`);
      }
      continue;
    }
    const key = componentKeyFromPath(pathname);
    if (key !== null && !selected.has(key)) {
      throw new Error(`${label} fetched unselected component ${key}.`);
    }
    if (key === null && ![
      "/facesjs-components/catalog.json",
      "/facesjs-components/bases/bust/manifest.json",
    ].includes(pathname)) {
      throw new Error(`${label} fetched unexpected component resource ${pathname}.`);
    }
  }
}

function assertDeltaRequests(paths, beforeKeys, afterKeys, label) {
  const before = new Set(beforeKeys);
  const after = new Set(afterKeys);
  const added = new Set([...after].filter((key) => !before.has(key)));
  assertSelectedRequests(paths, afterKeys, label);
  for (const pathname of paths) {
    const key = componentKeyFromPath(pathname);
    if (key !== null && !added.has(key)) {
      throw new Error(`${label} refetched cached component ${key}.`);
    }
  }
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolveFrame) =>
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

async function captureFrames(page) {
  const before = await page.evaluate(() => globalThis.__facesJsPrototype.snapshot());
  await page.evaluate(() => {
    const state = { active: true, frames: [] };
    globalThis.__cssFaceBudgetFrames = state;
    const sample = (timestamp) => {
      if (!state.active) return;
      state.frames.push(timestamp);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const box = await page.locator("#stage").boundingBox();
  assert(box, "FacesJS budget stage has no browser bounds.");
  const startX = box.x + box.width * 0.22;
  const endX = box.x + box.width * 0.78;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let index = 1; index <= 90; index += 1) {
    await page.mouse.move(startX + ((endX - startX) * index / 90), y);
    await page.waitForTimeout(10);
  }
  await page.mouse.up();
  await page.waitForTimeout(220);
  const timestamps = await page.evaluate(() => {
    globalThis.__cssFaceBudgetFrames.active = false;
    return globalThis.__cssFaceBudgetFrames.frames;
  });
  const after = await page.evaluate(() => globalThis.__facesJsPrototype.snapshot());
  const frameTimes = timestamps.slice(1)
    .map((timestamp, index) => timestamp - timestamps[index])
    .filter((value) => value > 0 && value < 250);
  assert(frameTimes.length >= 30,
    `FacesJS budget captured only ${frameTimes.length} rotation frames.`);
  assert(before.leafIdentity === after.leafIdentity,
    "FacesJS rotation replaced retained leaf identity.");
  return Object.freeze({
    action: Object.freeze({
      type: "real-pointer-drag",
      selector: "#stage",
      steps: 90,
      settleMs: 220,
    }),
    frames: Object.freeze({
      sampleCount: frameTimes.length,
      p50Ms: round(percentile(frameTimes, 0.5)),
      p95Ms: round(percentile(frameTimes, 0.95)),
      p99Ms: round(percentile(frameTimes, 0.99)),
      maximumMs: round(Math.max(...frameTimes)),
    }),
    runtime: Object.freeze({
      leaves: before.leaves,
      canvases: before.canvases,
      leafIdentity: before.leafIdentity,
      styleWrites: after.rotationLightingWrites - before.rotationLightingWrites,
      publications:
        after.rotationLightingPublications - before.rotationLightingPublications,
      maximumBatch: after.rotationLightingMaximumBatch,
      lightingTexels: before.rotationLightingTexels,
    }),
  });
}

async function browserReport(corpus, presets) {
  const vite = await createServer({
    configFile: resolve(repoRoot, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  try {
    await vite.listen();
    const url = vite.resolvedUrls?.local?.[0];
    assert(url, "FacesJS budget Vite server has no local URL.");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript(() => {
      const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value(array) {
          if (array instanceof Uint32Array && array.length === 1) {
            array[0] = 0;
            return array;
          }
          return original(array);
        },
      });
    });
    const page = await context.newPage();
    const requests = [];
    const errors = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/facesjs-components/")) requests.push(pathname);
    });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.documentElement.dataset.prototypeReady === "true"
      && document.querySelector("#stage")?.dataset.facesJsReady === "true",
    null, { timeout: 120_000 });
    await settle(page);
    const initial = await page.evaluate(() => globalThis.__facesJsPrototype.snapshot());
    const resources = await page.evaluate(() =>
      performance.getEntriesByType("resource")
        .map((entry) => ({
          name: entry.name,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
        }))
        .filter(({ name }) => name.includes("/facesjs-components/")
          || name.includes("/cssgraphics/")));
    const coldPaths = resources.map(({ name }) => new URL(name).pathname);
    assertSelectedRequests(coldPaths, initial.selectedComponents, "Cold face");
    const coldTransferBytes = resources.reduce((sum, entry) =>
      sum + (entry.transferSize || entry.encodedBodySize), 0);

    const randomRequestStart = requests.length;
    const randomBefore = initial.selectedComponents;
    await page.evaluate(() => {
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value(array) {
          if (array instanceof Uint32Array && array.length === 1) {
            array[0] = 42;
            return array;
          }
          throw new TypeError("Unexpected random source in FacesJS budget harness.");
        },
      });
    });
    await page.locator("#random-button").click();
    await page.waitForFunction((prior) => {
      const snapshot = globalThis.__facesJsPrototype.snapshot();
      return JSON.stringify(snapshot.selectedComponents) !== JSON.stringify(prior)
        && !document.querySelector("#random-button")?.disabled;
    }, randomBefore, { timeout: 120_000 });
    await settle(page);
    const randomAfter = await page.evaluate(() => globalThis.__facesJsPrototype.snapshot());
    const randomPaths = requests.slice(randomRequestStart);
    assertDeltaRequests(
      randomPaths,
      randomBefore,
      randomAfter.selectedComponents,
      "Randomize",
    );

    const classic = presets.find(({ id }) => id === "classic");
    assert(classic, "FacesJS budget cannot find the classic B1 face.");
    const configRequestStart = requests.length;
    const configBefore = randomAfter.selectedComponents;
    await page.evaluate((face) => globalThis.__cssFacePreview.setFaceConfig(face), classic.face);
    await settle(page);
    const configAfter = await page.evaluate(() => globalThis.__facesJsPrototype.snapshot());
    const configPaths = requests.slice(configRequestStart);
    assertDeltaRequests(
      configPaths,
      configBefore,
      configAfter.selectedComponents,
      "FaceConfig switch",
    );
    const rotation = await captureFrames(page);
    assert(rotation.runtime.canvases === 0, "FacesJS budget found a Canvas renderer.");
    assert(rotation.runtime.styleWrites > 0,
      "FacesJS budget rotation did not apply prepared lighting/visibility writes.");
    assert(rotation.runtime.publications > 0,
      "FacesJS budget rotation did not publish prepared state transitions.");
    assert(errors.length === 0, `FacesJS budget browser errors:\n${errors.join("\n")}`);
    await context.close();
    return Object.freeze({
      page: Object.freeze({ viewport: VIEWPORT, urlPath: "/" }),
      cold: Object.freeze({
        selectedComponents: initial.selectedComponents,
        transferBytes: coldTransferBytes,
        requests: coldPaths,
      }),
      randomize: Object.freeze({
        before: randomBefore,
        after: randomAfter.selectedComponents,
        requests: randomPaths,
      }),
      configSwitch: Object.freeze({
        before: configBefore,
        after: configAfter.selectedComponents,
        requests: configPaths,
      }),
      rotation,
    });
  } finally {
    await browser?.close();
    await vite.close();
  }
}

function assertWithin(actual, ceiling, label) {
  assert(actual <= ceiling, `${label} ${actual} exceeds ${ceiling}.`);
}

function validateReport(report, contract) {
  assert(contract.schema === "cssface.facesjs-budget-contract@1",
    "FacesJS budget contract schema changed.");
  assert(report.baseline.path === contract.baseline.path,
    "FacesJS budget contract points at a different baseline fixture.");
  assert(report.baseline.sha256 === contract.baseline.sha256,
    "FacesJS B1 baseline changed without a reviewed budget contract.");
  assert(report.baseline.coldTransferBytes === contract.baseline.coldTransferBytes
    && report.baseline.p95FrameMs === contract.baseline.p95FrameMs
    && report.baseline.styleWrites === contract.baseline.styleWrites,
  "FacesJS B1 numeric baseline changed without a reviewed budget contract.");
  assert(report.static.componentCount === contract.quality.supportedComponentIds,
    "FacesJS reusable component coverage changed.");
  assert(report.static.corpusCaseCount === contract.quality.differentialCorpusCases,
    "FacesJS differential corpus coverage changed.");
  assertWithin(report.static.totalBytes, contract.ceilings.catalogOutputBytes,
    "Catalog output bytes");
  assertWithin(
    report.static.largestSelectedCase.selectedBytes,
    contract.ceilings.largestSelectedRuntimeBytes,
    "Largest selected runtime bytes",
  );
  assertWithin(report.browser.cold.transferBytes, contract.ceilings.coldTransferBytes,
    "Cold selected-face transfer");
  assertWithin(report.browser.rotation.runtime.leaves, contract.ceilings.domLeaves,
    "DOM leaves");
  assertWithin(report.browser.rotation.frames.p95Ms, contract.ceilings.p95FrameMs,
    "Rotation p95 frame time");
  assertWithin(report.browser.rotation.runtime.styleWrites, contract.ceilings.styleWrites,
    "Rotation style writes");
  assertWithin(
    report.browser.rotation.runtime.maximumBatch,
    contract.ceilings.maximumStyleWriteBatch,
    "Rotation maximum style-write batch",
  );
  const baselineTransferCeiling = Math.ceil(contract.baseline.coldTransferBytes * 1.1);
  const baselineFrameCeiling = round(contract.baseline.p95FrameMs * 1.1);
  const baselineWriteCeiling = Math.ceil(contract.baseline.styleWrites * 1.1);
  const replacementNeeded = report.browser.cold.transferBytes > baselineTransferCeiling
    || report.browser.rotation.frames.p95Ms > baselineFrameCeiling
    || report.browser.rotation.runtime.styleWrites > baselineWriteCeiling;
  if (replacementNeeded) {
    assert(contract.replacement?.reviewStatus === "burnlist-approved",
      "FacesJS exceeds B1 by more than 10% without a reviewed replacement budget.");
    assert(contract.replacement.qualityGain === "326 source-bound reusable component ids",
      "FacesJS replacement budget does not identify its measurable quality gain.");
  }
}

function assertNegativeControls(report, contract, catalog) {
  const selected = new Set(report.browser.cold.selectedComponents);
  const unselected = catalog.components.map(componentKey).find((key) => !selected.has(key));
  assert(unselected, "FacesJS budget negative control has no unselected component.");
  const [family, sourceId] = unselected.split(":");
  let rejectedUnselected = false;
  try {
    assertSelectedRequests([
      ...report.browser.cold.requests,
      `/facesjs-components/components/${family}/${sourceId}/manifest.json`,
    ], report.browser.cold.selectedComponents, "Injected cold face");
  } catch {
    rejectedUnselected = true;
  }
  assert(rejectedUnselected, "FacesJS budget accepted an injected unselected fetch.");
  let rejectedOverBudget = false;
  try {
    validateReport({
      ...report,
      browser: {
        ...report.browser,
        cold: {
          ...report.browser.cold,
          transferBytes: contract.ceilings.coldTransferBytes + 1,
        },
      },
    }, contract);
  } catch {
    rejectedOverBudget = true;
  }
  assert(rejectedOverBudget, "FacesJS budget accepted an injected over-budget fixture.");
}

const [catalogBytes, corpus, presets, baselineBytes] = await Promise.all([
  readFile(catalogPath),
  readJson(corpusPath),
  readJson(presetsPath),
  readFile(baselinePath),
]);
const catalog = JSON.parse(catalogBytes);
const baseline = JSON.parse(baselineBytes);
const report = Object.freeze({
  schema: "cssface.facesjs-budget-report@1",
  capturedAt: new Date().toISOString(),
  baseline: Object.freeze({
    path: relative(repoRoot, baselinePath),
    sha256: sha256(baselineBytes),
    coldTransferBytes: baseline.browser.network.transferBytes,
    p95FrameMs: baseline.browser.frames.p95Ms,
    styleWrites: baseline.browser.runtime.rotationLightingWrites,
  }),
  static: await staticReport(catalog, corpus),
  browser: await browserReport(corpus, presets),
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

const check = process.argv.includes("--check") || !process.argv.includes("--capture");
if (check) {
  const contract = await readJson(contractPath);
  validateReport(report, contract);
  assertNegativeControls(report, contract, catalog);
  console.log(
    `FacesJS budget check passed: ${report.static.componentCount} reusable ids, `
    + `${report.browser.cold.transferBytes} cold bytes, `
    + `${report.browser.rotation.runtime.leaves} leaves, `
    + `${report.browser.rotation.frames.p95Ms}ms p95, `
    + `${report.browser.rotation.runtime.styleWrites} prepared style writes.`,
  );
} else {
  console.log(`FacesJS budget capture written to ${relative(repoRoot, outputPath)}.`);
}
