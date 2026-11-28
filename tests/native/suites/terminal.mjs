import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function terminalSuite({
  fixture, app, pid, eventually, js, click, text, set, current, output, chooseCommand,
  openProjectControl, record, recordCase, terminalCheckpoint, openOrbit, holdConfiguredBuild,
}) {
  const snapshot = () => js("return window.__ironTest.terminalSnapshot();");
  const observation = () => js("return window.__ironTest.terminalObservation();");
  const send = text => js("window.__ironTest.terminalInput(arguments[0]); return true;", text);
  const close = async () => {
    await click("#terminal-close");
    await eventually("the active terminal has an explicit close decision", () => js("return document.querySelector('#terminal-close-dialog')?.open || document.querySelector('#terminal-tab').hidden;"));
    if (await js("return document.querySelector('#terminal-close-dialog')?.open === true;")) await click("#terminal-close-confirm");
    await eventually("the terminal slot is inactive", snapshot, state => !state?.active);
  };
  await recordCase("pty-io", "a real macOS PTY shell accepts input, resizes, interrupts and closes", async () => {
    await openOrbit();
    await click("#quick-open");
    await set("#palette-text", ">start shell");
    await eventually("the workbench can start a real local shell", () => text("#palette-options"), value => /Start Shell/.test(value));
    await click("#palette-options button");
    await eventually("the terminal starts and is visible", () => js("return !!document.querySelector('#terminal-pane .xterm');"));
    await send("printf 'shell-cwd:%s\\n' \"$PWD\"; printf 'shell-unicode:\\343\\201\\202\\n'\r");
    await eventually("real shell output contains the workspace and Unicode", snapshot,
      state => state?.text.includes(`shell-cwd:${fixture}`) && state.text.includes("shell-unicode:あ"));
    const before = await snapshot();
    await js("return window.__ironTest.resize(840, 620).then(() => true);");
    const resized = await eventually("the terminal follows the actual native window resize", snapshot,
      state => state?.cols > 0 && state.cols !== before.cols);
    await send("printf 'tty-size:'; stty size\r");
    await eventually("the macOS kernel reports the resized PTY", snapshot, state => state?.text.includes(`tty-size:${resized.rows} ${resized.cols}`));
    await send("/bin/sh -c 'printf \"owned-foreground:%s\\n\" \"$$\"; exec /bin/sleep 120'\r");
    const ready = await eventually("a separate foreground process is running", snapshot, state => /owned-foreground:\d+/.test(state?.text));
    const foreground = Number(ready.text.match(/owned-foreground:(\d+)/)[1]);
    await send("\x03");
    await eventually("Ctrl-C interrupts the actual foreground process", () => {
      try { process.kill(foreground, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    });
    await send("printf 'back-at-prompt\\n'\r");
    await eventually("the shell survives its foreground job", snapshot, state => /(?:^|\n)back-at-prompt/.test(state?.text));
    await eventually("the ordinary target is ready", () => js("return document.querySelector('#run-target').value === './cmd/orbit' && !document.querySelector('#run').disabled;"));
    await click("#run");
    await eventually("ordinary Go Run still uses Task Output while a shell is open", output, value => /orbit v0\.1\.0 is online[\s\S]*exit code 0/.test(value), 30_000);
    assert.equal((await snapshot()).active, true);
    await click("#terminal-tab");
    await close();
  });
  await recordCase("pty-credit", "full terminal output credit does not block resize or foreground teardown", async () => {
    await chooseCommand("start shell");
    const old = await eventually("a fresh shell is admitted", snapshot, state => state?.active && state.id && state.text.includes("%"));
    await js("window.__ironTest.holdTerminalAck(true); return true;");
    try {
      await send("/bin/sh -c 'printf \"burst-process:%s\\n\" \"$$\"; exec /bin/dd if=/dev/zero bs=65536 count=32'\r");
      // The process marker can scroll out of xterm's bounded history once the
      // credit fills. Read the actual native child from this shell tree.
      const foreground = await eventually("the foreground output fixture is live", () => {
        const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n");
        const shell = rows.flatMap(row => { const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return match ? [{ id: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []; });
        const owner = shell.find(row => row.parent === pid && row.command.includes("zsh"));
        return owner && shell.find(row => row.parent === owner.id && row.command.includes("dd if=/dev/zero bs=65536 count=32"))?.id;
      });
      const full = await eventually("64 KiB of unacknowledged renderer output is held", snapshot, state => state?.heldBytes === 64 * 1024);
      await js("return window.__ironTest.resize(970, 680).then(() => true);");
      const resized = await eventually("resize still reaches xterm while native output is backpressured", snapshot, state => state?.cols > 0 && state.cols !== full.cols);
      await eventually("the kernel PTY resizes without needing output credit", observation,
        state => state?.credit === 0 && state.cols === resized.cols && state.rows === resized.rows);
      await close();
      await eventually("closing during backpressure reaps the actual foreground job", () => {
        try { process.kill(foreground, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
      });
      await chooseCommand("start shell");
      const replacement = await eventually("a distinct terminal generation is admitted", snapshot, state => state?.active && state.id && state.id !== old.id && state.text.includes("%"));
      assert.notEqual(replacement.id, old.id);
      const newCredit = await eventually("the new prompt has its own pending receipt", observation, state => state?.credit < 64 * 1024);
      await js("return window.__ironTest.attemptTerminalAck(arguments[0], 1).then(() => true);", old.id);
      await delay(80);
      assert.equal((await observation()).credit, newCredit.credit, "Rust must ignore stale receipts even if their sequence matches the new terminal");
    } finally { await js("window.__ironTest.holdTerminalAck(false); return true;"); }
    await send("printf 'replacement-shell\\n'\r");
    await eventually("late old credits cannot disrupt the replacement", snapshot, state => /(?:^|\n)replacement-shell/.test(state?.text));
    const startShellEnabled = () => js("return window.__ironTest.menuItem('Run', 'Start Shell');");
    await eventually("native Start Shell is disabled while the shell is active", startShellEnabled, value => value === false);
    await send("exit\r");
    await eventually("native Start Shell becomes available after a natural shell exit", startShellEnabled, value => value === true);
    await close();
  });
  await recordCase("pty-survivor", "a foreground survivor after leader exit keeps the terminal slot reserved", async () => {
    await chooseCommand("start shell");
    const owner = await eventually("the shell leader is observed", observation, state => state?.leader > 0);
    await send("/bin/sh -c 'trap \"\" HUP; printf \"surviving-foreground:%s\\n\" \"$$\"; exec /bin/sleep 120'\r");
    const ready = await eventually("the fixture reports its actual foreground PID", snapshot, state => /surviving-foreground:\d+/.test(state?.text));
    const foreground = Number(ready.text.match(/surviving-foreground:(\d+)/)[1]);
    const alive = processId => {
      try { process.kill(processId, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    try {
      await eventually("Rust observes the shell's separate foreground", observation, state => state?.foreground.includes(foreground));
      process.kill(owner.leader, "SIGKILL");
      await eventually("the native shell leader exits while a different process survives", () => !alive(owner.leader) && alive(foreground));
      await click("#terminal-close");
      await eventually("the unresolved terminal still needs an explicit close decision", () => js("return document.querySelector('#terminal-close-dialog').open;"));
      await click("#terminal-close-confirm");
      await eventually("cleanup timeout is reported without releasing the terminal", () => text("#toast"), value => /Terminal cleanup could not be confirmed/.test(value));
      assert.equal((await snapshot()).active, true);
      await chooseCommand("start shell");
      await eventually("a new shell is refused while the old foreground survives", () => text("#toast"), value => /Close the active terminal/.test(value));

      const before = await current();
      const created = path.join(path.dirname(fixture), "created-before-terminal-refusal");
      await chooseCommand("new project");
      await set("#form-name", "created-before-terminal-refusal");
      await set("#form-module", "example.com/created-before-terminal-refusal");
      await click("#form-submit");
      await eventually("New Project asks before retiring the terminal", () => js("return document.querySelector('#project-transition-dialog').open;"));
      await click("#project-transition-continue");
      await eventually("the partial outcome names the project that was written", () => text("#toast"),
        value => value.includes(`Project created in ${created} but not opened`));
      await eventually("the form closes after a committed creation", () => js("return !document.querySelector('#form-dialog').open;"));
      assert.equal((await current()).root, before.root);
      assert.match(await readFile(path.join(created, "go.mod"), "utf8"), /^module example\.com\/created-before-terminal-refusal/m);
      assert.match(await readFile(path.join(created, "main.go"), "utf8"), /^package main/m);
    } finally {
      if (alive(foreground)) {
        const command = execFileSync("ps", ["-p", String(foreground), "-o", "command="], { encoding: "utf8" });
        assert.match(command, /sleep 120/);
        process.kill(foreground, "SIGKILL");
      }
    }
    await eventually("the slot retires once the observed foreground exits", snapshot, state => !state?.active);
  });
  await record("interactive Go uses configured cwd, args, environment and a real stdin", async () => {
    const module = path.join(fixture, "interactive-module");
    const runtime = path.join(fixture, "interactive-runtime");
    await Promise.all([mkdir(module), mkdir(runtime)]);
    await writeFile(path.join(fixture, "go.work"), "go 1.22\n\nuse (\n\t.\n\t./interactive-module\n)\n");
    await writeFile(path.join(module, "go.mod"), "module example.test/interactive-module\n\ngo 1.22\n");
    await writeFile(path.join(module, "main.go"), `package main
import ("bufio"; "encoding/json"; "fmt"; "os"; "strings")
func main() {
  cwd, _ := os.Getwd()
  data, _ := json.Marshal(map[string]any{"cwd":cwd,"args":os.Args[1:],"gowork":os.Getenv("GOWORK"),"env":os.Getenv("TERMINAL_FIXTURE")})
  fmt.Printf("terminal-context %s\\n", data)
  answer, _ := bufio.NewReader(os.Stdin).ReadString('\\n')
  fmt.Printf("received-answer:%s\\n", strings.TrimSpace(answer))
}
`);
    await openProjectControl("#open-folder");
    await eventually("the nested executable is discovered", () => js("return Array.from(document.querySelector('#run-target').options, option => option.value);"), targets => targets.includes("./interactive-module"));
    await click('[data-view="tasks"]');
    await click("#run-configurations");
    await set("#run-config-name", "Terminal fixture");
    await set("#run-config-package", "./interactive-module");
    await set("#run-config-directory", "interactive-runtime");
    const args = ["", "two words"];
    await set("#run-config-arguments", JSON.stringify(args));
    await set("#run-config-session", "GOWORK=invalid-for-build\nTERMINAL_FIXTURE=visible only in program");
    await click("#run-config-save");
    await eventually("the configured target is selected", () => js("return document.querySelector('#run-target').selectedOptions[0]?.textContent;"), value => value?.includes("Terminal fixture"));
    const launch = () => chooseCommand("run go program in terminal");
    const release = () => js("return window.__ironTest.runHandoff(false).then(() => true);");
    try {
      const cancelled = await holdConfiguredBuild(launch);
      await js(`window.__ordinaryTask = ''; void window.__ironTest.attemptConfiguredRun('./cmd/orbit', { directory: '.', args: [], environment: {} })
        .then(() => window.__ordinaryTask = 'unexpected admission', error => window.__ordinaryTask = String(error)); return true;`);
      await eventually("the native Go lane is reserved during terminal build", () => js("return window.__ordinaryTask;"), value => /already running/.test(value));
      await close();
      await eventually("cancellation removes the terminal build directory", async () => {
        try { await stat(cancelled); return false; } catch (error) { return error.code === "ENOENT"; }
      });
    } finally { await release(); }
    await launch();
    const began = await eventually("the Go executable starts inside the PTY", snapshot, state => /terminal-context \{[^\n]+\}/.test(state?.text), 30_000);
    assert.deepEqual(JSON.parse(began.text.match(/terminal-context (\{[^\n]+\})/)[1]),
      { cwd: runtime, args, gowork: "invalid-for-build", env: "visible only in program" });
    await send("actual terminal input あ\r");
    await eventually("Go reads native interactive input", snapshot, state => state?.text.includes("received-answer:actual terminal input あ"));
    await eventually("natural exit frees both terminal and Go reservations", snapshot, state => !state?.active);
    assert.equal(await js("return !document.querySelector('#run').disabled;"), true);
  });
  await recordCase("pty-cutover", "actual project switch and Quit retire a live terminal foreground", async () => {
    const alive = processId => {
      try { process.kill(processId, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    const start = async () => {
      await chooseCommand("start shell");
      const owner = await eventually("a shell leader is alive", observation, state => state?.leader > 0);
      await send("/bin/sh -c 'printf \"closing-foreground:%s\\n\" \"$$\"; exec /bin/sleep 120'\r");
      const began = await eventually("a real foreground is active", snapshot, state => /closing-foreground:\d+/.test(state?.text));
      const processId = Number(began.text.match(/closing-foreground:(\d+)/)[1]);
      assert.ok(alive(owner.leader) && alive(processId));
      return () => !alive(owner.leader) && !alive(processId);
    };
    const old = await start();
    const workspace = await js("return window.__ironTest.workspaceId();");
    const switchProject = async () => {
      await openProjectControl("#open-folder");
      await eventually("switch warns about the active terminal", () => text("#project-transition-description"), value => /terminal.*foreground/.test(value));
      await click("#project-transition-continue");
      await eventually("the workbench settles the project picker", () => js("return !document.querySelector('#open-folder').disabled;"));
    };
    await js("return window.__ironTest.cancelNextPicker().then(() => true);");
    await switchProject();
    assert.equal(await js("return window.__ironTest.workspaceId();"), workspace);
    assert.equal(old(), false, "a cancelled picker must preserve the terminal");
    await switchProject();
    assert.notEqual(await js("return window.__ironTest.workspaceId();"), workspace);
    assert.equal(old(), true, "cutover must wait for leader and foreground cleanup");

    const shutdown = await start();
    await terminalCheckpoint("Quit with PTY");
    try { await js("void window.__ironTest.quitMenu(); return true;"); }
    catch (error) { if (error.cause?.code !== "UND_ERR_SOCKET") throw error; }
    const exit = await Promise.race([app.exited, delay(10_000, { timedOut: true }, { ref: false })]);
    assert.equal(exit.code, 0);
    assert.equal(shutdown(), true, "AppKit Quit waits for PTY and foreground retirement");
  });
}
