const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
    citizenId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    referenceNo: { type: String, unique: true, required: true },
    title: { type: String, required: true, maxlength: 120 },
    category: { 
        type: String, 
        required: true,
        enum: ['Worker Misconduct', 'Missed Pickup', 'Improper Disposal', 'Damage to Property', 'Rude Behaviour', 'No Action on Report', 'Other']
    },
    against: { type: String, required: true },
    description: { type: String, required: true, maxlength: 1000 },
    status: {
        type: String,
        enum: ['open', 'in-progress', 'resolved', 'closed'],
        default: 'open'
    },
    adminNote: { type: String, default: null },
    timestamp: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null }
});

module.exports = mongoose.model('Complaint', complaintSchema);