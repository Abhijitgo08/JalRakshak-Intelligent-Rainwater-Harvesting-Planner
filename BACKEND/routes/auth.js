// routes/auth.js (ready-to-paste)
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(user) {
  const payload = { user: { id: String(user._id) } };
  const secret = process.env.JWT_SECRET || 'supersecretkey';
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ msg: 'name, email and password are required' });
    }

    const normEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normEmail }).lean();
    if (existing) return res.status(400).json({ msg: 'Email already in use' });

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    const user = new User({ name: String(name).trim(), email: normEmail, password: hashed });
    await user.save();

    const token = signToken(user);

    return res.json({
      token,
      user: { _id: String(user._id), name: user.name, email: user.email }
    });
  } catch (err) {
    console.error('Register error:', err && err.stack ? err.stack : err);
    if (err && err.code === 11000) return res.status(400).json({ msg: 'Email already in use' });
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ msg: 'email and password required' });

    const normEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normEmail });
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });

    const token = signToken(user);
    return res.json({ token, user: { _id: String(user._id), name: user.name, email: user.email } });
  } catch (err) {
    console.error('Login error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;
