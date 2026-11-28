import { spawn } from "node:child_process";

export async function runFeedback(stages, { report = console.log } = {}) {
  const started = performance.now();
  let interruption;
  const running = [];
  const interrupt = signal => {
    if (interruption) return;
    interruption = signal;
    report(`Feedback interrupted (${signal}); waiting for stage cleanup.`);
    for (const { stage, child } of running) {
      if (stage.interrupt && child.pid && child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const results = await Promise.all(stages.map(stage => new Promise(resolve => {
      const start = performance.now();
      const complete = (code, signal, error) => resolve({ name: stage.name, code, signal, error, ms: performance.now() - start });
      try {
        const child = spawn(stage.command, stage.args, { stdio: "inherit", detached: true });
        running.push({ stage, child });
        child.once("error", error => complete(null, null, error.message));
        child.once("close", complete);
      } catch (error) { complete(null, null, error.message); }
    })));
    const failed = result => result.code !== 0 || result.signal || result.error;
    for (const result of results) {
      const outcome = failed(result) ? `failed (${result.error ?? result.signal ?? `exit ${result.code}`})` : "passed";
      report(`${result.name}: ${outcome} in ${(result.ms / 1000).toFixed(1)} s`);
    }
    const ms = performance.now() - started;
    report(`Feedback wall time: ${(ms / 1000).toFixed(1)} s`);
    const code = interruption === "SIGINT" ? 130 : interruption === "SIGTERM" ? 143 : results.some(failed) ? 1 : 0;
    return { code, stages: results, ms };
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (import.meta.main) {
  const result = await runFeedback([
    { name: "Checks", command: "npm", args: ["run", "check"] },
    { name: "Chromium", command: "npm", args: ["run", "test:ui"] },
    { name: "Native", command: process.execPath, args: ["tests/native/workbench.mjs", "--require-gopls", "--require-delve"], interrupt: true },
  ]);
  process.exitCode = result.code;
}
