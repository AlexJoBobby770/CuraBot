/**
 * CuraBot+ — Node.js Express Backend
 * ------------------------------------
 * Acts as the bridge between the browser dashboard and the ESP32.
 * All commands are validated here before being forwarded to the robot.
 *
 * Run:  node server.js
 * Port: 3000 (default)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

// ── ESP32 Configuration ─────────────────────────────────────────────────────
// Set ESP32_URL in your .env file (copy .env.example → .env and edit).
// Default falls back to the IP you recorded during initial setup.
const ESP32_URL = process.env.ESP32_URL || "http://192.168.29.162";
const ESP32_TIMEOUT_MS = parseInt(process.env.ESP32_TIMEOUT_MS || "5000", 10);

// ── Valid values ─────────────────────────────────────────────────────────────
const VALID_COMMANDS = ["MOVE", "STOP", "STATUS"];
const VALID_DESTINATIONS = ["PHARMACY", "WARD A", "WARD B", "EMERGENCY ROOM", "RECEPTION"];

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Simple request logger so you can follow the flow in the terminal
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}]  ${req.method}  ${req.path}`);
  next();
});

// ── Helper: Send an HTTP request to the ESP32 ────────────────────────────────
/**
 * Makes a raw Node.js http request to the ESP32.
 * We avoid third-party HTTP clients (axios, node-fetch) to keep
 * the dependency list minimal for a beginner project.
 *
 * @param {string} method   - "GET" or "POST"
 * @param {string} path     - e.g. "/status" or "/command"
 * @param {object|null} body - JSON body for POST requests
 * @returns {Promise<{statusCode: number, data: object}>}
 */
function esp32Request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(ESP32_URL);
    const postData = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: path,
      method: method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}),
      },
      timeout: ESP32_TIMEOUT_MS,
    };

    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(raw);
          resolve({ statusCode: res.statusCode, data });
        } catch {
          // ESP32 returned non-JSON (rare but possible during boot)
          resolve({ statusCode: res.statusCode, data: { raw } });
        }
      });
    });

    // Network-level timeout (e.g. robot powered off)
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ESP32 request timed out"));
    });

    // Connection refused / no route to host
    req.on("error", (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// ── Route: POST /api/command ─────────────────────────────────────────────────
/**
 * Accepts a command from the dashboard, validates it, then forwards it
 * to the ESP32's POST /command endpoint.
 *
 * Expected body:
 *   { "command": "MOVE", "destination": "PHARMACY" }
 *   { "command": "STOP" }
 *   { "command": "STATUS" }
 */
app.post("/api/command", async (req, res) => {
  const { command, destination } = req.body || {};

  // ── Validation ──────────────────────────────────────────────────────────
  if (!command) {
    return res.status(400).json({
      success: false,
      error: "Missing required field: command",
    });
  }

  const cmd = String(command).toUpperCase().trim();

  if (!VALID_COMMANDS.includes(cmd)) {
    return res.status(400).json({
      success: false,
      error: `Invalid command "${cmd}". Allowed: ${VALID_COMMANDS.join(", ")}`,
    });
  }

  if (cmd === "MOVE") {
    if (!destination) {
      return res.status(400).json({
        success: false,
        error: "MOVE command requires a destination field",
      });
    }

    const dest = String(destination).toUpperCase().trim();

    if (!VALID_DESTINATIONS.includes(dest)) {
      return res.status(400).json({
        success: false,
        error: `Invalid destination "${dest}". Allowed: ${VALID_DESTINATIONS.join(", ")}`,
      });
    }
  }

  // ── Forward to ESP32 ────────────────────────────────────────────────────
  const payload = {
    command: cmd,
    ...(destination
      ? { destination: String(destination).toUpperCase().trim() }
      : {}),
  };

  console.log(`  → Forwarding to ESP32: ${JSON.stringify(payload)}`);

  try {
    const { statusCode, data } = await esp32Request("POST", "/command", payload);

    if (statusCode === 200) {
      console.log(`  ← ESP32 acknowledged: ${JSON.stringify(data)}`);
      return res.status(200).json({
        success: true,
        message: "Command acknowledged by ESP32",
        esp32Response: data,
      });
    } else {
      console.warn(`  ← ESP32 returned HTTP ${statusCode}: ${JSON.stringify(data)}`);
      const errorMsg = (data && (data.message || data.error)) || `ESP32 returned status ${statusCode}`;
      const forwardStatus = (statusCode >= 400 && statusCode < 600) ? statusCode : 502;
      return res.status(forwardStatus).json({
        success: false,
        error: errorMsg,
        esp32Response: data,
      });
    }
  } catch (err) {
    // Do NOT fake success — tell the dashboard exactly what went wrong
    const isTimeout = err.message.includes("timed out");
    const isOffline =
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.code === "EHOSTUNREACH" ||
      err.code === "ENETUNREACH";

    let userMessage = "Failed to reach ESP32";
    if (isTimeout) userMessage = "ESP32 did not respond in time (timeout)";
    if (isOffline) userMessage = "ESP32 is offline or unreachable";

    console.error(`  ✗ ${userMessage}: ${err.message}`);

    return res.status(503).json({
      success: false,
      error: userMessage,
      detail: err.message,
    });
  }
});

// ── Route: GET /api/status ───────────────────────────────────────────────────
/**
 * Polls the ESP32's GET /status endpoint and returns the result.
 * The dashboard uses this to show the connection indicator.
 */
app.get("/api/status", async (req, res) => {
  try {
    const { statusCode, data } = await esp32Request("GET", "/status");

    if (statusCode === 200) {
      return res.status(200).json({
        success: true,
        connected: true,
        esp32Status: data,
        esp32Url: ESP32_URL,
      });
    } else {
      return res.status(502).json({
        success: false,
        connected: false,
        error: `ESP32 returned HTTP ${statusCode}`,
      });
    }
  } catch (err) {
    const isTimeout = err.message.includes("timed out");
    const isOffline =
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.code === "EHOSTUNREACH" ||
      err.code === "ENETUNREACH";

    let userMessage = "Cannot reach ESP32";
    if (isTimeout) userMessage = "ESP32 status check timed out";
    if (isOffline) userMessage = "ESP32 is offline";

    return res.status(503).json({
      success: false,
      connected: false,
      error: userMessage,
    });
  }
});

// ── Route: GET /api/config ───────────────────────────────────────────────────
// Lets the frontend know which ESP32 URL the backend is targeting.
// Useful for the "Settings" section of the dashboard.
app.get("/api/config", (req, res) => {
  res.json({ esp32Url: ESP32_URL });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "CuraBot+ Backend", timestamp: new Date() });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║        CuraBot+ Backend — ONLINE         ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Server  : http://localhost:${PORT}          ║`);
  console.log(`║  ESP32   : ${ESP32_URL.padEnd(30)} ║`);
  console.log(`║  Timeout : ${ESP32_TIMEOUT_MS}ms                         ║`);
  console.log("╚══════════════════════════════════════════╝");
});
