import express from "express";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Root route
app.get("/", (req, res) => {
  res.send("🚀 Project SPARK server is running!");
});

// Example POST endpoint for receiving call file info
app.post("/new-call", (req, res) => {
  const callData = req.body;
  console.log("📞 New call data received:", callData);
  res.status(200).json({ message: "Call data received" });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
