/**
 * CuraBot+ Dashboard — script.js
 * =================================
 * Handles:
 *   1. Polling GET /api/status  every 5 s (connection indicator + state display)
 *   2. Sending POST /api/command on button clicks
 *   3. Updating the UI in real-time
 *   4. Activity log with timestamps
 *   5. Toast notifications
 *   6. Graceful ESP32-offline error display
 *
 * Architecture:
 *   Browser ──fetch──▶ Node.js :3000 ──http──▶ ESP32 :80
 *
 * No frameworks. Pure vanilla JS.
 */

"use strict";

// ── Configuration ─────────────────────────────────────────────────────────────
const BACKEND_URL       = "http://localhost:3000"; // Node.js backend
const STATUS_POLL_MS    = 5000;                    // poll ESP32 status every 5 s
const CMD_TIMEOUT_LABEL = "Sending…";

// ── DOM references ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const connBadge      = $("connection-badge");
const connDot        = $("conn-dot");
const connLabel      = $("conn-label");
const esp32UrlText   = $("esp32-url-text");
const esp32UrlChip   = $("esp32-url-chip");

const stateRing      = $("state-ring");
const stateEmoji     = $("state-emoji");
const stateLabel     = $("state-label");

const detailLastCmd  = $("detail-last-cmd");
const detailDest     = $("detail-destination");
const detailCmdCount = $("detail-cmd-count");
const detailUptime   = $("detail-uptime");
const detailIp       = $("detail-ip");

const destBtns       = document.querySelectorAll(".dest-btn");
const stopBtn        = $("btn-stop");
const returnBtn      = $("btn-return");

const logContainer   = $("log-container");
const logEmpty       = $("log-empty");
const clearLogBtn    = $("btn-clear-log");

const responseJson   = $("response-json");
const respStatusBadge= $("resp-status-badge");
const respLatency    = $("resp-latency");

const toastContainer = $("toast-container");
const cmdOverlay     = $("cmd-overlay");
const cmdOverlayText = $("cmd-overlay-text");

// ── App State ─────────────────────────────────────────────────────────────────
let commandsDispatched = 0; // front-end counter (separate from ESP32's)
let currentlyActive    = null; // the currently highlighted destination button

// ═════════════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Show a toast notification that auto-dismisses.
 * @param {string} message
 * @param {"success"|"error"|"info"} type
 * @param {number} durationMs
 */
function showToast(message, type = "info", durationMs = 4000) {
  const icons = { success: "✓", error: "✗", info: "ℹ" };

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("exiting");
    toast.addEventListener("animationend", () => toast.remove());
  }, durationMs);
}

/**
 * Append an entry to the activity log.
 * @param {string} message
 * @param {"success"|"error"|"info"|"warning"} type
 */
function addLog(message, type = "info") {
  // Hide the empty-state placeholder
  if (logEmpty) logEmpty.style.display = "none";

  const now  = new Date();
  const time = now.toLocaleTimeString("en-IN", { hour12: false });

  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `
    <span class="log-dot"></span>
    <div class="log-body">
      <div class="log-message">${escapeHtml(message)}</div>
      <div class="log-time">${time}</div>
    </div>`;

  // Newest at top
  logContainer.insertBefore(entry, logContainer.firstChild);
}

/** Minimal HTML escaping to prevent XSS from server responses */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format seconds into a human-readable uptime string */
function formatUptime(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Show/hide the full-screen loading overlay */
function setOverlay(visible, text = CMD_TIMEOUT_LABEL) {
  cmdOverlay.hidden    = !visible;
  cmdOverlay.setAttribute("aria-hidden", String(!visible));
  cmdOverlayText.textContent = text;
}

/** Disable all command buttons while a request is in-flight */
function setButtonsDisabled(disabled) {
  destBtns.forEach((btn) => {
    btn.disabled = disabled;
    btn.classList.toggle("loading", disabled);
  });
  // STOP must remain available even while a MOVE request is being sent.
  returnBtn.disabled = disabled;
  returnBtn.classList.toggle("loading", disabled);
}

/** Render the ESP32 JSON response in the response card */
function showResponse(data, ok, latencyMs) {
  const pretty = JSON.stringify(data, null, 2);
  responseJson.textContent = pretty;
  responseJson.style.color = ok
    ? "var(--clr-cyan)"
    : "var(--clr-red)";

  // Status badge
  respStatusBadge.textContent = ok ? "200 OK" : "Error";
  respStatusBadge.className   = `meta-item ${ok ? "success" : "error"}`;

  // Latency badge
  respLatency.textContent = `${latencyMs} ms`;
  respLatency.className   = "meta-item";
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROBOT STATE DISPLAY
// ═════════════════════════════════════════════════════════════════════════════

const STATE_MAP = {
  IDLE:    { emoji: "⏸",  cls: "idle",    label: "IDLE"    },
  MOVING:  { emoji: "🚀", cls: "moving",  label: "MOVING"  },
  RETURNING: { emoji: "↩", cls: "moving", label: "RETURNING" },
  STOPPED: { emoji: "🛑", cls: "stopped", label: "STOPPED" },
};

/**
 * Update the robot state ring and detail rows from an ESP32 status object.
 * @param {object} esp32Status - the `esp32Status` field from /api/status
 */
function updateRobotState(esp32Status) {
  const state    = (esp32Status.robotState || "IDLE").toUpperCase();
  const stateObj = STATE_MAP[state] || STATE_MAP.IDLE;

  stateEmoji.textContent = stateObj.emoji;
  stateLabel.textContent = stateObj.label;

  // Update ring class
  stateRing.className = `state-ring ${stateObj.cls}`;

  // Detail rows
  detailLastCmd.textContent  = esp32Status.lastCommand     || "—";
  detailDest.textContent     = esp32Status.lastDestination || "—";
  detailCmdCount.textContent = esp32Status.commandCount    ?? "—";
  detailUptime.textContent   = esp32Status.uptime != null
                                 ? formatUptime(esp32Status.uptime)
                                 : "—";
  detailIp.textContent       = esp32Status.ip              || "—";
}

/**
 * Update the connection badge in the header.
 * @param {boolean} online
 * @param {string}  [label]
 */
function updateConnectionBadge(online, label) {
  connBadge.className = `connection-badge ${online ? "connected" : "disconnected"}`;
  connLabel.textContent = label || (online ? "ESP32 Online" : "ESP32 Offline");
}

// ═════════════════════════════════════════════════════════════════════════════
//  STATUS POLLING
// ═════════════════════════════════════════════════════════════════════════════

let pollTimer = null;

async function pollStatus() {
  try {
    const t0  = Date.now();
    const res = await fetch(`${BACKEND_URL}/api/status`);
    const json = await res.json();
    const ms  = Date.now() - t0;

    if (json.connected && json.esp32Status) {
      updateConnectionBadge(true);
      updateRobotState(json.esp32Status);

      // Show the ESP32 URL from backend config (first poll only is fine)
      if (json.esp32Url && esp32UrlText.textContent === "—") {
        esp32UrlText.textContent = json.esp32Url;
      }
    } else {
      updateConnectionBadge(false, json.error || "ESP32 Offline");
    }
  } catch {
    // Backend itself is unreachable (not just ESP32)
    updateConnectionBadge(false, "Backend offline");
  }
}

/** Start periodic polling. */
function startPolling() {
  pollStatus(); // immediate first check
  pollTimer = setInterval(pollStatus, STATUS_POLL_MS);
}

// ═════════════════════════════════════════════════════════════════════════════
//  COMMAND SENDING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Send a command to the backend, which will proxy it to the ESP32.
 * @param {"MOVE"|"STOP"|"STATUS"} command
 * @param {string} [destination]
 */
async function sendCommand(command, destination) {
  const payload = { command, ...(destination ? { destination } : {}) };

  const logPrefix = destination
    ? `→ MOVE to ${destination}`
    : `→ ${command}`;

  addLog(`${logPrefix} — sending…`, "info");
  setButtonsDisabled(true);
  setOverlay(true, `Sending ${command}…`);

  const t0 = Date.now();

  try {
    const res  = await fetch(`${BACKEND_URL}/api/command`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    const json    = await res.json();
    const latency = Date.now() - t0;

    if (res.ok && json.success) {
      // ── Success ────────────────────────────────────────────────────────
      commandsDispatched++;

      const ack = json.esp32Response || {};
      addLog(
        `✓ ${command}${destination ? ` → ${destination}` : ""} acknowledged by ESP32`,
        "success"
      );
      showResponse(json, true, latency);
      showToast(
        destination
          ? `CuraBot+ dispatched to ${toTitleCase(destination)}`
          : `${command} command acknowledged`,
        "success"
      );

      // Refresh state immediately after a successful command
      pollStatus();

    } else {
      // ── Application-level error (4xx, ESP32 error etc.) ────────────────
      const errMsg = json.error || "Unknown error";
      addLog(`✗ ${command} failed — ${errMsg}`, "error");
      showResponse(json, false, latency);
      showToast(errMsg, "error");
    }

  } catch (err) {
    // ── Network error (backend not running, etc.) ─────────────────────────
    const latency = Date.now() - t0;
    const errMsg  = "Cannot reach backend — is the Node.js server running?";
    addLog(`✗ Network error — ${errMsg}`, "error");
    showResponse({ error: err.message }, false, latency);
    showToast(errMsg, "error");
  } finally {
    setOverlay(false);
    setButtonsDisabled(false);
  }
}

/** Convert "WARD A" → "Ward A" */
function toTitleCase(str) {
  return str
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ═════════════════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═════════════════════════════════════════════════════════════════════════════

/** Wire up each destination button */
destBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const dest = btn.dataset.dest;
    if (!dest) return;

    // Highlight the active destination
    destBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentlyActive = btn;

    sendCommand("MOVE", dest);
  });
});

/** Return-to-reception button */
returnBtn.addEventListener("click", () => {
  destBtns.forEach((b) => b.classList.remove("active"));
  currentlyActive = null;
  sendCommand("MOVE", "RECEPTION");
});

/** STOP button */
stopBtn.addEventListener("click", () => {
  // Remove destination highlight — robot is stopping
  destBtns.forEach((b) => b.classList.remove("active"));
  currentlyActive = null;

  sendCommand("STOP");
});

/** Clear the activity log */
clearLogBtn.addEventListener("click", () => {
  // Remove all entries except the empty-state div
  const entries = logContainer.querySelectorAll(".log-entry");
  entries.forEach((e) => e.remove());
  if (logEmpty) logEmpty.style.display = "";
});

// ═════════════════════════════════════════════════════════════════════════════
//  FETCH ESP32 URL FROM BACKEND CONFIG
// ═════════════════════════════════════════════════════════════════════════════

async function fetchConfig() {
  try {
    const res  = await fetch(`${BACKEND_URL}/api/config`);
    const json = await res.json();
    if (json.esp32Url) {
      esp32UrlText.textContent = json.esp32Url;
    }
  } catch {
    // Backend not yet running — URL chip stays as "—"
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ═════════════════════════════════════════════════════════════════════════════

(function init() {
  fetchConfig();
  startPolling();
  addLog("Dashboard initialised — polling ESP32 status…", "info");
})();
