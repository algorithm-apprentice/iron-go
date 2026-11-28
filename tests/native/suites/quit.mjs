import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function nativeSaveQuit({
  fixture, app, eventually, js, click, text, current, replace, output, openProjectControl,
  recordCase, terminalCheckpoint, requestNativeQuit,
}) {
  await recordCase("save-quit", "native Save and Quit preserves the project on partial saves and expired tickets", async () => {
    const source = path.join(fixture, "cmd/orbit/main.go");
    const readme = path.join(fixture, "README.md");
    const original = 'package main\nimport ("fmt"; "os"; "time")\nfunc main(){fmt.Printf("save-quit-child %d\\n",os.Getpid());time.Sleep(time.Minute)}\n';
    await writeFile(source, original);
    await openProjectControl("#welcome-open");
    await eventually("the project and run target are ready", () => js("return document.querySelector('#run-target').value === './cmd/orbit' && !document.querySelector('#run').disabled;"));
    await click("#run");
    const ready = await eventually("the child runs", output, value => /save-quit-child \d+/.test(value), 30_000);
    const pid = Number(ready.match(/save-quit-child (\d+)/)[1]);
    const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
    const mainTab = () => click('#tabs [data-path="cmd/orbit/main.go"]');
    const startQuit = async () => {
      requestNativeQuit();
      await eventually("a live Save and Quit choice opens", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-save').disabled;"));
    };
    const thawed = () => eventually("the same workbench accepts another decision", () => js("return !document.querySelector('#open-folder').disabled;"));
    const first = original + "\n// First commit before conflict\n";
    const diskReadme = await readFile(readme, "utf8");
    await replace(first);
    await click('#explorer [data-path="README.md"]');
    await eventually("README loaded", current, state => state?.path === "README.md");
    const dirtyReadme = diskReadme + "\nUnsaved second tab.\n";
    await replace(dirtyReadme);
    await writeFile(readme, diskReadme + "\nExternal conflict.\n");
    await startQuit();
    await click("#quit-save");
    await eventually("second file reports the save conflict", () => text("#toast"), value => /README\.md.*changed on disk/i.test(value));
    await thawed();
    assert.match(await output(), /Saved: cmd\/orbit\/main\.go/);
    assert.equal(await readFile(source, "utf8"), first);
    assert.equal((await current()).text, dirtyReadme);
    assert.equal(alive(), true);
    await startQuit();
    await click("#quit-cancel");
    await thawed();

    await writeFile(readme, diskReadme);
    const later = first + "// First admitted before expiry\n";
    await mainTab();
    await replace(later);
    await js("window.__batchHoldReady = false; void window.__ironTest.holdSave(true, 'cmd/orbit/main.go').then(() => window.__batchHoldReady = true); return true;");
    await eventually("the native save barrier is armed", () => js("return window.__batchHoldReady;"));
    await js("window.__expiryHoldReady = false; void window.__ironTest.quitDeadline(true).then(() => window.__expiryHoldReady = true); return true;");
    await eventually("the timeout callback is held independently", () => js("return window.__expiryHoldReady;"));
    try {
      const expiry = await js("return window.__ironTest.quitExpiry();");
      await startQuit();
      await click("#quit-save");
      await eventually("first Quit save is admitted and held", () => js(`
        if (!window.__batchAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__batchAtBarrier = waiting);
        return !!window.__batchAtBarrier;
      `));
      const [expired] = await eventually("the pending native ticket reaches its deadline before callback delivery", () => js(`
        void window.__ironTest.quitDeadline().then(value => window.__pendingQuitDeadline = value);
        return window.__pendingQuitDeadline ?? null;
      `), value => value?.[1] === true);
      assert.equal(await js("return window.__ironTest.quitExpiry();"), expiry);
      await js(`window.__expiredSaveAdmission = null;
        void window.__ironTest.attemptQuitSave('README.md', arguments[0], arguments[1], arguments[2]).then(
          () => window.__expiredSaveAdmission = 'unexpected save', error => window.__expiredSaveAdmission = String(error));
        return true;`, diskReadme, dirtyReadme, expired);
      await eventually("the host rejects a queued save with the expired ticket", () => js("return window.__expiredSaveAdmission;"), value => /expired/i.test(value ?? ""));
      await js("void window.__ironTest.quitDeadline(false); return true;");
      await eventually("the timeout event still arrives for the held write", () => js("return window.__ironTest.quitExpiry();"), value => value > expiry);
      assert.equal(await readFile(source, "utf8"), first);
      assert.equal(alive(), true);
    } finally { await js("void window.__ironTest.quitDeadline(false); void window.__ironTest.holdSave(false); return true;"); }
    await thawed();
    assert.equal(await readFile(source, "utf8"), later);
    assert.equal(await readFile(readme, "utf8"), diskReadme);
    assert.equal(alive(), true);
    const final = later + "// Save and Quit completes both files\n";
    await replace(final);
    await startQuit();
    await terminalCheckpoint("dirty Save and Quit");
    try { await click("#quit-save"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const result = await Promise.race([app.exited, delay(6000, { code: null, timedOut: true }, { ref: false })]);
    assert.equal(result.code, 0, "Save and Quit must exit normally");
    assert.equal(await readFile(source, "utf8"), final);
    assert.equal(await readFile(readme, "utf8"), dirtyReadme);
    await eventually("successful native Quit stops the Go child", () => !alive());
  });
}

export async function nativeQuitSmoke({
  driver, artifacts, fixture, app, eventually, js, click, current, replace, output,
  openProjectControl, recordCase, terminalCheckpoint, requestNativeQuit,
}) {
  await recordCase("dirty-quit", "native Quit asks before discarding a dirty Go buffer", async () => {
    const source = path.join(fixture, "cmd/orbit/main.go");
    await writeFile(source, 'package main\nimport ("fmt"; "os"; "time")\nfunc main(){fmt.Printf("quit-child-ready %d\\n",os.Getpid());time.Sleep(time.Minute)}\n');
    await openProjectControl("#welcome-open");
    const initial = await eventually("disposable project open", current, state => state?.path === "cmd/orbit/main.go");
    await eventually("Go target ready", () => js("return document.querySelector('#run-target').value === './cmd/orbit' && !document.querySelector('#run').disabled;"));
    await click("#run");
    const ready = await eventually("fixture child is running", output, value => /quit-child-ready \d+/.test(value), 30_000);
    const pid = Number(ready.match(/quit-child-ready (\d+)/)[1]);
    const saved = `${initial.text}\n// saved after the held IPC\n`;
    const unsaved = `${saved}\n// unsaved native quit\n`;
    const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
    async function cancelled(label) {
      await Promise.race([
        eventually(`${label}: display the real confirmation`, () => js("return document.querySelector('#quit-dialog')?.open === true;")),
        app.exited.then(() => { throw new Error(`${label}: exited before confirming the unsaved buffer.`); }),
      ]);
      await js("window.__ironTest.tryType('unexpected edit'); return true;");
      assert.equal((await current()).text, unsaved, `${label}: the pending decision must prevent typing`);
      await click("#quit-cancel");
      await eventually(`${label}: editing re-enabled`, () => js("return !document.querySelector('#open-folder').disabled;"));
      const state = await current();
      assert.equal(state.text, unsaved);
      assert.equal(state.dirty, true);
      assert.equal(await readFile(source, "utf8"), saved);
      assert.equal(alive(), true, `${label}: cancelling must not stop the Go child`);
      console.log(`    ${label}: Cancel preserved the buffer and child`);
    }
    // The parent owns failure cleanup, even if this worker never returns.
    {
      await js("window.__saveHoldReady = false; void window.__ironTest.holdSave(true).then(() => window.__saveHoldReady = true); return true;");
      await eventually("native save barrier armed", () => js("return window.__saveHoldReady;"));
      await replace(saved);
      await click("#save");
      await eventually("save_file IPC has reached its native barrier", () => js(`
        if (!window.__saveAtBarrier) void window.__ironTest.holdSave().then(waiting => window.__saveAtBarrier = waiting);
        return window.__saveAtBarrier === true && window.__ironTest.saving();
      `));
      const beforeSaveQuit = await js("return window.__ironTest.quitRequests();");
      requestNativeQuit();
      await Promise.race([
        eventually("Quit reaches the workbench during a held save", () => js("return window.__ironTest.quitRequests();"), count => count === beforeSaveQuit + 1),
        app.exited.then(() => { throw new Error("An in-flight save must veto application exit."); }),
      ]);
      assert.equal(await js("return document.querySelector('#quit-dialog').open;"), false);
      assert.equal(await js("return window.__ironTest.saving();"), true);
      assert.equal(await readFile(source, "utf8"), initial.text);
      await js("void window.__ironTest.holdSave(false); return true;");
      await eventually("held save completes after Quit was refused", current, state => state?.text === saved && !state.dirty);
      assert.equal(await readFile(source, "utf8"), saved);
      console.log("    Quit during the held native save was refused");

      await replace(unsaved);
      await eventually("buffer is dirty", current, state => state?.dirty);
      requestNativeQuit();
      await cancelled("System Quit");

      const readMinimizedQuit = () => js(`
        return { menu: window.__menuQuit, requests: window.__ironTest.quitRequests(),
          window: window.__nativeWindowState, dialog: document.querySelector('#quit-dialog').open,
          ready: !document.querySelector('#quit-discard').disabled };
      `);
      const observeWindow = () => js(`
        void window.__ironTest.quitWindowState().then(state => window.__nativeWindowState = state);
        return true;
      `);
      await js("window.__nativeWindowState = null; void window.__ironTest.quitWindowState(true); return true;");
      const minimized = await eventually("AppKit minimized the dirty window", async () => {
        await observeWindow();
        return readMinimizedQuit();
      }, result => result?.window?.[0] === true && result.window[1] === false);
      let restored;
      try {
        await js("window.__menuQuit = null; void window.__ironTest.quitMenu().then(found => window.__menuQuit = found).catch(error => window.__menuQuit = String(error)); return true;");
        restored = await eventually("Quit menu restores the minimized window with a usable confirmation", async () => {
          await observeWindow();
          return readMinimizedQuit();
        }, result => result?.menu === true && result.requests === minimized.requests + 1 &&
          result.window?.[0] === false && result.window[1] === true && result.dialog && result.ready);
        await cancelled("Quit menu with minimized window");
      } finally {
        const last = await readMinimizedQuit().catch(error => ({ error: String(error) }));
        await writeFile(path.join(artifacts, "minimized-quit.json"), JSON.stringify({ minimized, restored, last }, null, 2));
      }

      await js("window.__menuQuit = null; void window.__ironTest.quitMenu().then(found => window.__menuQuit = found).catch(error => window.__menuQuit = String(error)); return true;");
      await eventually("default AppKit Quit menu action invoked", () => js("return { result: window.__menuQuit, requests: window.__ironTest.quitRequests(), dialog: document.querySelector('#quit-dialog').open };"), state => state?.result === true);
      await cancelled("Quit menu");

      await js("void window.__ironTest.closeWindow(); return true;");
      await cancelled("Native window close");

      requestNativeQuit();
      await eventually("unanswered Quit dialog is usable", () => js(`
        return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;
      `));
      await eventually("the real timeout dismisses the dialog and restores editing", () => js("return !document.querySelector('#quit-dialog').open && !document.querySelector('#open-folder').disabled;"));
      assert.equal((await current()).text, unsaved);
      assert.equal(alive(), true, "expiry leaves the Go process alone");
      requestNativeQuit();
      await cancelled("Retry after missing reply");

      requestNativeQuit();
      await eventually("Discard is available", () => js("return document.querySelector('#quit-dialog').open && !document.querySelector('#quit-discard').disabled;"));
      await terminalCheckpoint("dirty Discard");
      try { await click("#quit-discard"); }
      catch (error) {
        // A successful Discard can exit before the embedded driver sends
        // the HTTP acknowledgement. Only allow that transport shutdown
        // here, and still require the real child process to exit with 0.
        if (error.cause?.code !== "UND_ERR_SOCKET") throw error;
      }
      const result = await Promise.race([app.exited, delay(6000, { code: null, timedOut: true }, { ref: false })]);
      assert.equal(result.code, 0, "approving Discard should exit normally");
      assert.equal(await readFile(source, "utf8"), saved);
      await eventually("approved exit stops the Go child", () => !alive());
    }
  });
}
