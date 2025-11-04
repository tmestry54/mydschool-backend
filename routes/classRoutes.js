const express = require("express");
const router = express.Router();

router.post("/classes", (req, res) => {
  res.json({ success: true, message: "class successful!" });
});

module.exports = router;