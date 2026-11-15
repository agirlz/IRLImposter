# Join Game: stop pre-filling the last game code

James's feedback: the Join Game field always shows the last code someone
typed in, which is confusing when a different person is joining next (or
the same person is joining a new game with a new key).

This is a tiny, standalone fix in the native launcher's `www/js/index.js`
— independent of the in-app updater package delivered separately
(`irl-imposter-updater.zip`). It doesn't depend on that package or on each
other; apply whichever of the two you're ready for, in any order.

## What's causing it

Two spots in `onDeviceReady()` / `connectToGame()` work together to
remember the last thing typed into the Join Game field, in
`localStorage`, and then pre-fill it next time:

**1. Written on a successful join** — inside `connectToGame()`'s success
callback:

```js
cordova.exec(function () {
  localStorage.setItem("irlJoinEntry", originalEntry);
  localStorage.setItem("amongusHost", origin);
  showStatus("Opening the game…", origin);
  ...
```

**2. Read back and pre-filled** — inside `onDeviceReady()`:

```js
function onDeviceReady() {
  byId("hostInput").value = localStorage.getItem("irlJoinEntry") || "";
  ...
```

## The fix

Remove both. The Join Game field should always start empty.

**In `connectToGame()`** — delete the `irlJoinEntry` line (keep the
`amongusHost` one; that's unrelated, it's what lets Host Game / View
Tutorial reconnect to an already-running local server, not something this
fix touches):

```js
cordova.exec(function () {
  localStorage.setItem("amongusHost", origin);
  showStatus("Opening the game…", origin);
  ...
```

**In `onDeviceReady()`** — delete the pre-fill line entirely (don't
replace it with anything — just remove the assignment, the input's
default empty value is fine):

```js
function onDeviceReady() {
  byId("hostBtn").addEventListener("click", startHost);
  ...
```

That's the whole fix — two one-line deletions, no other files touched.
Once removed, `irlJoinEntry` is no longer read or written anywhere;
feel free to also drop it from any device's existing `localStorage` if
you want to clean up the stale key, but it's harmless to just leave an
orphaned key sitting there unread.
