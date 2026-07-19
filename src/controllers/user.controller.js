
const { userModel } = require("../models/user.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../utils/utils");

const userController = {
    getUser: async (req, res) => {
        try {
            const users = await userModel.find({}, "-password");
            res.status(200).json({ users });
        } catch (err) {
            console.error('user.register error', err);
            res.status(500).json({ message: "Server error" });
        }
    },


    register: async (req, res) => {
        try {
            const { name, email, password, role } = req.body;
            if (
                typeof name !== "string" || typeof email !== "string" || typeof password !== "string" ||
                !name || !email || !password
            ) {
                return res.status(400).json({ message: "All fields are required" });
            }
            if (password.length < 8) {
                return res.status(400).json({ message: "Password must be at least 8 characters" });
            }
            // Only "user" (default/no admin access), "donations_admin" (scoped
            // to /donations/admin only), or "blogs_admin" (scoped to writing/
            // editing blog posts, with deletion requiring admin approval) can
            // be granted here — deliberately never "admin", so creating
            // another full admin always stays a separate, more deliberate
            // action rather than a dropdown on this form.
            const allowedRoles = ["user", "donations_admin", "blogs_admin"];
            const resolvedRole = allowedRoles.includes(role) ? role : "user";
            const existing = await userModel.findOne({ email });
            if (existing) {
                return res.status(409).json({ message: "Email already registered" });
            }
            const hash = await bcrypt.hash(password, 10);
            const user = await userModel.create({ name, email, password: hash, role: resolvedRole });
            res.status(201).json({ message: "User registered successfully", user: { _id: user._id, name: user.name, email: user.email, role: user.role } });
        } catch (err) {
            console.error('user.login error', err);
            res.status(500).json({ message: "Server error" });
        }
    },

   
    login: async (req, res) => {
        try {
            const { email, password } = req.body;
            // Reject non-string email/password outright — without this, a
            // crafted payload like {"email": {"$ne": null}} would be passed
            // straight into the Mongo query as an operator, not a value.
            if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
                return res.status(400).json({ message: "Email and password required" });
            }
            const user = await userModel.findOne({ email });
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
                // Allow cross-site requests to include the cookie in production (requires HTTPS)
                sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
                maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
            });
            // Also return the token so clients can use Authorization header if needed
            res.status(200).json({ user: { _id: user._id, name: user.name, email: user.email, role: user.role }, token });
        } catch (err) {
            console.error('user.profile error', err);
            res.status(500).json({ message: "Server error" });
        }
    },

    logout: (req, res) => {
        res.clearCookie("token");
        res.status(200).json({ message: "Logged out" });
    },

    profile: async (req, res) => {
        try {
            const user = await userModel.findById(req.user.userId, "-password");
            if (!user) return res.status(404).json({ message: "User not found" });
            res.status(200).json({ user });
        } catch (err) {
            console.error('user.update error', err);
            res.status(500).json({ message: "Server error" });
        }
    },

    update: async (req, res) => {
        try {
            const { name, email, currentPassword, newPassword, preferences } = req.body;
            const user = await userModel.findById(req.user.userId);
            if (!user) return res.status(404).json({ message: "User not found" });

            const updateData = {};
            if (name) updateData.name = name;
            if (email && typeof email === "string" && email !== user.email) {
                const existing = await userModel.findOne({ email, _id: { $ne: user._id } });
                if (existing) return res.status(400).json({ message: "Email already in use" });
                updateData.email = email;
            }
            if (preferences && typeof preferences === "object") {
                updateData.preferences = { ...(user.preferences?.toObject?.() || user.preferences || {}), ...preferences };
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

            const updated = await userModel.findByIdAndUpdate(req.user.userId, updateData, { new: true, select: "-password" });
            res.status(200).json({ message: "Profile updated", user: updated });
        } catch (err) {
            console.error('user.update error', err);
            res.status(500).json({ message: "Server error" });
        }
    },

    delete: async (req, res) => {
        try {
            const { id } = req.params;
            await userModel.findByIdAndDelete(id);
            res.status(200).json({ message: "User deleted" });
        } catch (err) {
            res.status(500).json({ message: "Server error" });
        }
    }
};


module.exports = {userController};