// Online mode end to end, through the real Supabase relay: a host page runs
// the game, three station pages and some test players join by room code.
// Needs internet. usage: node tests/online.cjs [port] [screenshotDir]
const path = require("path");
const { chromium } = require("playwright-core");
const { sleep, startServer, makeChecker, run } = require("./helpers.cjs");

const port = process.argv[2] || "3161";
const shots = process.argv[3];
const base = `http://127.0.0.1:${port}`;
const { check, summary } = makeChecker();
const srv = startServer(port);
let browser;

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const room = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
const tune = "SABOTAGE_COOLDOWN_MS:1,MEETING_GATHER_MS:60000,MEETING_DISCUSS_MS:60000,MEETING_VOTE_MS:60000,MEETING_RESULTS_MS:300";

run(async () => {
  await sleep(1000);
  console.log("room", room);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const errors = [];
  const open = async (pathAndQuery, viewport = { width: 380, height: 560 }) => {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/" + pathAndQuery);
    return page;
  };

  // ---- host
  const host = await open(`host.html?online=1&room=${room}&tune=${tune}`, { width: 390, height: 844 });
  await host.waitForFunction(() => document.querySelector("#serverCodeValue").textContent.length === 4);
  check("Host shows the room code", (await host.textContent("#serverCodeValue")) === room);
  const hostEmit = (ev, payload) => host.evaluate(([e, p]) => new Promise((res) => { socket.emit(e, p, res); setTimeout(res, 400); }), [ev, payload || {}]);
  const hostLobby = () => host.evaluate(() => new Promise((res) => { socket.on("lobby:update", function h(p) { res(p); }); socket.emit("host:join"); }));

  // ---- stations: two by link, one by typing the code
  const station = async (query, roomName, typeCode) => {
    const page = await open(`station.html?online=1${query}`);
    if (typeCode) {
      await page.waitForSelector("#overlay-roomCode:not([hidden])");
      await page.fill("#roomCodeInput", room.toLowerCase());
      await page.click("#roomCodeBtn");
    }
    await page.waitForSelector("#overlay-room:not([hidden])", { timeout: 15000 });
    await page.click(`#roomGrid button:text-is("${roomName}")`);
    await page.waitForSelector("#overlay-room", { state: "hidden" });
    return page;
  };
  const t0 = Date.now();
  const a = await station(`&room=${room}`, "Kitchen");
  console.log(`      first station connected in ${Date.now() - t0}ms`);
  const b = await station(`&room=${room}`, "Garage");
  const c = await station("", "Bedroom", true);
  await sleep(800);
  const secs = [];
  for (const p of [a, b, c]) secs.push(await p.evaluate(() => section));
  check("Stations join by link and by typed code, in priority order", secs.join() === "Electrical,Engineering,Reactor", secs.join());
  check("Station shows the room in its build stamp", (await c.textContent("#buildStamp")).includes(room));
  let lobby = await hostLobby();
  check("Host sees all three terminals and their rooms", Object.keys(lobby.sectionStaffing).length === 3 && lobby.sectionRooms.Electrical === "Kitchen", JSON.stringify(lobby.sectionRooms));

  // ---- players, through a test page's own sockets
  const bots = await open(`station.html?online=1&standalone=1&room=${room}`);
  await bots.evaluate(() => {
    window.bot = connectGame();
    window.ask = (ev, p) => new Promise((res) => window.bot.emit(ev, p, res));
    return new Promise((res) => window.bot.on("connect", res));
  });
  const ask = (ev, p) => bots.evaluate(([e, x]) => ask(e, x), [ev, p]);
  const players = [];
  for (const name of ["Ann", "Bob", "Cat", "Dan"]) {
    const r = await ask("station:register", { name });
    players.push({ id: r.playerId, name, pin: r.pin });
  }
  check("Players register online with 3-digit PINs", players.every((p) => /^\d{3}$/.test(p.pin)));
  await sleep(500);
  check("Stations see the roster live", (await a.textContent("#joinedList")).includes("Dan"));

  await hostEmit("host:start");
  await a.waitForSelector("#idleLoginPanel:not([hidden])", { timeout: 10000 });
  check("Starting on the host puts every station on its keypad", await b.isVisible("#idleLoginPanel") && await c.isVisible("#idleLoginPanel"));
  for (const p of players) {
    const r = await ask("station:revealRole", { playerId: p.id, pin: p.pin });
    p.role = r.role; p.tasks = r.tasks;
  }
  const imp = players.find((p) => p.role === "impostor");
  const crew = players.filter((p) => p.role === "crewmate");

  // ---- log in on a real station by keypad
  const bySection = { Electrical: a, Engineering: b, Reactor: c };
  const stationFor = (s) => bySection[s];
  const notHere = Object.keys(bySection).find((s) => s !== imp.tasks[0].section);
  const pg = stationFor(notHere);
  for (const k of imp.pin) await pg.click(`#loginKeypad .key:text-is("${k}")`);
  await pg.waitForSelector("#loggedInPanel:not([hidden]), #roleRevealPanel:not([hidden])", { timeout: 8000 });
  const text = (await pg.evaluate(() => document.body.innerText)).toLowerCase();
  check("Keypad login works online, with the role still hidden", !text.includes("impostor"));
  if (shots) await pg.screenshot({ path: path.join(shots, "online-login.png") });
  if (await pg.isVisible("#roleRevealPanel")) {
    const rb = await pg.locator("#roleHoldBtn").boundingBox();
    await pg.mouse.move(rb.x + 10, rb.y + 10); await pg.mouse.down(); await sleep(200); await pg.mouse.up();
    await pg.click("#roleRevealContinueBtn");
    await pg.waitForSelector("#loggedInPanel:not([hidden])");
  }
  await sleep(500);
  const roomName = { Electrical: "Kitchen", Engineering: "Garage", Reactor: "Bedroom" }[imp.tasks[0].section];
  check("Next assignment names the real room online", (await pg.textContent("#loggedInNextSection")) === roomName, await pg.textContent("#loggedInNextSection"));
  await pg.click("#logoutBtn");

  // ---- a meeting and a Skip vote
  await ask("station:redAlert", {});
  await a.waitForSelector("#overlay-redalert:not([hidden])", { timeout: 8000 });
  check("Red Alert reaches every station", await b.isVisible("#overlay-redalert") && await c.isVisible("#overlay-redalert"));
  await hostEmit("host:advanceMeeting"); await sleep(1200);
  await hostEmit("host:advanceMeeting"); await sleep(1200);
  for (const p of players) await ask("station:vote", { playerId: p.id, pin: p.pin, target: "skip" });
  await a.waitForFunction(() => state.meeting && state.meeting.phase === "results", null, { timeout: 8000 });
  check("Votes count and Skip wins", await a.evaluate(() => state.meeting.skipped === true));
  await a.waitForSelector("#overlay-redalert", { state: "hidden", timeout: 8000 });

  // ---- Lights Out, fixed at Electrical
  const sab = await ask("station:sabotage", { playerId: imp.id, kind: "minor" });
  check("Sabotage starts online", sab && sab.ok, JSON.stringify(sab));
  await b.waitForSelector("#lightsOutPanel:not([hidden])", { timeout: 8000 });
  check("Lights Out names the real room", (await b.textContent("#lightsOutPlace")) === "Kitchen (Electrical)");
  const claim = await a.evaluate(([id, pin]) => new Promise((res) => socket.emit("station:sabotageClaimSlot", { playerId: id, pin }, res)), [crew[0].id, crew[0].pin]);
  check("A console can be claimed at Electrical", claim && claim.ok, JSON.stringify(claim));
  await a.evaluate(([id]) => socket.emit("station:sabotageHold", { playerId: id, slotIndex: 0, holding: true }), [crew[0].id]);
  await b.waitForSelector("#lightsOutPanel", { state: "hidden", timeout: 12000 });
  check("Holding fixes it and the lights come back", await b.isVisible("#idleLoginPanel"));

  // ---- a dropped connection
  await c.evaluate(() => socket.io.engine.close());
  await c.waitForFunction(() => socket.connected === false, null, { timeout: 5000 }).catch(() => {});
  await c.waitForFunction(() => socket.connected === true, null, { timeout: 15000 });
  await sleep(1500);
  lobby = await hostLobby();
  check("Reconnected station keeps its section", (await c.evaluate(() => section)) === "Reactor" && lobby.sectionStaffing.Reactor === 1, JSON.stringify(lobby.sectionStaffing));
  const reactorTasker = crew.find((p) => p.tasks.some((t) => !t.done)) || crew[0];
  const req = await c.evaluate(([id]) => new Promise((res) => socket.emit("station:requestTask", { playerId: id }, res)), [reactorTasker.id]);
  check("Reconnected station still hands out tasks", req && req.ok === true, JSON.stringify(req).slice(0, 80));

  // ---- the host page reloads: phones find it again
  await host.reload();
  await host.waitForFunction(() => document.querySelector("#serverCodeValue").textContent.length === 4);
  check("Host keeps the same room code after a reload", (await host.textContent("#serverCodeValue")) === room);
  await a.waitForSelector("#frontScreenPanel:not([hidden])", { timeout: 20000 });
  await sleep(1500);
  lobby = await hostLobby();
  check("Stations rejoin a reloaded host on their own", Object.keys(lobby.sectionStaffing).length === 3 && lobby.sectionRooms.Electrical === "Kitchen", JSON.stringify([lobby.sectionStaffing, lobby.sectionRooms]));

  check("No page errors", errors.length === 0, errors.join(" | "));
  return summary();
}, async () => { if (browser) await browser.close(); srv.kill(); });
