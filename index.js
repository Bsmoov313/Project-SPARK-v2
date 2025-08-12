// index.js (ESM)
// Express server + Google Drive change watcher with subfolder support
// Includes: /health, /test/process, /test/drive-notify, /drive/register, /drive/notify

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";

// ---------- ENV VARS (set these in Firebase App Hosting / apphosting.yaml via secrets) ----------
const {
  // Base64 of your service account JSON (or raw JSON string)
  DRIVE_SERVICE_ACCOUNT_JSON,
  // The Cube ACR **root** folder ID (not a dated subfolder)
  DRIVE_FOLDER_ID,
  // Where to POST new audio file notifications for processing
  PROCESS_WEBHOOK_URL,
  // Optional: token Google will echo in notify headers; we validate it
  DRIVE_VERIFY_TOKEN = "",
  // Optional: your public app URL (used only for /drive/register)
  APP_HOST_URL = "",
} = process.env;

// ---------- App setup ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());

// Basic landing
app.get("/", (_req, res) => {
  res
    .status(200)
    .send(
      `<html><head><meta charset="utf-8"><title>SPARK v2</title></head><body style="font-family:system-ui;padding:24px">
        <h1>🚀 SPARK v2 App Hosting server</h1>
        <p>Up and running.</p>
        <ul>
          <li>GET <code>/health</code></li>
          <li>POST <code>/test/process</code></li>
          <li>POST <code>/test/drive-notify</code></li>
          <li>POST <code>/drive/register</code></li>
          <li>POST <code>/drive/notify</code></li>
        </ul>
      </body></html>`
    );
});

// HEALTH: simple 200 OK for scripts/monitors
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "spark-v2", ts: Date.now() });
});

// ---------- Google Drive auth (service account) ----------
function driveClient() {
  if (!DRIVE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing env: DRIVE_SERVICE_ACCOUNT_JSON");
  }
  // allow base64 or raw JSON
  let raw = DRIVE_SERVICE_ACCOUNT_JSON;
  try {
    raw = Buffer.from(DRIVE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8");
    // if decode produced binary-ish junk, JSON.parse will fail and we'll fall back
  } catch {}
  const keyObj = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return JSON.parse(DRIVE_SERVICE_ACCOUNT_JSON);
    }
  })();

  const jwt = new google.auth.JWT(
    keyObj.client_email,
    null,
    keyObj.private_key,
    [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ]
  );
  return google.drive({ version: "v3", auth: jwt });
}

const AUDIO_EXTS = [".m4a", ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4b"];
const FOLDER_MIME = "application/vnd.google-apps.folder";
const isAudio = (name = "", mime = "") =>
  mime.startsWith("audio/") ||
  AUDIO_EXTS.some((ext) => name.toLowerCase().endsWith(ext));
const detectCallType = (name = "") => {
  const n = name.toLowerCase();
  if (n.includes("incoming")) return "incoming";
  if (n.includes("outgoing")) return "outgoing";
  return "unknown";
};

// parent cache for fewer Drive calls
const parentCache = new Map(); // id -> parents[]
async function getParents(drive, id) {
  if (parentCache.has(id)) return parentCache.get(id);
  const { data } = await drive.files.get({
    fileId: id,
    fields: "id,parents",
    supportsAllDrives: true,
  });
  const parents = data.parents || [];
  parentCache.set(id, parents);
  return parents;
}

// climb up until we hit the root Cube ACR folder or Drive root
async function isInSubtree(drive, fileOrFolderId, rootFolderId) {
  let stack = [fileOrFolderId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const parents = await getParents(drive, cur);
    if (!parents.length) return false; // reached Drive root
    if (parents.includes(rootFolderId)) return true;
    stack.push(...parents);
  }
  return false;
}

// In-memory Drive page token (good enough for single instance)
let lastPageToken = null;

// ---------- 1) Register a Drive watch channel (manual trigger) ----------
app.post("/drive/register", async (_req, res) => {
  try {
    if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
      return res
        .status(400)
        .json({ error: "Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL" });
    }
    if (!APP_HOST_URL) {
      return res.status(400).json({
        error:
          "APP_HOST_URL is required for Drive to call your /drive/notify endpoint.",
      });
    }

    const drive = driveClient();

    // start page token
    const { data: token } = await drive.changes.getStartPageToken({
      supportsAllDrives: true,
    });
    lastPageToken = token.startPageToken;

    // Create channel
    const channelId = `chan_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    const notifyUrl = `${APP_HOST_URL.replace(/\/$/, "")}/drive/notify`;

    const { data: watch } = await drive.changes.watch({
      pageToken: lastPageToken,
      supportsAllDrives: true,
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: notifyUrl,
        token: DRIVE_VERIFY_TOKEN || undefined,
      },
    });

    return res.status(200).json({
      ok: true,
      message: "Drive watch registered.",
      channel: { id: watch.id, resourceId: watch.resourceId },
      pageToken: lastPageToken,
      notifyUrl,
    });
  } catch (err) {
    console.error("register error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---------- 2) Drive webhook receiver ----------
app.post("/drive/notify", async (req, res) => {
  try {
    // Optional token check from header
    const token = req.get("X-Goog-Channel-Token") || "";
    if (DRIVE_VERIFY_TOKEN && token !== DRIVE_VERIFY_TOKEN) {
      return res.status(403).send("bad token");
    }

    // Ack immediately
    res.status(204).end();

    // Process changes since lastPageToken
    await harvestChangesAndDispatch();
  } catch (err) {
    console.error("notify error:", err);
    // already acked
  }
});

async function harvestChangesAndDispatch() {
  if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
    throw new Error("Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL.");
  }
  const drive = driveClient();

  // ensure we have a starting token
  if (!lastPageToken) {
    const { data: token } = await drive.changes.getStartPageToken({
      supportsAllDrives: true,
    });
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
        "changes(fileId,file(id,name,mimeType,parents,webViewLink,webContentLink,createdTime,modifiedTime)),nextPageToken,newStartPageToken",
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
        callType: detectCallType(f.name),
      };

      try {
        const r = await fetch(PROCESS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          console.error("PROCESS_WEBHOOK_URL failed:", r.status, t);
        }
      } catch (e) {
        console.error("Webhook POST error:", e.message);
      }
    }
  } while (nextToken);

  if (newStart) lastPageToken = newStart;
}

// ---------- TEST ROUTES ----------
app.post("/test/process", async (req, res) => {
  try {
    const payload =
      req.body && Object.keys(req.body).length
        ? req.body
        : {
            source: "manual_test",
            fileId: "TEST_FILE_ID",
            fileName: "TEST_FILE_NAME.m4a",
            mimeType: "audio/m4a",
            callType: "outgoing",
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
          };

    if (!PROCESS_WEBHOOK_URL) {
      return res
        .status(400)
        .json({ ok: false, error: "PROCESS_WEBHOOK_URL not set" });
    }

    const r = await fetch(PROCESS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    res.status(200).json({ ok: true, echoed: payload, downstream: r.status, body: text.slice(0, 3000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/test/drive-notify", async (_req, res) => {
  try {
    await harvestChangesAndDispatch();
    res.status(200).json({ ok: true, ran: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`✅ SPARK v2 server listening on ${PORT}`);
});
