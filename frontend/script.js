/**
 * CuraBot+ Dashboard — script.js
 * =================================
 * Handles:
 *   1. Live polling GET /api/status every 1000 ms (state + obstacle detection)
 *   2. Real-time HC-SR04 ultrasonic distance & obstacle state visualization
 *   3. Sending POST /api/command on button clicks (MOVE, STOP, RECEPTION)
 *   4. State transition activity log with timestamps & duplicate prevention
 *   5. Toast notifications
 *   6. Graceful ESP32-offline error display
 *   7. Uncompromised emergency STOP accessibility (never disabled)
 *
 * Architecture:
 *   Browser ──fetch──▶ Node.js :3000 ──http──▶ ESP32 :80
 *
 * Pure vanilla JS. No external frameworks.
 */

"use strict";

// ── Configuration ─────────────────────────────────────────────────────────────
const BACKEND_URL       = "http://localhost:3000"; // Node.js backend
const STATUS_POLL_MS    = 1000;                    // poll ESP32 status every 1000 ms for live updates
const CMD_TIMEOUT_LABEL = "Sending…";

// ── DOM references ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const connBadge         = $("connection-badge");
const connDot           = $("conn-dot");
const connLabel         = $("conn-label");
const esp32UrlText      = $("esp32-url-text");
const esp32UrlChip      = $("esp32-url-chip");

const stateRing         = $("state-ring");
const stateEmoji        = $("state-emoji");
const stateLabel        = $("state-label");

// Obstacle Guard DOM elements
const obsSection        = $("obstacle-section");
const obsIcon           = $("obs-icon");
const obsStatusSub      = $("obs-status-sub");
const obsBadge          = $("obs-badge");
const obsDistanceVal    = $("obs-distance-val");
const obsDistanceUnit   = $("obs-distance-unit");
const obsSafetyState    = $("obs-safety-state");
const obsAlertBanner    = $("obs-alert-banner");
const obsAlertMsg       = $("obs-alert-msg");
const cmdObsWarning     = $("cmd-obs-warning");
const cmdObsWarningText = $("cmd-obs-warning-text");

// Status details DOM elements
const detailObstacle    = $("detail-obstacle");
const detailDistance    = $("detail-distance");
const detailLastCmd     = $("detail-last-cmd");
const detailDest        = $("detail-destination");
const detailCmdCount    = $("detail-cmd-count");
const detailUptime      = $("detail-uptime");
const detailIp          = $("detail-ip");

const destBtns          = document.querySelectorAll(".dest-btn");
const stopBtn           = $("btn-stop");
const returnBtn         = $("btn-return");

const logContainer      = $("log-container");
const logEmpty          = $("log-empty");
const clearLogBtn       = $("btn-clear-log");

const responseJson      = $("response-json");
const respStatusBadge   = $("resp-status-badge");
const respLatency       = $("resp-latency");

const toastContainer    = $("toast-container");
const cmdOverlay        = $("cmd-overlay");
const cmdOverlayText    = $("cmd-overlay-text");

// ── App State ─────────────────────────────────────────────────────────────────
let commandsDispatched       = 0;     // Front-end dispatched counter
let currentlyActive          = null;  // Currently active destination button
let isCommandInFlight        = false; // Request actively inflight to backend

// State-transition memory to prevent log flooding
let prevRobotState           = null;
let prevObstacleDetected     = false;
let prevDistanceVal          = null;

// ═════════════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Show a toast notification that auto-dismisses.
 * @param {string} message
 * @param {"success"|"error"|"info"|"warning"} type
 * @param {number} durationMs
 */
function showToast(message, type = "info", durationMs = 4000) {
  const icons = { success: "✓", error: "✗", info: "ℹ", warning: "⚠️" };

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || "ℹ"}</span><span>${escapeHtml(message)}</span>`;
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

/** Minimal HTML escaping to prevent XSS */
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

/** Show/hide the loading overlay */
function setOverlay(visible, text = CMD_TIMEOUT_LABEL) {
  cmdOverlay.hidden = !visible;
  cmdOverlay.setAttribute("aria-hidden", String(!visible));
  cmdOverlayText.textContent = text;
}

/**
 * Update button states.
 * IMPORTANT: Emergency STOP must NEVER be disabled under any circumstance!
 */
function updateButtonStates(activeNavState) {
  const isNavActive = (activeNavState === "MOVING" || activeNavState === "RETURNING" || activeNavState === "OBSTACLE");
  const shouldDisableDest = isCommandInFlight || isNavActive;

  destBtns.forEach((btn) => {
    btn.disabled = shouldDisableDest;
    btn.classList.toggle("loading", isCommandInFlight);
  });

  returnBtn.disabled = shouldDisableDest;
  returnBtn.classList.toggle("loading", isCommandInFlight);

  // Manual emergency STOP must remain available at ALL times
  stopBtn.disabled = false;
  stopBtn.classList.toggle("loading", false);
}

/** Render the ESP32 JSON response in the response card */
function showResponse(data, ok, latencyMs) {
  const pretty = JSON.stringify(data, null, 2);
  responseJson.textContent = pretty;
  responseJson.style.color = ok ? "var(--clr-cyan)" : "var(--clr-red)";

  // Status badge
  respStatusBadge.textContent = ok ? "200 OK" : "Error";
  respStatusBadge.className   = `meta-item ${ok ? "success" : "error"}`;

  // Latency badge
  respLatency.textContent = `${latencyMs} ms`;
  respLatency.className   = "meta-item";
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROBOT STATE & OBSTACLE MAPPING
// ═════════════════════════════════════════════════════════════════════════════

const STATE_MAP = {
  IDLE:      { emoji: "⏸",  cls: "idle",      label: "IDLE"      },
  MOVING:    { emoji: "🚀", cls: "moving",    label: "MOVING"    },
  RETURNING: { emoji: "↩", cls: "returning", label: "RETURNING" },
  OBSTACLE:  { emoji: "⚠️", cls: "obstacle",  label: "OBSTACLE"  },
  STOPPED:   { emoji: "🛑", cls: "stopped",   label: "STOPPED"   },
  ERROR:     { emoji: "❌", cls: "error",     label: "ERROR"     },
};

/**
 * Update the obstacle detection UI based on real ESP32 readings.
 */
function updateObstacleDisplay(isObstacle, distStr, distNum) {
  if (isObstacle) {
    obsBadge.className = "obstacle-badge detected";
    obsBadge.textContent = "DETECTED";
    obsIcon.textContent = "🚨";
    obsStatusSub.textContent = "Obstacle detected — Robot paused";

    obsSafetyState.textContent = "PAUSED";
    obsSafetyState.className = "obs-safety-state warning";

    obsDistanceVal.className = "obs-distance-val mono warning";
    obsDistanceVal.textContent = distStr;
    obsDistanceUnit.style.display = (distStr === "—" || distStr === "No reading") ? "none" : "inline";

    obsSection.classList.add("active-obstacle");
    obsAlertBanner.hidden = false;
    obsAlertMsg.textContent = distNum >= 0
      ? `Obstacle detected at ${distStr} cm — Motors paused automatically`
      : "Obstacle detected — Motors paused automatically";

    cmdObsWarning.hidden = false;
    cmdObsWarningText.textContent = distNum >= 0
      ? `Robot paused: Obstacle detected within 20 cm (${distStr} cm). Waiting for path to clear...`
      : "Robot paused: Obstacle detected within 20 cm. Waiting for path to clear...";

    detailObstacle.textContent = "OBSTACLE DETECTED";
    detailDistance.textContent = distNum >= 0 ? `${distStr} cm` : "—";

  } else {
    obsBadge.className = "obstacle-badge clear";
    obsBadge.textContent = "CLEAR";
    obsIcon.textContent = "🛡️";
    obsStatusSub.textContent = "Path Clear";

    obsSafetyState.textContent = "CLEAR";
    obsSafetyState.className = "obs-safety-state";

    obsDistanceVal.className = "obs-distance-val mono";
    obsDistanceVal.textContent = distStr;
    obsDistanceUnit.style.display = (distStr === "—" || distStr === "No reading") ? "none" : "inline";

    obsSection.classList.remove("active-obstacle");
    obsAlertBanner.hidden = true;
    cmdObsWarning.hidden = true;

    detailObstacle.textContent = "Path Clear";
    detailDistance.textContent = distNum >= 0 ? `${distStr} cm` : "—";
  }
}

/**
 * Handle state transitions and append non-repeating activity log entries.
 */
function handleStateTransitions(currentState, isObstacleNow, distStr, distNum, esp32Status) {
  // 1. Obstacle transition logging (logged once per transition)
  if (!prevObstacleDetected && isObstacleNow) {
    const atDist = (distNum >= 0) ? ` at ${distStr} cm` : "";
    addLog(`Obstacle detected${atDist} — motors stopped.`, "warning");
    showToast(`Obstacle detected${atDist} — Robot paused`, "warning", 3500);
  } else if (prevObstacleDetected && !isObstacleNow) {
    addLog("Path clear — robot resuming navigation.", "success");
    showToast("Path clear — robot resuming navigation", "info", 3000);
  }

  // 2. Robot state transition logging
  if (prevRobotState !== null && prevRobotState !== currentState) {
    if (currentState === "STOPPED") {
      addLog("Manual emergency STOP activated.", "error");
    } else if (currentState === "ERROR") {
      addLog("Robot reported a navigation error.", "error");
    } else if (currentState === "IDLE" && (prevRobotState === "MOVING" || prevRobotState === "RETURNING" || prevRobotState === "OBSTACLE")) {
      const lastCmd = (esp32Status.lastCommand || "").toUpperCase();
      const lastDest = esp32Status.lastDestination || "";
      if (lastCmd === "ARRIVED") {
        addLog(`Robot arrived at destination: ${lastDest || "target location"}.`, "success");
      } else if (lastCmd === "RETURNED" || lastDest === "RECEPTION") {
        addLog("Robot returned to reception base.", "success");
      } else {
        addLog("Robot route finished — returned to IDLE.", "info");
      }
    }
  }

  prevRobotState = currentState;
  prevObstacleDetected = isObstacleNow;
}

/**
 * Update the robot state ring and detail rows from an ESP32 status object.
 * @param {object} esp32Status - the `esp32Status` field from /api/status
 */
function updateRobotState(esp32Status) {
  const rawState = (esp32Status.robotState || "IDLE").toUpperCase();
  const stateObj = STATE_MAP[rawState] || STATE_MAP.IDLE;

  // 1. Ultrasonic Distance calculation
  let distStr = "—";
  let distNum = -1;
  if (esp32Status.distanceCm != null) {
    const val = parseFloat(esp32Status.distanceCm);
    if (!isNaN(val)) {
      if (val >= 0) {
        distNum = val;
        distStr = val.toFixed(1);
      } else {
        distStr = "No reading";
      }
    }
  }

  // 2. Determine obstacle state
  const isObstacleNow = Boolean(
    esp32Status.obstacleDetected === true ||
    rawState === "OBSTACLE" ||
    (esp32Status.lastCommand || "").toUpperCase() === "OBSTACLE"
  );

  // 3. Update Obstacle Component
  updateObstacleDisplay(isObstacleNow, distStr, distNum);

  // 4. Update Ring & State Labels
  if (stateEmoji.textContent !== stateObj.emoji) stateEmoji.textContent = stateObj.emoji;
  if (stateLabel.textContent !== stateObj.label) stateLabel.textContent = stateObj.label;

  const targetRingClass = `state-ring ${stateObj.cls}`;
  if (stateRing.className !== targetRingClass) {
    stateRing.className = targetRingClass;
  }

  // 5. Update Status Detail Rows
  detailLastCmd.textContent  = esp32Status.lastCommand     || "—";
  detailDest.textContent     = esp32Status.lastDestination || "—";
  detailCmdCount.textContent = esp32Status.commandCount    ?? "—";
  detailUptime.textContent   = esp32Status.uptime != null ? formatUptime(esp32Status.uptime) : "—";
  detailIp.textContent       = esp32Status.ip              || "—";

  // 6. Handle State Transition Logging
  handleStateTransitions(rawState, isObstacleNow, distStr, distNum, esp32Status);

  // 7. Update Button Availability
  updateButtonStates(rawState);
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
    const t0   = Date.now();
    const res  = await fetch(`${BACKEND_URL}/api/status`);
    const json = await res.json();
    const ms   = Date.now() - t0;

    if (json.connected && json.esp32Status) {
      updateConnectionBadge(true);
      updateRobotState(json.esp32Status);

      if (json.esp32Url && esp32UrlText.textContent === "—") {
        esp32UrlText.textContent = json.esp32Url;
      }
    } else {
      updateConnectionBadge(false, json.error || "ESP32 Offline");
    }
  } catch {
    updateConnectionBadge(false, "Backend offline");
  }
}

/** Start periodic status polling */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollStatus(); // immediate initial check
  pollTimer = setInterval(pollStatus, STATUS_POLL_MS);
}

// ═════════════════════════════════════════════════════════════════════════════
//  COMMAND SENDING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Send a command to the backend, which proxies it to the ESP32.
 * @param {"MOVE"|"STOP"|"STATUS"} command
 * @param {string} [destination]
 */
async function sendCommand(command, destination) {
  // Prevent duplicate concurrent command requests
  if (isCommandInFlight && command !== "STOP") return;

  const payload = { command, ...(destination ? { destination } : {}) };

  const logPrefix = destination
    ? `→ MOVE to ${destination}`
    : `→ ${command}`;

  addLog(`${logPrefix} — sending…`, "info");

  isCommandInFlight = true;
  updateButtonStates(prevRobotState);
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
      commandsDispatched++;

      addLog(
        `✓ ${command}${destination ? ` → ${destination}` : ""} acknowledged by ESP32`,
        "success"
      );
      showResponse(json, true, latency);
      showToast(
        destination
          ? (destination === "RECEPTION" ? "CuraBot+ returning to Reception" : `CuraBot+ dispatched to ${toTitleCase(destination)}`)
          : `${command} command acknowledged`,
        "success"
      );

      // Immediately poll for the updated state
      pollStatus();

    } else {
      const errMsg = json.error || (json.esp32Response && json.esp32Response.message) || "Command rejected";
      addLog(`✗ ${command} failed — ${errMsg}`, "error");
      showResponse(json, false, latency);
      showToast(errMsg, "error");
    }

  } catch (err) {
    const latency = Date.now() - t0;
    const errMsg  = "Cannot reach backend — is the Node.js server running?";
    addLog(`✗ Network error — ${errMsg}`, "error");
    showResponse({ error: err.message }, false, latency);
    showToast(errMsg, "error");
  } finally {
    isCommandInFlight = false;
    setOverlay(false);
    updateButtonStates(prevRobotState);
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

/** Destination buttons */
destBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const dest = btn.dataset.dest;
    if (!dest) return;

    destBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentlyActive = btn;

    sendCommand("MOVE", dest);
  });
});

/** Return to Reception button */
returnBtn.addEventListener("click", () => {
  destBtns.forEach((b) => b.classList.remove("active"));
  currentlyActive = null;
  sendCommand("MOVE", "RECEPTION");
});

/** Manual Emergency STOP button (Always accessible) */
stopBtn.addEventListener("click", () => {
  destBtns.forEach((b) => b.classList.remove("active"));
  currentlyActive = null;
  sendCommand("STOP");
});

/** Clear activity log */
clearLogBtn.addEventListener("click", () => {
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
    // Backend not yet running — URL chip remains as "—"
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ═════════════════════════════════════════════════════════════════════════════

(function init() {
  fetchConfig();
  startPolling();
  addLog("Dashboard initialized — 1000ms polling active with Obstacle Guard.", "info");
})();
