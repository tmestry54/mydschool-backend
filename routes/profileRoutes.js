import express from "express";
const router = express.Router();

router.post("/profile", (req, res) => {
  res.json({ success: true, message: "profile successful!" });
});

export default router;
