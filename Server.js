
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");
const crypto = require("crypto");
const firebaseKeyPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  "/etc/secrets/firebase-service-account.json";

let firebaseReady = false;
let db = null;

try {
  if (fs.existsSync(firebaseKeyPath)) {
    const serviceAccount = require(firebaseKeyPath);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    firebaseReady = true;

    console.log("Firebase Admin initialized successfully");
  } else {
    console.error("Firebase service account file not found");
  }
} catch (error) {
  console.error(
    "Firebase Admin initialization failed:",
    error.message
  );
}

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const API_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 55000;
const PHOTO_DAILY_LIMIT = 5;
const FILE_DAILY_LIMIT = 3;
// Reserve one file analysis
async function reserveFileUsage(uid) {
  const date = getIndiaDate();

  const usageRef = db
    .collection("users")
    .doc(uid)
    .collection("usage")
    .doc(date);

  return await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(usageRef);

    const currentCount = snapshot.exists
      ? Number(snapshot.get("fileCount") || 0)
      : 0;

    if (currentCount >= FILE_DAILY_LIMIT) {
      return {
        allowed: false,
        used: currentCount,
        remaining: 0
      };
    }

    const newCount = currentCount + 1;

    transaction.set(
      usageRef,
      {
        date: date,
        fileCount: newCount,
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      allowed: true,
      used: newCount,
      remaining: FILE_DAILY_LIMIT - newCount,
      usageRef: usageRef
    };
  });
}

// Refund file usage if Gemini request fails
async function refundFileUsage(usageRef) {
  if (!usageRef) return;

  try {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(usageRef);

      if (!snapshot.exists) return;

      const count = Number(
        snapshot.get("fileCount") || 0
      );

      if (count > 0) {
        transaction.update(usageRef, {
          fileCount: count - 1,
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
  } catch (error) {
    console.error(
      "File usage refund failed:",
      error.message
    );
  }
}
const VOICE_DAILY_LIMIT_SECONDS = 600;
const VOICE_HEARTBEAT_MAX_SECONDS = 45;
// Firebase login verification
async function verifyFirebaseUser(req, res, next) {
  try {
    if (!firebaseReady || !admin.apps.length) {
      return res.status(503).json({
        error: "Authentication service unavailable",
        reply: "Authentication service is temporarily unavailable."
      });
    }

    const authorization =
      req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required",
        reply: "Please login again to continue."
      });
    }

    const token = authorization.substring(7);

    const decodedToken =
      await admin.auth().verifyIdToken(token);

    req.user = decodedToken;

    next();
  } catch (error) {
    console.error(
      "Firebase token verification failed:",
      error.message
    );

    return res.status(401).json({
      error: "Invalid authentication",
      reply: "Your login session expired. Please login again."
    });
  }
}

// India date: YYYY-MM-DD
function getIndiaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  parts.forEach(part => {
    values[part.type] = part.value;
  });

  return (
    values.year + "-" +
    values.month + "-" +
    values.day
  );
}

// Reserve one photo analysis
async function reservePhotoUsage(uid) {
  const date = getIndiaDate();

  const usageRef = db
    .collection("users")
    .doc(uid)
    .collection("usage")
    .doc(date);

  return await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(usageRef);

    const currentCount = snapshot.exists
      ? Number(snapshot.get("photoCount") || 0)
      : 0;

    if (currentCount >= PHOTO_DAILY_LIMIT) {
      return {
        allowed: false,
        used: currentCount,
        remaining: 0
      };
    }

    const newCount = currentCount + 1;

    transaction.set(
      usageRef,
      {
        date: date,
        photoCount: newCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      allowed: true,
      used: newCount,
      remaining: PHOTO_DAILY_LIMIT - newCount,
      usageRef: usageRef
    };
  });
}

// Refund photo usage if Gemini request fails
async function refundPhotoUsage(usageRef) {
  if (!usageRef) return;

  try {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(usageRef);

      if (!snapshot.exists) return;

      const count = Number(
        snapshot.get("photoCount") || 0
      );

      if (count > 0) {
        transaction.update(usageRef, {
          photoCount: count - 1,
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
  } catch (error) {
    console.error(
      "Photo usage refund failed:",
      error.message
    );
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractText(data) {
  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.steps)) {
    return data.steps
      .filter(step => step.type === "model_output")
      .flatMap(step =>
        Array.isArray(step.content) ? step.content : []
      )
      .filter(item => item.type === "text")
      .map(item => item.text || "")
      .join("\n")
      .trim();
  }

  if (Array.isArray(data.output)) {
    return data.output
      .filter(item => item.type === "model_output")
      .flatMap(item =>
        Array.isArray(item.content) ? item.content : []
      )
      .filter(item => item.type === "text")
      .map(item => item.text || "")
      .join("\n")
      .trim();
  }

  return "";
}


async function askGemini(
  message,
  imageBase64,
  mimeType,
  fileBase64,
  fileMimeType
) {
  let lastStatus = 502;
  let lastMessage = "Gemini request failed";

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const input = [];

      if (imageBase64) {
        input.push({
          type: "image",
          data: imageBase64,
          mime_type: mimeType
        });
      }

      if (fileBase64 && fileMimeType === "application/pdf") {
        input.push({
          type: "document",
          data: fileBase64,
          mime_type: "application/pdf"
        });
      }

      if (fileBase64 && fileMimeType === "text/plain") {
        const fileText = Buffer
          .from(fileBase64, "base64")
          .toString("utf8");

        input.push({
          type: "text",
          text: "Uploaded file content:\n" + fileText
        });
      }

      input.push({
        type: "text",
        text: message
      });

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          input:
            imageBase64 || fileBase64
              ? input
              : message,
          system_instruction:
            "You are Aivora AI, an intelligent all-in-one personal AI assistant. " +
            "Help users with coding, Android app development, APK creation, " +
            "writing, translation, learning, research and everyday questions. " +
            "Give accurate, clear and useful answers. " +
            "Guide beginners step by step. " +
            "When providing code, provide complete and compatible code. " +
            "Analyze uploaded images and documents carefully. " +
            "Reply in the user's preferred language. " +
            "Never invent facts or claim capabilities you do not have. " +
            "When asked about your underlying technology, answer honestly."
        }),
        signal: controller.signal
      });

      const raw = await response.text();
      let data;

      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = {};
      }

      if (!response.ok) {
        lastStatus = response.status;

        lastMessage =
          data.error && data.error.message
            ? data.error.message
            : raw || "Gemini request failed";

        console.error(
          "Gemini attempt " + attempt + " failed:",
          lastStatus,
          lastMessage
        );

        const retryable =
          [429, 500, 503, 504].includes(lastStatus);

        if (!retryable || attempt === MAX_ATTEMPTS) {
          break;
        }
      } else {
        const reply = extractText(data);

        if (reply) {
          return {
            reply: reply,
            model: GEMINI_MODEL
          };
        }

        lastStatus = 502;
        lastMessage = "Gemini returned no text response.";
        break;
      }
    } catch (error) {
      lastStatus =
        error.name === "AbortError" ? 504 : 502;

      lastMessage =
        error.name === "AbortError"
          ? "Gemini request timed out"
          : error.message || "Network error";

      if (attempt === MAX_ATTEMPTS) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < MAX_ATTEMPTS) {
      await wait(1000 * Math.pow(2, attempt - 1));
    }
  }

  const error = new Error(lastMessage);
  error.status = lastStatus;
  throw error;
      }
          

// =====================================
// VOICE MODE DAILY LIMIT SYSTEM
// =====================================

// Start voice session
app.post(
  "/voice/start",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const uid = req.user.uid;
      const date = getIndiaDate();

      const usageRef = db
        .collection("users")
        .doc(uid)
        .collection("usage")
        .doc(date);

      const sessionId = crypto.randomBytes(16).toString("hex");

      const sessionRef = db
        .collection("users")
        .doc(uid)
        .collection("voiceSessions")
        .doc(sessionId);

      const now = Date.now();

      const result = await db.runTransaction(async transaction => {
        const usageSnap = await transaction.get(usageRef);

        const used = usageSnap.exists
          ? Number(usageSnap.get("voiceSeconds") || 0)
          : 0;

        if (used >= VOICE_DAILY_LIMIT_SECONDS) {
          return {
            allowed: false,
            used: used,
            remaining: 0
          };
        }

        const oldSessionId = usageSnap.exists
          ? usageSnap.get("activeVoiceSessionId")
          : null;

        let oldSessionRef = null;
        let oldSessionSnap = null;

        if (oldSessionId) {
          oldSessionRef = db
            .collection("users")
            .doc(uid)
            .collection("voiceSessions")
            .doc(oldSessionId);

          oldSessionSnap = await transaction.get(oldSessionRef);
        }

        if (
          oldSessionSnap &&
          oldSessionSnap.exists &&
          oldSessionSnap.get("status") === "active"
        ) {
          const lastHeartbeat = Number(
            oldSessionSnap.get("lastHeartbeatAt") || 0
          );

          if (now - lastHeartbeat < 60000) {
            return {
              allowed: false,
              active: true
            };
          }

          transaction.update(oldSessionRef, {
            status: "expired",
            stoppedAt: now
          });
        }

        transaction.create(sessionRef, {
          date: date,
          status: "active",
          startedAt: now,
          lastHeartbeatAt: now
        });

        transaction.set(
          usageRef,
          {
            date: date,
            activeVoiceSessionId: sessionId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        return {
          allowed: true,
          sessionId: sessionId,
          used: used,
          remaining: VOICE_DAILY_LIMIT_SECONDS - used
        };
      });

      if (!result.allowed) {
        return res.status(429).json({
          error: result.active
            ? "VOICE_SESSION_ACTIVE"
            : "VOICE_DAILY_LIMIT",
          limit: VOICE_DAILY_LIMIT_SECONDS,
          used: result.used || 0,
          remaining: result.remaining || 0,
          reply: result.active
            ? "A voice session is already active."
            : "Your daily voice limit of 10 minutes has been reached."
        });
      }

      return res.json(result);

    } catch (error) {
      console.error("Voice start failed:", error.message);

      return res.status(500).json({
        error: "VOICE_START_FAILED",
        reply: "Could not start voice mode."
      });
    }
  }
);


// Voice heartbeat
app.post(
  "/voice/heartbeat",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const uid = req.user.uid;
      const sessionId = req.body?.sessionId;

      if (
        typeof sessionId !== "string" ||
        !/^[a-f0-9]{32}$/.test(sessionId)
      ) {
        return res.status(400).json({
          error: "INVALID_SESSION"
        });
      }

      const sessionRef = db
        .collection("users")
        .doc(uid)
        .collection("voiceSessions")
        .doc(sessionId);

      const now = Date.now();
      const today = getIndiaDate();

      const result = await db.runTransaction(async transaction => {
        const sessionSnap = await transaction.get(sessionRef);

        if (!sessionSnap.exists ||
            sessionSnap.get("status") !== "active") {
          return { active: false };
        }

        const sessionDate = sessionSnap.get("date");

        const usageRef = db
          .collection("users")
          .doc(uid)
          .collection("usage")
          .doc(sessionDate);

        const usageSnap = await transaction.get(usageRef);

        if (sessionDate !== today) {
          transaction.update(sessionRef, {
            status: "stopped",
            stoppedAt: now
          });

          if (
            usageSnap.exists &&
            usageSnap.get("activeVoiceSessionId") === sessionId
          ) {
            transaction.set(usageRef, {
              activeVoiceSessionId: null
            }, { merge: true });
          }

          return {
            active: false,
            dayReset: true
          };
        }

        const last = Number(
          sessionSnap.get("lastHeartbeatAt") || now
        );

        const elapsed = Math.min(
          VOICE_HEARTBEAT_MAX_SECONDS,
          Math.max(0, Math.floor((now - last) / 1000))
        );

        const used = usageSnap.exists
          ? Number(usageSnap.get("voiceSeconds") || 0)
          : 0;

        const newUsed = Math.min(
          VOICE_DAILY_LIMIT_SECONDS,
          used + elapsed
        );

        const remaining = VOICE_DAILY_LIMIT_SECONDS - newUsed;
        const shouldStop = remaining <= 0;

        transaction.set(usageRef, {
          date: sessionDate,
          voiceSeconds: newUsed,
          activeVoiceSessionId: shouldStop ? null : sessionId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        transaction.update(sessionRef, {
          lastHeartbeatAt: now,
          status: shouldStop ? "stopped" : "active",
          stoppedAt: shouldStop ? now : null
        });

        return {
          active: !shouldStop,
          used: newUsed,
          remaining: remaining
        };
      });

      return res.json(result);

    } catch (error) {
      console.error("Voice heartbeat failed:", error.message);

      return res.status(500).json({
        error: "VOICE_HEARTBEAT_FAILED"
      });
    }
  }
);


// Stop voice session
app.post(
  "/voice/stop",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const uid = req.user.uid;
      const sessionId = req.body?.sessionId;

      if (
        typeof sessionId !== "string" ||
        !/^[a-f0-9]{32}$/.test(sessionId)
      ) {
        return res.status(400).json({
          error: "INVALID_SESSION"
        });
      }

      const sessionRef = db
        .collection("users")
        .doc(uid)
        .collection("voiceSessions")
        .doc(sessionId);

      const now = Date.now();

      const result = await db.runTransaction(async transaction => {
        const sessionSnap = await transaction.get(sessionRef);

        if (!sessionSnap.exists ||
            sessionSnap.get("status") !== "active") {
          return { stopped: true };
        }

        const date = sessionSnap.get("date");

        const usageRef = db
          .collection("users")
          .doc(uid)
          .collection("usage")
          .doc(date);

        const usageSnap = await transaction.get(usageRef);

        const last = Number(
          sessionSnap.get("lastHeartbeatAt") || now
        );

        const elapsed = Math.min(
          VOICE_HEARTBEAT_MAX_SECONDS,
          Math.max(0, Math.floor((now - last) / 1000))
        );

        const used = usageSnap.exists
          ? Number(usageSnap.get("voiceSeconds") || 0)
          : 0;

        const newUsed = Math.min(
          VOICE_DAILY_LIMIT_SECONDS,
          used + elapsed
        );

        transaction.set(usageRef, {
          date: date,
          voiceSeconds: newUsed,
          activeVoiceSessionId: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        transaction.update(sessionRef, {
          status: "stopped",
          lastHeartbeatAt: now,
          stoppedAt: now
        });

        return {
          stopped: true,
          used: newUsed,
          remaining: VOICE_DAILY_LIMIT_SECONDS - newUsed
        };
      });

      return res.json(result);

    } catch (error) {
      console.error("Voice stop failed:", error.message);

      return res.status(500).json({
        error: "VOICE_STOP_FAILED"
      });
    }
  }
);
      
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Aivora AI",
    message: "Aivora AI server is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ai: "Gemini",
    configured: Boolean(GEMINI_API_KEY),
    firebase: firebaseReady,
    model: GEMINI_MODEL,
    api: "Interactions",
    imageSupport: true
  });
});


app.post(
  "/chat",
  verifyFirebaseUser,
  async (req, res) => {
    const message =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    const imageBase64 =
      typeof req.body?.imageBase64 === "string"
        ? req.body.imageBase64.replace(
            /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
            ""
          )
        : "";

    const mimeType =
      typeof req.body?.mimeType === "string"
        ? req.body.mimeType
        : "image/jpeg";

    const fileBase64 =
      typeof req.body?.fileBase64 === "string"
        ? req.body.fileBase64.replace(
            /^data:[^;]+;base64,/,
            ""
          )
        : "";

    const fileMimeType =
      typeof req.body?.fileMimeType === "string"
        ? req.body.fileMimeType
        : "";

    if (!message && !imageBase64 && !fileBase64) {
      return res.status(400).json({
        error: "Input required",
        reply: "Please enter a message or select a file."
      });
    }

    if (imageBase64 && fileBase64) {
      return res.status(400).json({
        error: "One attachment at a time",
        reply: "Please send an image or a document separately."
      });
    }

    if (imageBase64) {
      if (
        !["image/jpeg", "image/png", "image/webp"]
          .includes(mimeType)
      ) {
        return res.status(400).json({
          error: "Unsupported image type",
          reply: "Please select a JPG, PNG or WEBP image."
        });
      }

      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64)) {
        return res.status(400).json({
          error: "Invalid image data",
          reply: "The selected image data is invalid."
        });
      }

      const imageSize = Math.floor(
        imageBase64.length * 3 / 4
      );

      if (imageSize > 14 * 1024 * 1024) {
        return res.status(413).json({
          error: "Image too large",
          reply: "Please select an image smaller than 14 MB."
        });
      }
    }

    if (fileBase64) {
      if (
        !["application/pdf", "text/plain"]
          .includes(fileMimeType)
      ) {
        return res.status(400).json({
          error: "Unsupported file type",
          reply: "Only PDF and TXT files are supported."
        });
      }

      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(fileBase64)) {
        return res.status(400).json({
          error: "Invalid file data",
          reply: "The selected file data is invalid."
        });
      }

      const fileSize = Math.floor(
        fileBase64.length * 3 / 4
      );

      if (fileSize > 12 * 1024 * 1024) {
        return res.status(413).json({
          error: "File too large",
          reply: "Please select a file smaller than 12 MB."
        });
      }
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Server configuration error",
        reply: "AI server configuration is incomplete."
      });
    }

    let photoReservation = null;
    let fileReservation = null;

    try {
      if (imageBase64) {
        photoReservation = await reservePhotoUsage(
          req.user.uid
        );

        if (!photoReservation.allowed) {
          return res.status(429).json({
            error: "PHOTO_DAILY_LIMIT",
            limit: PHOTO_DAILY_LIMIT,
            used: photoReservation.used,
            remaining: 0,
            reply:
              "Your daily photo AI limit of 5 has been reached. Please try again after midnight."
          });
        }
      }

      if (fileBase64) {
        fileReservation = await reserveFileUsage(
          req.user.uid
        );

        if (!fileReservation.allowed) {
          return res.status(429).json({
            error: "FILE_DAILY_LIMIT",
            limit: FILE_DAILY_LIMIT,
            used: fileReservation.used,
            remaining: 0,
            reply:
              "Your daily file analysis limit of 3 has been reached. Please try again after midnight."
          });
        }
      }

      const prompt = message ||
        (imageBase64
          ? "Please describe this image in detail."
          : "Please analyze this uploaded file in detail.");

      const result = await askGemini(
        prompt,
        imageBase64,
        mimeType,
        fileBase64,
        fileMimeType
      );

      if (imageBase64) {
        result.photoUsage = {
          limit: PHOTO_DAILY_LIMIT,
          used: photoReservation.used,
          remaining: photoReservation.remaining
        };
      }

      if (fileBase64) {
        result.fileUsage = {
          limit: FILE_DAILY_LIMIT,
          used: fileReservation.used,
          remaining: fileReservation.remaining
        };
      }

      return res.status(200).json(result);

    } catch (error) {
      if (photoReservation && photoReservation.usageRef) {
        await refundPhotoUsage(
          photoReservation.usageRef
        );
      }

      if (fileReservation && fileReservation.usageRef) {
        await refundFileUsage(
          fileReservation.usageRef
        );
      }

      const status = error.status || 502;

      console.error(
        "Chat request failed:",
        status,
        error.message
      );

      let reply =
        "Aivora AI could not get a response from Gemini.";

      if (status === 429) {
        reply = "Gemini quota limit reached. Please try again later.";
      } else if (status === 503) {
        reply = "Gemini is temporarily busy. Please try again later.";
      } else if (status === 504) {
        reply = "Gemini request timed out. Please try again.";
      }

      return res.status(status).json({
        error: "Gemini request failed",
        upstreamStatus: status,
        reply: reply
      });
    }
  }
);


app.listen(PORT, "0.0.0.0", () => {
  console.log("Aivora AI server running on port " + PORT);
  console.log("Gemini model configured: " + GEMINI_MODEL);
  console.log("Firebase authentication: " + firebaseReady);
  console.log("Photo daily limit: " + PHOTO_DAILY_LIMIT);
  console.log("Image support enabled");
  console.log("API: Interactions");
});
      
