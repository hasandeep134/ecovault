const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
    citizenId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    workerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    location: {
        address: { type: String, required: true },
        coordinates: { lat: Number, lng: Number }
    },
    imageUpload: { type: String }, // Path to local uploads folder
    garbageType: { 
        type: String, 
        required: true, 
        enum: ['Organic Waste', 'Plastic', 'Paper', 'Metal', 'Electronic', 'Other'] 
    },
    severity: {
        type: String,
        enum: ['Low', 'Medium', 'High'],
        default: 'Medium'
    },
    status: { type: String, enum: ['pending', 'accepted', 'completed'], default: 'pending' },
    pointsAwarded: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null }
});

module.exports = mongoose.model('Report', reportSchema);