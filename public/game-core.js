// IRL Imposter — game rules, shared by every way the game can run.
//
// The rules don't care how phones are connected. attach() takes anything
// shaped like a socket.io server — on("connection"), emit() to everyone,
// sockets.sockets, and per-connection sockets with id, data, on(), emit()
// and disconnect() — and runs one game on it:
//   - server.js hands it a real socket.io server (the offline / Android
//     app setup, where one device on the Wi-Fi hosts).
//   - online.js hands it a stand-in that relays messages through Supabase,
//     so the host's browser tab runs the game (the GitHub Pages setup).
// Keep this file plain ES2018 with no Node or browser APIs: the Android
// app's embedded Node is version 12.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IRLGameCore = factory();
})(this, function () {
function attach(io, options) {
  const env = (options && options.env) || {};

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const SABOTAGE_COOLDOWN_MS = Number(env.SABOTAGE_COOLDOWN_MS) || 60 * 1000;
  const MINOR_SABOTAGE_MS = Number(env.MINOR_SABOTAGE_MS) || 3 * 60 * 1000;
  const CRITICAL_SABOTAGE_MS = Number(env.CRITICAL_SABOTAGE_MS) || 75 * 1000;
  const CRITICAL_SABOTAGE_NEEDS = 2; // distinct players required to fix it
  const SABOTAGE_HOLD_MS = Number(env.SABOTAGE_HOLD_MS) || 4 * 1000; // continuous hold once every console is ready
  const MEETING_GATHER_MS = Number(env.MEETING_GATHER_MS) || 25 * 1000;
  const MEETING_DISCUSS_MS = Number(env.MEETING_DISCUSS_MS) || 90 * 1000;
  const MEETING_VOTE_MS = Number(env.MEETING_VOTE_MS) || 45 * 1000;
  const MEETING_RESULTS_MS = Number(env.MEETING_RESULTS_MS) || 8 * 1000;
  // Right after the game server (re)starts, terminals that were already set
  // up rush back in, in no particular order — they keep the sections they
  // had instead of being reshuffled by priority. Brand-new or leftover
  // terminals joining later still get moved up.
  const REJOIN_GRACE_MS = Number(env.REJOIN_GRACE_MS) || 10 * 1000;
  const startedAt = Date.now();
  const MIN_SECTIONS = 3;
  const MAX_SECTIONS = 12;

  // "Electrical" and "Reactor" are fixed, mandatory sections — Lights Out is
  // always fixed at Electrical and Reactor Meltdown always at Reactor, no
  // host configuration needed. sanitizeSections() force-includes both no
  // matter what the host picks, so they can never be left out.
  const REQUIRED_SECTIONS = ["Electrical", "Reactor"];
  const DEFAULT_SECTIONS = ["Engineering", "Electrical", "Reactor", "Navigation", "Medbay", "Communications"];

  // The same main ship sections always come first. Terminals fill them in this
  // order, and a smaller group only plays the top of the list. Custom sections
  // come after all of these, in the order the host added them.
  const SECTION_PRIORITY = ["Electrical", "Engineering", "Reactor", "Navigation", "Medbay", "Communications"];

  function sectionRank(section) {
    const i = SECTION_PRIORITY.indexOf(section);
    return i === -1 ? SECTION_PRIORITY.length : i;
  }

  function byPriority(sections) {
    return sections.slice().sort((a, b) => sectionRank(a) - sectionRank(b));
  }

  const TASK_TYPES = [
    { id: "conduit-patch", name: "Conduit Patch", hint: "Reconnect the cut wires", file: "conduit-patch.html" },
    { id: "power-cycle", name: "Power Cycle", hint: "Hold the charge steady", file: "power-cycle.html" },
    { id: "sequence-lock", name: "Sequence Lock", hint: "Repeat the light pattern", file: "sequence-lock.html" },
    { id: "steady-hand", name: "Steady Hand", hint: "Keep the needle in the green", file: "steady-hand.html" },
    { id: "access-code", name: "Access Code", hint: "Memorize and enter the code", file: "access-code.html" },
  ];

  const SABOTAGE_KINDS = {
    minor: { label: "Lights Out", ms: MINOR_SABOTAGE_MS, needs: 1 },
    critical: { label: "Reactor Meltdown", ms: CRITICAL_SABOTAGE_MS, needs: CRITICAL_SABOTAGE_NEEDS },
  };

  // ---------------------------------------------------------------------------
  // Game state (single game, in memory)
  // ---------------------------------------------------------------------------
  function freshGame(sections) {
    const secs = sanitizeSections(sections && sections.length ? sections : DEFAULT_SECTIONS);
    return {
      phase: "lobby", // lobby | active | meeting | ended
      players: new Map(), // id -> player
      sections: secs,
      // Fixed sabotage locations — always these two fixed names, never a host
      // setting. sanitizeSections() guarantees both are always present in secs.
      electricalSection: "Electrical",
      reactorSection: "Reactor",
      sectionTaskMap: {}, // section -> task type
      sabotage: null, // { kind, label, deadline, needs, section, slots:[{playerId,code,codeVerified,holding}], simulHoldSince }
      lastSabotageAt: 0,
      meeting: null, // { calledBy, phase, deadline, votes:Map }
      winner: null,
      reason: null,
    };
  }

  let game = freshGame();

  function newId() {
    let s = "";
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  // A personal PIN, assigned once at registration and kept for as long as
  // that player stays in the roster (it survives a host reset — see
  // resetGame — and is only replaced if they leave and rejoin as a new
  // registration, or the host resets it for them). Required every time this
  // player's name is tapped anywhere, so no interaction — task, sabotage,
  // vote, whatever — ever looks different from any other, and no one can act
  // as someone else without knowing their PIN.
  //
  // PIN_LENGTH is 3 digits (000-999) — short enough to remember and fast to
  // type on the on-screen keypad for a party game, while being hard enough to
  // guess that nobody stumbles onto someone else's screen. makeUniquePin()
  // below is what actually keeps it safe to log in by PIN alone: every
  // assignment loops until it finds a code truly nobody else has.
  const PIN_LENGTH = 3;
  const PIN_MAX = 10 ** PIN_LENGTH; // 1000 for length 3
  function makePin() {
    return String(Math.floor(Math.random() * PIN_MAX)).padStart(PIN_LENGTH, "0");
  }

  // Collision-free PIN assignment. Random PINs were fine when they were only
  // ever paired with a tapped name for confirmation, but the keypad-only
  // login flow (station:revealRole with no playerId) now looks a player up BY
  // PIN alone — two players sharing a PIN would let one log in as the other.
  // This loop (rather than raw randomness alone) is what actually guarantees
  // uniqueness — expect it
  // to run a few extra times as the roster fills up.
  function makeUniquePin() {
    const taken = new Set([...game.players.values()].map((p) => p.pin));
    let pin;
    do { pin = makePin(); } while (taken.has(pin));
    return pin;
  }

  function checkPin(p, pin) {
    return !!p && !!p.pin && String(pin == null ? "" : pin).trim() === p.pin;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sanitizeSections(list) {
    const seen = new Set();
    const out = [];
    const addOne = (raw) => {
      const s = String(raw || "").trim().slice(0, 30);
      const key = s.toLowerCase();
      if (!s || seen.has(key)) return;
      seen.add(key);
      out.push(s);
    };
    // Electrical and Reactor are mandatory — always present regardless of
    // what the host passes in, so sabotage locations never go missing.
    REQUIRED_SECTIONS.forEach(addOne);
    for (const raw of list || []) {
      if (out.length >= MAX_SECTIONS) break;
      addOne(raw);
    }
    return out;
  }

  function livingPlayers() {
    return [...game.players.values()].filter((p) => p.alive);
  }

  function livingCrew() {
    return livingPlayers().filter((p) => p.role !== "impostor");
  }

  function livingImpostors() {
    return livingPlayers().filter((p) => p.role === "impostor");
  }

  // A player can still work stations if they haven't been fully ejected by a
  // vote. Someone found dead and declared during a meeting becomes a quiet
  // Ghost but can still finish their own remaining tasks.
  function canWork(p) {
    return !!p && p.cause !== "ejected";
  }

  function publicPlayerList() {
    return [...game.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      cause: p.cause,
    }));
  }

  function taskListFor(p) {
    return p.role === "impostor" ? p.fakeTasks : p.tasks;
  }

  function progressSummary() {
    const players = [...game.players.values()].map((p) => {
      const list = taskListFor(p) || [];
      return {
        id: p.id,
        name: p.name,
        alive: p.alive,
        doneCount: list.filter((t) => t.done).length,
        totalCount: list.length,
      };
    });
    const crew = [...game.players.values()].filter((p) => p.role !== "impostor");
    const totalTasks = crew.reduce((n, p) => n + (p.tasks || []).length, 0);
    const doneTasks = crew.reduce((n, p) => n + (p.tasks || []).filter((t) => t.done).length, 0);
    return { totalTasks, doneTasks, players };
  }

  function buildTaskList(sections) {
    return sections.map((section) => ({
      ...game.sectionTaskMap[section],
      section,
      instanceId: newId(),
      done: false,
    }));
  }

  // ---- Live terminal-to-section tracking ----
  // A "section" the host configures is just a name until an actual device
  // opens a station and claims it — that's what makes it "staffed." A round
  // can only ever hand out tasks for sections that are staffed *right now*,
  // so nobody ever gets a task at a section nobody physically set up a
  // terminal for.
  const sectionTerminals = new Map(); // section -> Set(socket.id)

  // The real room each section's terminal sits in ("Kitchen"), so nobody has to
  // remember where "Engineering" is. The device remembers its room and sends it
  // on every join, so this survives resets and server restarts, and follows the
  // device if it's handed a different section. Deliberately not cleared when a
  // terminal drops — directions should keep working while it reconnects.
  const sectionRooms = new Map(); // section -> room name

  function recordRoom(socket) {
    const { section, room } = socket.data;
    if (!section) return;
    if (room) sectionRooms.set(section, room);
    else if (sectionTerminals.get(section).size === 1) sectionRooms.delete(section);
  }

  function cleanRoom(room) {
    return String(room || "").trim().slice(0, 24);
  }

  function addTerminal(section, id) {
    if (!section) return;
    if (!sectionTerminals.has(section)) sectionTerminals.set(section, new Set());
    sectionTerminals.get(section).add(id);
  }
  function removeTerminal(section, id) {
    if (!section) return;
    const set = sectionTerminals.get(section);
    if (!set) return;
    set.delete(id);
    if (!set.size) sectionTerminals.delete(section);
  }
  function dropOldConnections(socket) {
    const { terminalId } = socket.data;
    if (!terminalId) return;
    for (const other of io.sockets.sockets.values()) {
      if (other === socket || other.data.terminalId !== terminalId) continue;
      removeTerminal(other.data.section, other.id);
      other.data.section = null;
      other.disconnect(true);
    }
  }
  function staffedSections(candidates) {
    return candidates.filter((s) => (sectionTerminals.get(s) || new Set()).size > 0);
  }
  function sectionTerminalCounts() {
    const out = {};
    for (const [s, ids] of sectionTerminals.entries()) out[s] = ids.size;
    return out;
  }

  // Which sections a round with the current roster would use: the highest
  // priority staffed ones, one stop for every player beyond the first, and
  // never fewer than MIN_SECTIONS — so 3-4 players get 3 rooms, 5 get 4, and so
  // on. Electrical and Reactor are in the top 3, so they're always included.
  function sectionsForRound() {
    const staffed = staffedSections(byPriority(sanitizeSections(game.sections)));
    return staffed.slice(0, Math.max(MIN_SECTIONS, game.players.size - 1));
  }

  function publicSectionRooms() {
    const entries = [...sectionRooms.entries()];
    // Before a round, only rooms with a terminal there right now count — a
    // device that moved to a new section shouldn't leave its room on the old one.
    return Object.fromEntries(game.phase === "lobby" ? entries.filter(([s]) => sectionTerminals.has(s)) : entries);
  }

  function lobbyPayload() {
    return {
      phase: game.phase,
      players: publicPlayerList(),
      sections: game.sections,
      electricalSection: game.electricalSection,
      reactorSection: game.reactorSection,
      sectionStaffing: sectionTerminalCounts(),
      sectionRooms: publicSectionRooms(),
      roundSections: sectionsForRound(),
    };
  }

  // Auto-assignment: a terminal never asks a human to pick a section. Terminals
  // fill SECTION_PRIORITY in order, so with only a handful of devices on hand
  // you always know exactly which sections get covered first (and both sabotage
  // locations are guaranteed among the earliest three, not left to chance).
  // Once every section already has at least one terminal, a
  // further device goes to whichever section currently has the *fewest* —
  // spreading extras out instead of always piling onto the same one.
  // `exclude` lets the "reassign" flow avoid handing a terminal right back the
  // room it just left.
  function leastStaffedSection(candidates) {
    let min = Infinity;
    let choices = [];
    for (const s of candidates) {
      const n = (sectionTerminals.get(s) || new Set()).size;
      if (n < min) {
        min = n;
        choices = [s];
      } else if (n === min) {
        choices.push(s);
      }
    }
    return choices[Math.floor(Math.random() * choices.length)];
  }

  function pickSectionForNewTerminal(exclude) {
    const sections = (game.sections && game.sections.length ? game.sections : DEFAULT_SECTIONS).filter(
      (s) => s !== exclude
    );
    if (!sections.length) return null;
    const unstaffed = sections.filter((s) => (sectionTerminals.get(s) || new Set()).size === 0);
    if (!unstaffed.length) return leastStaffedSection(sections);
    return byPriority(unstaffed)[0];
  }

  function broadcastLobby() {
    io.emit("lobby:update", lobbyPayload());
  }

  function publicSabotageSlots() {
    if (!game.sabotage) return [];
    return game.sabotage.slots.map((s) => ({
      playerId: s.playerId,
      name: s.playerId ? (game.players.get(s.playerId) || {}).name : null,
      codeVerified: s.codeVerified,
      holding: s.holding,
    }));
  }

  function broadcastSabotageSlots() {
    io.emit("sabotage:slots", { slots: publicSabotageSlots() });
  }

  function broadcastProgress() {
    io.emit("progress:update", progressSummary());
  }

  function checkWinConditions() {
    if (game.phase === "ended") return;
    const crew = livingCrew();
    const imp = livingImpostors();

    if (imp.length === 0) {
      return endGame("crew", "The Impostor was voted out.");
    }
    if (imp.length >= crew.length) {
      return endGame("impostor", "The Impostor equaled the crew.");
    }
    const totalCrewTasks = [...game.players.values()]
      .filter((p) => p.role !== "impostor")
      .reduce((n, p) => n + p.tasks.length, 0);
    const doneCrewTasks = [...game.players.values()]
      .filter((p) => p.role !== "impostor")
      .reduce((n, p) => n + p.tasks.filter((t) => t.done).length, 0);
    if (totalCrewTasks > 0 && doneCrewTasks >= totalCrewTasks) {
      return endGame("crew", "All tasks completed.");
    }
  }

  function endGame(winner, reason) {
    game.phase = "ended";
    game.winner = winner;
    game.reason = reason;
    game.sabotage = null;
    game.meeting = null;
    const reveal = [...game.players.values()].map((p) => ({ id: p.id, name: p.name, role: p.role }));
    io.emit("game:ended", { winner, reason, reveal });
    broadcastLobby();
  }

  // ---- Sabotage ----
  // Each sabotage kind is tied to one specific section (host-assigned) —
  // Lights Out can only be fixed at Electrical, Reactor Meltdown only at
  // Reactor. Fixing it means claiming a console (tap your name, confirm your
  // PIN), then holding a button. Reactor needs two different people to be
  // holding their buttons down at the exact same time, continuously, for
  // SABOTAGE_HOLD_MS — like the real game, letting go resets the hold for
  // everyone. An earlier version also made you read a short code off the
  // screen and type it back in before the hold button unlocked — removed per
  // James's feedback: the PIN you just entered already proves who you are,
  // so retyping a second code the screen was already showing you was pure
  // busywork with no actual security benefit. Claiming a slot now unlocks the
  // hold button immediately.
  function triggerSabotage(kind) {
    const now = Date.now();
    if (game.phase !== "active") return { ok: false, message: "No active round." };
    if (game.sabotage) return { ok: false, message: "A sabotage is already in progress." };
    if (now - game.lastSabotageAt < SABOTAGE_COOLDOWN_MS) {
      const wait = Math.ceil((SABOTAGE_COOLDOWN_MS - (now - game.lastSabotageAt)) / 1000);
      return { ok: false, message: `Cooldown: wait ${wait}s.` };
    }
    const def = SABOTAGE_KINDS[kind];
    if (!def) return { ok: false, message: "Unknown sabotage." };
    const section = kind === "critical" ? game.reactorSection : game.electricalSection;
    if (!section) return { ok: false, message: "That sabotage isn't set up yet — ask the host to assign it a section." };

    game.sabotage = {
      kind,
      label: def.label,
      needs: def.needs,
      deadline: now + def.ms,
      section,
      slots: Array.from({ length: def.needs }, () => ({ playerId: null, codeVerified: false, holding: false })),
      simulHoldSince: null,
    };
    game.lastSabotageAt = now;
    io.emit("sabotage:started", {
      kind,
      label: def.label,
      deadline: game.sabotage.deadline,
      needs: def.needs,
      section,
      holdMs: SABOTAGE_HOLD_MS,
    });
    broadcastSabotageSlots();
    return { ok: true };
  }

  function tickSabotage() {
    if (!game.sabotage) return;
    if (Date.now() >= game.sabotage.deadline) {
      const wasCritical = game.sabotage.kind === "critical";
      game.sabotage = null;
      if (wasCritical) {
        endGame("impostor", "The reactor melted down.");
      } else {
        io.emit("sabotage:resolved", { expired: true });
      }
    }
  }

  // Runs every tick: checks whether every console is currently being held
  // down at once, and how long that's been continuously true.
  function tickSabotageHold() {
    const sab = game.sabotage;
    if (!sab) return;
    const ready = sab.slots.length > 0 && sab.slots.every((s) => s.playerId && s.codeVerified);
    const allHolding = ready && sab.slots.every((s) => s.holding);

    if (allHolding) {
      if (!sab.simulHoldSince) sab.simulHoldSince = Date.now();
      const elapsedMs = Date.now() - sab.simulHoldSince;
      io.emit("sabotage:holdProgress", { elapsedMs: Math.min(elapsedMs, SABOTAGE_HOLD_MS), neededMs: SABOTAGE_HOLD_MS });
      if (elapsedMs >= SABOTAGE_HOLD_MS) {
        game.sabotage = null;
        io.emit("sabotage:resolved", {});
      }
    } else if (sab.simulHoldSince) {
      sab.simulHoldSince = null;
      io.emit("sabotage:holdProgress", { elapsedMs: 0, neededMs: SABOTAGE_HOLD_MS, reset: true });
    }
  }

  // ---- Meetings (Red Alert) ----
  // A Red Alert can be called from any station terminal at any time during an
  // active round — no per-player limit, no "who called it" tracking. It's how
  // a found body gets reported: someone walks to the nearest terminal and hits
  // the button. Every terminal in the house immediately flips to the alert
  // screen, interrupting whatever task was in progress there (it isn't marked
  // done — that player has to start it over once the round resumes).
  function triggerRedAlert(section) {
    if (game.phase !== "active") return { ok: false, message: "No active round." };
    if (game.sabotage) {
      // A Red Alert interrupts any in-progress sabotage — tell every client
      // explicitly (rather than just going quiet) so station terminals drop
      // their sabotage corner badge/console and the dashboard's sabotage
      // block clears instead of sitting stale until the round resumes.
      game.sabotage = null;
      io.emit("sabotage:resolved", { interrupted: true });
    }
    game.phase = "meeting";
    game.meeting = {
      calledBy: section ? `Reported from ${section}` : "Red Alert",
      phase: "gather",
      deadline: Date.now() + MEETING_GATHER_MS,
      votes: new Map(),
    };
    io.emit("meeting:started", {
      calledBy: game.meeting.calledBy,
      phase: "gather",
      deadline: game.meeting.deadline,
    });
    broadcastLobby();
    return { ok: true };
  }

  function advanceMeeting() {
    const m = game.meeting;
    if (!m) return;
    if (Date.now() < m.deadline) return;

    if (m.phase === "gather") {
      m.phase = "discuss";
      m.deadline = Date.now() + MEETING_DISCUSS_MS;
      io.emit("meeting:phase", { phase: "discuss", deadline: m.deadline });
    } else if (m.phase === "discuss") {
      m.phase = "vote";
      m.deadline = Date.now() + MEETING_VOTE_MS;
      io.emit("meeting:phase", { phase: "vote", deadline: m.deadline });
    } else if (m.phase === "vote") {
      const tally = {};
      for (const target of m.votes.values()) {
        tally[target] = (tally[target] || 0) + 1;
      }
      let ejectedId = null;
      let top = 0;
      let tie = false;
      // "skip" competes like any other target: if it wins or ties for the most
      // votes, no one is ejected.
      for (const [target, count] of Object.entries(tally)) {
        if (count > top) {
          top = count;
          ejectedId = target;
          tie = false;
        } else if (count === top) {
          tie = true;
        }
      }
      let ejectedName = null;
      if (ejectedId && !tie) {
        const p = game.players.get(ejectedId);
        if (p) {
          p.alive = false;
          p.cause = "ejected";
          ejectedName = p.name;
        }
      }
      m.phase = "results";
      m.deadline = Date.now() + MEETING_RESULTS_MS;
      broadcastLobby();
      io.emit("meeting:phase", {
        phase: "results",
        deadline: m.deadline,
        tally,
        ejectedName,
        skipped: !ejectedName,
      });
    } else if (m.phase === "results") {
      game.meeting = null;
      game.phase = "active";
      io.emit("meeting:ended", {});
      checkWinConditions();
      broadcastProgress();
      broadcastLobby();
    }
  }

  // ---- Game lifecycle ----
  function startGame() {
    const players = [...game.players.values()];
    if (players.length < 3) return { ok: false, message: "Need at least 3 players." };

    const configured = sanitizeSections(game.sections);
    if (configured.length < MIN_SECTIONS) {
      return { ok: false, message: `Set up at least ${MIN_SECTIONS} sections (rooms) first.` };
    }

    // Only sections with an actual terminal connected right now can end up
    // with a task on them — that's what guarantees every task handed out is
    // physically reachable, whether you've got a device for every configured
    // section or only enough for a handful of them.
    const staffed = staffedSections(configured);
    if (staffed.length < MIN_SECTIONS) {
      return {
        ok: false,
        message: `Only ${staffed.length} of your ${configured.length} selected sections have a terminal connected right now — open at least ${MIN_SECTIONS} terminals (or select fewer sections) before starting.`,
      };
    }
    if (!staffed.includes(game.electricalSection) || !staffed.includes(game.reactorSection)) {
      return { ok: false, message: "The Electrical and Reactor sections both need a terminal connected before you can start." };
    }

    const inPlay = sectionsForRound();
    const shuffledTypes = shuffle(TASK_TYPES);
    game.sectionTaskMap = {};
    inPlay.forEach((section, i) => {
      game.sectionTaskMap[section] = shuffledTypes[i % shuffledTypes.length];
    });

    const impostor = players[Math.floor(Math.random() * players.length)];
    game.phase = "active";
    game.sabotage = null;
    game.meeting = null;
    game.winner = null;

    for (const p of players) {
      p.alive = true;
      p.cause = null;
      p.roleSeen = false;
      if (p.id === impostor.id) {
        p.role = "impostor";
        p.tasks = [];
        p.fakeTasks = buildTaskList(shuffle(inPlay));
      } else {
        p.role = "crewmate";
        p.tasks = buildTaskList(shuffle(inPlay));
        p.fakeTasks = [];
      }
    }

    io.emit("game:started", { sections: inPlay });
    broadcastLobby();
    broadcastProgress();
    return { ok: true };
  }

  function resetGame() {
    // Same name, same PIN — a player only gets a new one if they leave the
    // roster and register again from scratch (a new registration = a new id).
    const keep = [...game.players.values()].map((p) => ({ id: p.id, name: p.name, pin: p.pin }));
    const sections = game.sections;
    game = freshGame(sections);
    for (const p of keep) {
      game.players.set(p.id, {
        id: p.id,
        name: p.name,
        pin: p.pin,
        role: null,
        alive: true,
        cause: null,
        roleSeen: false,
        tasks: [],
        fakeTasks: [],
      });
    }
    broadcastLobby();
    io.emit("game:reset", {});
  }

  const ticker = setInterval(() => {
    tickSabotage();
    tickSabotageHold();
    advanceMeeting();
  }, 500);

  // ---------------------------------------------------------------------------
  // Socket handlers
  // ---------------------------------------------------------------------------
  io.on("connection", (socket) => {
    socket.data.isHost = false;
    socket.data.isStation = false;
    socket.data.section = null;

    socket.emit("lobby:update", lobbyPayload());
    if (game.phase !== "lobby") {
      socket.emit("progress:update", progressSummary());
      if (game.sabotage) {
        socket.emit("sabotage:started", {
          kind: game.sabotage.kind,
          label: game.sabotage.label,
          deadline: game.sabotage.deadline,
          needs: game.sabotage.needs,
          section: game.sabotage.section,
          holdMs: SABOTAGE_HOLD_MS,
        });
        socket.emit("sabotage:slots", { slots: publicSabotageSlots() });
      }
      if (game.meeting) {
        socket.emit("meeting:started", {
          calledBy: game.meeting.calledBy,
          phase: game.meeting.phase,
          deadline: game.meeting.deadline,
        });
      }
    }

    socket.on("host:join", () => {
      socket.data.isHost = true;
      socket.emit("lobby:update", lobbyPayload());
      socket.emit("progress:update", progressSummary());
    });

    // Emergency "I forgot my PIN" recovery — only the host can trigger this,
    // and the new PIN is only ever sent back to the host's own screen (never
    // broadcast), so it doesn't undermine the whole point of having one.
    socket.on("host:resetPlayerPin", ({ playerId }, ack) => {
      if (!socket.data.isHost) return;
      const p = game.players.get(playerId);
      if (!p) { if (ack) ack({ ok: false, message: "Player not found." }); return; }
      p.pin = makeUniquePin();
      if (ack) ack({ ok: true, name: p.name, pin: p.pin });
    });

    socket.on("host:setSections", (sections) => {
      if (!socket.data.isHost || game.phase !== "lobby") return;
      const clean = sanitizeSections(sections);
      if (clean.length < MIN_SECTIONS) {
        socket.emit("host:error", { message: `Need at least ${MIN_SECTIONS} sections.`, context: "sections" });
        return;
      }
      game.sections = clean;
      broadcastLobby();
    });

    socket.on("host:start", () => {
      const result = startGame();
      if (!result.ok) socket.emit("host:error", { ...result, context: "start" });
    });

    socket.on("host:reset", () => {
      resetGame();
    });

    socket.on("host:advanceMeeting", () => {
      if (!socket.data.isHost) return;
      if (game.meeting) game.meeting.deadline = Date.now();
    });

    // ---- Station terminals (the only player-facing device) ----
    // No human ever picks a section. A terminal that already remembers a
    // still-valid section (localStorage, or a legacy ?section= link) keeps
    // it — that's what stops a device from getting reshuffled to a new room
    // every time the page reloads. BUT that remembered section only counts if
    // no *other* terminal currently holds it — two devices that each
    // separately remember "Electrical" from an earlier solo test (e.g. the
    // server got restarted between test runs, so each one was "the first
    // terminal" at some point and both happened to land there) must not both
    // get to sit on it forever once they're actually on the network together.
    // Anything else — first launch, a section the host removed, or a
    // remembered section someone else already has — gets freshly
    // auto-assigned server-side.
    //
    // A terminal also sends this on every reconnect, usually before the server
    // has noticed its old connection died (that can take up to ~45s). Dropping
    // that old socket first is what lets it keep its room instead of being
    // bumped off its own section mid-round.
    //
    // Before a round, a remembered section also gives way to a higher-priority
    // one nobody has yet, so tonight's devices always cover the main sections
    // first even if one of them sat in Medbay last time. A ?section= link
    // (`pinned`) is an explicit choice and stays put. Mid-round a terminal never
    // moves this way, since players' routes depend on it.
    socket.on("station:join", ({ section, terminalId, room, pinned }) => {
      socket.data.isStation = true;
      socket.data.terminalId = terminalId ? String(terminalId) : null;
      socket.data.room = cleanRoom(room);
      dropOldConnections(socket);
      section = String(section || "").trim();
      const rememberedIsValid = !!section && game.sections.includes(section);
      const rememberedIsTaken = rememberedIsValid && (sectionTerminals.get(section) || new Set()).size > 0;
      const best = pickSectionForNewTerminal();
      const rejoining = Date.now() - startedAt < REJOIN_GRACE_MS;
      const betterIsOpen = game.phase === "lobby" && !pinned && !rejoining && sectionRank(best) < sectionRank(section);
      if (!rememberedIsValid || rememberedIsTaken || betterIsOpen) {
        section = best;
      }
      socket.data.section = section || null;
      if (section) {
        addTerminal(section, socket.id);
        recordRoom(socket);
      }
      socket.emit("lobby:update", lobbyPayload());
      socket.emit("station:info", {
        section: socket.data.section,
        taskType: section && game.sectionTaskMap ? game.sectionTaskMap[section] : null,
        validSection: section ? game.sections.includes(section) : null,
      });
      if (section) broadcastLobby(); // let the host see this terminal come online right away
    });

    // The "change" button on a terminal — releases whatever section it had
    // and gets handed a fresh auto-assigned one (excluding the one it just
    // left, when another option exists). No typing, no dropdown.
    socket.on("station:reassignSection", (_data, ack) => {
      const prev = socket.data.section;
      if (prev) removeTerminal(prev, socket.id);
      const next = pickSectionForNewTerminal(prev);
      socket.data.section = next || null;
      socket.data.isStation = true;
      if (next) {
        addTerminal(next, socket.id);
        recordRoom(socket);
      }
      broadcastLobby();
      const payload = { section: next, taskType: next && game.sectionTaskMap ? game.sectionTaskMap[next] : null };
      socket.emit("station:info", payload);
      if (ack) ack({ ok: true, ...payload });
    });

    // One tap on the terminal: which real room of the house this device is in.
    socket.on("station:setRoom", ({ room }) => {
      socket.data.room = cleanRoom(room);
      recordRoom(socket);
      broadcastLobby();
    });

    // Generic PIN check, reused for the "tap your own name" self-identify
    // step in voting so it gets the same immediate feedback as everything
    // else — the actual action handlers below re-check the PIN themselves
    // too, so this alone never being called can't skip the real check.
    socket.on("station:verifyPin", ({ playerId, pin }, ack) => {
      if (!ack) return;
      const p = game.players.get(playerId);
      ack({ ok: checkPin(p, pin) });
    });

    // Join the game roster from this terminal, lobby only.
    socket.on("station:register", ({ name }, ack) => {
      name = (name || "").trim().slice(0, 24) || "Player";
      if (game.phase !== "lobby") {
        if (ack) ack({ ok: false, message: "A round is already in progress. Ask the host to reset." });
        return;
      }
      const dupe = [...game.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
      if (dupe) {
        if (ack) ack({ ok: false, message: "That name's taken — try initials or a nickname." });
        return;
      }
      const id = newId();
      const pin = makeUniquePin();
      game.players.set(id, {
        id,
        name,
        pin,
        role: null,
        alive: true,
        cause: null,
        roleSeen: false,
        tasks: [],
        fakeTasks: [],
      });
      broadcastLobby();
      if (ack) ack({ ok: true, playerId: id, name, pin });
    });

    // Log in at any station terminal: reveals your role the first time,
    // silently confirms it on every later login so the terminal knows whether
    // to show the Sabotage shortcut. Since the terminal keypad asks for a PIN
    // and nothing else — no "tap your name" step anymore — a bare PIN alone
    // (no playerId) identifies you: makeUniquePin() guarantees no two players
    // ever share one, so the PIN alone is enough to look someone up safely.
    // A playerId + PIN pair (the older "tap your name, then confirm" shape) is
    // still accepted too, for any other caller that already knows who it's
    // asking about.
    socket.on("station:revealRole", ({ playerId, pin }, ack) => {
      if (!ack) return;
      pin = String(pin == null ? "" : pin).trim();
      let p;
      if (playerId) {
        p = game.players.get(playerId);
        if (!p || game.phase !== "active" || !p.role) {
          ack({ ok: false, message: "Not available right now." });
          return;
        }
        if (!checkPin(p, pin)) {
          ack({ ok: false, wrongPin: true, message: "Wrong PIN — try again." });
          return;
        }
      } else {
        p = pin ? [...game.players.values()].find((pl) => pl.pin === pin) : null;
        if (!p) {
          ack({ ok: false, wrongPin: true, message: "PIN not recognized." });
          return;
        }
        if (game.phase !== "active" || !p.role) {
          // The PIN was real — just not usable right now (round hasn't
          // started yet, or already ended). Distinct from "PIN not
          // recognized" so a keypad login caught in that split-second phase
          // transition doesn't look like a typo.
          ack({ ok: false, message: "Not available right now." });
          return;
        }
      }
      const firstTime = !p.roleSeen;
      p.roleSeen = true;
      if (p.role === "impostor") {
        ack({
          ok: true,
          firstTime,
          playerId: p.id,
          name: p.name,
          role: "impostor",
          tasks: p.fakeTasks,
          sabotageKinds: Object.entries(SABOTAGE_KINDS).map(([k, v]) => ({
            kind: k,
            label: v.label,
            needs: v.needs,
            section: k === "critical" ? game.reactorSection : game.electricalSection,
          })),
        });
      } else {
        ack({ ok: true, firstTime, playerId: p.id, name: p.name, role: "crewmate", tasks: p.tasks });
      }
    });

    // Tasks are handed out strictly in the order they were assigned — a
    // player can't skip ahead to whichever section is nearest or matches a
    // friend's. Each player's order was independently shuffled at round
    // start, so this is also what keeps a group of friends from just walking
    // the house together doing the same rooms in the same sequence: only
    // whoever's NEXT task actually matches the room they're standing in gets
    // handed one.
    socket.on("station:requestTask", ({ playerId }, ack) => {
      const section = socket.data.section;
      const p = game.players.get(playerId);
      if (!ack) return;
      if (!p || !section || game.phase !== "active" || !canWork(p)) {
        ack({ ok: false, message: "Nothing to do here right now." });
        return;
      }
      const list = taskListFor(p) || [];
      const nextPending = list.find((t) => !t.done);
      if (!nextPending) {
        ack({ ok: true, none: true, allDone: true });
        return;
      }
      if (nextPending.section !== section) {
        ack({ ok: true, none: true, nextSection: nextPending.section, allDone: false });
        return;
      }
      ack({ ok: true, task: nextPending });
    });

    socket.on("station:completeTask", ({ playerId, instanceId }, ack) => {
      const p = game.players.get(playerId);
      if (!p || game.phase !== "active" || !canWork(p)) {
        if (ack) ack({ ok: false });
        return;
      }
      const list = taskListFor(p) || [];
      const t = list.find((t) => t.instanceId === instanceId);
      if (t) t.done = true;
      broadcastProgress();
      checkWinConditions();
      const nextPending = list.find((t) => !t.done);
      if (ack) ack({ ok: true, nextSection: nextPending ? nextPending.section : null, allDone: !nextPending });
    });

    socket.on("station:sabotage", ({ playerId, kind }, ack) => {
      const p = game.players.get(playerId);
      if (!p || p.role !== "impostor" || !p.alive) {
        if (ack) ack({ ok: false, message: "Not available." });
        return;
      }
      const result = triggerSabotage(kind);
      if (ack) ack(result);
    });

    // Claim an open console at the sabotage's assigned section. Only works
    // from the terminal that IS that section — this is what forces someone to
    // physically go there instead of fixing it from wherever they're standing.
    // Claiming with a verified PIN is the whole check now — no separate
    // "read a code, type it back" step (see the comment above triggerSabotage
    // for why that was dropped) — so the hold button unlocks immediately.
    socket.on("station:sabotageClaimSlot", ({ playerId, pin }, ack) => {
      if (!ack) return;
      const sab = game.sabotage;
      const p = game.players.get(playerId);
      if (!sab || !p || !canWork(p) || socket.data.section !== sab.section) {
        ack({ ok: false, message: "Nothing to fix here right now." });
        return;
      }
      if (!checkPin(p, pin)) {
        ack({ ok: false, wrongPin: true, message: "Wrong PIN — try again." });
        return;
      }
      if (sab.slots.some((s) => s.playerId === playerId)) {
        ack({ ok: false, message: "You're already on a console." });
        return;
      }
      const slotIndex = sab.slots.findIndex((s) => !s.playerId);
      if (slotIndex === -1) {
        ack({ ok: false, message: "Every console here is already taken." });
        return;
      }
      sab.slots[slotIndex] = { playerId, codeVerified: true, holding: false };
      broadcastSabotageSlots();
      ack({ ok: true, slotIndex, holdMs: SABOTAGE_HOLD_MS });
    });

    // No ack — this fires rapidly on pointerdown/pointerup while holding.
    socket.on("station:sabotageHold", ({ playerId, slotIndex, holding }) => {
      const sab = game.sabotage;
      const slot = sab && sab.slots[slotIndex];
      if (!sab || !slot || slot.playerId !== playerId || !slot.codeVerified) return;
      slot.holding = !!holding;
      broadcastSabotageSlots();
    });

    // Anyone, at any terminal, can call a Red Alert during an active round.
    socket.on("station:redAlert", (_payload, ack) => {
      const result = triggerRedAlert(socket.data.section);
      if (ack) ack(result);
      else if (!result.ok) socket.emit("host:error", { ...result, context: "redalert" });
    });

    // Declaring someone dead is how a found body becomes official — it's what
    // actually marks them a Ghost server-side. Whoever's reporting it PINs in
    // as themselves first, same as any other name-tap.
    socket.on("station:declareDead", ({ targetId, reporterId, pin }, ack) => {
      if (!game.meeting || game.meeting.phase === "results") {
        if (ack) ack({ ok: false, message: "No active Red Alert." });
        return;
      }
      const reporter = game.players.get(reporterId);
      if (!checkPin(reporter, pin)) {
        if (ack) ack({ ok: false, wrongPin: true, message: "Wrong PIN — try again." });
        return;
      }
      const target = game.players.get(targetId);
      if (!target || !target.alive) {
        if (ack) ack({ ok: false, message: "Already handled." });
        return;
      }
      target.alive = false;
      target.cause = "declared";
      io.emit("meeting:deadDeclared", { id: target.id, name: target.name });
      broadcastLobby();
      broadcastProgress();
      checkWinConditions();
      if (ack) ack({ ok: true });
    });

    socket.on("station:vote", ({ playerId, target, pin }, ack) => {
      const p = game.players.get(playerId);
      if (!p || !p.alive || !game.meeting || game.meeting.phase !== "vote") {
        if (ack) ack({ ok: false, message: "Can't vote right now." });
        return;
      }
      if (!checkPin(p, pin)) {
        if (ack) ack({ ok: false, wrongPin: true, message: "Wrong PIN — try again." });
        return;
      }
      game.meeting.votes.set(p.id, target);
      io.emit("meeting:voteCount", { count: game.meeting.votes.size, of: livingPlayers().length });
      if (game.meeting.votes.size >= livingPlayers().length) {
        game.meeting.deadline = Date.now(); // everyone's in — no need to wait out the clock
      }
      if (ack) ack({ ok: true });
    });

    socket.on("disconnect", () => {
      if (socket.data.section) {
        removeTerminal(socket.data.section, socket.id);
        broadcastLobby();
      }
    });
  });

  return { stop() { clearInterval(ticker); } };
}

return { attach };
});
