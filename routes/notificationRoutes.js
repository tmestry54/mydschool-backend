import express from "express";
const router = express.Router();

router.post("/notifications", (req, res) => {
  res.json({ success: true, message: "notification successful!" });
});

export default router;
