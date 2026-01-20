// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Keep the full decoded user object for reference
    req.user = decoded.user || decoded;

    // Set a stable req.userId so routes/location.js can find it
    req.userId =
      decoded.user?.id ||
      decoded.user?._id ||
      decoded.id ||
      decoded.sub ||
      null;

    if (!req.userId) {
      return res.status(401).json({ msg: 'Token missing user identifier' });
    }

    next();
  } catch (err) {
    console.error('authMiddleware error:', err.message);
    return res.status(401).json({ msg: 'Token is not valid' });
  }
};
