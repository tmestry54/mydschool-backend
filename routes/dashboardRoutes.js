const express = require("express");
const router = express.Router();

router.post("/dashboard", (req, res) => {
  res.json({ success: true, message: "dashboard successful!" });
});

module.exports = router;