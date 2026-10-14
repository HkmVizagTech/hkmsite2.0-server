import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};

const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET environment variable is not set. Refusing to sign/verify tokens with a default secret."
    );
  }
  return secret;
};

const generateToken = (payload) => {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "7d" });
};

export { hashPassword, comparePassword, generateToken, getJwtSecret };
