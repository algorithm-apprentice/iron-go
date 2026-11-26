import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

let server, browser, url, assets;
const fixture = fileURLToPath(new URL("../fixtures/orbit", import.meta.url));
before(async () => {
  assets = await mkdtemp(join(tmpdir(), "iron-go-ui-"));
  await build({ build: { outDir: assets, emptyOutDir: true }, logLevel: "warn" });
  server = await preview({ build: { outDir: assets }, preview: { port: 0, host: "127.0.0.1" } });
  url = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  if (assets) await rm(assets, { recursive: true, force: true });
});

async function openFixture(page) {
  await page.locator("#import-folder").setInputFiles(fixture);
  await page.getByRole("tab", { name: "main.go", exact: true, selected: true }).waitFor({ timeout: 8000 });
}

async function scenario(name, run, withProject = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page;
  const logs = [];
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    page = await context.newPage();
    page.on("pageerror", error => logs.push(error.stack));
    page.on("console", message => { if (message.type() === "error") logs.push(message.text()); });
    await page.goto(url);
    await page.locator("#project-welcome").waitFor({ timeout: 8000 });
    if (withProject) await openFixture(page);
    await run(page);
    assert.deepEqual(logs, []);
  } catch (error) {
    const dir = `test-results/ui/${name}`;
    await mkdir(dir, { recursive: true });
    await page?.screenshot({ path: `${dir}/workbench.png`, timeout: 3000 }).catch(() => {});
    await context.tracing.stop({ path: `${dir}/trace.zip` });
    await writeFile(`${dir}/browser.log`, logs.join("\n"));
    throw error;
  } finally {
    await context.close();
  }
}

test("an imported test fixture uses the real workbench and quick open", async () => {
  await scenario("navigation", async page => {
    assert.equal(await page.locator(".titlebar #quick-open").count(), 1);
    assert.equal(await page.locator(".editor-actions #run").count(), 1, "Run belongs to the editor group");
    assert.equal(await page.getByRole("combobox", { name: "Run target" }).isDisabled(), true, "The preview does not discover local targets");
    assert.equal(await page.locator(".titlebar img").count(), 0);
    assert.deepEqual(await page.locator(".panel-tabs [data-panel]").evaluateAll(tabs => tabs.map(tab => tab.dataset.panel)), ["problems", "output"]);
    const sidebar = page.getByRole("button", { name: "Toggle Side Bar", exact: true });
    await sidebar.click();
    await page.locator("#sidebar").waitFor({ state: "hidden" });
    await sidebar.click();
    await page.locator("#sidebar").waitFor({ state: "visible" });
    assert.equal(await page.locator("#module-name").innerText(), "example.com/orbit");
    assert.equal(await page.locator("#tool-version").innerText(), "Preview");
    await page.locator("#quick-open").click();
    const input = page.getByRole("textbox", { name: "Quick Open search" });
    await input.fill("report_test");
    await input.press("Enter");
    await page.getByRole("tab", { name: "report_test.go", exact: true, selected: true }).waitFor();
    assert.deepEqual(await page.locator("#breadcrumbs .crumb").allTextContents(), ["internal", "status", "report_test.go"]);
    await page.getByRole("button", { name: "Toggle Bottom Panel" }).click();
    await page.locator("#panel").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Show Problems" }).click();
    await page.getByRole("tab", { name: /Problems/, selected: true }).waitFor();
  });
});

test("an imported file becomes dirty, saves in memory, and is searchable", async () => {
  await scenario("edit-save-search", async page => {
    await page.locator('#explorer [data-path="README.md"]').click();
    await page.getByRole("tab", { name: "README.md", exact: true, selected: true }).waitFor();
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("agent-note-417 ");
    await page.locator('.tab.dirty [data-path="README.md"]').waitFor();
    await page.getByRole("button", { name: "Save File" }).click();
    await page.locator('.tab.dirty [data-path="README.md"]').waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("textbox", { name: "Search saved files" }).fill("agent-note-417");
    await page.locator('#search-results [data-path="README.md"]').waitFor();
    await page.locator('#search-results [data-path="README.md"]').click();
    await page.getByRole("tab", { name: "README.md", exact: true, selected: true }).waitFor();
  });
});

test("creates a nested file, rejects duplicates, and does not fake native tasks", async () => {
  await scenario("create-and-preview", async page => {
    const create = async () => {
      await page.getByRole("button", { name: "New File", exact: true }).click();
      await page.getByRole("textbox", { name: "Relative file path" }).fill("pkg/extra.go");
      await page.getByRole("button", { name: "Create", exact: true }).click();
    };
    await create();
    await page.getByRole("tab", { name: "extra.go", exact: true, selected: true }).waitFor();
    await create();
    assert.match(await page.locator("#form-error").innerText(), /already exists/i);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#run").click();
    assert.match(await page.locator("#toast").innerText(), /desktop app/i);
  });
});

test("Dark and Light switch the entire workbench and persist without dropping edits", async () => {
  await scenario("color-themes", async page => {
    const backgrounds = () => page.evaluate(() => [".monaco-editor-background", ".sidebar", ".bottom-panel"].map(selector =>
      getComputedStyle(document.querySelector(selector)).backgroundColor,
    ));
    const dark = ["rgb(18, 19, 20)", "rgb(25, 26, 27)", "rgb(25, 26, 27)"];
    const light = ["rgb(255, 255, 255)", "rgb(250, 250, 253)", "rgb(250, 250, 253)"];
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const theme = page.getByRole("combobox", { name: "Color Theme" });
    await theme.waitFor({ timeout: 3000 });
    assert.deepEqual(await theme.locator("option").allTextContents(), ["Dark", "Light"]);
    assert.deepEqual(await backgrounds(), dark);
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("// Unsaved theme check");
    await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await theme.selectOption({ label: "Light" });
    await page.getByRole("button", { name: "Close settings" }).click();
    assert.deepEqual(await backgrounds(), light);
    assert.match(await page.locator("#editor .view-lines").innerText(), /Unsaved\s+theme\s+check/);
    assert.equal(await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').count(), 1);
    await page.getByRole("button", { name: "Save File" }).click();
    await page.locator(".tab.dirty").waitFor({ state: "detached" });
    await page.reload();
    await page.locator("#project-welcome").waitFor();
    await openFixture(page);
    assert.deepEqual(await backgrounds(), light);
    await page.locator("#quick-open").click();
    const palette = page.getByRole("textbox", { name: "Quick Open search" });
    await palette.fill(">color theme dark");
    await page.getByRole("button", { name: "Color Theme: Dark", exact: true }).waitFor({ timeout: 3000 });
    await palette.press("Enter");
    assert.deepEqual(await backgrounds(), dark);
  });
});

test("the browser also starts at welcome without an Orbit project", async () => {
  await scenario("empty-welcome", async page => {
    assert.equal(await page.locator("#tabs [role=tab]").count(), 0);
    assert.equal(await page.locator("#run").isDisabled(), true);
    assert.equal(await page.locator("#editor-toolbar").isHidden(), true);
    assert.equal(await page.getByRole("button", { name: "Search commands", exact: true }).count(), 1);
    const welcome = await page.locator("#project-welcome").innerText();
    assert.match(welcome, /Open Project/);
    assert.match(welcome, /New Project/);
    assert.doesNotMatch(welcome, /Orbit/);
    await page.waitForFunction(() => document.querySelector("#project-welcome img")?.naturalWidth === 128);
    assert.match(await page.locator("#project-welcome img").evaluate(image => getComputedStyle(image).filter), /grayscale\(1\)/);
  }, false);
});

test("adjacent workbench controls and visible dividers use a one-pixel gap", async () => {
  await scenario("dense-controls", async page => {
    const check = async (group, vertical = false, selector = "button, select, input") => {
      const gaps = await page.locator(group).evaluate((element, { vertical, selector }) => {
        const bounds = [...element.children].filter(child => child.matches(selector) && child.getClientRects().length)
          .map(child => child.getBoundingClientRect());
        return bounds.slice(1).map((current, index) => vertical ? current.top - bounds[index].bottom : current.left - bounds[index].right);
      }, { vertical, selector });
      assert.ok(gaps.length, `${group} should have adjacent controls`);
      for (const gap of gaps) assert.ok(Math.abs(gap - 1) < 0.1, `${group} gap: expected 1px, got ${gap}px`);
    };
    const horizontalGroups = [".title-actions", ".editor-actions", ".panel-tabs", ".panel-actions", "#explorer-view .inline-actions"];
    for (const group of horizontalGroups) await check(group);
    await page.locator('#explorer [data-path="go.mod"]').click();
    await page.getByRole("tab", { name: "go.mod", selected: true }).waitFor();
    await check("#tabs", false, ".tab");
    await check("#explorer .tree-list", true);
    assert.equal((await page.locator("#sidebar-resize").boundingBox()).width, 1);
    assert.equal((await page.locator("#panel-resize").boundingBox()).height, 1);
    await page.getByRole("button", { name: "Run and Test", exact: true }).click();
    await check(".task-actions", true);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await check(".search-field");
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByRole("button", { name: "New File", exact: true }).click();
    await check(".dialog-actions");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 650, height: 560 });
    for (const group of horizontalGroups) await check(group);
    assert.equal((await page.locator("#sidebar-resize").boundingBox()).width, 1);
  });
});

test("the app title bar stays 36 pixels at normal and compact widths", async () => {
  await scenario("titlebar-height", async page => {
    for (const width of [1440, 650]) {
      await page.setViewportSize({ width, height: 750 });
      const bounds = await page.locator(".titlebar").boundingBox();
      assert.equal(bounds.height, 36);
      assert.doesNotMatch(await page.locator(".titlebar").innerText(), /Iron\s*Go/);
      assert.equal(await page.locator(".titlebar .title-actions #toggle-panel").count(), 1);
      const command = await page.locator("#quick-open").boundingBox();
      assert.ok(command.y >= bounds.y && command.y + command.height <= bounds.y + bounds.height);
      assert.ok(Math.abs((command.x + command.width / 2) - (bounds.x + bounds.width / 2)) < 1);
    }
  });
});
