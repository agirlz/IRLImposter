// Which way this copy of the game connects.
//   online: false — the offline setup: one device on the Wi-Fi runs server.js
//                   (the Android app does this), and pages talk to it directly.
//   online: true  — the GitHub Pages setup: the host's browser tab runs the
//                   game and Supabase relays messages between phones. The
//                   publish workflow switches this on; add ?online=1 to any
//                   page to try online mode from a local server.
// The Supabase project is the one Upped uses. Its URL and publishable key are
// public by design (they ship inside every web app); IRL Imposter only uses
// its live messaging, never its database.
window.IRL_CONFIG = {
  online: false,
  supabaseUrl: "https://lvmbzqlkwnbvtnmukkfc.supabase.co",
  supabaseKey: "sb_publishable_qTzEtpahbwAFL8UDt_DSsQ_PiAxPlRs",
};
