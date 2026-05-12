const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['citizen', 'worker', 'admin'], required: true },
    isAdmin: { type: Number, default: 0 }, // 0 for citizens/workers, 1 for admin
    isBlocked: { type: Boolean, default: false }, // Block/unblock users
    profilePicture: { type: String, default: null },  // base64 data URL
    
    // Citizen specific
    greenPoints: { type: Number, default: 0 },
    
    // Worker specific
    workerID: { type: String, default: "" },
    totalEarnings: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    isBusy: { type: Boolean, default: false } // <-- Added shift status here
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);