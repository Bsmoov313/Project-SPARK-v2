// index.js (ESM) — SPARK v2 App Hosting backend
// Express server + Google Drive watcher + test endpoints

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";

// ---------- ENV VARS ----------
const {
  // Google OAuth (already coming from Secret Manager via apphosting.yaml)
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,

  // For Drive watcher + tests
  DRIVE_SERVICE_ACCOUNT_JSON,     // optional: if you use a service account instead of refresh token
  DRIVE_FOLDER_ID,                // REQUIRED for real Drive watching (root Cube ACR folder id)
  PROCESS_WEBHOOK_URL,            // REQUIRED: where we POST each audio file payload
  DRIVE_VERIFY_TOKEN = "",        // optional: webhook verify

  // Useful for the /drive/register helper (the public URL of this app)
  APP_HOST_URL,                   // e.g. https://project-spark-v2--project-spark-v2.us-central1.hosted.app
} = process.env;

// ---------- Basic server ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());

// Root & health
app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("🚀 SPARK v2 App Hosting server up.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// ---------- Google Drive auth ----------
function driveClient() {
  // Prefer service account if provided; otherwise use OAuth2 with refresh token.
  if (DRIVE_SERVICE_ACCOUNT_JSON) {
    const keyObj = JSON.parse(
      Buffer.from(DRIVE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8") ||
        DRIVE_SERVICE_ACCOUNT_JSON
    );
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

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing Google OAuth env vars.");
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  return google.drive({ version: "v3", auth: oauth2Client });
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

// climb up until we hit the given root folder or Drive root
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

// In-memory Drive page token (simple)
let lastPageToken = null;

// ---------- Register a Drive watch channel (helper) ----------
app.post("/drive/register", async (_req, res) => {
  try {
    if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
      return res
        .status(400)
        .json({ error: "Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL" });
    }
    const drive = driveClient();

    // Get/refresh start page token
    const { data: token } = await drive.changes.getStartPageToken({
      supportsAllDrives: true,
    });
    lastPageToken = token.startPageToken;

    // Build webhook URL to *this* app
    if (!APP_HOST_URL) {
      return res
        .status(400)
        .json({ error: "APP_HOST_URL not set; cannot register webhook." });
    }
    const notifyUrl = `${APP_HOST_URL}/drive/notify`;

    const channelId = `chan_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;

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

// ---------- Drive webhook receiver ----------
app.post("/drive/notify", async (req, res) => {
  try {
    const token = req.get("X-Goog-Channel-Token") || "";
    if (DRIVE_VERIFY_TOKEN && token !== DRIVE_VERIFY_TOKEN) {
      return res.status(403).send("bad token");
    }

    // Ack quickly
    res.status(204).end();

    // Process changes since last token
    await harvestChangesAndDispatch();
  } catch (err) {
    console.error("notify error:", err);
  }
});

async function harvestChangesAndDispatch() {
  if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
    throw new Error("Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL.");
  }
  const drive = driveClient();

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
        "changes(fileId,file(name,mimeType,parents,webViewLink,webContentLink,createdTime,modifiedTime)),nextPageToken,newStartPageToken",
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

// ---------- Test / dev helpers ----------
app.post("/dev/echo", async (req, res) => {
  res.status(200).json({ ok: true, echo: req.body || null });
});

app.post("/test/process", async (_req, res) => {
  if (!PROCESS_WEBHOOK_URL) {
    return res
      .status(400)
      .json({ ok: false, error: "PROCESS_WEBHOOK_URL not set" });
  }
  const dummy = {
    source: "manual_test",
    fileId: "TEST_FILE_ID",
    fileName: "TEST_FILE_NAME",
    mimeType: "audio/m4a",
    webViewLink: null,
    webContentLink: null,
    callType: "outgoing",
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };
  try {
    const r = await fetch(PROCESS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dummy),
    });
    const text = await r.text();
    return res.status(200).json({ ok: true, status: r.status, body: text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/test/drive-notify", async (_req, res) => {
  try {
    if (!DRIVE_FOLDER_ID || !PROCESS_WEBHOOK_URL) {
      return res.status(400).json({
        ok: false,
        error: "Missing DRIVE_FOLDER_ID or PROCESS_WEBHOOK_URL",
      });
    }
    await harvestChangesAndDispatch();
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`✅ SPARK v2 server listening on ${PORT}`);
});
