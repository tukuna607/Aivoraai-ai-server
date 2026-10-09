const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Aivora AI Server is running!");
});

app.post("/chat", (req, res) => {
  const message = String(req.body.message || "").trim();

  if (!message) {
    return res.status(400).json({
      reply: "Please enter a message."
    });
  }

  const lower = message.toLowerCase();
  let reply;

  if (["hi", "hello", "hey", "namaste"].includes(lower)) {
    reply = "Hello! Main Aivora AI hoon. Aapki kya madad kar sakta hoon?";
  } else if (lower.includes("your name") || lower.includes("tumhara naam")) {
    reply = "Mera naam Aivora AI hai!";
  } else if (lower.includes("time")) {
    reply = "Main abhi live time check nahi kar sakta.";
  } else {
    reply = "Aapne kaha: " + message +
      "\nMain Aivora AI hoon. Abhi mera free basic mode chal raha hai.";
  }

  res.json({ reply });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aivora AI server started on port " + PORT);
});
