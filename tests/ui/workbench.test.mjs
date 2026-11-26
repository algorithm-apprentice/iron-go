import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

let server, browser, url;
before(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  url = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page;
  const logs = [];
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    page = await context.newPage();
    page.on("pageerror", error => logs.push(error.stack));
    page.on("console", message => { if (message.type() === "error") logs.push(message.text()); });
    await page.goto(url);
    await page.getByRole("tab", { name: "main.go", exact: true }).waitFor({ timeout: 8000 });
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

test("sample uses the real workbench, tree and quick open", async () => {
  await scenario("navigation", async page => {
    assert.equal(await page.locator(".titlebar #quick-open").count(), 1);
    assert.equal(await page.locator(".editor-actions #run").count(), 1, "Run belongs to the editor group");
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

test("sample edit becomes dirty, saves, and is searchable after a reload", async () => {
  await scenario("edit-save-search", async page => {
    await page.locator('#explorer [data-path="README.md"]').click();
    await page.getByRole("tab", { name: "README.md", exact: true, selected: true }).waitFor();
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("agent-note-417 ");
    await page.locator('.tab.dirty [data-path="README.md"]').waitFor();
    await page.getByRole("button", { name: "Save File" }).click();
    await page.locator('.tab.dirty [data-path="README.md"]').waitFor({ state: "detached" });
    await page.reload();
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

test("VS Code themes switch the entire workbench and persist without dropping edits", async () => {
  await scenario("color-themes", async page => {
    const backgrounds = () => page.evaluate(() => [".monaco-editor-background", ".sidebar", ".bottom-panel"].map(selector =>
      getComputedStyle(document.querySelector(selector)).backgroundColor,
    ));
    const dark = ["rgb(18, 19, 20)", "rgb(25, 26, 27)", "rgb(25, 26, 27)"];
    const light = ["rgb(255, 255, 255)", "rgb(250, 250, 253)", "rgb(250, 250, 253)"];
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const theme = page.getByRole("combobox", { name: "Color Theme" });
    await theme.waitFor({ timeout: 3000 });
    assert.deepEqual(await backgrounds(), dark);
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator("#editor textarea.inputarea").focus();
    await page.keyboard.insertText("// Unsaved theme check");
    await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await theme.selectOption({ label: "VS Code Light" });
    await page.getByRole("button", { name: "Close settings" }).click();
    assert.deepEqual(await backgrounds(), light);
    assert.match(await page.locator("#editor .view-lines").innerText(), /Unsaved\s+theme\s+check/);
    assert.equal(await page.locator('.tab.dirty [data-path="cmd/orbit/main.go"]').count(), 1);
    await page.getByRole("button", { name: "Save File" }).click();
    await page.locator(".tab.dirty").waitFor({ state: "detached" });
    await page.reload();
    await page.getByRole("tab", { name: "main.go", selected: true }).waitFor();
    assert.deepEqual(await backgrounds(), light);
    await page.locator("#quick-open").click();
    const palette = page.getByRole("textbox", { name: "Quick Open search" });
    await palette.fill(">color theme dark");
    await palette.press("Enter");
    assert.deepEqual(await backgrounds(), dark);
  });
});
