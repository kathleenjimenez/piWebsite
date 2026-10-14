
module.exports = function handler(req, res) {
  // This endpoint is only for checking the AI connection.
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  const model =
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash";

  return res.status(200).json({
    ok: true,
    ai: Boolean(apiKey),
    model: model
  });
};
