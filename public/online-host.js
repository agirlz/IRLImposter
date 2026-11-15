// Online mode, host side: runs the game rules (game-core.js) in this browser
// tab and relays them to every phone through a Supabase channel. See
// transport.js for the message format.
//
// game-core.js expects a socket.io server, so this builds a small stand-in
// with the same shape: on("connection"), emit() to everyone, sockets.sockets,
// and one socket per connected phone. The host page's own UI (host.js) gets a
// socket here too, wired straight in with no network in between.
//
// This tab IS the game server: if it closes or the phone sleeps, the game
// stops, so it asks the screen to stay on.
(function () {
  function start() {
    var code = IRLRoom.saved();
    if (code.length !== 4) code = IRLRoom.fresh();
    IRLRoom.remember(code);
    var url = new URL(location.href);
    url.searchParams.set("room", code);
    history.replaceState(null, "", url);

    // ---- The socket.io stand-in game-core.js runs on ----
    var sockets = new Map();
    var onConnection = [];
    var outbox = [];
    var flushTimer = null;
    var channel = null;
    var subscribed = false;

    function queue(msg) {
      outbox.push(msg);
      // Batch everything from one burst of game activity into a single
      // broadcast — far fewer messages through Supabase.
      if (!flushTimer) flushTimer = setTimeout(flush, 30);
    }
    function flush() {
      flushTimer = null;
      if (!subscribed || !outbox.length) return;
      var batch = outbox;
      outbox = [];
      channel.send({ type: "broadcast", event: "h2c", payload: { batch: batch } });
    }

    function makeSocket(id, deliver) {
      var handlers = {};
      var s = {
        id: id,
        data: {},
        connected: true,
        local: false,
        on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
        emit: function (ev, data) {
          if (!s.connected) return;
          if (deliver) deliver(ev, data);
          else queue({ to: id, kind: "ev", ev: ev, data: data });
        },
        disconnect: function () {
          if (!s.connected) return;
          s.connected = false;
          sockets.delete(id);
          s.dispatch("disconnect");
        },
        dispatch: function (ev, payload, ack) {
          (handlers[ev] || []).forEach(function (fn) {
            // One bad message must never take the whole game down.
            try { fn(payload, ack); } catch (e) { console.error("[host] " + ev + " failed:", e); }
          });
        },
      };
      return s;
    }
    function addSocket(id, deliver) {
      var s = makeSocket(id, deliver);
      sockets.set(id, s);
      onConnection.forEach(function (fn) { fn(s); });
      return s;
    }

    var io = {
      sockets: { sockets: sockets },
      on: function (ev, fn) { if (ev === "connection") onConnection.push(fn); },
      emit: function (ev, data) {
        queue({ to: "*", kind: "ev", ev: ev, data: data });
        if (localSocket) localSocket.deliver(ev, data);
      },
    };

    // Timing tunables can be shortened from the URL (?tune=MEETING_VOTE_MS:5000)
    // for testing; a normal game never sets them.
    var env = {};
    (new URLSearchParams(location.search).get("tune") || "").split(",").forEach(function (pair) {
      var kv = pair.split(":");
      if (kv.length === 2) env[kv[0]] = kv[1];
    });
    IRLGameCore.attach(io, { env: env });

    // ---- The host page's own socket (host.js), no network involved ----
    var localHandlers = {};
    var localSocket = {
      room: code,
      online: true,
      on: function (ev, fn) { (localHandlers[ev] = localHandlers[ev] || []).push(fn); return localSocket; },
      deliver: function (ev, data) {
        (localHandlers[ev] || []).slice().forEach(function (fn) { fn(data); });
      },
      emit: function (ev, payload, ack) {
        if (typeof payload === "function") { ack = payload; payload = undefined; }
        setTimeout(function () {
          inner.dispatch(ev, payload === undefined ? null : payload, ack ? function (d) { setTimeout(function () { ack(d); }); } : undefined);
        });
        return localSocket;
      },
    };
    var inner = addSocket("host-local", function (ev, data) { localSocket.deliver(ev, data); });
    inner.local = true;

    // ---- The Supabase channel ----
    channel = IRLSupabase().channel("irl-" + code, {
      config: { broadcast: { self: false }, presence: { key: "host" } },
    });
    channel.on("broadcast", { event: "c2h" }, function (msg) {
      var m = msg.payload || {};
      if (!m.from) return;
      var s = sockets.get(m.from);
      if (m.kind === "hello") {
        queue({ to: m.from, kind: "welcome" });
        if (!s) addSocket(m.from, null);
        return;
      }
      if (!s) {
        // Someone from before a host reload — have them start over.
        queue({ to: m.from, kind: "rehello" });
        return;
      }
      var ack = m.ackId ? function (data) { queue({ to: m.from, kind: "ack", ackId: m.ackId, data: data }); } : undefined;
      s.dispatch(m.ev, m.payload, ack);
    });
    channel.on("presence", { event: "leave" }, function (ev) {
      var s = sockets.get(ev.key);
      if (s && !s.local) s.disconnect();
    });
    channel.subscribe(function (status) {
      if (status === "SUBSCRIBED") {
        subscribed = true;
        channel.track({ t: "host" });
        // A reloaded host knows nobody yet; phones that never noticed it
        // was gone are told to say hello again.
        queue({ to: "*", kind: "rehello" });
        flush();
        // Two host pages on one room code would fight over the game.
        setTimeout(function () {
          var hosts = (channel.presenceState().host || []).length;
          if (hosts > 1) localSocket.deliver("host:error", { message: "Another host page is already running room " + code + ". Close one of them.", context: "start" });
        }, 2500);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        subscribed = false;
        localSocket.deliver("online:status", { ok: false });
      }
    });

    keepAwake();
    return localSocket;
  }

  // The rules run on timers in this tab, and a phone's browser slows those
  // right down once the screen sleeps.
  function keepAwake() {
    var lock = null;
    function request() {
      if (!navigator.wakeLock || document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then(function (l) { lock = l; }).catch(function () {});
    }
    document.addEventListener("visibilitychange", request);
    request();
  }

  window.IRLOnlineHost = { start: start };
})();
