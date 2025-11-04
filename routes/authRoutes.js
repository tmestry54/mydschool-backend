const express = require("express");
const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "admin" && password === "admin@123") {
    res.json({
      success: true,
      message: "Login successful",
      user: { username: "admin", role: "admin" },
      token: "mock-token-123",
    });
  } else {
    res.status(401).json({
      success: false,
      message: "Invalid credentials",
    });
  }
});

module.exports = router;
