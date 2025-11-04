import express from "express";
const router = express.Router();

router.post("/Assignments", (req, res) => {
  res.json({ success: true, message: "assignment!" });
});

export default router;
