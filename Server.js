
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

async function askGemini(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

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

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(
        data?.error?.message || "Gemini request failed"
      );
      error.status = response.status;
      throw error;
    }

    let reply = data.output_text || "";

    if (!reply && Array.isArray(data.output)) {
      reply = data.output
        .filter(item => item.type === "model_output")
        .flatMap(item => item.content || [])
        .filter(item => item.type === "text")
        .map(item => item.text || "")
        .join("\n")
        .trim();
    }

    if (!reply) {
      throw new Error("Gemini returned no text");
    }

    return {
      reply,
      model: GEMINI_MODEL
    };
  } finally {
    clearTimeout(timeout);
  }
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
      "Gemini API error:",
      status,
      error.message
    );

    return res.status(status >= 400 && status <= 599 ? status : 502).json({
      error: "Gemini request failed",
      upstreamStatus: status,
      reply:
        status === 429
          ? "Gemini quota limit reached. Please try again later."
          : status === 503
          ? "Gemini is temporarily busy. Please try again."
          : "Aivora AI could not get a response from Gemini."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aivora AI server running on port " + PORT);
  console.log("Gemini model configured: " + GEMINI_MODEL);
  console.log("API: Interactions");
});
      
    
