import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeClean } from "../plan.mjs";

export async function recoverySuite({
  reopen, fixture, peer, app, peerExited, eventually, w3c, js, click, text, current, replace,
  chooseCommand, openProjectControl, record, recordCase, terminalCheckpoint,
  observeBeforeCrash, openOrbit,
}) {
  const file = path.join(fixture, "cmd/orbit/main.go");
  const original = await readFile(file, "utf8");
  const local = original + "\n// Uncommitted crash recovery marker.\n";
  if (!reopen) {
    await recordCase("draft-crash", "a completed unsaved draft survives abrupt process termination", async () => {
      await openOrbit();
      await replace(local);
      await eventually("the native writer has committed the draft", () => text("#draft-state"), value => /Draft saved/.test(value));
      assert.equal(await readFile(file, "utf8"), original);
      await terminalCheckpoint("crash with completed draft");
      await observeBeforeCrash(app.child.pid);
      process.kill(app.child.pid, "SIGKILL");
      const exit = await Promise.race([app.exited, delay(6000, { timedOut: true }, { ref: false })]);
      assert.equal(exit.signal, "SIGKILL", "the test crashed the app process, not its worker");
      const substitute = `${file}.replacement`;
      await writeFile(substitute, original);
      await rename(substitute, file);
    });
    return;
  }
  if (reopen === "after-quit") {
    await recordCase("draft-retired", "ordinary Discard and Quit retires only that writer's draft", async () => {
      assert.equal((await current()).path ?? null, null);
      await openOrbit();
      await chooseCommand("recover drafts");
      await eventually("only the original crashed writer's draft remains", () => text("#draft-list"), value => /Detached writer/.test(value));
      assert.equal(await js("return document.querySelectorAll('#draft-list .draft-row').length;"), 1);
      await click('[data-dialog-close="draft-dialog"]');
      const moved = `${fixture}-moved`;
      await rename(fixture, moved);
      try {
        await chooseCommand("close project");
        await eventually("a moved project can still be closed", () => js("return !document.querySelector('#project-welcome').hidden;"));
        await chooseCommand("manage recovery drafts");
        await eventually("management lists the old location without opening it", () => text("#draft-list"), value => value.includes(fixture));
        const remove = '#draft-list .draft-row button';
        await click(remove);
        await eventually("removal requires a separate confirmation", () => text(remove), value => value === "Confirm Removal");
        await click(remove);
        await eventually("explicit removal retires the detached snapshot", () => text("#draft-dialog-note"), value => /No detached drafts/.test(value));
      } finally { await rename(moved, fixture); }
      assert.equal(await readFile(file, "utf8"), original);
    });
    return;
  }
  await recordCase("draft-reopened", "recovery after a same-byte replacement retains the original disk expectation", async () => {
    assert.equal((await current()).path ?? null, null);
    assert.equal(await js("return !document.querySelector('#project-welcome').hidden;"), true);
    await openOrbit();
    await chooseCommand("recover drafts");
    await eventually("the detached draft is offered for explicit recovery", () => text("#draft-list"), value => /cmd\/orbit\/main\.go/.test(value));
    await click("#draft-list button");
    await eventually("the recovered content is a dirty editor buffer", current, entry => entry?.text === local && entry.dirty);
    assert.equal(await readFile(file, "utf8"), original);
    await click("#save");
    await eventually("normal Save refuses a replaced baseline even when the bytes match", () => text("#toast"), value => /disk version changed/i.test(value));
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal((await current()).dirty, true);
  });
  await record("a reviewed reload held during retirement preserves the draft if disk changes again", async () => {
    await eventually("the recovered draft copy is published", () => text("#draft-state"), value => /Draft saved/.test(value));
    await click("#compare-disk");
    await eventually("the reviewed reload action is ready", () => js("return document.querySelector('#disk-compare-dialog').open && !document.querySelector('#disk-compare-reload').disabled;"));
    await js("return window.__ironTest.holdSave(true, 'cmd/orbit/main.go').then(() => true);");
    try {
      await click("#disk-compare-reload");
      await eventually("the native reviewed retirement is held", () => js("return window.__ironTest.holdSave();"));
      await writeFile(file, original + "\n// Changed during recovery retirement.\n");
    } finally { await js("return window.__ironTest.holdSave(false).then(() => true);"); }
    await eventually("the reviewed reload reports the changed disk version", () => text("#toast"), value => /Compare again before reloading/.test(value));
    assert.equal((await current()).text, local);
    assert.equal((await current()).dirty, true);
    await chooseCommand("recover drafts");
    await eventually("the active copy's recovery entry remains published", () => text("#draft-list"), value => /Open writer/.test(value));
    await click('[data-dialog-close="draft-dialog"]');
    await writeFile(file, original);
  });
  await recordCase("draft-writer-isolated", "two live workbenches cannot remove an active writer or its newer detached draft", async () => {
    assert.ok(peer && peerExited);
    const request = (endpoint, payload) => w3c(endpoint, payload, undefined, peer.driver);
    await eventually("the second native workbench is ready", () => request("/status"), value => value?.ready);
    const { sessionId } = await request("/session", { capabilities: { alwaysMatch: {} } });
    const fromPeer = (script, ...args) => request(`/session/${sessionId}/execute/sync`, { script, args });
    await eventually("the second workbench has its own native adapter", () => fromPeer("return !!window.__ironTest;"));
    const records = () => js("return window.__ironTest.draftRecords();");
    const previous = new Set((await records()).map(entry => entry.writer));
    await fromPeer("document.querySelector('#welcome-open').click(); return true;");
    await eventually("the second writer opens the same project explicitly", () => fromPeer("return window.__ironTest.snapshot();"), entry => entry?.path === "cmd/orbit/main.go");
    await fromPeer("window.__ironTest.replace(arguments[0]); return true;", original + "\n// Independent writer first draft.\n");
    const captured = await eventually("the first app observes a live independent writer", async () => (await records()).find(entry => !previous.has(entry.writer)),
      entry => entry?.path === "cmd/orbit/main.go" && !entry.detached);
    const tryRemove = entry => js("return window.__ironTest.removeDraftRecord(arguments[0]).then(() => '', error => String(error));", entry);
    assert.match(await tryRemove(captured), /writer is still open/);
    await fromPeer("return window.__ironTest.holdDraftProfile(true).then(() => true);");
    try {
      await js("void window.__ironTest.quitMenu(); return true;");
      await eventually("Quit presents its decision while the second app holds the profile", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
      await click("#quit-discard");
      await eventually("Quit releases the workbench without receiving the profile lock", () => text("#toast"), value => /Recovery storage is busy/.test(value), 3500);
      await eventually("editing thaws before the profile holder releases its lock", () => js("return !document.querySelector('#open-folder').disabled;"));
      assert.equal((await current()).text, local);
    } finally { await fromPeer("return window.__ironTest.holdDraftProfile(false).then(() => true);"); }
    assert.ok((await records()).some(entry => entry.writer === captured.writer));
    await fromPeer("window.__ironTest.replace(arguments[0]); return true;", original + "\n// Independent writer newer draft.\n");
    const newer = await eventually("the live writer publishes its next revision", async () => (await records()).find(entry => entry.writer === captured.writer),
      entry => entry?.revision > captured.revision && !entry.detached);
    const errors = await fromPeer("return window.__ironTestRuntimeErrors();");
    runtimeClean(errors);
    await writeFile(path.join(peer.artifacts, "last-live.json"), JSON.stringify({ runtimeErrors: errors }));
    await observeBeforeCrash(peer.pid);
    process.kill(peer.pid, "SIGKILL");
    const exit = await Promise.race([peerExited, delay(6000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.signal, "SIGKILL");
    await writeFile(path.join(peer.artifacts, "report.json"), JSON.stringify({
      version: 1, group: "recovery", cases: [{ name: "Independent left-behind writer", result: "pass" }],
      terminal: { action: "crash with completed draft", rendererObserved: "through last live checkpoint before requesting exit" },
    }));
    await eventually("the writer is detached after the actual second app exits", async () => (await records()).find(entry => entry.writer === captured.writer), entry => entry?.detached);
    assert.match(await tryRemove(captured), /record changed/);
    assert.equal(await tryRemove(newer), "");
    assert.deepEqual(new Set((await records()).map(entry => entry.writer)), previous);
    assert.equal(await readFile(file, "utf8"), original);
  });
  await recordCase("draft-quit-refused", "refused and expired Quit leave the staged recovery data available", async () => {
    await eventually("a native draft exists before testing Quit", () => text("#draft-state"), value => /Draft saved/.test(value));
    for (const refuse of [true, false]) {
      const before = await js("return window.__ironTest.quitExpiry();");
      await js("return window.__ironTest.draftQuit(true).then(() => true);");
      try {
        await js("void window.__ironTest.quitMenu(); return true;");
        await eventually("Quit presents its ordinary discard choice", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
        await click("#quit-discard");
        await eventually("a draft index is staged before the final Quit decision", () => js("return window.__ironTest.draftQuit();"));
        if (!refuse) await eventually("the real Quit ticket expires while staged", () => js("return window.__ironTest.quitExpiry();"), value => value > before);
      } finally { await js("return window.__ironTest.draftQuit(false, arguments[0]).then(() => true);", refuse); }
      await eventually("the workbench thaws after the unsuccessful Quit", () => js("return !document.querySelector('#open-folder').disabled;"));
      assert.equal((await current()).text, local);
      assert.equal((await current()).dirty, true);
      await chooseCommand("recover drafts");
      await eventually("both published drafts survived the unsuccessful Quit", () => js("return document.querySelectorAll('#draft-list .draft-row').length;"), count => count === 2);
      await click('[data-dialog-close="draft-dialog"]');
    }
  });
  await recordCase("draft-discard-quit", "cancelled project switch retains the draft and ordinary Quit commits its retirement", async () => {
    await eventually("the recovered copy has a separate completed draft", () => text("#draft-state"), value => /Draft saved/.test(value));
    const rootId = await js("return window.__ironTest.workspaceId();");
    await js("return window.__ironTest.cancelNextPicker().then(() => true);");
    await openProjectControl("#open-folder");
    await eventually("the project confirms discard before the picker", () => text("#project-transition-continue"), value => /Discard and Continue/.test(value));
    await click("#project-transition-continue");
    await eventually("the cancelled picker leaves an editable workbench", () => js("return !document.querySelector('#open-folder').disabled;"));
    assert.equal(await js("return window.__ironTest.workspaceId();"), rootId);
    assert.equal((await current()).text, local);
    await chooseCommand("recover drafts");
    await eventually("both the crashed snapshot and its active copy remain", () => js("return document.querySelectorAll('#draft-list .draft-row').length;"), count => count === 2);
    await click('[data-dialog-close="draft-dialog"]');
    await js("void window.__ironTest.quitMenu(); return true;");
    await eventually("ordinary Quit requests a decision for the recovered buffer", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
    await terminalCheckpoint("discard recovery and Quit");
    try { await click("#quit-discard"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const exit = await Promise.race([app.exited, delay(6000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.code, 0);
    assert.equal(await readFile(file, "utf8"), original);
  });
}
