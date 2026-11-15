// Regression tests for v0.24's bug fixes: Skip votes, stale sabotage after a
// round ends or resets, and terminals keeping their room across reconnects.
// usage: node tests/fixes.cjs [port]
const { io } = require("socket.io-client");
const { chromium } = require("playwright-core");
const { sleep, startServer, makeChecker, once, ask, run } = require("./helpers.cjs");

const port = process.argv[2] || "3111";
const url = `http://127.0.0.1:${port}`;
const { check, summary } = makeChecker();
const srv = startServer(port, {
  SABOTAGE_COOLDOWN_MS: "1", CRITICAL_SABOTAGE_MS: "4000", MEETING_GATHER_MS: "60000",
  MEETING_DISCUSS_MS: "60000", MEETING_VOTE_MS: "60000", MEETING_RESULTS_MS: "300",
});
let browser;

run(async () => {
  await sleep(1000);
  const host = io(url); host.emit("host:join");
  const bot = io(url);
  await once(bot, "lobby:update");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const pages = {};
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ viewport: { width: 380, height: 560 } });
    const page = await ctx.newPage();
    await page.goto(url + "/station.html");
    await page.waitForFunction(() => !!section);
    pages[await page.evaluate(() => section)] = page;
    await sleep(100);
  }
  console.log("terminals:", Object.keys(pages).join(", "));

  const players = [];
  for (const name of ["Ann", "Bob", "Cat", "Dan", "Eve"]) {
    const r = await ask(bot, "station:register", { name });
    players.push({ id: r.playerId, name, pin: r.pin });
  }
  const start = async () => {
    const started = once(host, "lobby:update", (p) => p.phase === "active");
    host.emit("host:start");
    await started;
    await sleep(200);
    for (const p of players) p.role = (await ask(bot, "station:revealRole", { playerId: p.id, pin: p.pin })).role;
  };
  const reset = async () => { host.emit("host:reset"); await once(host, "lobby:update", (p) => p.phase === "lobby"); await sleep(200); };
  const imp = () => players.find((p) => p.role === "impostor");

  // ---- votes
  await start();
  const voteRound = async (targets) => {
    const started = once(host, "meeting:started");
    bot.emit("station:redAlert", {});
    await started;
    host.emit("host:advanceMeeting"); await once(host, "meeting:phase", (p) => p.phase === "discuss");
    host.emit("host:advanceMeeting"); await once(host, "meeting:phase", (p) => p.phase === "vote");
    const res = once(host, "meeting:phase", (p) => p.phase === "results");
    for (let i = 0; i < targets.length; i++) await ask(bot, "station:vote", { playerId: players[i].id, pin: players[i].pin, target: targets[i] });
    const out = await res;
    await once(host, "meeting:ended");
    return out;
  };
  const crew = players.filter((p) => p.role === "crewmate");
  let r = await voteRound([crew[0].id, "skip", "skip", "skip", "skip"]);
  check("Skip majority ejects no one", r.skipped === true, `ejected=${r.ejectedName}`);
  r = await voteRound([crew[0].id, crew[0].id, "skip", "skip", crew[1].id]);
  check("Tie with Skip ejects no one", r.skipped === true, `ejected=${r.ejectedName}`);
  r = await voteRound([crew[0].id, crew[0].id, crew[0].id, "skip", "skip"]);
  check("Player majority still ejects", r.ejectedName === crew[0].name, `ejected=${r.ejectedName}`);
  await reset();

  const vis = (page, sel) => page.locator(sel).isVisible();

  // ---- meltdown win, then a new round
  await start();
  bot.emit("station:sabotage", { playerId: imp().id, kind: "critical" });
  await once(host, "game:ended", () => true, 8000);
  await reset();
  await start();
  await sleep(300);
  check("After meltdown win, Reactor terminal is back on its keypad", await vis(pages.Reactor, "#idleLoginPanel") && !(await vis(pages.Reactor, "#sabotageConsolePanel")));
  check("After meltdown win, no corner badge", !(await vis(pages.Electrical, "#sabotageCorner")));
  await reset();

  // ---- reset during Lights Out, then a new round
  await start();
  const a = once(host, "sabotage:started");
  bot.emit("station:sabotage", { playerId: imp().id, kind: "minor" });
  await a; await sleep(200);
  const dark = await vis(pages.Reactor, "#lightsOutPanel");
  await reset();
  await start();
  await sleep(300);
  check("Reset during Lights Out: next round isn't dark", dark && !(await vis(pages.Reactor, "#lightsOutPanel")) && await vis(pages.Reactor, "#idleLoginPanel"));

  // ---- a dropped connection (clean close)
  await pages.Reactor.evaluate(() => socket.io.engine.close());
  await sleep(2500);
  const staffing = await new Promise((res) => { host.once("lobby:update", (p) => res(p.sectionStaffing)); host.emit("host:join"); });
  check("Reconnected terminal is still staffed in its room", staffing.Reactor === 1, JSON.stringify(staffing));
  const started = once(host, "sabotage:started");
  bot.emit("station:sabotage", { playerId: imp().id, kind: "critical" });
  await started; await sleep(200);
  const claim = await pages.Reactor.evaluate(([id, pin]) => new Promise((res) => socket.emit("station:sabotageClaimSlot", { playerId: id, pin }, res)), [crew[1].id, crew[1].pin]);
  check("Reconnected Reactor terminal can fix a meltdown", claim.ok === true, claim.message || "");

  // ---- reconnect while a sabotage is running keeps the console up
  await pages.Reactor.evaluate(() => socket.io.engine.close());
  await sleep(1800);
  check("Reconnect mid-sabotage still shows the console", await vis(pages.Reactor, "#sabotageConsolePanel"));
  await once(host, "game:ended", () => true, 8000).catch(() => {});
  await reset();

  // ---- the old connection hasn't timed out yet
  const ghost = io(url, { reconnection: false }); await once(ghost, "lobby:update");
  await new Promise((res) => { ghost.once("station:info", res); ghost.emit("station:join", { section: "Navigation", terminalId: "same-device" }); });
  const back = io(url, { reconnection: false }); await once(back, "lobby:update");
  const info = await new Promise((res) => { back.once("station:info", res); back.emit("station:join", { section: "Navigation", terminalId: "same-device" }); });
  check("Returning terminal keeps its room over its own dead socket", info.section === "Navigation", `got ${info.section}`);
  const other = io(url, { reconnection: false }); await once(other, "lobby:update");
  const otherInfo = await new Promise((res) => { other.once("station:info", res); other.emit("station:join", { section: "Navigation", terminalId: "different-device" }); });
  check("A different device still can't share that room", otherInfo.section !== "Navigation", `got ${otherInfo.section}`);

  return summary();
}, async () => { if (browser) await browser.close(); srv.kill(); });
