# IRL Imposter

A real-life Among Us–style party game. There are **no personal phones** in
this design — every device is a stationary **station terminal** placed in
one room of the house. Players walk up to whichever terminal is nearest to
join, see their role, do a task, sabotage, call a Red Alert, declare someone
dead, or vote. Everything syncs live across every terminal in real time. No
accounts, no app installs — it all runs in a browser.

## Two ways to play

**Online (no installs):** open **https://agirlz.github.io/IRLImposter/**.
One device taps **Host a game** and gets a 4-letter room code; every station
phone taps **Join a game** and types it (or opens the station link the host
screen shows). On Android, Chrome's menu → *Add to Home screen* makes it an
icon. Every push to `main` republishes the site through GitHub Actions, so
phones pick up changes the next time the page loads — nothing to reinstall.

- The host's page **runs the game**: keep it open, plugged in, with the
  screen on (it asks the screen to stay awake). If it closes, the round is
  lost; reopening it keeps the same room code and stations reconnect.
- Phones need internet. Supabase (the same project Upped uses) only relays
  messages between them — this game stores nothing in its database.
- Anyone with developer tools open on a station could read other players'
  roles from those messages. Fine for a family party; not anti-cheat.

**Offline (house Wi-Fi only):** run `npm start` on a laptop, or use the
Android app, which runs the same server inside the host phone. The rest of
this README describes that setup. Both use the same game rules
(`public/game-core.js`) and pages.

## Tests

`npm test` runs the browser suites against the offline server (Microsoft
Edge must be installed; no other download). `npm run test:online` plays a
short game through the real Supabase relay and needs internet.

## How it works

- **You (the host)** run this server on a laptop before the party, and use
  the host dashboard as your own control screen (it's not a player device)
  to set up sections and start/reset rounds. **Electrical** and **Reactor**
  are always two of those sections — that's simply where Lights Out and
  Reactor Meltdown get fixed, nothing to configure.
- **Station terminals**: for every room you want in play, just open the
  station page on a device (an old phone, tablet, or laptop) and leave it
  there — the terminal **auto-assigns itself a section**, no one has to
  pick or coordinate who takes which room.
- **Players never get a personal device.** Joining happens once, by typing
  your name at any terminal's front screen before the round starts — right
  after, you land on a **Lobby** screen showing who else has joined and
  which "sections of the ship" are in play tonight (each with the same
  icon/color its own terminal uses), plus one-tap links into the tutorial
  or practice games. Tap **Continue** to hand the terminal back to the join
  screen for the next player. From then on, every terminal shows a big
  on-screen number **PIN keypad** — no name list, no text keyboard — and
  typing your 3-digit PIN there identifies you and logs you straight into
  your current task. Each keypress gives a short vibration + beep.
  Voting, declaring a body, and claiming a sabotage console still start by
  tapping a target's name (since those need to pick *someone else*),
  followed by the same PIN keypad to confirm it's really you.
- **Every terminal has its own color and icon** — a thick colored border and
  a matching icon (⚡ Electrical, ☢ Reactor, ⚙️ Engineering, and so on) so a
  room's terminal is recognizable at a glance, and a young or non-reading
  player can find "their" station by color alone.
- **Before the round starts**, the front screen (and the new Lobby screen —
  see above) also offer a **tutorial** — a 7-slide walkthrough covering the
  whole night in order: joining, everyone spreading out to a different
  room, logging in with your PIN, crew vs. impostor roles, getting directed
  station to station, always logging out, and impostor sabotage — with
  Back/Next, a dot tracker, and a Close button reachable from any slide —
  and **Practice Games**, free play for all 5 task mini-games with no
  effect on the real game, so everyone can get comfortable with the
  controls before it counts. Neither is available once a round is
  underway.
- **Your role stays hidden.** A logged-in screen looks the same for crew and
  Impostor. The first time you log in, press and hold to see your role; after
  that, press and hold **Private** for a second to see it again. That's also
  where the Impostor's Sabotage button lives. It closes by itself after a few
  seconds, so it can't be left showing.
- **Logging out is explicit.** As soon as a task is done (or you're told
  there's nothing for you here), the screen shows your next room and a big
  **LOG OUT NOW** button. That returns the terminal to the PIN keypad so
  nobody else reads your screen.
- **Every screen uses real room names.** The first time a terminal starts, it
  asks "Where is this screen?" and you tap the room once. The device remembers
  it, and its big title, your next assignment, and every sabotage warning all
  say **Kitchen** rather than leaving you to remember where Engineering is.
- **Any station terminal can also check progress.** There's a small
  "Dashboard" button in the corner of every station screen — tapping it
  shows a read-only view of the same live status the host dashboard shows
  (crew progress, section staffing, any active sabotage or meeting, the
  player list) without needing a second dedicated device just to peek at
  how the round's going. It's read-only on purpose: setting up sections,
  sabotage locations, and starting/resetting the round still only happen
  from the actual host dashboard, so nobody accidentally (or mischievously)
  resets the round mid-game from their pocket.

Everyone (laptop + every station terminal) needs to be on the **same Wi-Fi
network**. No internet connection is required.

## Setup (before the party)

1. Install [Node.js](https://nodejs.org) if you don't already have it (v18+).
2. Open a terminal in this folder (the one with `package.json` in it, not the
   `public` subfolder) and run:
   ```
   npm install
   npm start
   ```
3. The terminal will print something like:
   ```
   Host screen:   http://<this-computer's-LAN-IP>:3000/host.html
   Station (any room, auto-assigned): http://<this-computer's-LAN-IP>:3000/station.html
   ```
   Find your computer's actual LAN IP (System Settings → Wi-Fi → Details on
   Mac, or `ipconfig` on Windows) and swap it in — it'll look like
   `192.168.1.42`. Every station device opens the exact same address — there's
   nothing per-room to type differently.
4. Make sure your laptop's firewall allows incoming connections on port 3000.

## Setting up station terminals

Decide which "sections of the ship" — really just rooms of the house, named
however you like — will have a station. The host dashboard's **Sections**
panel lists them as checkboxes (a themed default set you can tick on or off,
plus an "Add a custom section" box for anything else — any room can be any
section, the names are just flavor), except **Electrical** and **Reactor**,
which are fixed rows that are always included — those are the two sabotage
locations (Lights Out and Reactor Meltdown) and there's no toggle for them.
Each section becomes one fixed task type for the whole round, and every
player gets exactly one task per section — so with 5 sections, everyone has
a 5-stop route through the house.

The host dashboard also shows a **Game Key** — your device's own address,
shortened to a 3-digit code. Read it out loud once at the start of the
party; everyone entering it on a station or Join screen gets connected
automatically. There's a collapsed **Network info** disclosure below it if
you ever need the raw address as a fallback — everyone taps it open only if
the game key isn't working.

**You don't need one device per section, and nobody has to decide who takes
which room.** Just open the station page (the same single link — see above)
on whatever devices you actually have. Each terminal **auto-assigns itself**
a section the instant it connects — no picker, no typing, no coordinating
with anyone else. Devices fill the sections in a fixed priority order:
**Electrical, Engineering, Reactor, Navigation, Medbay, Communications**, then
any custom sections — so with just a handful of phones you always know exactly
which sections get covered first, and both sabotage locations are guaranteed
among them. Further devices spread out evenly once every section has one.

The round size follows the player count: 3-4 players use the top 3 staffed
sections, and each extra player adds the next one. The host screen shows which
sections the round will use, next to Start Round. A section is only ever handed to one terminal at a time —
if a device remembers a room from earlier (see below) but someone else is
now sitting in it, that device gets bumped to a fresh room automatically
instead of both terminals sitting on the same one. A terminal remembers its
assigned room across reloads, so it won't reshuffle on you unnecessarily;
tap the small **change** button next to the room name if you need to move
a device to a different room later — it gets handed a fresh
auto-picked section, again with no typing involved.

If you've configured 5 sections but only have 3 phones, that's fine —
**only the sections that actually have a terminal get used when the round
starts.** The other configured sections are simply skipped for that round
(no player ever gets a task in a room with no device), so you can plan for
your ideal room count and still run the game with whatever you've actually
got plugged in that night. Starting still requires at least `MIN_SECTIONS`
(default 3) *staffed* sections, including both Electrical and Reactor — the
host dashboard will tell you exactly what's short if you try to start
without enough.

That's it — once a terminal's been assigned its room, it just sits there for
the whole game. Players do everything else by tapping the screen in front of
them:

- **Joining**: while the round hasn't started, every terminal shows a
  "Join the game" screen — anyone can type their name at any terminal to get
  into the roster. **Multiple people can join from the same terminal** —
  there's no limit tying a person to a specific device, only a device to a
  specific room. Six people can play on three phones (two names registered
  per phone) just as easily as with six.
- **Your PIN**: the moment you join, you're shown a 3-digit PIN and asked to
  remember it (or jot it down) — see **PINs** below. Every terminal asks for
  it every time you tap your name, for anything, for the rest of the night.
  Right after, you land on the **Lobby** screen — see who else has joined
  and a preview of tonight's ship sections, with links into the tutorial or
  practice games — until you tap Continue to free up the terminal.
- **Playing**: once the host starts the round, entering your PIN at a
  terminal lets you press and hold to see your role the first time, then hands
  you that room's task — *if* that room is actually next on your route (see below). Either
  way, a big "Your Next Assignment" callout tells you exactly which room to
  head to.
- **Your route is fixed and yours alone.** Each player gets their own
  independently-shuffled order through the staffed sections at the start of
  the round — you can't reshuffle it or skip ahead by choosing which room to
  walk into first. Tap in at a room that isn't next on your list and the
  station tells you it's the wrong stop and points you to the right one
  instead of handing you a task anyway. This is deliberate: it's what keeps
  a group of friends from just wandering the house together doing the same
  rooms in the same order — everyone's actually on their own path.
- **Sabotage**: the Impostor presses and holds **Private** on their logged-in
  screen to reach the Sabotage button.
- **Red Alert**: every terminal has a big Red Alert button, always
  available during the round. It's a two-tap confirm so it can't go off by
  accident.

## PINs: keeping people from peeking at each other's roles

Every terminal identifies you by PIN, not by name — so nothing lets a
curious Crewmate browse a name list and act as the Impostor just to look.
Logging in at the idle keypad screen, claiming a sabotage console, voting,
and declaring someone dead all require your private 3-digit PIN, and the
action is refused if it's wrong. Three digits is short by design — it's fast
to type and easy to remember for a party game; `makeUniquePin()` in `server.js`
is what actually guarantees no two players ever share one, looping until it
finds a code truly nobody else has.

- **You get one PIN, once, when you first join** (it's shown right after you
  type your name, with a reminder to write it down if you're not confident
  you'll remember it — there's no "forgot PIN" self-service, see below).
  Because the main terminal login is PIN-only with no name step, PINs are
  guaranteed unique across all players (the server keeps generating one
  until it finds a code nobody else already has) — otherwise two players
  sharing a PIN could log in as each other.
- **It stays the same for as long as you're in the game.** Resetting for a
  new round (**Reset for a new round** on the host screen) keeps every
  existing player's name *and* PIN exactly as it was — you only get handed a
  brand-new PIN if you fully leave and re-register as if you were a new
  player.
- **If someone forgets their PIN**, they can't recover it themselves — that's
  intentional, since a self-service reset would be exactly the loophole this
  is meant to close. Instead, the host finds their name on the host
  dashboard's player list and taps **Reset PIN** next to it; the new PIN is
  shown only on the host's own screen, for the host to relay privately.
- **Declaring someone dead is a two-part tap now**: whoever found the body
  identifies *themselves* first (name + PIN), then picks who they're
  reporting. That's one extra step versus earlier versions, but it means the
  "who found the body" record — and every other action all night — is
  actually tied to a real, PIN-verified person instead of just whoever's
  thumb happened to be nearest the screen.

## Running the game

1. Connect your laptop and every station terminal to the same Wi-Fi.
2. Open the **host dashboard** — this is your control screen. Set your
   Sections (rooms), then open the station page on each device you're
   using — every one auto-assigns itself a room, nothing to configure per
   device.
3. Have players join by typing their name into any station terminal's front
   screen and noting the PIN it shows them (there's a live roster on the
   host screen too). This is also when they can tap **View Tutorial** or
   **Practice Games** if they want to get familiar with things first.
4. Once at least 3 players have joined, tap **Start Round** on the host
   screen. From here on, roles, tasks, sabotage, and meetings are handled
   entirely at the station terminals.
5. Play! Every terminal now shows a PIN keypad. Crewmates walk the house,
   entering their PIN at each station to log in and work through their task
   route. The Impostor logs in exactly the same way and gets their own cover
   tasks (same rooms, same task types) so logging in looks identical to a
   real crewmate — the only tell is a Sabotage button only they can see. The
   Impostor eliminates Crewmates by tagging them in person — a touch,
   nothing more. **The tagged player doesn't touch any device.** They simply
   go to one knee, or lie down, right where they were tagged, and stay
   there — dead, in the scene — until someone finds them.
6. When someone finds a body, they go to the **nearest terminal and hit Red
   Alert**. Every terminal in the house immediately flips to a blinking red
   alert screen — whatever anyone was doing there (including a task in
   progress) is interrupted and has to be started over later; it is **not**
   marked complete. Gather, then discuss it out loud as a group (there's no
   in-app chat — this is all in person). At any point during the alert,
   anyone at any terminal can **declare a specific person dead**, which is
   what actually removes them from the game — tap your own name and enter
   your PIN to identify yourself as the reporter, then tap theirs; it's
   final immediately.
7. During the vote phase, tap your own name and enter your PIN at a
   terminal to cast your vote, then pick who to eject (or Skip). Most votes ejects that player on
   the spot. If Skip gets the most votes, or there's a tie for the most
   (including with Skip), no one is ejected. The host can tap **Skip to next phase** at
   any point to cut a countdown short, and the vote phase also auto-advances
   the moment every living player has voted.
8. The round ends automatically — Crewmates win by finishing every task or
   ejecting the Impostor; the Impostor wins by matching the remaining
   Crewmate count or letting a critical sabotage run out. Every terminal
   shows the final reveal.
9. Tap **Reset for a new round** on the host screen to play again — it
   reshuffles a new Impostor and fresh tasks, and keeps your saved sections.

## Sabotage: you have to actually go fix it

Sabotage now requires physically getting to a specific terminal — it isn't a
free instant fix from wherever you happen to be standing. The instant either
sabotage starts, **every terminal in the house** — whatever it's showing at
that moment — gets a corner badge with a big icon and a countdown meter that
drains from full to empty as the clock runs out, so a glance at any screen
in the house tells you something's wrong and roughly how much time is left,
even from across the room. Reactor Meltdown gets a red pulsing radiation
icon; Lights Out gets a calmer amber lightning bolt.

- **Lights Out** goes further than the corner badge: **every terminal in the
  house except Electrical's own goes fully dark**, with a simple "Lights are
  out! Head to Electrical to fix it." message and a countdown — the Red
  Alert button still works from a blacked-out terminal, in case someone
  trips over a body in the dark. It can only be fixed at the **Electrical**
  terminal: whoever gets there taps their name, confirms their PIN, and
  holds a button down — without letting go — for a few seconds until it's
  fixed. (An earlier version also made you read a short code off the screen
  and type it back in before the hold button unlocked; that's gone now —
  your PIN already proves who you are, so it was pure busywork with no real
  security benefit.)
- **Reactor Meltdown** can only be fixed at the **Reactor** terminal, and its
  terminal switches to a dedicated **officer authorization** screen while
  it's active — a big warning icon, "REACTOR MELTDOWN" in red, and two
  clearly separate **Officer 1** / **Officer 2** login panels. Each officer
  taps their own name and confirms their PIN, and then — this is the
  important part — **both have to be holding their own button down at the
  exact same moment**, continuously, for the full duration. If either person
  lets go early, the hold resets for both and they have to start over
  together. Fail to fix it before the timer runs out and the Impostor wins
  instantly. Reactor Meltdown doesn't black out the rest of the house the
  way Lights Out does — every other terminal just shows the usual small
  banner telling everyone to get to Reactor.
- The Impostor claims a console exactly the same way everyone else does, and
  the console screen never shows anyone's role — so someone glancing over a
  shoulder at the Impostor "helping" fix a sabotage sees exactly the same
  screen a Crewmate would.
- If a Red Alert interrupts a sabotage in progress, it's cancelled outright
  (not paused) — the corner badge, the Lights Out blackout, and the officer
  console all clear on every terminal the moment the alert goes out.

## Tuning the game

Open `server.js` and adjust the constants near the top (most are also
overridable via environment variables of the same name):

- `MIN_SECTIONS` / `MAX_SECTIONS` — how many rooms/sections the host can
  configure (default 3–12). Each section is one task stop per player.
- `SABOTAGE_COOLDOWN_MS` — how often the Impostor can sabotage.
- `MINOR_SABOTAGE_MS` / `CRITICAL_SABOTAGE_MS` — how long the group has to
  get to Electrical / Reactor and fix each before it expires (or, for the
  critical one, before the Impostor wins).
- `SABOTAGE_HOLD_MS` — how long the button(s) need to be held down
  continuously once every console's code is verified.
- `MEETING_GATHER_MS` / `MEETING_DISCUSS_MS` / `MEETING_VOTE_MS` /
  `MEETING_RESULTS_MS` — meeting phase lengths (any phase can also be cut
  short early by the host's "Skip to next phase" button).

## Task mini-games

Five task mini-games ship in `public/tasks/`: Conduit Patch (wire connect),
Power Cycle (hold to charge), Sequence Lock (Simon Says), Steady Hand
(keep a needle in a moving zone), and Access Code (memorize and enter a
code). Each section is randomly assigned one of these for the round, and
every player gets one task per section. The same 5 files also power
**Practice Games** on each terminal's front screen (before a round starts) —
free play with no server round-trip and no effect on the real game, so
anyone can try every game type first.

**Learn to Play, before joining anything:** `station.html?standalone=1`
loads just the View Tutorial / Practice Games screen — no join form, no
section assignment, no `station:join` sent to the server. This is meant to
be linked from the native app's very first Host Game / Join Game picker
screen (before a game key is even entered), so new players can look around
without needing a live game running yet. It's the same tutorial and
practice code as the in-game front screen, just reachable a step earlier.

To add your own task, drop a new HTML file
in `public/tasks/` that calls
`window.parent.postMessage({ type: "task-complete" }, "*")` when finished,
add it to the `TASK_TYPES` list in `server.js`, and add a matching tile to
the `PRACTICE_GAMES` list in `public/station.js`. Put `class="task-page"` on
its `<html>` tag and `class="grow"` on whichever part should take the spare
height. Every task has to fit its box with no scrolling, because the box can
be as short as 260px and drag/hold games block touch-scrolling. Check the
smallest size before shipping one (see the `.task-page` rules in `style.css`).

## If station devices suddenly can't reach the host ("connection refused")

This means the server itself stopped answering on that address — it's a
different problem than a page glitching or state looking stale. Two causes
account for almost every case:

- **The host device's screen locked or the app went to the background.**
  Some phones (Samsung in particular — its "Sleeping apps" / RAM Plus
  battery management is notorious for this) will freeze or kill a
  backgrounded app's process even while it looks like it's "still running."
  If the host device is the Android app from `BUILD-THE-APK.md`: go to
  **Settings → Apps → Amongus IRL → Battery** and set it to **Unrestricted**,
  and on Samsung specifically also check **Settings → Battery and device
  care → Background usage limits** and make sure the app is *not* listed
  under Sleeping/Deep sleeping apps (add it to **Never sleeping apps**
  instead). Keep the host device's screen on and plugged in for the whole
  party — Developer Options → **Stay awake while charging** makes this
  automatic.
- **The host device's IP address changed.** If Wi-Fi was toggled, the host
  app was fully closed and reopened, or the router just handed out a new
  lease, the game key (or address) everyone entered is stale. Check the
  current game key on the host dashboard before every round if this keeps
  happening, and re-enter it on any station device that's showing a
  connection error.

Both of the above are outside this project's code — they're phone/OS
behavior. What *is* handled in the code now: the server won't crash from an
unexpected error in any single request anymore (previously, one bad edge
case could in theory take the whole thing down for every player at once —
now it logs the error and keeps running), and it explicitly tells Android
"I'm still working" if the host app gets backgrounded, so a screen lock by
itself shouldn't be read as "close everything."

## Known limitations (it's a prototype)

- One game runs at a time; restarting the server clears all progress.
- A tagged-but-not-yet-declared player is only "dead" by agreement — the
  server has no way of knowing until someone declares it during a Red
  Alert. That's intentional: the physical staging and the group's honesty
  are the anti-cheat mechanism here, not a passphrase or a device check.
- The PIN check confirms *which registered player* is tapping — it doesn't
  verify who's physically standing at the terminal (nothing stops someone
  from telling a friend their PIN). Tagging itself is still pure honor
  system, same as always — there's no way for the server to know a tag
  happened until someone reports it.
- The server keeps everything in memory — no database, no persistence
  between restarts.
