const mongoose = require('mongoose');

const redemptionHistorySchema = new mongoose.Schema({
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    key:      { type: String, required: true },       // coupon key e.g. 'swiggy'
    brand:    { type: String, required: true },
    ico:      { type: String, default: '🎁' },
    offer:    { type: String, required: true },
    code:     { type: String, required: true },
    pts:      { type: Number, required: true },
    redeemedAt: { type: Date, default: Date.now }
}, { timestamps: false });

module.exports = mongoose.model('RedemptionHistory', redemptionHistorySchema);

// hello