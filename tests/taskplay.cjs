// Plays all five mini-games to completion with real touch events, inside the
// real station task area, at four screen sizes — and checks nothing is cut off.
// usage: node tests/taskplay.cjs [port] [screenshotDir]
const path = require("path");
const { chromium } = require("playwright-core");
const { sleep, startServer, makeChecker, run } = require("./helpers.cjs");

const port = process.argv[2] || "3151";
const shots = process.argv[3];
const url = `http://127.0.0.1:${port}`;
const { check, summary } = makeChecker();
const srv = startServer(port);
let browser;

run(async () => {
  await sleep(1000);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const vp of [{ width: 380, height: 560 }, { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }]) {
    const label = `${vp.width}x${vp.height}`;
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.goto(url + "/station.html");
    await sleep(500);
    const box = await page.evaluate(() => {
      document.querySelector("#overlay-room").hidden = true;
      state.phase = "active"; state.view = "loggedIn"; state.currentName = "Test";
      state.lastTaskOutcome = { type: "task", task: { hint: "Test", file: "power-cycle.html", instanceId: "x" } };
      render();
      window.done = 0;
      window.addEventListener("message", (e) => { if (e.data && e.data.type === "task-complete") window.done++; });
      const r = document.querySelector("#stationFrame").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    console.log(`--- ${label}: task iframe ${Math.round(box.w)}x${Math.round(box.h)}`);

    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: x + box.x, y: y + box.y }] });
    const tap = async (x, y) => { await touch("touchStart", x, y); await sleep(40); await touch("touchEnd"); await sleep(120); };
    const load = async (f) => {
      await page.evaluate((file) => { document.querySelector("#stationFrame").src = `tasks/${file}.html?id=x`; }, f);
      await sleep(600);
      return page.frames().find((fr) => fr.url().includes(f));
    };
    const center = (frame, sel) => frame.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }, sel);
    const doneAfter = async (before, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await page.evaluate(() => window.done)) > before) return true; await sleep(100); } return false; };
    const fits = (frame) => frame.evaluate(() => {
      const de = document.documentElement; const bad = [];
      document.querySelectorAll("button, svg, .track, .charge-ring, .code-display, .progress-bar").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height && (r.bottom > de.clientHeight + 0.5 || r.top < -0.5 || r.right > de.clientWidth + 0.5)) bad.push(el.id || el.className || el.tagName);
      });
      return { bad };
    });
    const shot = (name) => (shots && (vp.height === 560 || vp.height === 844) ? page.screenshot({ path: path.join(shots, `play-${vp.height}-${name}.png`) }) : null);
    let before, f, m, b;

    // ---- Power Cycle
    f = await load("power-cycle"); before = await page.evaluate(() => window.done);
    m = await fits(f); check(`${label} Power Cycle fits`, !m.bad.length, m.bad.join());
    await shot("power-cycle");
    b = await center(f, "#holdBtn");
    await touch("touchStart", b.x, b.y);
    await sleep(3900);
    await touch("touchEnd");
    check(`${label} Power Cycle completes by touch`, await doneAfter(before, 2500));

    // ---- Sequence Lock
    f = await load("sequence-lock"); before = await page.evaluate(() => window.done);
    m = await fits(f); check(`${label} Sequence Lock fits`, !m.bad.length, m.bad.join());
    await shot("sequence-lock");
    await f.waitForFunction(() => accepting === true, null, { timeout: 8000 });
    for (const i of await f.evaluate(() => sequence)) {
      const p = await center(f, `.pad[data-i='${i}']`);
      await tap(p.x, p.y);
    }
    check(`${label} Sequence Lock completes by touch`, await doneAfter(before, 2500));

    // ---- Access Code
    f = await load("access-code"); before = await page.evaluate(() => window.done);
    m = await fits(f); check(`${label} Access Code memorize fits`, !m.bad.length, m.bad.join());
    await f.waitForFunction(() => !document.getElementById("keypad").hidden, null, { timeout: 6000 });
    await sleep(100);
    m = await fits(f); check(`${label} Access Code keypad fits`, !m.bad.length, m.bad.join());
    await shot("access-code-keypad");
    b = await center(f, "#keypad button");
    check(`${label} Access Code keys are big enough to tap`, b.h >= 30, `${Math.round(b.h)}px tall`);
    const code = await f.evaluate(() => code);
    const pos = await f.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("#keypad button")).map((k) => { const r = k.getBoundingClientRect(); return { t: k.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
    for (const dg of code) { const k = pos.find((p) => p.t === dg); await tap(k.x, k.y); }
    check(`${label} Access Code completes by touch`, await doneAfter(before, 2500));

    // ---- Steady Hand
    f = await load("steady-hand"); before = await page.evaluate(() => window.done);
    m = await fits(f); check(`${label} Steady Hand fits`, !m.bad.length, m.bad.join());
    const tr = await center(f, "#track");
    await touch("touchStart", tr.x, tr.y);
    const end = Date.now() + 9000;
    let steady = false;
    while (Date.now() < end) {
      const c = await f.evaluate(() => zoneCenter((performance.now() - t0) / 1000));
      await touch("touchMove", tr.x - tr.w / 2 + (tr.w * c) / 100, tr.y);
      await sleep(30);
      if (await f.evaluate(() => done)) { steady = true; break; }
    }
    await touch("touchEnd");
    check(`${label} Steady Hand completes by touch`, steady && (await doneAfter(before, 2500)));

    // ---- Conduit Patch
    f = await load("conduit-patch"); before = await page.evaluate(() => window.done);
    m = await fits(f); check(`${label} Conduit Patch fits`, !m.bad.length, m.bad.join());
    await shot("conduit-patch");
    const points = await f.evaluate(() => {
      const ctm = document.getElementById("board").getScreenCTM();
      const c = (el) => ({ id: el.dataset.id, x: ctm.a * +el.getAttribute("cx") + ctm.e, y: ctm.d * +el.getAttribute("cy") + ctm.f });
      return { pegs: Array.from(document.querySelectorAll('[data-role="peg"]')).map(c), ports: Array.from(document.querySelectorAll('[data-role="port"]')).map(c) };
    });
    check(`${label} Conduit pegs are far enough apart to grab`, points.pegs[1].y - points.pegs[0].y >= 28);
    for (const peg of points.pegs) {
      const port2 = points.ports.find((p) => p.id === peg.id);
      await touch("touchStart", peg.x, peg.y);
      await sleep(40);
      for (let s = 1; s <= 6; s++) { await touch("touchMove", peg.x + ((port2.x - peg.x) * s) / 6, peg.y + ((port2.y - peg.y) * s) / 6); await sleep(20); }
      await touch("touchEnd");
      await sleep(80);
    }
    check(`${label} Conduit Patch completes by touch`, await doneAfter(before, 3000));
    await ctx.close();
  }
  return summary();
}, async () => { if (browser) await browser.close(); srv.kill(); });
