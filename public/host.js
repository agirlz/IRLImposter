// Offline this talks to server.js on the Wi-Fi; online, this tab runs the
// game itself (see online-host.js).
const socket = connectGame({ host: true });
socket.emit("host:join");

$("#joinHint").textContent = "Players join and play entirely from station terminals placed around the house — every device auto-assigns itself a room, so just open a station on each one and go.";

$("#startBtn").addEventListener("click", () => socket.emit("host:start"));
$("#resetBtn").addEventListener("click", () => socket.emit("host:reset"));
$("#skipMeetingBtn").addEventListener("click", () => socket.emit("host:advanceMeeting"));

// ---- Sections: fixed Electrical/Reactor + preset checkboxes + custom chips ----
// Electrical and Reactor are mandatory — the server always includes them no
// matter what's saved here, since that's where sabotage locations live now.
// They're shown as fixed rows (not checkboxes) so there's nothing to
// accidentally uncheck. Mirrors server.js's DEFAULT_SECTIONS otherwise.
const FIXED_SECTIONS = ["Electrical", "Reactor"];
const PRESET_SECTIONS = ["Engineering", "Navigation", "Medbay", "Communications"];

let sectionsDirty = false;
let checkedPresets = new Set(PRESET_SECTIONS); // which presets are ticked
let customSections = []; // extra sections the host typed in, in add order

function currentSectionList() {
  return [...FIXED_SECTIONS, ...PRESET_SECTIONS.filter((s) => checkedPresets.has(s)), ...customSections];
}

function renderFixedSections() {
  const wrap = $("#fixedSections");
  wrap.innerHTML = "";
  FIXED_SECTIONS.forEach((name) => {
    const row = document.createElement("div");
    row.className = "chip-row";
    row.innerHTML = `<span>${escapeHtml(name)} <span class="hint">(always on)</span></span> <span class="hint" data-staffing-for="${escapeHtml(name)}"></span>`;
    wrap.appendChild(row);
  });
  applyStaffingBadges();
}

// Live count of terminals actually connected per section — this is what
// decides which sections a round can use, independent of how many are
// merely checked here. Updated on every lobby:update, redrawn immediately
// regardless of sectionsDirty (checking boxes and terminals coming online
// are two different things).
let lastStaffing = {};
let lastRooms = {};

function staffingBadgeText(name) {
  const n = lastStaffing[name] || 0;
  if (n === 0) return "no terminal yet";
  return lastRooms[name] ? `● ${lastRooms[name]}` : `● ${n} terminal${n > 1 ? "s" : ""} (no room set)`;
}

function applyStaffingBadges() {
  document.querySelectorAll("[data-staffing-for]").forEach((el) => {
    const name = el.getAttribute("data-staffing-for");
    el.textContent = staffingBadgeText(name);
    el.style.color = (lastStaffing[name] || 0) > 0 ? "var(--good)" : "var(--text-dim)";
  });
}

function renderPresetSections() {
  const wrap = $("#presetSections");
  wrap.innerHTML = "";
  PRESET_SECTIONS.forEach((name) => {
    const row = document.createElement("label");
    row.className = "check-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checkedPresets.has(name);
    cb.addEventListener("change", () => {
      sectionsDirty = true;
      if (cb.checked) checkedPresets.add(name);
      else checkedPresets.delete(name);
    });
    const span = document.createElement("span");
    span.textContent = name;
    span.style.flex = "1";
    const badge = document.createElement("span");
    badge.className = "hint";
    badge.setAttribute("data-staffing-for", name);
    row.appendChild(cb);
    row.appendChild(span);
    row.appendChild(badge);
    wrap.appendChild(row);
  });
  applyStaffingBadges();
}

function renderCustomSections() {
  const wrap = $("#customSectionsList");
  wrap.innerHTML = "";
  customSections.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "chip-row";
    row.innerHTML = `<span>${escapeHtml(name)}</span> <span class="hint" data-staffing-for="${escapeHtml(name)}"></span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      customSections.splice(i, 1);
      sectionsDirty = true;
      renderCustomSections();
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  });
  applyStaffingBadges();
}

$("#addCustomSectionBtn").addEventListener("click", () => {
  const input = $("#customSectionInput");
  const name = input.value.trim().slice(0, 30);
  if (!name) return;
  const dupe = currentSectionList().some((s) => s.toLowerCase() === name.toLowerCase());
  if (dupe) {
    $("#sectionsError").textContent = "That section's already in the list.";
    return;
  }
  $("#sectionsError").textContent = "";
  customSections.push(name);
  input.value = "";
  sectionsDirty = true;
  renderCustomSections();
});
$("#customSectionInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#addCustomSectionBtn").click(); }
});

$("#saveSectionsBtn").addEventListener("click", () => {
  $("#sectionsError").textContent = "";
  socket.emit("host:setSections", currentSectionList());
  sectionsDirty = false;
});

renderFixedSections();
renderPresetSections();
renderCustomSections();

// ---- Game key: a short stand-in for the full LAN address ----
// This page is itself reached at http://<this-device's-LAN-IP>:3000/host.html,
// so location.hostname IS that address already — no server round-trip needed.
// Online there's no address to share — just the room code, and this page has
// to stay open because it's running the game.
let lanPrefix = "";
let lanCode = "";
function stationUrl() {
  return new URL("station.html" + (socket.online ? "?room=" + socket.room : ""), location.href).href;
}
function renderServerCode() {
  if (socket.online) {
    $("#serverCodeTitle").textContent = "Room Code";
    $("#serverCodeHint").textContent = `Everyone opens ${new URL("station.html", location.href).href} on their phone and types this code. Keep this page open with the screen on — it's running the game.`;
    $("#serverCodeValue").textContent = socket.room;
    $("#serverCodePanel").hidden = false;
    return;
  }
  const host = location.hostname;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return; // not a plain IPv4 host (e.g. "localhost")
  lanPrefix = parts.slice(0, 3).join(".");
  lanCode = parts[3].padStart(3, "0");
  $("#serverCodeValue").textContent = lanCode;
  $("#serverCodePanel").hidden = false;
}
renderServerCode();
renderNetworkInfo(); // independent of whether a game key could be derived

// ---- Network info: collapsed by default — the raw IP/address, useful only
// as a fallback if the game key ever doesn't work. One entry, not six —
// every device is the same address now that sections auto-assign.
let networkInfoOpen = false;
function renderNetworkInfo() {
  const body = $("#networkInfoBody");
  body.innerHTML = "";
  const url = stationUrl();
  const row = document.createElement("div");
  row.className = "chip-row";
  row.innerHTML = `<span style="word-break:break-all;">${escapeHtml(url)}</span>`;
  const btn = document.createElement("button");
  btn.textContent = "Copy";
  btn.addEventListener("click", () => {
    navigator.clipboard?.writeText(url).catch(() => {});
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  });
  row.appendChild(btn);
  body.appendChild(row);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = socket.online
    ? "Opening this link on a phone joins this room directly, with no code to type."
    : lanPrefix
      ? `Full address: ${location.host}. Every station device uses this same address — the game key above is just a shortcut for it.`
      : "Every station device uses this same address — the game key above is just a shortcut for it.";
  body.appendChild(hint);
}
$("#networkInfoToggle").addEventListener("click", () => {
  networkInfoOpen = !networkInfoOpen;
  $("#networkInfoBody").hidden = !networkInfoOpen;
  $("#networkInfoToggle").textContent = (networkInfoOpen ? "▾" : "▸") + " Network info";
});

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

socket.on("lobby:update", ({ phase, players, sections, sectionStaffing, sectionRooms, roundSections }) => {
  $("#phaseText").textContent = phase[0].toUpperCase() + phase.slice(1);
  const inLobby = phase === "lobby";
  $("#sectionsPanel").hidden = !inLobby;
  $("#startPanel").hidden = !inLobby;
  $("#progressPanel").hidden = inLobby;

  const list = $("#playerList");
  list.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = p.name;
    const pill = document.createElement("span");
    pill.className = `pill ${p.alive ? "alive" : "dead"}`;
    pill.innerHTML = `<span class="dot"></span>${p.alive ? "in" : "out"}`;
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset PIN";
    resetBtn.style.marginLeft = "8px";
    resetBtn.addEventListener("click", () => {
      socket.emit("host:resetPlayerPin", { playerId: p.id }, (res) => {
        if (res && res.ok) alert(`New PIN for ${res.name}: ${res.pin}\n(Tell them privately.)`);
      });
    });
    li.appendChild(span);
    li.appendChild(pill);
    li.appendChild(resetBtn);
    list.appendChild(li);
  });
  $("#startBtn").disabled = players.length < 3;
  if (players.length < 3) $("#startError").textContent = "Need at least 3 players to start.";
  else $("#startError").textContent = "";

  if (sectionStaffing) {
    lastStaffing = sectionStaffing;
    lastRooms = sectionRooms || {};
    applyStaffingBadges();
  }

  $("#roundSectionsHint").textContent = roundSections && roundSections.length
    ? `With ${players.length} player${players.length === 1 ? "" : "s"}, this round uses: ${roundSections.map((s) => lastRooms[s] ? `${lastRooms[s]} (${s})` : s).join(", ")}.`
    : "";

  if (sections) {
    if (!sectionsDirty) {
      checkedPresets = new Set(sections.filter((s) => PRESET_SECTIONS.includes(s)));
      customSections = sections.filter((s) => !PRESET_SECTIONS.includes(s) && !FIXED_SECTIONS.includes(s));
      renderPresetSections();
      renderCustomSections();
    }
    renderFixedSections();
  }
});

socket.on("progress:update", (payload) => {
  const pct = payload.totalTasks ? Math.round((payload.doneTasks / payload.totalTasks) * 100) : 0;
  $("#overallBar").style.width = pct + "%";
  $("#overallText").textContent = `${payload.doneTasks}/${payload.totalTasks} crew tasks complete`;
  const list = $("#progressList");
  list.innerHTML = "";
  payload.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.alive ? "" : " (down)"}</span><span class="pill ${p.alive ? "alive" : "dead"}"><span class="dot"></span>${p.doneCount}/${p.totalCount}</span>`;
    list.appendChild(li);
  });
});

socket.on("sabotage:started", ({ label, deadline, needs, section }) => {
  $("#sabotageTitle").textContent = "Sabotage: " + label;
  $("#sabotageNeed").textContent = `Fix at ${section} — needs ${needs} player${needs > 1 ? "s" : ""} there.`;
  runCountdown($("#sabotageCountdown"), deadline);
  show($("#sabotagePanel"));
});
socket.on("sabotage:holdProgress", ({ elapsedMs, neededMs, reset }) => {
  const pct = Math.min(100, Math.round((elapsedMs / neededMs) * 100));
  $("#sabotageNeed").textContent = reset ? "Someone let go — holding has to start over." : (pct > 0 ? `Holding steady… ${pct}%` : $("#sabotageNeed").textContent);
});
socket.on("sabotage:resolved", () => hide($("#sabotagePanel")));

socket.on("meeting:started", ({ calledBy, deadline }) => {
  $("#meetingTitle").textContent = "🚨 " + (calledBy || "Red Alert");
  $("#meetingSub").textContent = "Gathering…";
  runCountdown($("#meetingCountdown"), deadline);
  show($("#meetingPanel"));
});
socket.on("meeting:phase", (payload) => {
  runCountdown($("#meetingCountdown"), payload.deadline);
  if (payload.phase === "discuss") $("#meetingSub").textContent = "Discussing…";
  else if (payload.phase === "vote") $("#meetingSub").textContent = "Voting…";
  else if (payload.phase === "results") $("#meetingSub").textContent = payload.skipped ? "No one ejected." : `${payload.ejectedName} ejected.`;
});
socket.on("meeting:ended", () => hide($("#meetingPanel")));

socket.on("game:ended", ({ winner, reason, reveal }) => {
  $("#gameoverTitle").textContent = winner === "crew" ? "Crew Wins" : "Impostor Wins";
  $("#gameoverReason").textContent = reason || "";
  const list = $("#gameoverReveal");
  list.innerHTML = "";
  reveal.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="pill">${p.role}</span>`;
    list.appendChild(li);
  });
  show($("#gameoverPanel"));
  hide($("#sabotagePanel"));
  hide($("#meetingPanel"));
});

socket.on("game:reset", () => {
  hide($("#gameoverPanel"));
  sectionsDirty = false;
});

socket.on("host:error", ({ message, context }) => {
  if (context === "sections") $("#sectionsError").textContent = message;
  else $("#startError").textContent = message;
});
