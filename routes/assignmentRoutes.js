const express = require("express");
const router = express.Router();

router.post("/Assignments", (req, res) => {
  res.json({ success: true, message: "assignment!" });
});
module.exports = router;