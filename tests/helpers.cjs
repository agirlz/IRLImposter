// Shared bits for the browser test suites. Each suite starts its own server
// on its own port, drives real pages in Microsoft Edge (installed on every
// Windows PC, so there's no browser download), and exits non-zero on failure.
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, env = {}) {
  return spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: "ignore",
  });
}

function makeChecker() {
  const results = [];
  const check = (name, ok, extra = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  };
  const summary = () => {
    const passed = results.filter(Boolean).length;
    console.log(`${passed}/${results.length} passed`);
    return passed === results.length;
  };
  return { check, summary };
}

// Resolves with the first payload of `ev` that matches `pred`.
const once = (s, ev, pred = () => true, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error("timeout " + ev)); }, ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
const ask = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));

function run(main, cleanup) {
  let ok = false;
  main()
    .then((passed) => { ok = passed; })
    .catch((e) => console.log("ERROR", e.message))
    .finally(async () => {
      try { if (cleanup) await cleanup(); } catch (e) {}
      process.exit(ok ? 0 : 1);
    });
}

module.exports = { ROOT, sleep, startServer, makeChecker, once, ask, run };
