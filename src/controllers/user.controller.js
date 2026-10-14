import { users } from "../db/tables.js";
import { publicUser, toBool } from "../domain/validate.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../utils/utils.js";

const userController = {
  getUser: async (req, res) => {
    try {
      const list = (await users.find({}, { sort: { _id: 1 } })).map(publicUser);
      res.status(200).json({ users: list });
    } catch (err) {
      console.error("user.register error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  register: async (req, res) => {
    try {
      const { name, email, password, role, allowedModules } = req.body;
      if (
        typeof name !== "string" ||
        typeof email !== "string" ||
        typeof password !== "string" ||
        !name ||
        !email ||
        !password
      ) {
        return res.status(400).json({ message: "All fields are required" });
      }
      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      const allowedRoles = ["user", "donations_admin", "blogs_admin", "shop_admin", "preacher"];
      const resolvedRole = allowedRoles.includes(role) ? role : "user";

      const VALID_PREACHER_MODULES = ["raise-receipt", "my-donors", "resend", "my-reports", "donor-assignment"];
      const resolvedModules =
        resolvedRole === "preacher" && Array.isArray(allowedModules)
          ? allowedModules.filter((m) => VALID_PREACHER_MODULES.includes(m))
          : [];

      const existing = await users.findOne({ email });
      if (existing) {
        return res.status(409).json({ message: "Email already registered" });
      }
      const hash = await bcrypt.hash(password, 10);
      const user = await users.insert({
        name,
        email,
        password: hash,
        role: resolvedRole,
        mustChangePassword: true,
        allowedModules: resolvedModules,
      });
      res.status(201).json({
        message: "User registered successfully",
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          allowedModules: user.allowedModules,
        },
      });
    } catch (err) {
      console.error("user.login error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  registerAdmin: async (req, res) => {
    try {
      const { name, email, password, confirm } = req.body;
      if (
        typeof name !== "string" ||
        typeof email !== "string" ||
        typeof password !== "string" ||
        !name ||
        !email ||
        !password
      ) {
        return res.status(400).json({ message: "All fields are required" });
      }
      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      if (confirm !== "CREATE ADMIN") {
        return res.status(400).json({ message: "Confirmation text did not match. Please type CREATE ADMIN exactly." });
      }
      const existing = await users.findOne({ email });
      if (existing) {
        return res.status(409).json({ message: "Email already registered" });
      }
      const hash = await bcrypt.hash(password, 10);
      const user = await users.insert({ name, email, password: hash, role: "admin", mustChangePassword: true });
      console.log(`[SECURITY] New full admin created: ${user.email} (${user._id}) by ${req.user?.userId || "unknown"}`);
      res.status(201).json({
        message: "Admin account created successfully",
        user: { _id: user._id, name: user.name, email: user.email, role: user.role },
      });
    } catch (err) {
      console.error("user.registerAdmin error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  login: async (req, res) => {
    try {
      const { email, password } = req.body;
      if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
        return res.status(400).json({ message: "Email and password required" });
      }
      const user = await users.findOne({ email });
      if (!user) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      const token = jwt.sign({ userId: user._id, role: user.role }, getJwtSecret(), { expiresIn: "7d" });
      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });
      res.status(200).json({
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          mustChangePassword: !!user.mustChangePassword,
          allowedModules: user.allowedModules || [],
        },
        token,
      });
    } catch (err) {
      console.error("user.profile error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  logout: (req, res) => {
    res.clearCookie("token");
    res.status(200).json({ message: "Logged out" });
  },

  changePassword: async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current and new password are required." });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "New password must be at least 8 characters." });
      }
      const user = await users.findById(req.user.userId);
      if (!user) return res.status(404).json({ message: "User not found." });

      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match) return res.status(401).json({ message: "Current password is incorrect." });

      await users.updateById(user._id, { password: await bcrypt.hash(newPassword, 10), mustChangePassword: false });

      res.status(200).json({ message: "Password updated successfully." });
    } catch (err) {
      console.error("user.changePassword error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  profile: async (req, res) => {
    try {
      const user = await users.findById(req.user.userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      res.status(200).json({ user: publicUser(user) });
    } catch (err) {
      console.error("user.update error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  update: async (req, res) => {
    try {
      const { name, email, currentPassword, newPassword, preferences } = req.body;
      const user = await users.findById(req.user.userId);
      if (!user) return res.status(404).json({ message: "User not found" });

      const updateData = {};
      if (name) updateData.name = name;
      if (email && typeof email === "string" && email !== user.email) {
        const existing = await users.findOne({ email, _id: { $ne: user._id } });
        if (existing) return res.status(400).json({ message: "Email already in use" });
        updateData.email = email;
      }
      if (preferences && typeof preferences === "object") {
        const next = { ...(user.preferences || {}) };
        for (const key of ["newDonation", "newDevotee", "eventReminders", "weeklyReport"]) {
          if (preferences[key] !== undefined) next[key] = toBool(preferences[key]);
        }
        updateData.preferences = next;
      }

      if (newPassword) {
        if (!currentPassword) {
          return res.status(400).json({ message: "Current password is required to set a new password" });
        }
        const matches = await bcrypt.compare(currentPassword, user.password);
        if (!matches) {
          return res.status(400).json({ message: "Current password is incorrect" });
        }
        if (String(newPassword).length < 8) {
          return res.status(400).json({ message: "New password must be at least 8 characters" });
        }
        updateData.password = await bcrypt.hash(newPassword, 10);
      }

      const updated = await users.updateById(req.user.userId, updateData);
      res.status(200).json({ message: "Profile updated", user: publicUser(updated) });
    } catch (err) {
      console.error("user.update error", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  delete: async (req, res) => {
    try {
      const { id } = req.params;
      await users.deleteById(id);
      res.status(200).json({ message: "User deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { userController };
