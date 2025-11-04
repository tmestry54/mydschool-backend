const express = require("express");
const router = express.Router();

router.post("/profile", (req, res) => {
  res.json({ success: true, message: "profile successful!" });
});

module.exports = router;