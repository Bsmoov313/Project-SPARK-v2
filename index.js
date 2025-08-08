// index.js (ESM)
// Express server + Google Drive change watcher with subfolder support

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";

// ---------- ENV VARS you set in App Hosting ----------
const {
  // Share your Cube ACR *root folder* with this service account email
  DRIVE_SERVICE_ACCOUNT_JSON, // paste JSON (or base64) of service account key
  DRIVE_FOLDER_ID,            // the Cube ACR root folder ID (NOT a date subfolder)
  PROCESS_WEBHOOK_URL,        // your processing endpoint (e.g. https://<your-app>/api/process-recording)
  DRIVE_VERIFY_TOKEN = ""     // optional: set to any strong string; Drive will echo it in header
} = process.env;

// In-memory Drive page token (simple for now; we can move to Firestore later)
let lastPageToken = null;

// ---------- Basic server ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());

// Health
app.get("/", (_req, res) => {
  res.status(200).send("🚀 SPARK v2 App Hosting server up.");
});

// ----- Google Drive auth (service account) -----
function driveClient() {
  if (!DRIVE_SERVICE_ACCOUNT_JSON) throw new Error("Missing DRIVE_SERVICE_ACCOUNT_JSON env.");
  const keyObj = JSON.parse(
    // allow base64 or raw JSON
    Buffer.from(DRIVE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8") || DRIVE_SERVICE_ACCOUNT_JSON
  );

  const jwt = new google.auth.JWT(
    keyObj.client_email,
    null,
    keyObj.private_key,
    ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.metadata.readonly"]
  );
  return google.drive({ version: "v3", auth: jwt });
}

const AUDIO_EXTS = [".m4a", ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4b"];
const FOLDER_MIME = "application/vnd.google-apps.folder";

const isAudio = (name = "", mime = "") =>
  mime.startsWith("audio/") || AUDIO_EXTS.some((ext) => name.toLowerCase().endsWith(ext));

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
    supportsAllDrives: true
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
    if (!parents.length) return false; // reached root
    if (parents.includes(rootFolderId)) return true;
    stack.push(...parents);
  }
  return false;
}

// ---------- 1) Register a Drive watch channel ----------
// Call this once (POST /drive/register) after you set env vars
app.post("/drive/register", async (_req, res) => {
  try {
    if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
      return res.status(400).json({ error: "Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL" });
    }
    const drive = driveClient();

    // get or refresh a startPageToken
    const { data: token } = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    lastPageToken = token.startPageToken;

    // Build webhook URL (this server’s notify endpoint)
    // Use your live domain if you have one; App Hosting usually proxies the Node app directly.
    const baseUrl = process.env.APP_HOST_URL || ""; // set this env to your live app URL if needed
    const notifyUrl = baseUrl
      ? `${baseUrl}/drive/notify`
      : `/drive/notify`; // If baseUrl empty, Drive will reject; set APP_HOST_URL after first deploy.

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

      try {
        const r = await fetch(PROCESS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
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

  // Save new token in memory (good for a single running instance)
  if (newStart) lastPageToken = newStart;
}

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`✅ SPARK v2 server listening on ${PORT}`);
});
