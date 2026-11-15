// How a page talks to the game — load this right after config.js, before any
// script that calls connectGame().
//
// Offline (config.online false), connectGame() is just socket.io's io(),
// talking to server.js on the Wi-Fi.
//
// Online, every phone joins a Supabase live-messaging channel named after a
// 4-letter room code. The host's browser tab runs the game rules
// (game-core.js, via online-host.js); everyone else gets a stand-in socket
// with the same on()/emit(event, payload, ack) shape as socket.io, so
// station.js and host.js don't care which setup they're in. Messages:
//   phone -> host  "c2h"  { from, kind: hello|msg, ev, payload, ackId }
//   host -> phones "h2c"  { batch: [{ to: id|"*", kind: welcome|ev|ack|rehello, ... }] }
// Presence on the channel stands in for socket connect/disconnect: the host
// tracks as "host", every other connection as its own random id.
(function () {
  var cfg = window.IRL_CONFIG || {};
  var params = new URLSearchParams(location.search);
  try { if (params.get("online") === "1") sessionStorage.setItem("irlOnline", "1"); } catch (e) {}
  var online = !!cfg.online;
  try { online = online || sessionStorage.getItem("irlOnline") === "1"; } catch (e) {}
  window.IRL_ONLINE = online;

  // Load the matching client library before the page's own scripts run.
  document.write('<script src="' + (online ? "vendor/supabase.js" : "socket.io/socket.io.js") + '"><\/script>');

  // ---- Room codes: 4 letters, none that are easy to mix up (no I or O) ----
  var ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  var ROOM_KEY = "irlRoom";
  function cleanRoom(code) {
    return String(code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  }
  function newRoomCode() {
    var s = "";
    for (var i = 0; i < 4; i++) s += ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)];
    return s;
  }
  function savedRoom() {
    var fromUrl = cleanRoom(params.get("room"));
    if (fromUrl.length === 4) return fromUrl;
    try { return cleanRoom(localStorage.getItem(ROOM_KEY)); } catch (e) { return ""; }
  }
  function rememberRoom(code) {
    try { localStorage.setItem(ROOM_KEY, code); } catch (e) {}
  }
  window.IRLRoom = { clean: cleanRoom, fresh: newRoomCode, saved: savedRoom, remember: rememberRoom };

  // One client per connection: Supabase allows a single subscription per
  // channel on a client, so two sockets sharing one would keep kicking each
  // other off the room.
  function supabaseClient() {
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      // Upped shares this web address; never touch its saved sign-in.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "irl-imposter-auth" },
      realtime: { params: { eventsPerSecond: 50 } },
    });
  }
  window.IRLSupabase = supabaseClient;

  function randomId() {
    return "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // ---- The stand-in socket every non-host page uses online ----
  function OnlineSocket() {
    var self = this;
    this.handlers = {};
    this.acks = {};
    this.ackCount = 0;
    this.queue = [];
    this.connected = false;
    this.hostHere = false;
    this.generation = 0;
    this.room = "";
    this.id = null;
    this.channel = null;
    this.client = null;
    // Same escape hatch socket.io has, so a test can force a reconnect.
    this.io = { engine: { close: function () { self.restart(); } } };
    var code = savedRoom();
    this.needsRoom = code.length !== 4;
    if (!this.needsRoom) this.joinRoom(code);
  }
  OnlineSocket.prototype.on = function (ev, fn) {
    (this.handlers[ev] = this.handlers[ev] || []).push(fn);
    return this;
  };
  OnlineSocket.prototype.off = function (ev, fn) {
    var list = this.handlers[ev] || [];
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  };
  OnlineSocket.prototype.fire = function (ev, data) {
    (this.handlers[ev] || []).slice().forEach(function (fn) { fn(data); });
  };
  OnlineSocket.prototype.emit = function (ev, payload, ack) {
    if (typeof payload === "function") { ack = payload; payload = undefined; }
    var msg = { kind: "msg", ev: ev, payload: payload === undefined ? null : payload };
    if (ack) {
      msg.ackId = ++this.ackCount;
      this.acks[msg.ackId] = ack;
    }
    // Like socket.io, anything sent before the host has said hello waits.
    if (this.connected) this.send(msg);
    else this.queue.push(msg);
    return this;
  };
  OnlineSocket.prototype.joinRoom = function (code) {
    this.room = cleanRoom(code);
    this.needsRoom = false;
    rememberRoom(this.room);
    this.open();
  };
  OnlineSocket.prototype.send = function (msg) {
    msg.from = this.id;
    this.channel.send({ type: "broadcast", event: "c2h", payload: msg });
  };
  OnlineSocket.prototype.open = function () {
    var self = this;
    var gen = ++this.generation;
    var current = function () { return gen === self.generation; };
    // A fresh id per connection, like a socket.io socket id; the host treats
    // a returning terminal by its terminalId, not this.
    this.id = randomId();
    this.hostHere = false;
    if (!this.client) this.client = supabaseClient();
    var ch = this.client.channel("irl-" + this.room, {
      config: { broadcast: { self: false }, presence: { key: this.id } },
    });
    this.channel = ch;
    ch.on("broadcast", { event: "h2c" }, function (msg) {
      if (current()) self.receive((msg.payload && msg.payload.batch) || []);
    });
    ch.on("presence", { event: "sync" }, function () {
      if (!current()) return;
      var here = !!ch.presenceState().host;
      if (here && !self.hostHere) { self.hostHere = true; self.hello(gen); }
      if (!here && self.hostHere) { self.hostHere = false; self.lost(); }
    });
    ch.subscribe(function (status) {
      if (!current()) return;
      if (status === "SUBSCRIBED") {
        ch.track({ t: "station" });
        self.hello(gen);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        self.restart();
      }
    });
  };
  // Keep saying hello until the host answers — it may not be open yet.
  OnlineSocket.prototype.hello = function (gen) {
    var self = this;
    if (gen !== this.generation || this.connected) return;
    this.send({ kind: "hello" });
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(function () { self.hello(gen); }, 2000);
  };
  OnlineSocket.prototype.lost = function () {
    if (!this.connected) return;
    this.connected = false;
    this.fire("disconnect");
  };
  OnlineSocket.prototype.restart = function () {
    var self = this;
    var old = this.channel;
    this.generation++;
    this.channel = null;
    clearTimeout(this.helloTimer);
    this.lost();
    if (old) this.client.removeChannel(old);
    setTimeout(function () { if (!self.channel) self.open(); }, 600);
  };
  OnlineSocket.prototype.receive = function (batch) {
    for (var i = 0; i < batch.length; i++) {
      var m = batch[i];
      if (m.to !== "*" && m.to !== this.id) continue;
      if (m.kind === "welcome") {
        if (this.connected) continue;
        this.connected = true;
        clearTimeout(this.helloTimer);
        var waiting = this.queue;
        this.queue = [];
        for (var j = 0; j < waiting.length; j++) this.send(waiting[j]);
        this.fire("connect");
      } else if (!this.connected) {
        continue;
      } else if (m.kind === "ev") {
        this.fire(m.ev, m.data);
      } else if (m.kind === "ack") {
        var cb = this.acks[m.ackId];
        delete this.acks[m.ackId];
        if (cb) cb(m.data);
      } else if (m.kind === "rehello") {
        // The host restarted and forgot us — say hello again as a new connection.
        this.lost();
        this.hello(this.generation);
      }
    }
  };

  // The page's way in. Host pages pass { host: true }, which (online) starts
  // the game itself in this tab via online-host.js.
  window.connectGame = function (opts) {
    if (!online) return window.io();
    if (opts && opts.host) return window.IRLOnlineHost.start();
    return new OnlineSocket();
  };
})();
