import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function debugSuite({
  fixture, home, app, eventually, js, click, text, set, current, output, chooseCommand,
  openProjectControl, prepareKeyboardCommand, enterKeyboardCommand, clickCodeLens,
  placeBreakpoint, clickGlyphBreakpoint, record, terminalCheckpoint, probeTools, openOrbit,
  holdConfiguredBuild, openTestFile,
}) {
  await probeTools({ gopls: true, delve: true });
  await openOrbit();
  await openTestFile();
      await record("Debug Test at Cursor pauses at a real breakpoint and continues the test", async () => {
        await clickGlyphBreakpoint(9);
        await eventually("gopls ready for caret test", current, state => state?.gopls === "ready", 30_000);
        await js("window.__ironTest.revealLine(9); return true;");
        await prepareKeyboardCommand("debug test at cursor");
        await enterKeyboardCommand();
        await eventually("debuggee stops on line 9", () => text("#status"), value => /Breakpoint hit.*report_test\.go:9/.test(value), 60_000);
        await click("#debug-next");
        await eventually("stepped to the next source line", () => text("#status"), value => /Paused.*report_test\.go:(10|11)/.test(value), 15_000);
        await click("#debug-continue");
        await eventually("debug test finished", () => text("#status"), value => /Debug session finished/i.test(value), 15_000);
      });
      await record("Delve Stop and project switch retire a paused session and admit a fresh one", async () => {
        const reportTest = path.join(fixture, "internal/status/report_test.go");
        const marker = path.join(home, "test-inferior.pid");
        await js("window.__ironTest.revealLine(9); document.dispatchEvent(new KeyboardEvent('keydown', {key:'F9', bubbles:true,cancelable:true})); return true;");
        await eventually("the first scenario's breakpoint is cleared", () => js("return !document.querySelector('#editor .debug-breakpoint');"));
        await writeFile(reportTest, (await readFile(reportTest, "utf8"))
          .replace('"testing"', '"testing"; "os"; "strconv"')
          .replace("func TestSummary(t *testing.T) {", `func TestSummary(t *testing.T) {\n\tif err := os.WriteFile(${JSON.stringify(marker)}, []byte(strconv.Itoa(os.Getpid())), 0600); err != nil { t.Fatal(err) }`));
        await eventually("the active test model contains the disposable PID probe", current, entry => entry?.text.includes("os.Getpid()"));
        await placeBreakpoint(10);
        const paused = async () => {
          await writeFile(marker, "");
          await clickCodeLens("Debug TestSummary");
          await eventually("Delve paused after recording the inferior PID", () => text("#status"), value => /Breakpoint hit.*report_test\.go:10/.test(value), 60_000);
          const inferior = await eventually("real test executable reports its PID", async () => Number(await readFile(marker, "utf8")), pid => Number.isInteger(pid) && pid > 0);
          process.kill(inferior, 0);
          const adapter = await eventually("owned Delve child", () => {
            const processes = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
            for (const row of processes.split("\n")) {
              const entry = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
              if (entry && Number(entry[2]) === app.child.pid && path.basename(entry[3]) === "dlv") return Number(entry[1]);
            }
          });
          return { adapter, inferior };
        };
        const gone = (label, pid) => eventually(label, () => {
          try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
        });

        const holdScopes = () => js("window.__ironTest.holdDebugScopes(); return true;");
        const scopesAreHeld = () => eventually("the real scopes response is held", () => js("return window.__ironTest.debugScopesHeld();"));
        const releaseScopes = () => js("window.__ironTest.releaseDebugScopes(); return true;");
        await holdScopes();
        try {
          const stopped = await paused();
          await scopesAreHeld();
          await click("#debug-stop");
          await eventually("Debug Stop clears controls and inspection", () => js("return document.querySelector('#debug-controls').hidden && document.querySelector('#debug-tab').hidden && !document.querySelector('#run').disabled;"));
          await gone("Debug Stop reaps Delve", stopped.adapter);
          await gone("Debug Stop reaps the actual test executable", stopped.inferior);
        } finally { await releaseScopes(); }

        await holdScopes();
        try {
          const switched = await paused();
          await scopesAreHeld();
          await openProjectControl("#open-folder");
          await eventually("switch confirms active debug session", () => js("return document.querySelector('#project-transition-dialog').open;"));
          assert.match(await text("#project-transition-description"), /debug session will be stopped/i);
          await click("#project-transition-continue");
          await eventually("replacement workspace resets debug and the active tab", current, state => state?.path === "cmd/orbit/main.go");
          await eventually("switch clears debug controls and starts gopls", async () => ({ native: await current(), hidden: await js("return document.querySelector('#debug-controls').hidden && document.querySelector('#debug-tab').hidden;") }), state => state.native?.gopls === "ready" && state.hidden);
          await gone("workspace switch reaps Delve", switched.adapter);
          await gone("workspace switch reaps the actual test executable", switched.inferior);
        } finally { await releaseScopes(); }

        await click("#quick-open");
        await set("#palette-text", "report_test.go");
        await click("#palette-options button");
        await eventually("new session test file", current, state => state?.path === "internal/status/report_test.go");
        await placeBreakpoint(10);
        const replacement = await paused();
        await click("#debug-stop");
        await eventually("replacement Debug Stop clears controls", () => js("return document.querySelector('#debug-controls').hidden && !document.querySelector('#run').disabled;"));
        await gone("replacement Delve is reaped", replacement.adapter);
        await gone("replacement test executable is reaped", replacement.inferior);
       });
  await record("inspects a real paused stack and local variables and steps into and out of a call", async () => {
    const relative = "internal/status/inspect_test.go";
    const source = `package status

import "testing"

type inspectionData struct { Label string }

func TestInspection(t *testing.T) {
	if inspectLocals() != 42 { t.Fatal("unexpected result") }
}

func inspectLocals() int {
	number := 41
	probe := inspectionData{Label: "orbit"}
	result := inspectionCall(number, probe)
	return result
}

func inspectionCall(number int, probe inspectionData) int {
	return number + len(probe.Label) - 4
}
`;
    await writeFile(path.join(fixture, relative), source);
    await eventually("the inspection fixture is indexed", () => js("return !!document.querySelector('#explorer [data-path=\"internal/status/inspect_test.go\"]');"));
    await click('#explorer [data-path="internal/status/inspect_test.go"]');
    await eventually("the inspection fixture is active", current, entry => entry?.path === relative);
    await clickGlyphBreakpoint(14);
    await clickCodeLens("Debug TestInspection");
    await eventually("the debuggee stops before the nested call", () => text("#status"), value => /Breakpoint hit.*inspect_test\.go:14/.test(value), 60_000);
    await eventually("the selected frame and its caller are visible", () => text("#debug-stack"), value => /inspectLocals[\s\S]*TestInspection/.test(value));
    const frame = name => js(`const button = [...document.querySelectorAll('#debug-stack button')]
      .find(button => button.textContent.includes(arguments[0])); if (!button) return false; button.focus(); button.click(); return true;`, name);
    const selected = () => text('#debug-stack [aria-pressed="true"]');
    const highlight = line => eventually(`line ${line} is highlighted`, () => js(`
      const decorated = window.__ironTest.debugExecutionLines();
      return decorated.length === 1 && decorated[0] === arguments[0] && window.__ironTest.gutterTrace().caret?.lineNumber === arguments[0];`, line));
    await highlight(14);
    assert.match(await selected(), /inspectLocals/);
    assert.equal(await frame("testing.tRunner"), true);
    await eventually("unavailable external frame stays selected", () => text("#status"), value => /source unavailable/.test(value));
    assert.match(await selected(), /testing\.tRunner/);
    assert.equal(await frame("TestInspection"), true);
    await eventually("the caller frame is selected and revealed", () => text("#status"), value => /inspect_test\.go:8/.test(value));
    await highlight(8);
    assert.equal(await js("return document.activeElement === document.querySelector('#debug-stack [aria-pressed=true]');"), true);
    assert.equal(await frame("inspectLocals"), true);
    await eventually("the original selected frame returns", () => text("#status"), value => /inspect_test\.go:14/.test(value));
    const expand = name => js(`const disclosure = [...document.querySelectorAll('#debug-variables summary')]
      .find(summary => summary.textContent.includes(arguments[0])); if (!disclosure) return false;
      if (!disclosure.parentElement.open) disclosure.click(); return true;`, name);
    await eventually("the selected frame has a Locals scope", () => expand("Locals"));
    await eventually("the scalar local is shown", () => text("#debug-variables"), value => /number[\s\S]*41/.test(value));
    await eventually("the struct can be expanded", () => expand("probe"));
    await eventually("the struct field is shown", () => text("#debug-variables"), value => /Label[\s\S]*orbit/.test(value));
    await click("#debug-step-in");
    const steppedIn = await eventually("Step Into enters the nested call", () => text("#status"), value => /inspect_test\.go:(18|19)/.test(value), 15_000);
    await highlight(Number(steppedIn.split(":").at(-1)));
    assert.match(await selected(), /inspectionCall/);
    await click("#debug-step-out");
    const steppedOut = await eventually("Step Out returns to the caller", () => text("#status"), value => /inspect_test\.go:(14|15)/.test(value), 15_000);
    await highlight(Number(steppedOut.split(":").at(-1)));
    assert.match(await selected(), /inspectLocals/);
    await click("#debug-continue");
    await eventually("the debug test finishes and clears inspection", async () => [await text("#status"), await text("#debug-stack")],
      ([status, stack]) => /Debug session finished/i.test(status) && !stack.trim(), 15_000);
  });
  await record("Debug Go Program uses the selected preset without changing its build context", async () => {
    const program = path.join(fixture, "debug-program");
    const runtime = path.join(fixture, "debug-runtime");
    await Promise.all([mkdir(program), mkdir(runtime)]);
    await writeFile(path.join(fixture, "go.work"), "go 1.22\n\nuse (\n\t.\n\t./debug-program\n)\n");
    await writeFile(path.join(program, "go.mod"), "module example.test/debug-program\n\ngo 1.22\n");
    await writeFile(path.join(program, "main.go"), `package main

import ("encoding/json"; "fmt"; "os"; "os/exec"; "time")

func main() {
	cwd, _ := os.Getwd()
	if err := os.WriteFile("program.marker", []byte(cwd), 0600); err != nil { panic(err) }
	context := map[string]any{"cwd": cwd, "args": append([]string{}, os.Args[1:]...), "gowork": os.Getenv("GOWORK"), "preset": os.Getenv("DEBUG_PRESET"), "pid": os.Getpid()}
	if os.Getenv("DEBUG_PRESET") == "child" {
		child := exec.Command("/bin/sleep", "60")
		if err := child.Start(); err != nil { panic(err) }
		context["child"] = child.Process.Pid
		_ = child.Process.Release()
	}
	encoded, _ := json.Marshal(context)
	fmt.Printf("program-context %s\\n", encoded)
	if os.Getenv("DEBUG_PRESET") == "hold" { time.Sleep(time.Minute) }
}
`);
    await openProjectControl("#open-folder");
    await eventually("the nested executable is discovered", () => js("return Array.from(document.querySelector('#run-target').options, option => option.value);"), targets => targets.includes("./debug-program"));
    await click('[data-view="tasks"]');
    await click("#run-configurations");
    await set("#run-config-name", "Debug context fixture");
    await set("#run-config-package", "./debug-program");
    await set("#run-config-directory", "debug-runtime");
    const args = ["", "two words", "-literal"];
    await set("#run-config-arguments", JSON.stringify(args));
    await set("#run-config-session", "GOWORK=invalid-for-build\nDEBUG_PRESET=session-only");
    await click("#run-config-save");
    await eventually("the same preset is selected for Run and Debug", () => js("return document.querySelector('#run-target').selectedOptions[0]?.textContent;"), value => value?.includes("Debug context fixture"));
    assert.notEqual((await current()).path, "debug-program/main.go");
    const marker = path.join(runtime, "program.marker");
    const programContext = async () => JSON.parse((await eventually("the real Go program reports its context", output,
      value => /program-context \{[^\n]+\}/.test(value), 60_000)).match(/program-context (\{[^\n]+\})/)[1]);
    await click("#run");
    const { pid: runPid, ...runContext } = await programContext();
    assert.ok(runPid > 0);
    assert.deepEqual(runContext, { cwd: runtime, args, gowork: "invalid-for-build", preset: "session-only" });
    await eventually("Run releases its execution slot", () => text("#status"), value => /exit code 0/.test(value));
    await rename(marker, path.join(home, "run.marker"));
    await click("#quick-open");
    await set("#palette-text", "debug-program/main.go");
    await click("#palette-options button");
    await eventually("the executable source is active", current, entry => entry?.path === "debug-program/main.go");
    await placeBreakpoint(7);
    await click('#tabs [data-path="cmd/orbit/main.go"]');
    await eventually("a different source remains active before launch", current, entry => entry?.path === "cmd/orbit/main.go");
    await click("#quick-open");
    await set("#palette-text", ">debug go program");
    await eventually("the executable Debug Go Program command exists", () => text("#palette-options"), value => /Debug Go Program/.test(value));
    await js("document.querySelector('#palette').close(); return true;");
    const launchDebug = () => chooseCommand("debug go program");
    const releaseHandoff = () => js("void window.__ironTest.runHandoff(false); return true;");
    const removed = directory => eventually("the private debug directory is gone", async () => {
      try { await stat(directory); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; }
    });
    const gone = (label, pid) => eventually(label, () => {
      try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    });
    const held = await holdConfiguredBuild(launchDebug);
    await releaseHandoff();
    await eventually("the selected package hits its real breakpoint", () => text("#status"), value => /Breakpoint hit.*main\.go:7/.test(value), 30_000);
    assert.equal((await current()).path, "debug-program/main.go");
    await eventually("the executable frame is selected", () => text('#debug-stack [aria-pressed="true"]'), value => /main\.main/.test(value));
    await eventually("the program frame's locals are available", () => js(`const locals = [...document.querySelectorAll('#debug-variables summary')]
      .find(node => node.textContent === 'Locals'); if (!locals) return false; if (!locals.parentElement.open) locals.click(); return true;`));
    await eventually("the stopped executable exposes its actual cwd", () => text("#debug-variables"), value => value.includes(`cwd: "${runtime}"`));
    await click("#debug-continue");
    const { pid: debugPid, ...debugContext } = await programContext();
    assert.ok(debugPid > 0 && debugPid !== runPid);
    assert.deepEqual(debugContext, runContext);
    assert.equal(await readFile(marker, "utf8"), runtime);
    await eventually("Debug releases its execution slot", () => text("#status"), value => /Debug session finished/i.test(value));
    await removed(held);
    await gone("the normally finished debuggee is gone", debugPid);
    await rename(marker, path.join(home, "debug.marker"));

    const sourcePath = path.join(program, "main.go");
    const validSource = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, validSource + "\nGo build must fail here\n");
    try {
      await launchDebug();
      await eventually("a compile failure returns the Go lane", () => text("#status"), value => /Debug failed.*Go build/.test(value));
      assert.match(await output(), /syntax error|non-declaration statement/);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally { await writeFile(sourcePath, validSource); }

    try {
      const cancelled = await holdConfiguredBuild(launchDebug);
      await click("#debug-stop");
      await eventually("Stop cancels the build handoff", () => text("#status"), value => /Debug session stopped/.test(value));
      await removed(cancelled);
      await assert.rejects(stat(marker), { code: "ENOENT" });

      const stale = await holdConfiguredBuild(launchDebug);
      const backup = `${runtime}-original`;
      await rename(runtime, backup);
      await mkdir(runtime);
      try {
        await releaseHandoff();
        await eventually("an inode replacement refuses launch", () => text("#status"), value => /working directory was replaced/.test(value));
        await removed(stale);
        await assert.rejects(stat(marker), { code: "ENOENT" });
      } finally {
        await rename(runtime, `${runtime}-replacement`);
        await rename(backup, runtime);
      }

      const abandoned = await holdConfiguredBuild(launchDebug);
      await openProjectControl("#open-folder");
      await eventually("switch confirms the held Debug launch", () => js("return document.querySelector('#project-transition-dialog').open;"));
      await click("#project-transition-continue");
      await removed(abandoned);
      await eventually("fresh workspace and target are ready", () => js("return !document.querySelector('#run-target').disabled && !document.querySelector('#run').disabled;"));
      assert.doesNotMatch(await output(), /program-context|Build debuggable|Debug session stopped/);
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally { await releaseHandoff(); }

    await js(`const picker = document.querySelector('#run-target'); picker.value = './debug-program';
      picker.dispatchEvent(new Event('change')); return true;`);
    await launchDebug();
    const { pid: defaultPid, ...defaultContext } = await programContext();
    assert.deepEqual(defaultContext, { cwd: fixture, args: [], gowork: "auto", preset: "" });
    await eventually("default Debug releases the lane", () => text("#status"), value => /Debug session finished/i.test(value));
    await gone("the default debuggee exits", defaultPid);

    const setSessionPreset = async environment => {
      await click('[data-view="tasks"]');
      await click("#run-configurations");
      await eventually("saved preset is present", () => js(`const select = document.querySelector('#run-config-list');
        const option = [...select.options].find(option => option.textContent === 'Debug context fixture');
        if (!option) return false; select.value = option.value; select.dispatchEvent(new Event('change')); return true;`));
      await set("#run-config-session", environment);
      await click("#run-config-save");
    };
    await setSessionPreset("DEBUG_PRESET=child");
    const exiting = await holdConfiguredBuild(launchDebug);
    await releaseHandoff();
    const withChild = await programContext();
    assert.ok(withChild.child > 0);
    await eventually("normal exit releases the execution lane even with a same-group child", () => text("#status"), value => /Debug session finished/.test(value));
    await removed(exiting);
    await gone("the same-group child exits before reuse", withChild.child);
    await setSessionPreset("DEBUG_PRESET=hold");
    const liveDebugger = async () => {
      const directory = await holdConfiguredBuild(launchDebug);
      await releaseHandoff();
      const context = await programContext();
      assert.equal(context.preset, "hold");
      const processes = await eventually("the adapter and backend are live", () => {
        const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
          .flatMap(row => { const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []; });
        const adapter = rows.find(row => row.parent === app.child.pid && row.command.includes(directory) && row.command.includes(" dap "));
        const backend = adapter && rows.find(row => row.parent === adapter.pid && row.command.includes("debugserver"));
        return backend ? [adapter.pid, backend.pid, context.pid] : undefined;
      });
      return { directory, processes };
    };
    const holdDisconnect = hold => js("return window.__ironTest.holdDebugDisconnect(arguments[0]).then(() => true);", hold);
    const assertRetired = async (label, { directory, processes }) => {
      await removed(directory);
      for (const pid of processes) await gone(`${label} retires process ${pid}`, pid);
    };
    await holdDisconnect(true);
    const forced = await liveDebugger();
    await click("#debug-stop");
    await eventually("forced teardown releases the execution lane", () => text("#status"), value => /Debug session stopped/.test(value));
    await assertRetired("Forced Stop", forced);
    await holdDisconnect(false);

    await chooseCommand("start shell");
    const observation = () => js("return window.__ironTest.terminalObservation();");
    const shell = await eventually("the shell is observed before the Debug build", observation, value => value?.leader > 0);
    let survivor;
    try {
      await js("window.__ironTest.terminalInput(arguments[0]); return true;",
        "/bin/sh -c 'trap \"\" HUP; printf \"debug-quit-foreground:%s\\n\" \"$$\"; exec /bin/sleep 120'\r");
      const foreground = await eventually("the terminal reports its foreground PID", () => js("return window.__ironTest.terminalSnapshot();"),
        value => /debug-quit-foreground:\d+/.test(value?.text));
      survivor = Number(foreground.text.match(/debug-quit-foreground:(\d+)/)[1]);
      await eventually("Rust observes the foreground separately from the shell", observation, value => value?.foreground.includes(survivor));
      const kept = await holdConfiguredBuild(launchDebug);
      process.kill(shell.leader, "SIGKILL");
      await gone("the shell leader exits while its foreground is tracked", shell.leader);
      await js("void window.__ironTest.quitMenu(); return true;");
      const ticket = await eventually("Quit has a live native decision", () => js("return window.__ironTest.quitDeadline();"));
      await eventually("the Quit ticket expires while terminal retirement is pending", () => js("return window.__ironTest.expireQuit(arguments[0]);", ticket[0]));
      assert.equal(await js("return window.__ironTest.holdSaveLock();"), true, "Quit still owns the terminal cleanup wait");
      await releaseHandoff();
      const context = await programContext();
      assert.equal(context.preset, "hold");
      assert.equal((await js("return window.__ironTest.terminalSnapshot();")).active, true);
      await click("#debug-stop");
      await eventually("the preserved Debug owner stops only on explicit Stop", () => text("#status"), value => /Debug session stopped/.test(value));
      await removed(kept);
      await gone("the preserved debuggee exits on Stop", context.pid);
    } finally {
      await releaseHandoff();
      if (survivor) {
        try {
          process.kill(survivor, 0);
          const command = execFileSync("ps", ["-p", String(survivor), "-o", "command="], { encoding: "utf8" });
          assert.match(command, /sleep 120/);
          process.kill(survivor, "SIGKILL");
        } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    await eventually("the terminal and failed Quit reservation have both retired", () => js(`
      return window.__ironTest.holdSaveLock().then(busy => !busy && !window.__ironTest.terminalSnapshot().active);`));

    const quitting = await liveDebugger();
    await terminalCheckpoint("Quit with executable debugger");
    try { await js("void window.__ironTest.quitMenu(); return true;"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const exit = await Promise.race([app.exited, delay(10_000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.code, 0, "Ordinary Quit waits for executable debugger retirement");
    await assertRetired("Quit", quitting);
  });
}
