const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
require('dotenv').config();
const path = require('path');
const fs = require("fs");
const Report = require('./models/Report');
const User = require('./models/User');
const Complaint = require('./models/Complaint');
const WithdrawalHistory = require('./models/WithdrawalHistory');
const RedemptionHistory = require('./models/RedemptionHistory');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('📁 Created uploads directory');
}

async function verifyWasteWithAI(filePath) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }); 
        
        const imageData = {
            inlineData: {
                data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
                mimeType: "image/jpeg", 
            },
        };

        const prompt = `You are a strict environmental inspector. 
                        Analyze this image for urban waste, litter, or overflowing garbage. 
                        Ignore shadows, normal pavement textures, or people. 
                        If there is clearly visible garbage, respond with "YES". 
                        If the area is clean or the image is unrelated or there is very minimal amount of waste
                        like a piece of paper or a small leaf or where no significant waste is present, respond with "NO". 
                        Answer with only one word: YES or NO.`;
        const result = await model.generateContent([prompt, imageData]);
        const response = await result.response;
        const text = response.text().trim().toUpperCase();

        console.log("AI Scan Result:", text);
        return text.includes("YES");
    } catch (error) {
        console.error("AI Scan Error:", error);
        return false; 
    }
}



const app = express();



app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/welcome_page-dynamic.html'));
});

// Increase body parser limit to handle large base64 images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configure CORS - allow requests from frontend
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Configure how images are saved
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, 'waste-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });
// Make the uploads folder public so you can see images in the dash
app.use('/uploads', express.static('uploads'));

// ⚠️ IMPORTANT: Define ALL API routes BEFORE serving static frontend files

// MongoDB Connection
const localMongoUri = process.env.MONGO_LOCAL_URI || 'mongodb://127.0.0.1:27017/ecoVault';
const mongoMode = (process.env.MONGO_CONNECTION_MODE || 'local-only').toLowerCase();

function buildMongoCandidates() {
    const remoteCandidates = [
        { label: 'MONGO_URI', uri: process.env.MONGO_URI },
        { label: 'MONGO_DIRECT_URI', uri: process.env.MONGO_DIRECT_URI }
    ].filter(candidate => Boolean(candidate.uri));

    const localCandidate = { label: 'MONGO_LOCAL_URI', uri: localMongoUri };

    if (mongoMode === 'remote-only') return remoteCandidates;
    if (mongoMode === 'remote-first') return [...remoteCandidates, localCandidate];
    if (mongoMode === 'local-first') return [localCandidate, ...remoteCandidates];
    return [localCandidate];
}

const mongoCandidates = buildMongoCandidates();

// FIX: Check for actual DNS/SRV error types (not ECONNREFUSED which is a TCP error)
function isSrvDnsError(error) {
    if (!error) return false;
    const msg = error.message || '';
    return (
        error.code === 'ENOTFOUND' ||
        error.code === 'ETIMEOUT' ||
        msg.includes('querySrv') ||
        msg.includes('DNS') ||
        (error.syscall === 'querySrv')
    );
}

async function connectToMongo() {
    let lastError = null;

    if (mongoCandidates.length === 0) {
        throw new Error('No MongoDB connection URI is configured.');
    }

    for (const { label, uri } of mongoCandidates) {
        try {
            await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
            console.log(`✅ Connected to MongoDB using ${label}`);
            return;
        } catch (error) {
            lastError = error;
            if (isSrvDnsError(error) && label === 'MONGO_URI') {
                console.error('❌ SRV DNS lookup failed for MONGO_URI. This network may block DNS SRV queries.');
                console.error('ℹ️ Add MONGO_DIRECT_URI in .env using the non-SRV Atlas connection string (mongodb://...).');
            } else {
                console.error(`❌ MongoDB connection failed for ${label}:`, error.message);
            }
        }
    }

    throw lastError;
}

connectToMongo().then(async () => {
    // Auto-migrate existing users
    try {
        const usersNeedingBlocked = await User.find({ isBlocked: { $exists: false } });
        if (usersNeedingBlocked.length > 0) {
            await User.updateMany(
                { isBlocked: { $exists: false } },
                { $set: { isBlocked: false } }
            );
            console.log(`🔄 Migrated ${usersNeedingBlocked.length} users: added isBlocked field`);
        }

        const usersNeedingTimestamp = await User.find({ createdAt: { $exists: false } });
        if (usersNeedingTimestamp.length > 0) {
            await User.updateMany(
                { createdAt: { $exists: false } },
                { $set: { createdAt: new Date(), updatedAt: new Date() } }
            );
            console.log(`🕒 Migrated ${usersNeedingTimestamp.length} users: added missing creation timestamps`);
        }

        // Ensure withdrawalHistory field exists on all workers
        await User.updateMany(
            { role: 'worker', withdrawalHistory: { $exists: false } },
            { $set: { withdrawalHistory: [] } }
        );

        // ── NEW: Migrate embedded withdrawalHistory → WithdrawalHistory collection ──
        // This is idempotent: only migrates workers whose embedded history hasn't been
        // synced yet (tracked via a `historySynced` flag on the User document).
        try {
            const workersToSync = await User.find({
                role: 'worker',
                historySynced: { $ne: true },
                'withdrawalHistory.0': { $exists: true }  // has at least one entry
            });

            let migratedCount = 0;
            for (const worker of workersToSync) {
                const docs = (worker.withdrawalHistory || []).map(h => ({
                    workerId: worker._id,
                    amount:      h.amount      || 0,
                    method:      h.method      || 'UPI ID',
                    destination: h.destination || '—',
                    status:      h.status      || 'pending',
                    date:        h.date        || new Date()
                }));

                if (docs.length > 0) {
                    await WithdrawalHistory.insertMany(docs, { ordered: false });
                    migratedCount += docs.length;
                }

                // Mark this worker as synced so we don't double-import
                await User.updateOne({ _id: worker._id }, { $set: { historySynced: true } });
            }

            if (migratedCount > 0) {
                console.log(`📦 Migrated ${migratedCount} withdrawal records → WithdrawalHistory collection`);
            }
        } catch (syncErr) {
            // Non-fatal: existing embedded data still works as fallback
            console.error('⚠️  WithdrawalHistory sync warning:', syncErr.message);
        }
    } catch (err) {
        console.error('❌ Migration failed:', err);
    }

    // Auto-create Admin User if it doesn't exist
    try {
        const adminExists = await User.findOne({ email: 'admin@gmail.com' });
        if (!adminExists) {
            const hashedAdminPassword = await bcrypt.hash('admin123', 10);
            const adminUser = new User({
                fullName: 'System Administrator',
                email: 'admin@gmail.com',
                password: hashedAdminPassword,
                role: 'admin',
                isAdmin: 1
            });
            await adminUser.save();
            console.log('👑 Admin account created: admin@gmail.com');
        }
    } catch (err) {
        console.error('❌ Failed to create admin user:', err);
    }
}).catch(err => {
    console.error('❌ Connection Error:', err);
    process.exit(1);
});

// ══════════════════════════════════════════════════════════════
// ── AUTH ROUTES ──
// ══════════════════════════════════════════════════════════════

// Signup Route
// FIX: Return userId, fullName, and role so the frontend can store them and redirect correctly
app.post('/api/signup', async (req, res) => {
    try {
        const { fullName, email, password, role } = req.body;

        if (!fullName || !email || !password || !role) {
            return res.status(400).json({ success: false, message: 'Missing required fields.' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Auto-generate sequential WorkerID for workers
        let assignedWorkerID = '';
        if (role === 'worker') {
            const lastWorker = await User.findOne({ role: 'worker', workerID: { $ne: '' } })
                .sort({ workerID: -1 })
                .select('workerID');
            let nextNum = 1;
            if (lastWorker && lastWorker.workerID) {
                const parsed = parseInt(lastWorker.workerID, 10);
                if (!isNaN(parsed)) nextNum = parsed + 1;
            }
            assignedWorkerID = String(nextNum).padStart(3, '0');
        }

        const newUser = new User({
            fullName, email, password: hashedPassword, role,
            workerID: assignedWorkerID
        });

        await newUser.save();

        // FIX: Return all fields the frontend needs
        res.status(201).json({
            success: true,
            userId: newUser._id,
            fullName: newUser.fullName,
            role: newUser.role
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

// Login Route
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.isBlocked) {
            return res.status(403).json({ success: false, message: "Your account has been blocked by administrators." });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Invalid credentials" });
        }
        
        res.json({ 
            success: true, 
            userId: user._id,
            role: user.role, 
            fullName: user.fullName,
            isAdmin: user.isAdmin || 0
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ══════════════════════════════════════════════════════════════
// ── REPORT ROUTES ──
// ══════════════════════════════════════════════════════════════

app.post('/api/reports', upload.single('imageUpload'), async (req, res) => {
    try {
        const { citizenId, address, garbageType, lat, lng, severity } = req.body;
        // Normalise to 3-tier: map Critical → High, default to Medium
        const normSev = (s) => { if (!s) return 'Medium'; const t = s.trim(); if (t === 'Critical') return 'High'; if (['Low','Medium','High'].includes(t)) return t; return 'Medium'; };
        const reportSeverity = normSev(severity);
        const imagePath = req.file ? req.file.path : null;

        if (!imagePath) {
            return res.status(400).json({ success: false, message: "No image uploaded." });
        }

        console.log("🔍 Starting AI Scan for:", imagePath);
        const isWaste = await verifyWasteWithAI(imagePath);
        console.log("🤖 AI Result:", isWaste ? "WASTE DETECTED ✅" : "NO WASTE FOUND ❌");

        if (!isWaste) {
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
            return res.status(400).json({ 
                success: false, 
                message: "AI Verification Failed: No waste or garbage detected in this image. Please upload a clear photo of the waste." 
            });
        }

        const newReport = new Report({
            citizenId,
            location: {
                address,
                coordinates: { lat: parseFloat(lat), lng: parseFloat(lng) }
            },
            garbageType,
            severity: reportSeverity,
            imageUpload: imagePath,
            pointsAwarded: 50
        });

        await newReport.save();

        await User.findByIdAndUpdate(citizenId, {
            $inc: { greenPoints: 50 }
        });
        
        res.status(201).json({ 
            success: true, 
            message: "AI Verified! Report submitted successfully." 
        });

    } catch (error) {
        console.error("Submission Error:", error);
        res.status(500).json({ success: false, message: "Server error during submission" });
    }
});

app.get('/api/tasks/available', async (req, res) => {
    try {
        const tasks = await Report.find({ status: 'pending' });
        res.status(200).json({ success: true, tasks });
    } catch (error) {
        console.error("Worker Fetch Error:", error);
        res.status(500).json({ success: false, message: "Error fetching tasks" });
    }
});

// FIX: Added citizenId validation to prevent Mongoose CastError
app.get('/api/reports/active/:citizenId', async (req, res) => {
    try {
        const { citizenId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(citizenId)) {
            return res.status(400).json({ success: false, message: "Invalid citizen ID" });
        }

        // Return ALL reports (including completed) so citizen can track full history
        const activeReports = await Report.find({ citizenId })
            .sort({ timestamp: -1 })
            .limit(20);

        res.json({ success: true, reports: activeReports });
    } catch (error) {
        console.error("Active reports fetch error:", error);
        res.status(500).json({ success: false, message: "Error fetching reports" });
    }
});

// GET /api/reports/track/:reportId — full tracking detail for a single report
app.get('/api/reports/track/:reportId', async (req, res) => {
    try {
        const { reportId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(reportId)) {
            return res.status(400).json({ success: false, message: "Invalid report ID" });
        }

        const report = await Report.findById(reportId);
        if (!report) {
            return res.status(404).json({ success: false, message: "Report not found" });
        }

        // Fetch assigned worker info if available
        let workerInfo = null;
        if (report.workerId) {
            const worker = await User.findById(report.workerId)
                .select('fullName workerID');
            if (worker) {
                workerInfo = {
                    fullName:   worker.fullName,
                    workerID:   worker.workerID
                };
            }
        }

        res.json({
            success: true,
            report: {
                _id:          report._id,
                status:       report.status,
                garbageType:  report.garbageType,
                severity:     report.severity || 'Medium',
                address:      report.location.address,
                coordinates:  report.location.coordinates,
                timestamp:    report.timestamp,
                completedAt:  report.completedAt,
                pointsAwarded:report.pointsAwarded,
                worker:       workerInfo
            }
        });
    } catch (error) {
        console.error("Report tracking error:", error);
        res.status(500).json({ success: false, message: "Error fetching report tracking data" });
    }
});

// ══════════════════════════════════════════════════════════════
// ── USER PROFILE ROUTES ──
// FIX: These MUST come BEFORE /api/user/:id to prevent
//      "profile-picture" being matched as the :id parameter
// ══════════════════════════════════════════════════════════════

// GET /api/user/profile-picture/:userId
app.get('/api/user/profile-picture/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.json({ success: false, message: "User not found", profilePicture: null });
        }
        if (!user.profilePicture) {
            return res.json({ success: false, message: "No profile picture found", profilePicture: null });
        }
        res.json({ success: true, profilePicture: user.profilePicture });
    } catch (err) {
        console.error("Profile picture fetch error:", err);
        res.json({ success: false, error: err.message, profilePicture: null });
    }
});

// POST /api/user/profile-picture
app.post('/api/user/profile-picture', async (req, res) => {
    try {
        const { userId, profilePicture } = req.body;
        
        if (!userId || !profilePicture) {
            return res.status(400).json({ success: false, message: "Missing userId or profilePicture" });
        }
        
        const updatedUser = await User.findByIdAndUpdate(userId, { profilePicture }, { returnDocument: 'after' });
        
        if (!updatedUser) {
            return res.json({ success: false, message: "User not found" });
        }
        
        res.json({ success: true, message: "Profile picture updated successfully" });
    } catch (err) {
        console.error("Profile picture save error:", err);
        res.json({ success: false, message: "Error saving profile picture", error: err.message });
    }
});

// GET /api/user/:id — must come AFTER the more specific /api/user/profile-picture route
app.get('/api/user/:id', async (req, res) => {
    try {
        const userId = req.params.id;

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: "Invalid user ID" });
        }

        const user = await User.findById(userId);
        
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const totalRequests = await Report.countDocuments({ citizenId: userId });
        const areasCleaned = await Report.countDocuments({ citizenId: userId, status: 'completed' });
        const pendingRequests = await Report.countDocuments({ citizenId: userId, status: { $in: ['pending', 'accepted'] } });

        res.json({ 
            success: true, 
            points: user.greenPoints,
            totalRequests,
            areasCleaned,
            pendingRequests,
            profilePicture: user.profilePicture || null
        });
    } catch (err) {
        console.error("User fetch error:", err);
        res.status(500).json({ success: false, message: "Error fetching user" });
    }
});

// DEBUG endpoint
app.get('/api/debug/user/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.json({ success: false, message: "User not found", userId: req.params.userId });
        }
        res.json({
            success: true,
            userId: req.params.userId,
            userName: user.fullName,
            hasProfilePicture: !!user.profilePicture,
            profilePictureLength: user.profilePicture ? user.profilePicture.length : 0,
            profilePicturePreview: user.profilePicture ? user.profilePicture.substring(0, 100) : null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// ── COMPLAINT ROUTES ──
// ══════════════════════════════════════════════════════════════

function generateReferenceNo() {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
    const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `ECO-${dateStr}-${randomNum}`;
}

// GET /api/workers/validate/:workerID — check if a workerID exists in the system
app.get('/api/workers/validate/:workerID', async (req, res) => {
    try {
        const { workerID } = req.params;
        if (!workerID || !workerID.trim()) {
            return res.status(400).json({ success: false, message: 'workerID is required' });
        }
        const worker = await User.findOne({ 
            role: 'worker', 
            workerID: workerID.trim(),
            isBlocked: false
        }).select('fullName workerID');
        
        if (!worker) {
            return res.json({ success: false, valid: false, message: 'Invalid Worker ID. No worker found with this ID.' });
        }
        res.json({ success: true, valid: true, worker: { fullName: worker.fullName, workerID: worker.workerID } });
    } catch (error) {
        console.error('Worker validate error:', error);
        res.status(500).json({ success: false, message: 'Error validating worker ID' });
    }
});

// POST /api/complaints/submit
app.post('/api/complaints/submit', async (req, res) => {
    try {
        console.log("📥 Received Complaint Payload:", req.body);

        const { citizenId, title, category, against, description } = req.body;

        const missing = [];
        if (!citizenId)   missing.push('citizenId');
        if (!title)       missing.push('title');
        if (!category)    missing.push('category');
        if (!against)     missing.push('against');
        if (!description) missing.push('description');
        if (missing.length > 0) {
            console.warn('Complaint submit missing fields:', missing);
            return res.status(400).json({ success: false, message: 'Missing: ' + missing.join(', ') });
        }

        // For worker-related categories, validate the Worker ID exists in system
        const workerCategories = ['Worker Misconduct', 'Missed Pickup', 'Improper Disposal', 'Damage to Property', 'Rude Behaviour'];
        const isGeneralComplaint = ['general', 'management', 'system', 'service', 'n/a', 'na'].some(k => against.trim().toLowerCase().includes(k));
        if (!isGeneralComplaint && workerCategories.includes(category)) {
            const matchedWorker = await User.findOne({ role: 'worker', workerID: against.trim() }).select('_id');
            if (!matchedWorker) {
                return res.status(400).json({ 
                    success: false, 
                    invalidWorkerId: true,
                    message: `Invalid Worker ID "${against.trim()}". No active worker with this ID exists. Please verify the Worker ID and try again.`
                });
            }
        }

        const referenceNo = generateReferenceNo();

        const newComplaint = new Complaint({
            citizenId,
            referenceNo,
            title,
            category,
            against,
            description,
            status: 'open'
        });

        await newComplaint.save();

        res.status(201).json({ 
            success: true, 
            complaintId: newComplaint._id,
            referenceNo: newComplaint.referenceNo,
            message: 'Complaint submitted successfully.' 
        });
    } catch (error) {
        console.error("Complaint submission error:", error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during complaint submission.' 
        });
    }
});

// GET /api/complaints/my/:citizenId
app.get('/api/complaints/my/:citizenId', async (req, res) => {
    try {
        const citizenId = req.params.citizenId;

        const complaints = await Complaint.find({ citizenId })
            .sort({ timestamp: -1 });

        res.json({ success: true, complaints });
    } catch (error) {
        console.error("Fetch complaints error:", error);
        res.status(500).json({ 
            success: false, 
            complaints: [],
            message: 'Error fetching complaints.' 
        });
    }
});

// ── ADMIN COMPLAINT ROUTES — must be before /api/complaints/:complaintId ──

// GET /api/admin/complaints
app.get('/api/admin/complaints', async (req, res) => {
    try {
        const complaints = await Complaint.find().sort({ timestamp: -1 });
        res.json({ success: true, complaints });
    } catch (error) {
        console.error("Admin fetch complaints error:", error);
        res.status(500).json({ success: false, message: 'Error fetching complaints.' });
    }
});

// PUT /api/admin/complaints/:id/status
app.put('/api/admin/complaints/:id/status', async (req, res) => {
    try {
        const { status, adminNote } = req.body;
        const allowed = ['open', 'in-progress', 'resolved', 'closed'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status value.' });
        }

        const update = { status };
        if (adminNote !== undefined) update.adminNote = adminNote;
        if (status === 'resolved' || status === 'closed') update.resolvedAt = new Date();

        const complaint = await Complaint.findByIdAndUpdate(
            req.params.id,
            { $set: update },
            { returnDocument: 'after' }
        );

        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found.' });
        }

        res.json({ success: true, complaint });
    } catch (error) {
        console.error("Admin update complaint error:", error);
        res.status(500).json({ success: false, message: 'Error updating complaint.' });
    }
});

// GET /api/complaints/:complaintId
app.get('/api/complaints/:complaintId', async (req, res) => {
    try {
        const complaint = await Complaint.findById(req.params.complaintId);

        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found.' });
        }

        res.json({ success: true, complaint });
    } catch (error) {
        console.error("Fetch complaint error:", error);
        res.status(500).json({ success: false, message: 'Error fetching complaint.' });
    }
});

// DELETE /api/complaints/:complaintId
app.delete('/api/complaints/:complaintId', async (req, res) => {
    try {
        const { citizenId } = req.body;
        const complaint = await Complaint.findById(req.params.complaintId);

        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found.' });
        }

        if (complaint.citizenId.toString() !== citizenId) {
            return res.status(403).json({ success: false, message: 'You can only withdraw your own complaints.' });
        }

        if (complaint.status !== 'open') {
            return res.status(400).json({ success: false, message: 'Only open complaints can be withdrawn.' });
        }

        await Complaint.findByIdAndDelete(req.params.complaintId);

        res.json({ success: true, message: 'Complaint withdrawn successfully.' });
    } catch (error) {
        console.error("Withdraw complaint error:", error);
        res.status(500).json({ success: false, message: 'Error withdrawing complaint.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ── ADMIN USER MANAGEMENT ENDPOINTS ──
// ══════════════════════════════════════════════════════════════

// GET /api/admin/users
app.get('/api/admin/users', async (req, res) => {
    try {
        let users = await User.find()
            .select('_id fullName email role greenPoints isBlocked createdAt workerID totalEarnings')
            .sort({ _id: -1 });
        
        users = users.map(user => {
            const userObj = user.toObject();
            if (userObj.isBlocked === undefined || userObj.isBlocked === null) {
                userObj.isBlocked = false;
            }
            return userObj;
        });
        
        res.json({ success: true, users });
    } catch (error) {
        console.error('Admin fetch users error:', error);
        res.status(500).json({ success: false, message: 'Error fetching users.' });
    }
});

// GET /api/admin/workers
app.get('/api/admin/workers', async (req, res) => {
    try {
        const workers = await User.find({ role: 'worker' }).select('-password').sort({ _id: -1 });
        
        const workersWithStats = await Promise.all(workers.map(async (worker) => {
            const reports = await Report.find({ workerId: worker._id });
            const completed = reports.filter(r => r.status === 'completed').length;
            const pending = reports.filter(r => r.status === 'pending').length;
            const accepted = reports.filter(r => r.status === 'accepted').length;
            
            return {
                ...worker.toObject(),
                tasksCompleted: completed,
                tasksPending: pending,
                tasksAccepted: accepted,
                totalTasks: reports.length
            };
        }));
        
        res.json({ success: true, workers: workersWithStats });
    } catch (error) {
        console.error('Admin fetch workers error:', error);
        res.status(500).json({ success: false, message: 'Error fetching workers.' });
    }
});

// PUT /api/admin/users/:id/block
app.put('/api/admin/users/:id/block', async (req, res) => {
    try {
        const { isBlocked } = req.body;
        
        if (isBlocked === undefined || isBlocked === null) {
            return res.status(400).json({ success: false, message: 'isBlocked field is required' });
        }
        
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }
        
        const user = await User.findByIdAndUpdate(
            req.params.id,
            { $set: { isBlocked: Boolean(isBlocked), updatedAt: new Date() } },
            { new: true, runValidators: true }
        ).select('_id fullName email role greenPoints isBlocked createdAt workerID totalEarnings');
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        
        res.json({ 
            success: true, 
            message: user.isBlocked ? 'User blocked successfully.' : 'User unblocked successfully.',
            user: user.toObject()
        });
    } catch (error) {
        console.error('Admin block user error:', error);
        res.status(500).json({ success: false, message: 'Error updating user.' });
    }
});

// ══════════════════════════════════════════════════════════════
// ── WORKER ENDPOINTS ──
// ══════════════════════════════════════════════════════════════

// POST /api/reports/accept/:reportId
app.post('/api/reports/accept/:reportId', async (req, res) => {
    try {
        const { workerId } = req.body;
        const reportId = req.params.reportId;
        
        if (!workerId) {
            return res.status(400).json({ success: false, message: "Worker ID is required" });
        }

        if (!mongoose.Types.ObjectId.isValid(workerId)) {
            return res.status(400).json({ success: false, message: "Invalid workerId" });
        }

        const worker = await User.findById(workerId);
        if (!worker || worker.role !== 'worker') {
            return res.status(403).json({ success: false, message: "Only workers can accept jobs" });
        }

        if (worker.isBlocked) {
            return res.status(403).json({ success: false, message: "Your account has been blocked by administrators." });
        }

        if (worker.isBusy) {
            return res.status(403).json({ success: false, message: "You are currently set to Busy. Toggle your availability before accepting jobs." });
        }

        if (!mongoose.Types.ObjectId.isValid(reportId)) {
            return res.status(400).json({ success: false, message: "Invalid reportId" });
        }

        const report = await Report.findOneAndUpdate(
            { _id: reportId, status: 'pending' },
            { workerId, status: 'accepted' },
            { returnDocument: 'after' }
        );

        if (!report) {
            return res.status(404).json({ success: false, message: "Report not available for acceptance" });
        }

        res.json({ success: true, message: "Job accepted successfully", report });
    } catch (error) {
        console.error("❌ Accept job error:", error);
        res.status(500).json({ success: false, message: "Error accepting job" });
    }
});

// POST /api/reports/complete/:reportId
app.post('/api/reports/complete/:reportId', async (req, res) => {
    try {
        const { workerId } = req.body;
        const reportId = req.params.reportId;
        
        if (!workerId) {
            return res.status(400).json({ success: false, message: "Worker ID is required" });
        }

        if (!mongoose.Types.ObjectId.isValid(workerId)) {
            return res.status(400).json({ success: false, message: "Invalid workerId" });
        }

        const worker = await User.findById(workerId);
        if (!worker || worker.role !== 'worker') {
            return res.status(403).json({ success: false, message: "Only workers can complete jobs" });
        }

        if (worker.isBlocked) {
            return res.status(403).json({ success: false, message: "Your account has been blocked by administrators." });
        }

        if (!mongoose.Types.ObjectId.isValid(reportId)) {
            return res.status(400).json({ success: false, message: "Invalid reportId" });
        }

        let report = await Report.findOneAndUpdate(
            {
                _id: reportId,
                workerId: new mongoose.Types.ObjectId(workerId),
                status: 'accepted'
            },
            { status: 'completed', completedAt: new Date() },
            { returnDocument: 'after' }
        );

        if (!report) {
            return res.status(404).json({ success: false, message: "Accepted report not found for this worker" });
        }

        const payout = Number(report.pointsAwarded) > 0 ? Number(report.pointsAwarded) : 50;
        if (Number(report.pointsAwarded) !== payout) {
            await Report.updateOne({ _id: report._id }, { $set: { pointsAwarded: payout } });
            report.pointsAwarded = payout;
        }

        const updateResult = await User.findByIdAndUpdate(
            workerId,
            { $inc: { totalEarnings: payout } },
            { returnDocument: 'after' }
        );

        res.json({ 
            success: true, 
            message: "Job completed successfully",
            earnings: payout,
            newTotal: updateResult.totalEarnings,
            report 
        });
    } catch (error) {
        console.error("❌ Complete job error:", error);
        res.status(500).json({ success: false, message: "Error completing job" });
    }
});

// GET /api/worker/:workerId
app.get('/api/worker/:workerId', async (req, res) => {
    try {
        const workerId = req.params.workerId;

        if (!mongoose.Types.ObjectId.isValid(workerId)) {
            return res.status(400).json({ success: false, message: "Invalid workerId" });
        }

        const worker = await User.findById(workerId).select('-profilePicture');
        
        if (!worker) {
            return res.status(404).json({ success: false, message: "Worker not found" });
        }

        if (worker.isBlocked) {
            return res.status(403).json({ success: false, message: "Your account has been blocked by administrators." });
        }

        const workerObjectId = new mongoose.Types.ObjectId(workerId);
        const completedReports = await Report.find({ workerId: workerObjectId, status: 'completed' });
        const completedJobs = completedReports.length;
        const activeJob = await Report.findOne({ workerId: workerObjectId, status: 'accepted' }).lean();

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekRef = new Date(now);
        weekRef.setDate(weekRef.getDate() - weekRef.getDay());
        const weekStart = new Date(weekRef.getFullYear(), weekRef.getMonth(), weekRef.getDate());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const today = getWorkerPeriodStats(completedReports, todayStart);
        const week = getWorkerPeriodStats(completedReports, weekStart);
        const month = getWorkerPeriodStats(completedReports, monthStart);

        res.json({ 
            success: true, 
            worker: {
                fullName: worker.fullName,
                workerID: worker.workerID,
                totalEarnings: worker.totalEarnings,
                totalWithdrawn: worker.totalWithdrawn || 0,
                completedJobs,
                profilePicture: null,
                isBusy: worker.isBusy || false
            },
            activeJob,
            earnings: { today, week, month, total: worker.totalEarnings }
        });
    } catch (error) {
        console.error("Worker stats error:", error);
        res.status(500).json({ success: false, message: "Error fetching worker stats" });
    }
});

// PATCH /api/worker/:workerId/availability — persist isBusy toggle to DB
app.patch('/api/worker/:workerId/availability', async (req, res) => {
    try {
        const { workerId } = req.params;
        const { isBusy } = req.body;

        if (!mongoose.Types.ObjectId.isValid(workerId)) {
            return res.status(400).json({ success: false, message: "Invalid workerId" });
        }

        if (typeof isBusy !== 'boolean') {
            return res.status(400).json({ success: false, message: "isBusy must be a boolean" });
        }

        const worker = await User.findByIdAndUpdate(
            workerId,
            { $set: { isBusy } },
            { returnDocument: 'after' }
        ).select('fullName isBusy');

        if (!worker) {
            return res.status(404).json({ success: false, message: "Worker not found" });
        }

        res.json({
            success: true,
            message: isBusy ? "Status set to Busy" : "Status set to Available",
            isBusy: worker.isBusy
        });
    } catch (error) {
        console.error("❌ Availability update error:", error);
        res.status(500).json({ success: false, message: "Error updating availability" });
    }
});

// POST /api/worker/withdraw
app.post('/api/worker/withdraw', async (req, res) => {
    try {
        const { workerId, amount, method, destination } = req.body;
        
        if (!workerId || !amount || amount < 100) {
            return res.status(400).json({ success: false, message: "Invalid amount." });
        }

        const worker = await User.findById(workerId);
        if (!worker || worker.role !== 'worker') {
            return res.status(404).json({ success: false, message: "Worker not found." });
        }

        const withdrawn = worker.totalWithdrawn || 0;
        const availableBalance = worker.totalEarnings - withdrawn;

        if (amount > availableBalance) {
            return res.status(400).json({ success: false, message: "Insufficient available balance." });
        }

        // ── Save to dedicated WithdrawalHistory collection ──
        const historyDoc = new WithdrawalHistory({
            workerId: worker._id,
            amount,
            method:      method      || 'UPI ID',
            destination: destination || '—',
            status:      'pending',
            date:        new Date()
        });
        await historyDoc.save();

        // ── Update totals on the User document (keep embedded array in sync too) ──
        const historyEntry = {
            amount,
            method:      method      || 'UPI ID',
            destination: destination || '—',
            date:        new Date(),
            status:      'pending'
        };

        worker.totalWithdrawn = withdrawn + amount;
        if (!worker.withdrawalHistory) worker.withdrawalHistory = [];
        worker.withdrawalHistory.push(historyEntry);
        worker.historySynced = true;   // already in the new collection
        await worker.save();

        res.json({ 
            success: true, 
            message: "Withdrawal successful",
            totalWithdrawn:   worker.totalWithdrawn,
            availableBalance: worker.totalEarnings - worker.totalWithdrawn
        });
    } catch (error) {
        console.error("Withdrawal error:", error);
        res.status(500).json({ success: false, message: "Server error processing withdrawal." });
    }
});

// GET /api/worker/withdrawal-history/:workerId
app.get('/api/worker/withdrawal-history/:workerId', async (req, res) => {
    try {
        const workerId = req.params.workerId;
        if (!mongoose.Types.ObjectId.isValid(workerId)) {
            return res.status(400).json({ success: false, message: "Invalid workerId" });
        }

        const worker = await User.findById(workerId)
            .select('fullName workerID totalEarnings totalWithdrawn');
        if (!worker) {
            return res.status(404).json({ success: false, message: "Worker not found." });
        }

        // ── Fetch from dedicated WithdrawalHistory collection, newest first ──
        const history = await WithdrawalHistory.find({ workerId })
            .sort({ date: -1 })
            .lean();

        res.json({
            success: true,
            worker: {
                fullName:      worker.fullName,
                workerID:      worker.workerID,
                totalEarnings: worker.totalEarnings  || 0,
                totalWithdrawn:worker.totalWithdrawn || 0
            },
            history
        });
    } catch (error) {
        console.error("Withdrawal history error:", error);
        res.status(500).json({ success: false, message: "Server error fetching history." });
    }
});

// PATCH /api/admin/withdrawal/:id/status — approve or reject a withdrawal record
// Body: { status: 'paid' | 'rejected' }
app.patch('/api/admin/withdrawal/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['paid', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: "Status must be 'paid' or 'rejected'." });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid withdrawal ID." });
        }

        const withdrawal = await WithdrawalHistory.findById(id);
        if (!withdrawal) {
            return res.status(404).json({ success: false, message: "Withdrawal record not found." });
        }

        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Cannot update — withdrawal is already '${withdrawal.status}'.` });
        }

        withdrawal.status = status;
        await withdrawal.save();

        // If rejecting: refund the amount back to the worker's available balance
        if (status === 'rejected') {
            await User.findByIdAndUpdate(withdrawal.workerId, {
                $inc: { totalWithdrawn: -withdrawal.amount }
            });
        }

        // Best-effort sync of the embedded array — isolated so it never crashes the response.
        // The WithdrawalHistory collection is the source of truth; this is only cosmetic.
        try {
            await User.updateOne(
                {
                    _id: withdrawal.workerId,
                    'withdrawalHistory._id': withdrawal._id
                },
                { $set: { 'withdrawalHistory.$.status': status } }
            );
        } catch (syncErr) {
            // Non-fatal — log and continue
            console.warn('⚠️  Embedded withdrawalHistory sync skipped:', syncErr.message);
        }

        res.json({
            success: true,
            message: status === 'paid' ? 'Withdrawal approved and marked as paid.' : 'Withdrawal rejected and amount refunded.',
            withdrawal
        });
    } catch (error) {
        console.error("Admin withdrawal status update error:", error);
        res.status(500).json({ success: false, message: "Server error updating withdrawal status." });
    }
});

// GET /api/admin/worker-payments — all workers with their withdrawal history
app.get('/api/admin/worker-payments', async (req, res) => {
    try {
        const workers = await User.find({ role: 'worker' })
            .select('fullName workerID totalEarnings totalWithdrawn isBlocked')
            .sort({ _id: -1 });

        // ── Pull all withdrawal docs in one query, then group by workerId ──
        const allHistory = await WithdrawalHistory.find({
            workerId: { $in: workers.map(w => w._id) }
        }).sort({ date: -1 }).lean();

        // Build a map: workerId string → array of history docs
        const historyMap = {};
        for (const h of allHistory) {
            const key = h.workerId.toString();
            if (!historyMap[key]) historyMap[key] = [];
            historyMap[key].push(h);
        }

        const result = workers.map(w => ({
            _id:              w._id,
            fullName:         w.fullName,
            workerID:         w.workerID,
            totalEarnings:    w.totalEarnings    || 0,
            totalWithdrawn:   w.totalWithdrawn   || 0,
            availableBalance: (w.totalEarnings   || 0) - (w.totalWithdrawn || 0),
            isBlocked:        w.isBlocked        || false,
            withdrawalHistory: historyMap[w._id.toString()] || []
        }));

        res.json({ success: true, workers: result });
    } catch (error) {
        console.error("Admin worker payments error:", error);
        res.status(500).json({ success: false, message: "Error fetching worker payments." });
    }
});

// ══════════════════════════════════════════════════════════════
// ── HELPER FUNCTIONS ──
// ══════════════════════════════════════════════════════════════

function getWorkerPeriodStats(reports, startDate) {
    const matched = reports.filter(r => {
        const d = r.completedAt || r.timestamp;
        return d && new Date(d) >= startDate;
    });

    const jobs = matched.length;
    const amount = matched.reduce((sum, r) => sum + (Number(r.pointsAwarded) || 0), 0);

    return {
        amount,
        jobs,
        avg: jobs > 0 ? Math.round(amount / jobs) : 0,
        bonus: 0
    };
}

// ══════════════════════════════════════════════════════════════
// ── CITIZEN UTILITY ENDPOINTS ──
// ══════════════════════════════════════════════════════════════

// POST /api/user/deduct-points
app.post('/api/user/deduct-points', async (req, res) => {
    try {
        const { userId, points } = req.body;

        if (!userId || !points) {
            return res.status(400).json({ success: false, message: "Missing userId or points" });
        }

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: "Invalid userId" });
        }

        if (points <= 0) {
            return res.status(400).json({ success: false, message: "Points must be greater than 0" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.greenPoints < points) {
            return res.status(400).json({ success: false, message: "Insufficient green points" });
        }

        const updated = await User.findByIdAndUpdate(
            userId,
            { $inc: { greenPoints: -points } },
            { returnDocument: 'after' }
        );

        res.json({ 
            success: true, 
            message: `${points} green points deducted successfully`,
            remainingPoints: updated.greenPoints  // FIX: was "newBalance" in frontend, now consistent
        });
    } catch (error) {
        console.error("Deduct points error:", error);
        res.status(500).json({ success: false, message: "Error deducting points" });
    }
});

// ══════════════════════════════════════════════════════════════
// ── REDEMPTION HISTORY ENDPOINTS ──
// ══════════════════════════════════════════════════════════════

// POST /api/user/save-redemption — persist a coupon redemption to MongoDB
app.post('/api/user/save-redemption', async (req, res) => {
    try {
        const { userId, key, brand, ico, offer, code, pts } = req.body;
        if (!userId || !key || !brand || !offer || !code || !pts) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid userId' });
        }
        const entry = await RedemptionHistory.create({ userId, key, brand, ico, offer, code, pts });
        res.json({ success: true, entry });
    } catch (error) {
        console.error('Save redemption error:', error);
        res.status(500).json({ success: false, message: 'Error saving redemption' });
    }
});

// GET /api/user/redemption-history/:userId — fetch all redemptions for a user
app.get('/api/user/redemption-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid userId' });
        }
        const history = await RedemptionHistory.find({ userId }).sort({ redeemedAt: -1 }).lean();
        res.json({ success: true, history });
    } catch (error) {
        console.error('Fetch redemption history error:', error);
        res.status(500).json({ success: false, message: 'Error fetching history' });
    }
});

// GET /api/user/rank/:userId — rank among citizens by greenPoints
app.get('/api/user/rank/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid userId' });
        }
        const user = await User.findById(userId).select('greenPoints');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        const rank = await User.countDocuments({ role: 'citizen', greenPoints: { $gt: user.greenPoints } });
        const totalCitizens = await User.countDocuments({ role: 'citizen' });
        res.json({ success: true, rank: rank + 1, total: totalCitizens, points: user.greenPoints });
    } catch (error) {
        console.error('Rank error:', error);
        res.status(500).json({ success: false, message: 'Error fetching rank' });
    }
});

// ══════════════════════════════════════════════════════════════
// ── DATA MIGRATION & MAINTENANCE ──
// ══════════════════════════════════════════════════════════════

app.get('/api/admin/migrate-dates', async (req, res) => {
    try {
        const result = await User.updateMany(
            { createdAt: { $exists: false } },
            { $set: { createdAt: new Date() } }
        );
        res.json({ success: true, message: `Updated ${result.modifiedCount} old users.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/migrate-users', async (req, res) => {
    try {
        const result = await User.updateMany(
            { isBlocked: { $exists: false } },
            { $set: { isBlocked: false } },
            { upsert: false }
        );
        
        const users = await User.find({}).select('_id fullName email isBlocked createdAt updatedAt');
        const withoutBlocked = users.filter(u => u.isBlocked === undefined || u.isBlocked === null);
        const withoutTimestamps = users.filter(u => !u.createdAt || !u.updatedAt);
        
        res.json({ 
            success: true, 
            message: 'Migration complete',
            stats: {
                totalUsers: users.length,
                usersUpdated: result.modifiedCount,
                missingIsBlocked: withoutBlocked.length,
                missingTimestamps: withoutTimestamps.length
            }
        });
    } catch (error) {
        console.error('Migration error:', error);
        res.status(500).json({ success: false, message: 'Migration failed', error: error.message });
    }
});

// TEST ROUTE
app.post('/api/test-route', (req, res) => {
    res.json({ success: true, message: "Test route works!" });
});

// ══════════════════════════════════════════════════════════════
// ── SERVER STARTUP ──
// ══════════════════════════════════════════════════════════════

// Serve frontend static files — MUST be after all API routes
app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(process.env.PORT || 5000, () => console.log(`🚀 Server running on http://localhost:${process.env.PORT || 5000}`));