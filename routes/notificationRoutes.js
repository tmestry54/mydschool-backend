const express = require("express");
const router = express.Router();

router.post("/notifications", (req, res) => {
  res.json({ success: true, message: "notification successful!" });
});

module.exports = router;