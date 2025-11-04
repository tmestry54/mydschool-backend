import express from "express";
const router = express.Router();

router.post("/dashboard", (req, res) => {
  res.json({ success: true, message: "dashboard successful!" });
});

export default router;
