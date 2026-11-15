const socket = io();

// A quiet on-screen build tag (see .build-stamp in station.html) so a
// future bug report can say "yes, this is really v0.26" — bump this
// alongside the version-history entry in the project notes each round.
const STATION_BUILD = "station v0.26";
const buildStampEl = document.getElementById("buildStamp");
if (buildStampEl) buildStampEl.textContent = STATION_BUILD;

// Must match server.js's PIN_LENGTH — the keypad below reads this off the
// number of .pin-dot elements markup actually provides (see buildKeypad),
// so this constant only drives the PIN prompts this file builds fresh in
// JS (promptPin's confirm-it's-you overlay); the idle-login keypad's dot
// count comes straight from station.html's markup.
const PIN_LENGTH = 3;

const params = new URLSearchParams(location.search);
const SECTION_STORAGE_KEY = "amongusIRL_section";
const ROOM_STORAGE_KEY = "amongusIRL_room";
// The real room this device sits in ("Kitchen"). Belongs to the device, not
// the section: it's picked once and stays put even if the device is handed a
// different section on another night.
let myRoom = localStorage.getItem(ROOM_STORAGE_KEY) || "";
// A URL like ?section=Kitchen still works as a direct shortcut (existing
// host "Copy" links keep working); otherwise this terminal remembers
// whichever section it last claimed, and falls back to "unclaimed" —
// which shows a picker instead of a dead end.
let section = (params.get("section") || localStorage.getItem(SECTION_STORAGE_KEY) || "").trim();
// A "Learn to Play" entry point the native app can open straight from its
// Host Game / Join Game picker, before any game exists to join. Same page,
// same tutorial/practice code — just skips everything that depends on a
// live game (no section, no station:join, no socket-driven state).
const STANDALONE = params.get("standalone") === "1";
// In standalone mode this page never sent station:join, but its socket is
// still connected to whatever server it happens to be pointed at — so
// without this guard, a real, unrelated game running on that server would
// still broadcast sabotage/meeting/lobby/etc. state at this page and bleed
// visibly onto the tutorial screen (e.g. the floating sabotage-corner
// badge showing up over "Learn to Play"). Every real-game broadcast
// listener is registered through this instead of socket.on directly so
// none of them can ever touch a standalone page's state or DOM.
function onGameEvent(name, handler) {
  socket.on(name, (...args) => {
    if (STANDALONE) return;
    handler(...args);
  });
}

const state = {
  phase: "lobby",
  players: [],
  sections: [],
  sectionRooms: {}, // section -> real room name
  roundSections: [], // the sections this roster will actually play
  meeting: null,
  gameOver: null,

  reportingId: null, // declare-dead: who's doing the reporting, once PIN-verified
  reportingPin: null,

  sabotage: null, // {kind,label,deadline,needs,section,holdMs}
  sabotageSlots: [], // [{playerId,name,codeVerified,holding}]
  sabotageHoldProgress: null, // {elapsedMs,neededMs}
  _sabotageFingerprint: null,
  sabotageStartedAt: null, // Date.now() when this sabotage began, for the corner meter's fill %

  lastStaffing: {}, // section -> connected terminal count, for the read-only dashboard
  lastProgress: null, // most recent progress:update payload, for the read-only dashboard

  // Which pre-round screen this terminal is showing right now — a
  // stationary terminal is shared by everyone who joins from it, one after
  // another, so this toggles back to "join" (not just once at page load)
  // every time someone taps Continue on the post-join lobby screen, ready
  // for the next player.
  frontView: "join", // join | lobby
  lastJoinedName: "",
  lastJoinedId: null,
  tutorialIndex: 0,

  view: "idleLogin", // idleLogin | roleReveal | loggedIn | sabotageConsole
  currentPlayerId: null,
  currentName: "",
  currentRole: null,
  currentTasks: null,
  currentSabotageKinds: [],
  activeInstanceId: null,
  lastTaskOutcome: null, // populated right after a completeTask/requestTask round-trip, for the logged-in content area

  votedIds: new Set(),
  votingSelfId: null,
  pendingDeclareId: null,
};

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function workablePlayers() {
  return state.players.filter((p) => p.cause !== "ejected");
}

// ---------------------------------------------------------------------------
// Per-section color/icon identity — a thick border + translucent tint so
// every terminal visually announces which room it is, at a glance, from
// across the room. Known sections get a hand-picked color+icon; anything
// else (a custom section name the host typed in) gets a deterministic pick
// from the same palette so it's at least consistent every time.
// ---------------------------------------------------------------------------
const SECTION_THEMES = {
  Electrical: { color: "#ffb020", rgb: "255,176,32", icon: "⚡" },
  Reactor: { color: "#ff5252", rgb: "255,82,82", icon: "☢" },
  Engineering: { color: "#6cc7ff", rgb: "108,199,255", icon: "⚙️" },
  Navigation: { color: "#3ddc84", rgb: "61,220,132", icon: "🧭" },
  Medbay: { color: "#ff8fc4", rgb: "255,143,196", icon: "✚" },
  Communications: { color: "#b892ff", rgb: "184,146,255", icon: "📡" },
};
const FALLBACK_PALETTE = [
  { color: "#ffb020", rgb: "255,176,32" },
  { color: "#6cc7ff", rgb: "108,199,255" },
  { color: "#3ddc84", rgb: "61,220,132" },
  { color: "#b892ff", rgb: "184,146,255" },
  { color: "#ff8fc4", rgb: "255,143,196" },
];
function themeFor(name) {
  if (SECTION_THEMES[name]) return SECTION_THEMES[name];
  let hash = 0;
  for (let i = 0; i < String(name || "").length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const pick = FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
  return { color: pick.color, rgb: pick.rgb, icon: "📟" };
}
function applyTheme(name) {
  const t = themeFor(name);
  document.body.style.setProperty("--section-color", t.color);
  document.body.style.setProperty("--section-rgb", t.rgb);
  document.body.classList.toggle("themed", !!name);
  $("#idleBadge").textContent = t.icon;
}

// Everyone knows where the Kitchen is; nobody remembers where Engineering is.
// So the real room always leads, with the ship section alongside it.
function roomOf(s) {
  return s === section && myRoom ? myRoom : (state.sectionRooms || {})[s] || "";
}
function placeLabel(s) {
  const room = roomOf(s);
  return room ? `${room} (${s})` : s || "";
}
// Big line + small line, for anywhere a place needs to stand out: the real
// room up top with the section under it, or just the section if no room's set.
function renderPlace(bigEl, smallEl, s) {
  const room = roomOf(s);
  bigEl.textContent = room || s || "";
  smallEl.textContent = room ? `${themeFor(s).icon} ${s}` : "";
}

// Identifies this terminal across reconnects, so the server can tell "my own
// connection that hasn't timed out yet" from "another terminal has this room."
// sessionStorage, not localStorage: it survives a reload, but two tabs in one
// browser stay separate terminals.
const TERMINAL_ID_KEY = "amongusIRL_terminalId";
let terminalId = sessionStorage.getItem(TERMINAL_ID_KEY);
if (!terminalId) {
  terminalId = Math.random().toString(36).slice(2);
  sessionStorage.setItem(TERMINAL_ID_KEY, terminalId);
}

function applySection(s) {
  section = s;
  if (s) {
    renderPlace($("#sectionName"), $("#sectionSub"), s);
    document.title = "Station — " + s;
    localStorage.setItem(SECTION_STORAGE_KEY, s);
  } else {
    $("#sectionName").textContent = "Unassigned";
    $("#sectionSub").textContent = "";
    localStorage.removeItem(SECTION_STORAGE_KEY);
  }
  applyTheme(s);
}

if (STANDALONE) {
  // Nothing to join yet — don't occupy a section slot on whatever server
  // this WebView happens to be pointed at, and there's no live game for
  // the dashboard to show, so hide that entry point too.
  $("#sectionName").textContent = "Learn to Play";
  hide($("#dashboardBtn"));
} else {
  if (section) applySection(section);
  // Runs on every connect, not just the first — a reconnect is a brand new
  // socket that the server knows nothing about, so without this a terminal
  // back from a Wi-Fi drop still shows its room but can't hand out tasks or
  // fix a sabotage there. Any sabotage still running gets re-sent by the
  // server on connect, so whatever's held here could be out of date.
  socket.on("connect", () => {
    if (state.sabotage) clearSabotage();
    socket.emit("station:join", { section, terminalId, room: myRoom, pinned: params.has("section") });
  });
}

// "change" reassigns this terminal to a fresh auto-picked section — no
// dropdown, no typing. The server does the picking (see
// station:reassignSection in server.js).
$("#changeSectionBtn").addEventListener("click", () => {
  $("#changeSectionBtn").disabled = true;
  socket.emit("station:reassignSection", {}, (res) => {
    $("#changeSectionBtn").disabled = false;
    if (res && res.ok) {
      applySection(res.section);
      render();
    }
  });
});

// ---------------------------------------------------------------------------
// Room picker — "Where is this screen?" Pops up by itself the first time a
// terminal starts, one tap per device and then it's remembered, so setting up
// the house takes no longer than walking the devices to their rooms.
// ---------------------------------------------------------------------------
const ROOM_CHOICES = ["Kitchen", "Living Room", "Dining Room", "Bedroom", "Bathroom", "Office", "Garage", "Basement", "Hallway", "Laundry Room"];
let roomPromptDismissed = false;

function setRoom(name) {
  myRoom = name.trim().slice(0, 24);
  localStorage.setItem(ROOM_STORAGE_KEY, myRoom);
  socket.emit("station:setRoom", { room: myRoom });
  hide($("#overlay-room"));
  applySection(section);
  render();
}

function openRoomPicker() {
  const taken = Object.entries(state.sectionRooms || {}).filter(([s]) => s !== section).map(([, r]) => r);
  const grid = $("#roomGrid");
  grid.innerHTML = "";
  ROOM_CHOICES.forEach((name) => {
    const b = document.createElement("button");
    b.className = "name-btn" + (taken.includes(name) ? " dim" : "");
    b.textContent = name;
    b.addEventListener("click", () => setRoom(name));
    grid.appendChild(b);
  });
  $("#roomCustomInput").value = "";
  show($("#overlay-room"));
}

function maybePromptForRoom() {
  if (section && !myRoom && !roomPromptDismissed && state.phase === "lobby") openRoomPicker();
}

function saveCustomRoom() {
  const name = $("#roomCustomInput").value.trim();
  if (name) setRoom(name);
}
$("#roomBtn").addEventListener("click", openRoomPicker);
$("#roomCustomBtn").addEventListener("click", saveCustomRoom);
$("#roomCustomInput").addEventListener("keydown", (e) => { if (e.key === "Enter") saveCustomRoom(); });
$("#roomSkipBtn").addEventListener("click", () => {
  roomPromptDismissed = true;
  hide($("#overlay-room"));
});

// ---------------------------------------------------------------------------
// Keypad — big on-screen number buttons (never a text keyboard), with a
// short vibration + beep on every press. Reused for both the idle login
// screen (mounted once, persistent) and the "confirm it's you" PIN prompt
// overlay (rebuilt fresh each time it's shown).
// ---------------------------------------------------------------------------
let audioCtx = null;
function pressFeedback() {
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.08);
    o.stop(audioCtx.currentTime + 0.09);
  } catch (e) {}
}

// Builds a 4x3 keypad into `container` and renders PIN dots into
// `dotsContainer`. The number of digits expected is read straight from how
// many .pin-dot elements are already in dotsContainer (falling back to
// PIN_LENGTH if there are none) — so the whole app's PIN length lives in
// exactly one place per keypad instance: however many dot markers its
// caller put in the markup, rather than a hardcoded digit count duplicated
// in this function too. Calls onComplete(pin) once every digit is entered;
// call the returned .reset() to clear the buffer (e.g. on a wrong PIN) and
// .shakeError() to flash the dots red briefly.
function buildKeypad(container, dotsContainer, onComplete) {
  container.innerHTML = "";
  let buffer = "";
  const dots = dotsContainer ? $all(".pin-dot", dotsContainer) : [];
  const pinLength = dots.length || PIN_LENGTH;
  function renderDots() {
    dots.forEach((d, i) => d.classList.toggle("filled", i < buffer.length));
  }
  const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", ""];
  KEYS.forEach((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "key" + (k === "⌫" ? " func" : "") + (k === "" ? " empty" : "");
    b.textContent = k;
    if (k !== "") {
      b.addEventListener("click", () => {
        pressFeedback();
        if (k === "⌫") {
          buffer = buffer.slice(0, -1);
        } else if (buffer.length < pinLength) {
          buffer += k;
        }
        renderDots();
        if (buffer.length === pinLength) {
          const pin = buffer;
          onComplete(pin);
        }
      });
    }
    container.appendChild(b);
  });
  renderDots();
  return {
    reset() { buffer = ""; renderDots(); },
    shakeError() {
      if (!dotsContainer) return;
      dotsContainer.classList.add("error");
      setTimeout(() => dotsContainer.classList.remove("error"), 350);
    },
  };
}

// ---------------------------------------------------------------------------
// Panel switching (mutually exclusive "screens" inside .wrap)
// ---------------------------------------------------------------------------
const panels = ["noSectionPanel", "standalonePanel", "frontScreenPanel", "lobbyPanel", "idleLoginPanel", "roleRevealPanel", "loggedInPanel", "sabotageConsolePanel", "lightsOutPanel", "gameOverPanel"];
function showPanel(id) {
  panels.forEach((p) => hide($("#" + p)));
  show($("#" + id));
  // Every panel switch is a fresh "screen" as far as the player's concerned
  // (most notably Log Out, per James's feedback: it should read as leaving
  // one screen and landing cleanly on another, not as scrolling around
  // within the same long page) — force the viewport back to the top so
  // there's never a leftover scroll position from whatever the previous,
  // now-hidden panel's height used to be.
  window.scrollTo(0, 0);
}

function render() {
  if (state.phase !== "active" || state.view !== "loggedIn" || state.sabotage) closePrivate();

  // Setup only: moving a terminal mid-round would strand everyone's routes.
  const canSetUp = !!section && state.phase === "lobby" && !STANDALONE;
  $("#roomBtn").hidden = !canSetUp;
  $("#changeSectionBtn").hidden = !canSetUp;

  if (STANDALONE) {
    hide($("#fixedActions"));
    hide($("#sabotageBanner"));
    hide($("#overlay-redalert"));
    showPanel("standalonePanel");
    return;
  }

  if (!section) {
    hide($("#fixedActions"));
    hide($("#sabotageBanner"));
    hide($("#overlay-redalert"));
    showPanel("noSectionPanel");
    return;
  }

  if (state.phase === "meeting") {
    hide($("#fixedActions"));
    hide($("#sabotageBanner"));
    panels.forEach((p) => hide($("#" + p)));
    renderRedAlertOverlay();
    show($("#overlay-redalert"));
    return;
  }
  hide($("#overlay-redalert"));

  if (state.phase === "ended") {
    hide($("#fixedActions"));
    hide($("#sabotageBanner"));
    renderGameOver();
    showPanel("gameOverPanel");
    return;
  }

  if (state.phase === "lobby") {
    hide($("#fixedActions"));
    hide($("#sabotageBanner"));
    if (state.frontView === "lobby") {
      showPanel("lobbyPanel");
      renderLobby();
    } else {
      showPanel("frontScreenPanel");
      renderFrontScreen();
    }
    return;
  }

  // phase === "active"
  show($("#fixedActions"));
  show($("#redAlertBtn"));

  const sabotageHere = state.sabotage && state.sabotage.section === section;
  if (sabotageHere) {
    hide($("#sabotageBanner"));
    if (state.view === "loggedIn") {
      // A sabotage takes over this terminal just like a Red Alert does —
      // an in-progress task here is abandoned, not completed.
      $("#stationFrame").src = "about:blank";
      state.activeInstanceId = null;
    }
    state.view = "sabotageConsole";
    showPanel("sabotageConsolePanel");
    renderSabotageConsole();
    return;
  }

  // Lights Out is the one sabotage that's supposed to feel like the power
  // actually went out for the whole house, not just a banner at the top of
  // whatever you were doing — so every terminal except Electrical's own
  // goes fully dark until it's fixed there. Reactor Meltdown stays a small
  // banner everywhere else (a reactor problem doesn't plausibly kill every
  // light in the house), so this only applies to the "minor" kind.
  if (state.sabotage && state.sabotage.kind === "minor") {
    hide($("#sabotageBanner"));
    if (state.view === "loggedIn") {
      // Same as a sabotage taking over its own terminal — an in-progress
      // task elsewhere in a blacked-out house is abandoned, not completed.
      $("#stationFrame").src = "about:blank";
      state.activeInstanceId = null;
    }
    showPanel("lightsOutPanel");
    renderLightsOut();
    return;
  }
  renderSabotageBanner();

  if (state.view === "loggedIn") { showPanel("loggedInPanel"); renderLoggedIn(); return; }
  if (state.view === "roleReveal") { showPanel("roleRevealPanel"); return; }
  showPanel("idleLoginPanel");
  renderIdleLogin();
}

// ---------------------------------------------------------------------------
// Idle login — the terminal's resting state during an active round: no name
// list, just this section's PIN keypad. Whoever's PIN matches is identified
// server-side; there's no separate "tap your name first" step anymore.
// ---------------------------------------------------------------------------
let loginKeypadHandle = null;
function renderIdleLogin() {
  $("#loginError").textContent = "";
  if (!loginKeypadHandle) {
    loginKeypadHandle = buildKeypad($("#loginKeypad"), $("#loginPinDots"), submitLoginPin);
  } else {
    loginKeypadHandle.reset();
  }
}
function submitLoginPin(pin) {
  socket.emit("station:revealRole", { pin }, (res) => {
    if (!res || !res.ok) {
      loginKeypadHandle.shakeError();
      $("#loginError").textContent = (res && res.message) || "PIN not recognized.";
      setTimeout(() => { if (loginKeypadHandle) loginKeypadHandle.reset(); }, 300);
      return;
    }
    state.currentPlayerId = res.playerId;
    state.currentName = res.name;
    state.currentRole = res.role;
    state.currentTasks = res.tasks;
    state.currentSabotageKinds = res.sabotageKinds || [];
    if (loginKeypadHandle) loginKeypadHandle.reset();
    if (res.firstTime) {
      hideRoleReveal();
      $("#roleRevealContinueBtn").disabled = true;
      state.view = "roleReveal";
      render();
    } else {
      requestTask();
    }
  });
}

// ---------------------------------------------------------------------------
// Illustrated role reveal — a picture first, so nobody needs to read to know
// their role. Original artwork only (not a recreation of any licensed
// character): a green "officer" figure for Crewmate, a dark cloaked
// silhouette with glowing eyes and a pointing hand for Impostor.
// ---------------------------------------------------------------------------
const CREW_BADGE_SVG = `<svg viewBox="0 0 200 200" width="100%" height="100%">
  <circle cx="100" cy="100" r="92" fill="rgba(61,220,132,0.07)" stroke="#3ddc84" stroke-width="3" opacity="0.5"/>
  <rect x="82" y="128" width="14" height="30" rx="5" fill="#123822" stroke="#3ddc84" stroke-width="3"/>
  <rect x="104" y="128" width="14" height="30" rx="5" fill="#123822" stroke="#3ddc84" stroke-width="3"/>
  <path d="M66 90 C66 68 82 56 100 56 C118 56 134 68 134 90 L134 118 C134 130 122 138 100 138 C78 138 66 130 66 118 Z" fill="#123822" stroke="#3ddc84" stroke-width="4"/>
  <rect x="54" y="88" width="14" height="26" rx="6" fill="#123822" stroke="#3ddc84" stroke-width="3"/>
  <rect x="132" y="88" width="14" height="26" rx="6" fill="#123822" stroke="#3ddc84" stroke-width="3"/>
  <path d="M76 62 C76 46 86 34 100 34 C114 34 124 46 124 62 L124 76 C124 88 113 94 100 94 C87 94 76 88 76 76 Z" fill="#0d2517" stroke="#3ddc84" stroke-width="4"/>
  <path d="M84 62 C84 52 91 46 100 46 C109 46 116 52 116 62 L116 70 C116 78 109 82 100 82 C91 82 84 78 84 70 Z" fill="rgba(61,220,132,0.35)" stroke="#3ddc84" stroke-width="2.5"/>
  <path d="M91 30 L100 18 L109 30 Z" fill="#3ddc84"/>
  <path d="M91 106 L98 113 L112 96" fill="none" stroke="#3ddc84" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const IMPOSTOR_BADGE_SVG = `<svg viewBox="0 0 200 200" width="100%" height="100%">
  <circle cx="100" cy="100" r="92" fill="rgba(255,82,82,0.07)" stroke="#ff5252" stroke-width="3" opacity="0.5"/>
  <path d="M100 44 C124 44 138 62 138 86 C138 100 134 108 138 120 C150 130 156 148 152 166 L48 166 C44 148 50 130 62 120 C66 108 62 100 62 86 C62 62 76 44 100 44 Z" fill="#1c1418" stroke="#ff5252" stroke-width="4"/>
  <ellipse cx="86" cy="88" rx="7" ry="9" fill="#ff5252" opacity="0.95"/>
  <ellipse cx="114" cy="88" rx="7" ry="9" fill="#ff5252" opacity="0.95"/>
  <ellipse cx="86" cy="88" rx="12" ry="14" fill="#ff5252" opacity="0.25"/>
  <ellipse cx="114" cy="88" rx="12" ry="14" fill="#ff5252" opacity="0.25"/>
  <path d="M62 128 C48 138 36 150 30 164" stroke="#1c1418" stroke-width="16" stroke-linecap="round"/>
  <path d="M62 128 C48 138 36 150 30 164" stroke="#ff5252" stroke-width="3" stroke-linecap="round" fill="none"/>
  <ellipse cx="26" cy="168" rx="11" ry="9" fill="#2a1c20" stroke="#ff5252" stroke-width="3"/>
  <path d="M20 162 L14 154 M26 159 L23 149 M32 161 L32 150" stroke="#ff5252" stroke-width="3" stroke-linecap="round" fill="none"/>
</svg>`;
// A role never shows unless someone's actively asking for it. Screens get
// glanced at from across the room, so the default view is identical for crew
// and Impostor, and seeing a role takes a deliberate press and hold.
function bindHold(btn, { delay = 0, onShow, onRelease }) {
  let timer = null;
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // Revealing moves the button; capturing keeps the hold alive until release.
    btn.setPointerCapture(e.pointerId);
    btn.classList.add("holding");
    timer = setTimeout(onShow, delay);
  });
  const stop = () => {
    clearTimeout(timer);
    btn.classList.remove("holding");
    if (onRelease) onRelease();
  };
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
}

function hideRoleReveal() {
  hide($("#roleSecret"));
  show($("#roleCover"));
  $("#roleRevealBadge").innerHTML = "";
  $("#roleRevealTitle").textContent = "";
  $("#roleRevealText").textContent = "";
}
bindHold($("#roleHoldBtn"), {
  onShow: () => {
    renderRoleReveal();
    hide($("#roleCover"));
    show($("#roleSecret"));
    $("#roleRevealContinueBtn").disabled = false;
  },
  onRelease: hideRoleReveal,
});

// Same idea once a round's underway: the private screen holds your role and,
// for the Impostor, Sabotage. It closes by itself so it can't be left showing.
const PRIVATE_HOLD_MS = 1000;
const PRIVATE_AUTOHIDE_MS = 8000;
let privateTimer = null;
function closePrivate() {
  clearTimeout(privateTimer);
  hide($("#overlay-private"));
  hide($("#overlay-sabotagePicker"));
  $("#privateRole").textContent = "";
  $("#privateRole").className = "role-title";
  $("#privateNote").textContent = "";
  $("#sabotageFab").hidden = true;
}
function startPrivateTimer() {
  clearTimeout(privateTimer);
  privateTimer = setTimeout(closePrivate, PRIVATE_AUTOHIDE_MS);
}
bindHold($("#privateHoldBtn"), {
  delay: PRIVATE_HOLD_MS,
  onShow: () => {
    const impostor = state.currentRole === "impostor";
    $("#privateRole").textContent = impostor ? "You're the Impostor" : "You're a Crewmate";
    $("#privateRole").className = "role-title " + (impostor ? "impostor" : "crew");
    $("#privateNote").textContent = impostor ? "Blend in. Sabotage when the moment's right." : "Finish your tasks and watch for anything suspicious.";
    $("#sabotageFab").hidden = !impostor;
    show($("#overlay-private"));
    startPrivateTimer();
  },
});
$("#privateCloseBtn").addEventListener("click", closePrivate);

function renderRoleReveal() {
  if (state.currentRole === "impostor") {
    $("#roleRevealBadge").innerHTML = IMPOSTOR_BADGE_SVG;
    $("#roleRevealTitle").textContent = "You're the Impostor";
    $("#roleRevealTitle").className = "role-title impostor";
    $("#roleRevealText").textContent = "Blend in with the crew, sabotage the ship, and don't let anyone figure out it's you. Log in at any station for a cover task, and tag Crewmates in person — just a touch, no phrase needed.";
  } else {
    $("#roleRevealBadge").innerHTML = CREW_BADGE_SVG;
    $("#roleRevealTitle").textContent = "You're a Crewmate";
    $("#roleRevealTitle").className = "role-title crew";
    $("#roleRevealText").textContent = "Complete your tasks around the ship and keep an eye out — someone here isn't who they say they are. If you find a body, get to the nearest terminal and hit Red Alert.";
  }
}
$("#roleRevealContinueBtn").addEventListener("click", requestTask);

// ---------------------------------------------------------------------------
// Logged-in screen: welcome + current task + (impostor) sabotage + logout.
// Replaces the old separate task/nothing/done panels with one persistent
// view whose content area swaps between the task iframe and a status
// message, matching the approved mockup.
// ---------------------------------------------------------------------------
function renderLoggedIn() {
  $("#welcomeLine").textContent = `Welcome back, ${state.currentName}.`;

  const outcome = state.lastTaskOutcome;
  // Nothing left to do at this terminal means the only thing that matters
  // now is getting off it before someone else reads the screen.
  const leaveNow = !!outcome && outcome.type !== "task";
  $("#logoutBtn").classList.toggle("urgent", leaveNow);
  $("#logoutBtn").textContent = leaveNow ? "🔒 LOG OUT NOW" : "🔒 Log Out";
  $("#logoutWarning").hidden = !leaveNow;
  $("#taskEyebrow").hidden = leaveNow;
  $("#taskContent").hidden = leaveNow;
  $("#loggedInPanel").classList.toggle("tasking", !!outcome && outcome.type === "task");
  if (!outcome) return;

  if (outcome.type === "task") {
    $("#taskEyebrow").textContent = "Your task";
    $("#taskLine").textContent = outcome.task.hint || outcome.task.name || "Complete the activity below.";
    show($("#stationFrame"));
    hide($("#taskContentMsg"));
    hide($("#loggedInNextOrder"));
    if ($("#stationFrame").dataset.instanceId !== outcome.task.instanceId) {
      $("#stationFrame").dataset.instanceId = outcome.task.instanceId;
      $("#stationFrame").src = "/tasks/" + outcome.task.file + "?id=" + encodeURIComponent(outcome.task.instanceId);
    }
  } else {
    hide($("#stationFrame"));
    $("#stationFrame").src = "about:blank";
    delete $("#stationFrame").dataset.instanceId;
    show($("#taskContentMsg"));
    $("#taskEyebrow").textContent = outcome.type === "done" ? "Nice work" : "Nothing here";
    if (outcome.type === "done") {
      $("#taskContentMsgIcon").textContent = "✅";
      $("#taskLine").textContent = outcome.allDone ? "That was the last one — all directives complete, Officer!" : "Great work.";
      $("#taskContentMsgText").textContent = "Task logged.";
    } else if (outcome.allDone) {
      $("#taskContentMsgIcon").textContent = "🏁";
      $("#taskLine").textContent = "All directives complete — stand down, Officer.";
      $("#taskContentMsgText").textContent = "Nothing left for you to do.";
    } else if (outcome.nextSection) {
      $("#taskContentMsgIcon").textContent = "🧭";
      $("#taskLine").textContent = "Wrong station, Officer — your orders send you elsewhere.";
      $("#taskContentMsgText").textContent = "Head to your next assignment below.";
    } else {
      $("#taskContentMsgIcon").textContent = "🤷";
      $("#taskLine").textContent = outcome.message || "Nothing pending here right now.";
      $("#taskContentMsgText").textContent = "";
    }
    if (outcome.nextSection) {
      show($("#loggedInNextOrder"));
      renderPlace($("#loggedInNextSection"), $("#loggedInNextSub"), outcome.nextSection);
    } else {
      hide($("#loggedInNextOrder"));
    }
  }
}

function requestTask() {
  state.view = "loggedIn";
  render();
  socket.emit("station:requestTask", { playerId: state.currentPlayerId }, (res) => {
    if (!res) return;
    if (res.ok && res.task) {
      state.activeInstanceId = res.task.instanceId;
      state.lastTaskOutcome = { type: "task", task: res.task };
    } else if (res.ok && res.none) {
      state.activeInstanceId = null;
      state.lastTaskOutcome = { type: "none", allDone: res.allDone, nextSection: res.nextSection };
    } else {
      state.activeInstanceId = null;
      state.lastTaskOutcome = { type: "none", message: res && res.message };
    }
    render();
  });
}

window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "task-complete" && state.currentPlayerId && state.activeInstanceId) {
    const playerId = state.currentPlayerId;
    const instanceId = state.activeInstanceId;
    socket.emit("station:completeTask", { playerId, instanceId }, (res) => {
      state.activeInstanceId = null;
      if (res && res.ok) {
        state.lastTaskOutcome = { type: "done", allDone: res.allDone, nextSection: res.nextSection };
      } else {
        state.lastTaskOutcome = { type: "done", allDone: false, nextSection: null };
      }
      render();
    });
  }
});

function logOut() {
  closePrivate();
  $("#stationFrame").src = "about:blank";
  delete $("#stationFrame").dataset.instanceId;
  state.currentPlayerId = null;
  state.currentName = "";
  state.currentRole = null;
  state.currentTasks = null;
  state.currentSabotageKinds = [];
  state.activeInstanceId = null;
  state.lastTaskOutcome = null;
  state.view = "idleLogin";
  // showPanel()'s [hidden] toggle is what actually takes loggedInPanel off
  // screen — belt-and-suspenders on top of that: blank its personalized
  // text nodes too, so there's nothing with James's name or task left
  // sitting in the DOM under any circumstance, hidden or not.
  $("#welcomeLine").textContent = "";
  $("#taskLine").textContent = "";
  $("#taskEyebrow").textContent = "";
  render();
}
$("#logoutBtn").addEventListener("click", logOut);

// ---------------------------------------------------------------------------
// Front screen (pre-round lobby): join panel + Tutorial / Practice Games —
// only reachable here, never once a round is underway.
// ---------------------------------------------------------------------------
function renderFrontScreen() {
  const list = $("#joinedList");
  list.innerHTML = "";
  state.players.forEach((p) => {
    const chip = document.createElement("span");
    chip.className = "joined-chip";
    chip.textContent = p.name;
    list.appendChild(chip);
  });
}

function doJoin() {
  const input = $("#joinNameInput");
  const name = input.value.trim();
  $("#joinError").textContent = "";
  if (!name) { $("#joinError").textContent = "Enter a name first."; return; }
  socket.emit("station:register", { name }, (res) => {
    if (res && res.ok) {
      input.value = "";
      state.lastJoinedName = res.name;
      state.lastJoinedId = res.playerId;
      $("#pinRevealName").textContent = res.name;
      $("#pinRevealValue").textContent = res.pin;
      show($("#overlay-pinReveal"));
    } else {
      $("#joinError").textContent = (res && res.message) || "Couldn't join.";
    }
  });
}
$("#joinBtn").addEventListener("click", doJoin);
$("#joinNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
// Dismissing the "here's your PIN" overlay drops straight into the new
// Lobby screen (roster + tonight's sections) instead of just returning to
// whatever was behind it — see item 1 of James's post-playtest notes.
$("#pinRevealContinueBtn").addEventListener("click", () => {
  hide($("#overlay-pinReveal"));
  state.frontView = "lobby";
  render();
});

// ---------------------------------------------------------------------------
// Lobby (post-join): shown automatically right after someone joins. A
// stationary terminal gets used by several people in a row, so this is a
// deliberate stop, not the resting screen — "Continue" hands it back to the
// join form for whoever's next.
// ---------------------------------------------------------------------------
function renderLobby() {
  $("#lobbyWelcome").textContent = state.lastJoinedName ? `Welcome, ${state.lastJoinedName}!` : "You're in!";

  const roster = $("#lobbyRoster");
  roster.innerHTML = "";
  state.players.forEach((p) => {
    const chip = document.createElement("span");
    chip.className = "joined-chip";
    chip.textContent = p.id === state.lastJoinedId ? `${p.name} (you)` : p.name;
    roster.appendChild(chip);
  });

  const grid = $("#lobbySections");
  grid.innerHTML = "";
  const inPlay = state.roundSections && state.roundSections.length ? state.roundSections : state.sections || [];
  inPlay.forEach((s) => {
    const t = themeFor(s);
    const room = roomOf(s);
    const tile = document.createElement("div");
    tile.className = "lobby-section-tile";
    tile.style.setProperty("--tint", t.color);
    tile.style.setProperty("--tint-rgb", t.rgb);
    tile.innerHTML = `<span class="lst-icon">${t.icon}</span><span class="lst-name">${escapeHtml(room || s)}${room ? `<small>${escapeHtml(s)}</small>` : ""}</span>`;
    grid.appendChild(tile);
  });
}
$("#lobbyTutorialBtn").addEventListener("click", openTutorial);
$("#lobbyPracticeBtn").addEventListener("click", openPracticeGrid);
$("#lobbyContinueBtn").addEventListener("click", () => {
  state.frontView = "join";
  render();
});

// ---------------------------------------------------------------------------
// Tutorial — one combined walkthrough covering how the whole night works,
// reachable from the front screen, the standalone "Learn to Play" screen,
// and the new post-join Lobby screen. Data-driven (one array of slides)
// instead of two hardcoded panels, so it's easy to reorder or add to, and
// so Back/Next/dots/Close all come from one shared bit of navigation logic
// instead of being wired by hand per slide.
// ---------------------------------------------------------------------------
const TUTORIAL_SLIDES = [
  {
    title: "Join the game",
    body: `
      <div class="tutorial-icon-big">📛</div>
      <p class="hint center">Before the round starts, type your name in at whichever station terminal is nearest — there's no personal phone for this game. You'll be shown a short PIN right after; that's yours for the rest of the night.</p>
      <div class="tutorial-vertical-note">📱 Terminals stay put all night — set each one up standing on its own, held vertically, like a little sign in the room.</div>
    `,
  },
  {
    title: "Everyone spreads out",
    body: `
      <div class="tutorial-icon-big">🧭</div>
      <p class="hint center">The house is divided into "sections of the ship" — really just rooms. Every terminal shows its real room in big letters, like <b>Kitchen</b>, and your directions always use the real room too.</p>
      <p class="hint center">When the round starts, everyone begins in a <b>different</b> room — spread out around the house before the countdown, so you're not all standing in the same spot.</p>
    `,
  },
  {
    title: "Log in with your code",
    body: `
      <div class="tutorial-icon-big">🔢</div>
      <p class="hint center">Once the round is live, every terminal shows a number keypad. Enter your 3-digit PIN at any station. The first time, press and hold to see your secret role, then you'll get your first task.</p>
      <p class="hint center">From then on, that same PIN is what identifies you everywhere — tasks, sabotage, voting, all of it.</p>
    `,
  },
  {
    title: "Know your role",
    body: `
      <div class="tutorial-cards">
        <div class="tutorial-card crew">
          <svg class="tc-icon" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="46" fill="none" stroke="#3ddc84" stroke-width="3" opacity="0.5"/>
            <rect x="40" y="64" width="7" height="15" rx="2.5" fill="#123822" stroke="#3ddc84" stroke-width="2"/>
            <rect x="53" y="64" width="7" height="15" rx="2.5" fill="#123822" stroke="#3ddc84" stroke-width="2"/>
            <path d="M33 45 C33 34 41 28 50 28 C59 28 67 34 67 45 L67 59 C67 65 61 69 50 69 C39 69 33 65 33 59 Z" fill="#123822" stroke="#3ddc84" stroke-width="2.5"/>
            <path d="M38 31 C38 23 43 17 50 17 C57 17 62 23 62 31 L62 38 C62 44 56 47 50 47 C44 47 38 44 38 38 Z" fill="#0d2517" stroke="#3ddc84" stroke-width="2.5"/>
            <path d="M42 31 C42 26 45 23 50 23 C55 23 58 26 58 31 L58 35 C58 39 55 41 50 41 C45 41 42 39 42 35 Z" fill="rgba(61,220,132,0.35)" stroke="#3ddc84" stroke-width="1.5"/>
            <path d="M45 53 L49 57 L56 48" fill="none" stroke="#3ddc84" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="tc-label">Crewmate</div>
          <div class="tc-desc">Finish your tasks and help find the impostor.</div>
        </div>
        <div class="tutorial-card impostor">
          <svg class="tc-icon" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="46" fill="none" stroke="#ff5252" stroke-width="3" opacity="0.5"/>
            <path d="M50 22 C62 22 69 31 69 43 C69 50 67 54 69 60 C75 65 78 74 76 83 L24 83 C22 74 25 65 31 60 C33 54 31 50 31 43 C31 31 38 22 50 22 Z" fill="#1c1418" stroke="#ff5252" stroke-width="3"/>
            <ellipse cx="43" cy="44" rx="3.5" ry="4.5" fill="#ff5252"/>
            <ellipse cx="57" cy="44" rx="3.5" ry="4.5" fill="#ff5252"/>
            <path d="M31 62 C24 67 18 73 15 80" stroke="#1c1418" stroke-width="8" stroke-linecap="round"/>
            <path d="M31 62 C24 67 18 73 15 80" stroke="#ff5252" stroke-width="1.5" stroke-linecap="round" fill="none"/>
            <ellipse cx="13" cy="82" rx="5.5" ry="4.5" fill="#2a1c20" stroke="#ff5252" stroke-width="1.5"/>
          </svg>
          <div class="tc-label">Impostor</div>
          <div class="tc-desc">Blend in, sabotage the ship, and don't get caught.</div>
        </div>
      </div>
      <p class="hint center">Everyone gets a secret role when the game starts. Only <b>you</b> can see your screen — keep it a secret!</p>
    `,
  },
  {
    title: "Follow your orders",
    body: `
      <div class="tutorial-icon-big">🚦</div>
      <p class="hint center">After you finish a task (or log in somewhere with nothing pending), you'll be told exactly which room to head to next. Your route is yours alone — everyone's order is shuffled differently, so tapping in at the wrong room just points you back to the right one.</p>
    `,
  },
  {
    title: "Always log out",
    body: `
      <div class="tutorial-icon-big">🔒</div>
      <p class="hint center">As soon as you've seen where to go next, tap <b>Log Out</b> — it returns the screen to the keypad for whoever's next, so nobody else can read your screen.</p>
    `,
  },
  {
    title: "Impostor sabotage",
    body: `
      <div class="tutorial-sabotage-demo">💥 Sabotage</div>
      <p class="hint center">Your task screen looks the same as everyone else's. Press and hold <b>Private</b> for a second to see your role — only the impostor gets this button there.</p>
      <div class="tutorial-options">
        <div class="tutorial-opt minor"><div class="to-icon">⚡</div><div class="to-name">Lights Out</div></div>
        <div class="tutorial-opt critical"><div class="to-icon">☢</div><div class="to-name">Meltdown</div></div>
      </div>
      <p class="hint center">Crew must fix it quickly or the impostor wins. Watch for the matching icon on the corner of your screen — and during Lights Out, every screen but Electrical's goes dark until it's fixed.</p>
    `,
  },
];

function renderTutorialSlide() {
  const i = state.tutorialIndex;
  const slide = TUTORIAL_SLIDES[i];
  $("#tutorialEyebrow").textContent = `Tutorial · ${i + 1} of ${TUTORIAL_SLIDES.length}`;
  $("#tutorialSlideBody").innerHTML = `<h2 style="text-align:center;">${escapeHtml(slide.title)}</h2>${slide.body}`;

  const dotsWrap = $("#tutorialDots");
  dotsWrap.innerHTML = "";
  TUTORIAL_SLIDES.forEach((_, idx) => {
    const dot = document.createElement("span");
    if (idx === i) dot.className = "on";
    dotsWrap.appendChild(dot);
  });

  const backBtn = $("#tutorialBackBtn");
  if (i === 0) hide(backBtn); else show(backBtn);
  const nextBtn = $("#tutorialNextBtn");
  const isLast = i === TUTORIAL_SLIDES.length - 1;
  nextBtn.textContent = isLast ? "Got it ✓" : "Next →";
}
function openTutorial() {
  state.tutorialIndex = 0;
  renderTutorialSlide();
  show($("#overlay-tutorial"));
}
$("#viewTutorialBtn").addEventListener("click", openTutorial);
const standaloneTutorialBtn = document.getElementById("standaloneTutorialBtn");
if (standaloneTutorialBtn) standaloneTutorialBtn.addEventListener("click", openTutorial);
$("#tutorialBackBtn").addEventListener("click", () => {
  if (state.tutorialIndex > 0) { state.tutorialIndex--; renderTutorialSlide(); }
});
$("#tutorialNextBtn").addEventListener("click", () => {
  if (state.tutorialIndex < TUTORIAL_SLIDES.length - 1) {
    state.tutorialIndex++;
    renderTutorialSlide();
  } else {
    hide($("#overlay-tutorial"));
  }
});
// Closeable from any slide, not just after clicking through to the end —
// James's item 3 ("Tutorial has no back button") covered both: stepping
// back a slide (above) and backing out of the tutorial entirely (here).
$("#tutorialCloseBtn").addEventListener("click", () => hide($("#overlay-tutorial")));

// ---------------------------------------------------------------------------
// Practice Games — free play for all 5 task mini-games, reachable only from
// the front screen. Loads the same task files real rounds use, but with no
// server round-trip and no effect on real game state.
// ---------------------------------------------------------------------------
const PRACTICE_GAMES = [
  { file: "conduit-patch.html", name: "Conduit Patch", icon: "🔌", color: "amber" },
  { file: "power-cycle.html", name: "Power Cycle", icon: "🔋", color: "cyan" },
  { file: "sequence-lock.html", name: "Sequence Lock", icon: "🎯", color: "purple" },
  { file: "steady-hand.html", name: "Steady Hand", icon: "🎚️", color: "green" },
  { file: "access-code.html", name: "Access Code", icon: "🔢", color: "pink", wide: true },
];
function renderPracticeGrid() {
  const grid = $("#practiceGrid");
  grid.innerHTML = "";
  PRACTICE_GAMES.forEach((g) => {
    const tile = document.createElement("div");
    tile.className = "practice-tile " + g.color + (g.wide ? " wide" : "");
    tile.innerHTML = `<span class="pt-icon">${g.icon}</span><span class="pt-name">${escapeHtml(g.name)}</span>`;
    tile.addEventListener("click", () => openPracticeTask(g));
    grid.appendChild(tile);
  });
}
function openPracticeTask(g) {
  $("#practiceTaskTitle").textContent = g.name;
  hide($("#practiceTaskDone"));
  show($("#practiceTaskFrameWrap"));
  $("#practiceTaskFrame").src = "/tasks/" + g.file;
  show($("#overlay-practiceTask"));
}
function practiceTaskComplete() {
  hide($("#practiceTaskFrameWrap"));
  $("#practiceTaskFrame").src = "about:blank";
  show($("#practiceTaskDone"));
}
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "task-complete" && !$("#overlay-practiceTask").hidden) {
    practiceTaskComplete();
  }
});
function openPracticeGrid() { renderPracticeGrid(); show($("#overlay-practice")); }
$("#practiceGamesBtn").addEventListener("click", openPracticeGrid);
const standalonePracticeBtn = document.getElementById("standalonePracticeBtn");
if (standalonePracticeBtn) standalonePracticeBtn.addEventListener("click", openPracticeGrid);
$("#practiceCloseBtn").addEventListener("click", () => hide($("#overlay-practice")));
$("#practiceTaskBackBtn").addEventListener("click", () => {
  $("#practiceTaskFrame").src = "about:blank";
  hide($("#overlay-practiceTask"));
});

// ---------------------------------------------------------------------------
// PIN prompt — the "confirm it's you" keypad shown before a sensitive
// name-tap when picking a TARGET first (voting, declaring a body, claiming
// a sabotage console) so that step can't be spoofed either.
// onConfirm(pin, helpers) runs on submit; call helpers.error(msg) to show a
// message and let them retry. The caller closes the prompt once its own
// server round-trip actually succeeds.
// ---------------------------------------------------------------------------
function promptPin(name, onConfirm, onCancel) {
  $("#pinPromptTitle").textContent = `Enter PIN for ${name}`;
  $("#pinPromptError").textContent = "";
  const dotsWrap = document.createElement("div");
  dotsWrap.className = "pin-dots";
  for (let i = 0; i < PIN_LENGTH; i++) {
    const d = document.createElement("div");
    d.className = "pin-dot";
    dotsWrap.appendChild(d);
  }
  const keypadWrap = document.createElement("div");
  keypadWrap.className = "keypad";
  const wrap = $("#pinPromptKeypadWrap");
  wrap.innerHTML = "";
  wrap.appendChild(dotsWrap);
  wrap.appendChild(keypadWrap);
  const handle = buildKeypad(keypadWrap, dotsWrap, (pin) => {
    onConfirm(pin, {
      error: (msg) => {
        handle.shakeError();
        $("#pinPromptError").textContent = msg || "Wrong PIN — try again.";
        setTimeout(() => handle.reset(), 300);
      },
    });
  });
  show($("#overlay-pin"));
  $("#pinPromptCancelBtn").onclick = () => {
    hide($("#overlay-pin"));
    if (onCancel) onCancel();
  };
}
function closePinPrompt() {
  hide($("#overlay-pin"));
}

// ---------------------------------------------------------------------------
// Read-only dashboard — reachable from any terminal (station or otherwise;
// there's no separate dedicated dashboard device anymore). Shows the same
// live progress/staffing/sabotage/meeting state the host screen shows, but
// with no controls: sections, sabotage locations, and starting/resetting
// the round still only happen from the host screen.
// ---------------------------------------------------------------------------
function renderDashboard() {
  $("#dashPhaseText").textContent = state.phase.charAt(0).toUpperCase() + state.phase.slice(1);

  if (state.sabotage) {
    show($("#dashSabotageBlock"));
    $("#dashSabotageTitle").textContent = "Sabotage: " + state.sabotage.label;
    $("#dashSabotageNeed").textContent = `Fix at ${placeLabel(state.sabotage.section)} — needs ${state.sabotage.needs} player${state.sabotage.needs > 1 ? "s" : ""} there.`;
    runCountdown($("#dashSabotageCountdown"), state.sabotage.deadline);
  } else {
    hide($("#dashSabotageBlock"));
  }

  if (state.meeting) {
    show($("#dashMeetingBlock"));
    $("#dashMeetingTitle").textContent = "🚨 " + (state.meeting.calledBy || "Red Alert");
    runCountdown($("#dashMeetingCountdown"), state.meeting.deadline);
    const subMap = { gather: "Gathering…", discuss: "Discussing…", vote: "Voting…" };
    $("#dashMeetingSub").textContent = state.meeting.phase === "results"
      ? (state.meeting.skipped ? "No one ejected." : `${state.meeting.ejectedName} ejected.`)
      : (subMap[state.meeting.phase] || "");
  } else {
    hide($("#dashMeetingBlock"));
  }

  // Each row doubles as a quick "which icon/color is which room" legend —
  // the same icon+color a section's own terminal shows — since keeping all
  // the sections straight was flagged as confusing during a playtest.
  const staffWrap = $("#dashStaffingList");
  staffWrap.innerHTML = "";
  (state.sections || []).forEach((s) => {
    const n = (state.lastStaffing || {})[s] || 0;
    const t = themeFor(s);
    const row = document.createElement("div");
    row.className = "chip-row";
    row.innerHTML = `<span>${t.icon} ${escapeHtml(placeLabel(s))}</span><span class="hint" style="color:${n > 0 ? "var(--good)" : "var(--text-dim)"}">${n > 0 ? `● ${n} terminal${n > 1 ? "s" : ""}` : "no terminal yet"}</span>`;
    row.style.borderLeft = `3px solid ${t.color}`;
    staffWrap.appendChild(row);
  });

  if (state.lastProgress && state.phase !== "lobby") {
    show($("#dashProgressBlock"));
    const p = state.lastProgress;
    const pct = p.totalTasks ? Math.round((p.doneTasks / p.totalTasks) * 100) : 0;
    $("#dashOverallPct").textContent = pct + "%";
    $("#dashOverallBar").style.width = pct + "%";
    $("#dashOverallText").textContent = `${p.doneTasks}/${p.totalTasks} crew tasks complete`;
  } else {
    hide($("#dashProgressBlock"));
  }

  const progressById = {};
  if (state.lastProgress) state.lastProgress.players.forEach((p) => { progressById[p.id] = p; });
  const list = $("#dashPlayerList");
  list.innerHTML = "";
  state.players.forEach((p) => {
    const prog = progressById[p.id];
    const right = prog ? `${prog.doneCount}/${prog.totalCount}` : (p.alive ? "in" : "out");
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="pill ${p.alive ? "alive" : "dead"}"><span class="dot"></span>${right}</span>`;
    list.appendChild(li);
  });
}
function maybeRefreshDashboard() {
  if (!$("#overlay-dashboard").hidden) renderDashboard();
}
$("#dashboardBtn").addEventListener("click", () => { renderDashboard(); show($("#overlay-dashboard")); });
$("#dashboardCloseBtn").addEventListener("click", () => hide($("#overlay-dashboard")));

// ---------------------------------------------------------------------------
// Sabotage corner badge — a persistent "something's wrong" indicator shown
// on every screen (whatever this terminal happens to be doing at the
// moment) while any sabotage is active, with a meter that drains from full
// to empty as its countdown runs out.
// ---------------------------------------------------------------------------
function showSabotageCorner(sab) {
  const el = $("#sabotageCorner");
  const isReactor = sab.needs > 1;
  el.classList.toggle("minor", !isReactor);
  $("#sabotageCornerIcon").textContent = isReactor ? "☢" : "⚡";
  $("#sabotageCornerLabel").textContent = roomOf(sab.section) || sab.section || sab.label;
  show(el);
  const totalMs = sab.deadline - state.sabotageStartedAt;
  runMeter($("#sabotageCornerFill"), sab.deadline, totalMs);
}
function hideSabotageCorner() {
  const fill = $("#sabotageCornerFill");
  if (fill._meterTimer) { clearInterval(fill._meterTimer); fill._meterTimer = null; }
  hide($("#sabotageCorner"));
}

// ---------------------------------------------------------------------------
// Sabotage — fixing it only works at its assigned section's terminal.
// Every other terminal just shows an informational banner.
// ---------------------------------------------------------------------------
function renderSabotageBanner() {
  const banner = $("#sabotageBanner");
  if (!state.sabotage) { hide(banner); return; }
  show(banner);
  $("#sabotageBannerText").textContent = `⚠ ${state.sabotage.label} — get to ${placeLabel(state.sabotage.section)}!`;
}

// Full-screen blackout shown on every terminal except Electrical's own
// while Lights Out is active (see the "minor" branch in render()).
function renderLightsOut() {
  const sab = state.sabotage;
  if (!sab) return;
  $("#lightsOutPlace").textContent = placeLabel(sab.section);
  runCountdown($("#lightsOutCountdown"), sab.deadline);
}

// The hold buttons are deliberately never rebuilt while a hold could be in
// progress — only claim/code-verify transitions rebuild the console DOM.
// Hold/progress updates just mutate the existing button/bar in place, so a
// mid-press pointerdown never gets its element yanked out from under it.
function renderSabotageConsole() {
  const sab = state.sabotage;
  if (!sab) return;
  $("#sabotageConsoleTitle").textContent = sab.label;
  runCountdown($("#sabotageConsoleCountdown"), sab.deadline);

  const slots = state.sabotageSlots || [];
  // Reactor Meltdown is the only sabotage that ever needs more than one
  // console — that's what makes it reliably identify "this is the Reactor
  // screen" without any extra state, so it gets its own dedicated framing:
  // a big warning icon and "Officer" labels instead of generic consoles.
  const isReactor = slots.length > 1;
  $("#sabotageConsolePanel").classList.toggle("reactor", isReactor);
  $("#sabotageConsoleBigIcon").hidden = !isReactor;
  const fingerprint = JSON.stringify(slots.map((s) => [s.playerId, s.codeVerified]));
  const needsRebuild = state._sabotageFingerprint !== fingerprint;
  state._sabotageFingerprint = fingerprint;

  if (needsRebuild) {
    const wrap = $("#sabotageSlots");
    wrap.innerHTML = "";
    slots.forEach((slot, i) => {
      const box = document.createElement("div");
      box.className = "panel console-box" + (isReactor ? " officer" : "");
      const label = isReactor ? `Officer ${i + 1}` : "Console";

      if (!slot.playerId) {
        const prompt = isReactor ? `Tap your name to log in as ${label}.` : "Tap your name to take this console.";
        box.innerHTML = `<h2>${label}</h2><p class="hint">${prompt}</p>`;
        const grid = document.createElement("div");
        grid.className = "name-grid";
        const taken = slots.map((s) => s.playerId).filter(Boolean);
        workablePlayers().filter((p) => !taken.includes(p.id)).forEach((p) => {
          const b = document.createElement("button");
          b.className = "name-btn block";
          b.textContent = p.name;
          b.addEventListener("click", () => claimSlot(p.id, p.name));
          grid.appendChild(b);
        });
        box.appendChild(grid);
      } else {
        const head = document.createElement("h2");
        head.textContent = `${label} — ${slot.name || ""} ✓`;
        box.appendChild(head);
        const btn = document.createElement("button");
        btn.className = "console-hold-btn danger";
        btn.id = "sabotageHoldBtn" + i;
        btn.textContent = isReactor ? `${label}: Hold` : "Hold to stabilize";
        const start = (e) => { e.preventDefault(); socket.emit("station:sabotageHold", { playerId: slot.playerId, slotIndex: i, holding: true }); };
        const stop = () => { socket.emit("station:sabotageHold", { playerId: slot.playerId, slotIndex: i, holding: false }); };
        btn.addEventListener("pointerdown", start);
        btn.addEventListener("pointerup", stop);
        btn.addEventListener("pointerleave", stop);
        btn.addEventListener("pointercancel", stop);
        box.appendChild(btn);
      }
      wrap.appendChild(box);
    });
  }

  // Lightweight per-tick updates — never touches the hold buttons' identity.
  const allVerified = slots.length > 0 && slots.every((s) => s.codeVerified);
  slots.forEach((slot, i) => {
    const btn = $("#sabotageHoldBtn" + i);
    if (!btn) return;
    const label = isReactor ? `Officer ${i + 1}` : null;
    btn.disabled = !allVerified;
    btn.classList.toggle("holding", !!slot.holding);
    if (!allVerified) btn.textContent = isReactor ? "Waiting for both officers…" : "Waiting for every console…";
    else if (slot.holding) btn.textContent = label ? `${label}: Holding…` : "Holding…";
    else btn.textContent = label ? `${label}: Hold` : "Hold to stabilize";
  });

  const barWrap = $("#sabotageHoldBarWrap");
  if (allVerified) {
    show(barWrap);
    const prog = state.sabotageHoldProgress || { elapsedMs: 0, neededMs: sab.holdMs || 4000 };
    const pct = Math.min(100, Math.round((prog.elapsedMs / prog.neededMs) * 100));
    $("#sabotageHoldBar").style.width = pct + "%";
    $("#sabotageHoldHint").textContent = isReactor
      ? "Both officers hold at once, without letting go, until the reactor stabilizes."
      : "Hold it down, without letting go, until it's fixed.";
  } else {
    hide(barWrap);
    $("#sabotageHoldHint").textContent = "";
  }
}

function claimSlot(playerId, name) {
  promptPin(name, (pin, { error }) => {
    socket.emit("station:sabotageClaimSlot", { playerId, pin }, (res) => {
      if (res && res.wrongPin) { error(res.message); return; }
      closePinPrompt();
      render();
    });
  });
}

// Sabotage picker: large icon tiles, color-matched to the corner badges
// (amber ⚡ Lights Out, red ☢ Meltdown) rather than a plain text list.
const SABOTAGE_TILE_META = {
  minor: { icon: "⚡", cls: "minor", desc: "goes dark for everyone" },
  critical: { icon: "☢", cls: "critical", desc: "needs fixing before time runs out" },
};
$("#sabotageFab").addEventListener("click", () => {
  hide($("#overlay-private"));
  startPrivateTimer();
  const list = $("#sabotageKindList");
  list.innerHTML = "";
  $("#sabotagePickerError").textContent = "";
  (state.currentSabotageKinds || []).forEach((k) => {
    const meta = SABOTAGE_TILE_META[k.kind] || { icon: "💥", cls: "minor", desc: "" };
    const tile = document.createElement("div");
    tile.className = "sabotage-tile " + meta.cls;
    tile.innerHTML = `
      <div class="tile-icon">${meta.icon}</div>
      <div class="tile-text">
        <div class="tile-name">${escapeHtml(k.label)}</div>
        <div class="tile-desc">${escapeHtml(placeLabel(k.section))} ${meta.desc}${k.needs > 1 ? ` — ${k.needs} needed` : ""}</div>
      </div>`;
    tile.addEventListener("click", () => {
      socket.emit("station:sabotage", { playerId: state.currentPlayerId, kind: k.kind }, (res) => {
        if (res && res.ok) {
          hide($("#overlay-sabotagePicker"));
        } else {
          $("#sabotagePickerError").textContent = (res && res.message) || "Couldn't sabotage.";
        }
      });
    });
    list.appendChild(tile);
  });
  show($("#overlay-sabotagePicker"));
});
$("#sabotagePickerCancelBtn").addEventListener("click", () => hide($("#overlay-sabotagePicker")));

// ---------------------------------------------------------------------------
// Red Alert button (two-tap confirm so it can't be triggered by accident)
// ---------------------------------------------------------------------------
let redAlertArmed = false;
let redAlertArmTimer = null;
$("#redAlertBtn").addEventListener("click", () => {
  if (!redAlertArmed) {
    redAlertArmed = true;
    $("#redAlertBtn").textContent = "Tap again to confirm";
    clearTimeout(redAlertArmTimer);
    redAlertArmTimer = setTimeout(() => {
      redAlertArmed = false;
      $("#redAlertBtn").textContent = "🚨 Red Alert";
    }, 3000);
    return;
  }
  redAlertArmed = false;
  clearTimeout(redAlertArmTimer);
  $("#redAlertBtn").textContent = "🚨 Red Alert";
  socket.emit("station:redAlert", {}, (res) => {
    if (res && !res.ok) {
      $("#redAlertBtn").textContent = res.message || "Couldn't call it";
      setTimeout(() => { $("#redAlertBtn").textContent = "🚨 Red Alert"; }, 2500);
    }
  });
});

// ---------------------------------------------------------------------------
// Red Alert overlay: declare dead + voting, shown on every terminal at once
// ---------------------------------------------------------------------------
function renderRedAlertOverlay() {
  const m = state.meeting;
  if (!m) return;
  $("#redAlertCalledBy").textContent = m.calledBy || "Red Alert";
  runCountdown($("#redAlertCountdown"), m.deadline);
  const labels = { gather: "Gathering…", discuss: "Discussing…", vote: "Voting…", results: "" };
  $("#redAlertPhaseText").textContent = labels[m.phase] || "";

  const declareSection = $("#declareDeadSection");
  const voteSection = $("#voteSection");
  const resultsSection = $("#resultsSection");

  if (m.phase === "results") {
    hide(declareSection);
    hide(voteSection);
    show(resultsSection);
    $("#resultsText").textContent = m.skipped ? "No one was ejected." : `${m.ejectedName} was ejected.`;
    return;
  }

  hide(resultsSection);
  show(declareSection);
  renderDeclareDeadGrid();

  if (m.phase === "vote") {
    show(voteSection);
    renderVoteSection();
  } else {
    hide(voteSection);
  }
}

function renderDeclareDeadGrid() {
  const grid = $("#declareDeadGrid");
  grid.innerHTML = "";
  $("#declareDeadError").textContent = state._declareDeadError || "";
  const alive = state.players.filter((p) => p.alive);

  // Step 1: who's reporting? Same PIN gate as any other name-tap — nothing
  // about this flow should look any different from tasks or voting.
  if (!state.reportingId) {
    $("#declareDeadHint").textContent = "If you found a body, tap your own name first, then theirs. This is final.";
    if (!alive.length) { grid.innerHTML = '<p class="hint">No one left to report.</p>'; return; }
    alive.forEach((p) => {
      const b = document.createElement("button");
      b.className = "name-btn block";
      b.textContent = p.name;
      b.addEventListener("click", () => {
        promptPin(p.name, (pin, { error }) => {
          socket.emit("station:verifyPin", { playerId: p.id, pin }, (res) => {
            if (!res || !res.ok) { error("Wrong PIN — try again."); return; }
            closePinPrompt();
            state.reportingId = p.id;
            state.reportingPin = pin;
            state._declareDeadError = "";
            render();
          });
        });
      });
      grid.appendChild(b);
    });
    return;
  }

  // Step 2: confirm, once a target's picked.
  if (state.pendingDeclareId) {
    const target = alive.find((p) => p.id === state.pendingDeclareId);
    if (!target) { state.pendingDeclareId = null; return renderDeclareDeadGrid(); }
    const box = document.createElement("div");
    box.className = "confirm-box";
    box.innerHTML = `<div>Declare <b>${escapeHtml(target.name)}</b> dead?</div>`;
    const row = document.createElement("div");
    row.className = "row";
    const yes = document.createElement("button");
    yes.className = "danger";
    yes.textContent = "Confirm";
    yes.addEventListener("click", () => {
      socket.emit("station:declareDead", { targetId: target.id, reporterId: state.reportingId, pin: state.reportingPin }, (res) => {
        state.pendingDeclareId = null;
        state.reportingId = null;
        state.reportingPin = null;
        // Someone else may have already declared this body, or the meeting
        // may have moved on, in the moment between opening this confirm
        // dialog and tapping Confirm — say so instead of quietly resetting
        // as if it went through.
        state._declareDeadError = (!res || !res.ok) ? ((res && res.message) || "Couldn't declare — try again.") : "";
        render();
      });
    });
    const no = document.createElement("button");
    no.textContent = "Cancel";
    no.addEventListener("click", () => { state.pendingDeclareId = null; render(); });
    row.appendChild(yes);
    row.appendChild(no);
    box.appendChild(row);
    grid.appendChild(box);
    return;
  }

  // Step 3: who's dead?
  $("#declareDeadHint").textContent = "Now tap who you found.";
  const targets = alive.filter((p) => p.id !== state.reportingId);
  if (!targets.length) {
    grid.innerHTML = '<p class="hint">No one left to declare.</p>';
    return;
  }
  targets.forEach((p) => {
    const b = document.createElement("button");
    b.className = "name-btn block";
    b.textContent = p.name;
    b.addEventListener("click", () => { state.pendingDeclareId = p.id; render(); });
    grid.appendChild(b);
  });
}

function renderVoteSection() {
  const nameGrid = $("#voteNameGrid");
  nameGrid.innerHTML = "";
  $("#voteError").textContent = state._voteError || "";
  const alive = state.players.filter((p) => p.alive);
  alive.forEach((p) => {
    const b = document.createElement("button");
    b.className = "name-btn block" + (state.votedIds.has(p.id) ? " dim" : "");
    b.textContent = p.name + (state.votedIds.has(p.id) ? " ✓ voted" : "");
    b.addEventListener("click", () => {
      promptPin(p.name, (pin, { error }) => {
        socket.emit("station:verifyPin", { playerId: p.id, pin }, (res) => {
          if (!res || !res.ok) { error("Wrong PIN — try again."); return; }
          closePinPrompt();
          state.votingSelfId = p.id;
          state.myPin = pin;
          state._voteError = "";
          render();
        });
      });
    });
    nameGrid.appendChild(b);
  });

  const wrap = $("#voteTargetWrap");
  if (state.votingSelfId) {
    const voter = alive.find((p) => p.id === state.votingSelfId);
    show(wrap);
    $("#voteTargetHint").textContent = voter ? `${voter.name}, who do you vote to eject?` : "";
    const targetGrid = $("#voteTargetGrid");
    targetGrid.innerHTML = "";
    alive.forEach((p) => {
      const b = document.createElement("button");
      b.className = "name-btn block";
      b.textContent = "Vote: " + p.name;
      b.addEventListener("click", () => castVote(p.id));
      targetGrid.appendChild(b);
    });
    const skip = document.createElement("button");
    skip.className = "name-btn block";
    skip.textContent = "Skip";
    skip.addEventListener("click", () => castVote("skip"));
    targetGrid.appendChild(skip);
  } else {
    hide(wrap);
  }
}

function castVote(target) {
  const voterId = state.votingSelfId;
  const pin = state.myPin;
  socket.emit("station:vote", { playerId: voterId, target, pin }, (res) => {
    if (res && res.ok) {
      state.votedIds.add(voterId);
      state._voteError = "";
    } else {
      // The vote phase may have ended (everyone else already voted, or the
      // clock ran out) in the moment between picking a target and the
      // server round-trip — say so instead of just silently dropping back
      // to the name grid as if the vote had gone through.
      state._voteError = (res && res.message) || "Couldn't cast that vote — try again.";
    }
    state.votingSelfId = null;
    state.myPin = null;
    render();
  });
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function renderGameOver() {
  if (!state.gameOver) return;
  $("#gameOverTitle").textContent = state.gameOver.winner === "crew" ? "Crew Wins" : "Impostor Wins";
  $("#gameOverReason").textContent = state.gameOver.reason || "";
  const list = $("#gameOverReveal");
  list.innerHTML = "";
  (state.gameOver.reveal || []).forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="pill">${escapeHtml(p.role)}</span>`;
    list.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------
onGameEvent("lobby:update", (payload) => {
  state.phase = payload.phase;
  state.players = payload.players;
  if (payload.sections) state.sections = payload.sections;
  if (payload.sectionStaffing) state.lastStaffing = payload.sectionStaffing;
  if (payload.sectionRooms) state.sectionRooms = payload.sectionRooms;
  if (payload.roundSections) state.roundSections = payload.roundSections;
  maybeRefreshDashboard();
  if (!section) { render(); return; } // still picking a section — nothing else to update yet
  if (payload.phase !== "active") {
    state.currentPlayerId = null;
    state.currentName = "";
    state.currentRole = null;
    state.currentTasks = null;
    state.currentSabotageKinds = [];
    state.activeInstanceId = null;
    state.lastTaskOutcome = null;
    state.view = "idleLogin";
  }
  render();
});

// The server tells us which section this terminal actually got (whatever
// it remembered, or a fresh auto-assigned one) — apply it reactively so
// there's never a client-side "pick your section" step.
onGameEvent("station:info", (payload) => {
  if (payload && payload.section && payload.section !== section) applySection(payload.section);
  render();
  maybePromptForRoom();
});
onGameEvent("progress:update", (payload) => {
  state.lastProgress = payload;
  maybeRefreshDashboard();
});

onGameEvent("sabotage:started", (payload) => {
  state.sabotage = payload;
  state.sabotageSlots = [];
  state.sabotageHoldProgress = null;
  state._sabotageFingerprint = null;
  state.sabotageStartedAt = Date.now();
  showSabotageCorner(payload);
  maybeRefreshDashboard();
  render();
});
onGameEvent("sabotage:slots", (payload) => {
  state.sabotageSlots = payload.slots || [];
  render();
});
onGameEvent("sabotage:holdProgress", (payload) => {
  state.sabotageHoldProgress = payload;
  render();
});
// Also runs when a round ends or resets, and on reconnect — the server clears
// its own sabotage in those cases without sending sabotage:resolved, and this
// state outlives the round, so a stale one would take over the next round's
// terminals (a stuck console at Reactor, or a blackout nobody can fix).
function clearSabotage() {
  // sabotage:resolved is a broadcast — every terminal in the house hears it, not just the
  // one at the sabotage's own section. A terminal that was actually showing
  // the sabotage console (it WAS that section) — or, for Lights Out, ANY
  // terminal other than Electrical, since those all went dark and had any
  // in-progress task abandoned — should drop back to idle login; anywhere
  // else, a player logged in and mid-task must not get silently bounced
  // back to re-enter their PIN just because a sabotage somewhere else in
  // the house got fixed or timed out.
  const wasShowingConsole = state.view === "sabotageConsole";
  const wasBlackedOut = !!(state.sabotage && state.sabotage.kind === "minor" && state.sabotage.section !== section);
  state.sabotage = null;
  state.sabotageSlots = [];
  state.sabotageHoldProgress = null;
  state._sabotageFingerprint = null;
  state.sabotageStartedAt = null;
  if (wasShowingConsole || wasBlackedOut) state.view = "idleLogin";
  hideSabotageCorner();
  maybeRefreshDashboard();
  render();
}
onGameEvent("sabotage:resolved", clearSabotage);

onGameEvent("meeting:started", (payload) => {
  state.phase = "meeting";
  state.meeting = { calledBy: payload.calledBy, phase: payload.phase || "gather", deadline: payload.deadline };
  state.votedIds = new Set();
  state.votingSelfId = null;
  state.myPin = null;
  state.pendingDeclareId = null;
  state.reportingId = null;
  state.reportingPin = null;
  // A Red Alert interrupts everything — a task in progress is abandoned,
  // not completed. It has to be restarted after the round resumes.
  $("#stationFrame").src = "about:blank";
  delete $("#stationFrame").dataset.instanceId;
  state.activeInstanceId = null;
  maybeRefreshDashboard();
  render();
});
onGameEvent("meeting:phase", (payload) => {
  if (!state.meeting) state.meeting = {};
  state.meeting.phase = payload.phase;
  state.meeting.deadline = payload.deadline;
  if (payload.phase === "results") {
    state.meeting.ejectedName = payload.ejectedName;
    state.meeting.skipped = payload.skipped;
  }
  maybeRefreshDashboard();
  render();
});
onGameEvent("meeting:ended", () => {
  state.meeting = null;
  state.phase = "active";
  state.view = "idleLogin";
  state.currentPlayerId = null;
  state.currentName = "";
  state.currentRole = null;
  state.currentTasks = null;
  state.lastTaskOutcome = null;
  maybeRefreshDashboard();
  render();
});

onGameEvent("game:ended", (payload) => {
  state.phase = "ended";
  state.gameOver = payload;
  clearSabotage();
});
onGameEvent("game:reset", () => {
  state.gameOver = null;
  state.frontView = "join";
  state.lastJoinedName = "";
  state.lastJoinedId = null;
  clearSabotage();
});

render();
