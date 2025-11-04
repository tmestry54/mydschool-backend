const express = require("express");
const router = express.Router();

router.post("/sections", (req, res) => {
  res.json({ success: true, message: "sections successful!" });
});

module.exports = router;