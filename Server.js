
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");

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

async function askGemini(message, imageBase64, mimeType) {
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
          input: imageBase64 ? input : message,
          system_instruction:
            "You are Aivora AI, an intelligent all-in-one personal AI assistant. " +
            "Help users with coding, Android app development, APK creation, " +
            "writing, translation, learning, research and everyday questions. " +
            "Give accurate, clear and useful answers. " +
            "Guide beginners step by step. " +
            "When providing code, provide complete and compatible code. " +
            "Analyze uploaded images carefully. " +
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

    if (!message && !imageBase64) {
      return res.status(400).json({
        error: "Message or image required",
        reply: "Please enter a message or select a photo."
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

      const estimatedSize = Math.floor(
        imageBase64.length * 3 / 4
      );

      if (estimatedSize > 14 * 1024 * 1024) {
        return res.status(413).json({
          error: "Image too large",
          reply: "Please select an image smaller than 14 MB."
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

    try {
      // Enforce photo daily limit
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

      const prompt = message ||
        "Please describe this image in detail.";

      const result = await askGemini(
        prompt,
        imageBase64,
        mimeType
      );

      if (imageBase64) {
        result.photoUsage = {
          limit: PHOTO_DAILY_LIMIT,
          used: photoReservation.used,
          remaining: photoReservation.remaining
        };
      }

      return res.status(200).json(result);

    } catch (error) {
      if (photoReservation && photoReservation.usageRef) {
        await refundPhotoUsage(photoReservation.usageRef);
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
      
