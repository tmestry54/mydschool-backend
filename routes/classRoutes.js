import express from "express";
const router = express.Router();

router.post("/classes", (req, res) => {
  res.json({ success: true, message: "class successful!" });
});

export default router;
