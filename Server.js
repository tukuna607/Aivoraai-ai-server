
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const API_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 55000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractText(data) {
  // Convenience field, if provided by the API
  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  // REST Interactions API: text is inside steps
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

  // Fallback for compatible response formats
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

async function askGemini(message) {
  let lastStatus = 502;
  let lastMessage = "Gemini request failed";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          input: message,
          system_instruction:
            "You are Aivora AI, a helpful AI assistant. " +
            "Give accurate, clear and useful answers. " +
            "Reply in the user's language when possible."
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
          "Gemini attempt " + attempt + "/" + MAX_ATTEMPTS +
          " failed: " + lastStatus + " " + lastMessage
        );

        const retryable = [429, 500, 503, 504].includes(lastStatus);

        if (!retryable || attempt === MAX_ATTEMPTS) {
          break;
        }
      } else {
        const reply = extractText(data);

        if (reply) {
          console.log("Gemini response received successfully");

          return {
            reply: reply,
            model: GEMINI_MODEL
          };
        }

        lastStatus = 502;
        lastMessage =
          "No text found. Interaction status: " +
          (data.status || "unknown") +
          "; response steps: " +
          (Array.isArray(data.steps)
            ? data.steps.map(step => step.type).join(",")
            : "missing");

        console.error("Gemini response parsing error:", lastMessage);

        // Do not retry an HTTP 200 response with no text.
        break;
      }
    } catch (error) {
      lastStatus = error.name === "AbortError"
        ? 504
        : 502;

      lastMessage = error.name === "AbortError"
        ? "Gemini request timed out"
        : error.message || "Network error";

      console.error(
        "Gemini attempt " + attempt + "/" + MAX_ATTEMPTS +
        " error: " + lastMessage
      );

      if (attempt === MAX_ATTEMPTS) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = 1000 * Math.pow(2, attempt - 1);
      console.log("Retrying Gemini in " + delay + "ms");
      await wait(delay);
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
    model: GEMINI_MODEL,
    api: "Interactions"
  });
});

app.post("/chat", async (req, res) => {
  const message =
    typeof req.body?.message === "string"
      ? req.body.message.trim()
      : "";

  if (!message) {
    return res.status(400).json({
      error: "Message required",
      reply: "Please enter a message."
    });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Server configuration error",
      reply: "AI server configuration is incomplete."
    });
  }

  try {
    const result = await askGemini(message);
    return res.status(200).json(result);
  } catch (error) {
    const status = error.status || 502;

    console.error(
      "Chat request failed:",
      status,
      error.message
    );

    let reply = "Aivora AI could not get a response from Gemini.";

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
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aivora AI server running on port " + PORT);
  console.log("Gemini model configured: " + GEMINI_MODEL);
  console.log("API: Interactions");
});
      
