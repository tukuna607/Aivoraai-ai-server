const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Change this model only after confirming it is available
// for your API key in Google AI Studio.
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Aivora AI",
    message: "Aivora AI server is running"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok"
  });
});

app.post("/chat", async (req, res) => {
  try {
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

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      25000
    );

    let response;

    try {
      response = await fetch(
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
              parts: [
                {
                  text:
                    "You are Aivora AI, a helpful AI assistant. " +
                    "Answer accurately and clearly. " +
                    "Reply in the user's language when possible."
                }
              ]
            },
            contents: [
              {
                role: "user",
                parts: [{ text: message }]
              }
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2048
            }
          }),
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
      const upstreamMessage =
        data &&
        data.error &&
        data.error.message
          ? data.error.message
          : "Gemini request failed";

      console.error(
        "Gemini API error:",
        response.status,
        upstreamMessage
      );

      return res.status(
        response.status === 429 ? 429 :
        response.status === 503 ? 503 :
        response.status === 504 ? 504 : 502
      ).json({
        error: "Gemini API error",
        upstreamStatus: response.status,
        reply:
          response.status === 503
            ? "Gemini is temporarily unavailable. Please try again."
            : response.status === 429
            ? "Gemini quota or rate limit reached. Please try later."
            : "Aivora AI could not get a response from Gemini."
      });
    }

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
      console.error(
        "Gemini returned no text:",
        JSON.stringify(data).slice(0, 1000)
      );

      return res.status(502).json({
        error: "Empty Gemini response",
        reply: "Gemini returned no text. Please try again."
      });
    }

    return res.status(200).json({
      reply: reply,
      model: GEMINI_MODEL
    });
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Gemini request timed out");

      return res.status(504).json({
        error: "Request timeout",
        reply: "The AI response took too long. Please try again."
      });
    }

    console.error("Chat server error:", error.message);

    return res.status(500).json({
      error: "Internal server error",
      reply: "Aivora AI encountered an unexpected error."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aivora AI server running on port " + PORT);
  console.log("Gemini model configured: " + GEMINI_MODEL);
});
              
