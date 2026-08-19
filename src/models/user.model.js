
const mongoose = require("mongoose");


const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["user", "donations_admin", "blogs_admin", "admin"], default: "user" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    // Set true whenever an admin creates an account on someone's behalf
    // (register / register-admin) — they're logging in with a password
    // an admin chose, not one they picked themselves, so they're forced
    // to set their own on first login. Cleared once they do.
    mustChangePassword: { type: Boolean, default: false },
    preferences: {
        newDonation: { type: Boolean, default: true },
        newDevotee: { type: Boolean, default: true },
        eventReminders: { type: Boolean, default: true },
        weeklyReport: { type: Boolean, default: false },
    },
}, {
    timestamps: true,
    versionKey: false
});


const userModel = mongoose.model("user", userSchema);

module.exports = { userModel}