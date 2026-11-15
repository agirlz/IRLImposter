// Shared helpers for the IRL Imposter client pages.

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }

function fmtCountdown(msRemaining) {
  const s = Math.max(0, Math.ceil(msRemaining / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? (m + ":" + String(r).padStart(2, "0")) : String(r);
}

function runCountdown(el, deadline, onZero) {
  if (el._countdownTimer) clearInterval(el._countdownTimer);
  function tick() {
    const remaining = deadline - Date.now();
    el.textContent = fmtCountdown(remaining);
    if (remaining <= 0) {
      clearInterval(el._countdownTimer);
      el._countdownTimer = null;
      if (onZero) onZero();
    }
  }
  tick();
  el._countdownTimer = setInterval(tick, 250);
}

// Ticks el's height from 100% down to 0% between now and deadline, given the
// total duration the countdown started with — a visual "fuel gauge" to pair
// with a text countdown (used for the sabotage corner badge).
function runMeter(el, deadline, totalMs, onZero) {
  if (el._meterTimer) clearInterval(el._meterTimer);
  function tick() {
    const remaining = deadline - Date.now();
    const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remaining / totalMs) * 100)) : 0;
    el.style.height = pct + "%";
    if (remaining <= 0) {
      clearInterval(el._meterTimer);
      el._meterTimer = null;
      if (onZero) onZero();
    }
  }
  tick();
  el._meterTimer = setInterval(tick, 200);
}
