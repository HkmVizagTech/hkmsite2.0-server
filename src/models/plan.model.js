const mongoose = require('mongoose');

// Caches Razorpay Plan IDs so the same amount on the same account always
// reuses one plan instead of creating a new one per subscription.
const planSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  account: { type: String, required: true, default: 'default' },
  planId: { type: String, required: true },
}, { timestamps: true });

planSchema.index({ amount: 1, account: 1 }, { unique: true });

const planModel = mongoose.model('Plan', planSchema);
module.exports = { planModel };
