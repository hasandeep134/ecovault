// models/WithdrawalHistory.js
// Standalone MongoDB collection for tracking each worker's individual withdrawal records.
// This replaces the embedded withdrawalHistory array in the User document with a
// dedicated, queryable collection — enabling rich filtering, pagination, and admin audit trails.

const mongoose = require('mongoose');

const withdrawalHistorySchema = new mongoose.Schema({
    workerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true   // indexed for fast per-worker lookups
    },
    amount: {
        type: Number,
        required: true,
        min: 100
    },
    method: {
        type: String,
        required: true,
        enum: ['UPI ID', 'Bank Transfer', 'Paytm Wallet', 'Google Pay', 'PhonePe'],
        default: 'UPI ID'
    },
    destination: {
        type: String,
        required: true,
        trim: true
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'rejected'],
        default: 'pending'
    },
    date: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true   // adds createdAt + updatedAt automatically
});

// Compound index: quickly fetch all withdrawals for a worker sorted by date
withdrawalHistorySchema.index({ workerId: 1, date: -1 });

module.exports = mongoose.model('WithdrawalHistory', withdrawalHistorySchema);

