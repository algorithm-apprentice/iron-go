(() => {
  const errors = [];
  function record(kind, detail) {
    if (errors.length < 20) errors.push({ kind, detail: String(detail).slice(0, 4000) });
  }
  window.__ironTestRuntimeErrors = () => [...errors];
  window.addEventListener("error", event => {
    record("error", event.error?.stack || event.message || event.target?.src || "Resource failed to load.");
  }, true);
  window.addEventListener("unhandledrejection", event => {
    record("unhandledrejection", event.reason?.stack || event.reason);
  });
})();
