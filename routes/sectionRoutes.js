import express from "express";
const router = express.Router();

router.post("/sections", (req, res) => {
  res.json({ success: true, message: "sections successful!" });
});

export default router;
