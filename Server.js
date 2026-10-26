const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send("Aivora AI Gemini Server is running!");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ai: "Gemini",
    configured: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post("/chat", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();

    if (!message) {
      return res.status(400).json({
        reply: "Please enter a message."
      });
    }

    if (message.length > 10000) {
      return res.status(400).json({
        reply: "Message bahut lamba hai. Chhota message bhejein."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing");

      return res.status(500).json({
        reply: "AI setup pending hai. Please try again later."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "You are Aivora AI, a helpful and friendly AI assistant. Answer clearly and accurately. Reply in the language used by the user, including Hindi or Hinglish when appropriate."
            }]
          },
          contents: [{
            role: "user",
            parts: [{ text: message }]
          }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Gemini API error:",
        response.status,
        JSON.stringify(data.error || {})
      );

      if (response.status === 429) {
        return res.status(429).json({
          reply: "AI ki request limit abhi poori hai. Thodi der baad try karein."
        });
      }

      return res.status(502).json({
        reply: "Gemini AI se response nahi mila. Please dobara try karein."
      });
    }

    const reply = (data.candidates || [])
      .flatMap(candidate =>
        (candidate.content?.parts || [])
          .map(part => part.text || "")
      )
      .join("")
      .trim();

    if (!reply) {
      return res.status(502).json({
        reply: "AI abhi jawab nahi de paaya. Dobara try karein."
      });
    }

    return res.json({ reply });

  } catch (error) {
    console.error("Chat server error:", error.message);

    return res.status(500).json({
      reply: "Server mein problem hui. Please dobara try karein."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aivora AI server started on port " + PORT);
});
