export const loginUser = async (req, res) => {
  const { username, password } = req.body;

  // Temporary static login
  if (username === "admin" && password === "admin@123") {
    return res.json({
      success: true,
      message: "Login successful",
      token: "dummy-token-123",
    });
  }

  res.status(401).json({
    success: false,
    message: "Invalid credentials",
  });
};

export const registerUser = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res
      .status(400)
      .json({ success: false, message: "Missing username or password" });

  // Simulate successful registration
  res.json({ success: true, message: "User registered successfully!" });
};
