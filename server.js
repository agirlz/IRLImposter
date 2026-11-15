// IRL Imposter — party game server
// One process, one game at a time. Run on a laptop connected to the same
// Wi-Fi as your guests. There are NO personal phones in this design — every
// device is a stationary "terminal" placed in one room of the house
// (public/station.html). Players walk up to whichever terminal is nearest
// and tap their name to join, see their role, do a task, sabotage, call a
// Red Alert, declare someone dead, or vote. A separate host dashboard
// (public/host.html) is the control screen for configuring rooms and
// starting/resetting rounds.


const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { attach } = require("./public/game-core.js");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

// All the game rules live in public/game-core.js (the online version runs the
// same file in the host's browser). Timing tunables still come from the
// environment here — see "Tuning the game" in the README.
attach(io, { env: process.env });

function lanAddresses() {
  const os = require("os");
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

server.listen(PORT, "0.0.0.0", () => {
  const ips = lanAddresses();
  console.log(`\nIRL Imposter server running.`);
  if (ips.length) {
    ips.forEach((ip) => {
      console.log(`Host screen:   http://${ip}:${PORT}/host.html`);
      console.log(`Station (any room, auto-assigned): http://${ip}:${PORT}/station.html`);
    });
  } else {
    console.log(`Host screen:   http://<this-device's-LAN-IP>:${PORT}/host.html`);
  }

  // When running inside the nodejs-mobile-cordova plugin (i.e. bundled into
  // the Android app), tell the WebView shell which address to load — this
  // block is a no-op anywhere else (plain `npm start` on a laptop).
  try {
    const cordova = require("cordova-bridge");
    cordova.channel.post("server-ready", { port: PORT, ips });

    // If Android backgrounds the host app (screen lock, switching apps,
    // aggressive battery management on some phones), don't let that tear
    // down the game server that every other station terminal depends on —
    // just acknowledge the pause immediately and keep serving.
    cordova.app.on("pause", (pauseLock) => {
      console.log("[node] app paused — server keeps running in the background.");
      if (pauseLock && pauseLock.release) pauseLock.release();
    });
    cordova.app.on("resume", () => {
      console.log("[node] app resumed.");
    });
  } catch (e) {
    // Not running inside nodejs-mobile — nothing to do.
  }
});

// A single unexpected error in any one socket handler should never be able
// to bring down the whole server (and with it, every other player's
// terminal) mid-party. Log it and keep going instead of letting Node's
// default "crash the process" behavior kick in.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception (ignored, server stays up):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandled rejection (ignored, server stays up):", err);
});
