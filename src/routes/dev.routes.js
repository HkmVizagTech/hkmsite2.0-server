const express = require('express');
const { userModel } = require('../models/user.model');

const devRouter = express.Router();

// Only allow in non-production for safety
devRouter.post('/promote', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ message: 'Forbidden' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'email required' });
  try {
    const user = await userModel.findOne({ email });
    if (!user) return res.status(404).json({ message: 'user not found' });
    user.role = 'admin';
    await user.save();
    res.status(200).json({ message: 'promoted', user: { _id: user._id, email: user.email, role: user.role } });
  } catch (err) {
    console.error('dev.promote error', err);
    res.status(500).json({ message: 'server error' });
  }
});

module.exports = { devRouter };
