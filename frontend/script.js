/**
 * CuraBot+ Dashboard — script.js
 * =================================
 * Real-time control dashboard for autonomous hospital delivery robot.
 *
 * Core Capabilities:
 *   1. Periodic polling (GET /api/status every 1000 ms) for robot telemetry.
 *   2. Real-time HC-SR04 ultrasonic obstacle guard display (distance + hysteresis).
 *   3. RC522 RFID security status visualization:
 *        - WAITING_FOR_DELIVERY, NAVIGATING, AWAITING_RFID, LID_OPEN,
 *          SAME_CARD_REQUIRED, DELIVERY_DISPENSED, UNKNOWN_CARD,
 *          WRONG_DESTINATION, NOT_AT_DELIVERY_POINT, NAVIGATION_ERROR.
 *   4. SG90 Servo medicine compartment status (30° Locked / 90° Open).
 *   5. Delivery stage badge and contextual RFID event banner.
 *   6. Destination buttons with real-time status pills.
 *   7. Strict safety rules:
 *        - Compartment-open locks dispatch and return commands.
 *        - Emergency STOP is NEVER disabled under any condition.
 *        - Clean state-transition logging without poll spam.
 *   8. Zero simulated RFID or servo data — strictly mirrors ESP32 hardware telemetry.
 *
 * Architecture:
 *   Browser (Vanilla JS) ──fetch──▶ Node.js :3000 ──http──▶ ESP32 :80
 */

"use strict";

// ── Configuration ─────────────────────────────────────────────────────────────
const BACKEND_URL       = "http://localhost:3000"; // Node.js backend
const STATUS_POLL_MS    = 1000;                    // Poll ESP32 status every 1000 ms
const CMD_TIMEOUT_LABEL = "Sending…";

// ── DOM References ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// Header & Connection
const connBadge         = $("connection-badge");
const connDot           = $("conn-dot");
const connLabel         = $("conn-label");
const esp32UrlText      = $("esp32-url-text");
const esp32UrlChip      = $("esp32-url-chip");

// Robot State Ring
const stateRingWrapper  = $("state-ring-wrapper");
const stateRing         = $("state-ring");
const stateEmoji        = $("state-emoji");
const stateLabel        = $("state-label");

// Obstacle Guard
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

// Status Details Rows
const detailObstacle    = $("detail-obstacle");
const detailDistance    = $("detail-distance");
const detailLastCmd     = $("detail-last-cmd");
const detailDest        = $("detail-destination");
const detailCmdCount    = $("detail-cmd-count");
const detailUptime      = $("detail-uptime");
const detailIp          = $("detail-ip");

// Medicine Compartment & RFID Security
const compLivePill      = $("comp-live-pill");
const compVisualBox     = $("comp-visual-box");
const compLockIcon      = $("comp-lock-icon");
const compServoBadge    = $("comp-servo-badge");
const compHeadline      = $("comp-headline");
const compSubtext       = $("comp-subtext");
const authDest          = $("auth-dest");
const authDeliveryStage = $("auth-delivery-stage");
const authAccessStatus  = $("auth-access-status");
const authLidStatus     = $("auth-lid-status");
const authDispenseStatus= $("auth-dispense-status");
const rfidEventBanner   = $("rfid-event-banner");
const rfidEventIcon     = $("rfid-event-icon");
const rfidEventMsg      = $("rfid-event-msg");
const cmdLidWarning     = $("cmd-lid-warning");
const cmdLidWarningText = $("cmd-lid-warning-text");

// Destination Buttons & Status Pills
const destBtns          = document.querySelectorAll(".dest-btn");
const stopBtn           = $("btn-stop");
const returnBtn         = $("btn-return");

const pillMap = {
  "PHARMACY":       $("pill-pharmacy"),
  "WARD A":         $("pill-ward-a"),
  "WARD B":         $("pill-ward-b"),
  "EMERGENCY ROOM": $("pill-emergency"),
};

// Activity Log & Response Card
const logContainer      = $("log-container");
const logEmpty          = $("log-empty");
const clearLogBtn       = $("btn-clear-log");
const responseJson      = $("response-json");
const respStatusBadge   = $("resp-status-badge");
const respLatency       = $("resp-latency");

// Feedback & Overlay
const toastContainer    = $("toast-container");
const cmdOverlay        = $("cmd-overlay");
const cmdOverlayText    = $("cmd-overlay-text");

// ── Application State & Transition Memory ─────────────────────────────────────
let commandsDispatched   = 0;
let isCommandInFlight    = false;

// State memory to prevent duplicate activity logging on 1000ms polling cycles
let prevRobotState       = null;
let prevObstacleDetected = false;
let prevAccessStatus     = null;
let prevLidOpen          = false;
let prevDeliveryComplete = false;
let prevLastDestination  = null;

// Track current lid state for client-side command gating
let isCompartmentOpen    = false;

// ═════════════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Show a styled toast notification that auto-dismisses.
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

/** Format seconds into human-readable uptime */
function formatUptime(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Show or hide the command loading overlay */
function setOverlay(visible, text = CMD_TIMEOUT_LABEL) {
  cmdOverlay.hidden = !visible;
  cmdOverlay.setAttribute("aria-hidden", String(!visible));
  cmdOverlayText.textContent = text;
}

/** Convert string to Title Case (e.g., "WARD A" -> "Ward A") */
function toTitleCase(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Update button interactive states based on robot condition.
 * CRITICAL SAFETY RULE: Emergency STOP is NEVER disabled under any circumstance!
 */
function updateButtonStates(activeNavState, lidOpen) {
  const isNavActive = (activeNavState === "MOVING" || activeNavState === "RETURNING" || activeNavState === "OBSTACLE");
  const shouldBlockDispatch = isCommandInFlight || isNavActive || Boolean(lidOpen);

  destBtns.forEach((btn) => {
    btn.disabled = shouldBlockDispatch;
    btn.classList.toggle("loading", isCommandInFlight);
  });

  returnBtn.disabled = shouldBlockDispatch;
  returnBtn.classList.toggle("loading", isCommandInFlight);

  // Manual emergency STOP must remain available at ALL times
  stopBtn.disabled = false;
  stopBtn.classList.toggle("loading", false);
}

/** Render raw ESP32 JSON response in the bottom telemetry card */
function showResponse(data, ok, latencyMs) {
  const pretty = JSON.stringify(data, null, 2);
  responseJson.textContent = pretty;
  responseJson.style.color = ok ? "var(--clr-cyan)" : "var(--clr-red)";

  respStatusBadge.textContent = ok ? "200 OK" : "Error";
  respStatusBadge.className   = `meta-item ${ok ? "success" : "error"}`;

  respLatency.textContent = `${latencyMs} ms`;
  respLatency.className   = "meta-item";
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROBOT STATE VISUALIZATION
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
 * Update the Ultrasonic Obstacle Guard UI based on ESP32 readings.
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
      : "Obstacle detected within 20 cm — Motors paused automatically";

    cmdObsWarning.hidden = false;
    cmdObsWarningText.textContent = distNum >= 0
      ? `Robot paused: Obstacle detected within 20 cm (${distStr} cm). Waiting for path to clear (≥ 25 cm)...`
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

// ═════════════════════════════════════════════════════════════════════════════
//  MEDICINE COMPARTMENT & RFID SECURITY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Update the Medicine Compartment, Servo Angle, Delivery Stage,
 * and RFID Authentication status components.
 */
function updateCompartmentAndAuthDisplay(esp32Status, rawState) {
  const lidOpen          = Boolean(esp32Status.lidOpen);
  const deliveryComplete = Boolean(esp32Status.deliveryComplete);
  const accessStatus     = (esp32Status.accessStatus || "WAITING_FOR_DELIVERY").toUpperCase();
  const lastDest         = esp32Status.lastDestination || "—";
  const isNavigating     = (rawState === "MOVING" || rawState === "RETURNING" || rawState === "OBSTACLE");

  // Keep track of current lid open state for safety gating
  isCompartmentOpen = lidOpen;

  // 1. Servo angle & physical lock indicator
  if (lidOpen) {
    compLockIcon.textContent = "🔓";
    compServoBadge.textContent = "90° OPEN";
    compServoBadge.className = "servo-angle-badge";
    authLidStatus.textContent = "OPEN (90°)";
  } else {
    compLockIcon.textContent = "🔒";
    compServoBadge.textContent = "30° CLOSED";
    compServoBadge.className = "servo-angle-badge";
    authLidStatus.textContent = "LOCKED (30°)";
  }

  // 2. Delivery target unit
  authDest.textContent = (lastDest !== "RECEPTION" && lastDest !== "BOOT") ? lastDest : "BASE / RECEPTION";

  // 3. Persistent Lid Open Warning Notice
  if (lidOpen) {
    cmdLidWarning.hidden = false;
    cmdLidWarningText.textContent = "Medicine compartment is OPEN (90°). Scan the same RFID card to close the lid before returning to reception.";
  } else {
    cmdLidWarning.hidden = true;
  }

  // 4. Compartment Visual Box, Live Pill, Delivery Stage, Headline, Subtext & RFID Event Banner
  let pillClass   = "locked";
  let pillText    = "LOCKED (30°)";
  let boxClass    = "compartment-visual-box";
  let headline    = "Medicine Compartment Secured";
  let subtext     = "Lid locked at 30° — Awaiting destination arrival";
  let stageClass  = "idle";
  let stageText   = "AT BASE";
  let accessText  = "WAITING FOR DELIVERY";
  let dispenseText= "PENDING";

  let bannerShow  = false;
  let bannerClass = "rfid-event-banner";
  let bannerIcon  = "ℹ️";
  let bannerMsg   = "";

  if (lidOpen) {
    // Lid is currently open
    pillClass   = "open";
    pillText    = "OPEN (90°)";
    boxClass    = "compartment-visual-box open";
    headline    = "Medicine Compartment Unlocked";
    subtext     = "Compartment open at 90°. Scan the exact SAME RFID card to lock compartment and finish delivery.";
    stageClass  = "granted";
    stageText   = "ACCESS GRANTED - LID OPEN";
    accessText  = "LID OPEN (90°)";
    dispenseText= "IN PROGRESS";

    bannerShow  = true;
    bannerClass = "rfid-event-banner success";
    bannerIcon  = "🔓";
    bannerMsg   = "Authorized RFID verified. Compartment unlocked. Scan the SAME card to seal and complete.";

  } else if (accessStatus === "SAME_CARD_REQUIRED") {
    // Attempted to close with a different card
    pillClass   = "open";
    pillText    = "OPEN (90°)";
    boxClass    = "compartment-visual-box open";
    headline    = "Security Mismatch — Different Card";
    subtext     = "Access Denied: Only the same RFID card that opened the compartment is permitted to close it.";
    stageClass  = "granted";
    stageText   = "SAME CARD REQUIRED";
    accessText  = "SAME CARD REQUIRED";
    dispenseText= "IN PROGRESS";

    bannerShow  = true;
    bannerClass = "rfid-event-banner warning";
    bannerIcon  = "⚠️";
    bannerMsg   = "Security Alert: A different card was scanned. You must scan the original card to seal the compartment.";

  } else if (accessStatus === "AWAITING_RFID" || (deliveryComplete && !lidOpen)) {
    // Reached destination, waiting for RFID scan
    pillClass   = "awaiting";
    pillText    = "AWAITING RFID";
    boxClass    = "compartment-visual-box awaiting";
    headline    = "Arrived at Destination — Scan Badge";
    subtext     = `Hold authorized ${lastDest} RFID badge over sensor to unlock medicine compartment.`;
    stageClass  = "awaiting";
    stageText   = "AWAITING RFID SCAN";
    accessText  = "AWAITING RFID SCAN";
    dispenseText= "AWAITING AUTH";

    bannerShow  = true;
    bannerClass = "rfid-event-banner warning";
    bannerIcon  = "🪪";
    bannerMsg   = `Robot arrived at ${lastDest}. Scan assigned RFID badge to unlock medication.`;

  } else if (accessStatus === "DELIVERY_DISPENSED") {
    // Successfully dispensed and re-locked
    pillClass   = "locked";
    pillText    = "DISPENSED & LOCKED";
    boxClass    = "compartment-visual-box";
    headline    = "Delivery Completed & Secured";
    subtext     = `Medication safely dispensed at ${lastDest}. Compartment locked at 30°. Ready for Return.`;
    stageClass  = "dispensed";
    stageText   = "DELIVERY DISPENSED";
    accessText  = "DELIVERY DISPENSED";
    dispenseText= "COMPLETED";

    bannerShow  = true;
    bannerClass = "rfid-event-banner success";
    bannerIcon  = "✅";
    bannerMsg   = "Delivery verified! Compartment locked at 30°. CuraBot+ is ready to return to Reception.";

  } else if (accessStatus === "WRONG_DESTINATION") {
    // Scanned card belonging to another room
    pillClass   = "denied";
    pillText    = "CARD MISMATCH";
    boxClass    = "compartment-visual-box denied";
    headline    = "Access Denied — Wrong Card";
    subtext     = `This RFID card belongs to a different ward. Please use the card designated for ${lastDest}.`;
    stageClass  = "denied";
    stageText   = "ACCESS DENIED";
    accessText  = "WRONG DESTINATION CARD";
    dispenseText= "PENDING";

    bannerShow  = true;
    bannerClass = "rfid-event-banner error";
    bannerIcon  = "⛔";
    bannerMsg   = `Access Denied: Scanned card is unauthorized for ${lastDest}.`;

  } else if (accessStatus === "UNKNOWN_CARD") {
    // Unregistered RFID UID
    pillClass   = "denied";
    pillText    = "UNKNOWN CARD";
    boxClass    = "compartment-visual-box denied";
    headline    = "Access Denied — Unregistered Card";
    subtext     = "Unrecognized card UID. Medication compartment remains locked for patient safety.";
    stageClass  = "denied";
    stageText   = "ACCESS DENIED";
    accessText  = "UNKNOWN RFID CARD";
    dispenseText= "PENDING";

    bannerShow  = true;
    bannerClass = "rfid-event-banner error";
    bannerIcon  = "⛔";
    bannerMsg   = "Access Denied: RFID card not registered in CuraBot+ system.";

  } else if (accessStatus === "NOT_AT_DELIVERY_POINT") {
    // Card tapped during movement or away from stop
    pillClass   = "locked";
    pillText    = "LOCKED (30°)";
    boxClass    = "compartment-visual-box";
    headline    = "Scan Ignored — Robot Not At Destination";
    subtext     = "Compartment access is disabled while robot is in motion or stopped midway.";
    stageClass  = "idle";
    stageText   = isNavigating ? "IN TRANSIT" : "NOT AT STOP";
    accessText  = "NOT AT DELIVERY POINT";
    dispenseText= "LOCKED";

    bannerShow  = true;
    bannerClass = "rfid-event-banner warning";
    bannerIcon  = "⚠️";
    bannerMsg   = "RFID scanner inactive: Robot must complete its route before compartment can be unlocked.";

  } else if (accessStatus === "NAVIGATING" || isNavigating) {
    // In transit
    pillClass   = "locked";
    pillText    = "LOCKED (30°)";
    boxClass    = "compartment-visual-box";
    headline    = "In Transit — Compartment Secured";
    subtext     = `CuraBot+ is navigating to ${lastDest}. Compartment locked at 30° until arrival.`;
    stageClass  = "navigating";
    stageText   = rawState === "RETURNING" ? "RETURNING TO BASE" : "NAVIGATING";
    accessText  = "IN TRANSIT (LOCKED)";
    dispenseText= "EN ROUTE";

    bannerShow  = false;

  } else {
    // Standby at reception / base
    pillClass   = "locked";
    pillText    = "LOCKED (30°)";
    boxClass    = "compartment-visual-box";
    headline    = "Medicine Compartment Secured";
    subtext     = "Lid locked at 30° — Awaiting destination dispatch from reception.";
    stageClass  = "idle";
    stageText   = "AT BASE";
    accessText  = "STANDBY / READY";
    dispenseText= "PENDING";

    bannerShow  = false;
  }

  // Apply to DOM
  compLivePill.className      = `compartment-live-pill ${pillClass}`;
  compLivePill.textContent    = pillText;

  compVisualBox.className     = boxClass;
  compHeadline.textContent    = headline;
  compSubtext.textContent     = subtext;

  authDeliveryStage.className = `auth-stage-badge ${stageClass}`;
  authDeliveryStage.textContent = stageText;

  authAccessStatus.textContent   = accessText;
  authDispenseStatus.textContent = dispenseText;

  rfidEventBanner.hidden      = !bannerShow;
  if (bannerShow) {
    rfidEventBanner.className = bannerClass;
    rfidEventIcon.textContent = bannerIcon;
    rfidEventMsg.textContent  = bannerMsg;
  }
}

/**
 * Update the status pills inside the destination buttons.
 */
function updateDestinationPills(esp32Status, rawState) {
  const currentDest      = (esp32Status.lastDestination || "").toUpperCase();
  const accessStatus     = (esp32Status.accessStatus || "").toUpperCase();
  const lidOpen          = Boolean(esp32Status.lidOpen);
  const deliveryComplete = Boolean(esp32Status.deliveryComplete);

  Object.entries(pillMap).forEach(([destKey, pillEl]) => {
    if (!pillEl) return;

    if (destKey === currentDest) {
      if (rawState === "MOVING") {
        pillEl.textContent = "EN ROUTE";
        pillEl.className   = "dest-status-pill navigating";
      } else if (rawState === "OBSTACLE") {
        pillEl.textContent = "PAUSED";
        pillEl.className   = "dest-status-pill arrived";
      } else if (lidOpen) {
        pillEl.textContent = "LID OPEN";
        pillEl.className   = "dest-status-pill open";
      } else if (accessStatus === "DELIVERY_DISPENSED") {
        pillEl.textContent = "DELIVERED";
        pillEl.className   = "dest-status-pill completed";
      } else if (accessStatus === "AWAITING_RFID" || deliveryComplete) {
        pillEl.textContent = "ARRIVED";
        pillEl.className   = "dest-status-pill arrived";
      } else {
        pillEl.textContent = "ACTIVE";
        pillEl.className   = "dest-status-pill navigating";
      }
    } else {
      pillEl.textContent = "READY";
      pillEl.className   = "dest-status-pill";
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  STATE TRANSITION LOGGING (NON-REPEATING)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compare current telemetry against prior state memory and append
 * non-repeating entries to the activity log.
 */
function handleStateTransitions(currentState, isObstacleNow, distStr, distNum, esp32Status) {
  const currentAccess      = (esp32Status.accessStatus || "").toUpperCase();
  const currentLidOpen     = Boolean(esp32Status.lidOpen);
  const currentComplete    = Boolean(esp32Status.deliveryComplete);
  const currentDestination = esp32Status.lastDestination || "";

  // 1. Obstacle Detection Transition
  if (!prevObstacleDetected && isObstacleNow) {
    const atDist = (distNum >= 0) ? ` at ${distStr} cm` : "";
    addLog(`Obstacle detected${atDist} — Motors paused automatically.`, "warning");
    showToast(`Obstacle detected${atDist} — Robot paused`, "warning", 3500);
  } else if (prevObstacleDetected && !isObstacleNow) {
    addLog("Path clear (≥ 25 cm) — Robot resuming navigation.", "success");
    showToast("Path clear — Robot resuming navigation", "info", 3000);
  }

  // 2. Navigation & Movement State Transitions
  if (prevRobotState !== null && prevRobotState !== currentState) {
    if (currentState === "STOPPED") {
      addLog("Manual EMERGENCY STOP activated.", "error");
      showToast("Emergency Stop Activated", "error", 3500);
    } else if (currentState === "ERROR") {
      addLog("Robot reported a navigation error.", "error");
    } else if (currentState === "IDLE" && (prevRobotState === "MOVING" || prevRobotState === "RETURNING" || prevRobotState === "OBSTACLE")) {
      const lastCmd = (esp32Status.lastCommand || "").toUpperCase();
      if (lastCmd === "ARRIVED") {
        addLog(`Robot arrived at ${currentDestination}. Waiting for RFID authentication.`, "info");
      } else if (lastCmd === "RETURNED" || currentDestination === "RECEPTION") {
        addLog("Robot successfully returned to Reception base.", "success");
        showToast("Returned to Reception base", "success", 3000);
      } else {
        addLog("Navigation route completed.", "info");
      }
    }
  }

  // 3. RFID Authentication & Compartment State Transitions
  if (prevAccessStatus !== null && prevAccessStatus !== currentAccess) {
    if (currentAccess === "AWAITING_RFID") {
      addLog(`CuraBot+ arrived at ${currentDestination} — Awaiting authorized RFID card.`, "info");
    } else if (currentAccess === "LID_OPEN" && !prevLidOpen && currentLidOpen) {
      addLog(`RFID Access GRANTED (${currentDestination}) — Medicine compartment opened (90°).`, "success");
      showToast(`Access Granted: Compartment Open (90°) at ${currentDestination}`, "success", 4000);
    } else if (currentAccess === "DELIVERY_DISPENSED") {
      addLog(`RFID Same-Card Confirmed — Medicine compartment locked (30°). Delivery dispensed.`, "success");
      showToast("Medication Dispensed — Compartment Locked (30°)", "success", 4500);
    } else if (currentAccess === "SAME_CARD_REQUIRED") {
      addLog("RFID Security Warning: Different card scanned. Must scan same card to lock compartment.", "warning");
      showToast("Scan the same RFID card to close the compartment", "warning", 4000);
    } else if (currentAccess === "WRONG_DESTINATION") {
      addLog(`RFID Access DENIED: Card belongs to a different unit, not ${currentDestination}.`, "error");
      showToast(`Access Denied: Card does not match ${currentDestination}`, "error", 4000);
    } else if (currentAccess === "UNKNOWN_CARD") {
      addLog("RFID Access DENIED: Scanned card UID is not registered.", "error");
      showToast("Access Denied: Unregistered RFID Card", "error", 4000);
    } else if (currentAccess === "NOT_AT_DELIVERY_POINT" && prevAccessStatus !== "WAITING_FOR_DELIVERY") {
      addLog("RFID Scan Ignored: Robot is not stationary at a delivery point.", "warning");
    }
  }

  // Update memory state
  prevRobotState       = currentState;
  prevObstacleDetected = isObstacleNow;
  prevAccessStatus     = currentAccess;
  prevLidOpen          = currentLidOpen;
  prevDeliveryComplete = currentComplete;
  prevLastDestination  = currentDestination;
}

// ═════════════════════════════════════════════════════════════════════════════
//  MASTER TELEMETRY UPDATE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Update all dashboard UI elements from an ESP32 status object.
 * @param {object} esp32Status - Telemetry received from ESP32
 */
function updateRobotState(esp32Status) {
  const rawState = (esp32Status.robotState || "IDLE").toUpperCase();
  const stateObj = STATE_MAP[rawState] || STATE_MAP.IDLE;

  // 1. Ultrasonic Distance
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

  // 2. Obstacle condition
  const isObstacleNow = Boolean(
    esp32Status.obstacleDetected === true ||
    rawState === "OBSTACLE" ||
    (esp32Status.lastCommand || "").toUpperCase() === "OBSTACLE"
  );

  // 3. Update Ultrasonic Obstacle Component
  updateObstacleDisplay(isObstacleNow, distStr, distNum);

  // 4. Update Medicine Compartment & RFID Security
  updateCompartmentAndAuthDisplay(esp32Status, rawState);

  // 5. Update Destination Status Pills
  updateDestinationPills(esp32Status, rawState);

  // 6. Update State Ring & Emoji
  if (stateEmoji.textContent !== stateObj.emoji) stateEmoji.textContent = stateObj.emoji;
  if (stateLabel.textContent !== stateObj.label) stateLabel.textContent = stateObj.label;

  const targetRingClass = `state-ring ${stateObj.cls}`;
  if (stateRing.className !== targetRingClass) {
    stateRing.className = targetRingClass;
  }

  // 7. Update Telemetry Detail Rows
  detailLastCmd.textContent  = esp32Status.lastCommand     || "—";
  detailDest.textContent     = esp32Status.lastDestination || "—";
  detailCmdCount.textContent = esp32Status.commandCount    ?? "—";
  detailUptime.textContent   = esp32Status.uptime != null ? formatUptime(esp32Status.uptime) : "—";
  detailIp.textContent       = esp32Status.ip              || "—";

  // 8. Handle State Transition Logging
  handleStateTransitions(rawState, isObstacleNow, distStr, distNum, esp32Status);

  // 9. Update Button Availability & Lock Enforcement
  updateButtonStates(rawState, esp32Status.lidOpen);
}

/**
 * Update the connection badge in the header.
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
 * Send a command to the backend proxy, which forwards it to the ESP32.
 * @param {"MOVE"|"STOP"|"STATUS"} command
 * @param {string} [destination]
 */
async function sendCommand(command, destination) {
  // CRITICAL SAFETY CHECK: Prevent dispatch or return if medicine compartment is open
  if (isCompartmentOpen && command !== "STOP") {
    const warningMsg = "Cannot execute movement: Medicine compartment is OPEN (90°). Scan the same RFID card to close and lock the compartment first.";
    addLog(`⚠️ Command Blocked: ${warningMsg}`, "warning");
    showToast(warningMsg, "warning", 5000);
    return;
  }

  // Prevent duplicate concurrent command requests (except STOP)
  if (isCommandInFlight && command !== "STOP") return;

  const payload = { command, ...(destination ? { destination } : {}) };

  const logPrefix = destination
    ? `→ MOVE to ${destination}`
    : `→ ${command}`;

  addLog(`${logPrefix} — sending…`, "info");

  isCommandInFlight = true;
  updateButtonStates(prevRobotState, isCompartmentOpen);
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
      showToast(errMsg, "error", 4500);
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
    updateButtonStates(prevRobotState, isCompartmentOpen);
  }
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

    sendCommand("MOVE", dest);
  });
});

/** Return to Reception button */
returnBtn.addEventListener("click", () => {
  destBtns.forEach((b) => b.classList.remove("active"));
  sendCommand("MOVE", "RECEPTION");
});

/** Manual Emergency STOP button (Always accessible) */
stopBtn.addEventListener("click", () => {
  destBtns.forEach((b) => b.classList.remove("active"));
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
  addLog("Dashboard initialized — 1000ms polling active with Obstacle Guard & RFID Security.", "info");
})();
