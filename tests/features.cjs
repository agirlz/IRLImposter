// v0.25 playtest features: room labels, section priority by player count,
// 3-digit PINs, hidden roles, the LOG OUT NOW prompt, and phone-size layout.
// usage: node tests/features.cjs [port] [screenshotDir]
const path = require("path");
const { io } = require("socket.io-client");
const { chromium } = require("playwright-core");
const { sleep, startServer, makeChecker, once, ask, run } = require("./helpers.cjs");

const port = process.argv[2] || "3121";
const shots = process.argv[3];
const url = `http://127.0.0.1:${port}`;
const { check, summary } = makeChecker();
const srv = startServer(port, { SABOTAGE_COOLDOWN_MS: "1", MEETING_GATHER_MS: "60000" });
let browser;

run(async () => {
  await sleep(1000);
  const host = io(url); host.emit("host:join");
  const bot = io(url);
  await once(bot, "lobby:update");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const logs = [];
  const lobbyNow = () => new Promise((res) => { bot.once("lobby:update", res); host.emit("station:setRoom", {}); });

  const terminal = async (roomToTap, viewport = { width: 380, height: 560 }) => {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => logs.push(e.message));
    await page.goto(url + "/station.html");
    await page.waitForSelector("#overlay-room:not([hidden])");
    await page.click(`#roomGrid button:text-is("${roomToTap}")`);
    await page.waitForSelector("#overlay-room", { state: "hidden" });
    return page;
  };
  const a = await terminal("Kitchen");
  const b = await terminal("Garage");
  const c = await terminal("Bedroom");
  const d = await terminal("Office");
  const e = await terminal("Bathroom");
  await sleep(200);
  const secs = [];
  for (const p of [a, b, c, d, e]) secs.push(await p.evaluate(() => section));
  check("Terminals fill the priority order", secs.join() === "Electrical,Engineering,Reactor,Navigation,Medbay", secs.join());
  check("Header shows the real room with the section under it",
    (await a.textContent("#sectionName")) === "Kitchen" && (await a.textContent("#sectionSub")).includes("Electrical"));

  await a.reload(); await sleep(400);
  check("Room is remembered after a reload, with no prompt", !(await a.isVisible("#overlay-room")) && (await a.textContent("#sectionName")) === "Kitchen");

  const players = [];
  const reg = async (name) => { const r = await ask(bot, "station:register", { name }); players.push({ id: r.playerId, name, pin: r.pin }); };
  for (const n of ["Ann", "Bob", "Cat"]) await reg(n);
  check("PINs are 3 digits and unique", players.every((p) => /^\d{3}$/.test(p.pin)) && new Set(players.map((p) => p.pin)).size === 3);
  let lobby = await lobbyNow();
  check("3 players use the top 3 sections", lobby.roundSections.join() === "Electrical,Engineering,Reactor", lobby.roundSections.join());
  await reg("Dan"); await reg("Eve");
  lobby = await lobbyNow();
  check("5 players add the next section", lobby.roundSections.join() === "Electrical,Engineering,Reactor,Navigation", lobby.roundSections.join());
  await reg("Fay"); await reg("Gus");
  lobby = await lobbyNow();
  check("7 players use all 5 staffed sections", lobby.roundSections.length === 5, lobby.roundSections.join());

  const started = once(host, "lobby:update", (p) => p.phase === "active");
  host.emit("host:start");
  await started; await sleep(300);

  const login = async (page, pin) => {
    for (const k of pin) await page.click(`#loginKeypad .key:text-is("${k}")`);
    await sleep(250);
  };
  const leaks = async (page) => {
    const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    return text.includes("impostor") || text.includes("crewmate") || text.includes("sabotage");
  };
  const holdFor = async (page, sel, ms) => {
    const bb = await page.locator(sel).boundingBox();
    await page.mouse.move(bb.x + 20, bb.y + 10);
    await page.mouse.down(); await sleep(ms); await page.mouse.up();
    await sleep(100);
  };

  const pagesBySection = { Electrical: a, Engineering: b, Reactor: c, Navigation: d, Medbay: e };
  const roomFor = { Electrical: "Kitchen", Engineering: "Garage", Reactor: "Bedroom", Navigation: "Office", Medbay: "Bathroom" };
  // Look roles up from players[1..] first so players[0] keeps a real first login later.
  let impostor = null;
  for (const p of players) {
    const r = await ask(bot, "station:revealRole", { playerId: p.id, pin: p.pin });
    p.role = r.role; p.tasks = r.tasks;
    if (r.role === "impostor") impostor = p;
  }
  const crew = players.find((p) => p.role === "crewmate");

  // ---- returning login: nothing identifying on the default screen
  const first = impostor.tasks[0].section;
  const wrong = Object.keys(pagesBySection).find((s) => s !== first);
  const pg = pagesBySection[wrong];
  await login(pg, impostor.pin);
  await sleep(300);
  check("Impostor's screen doesn't show role or Sabotage by default", !(await leaks(pg)) && !(await pg.isVisible("#sabotageFab")));
  check("Next assignment leads with the real room", (await pg.textContent("#loggedInNextSection")) === roomFor[first], await pg.textContent("#loggedInNextSection"));
  check("Next assignment also names the section", (await pg.textContent("#loggedInNextSub")).includes(first));
  check("LOG OUT NOW is showing", (await pg.textContent("#logoutBtn")).includes("LOG OUT NOW") && await pg.isVisible("#logoutWarning"));

  const box = await pg.locator("#logoutBtn").boundingBox();
  const bar = await pg.locator("#fixedActions").boundingBox();
  const priv = await pg.locator("#privateHoldBtn").boundingBox();
  const bottom = Math.max(box.y + box.height, priv.y + priv.height);
  check("380x560: LOG OUT and Private fit above Red Alert", bottom <= bar.y + 20 && bottom <= 560, `bottom=${Math.round(bottom)} barTop=${Math.round(bar.y)}`);
  if (shots) await pg.screenshot({ path: path.join(shots, "next-assignment.png") });

  await pg.click("#privateHoldBtn");
  await sleep(1200);
  check("A quick tap doesn't open Private", !(await pg.isVisible("#overlay-private")));
  await holdFor(pg, "#privateHoldBtn", 1150);
  check("Holding opens Private with role and Sabotage", (await pg.textContent("#privateRole")).includes("Impostor") && await pg.isVisible("#sabotageFab"));
  await pg.click("#privateCloseBtn");
  check("Hide clears the role from the page", !(await leaks(pg)));
  await pg.click("#logoutBtn");
  await sleep(150);
  check("Log out returns to the 3-dot keypad", await pg.isVisible("#idleLoginPanel") && (await pg.locator("#loginPinDots .pin-dot").count()) === 3);

  // ---- crew at the terminal their task is at: task layout + Private
  const taskPage = pagesBySection[crew.tasks[0].section];
  await login(taskPage, crew.pin);
  await sleep(600);
  const iframe = await taskPage.locator("#stationFrame").boundingBox();
  const lo = await taskPage.locator("#logoutBtn").boundingBox();
  const tb = await taskPage.locator("#fixedActions").boundingBox();
  check("380x560 task screen: task and buttons fit above Red Alert", iframe.height >= 150 && lo.y + lo.height <= tb.y + 20, `iframe=${Math.round(iframe.height)} logoutBottom=${Math.round(lo.y + lo.height)} barTop=${Math.round(tb.y)}`);
  await holdFor(taskPage, "#privateHoldBtn", 1150);
  check("Crew Private shows Crewmate and no Sabotage", (await taskPage.textContent("#privateRole")).includes("Crewmate") && !(await taskPage.isVisible("#sabotageFab")));
  await taskPage.click("#privateCloseBtn");
  await taskPage.click("#logoutBtn");

  // ---- first login path, after a fresh round
  host.emit("host:reset"); await once(host, "lobby:update", (p) => p.phase === "lobby"); await sleep(200);
  const again = once(host, "lobby:update", (p) => p.phase === "active");
  host.emit("host:start"); await again; await sleep(300);
  await login(pg, players[1].pin);
  await sleep(200);
  check("First login: role is covered", await pg.isVisible("#roleCover") && !(await leaks(pg)));
  check("First login: Let's Go waits until the role is seen", await pg.isDisabled("#roleRevealContinueBtn"));
  const rb = await pg.locator("#roleHoldBtn").boundingBox();
  await pg.mouse.move(rb.x + 20, rb.y + 10);
  await pg.mouse.down(); await sleep(200);
  check("Holding shows the role", (await pg.textContent("#roleRevealTitle")).length > 5 && await pg.isVisible("#roleSecret"));
  await pg.mouse.up(); await sleep(100);
  check("Releasing hides it again", !(await pg.isVisible("#roleSecret")) && !(await leaks(pg)));
  await pg.click("#roleRevealContinueBtn");
  await sleep(300);

  // ---- real touch events, since the terminals are touchscreens
  const cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const tp = await pg.locator("#privateHoldBtn").boundingBox();
  const pt = { x: tp.x + 30, y: tp.y + 12 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] });
  await sleep(300);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(1000);
  check("Touch: a short press doesn't open Private", !(await pg.isVisible("#overlay-private")));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] });
  await sleep(1150);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(100);
  check("Touch: a long press opens Private", await pg.isVisible("#overlay-private"));
  await sleep(8200);
  check("Private closes by itself", !(await pg.isVisible("#overlay-private")) && (await pg.textContent("#privateRole")) === "");
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  // ---- sabotage directions use real rooms
  let imp2 = null;
  for (const p of players) {
    const r2 = await ask(bot, "station:revealRole", { playerId: p.id, pin: p.pin });
    if (r2.role === "impostor") imp2 = p;
  }
  const sab = once(host, "sabotage:started");
  bot.emit("station:sabotage", { playerId: imp2.id, kind: "minor" });
  await sab; await sleep(250);
  check("Lights Out names the real room", (await b.textContent("#lightsOutPlace")) === "Kitchen (Electrical)", await b.textContent("#lightsOutPlace"));
  check("Corner badge names the real room", (await b.textContent("#sabotageCornerLabel")) === "Kitchen");

  // ---- the room picker fits phones and tablets
  for (const vp of [{ width: 380, height: 560 }, { width: 390, height: 844 }, { width: 768, height: 1024 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    const p = await ctx.newPage();
    await p.goto(url + "/station.html");
    await sleep(300);
    await p.evaluate(() => openRoomPicker());
    await sleep(100);
    const skip = await p.locator("#roomSkipBtn").boundingBox();
    check(`Room picker fits ${vp.width}x${vp.height}`, skip.y + skip.height <= vp.height, `bottom=${Math.round(skip.y + skip.height)}`);
    await ctx.close();
  }

  check("No page errors", logs.length === 0, logs.join(" | "));
  return summary();
}, async () => { if (browser) await browser.close(); srv.kill(); });
