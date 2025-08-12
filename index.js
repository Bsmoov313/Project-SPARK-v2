// index.js (ESM)
// Express server + Google Drive change watcher with subfolder support
// + easy test endpoints (simulate Drive or send a fake file directly)

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";

// ---------- ENV VARS you set in App Hosting ----------
const {
  // For Drive watch + scanning:
  DRIVE_SERVICE_ACCOUNT_JSON, // JSON (or base64) of service account key that has access to the Cube ACR folder
  DRIVE_FOLDER_ID,            // the Cube ACR root folder ID (NOT a date subfolder)
  PROCESS_WEBHOOK_URL,        // your processing endpoint (e.g. https://<your-app>/api/process-recording)
  DRIVE_VERIFY_TOKEN = "",    // optional: echoed by Google in X-Goog-Channel-Token

  // Optional convenience for logs/links:
  APP_HOST_URL = ""
} = process.env;

// In-memory Drive page token (simple for now; we can persist later)
let lastPageToken = null;

// ---------- Basic server ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());

// Health
app.get("/", (_req, res) => {
  res.status(200).send("🚀 SPARK v2 App Hosting server up.");
});

// ---------- Helpers ----------
const AUDIO_EXTS = [".m4a", ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4b"];
const FOLDER_MIME = "application/vnd.google-apps.folder";

const isAudio = (name = "", mime = "") =>
  (mime && mime.startsWith("audio/")) ||
  AUDIO_EXTS.some((ext) => (name || "").toLowerCase().endsWith(ext));

const detectCallType = (name = "") => {
  const n = (name || "").toLowerCase();
  if (n.includes("incoming")) return "incoming";
  if (n.includes("outgoing")) return "outgoing";
  return "unknown";
};

async function postToProcessor(payload) {
  if (!PROCESS_WEBHOOK_URL) {
    console.error("Missing PROCESS_WEBHOOK_URL; cannot send payload.");
    return { ok: false, status: 500, text: "PROCESS_WEBHOOK_URL not set" };
  }
  try {
    const r = await fetch(PROCESS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const txt = await r.text().catch(() => "");
    if (!r.ok) console.error("PROCESS_WEBHOOK_URL failed:", r.status, txt);
    return { ok: r.ok, status: r.status, text: txt || "" };
  } catch (e) {
    console.error("Webhook POST error:", e.message);
    return { ok: false, status: 500, text: e.message };
  }
}

// ----- Google Drive auth (service account) -----
function driveClient() {
  if (!DRIVE_SERVICE_ACCOUNT_JSON) throw new Error("Missing DRIVE_SERVICE_ACCOUNT_JSON env.");
  // Accept base64 or raw JSON
  let raw = DRIVE_SERVICE_ACCOUNT_JSON;
  try {
    const decoded = Buffer.from(DRIVE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8");
    // If base64 was actually raw JSON, JSON.parse below will still work
    if (decoded && decoded.trim().startsWith("{")) raw = decoded;
  } catch (_) { /* ignore */ }

  const keyObj = JSON.parse(raw);

  const jwt = new google.auth.JWT(
    keyObj.client_email,
    null,
    keyObj.private_key,
    [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly"
    ]
  );
  return google.drive({ version: "v3", auth: jwt });
}

// Cache parents to reduce API calls
const parentCache = new Map(); // id -> parents[]
async function getParents(drive, id) {
  if (parentCache.has(id)) return parentCache.get(id);
  const { data } = await drive.files.get({
    fileId: id,
    fields: "id,parents",
    supportsAllDrives: true
  });
  const parents = data.parents || [];
  parentCache.set(id, parents);
  return parents;
}

// Climb up until we hit the root Cube ACR folder or Drive root
async function isInSubtree(drive, fileOrFolderId, rootFolderId) {
  let stack = [fileOrFolderId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const parents = await getParents(drive, cur);
    if (!parents.length) return false; // reached root
    if (parents.includes(rootFolderId)) return true;
    stack.push(...parents);
  }
  return false;
}

// ---------- 1) Register a Drive watch channel ----------
// Call this once (POST /drive/register) after env vars are set and the app is reachable publicly.
app.post("/drive/register", async (_req, res) => {
  try {
    if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
      return res.status(400).json({ error: "Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL" });
    }
    const drive = driveClient();

    // get or refresh a startPageToken
    const { data: token } = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    lastPageToken = token.startPageToken;

    const notifyUrl = APP_HOST_URL
      ? `${APP_HOST_URL.replace(/\/+$/, "")}/drive/notify`
      : null;

    if (!notifyUrl) {
      return res.status(400).json({
        error: "APP_HOST_URL not set; set it to your live app URL so Drive can call /drive/notify."
      });
    }

    // Create channel
    const channelId = `chan_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const { data: watch } = await drive.changes.watch({
      pageToken: lastPageToken,
      supportsAllDrives: true,
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: notifyUrl,
        token: DRIVE_VERIFY_TOKEN || undefined
      }
    });

    return res.status(200).json({
      ok: true,
      message: "Drive watch registered.",
      channel: { id: watch.id, resourceId: watch.resourceId },
      pageToken: lastPageToken,
      notifyUrl
    });
  } catch (err) {
    console.error("register error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---------- 2) Drive webhook receiver ----------
app.post("/drive/notify", async (req, res) => {
  try {
    // Optional token check
    const token = req.get("X-Goog-Channel-Token") || "";
    if (DRIVE_VERIFY_TOKEN && token !== DRIVE_VERIFY_TOKEN) {
      return res.status(403).send("bad token");
    }

    // Immediately ack; then process in background (best-effort)
    res.status(204).end();

    // Process changes since lastPageToken
    await harvestChangesAndDispatch();
  } catch (err) {
    console.error("notify error:", err);
    // Acked already
  }
});

// Harvest Drive changes and send to processor
async function harvestChangesAndDispatch() {
  if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
    throw new Error("Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL.");
  }
  const drive = driveClient();

  // If we don't have a saved token yet, start now
  if (!lastPageToken) {
    const { data: token } = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    lastPageToken = token.startPageToken;
  }

  let nextToken = lastPageToken;
  let newStart = null;

  do {
    const { data } = await drive.changes.list({
      pageToken: nextToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields:
        "changes(fileId,file(name,mimeType,parents,webViewLink,webContentLink,createdTime,modifiedTime)),nextPageToken,newStartPageToken"
    });

    nextToken = data.nextPageToken || null;
    if (data.newStartPageToken) newStart = data.newStartPageToken;

    const changes = data.changes || [];
    for (const ch of changes) {
      const f = ch.file;
      if (!f || !f.id) continue;
      if (f.mimeType === FOLDER_MIME) continue;

      const inside = await isInSubtree(drive, f.id, DRIVE_FOLDER_ID);
      if (!inside) continue;

      if (!isAudio(f.name, f.mimeType)) continue;

      const payload = {
        source: "google_drive",
        fileId: f.id,
        webViewLink: f.webViewLink || null,
        webContentLink: f.webContentLink || null,
        fileName: f.name,
        mimeType: f.mimeType,
        createdAt: f.createdTime,
        modifiedAt: f.modifiedTime,
        callType: detectCallType(f.name)
      };

      await postToProcessor(payload);
    }
  } while (nextToken);

  if (newStart) lastPageToken = newStart;
}

// ---------- 3) Test endpoints ----------

// (A) Trigger the real Drive scan (as if Drive called /drive/notify)
app.post("/test-drive-notify", async (_req, res) => {
  try {
    await harvestChangesAndDispatch();
    res.json({ ok: true, mode: "drive-scan" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// (B) Simulate a single “new recording” WITHOUT Drive.
//     You can POST JSON or call it via GET with query params.
app.post("/test-simulate-file", async (req, res) => {
  const {
    fileName = "Incoming Call.m4a",
    mimeType = "audio/m4a",
    webViewLink = null,
    webContentLink = null,
  } = req.body || {};

  const payload = {
    source: "simulated",
    fileId: null,
    webViewLink,
    webContentLink,
    fileName,
    mimeType,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    callType: detectCallType(fileName)
  };

  const result = await postToProcessor(payload);
  res.status(result.ok ? 200 : 500).json({ ok: result.ok, status: result.status, payload, response: result.text });
});

// Optional: GET version for quick tests from a phone browser.
// Example:  /test-simulate-file?fileName=Outgoing%20Call.mp3
app.get("/test-simulate-file", async (req, res) => {
  const fileName = req.query.fileName || "Incoming Call.m4a";
  const mimeType = req.query.mimeType || "audio/m4a";
  const webViewLink = req.query.webViewLink || null;
  const webContentLink = req.query.webContentLink || null;

  const payload = {
    source: "simulated",
    fileId: null,
    webViewLink,
    webContentLink,
    fileName,
    mimeType,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    callType: detectCallType(String(fileName))
  };

  const result = await postToProcessor(payload);
  res
    .status(result.ok ? 200 : 500)
    .send(
      `Sent simulated payload for "${fileName}". Processor status: ${result.status}. ${result.text || ""}`
    );
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`✅ SPARK v2 server listening on ${PORT}`);
});
