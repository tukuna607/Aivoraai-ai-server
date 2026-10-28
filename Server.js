
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 25000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function askGemini(message) {
  let lastStatus = 0;
  let lastMessage = "Gemini request failed";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(GEMINI_MODEL) +
          ":generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{
                text:
                  "You are Aivora AI, a helpful AI assistant. " +
                  "Answer accurately and clearly. " +
                  "Reply in the user's language when possible."
              }]
            },
            contents: [{
              role: "user",
              parts: [{ text: message }]
            }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2048
            }
          }),
          signal: controller.signal
        }
      );

      const data = await response.json();

      if (response.ok) {
        const reply =
          data &&
          data.candidates &&
          data.candidates[0] &&
          data.candidates[0].content &&
          data.candidates[0].content.parts
            ? data.candidates[0].content.parts
                .map(part => part.text || "")
                .join("")
                .trim()
            : "";

        if (!reply) {
          const blockReason =
            data &&
            data.candidates &&
            data.candidates[0] &&
            data.candidates[0].finishReason;

          const error = new Error(
            blockReason
              ? "Gemini returned no text: " + blockReason
              : "Gemini returned an empty response"
          );
          error.status = 502;
          throw error;
        }

        return {
          reply: reply,
          model: GEMINI_MODEL
        };
      }

      lastStatus = response.status;
      lastMessage =
        data && data.error && data.error.message
          ? data.error.message
          : "Gemini request failed";

      console.error(
        "Gemini attempt " + attempt + "/" + MAX_ATTEMPTS +
        " failed:",
        lastStatus,
        lastMessage
      );

      const retryable = [429, 500, 503, 504].includes(lastStatus);

      if (!retryable || attempt === MAX_ATTEMPTS) {
        break;
      }
    } catch (error) {
      if (error.status === 502) {
        throw error;
      }

      lastMessage =
        error.name === "AbortError"
          ? "Gemini request timed out"
          : error.message || "Network error";

      lastStatus = error.status || 0;

      console.error(
        "Gemini attempt " + attempt + "/" + MAX_ATTEMPTS +
        " error:",
        lastMessage
      );

      if (attempt === MAX_ATTEMPTS) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }

    const delay = 1000 * Math.pow(2, attempt - 1);
    console.log("Retrying Gemini in " + delay + "ms");
    await wait(delay);
  }

  const error = new Error(lastMessage);
  error.status = lastStatus || 502;
  throw error;
}

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Aivora AI",
    message: "Aivora AI server is running"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    ai: "Gemini",
    configured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL
  });
});

app.post("/chat", async (req, res) => {
  const message =
    typeof req.body.message === "string"
      ? req.body.message.trim()
      : "";

  if (!message) {
    return res.status(400).json({
      error: "Message required",
      reply: "Please enter a message."
    });
  }

  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing");

    return res.status(500).json({
      error: "Server configuration error",
      reply: "AI server configuration is incomplete."
    });
  }

  try {
    const result = await askGemini(message);

    return res.status(200).json(result);
  } catch (error) {
    console.error(
      "Chat request failed:",
      error.status || 500,
      error.message
    );

    const status = error.status || 502;

    if (status === 429) {
      return res.status(429).json({
        error: "Gemini rate limit",
        upstreamStatus: 429,
        reply: "Gemini is busy or its quota is limited. Please try later."
      });
    }

    if (status === 503 || status === 500 || status === 504) {
      return res.status(status).json({
        error: "Gemini temporarily unavailable",
        upstreamStatus: status,
        reply: "Gemini is temporarily unavailable. Please try again later."
      });
    }

    return res.status(502).json({
      error: "Gemini request failed",
      upstreamStatus: status,
      reply: "Aivora AI could not get a response from Gemini."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aivora AI server running on port " + PORT);
  console.log("Gemini model configured: " + GEMINI_MODEL);
  console.log("Automatic retry enabled: " + MAX_ATTEMPTS + " attempts");
});
    
