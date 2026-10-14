
const D = require("../data.js");

module.exports = async function handler(req, res) {
  // Ask Pluma sends questions using POST.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  // The API key stays on the server, not in the browser.
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "The site's AI is not configured yet."
    });
  }

  try {
    // Read the question sent by script.js.
    const body = req.body || {};
    const question =
      typeof body.question === "string"
        ? body.question.trim().replace(/\s+/g, " ").slice(0, 400)
        : "";

    if (!question) {
      return res.status(400).json({
        error: "Please enter a question."
      });
    }

    // Keep only valid, recent conversation messages.
    const history = Array.isArray(body.history)
      ? body.history
          .filter(
            (item) =>
              item &&
              (item.role === "user" || item.role === "assistant") &&
              typeof item.content === "string"
          )
          .slice(-6)
          .map((item) => ({
            role: item.role,
            content: item.content.slice(0, 2000)
          }))
      : [];

    const chapter =
      typeof body.chapter === "string"
        ? body.chapter.slice(0, 100)
        : null;

    // Retrieve verified facts from your existing data.js.
    const facts = D.factsForPrompt(question, chapter);

    // Build the Gemini request using your existing Rizal-only prompt.
    const requestBody =
      D.buildGeminiRequest(question, history, facts);

   const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

    const apiBase = (
      process.env.GEMINI_API_BASE ||
      "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");

    // Send the request from the server, keeping the key private.
    const response = await fetch(
      `${apiBase}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(requestBody)
      }
    );

    const geminiData = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "Gemini API error:",
        response.status,
        geminiData.error?.message || "No error details"
      );

      if (response.status === 429) {
        return res.status(429).json({
          error: "The AI request limit was reached. Please try again later."
        });
      }

      return res.status(502).json({
        error: "The AI service could not complete the request. Please try again later."
      });
    }

    // Extract the text returned by Gemini.
    const reply = D.geminiText(geminiData);

    if (!reply.text) {
      console.error("Gemini returned no answer:", reply.reason);

      return res.status(502).json({
        error: "The AI returned no answer. Please try again."
      });
    }

    // Only allow citations that refer to facts retrieved for this question.
    const validIds = new Set(facts.map((fact) => fact.id));
    const answer = D.parseAnswer(reply.text, validIds);

    // This is the format expected by your existing script.js.
    return res.status(200).json(answer);

  } catch (error) {
    console.error("Ask Pluma server error:", error);

    return res.status(500).json({
      error: "Something went wrong while answering. Please try again."
    });
  }
};
