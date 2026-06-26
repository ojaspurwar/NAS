const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const os = require('os');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 5000;
const HTTPS_PORT = process.env.HTTPS_PORT || 5443;
const storageDir = path.join(__dirname, 'storage');
const trashDir = path.join(storageDir, '.trash');
const hiddenDir = path.join(storageDir, '.hidden');

// Share links storage (in-memory, would use DB in production)
const shareLinks = new Map();

// Ensure directories exist
if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
if (!fs.existsSync(hiddenDir)) fs.mkdirSync(hiddenDir, { recursive: true });

// ============ SECURITY MIDDLEWARE ============

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

// Rate limiting - stricter for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 requests per 15 min for auth
    message: { error: 'Too many attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute for API
    message: { error: 'Rate limit exceeded' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ============ COLORS & UTILS ============

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m"
};

function getClientIp(req) {
    let ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    return ip.replace(/^.*:/, ''); // clean IPv6 prefixes
}

function getSafePath(userPath) {
    if (!userPath) return storageDir;
    const resolvedPath = path.resolve(storageDir, userPath);
    if (!resolvedPath.startsWith(storageDir)) {
        return storageDir;
    }
    return resolvedPath;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// ============ MIDDLEWARE SETUP ============

app.use(cors());
app.use(express.json());
app.use(apiLimiter); // Apply rate limiting to all API routes

// Cool Logger
app.use((req, res, next) => {
    const ip = getClientIp(req);
    const time = new Date().toLocaleTimeString();

    let methodColor = colors.green;
    if (req.method === 'POST') methodColor = colors.yellow;
    if (req.method === 'DELETE') methodColor = colors.red;
    if (req.method === 'PUT') methodColor = colors.blue;

    res.on('finish', () => {
        let statusColor = res.statusCode < 400 ? colors.green : colors.red;
        console.log(`${colors.dim}[${time}]${colors.reset} ${methodColor}${req.method}${colors.reset} ${colors.cyan}${req.originalUrl}${colors.reset} ${colors.dim}->${colors.reset} ${statusColor}${res.statusCode}${colors.reset} ${colors.dim}(${ip})${colors.reset}`);
    });

    next();
});

// HTTP to HTTPS redirect - only for HTTP server port
app.use((req, res, next) => {
    console.log(`HTTP redirect check: localPort=${req.socket.localPort}, PORT=${PORT}`);
    if (req.socket.localPort == PORT) {
        console.log(`Redirecting to https://${req.hostname}:${HTTPS_PORT}${req.url}`);
        return res.redirect(`https://${req.hostname}:${HTTPS_PORT}${req.url}`);
    }
    next();
});

app.use(express.static('public'));

// Configure Multer for uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const destPath = getSafePath(req.body.path || '');
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }
        cb(null, destPath);
    },
    filename: (req, file, cb) => {
        // Prevent overwriting - add timestamp if file exists
        const filePath = path.join(req.body.path || '', file.originalname);
        const safePath = getSafePath(req.body.path || '');
        const fullPath = path.join(safePath, file.originalname);

        if (fs.existsSync(fullPath)) {
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            const timestamp = Date.now();
            cb(null, `${name}_${timestamp}${ext}`);
        } else {
            cb(null, file.originalname);
        }
    }
});

// Configure upload limits (max 500MB per file)
const upload = multer({
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 }
});

// ============ AUTHENTICATION ============

const PASSWORD = process.env.NAS_PASSWORD || '112007';

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${PASSWORD}`) {
        const ip = getClientIp(req);
        console.log(`${colors.red}${colors.bright}⚠️  SECURITY ALERT:${colors.reset} ${colors.red}Blocked unauthorized access from IP: ${ip}${colors.reset}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function requireAuthQuery(req, res, next) {
    const token = req.query.token;
    if (!token || token !== PASSWORD) {
        const ip = getClientIp(req);
        console.log(`${colors.red}${colors.bright}⚠️  SECURITY ALERT:${colors.reset} ${colors.red}Blocked unauthorized access from IP: ${ip}${colors.reset}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Apply stricter rate limit to auth endpoints
app.use('/api/files', authLimiter);
app.use('/api/upload', authLimiter);
app.use('/api/search', authLimiter);
app.use('/api/folders', authLimiter);
app.use('/api/rename', authLimiter);
app.use('/api/move', authLimiter);
app.use('/api/trash', authLimiter);

// ============ API ROUTES ============

// Get storage info
app.get('/api/storage', requireAuth, (req, res) => {
    try {
        const stats = fs.statfsSync(storageDir);
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        const used = total - free;
        res.json({
            total,
            free,
            used,
            totalFormatted: formatBytes(total),
            freeFormatted: formatBytes(free),
            usedFormatted: formatBytes(used)
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get storage info' });
    }
});

// List all files and folders
app.get('/api/files', requireAuth, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');

    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'Directory not found' });
    }

    try {
        const items = fs.readdirSync(targetPath);
        const itemInfos = items
            .filter(item => {
                // Hide .trash and .hidden from root
                if (targetPath === storageDir && (item === '.trash' || item === '.hidden')) return false;
                return true;
            })
            .map(item => {
                const itemPath = path.join(targetPath, item);
                try {
                    const stats = fs.statSync(itemPath);
                    return {
                        name: item,
                        size: stats.isDirectory() ? null : stats.size,
                        sizeFormatted: stats.isDirectory() ? null : formatBytes(stats.size),
                        createdAt: stats.birthtime,
                        modifiedAt: stats.mtime,
                        isDirectory: stats.isDirectory()
                    };
                } catch (e) {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => {
                // Folders first, then by date
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return new Date(b.modifiedAt) - new Date(a.modifiedAt);
            });

        res.json(itemInfos);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read directory' });
    }
});

// Search files and folders globally
app.get('/api/search', requireAuth, (req, res) => {
    const query = (req.query.q || '').trim();
    const ip = getClientIp(req);

    if (!query || query.length < 2) return res.json([]);

    console.log(`${colors.cyan}🔍 SEARCHING:${colors.reset} "${query}" (${ip})`);

    const results = [];
    const maxResults = 100; // Limit results

    function searchDir(dirPath, relativePath = '') {
        if (results.length >= maxResults) return;

        try {
            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                if (results.length >= maxResults) return;
                if (dirPath === storageDir && (item === '.trash' || item === '.hidden')) continue;

                const fullPath = path.join(dirPath, item);
                const itemRelative = relativePath ? `${relativePath}/${item}` : item;

                try {
                    const stats = fs.statSync(fullPath);

                    if (item.toLowerCase().includes(query.toLowerCase())) {
                        results.push({
                            name: item,
                            path: itemRelative,
                            size: stats.isDirectory() ? null : stats.size,
                            sizeFormatted: stats.isDirectory() ? null : formatBytes(stats.size),
                            createdAt: stats.birthtime,
                            isDirectory: stats.isDirectory()
                        });
                    }

                    if (stats.isDirectory()) {
                        searchDir(fullPath, itemRelative);
                    }
                } catch (e) {
                    // Ignore unreadable items
                }
            }
        } catch (e) {
            // Ignore unreadable dirs
        }
    }

    try {
        searchDir(storageDir);
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// Create a folder
app.post('/api/folders', requireAuth, (req, res) => {
    const { path: folderPath, name } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Folder name required' });
    }

    const targetPath = getSafePath(folderPath || '');
    const newFolderPath = path.join(targetPath, name);

    if (fs.existsSync(newFolderPath)) {
        return res.status(400).json({ error: 'Folder already exists' });
    }

    try {
        fs.mkdirSync(newFolderPath, { recursive: true });
        console.log(`${colors.blue}📁 FOLDER CREATED:${colors.reset} ${name}`);
        res.json({ message: 'Folder created successfully', path: folderPath || '', name });
    } catch (e) {
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Upload files (multiple supported)
app.post('/api/upload', requireAuth, upload.array('files', 50), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedFiles = req.files.map(file => ({
        originalname: file.originalname,
        filename: file.filename,
        size: file.size,
        sizeFormatted: formatBytes(file.size)
    }));

    console.log(`${colors.magenta}📦 ${req.files.length} FILE(S) UPLOADED:${colors.reset} ${uploadedFiles.map(f => f.originalname).join(', ')}`);
    res.json({
        message: `${req.files.length} file(s) uploaded successfully`,
        files: uploadedFiles
    });
});

// Download a file
app.get('/api/download', requireAuthQuery, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        console.log(`${colors.yellow}⬇️  DOWNLOADING:${colors.reset} ${path.basename(targetPath)}`);
        res.download(targetPath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Delete a file or folder
app.delete('/api/files', requireAuth, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');
    const permanent = req.query.permanent === 'true';

    if (targetPath === storageDir) {
        return res.status(400).json({ error: 'Cannot delete root directory' });
    }

    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'Not found' });
    }

    const stats = fs.statSync(targetPath);
    const itemName = path.basename(targetPath);

    // If it's already in .trash, or permanent flag is true
    if (targetPath.startsWith(trashDir) || permanent) {
        try {
            if (stats.isDirectory()) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(targetPath);
            }
            console.log(`${colors.red}🗑️  PERMANENTLY DELETED:${colors.reset} ${itemName}`);
            res.json({ message: 'Deleted permanently' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to delete' });
        }
    } else {
        // Move to .trash
        const timestamp = Date.now();
        let trashPath = path.join(trashDir, `${itemName}_${timestamp}`);

        // Handle naming conflicts in trash
        let counter = 1;
        while (fs.existsSync(trashPath)) {
            trashPath = path.join(trashDir, `${itemName}_${timestamp}_${counter}`);
            counter++;
        }

        try {
            fs.renameSync(targetPath, trashPath);
            console.log(`${colors.yellow}♻️  MOVED TO TRASH:${colors.reset} ${itemName}`);
            res.json({ message: 'Moved to Recycle Bin' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to move to trash' });
        }
    }
});

// Empty Recycle Bin
app.delete('/api/trash/empty', requireAuth, (req, res) => {
    try {
        const items = fs.readdirSync(trashDir);
        let deletedCount = 0;

        for (const item of items) {
            const itemPath = path.join(trashDir, item);
            const stats = fs.statSync(itemPath);
            if (stats.isDirectory()) fs.rmSync(itemPath, { recursive: true, force: true });
            else fs.unlinkSync(itemPath);
            deletedCount++;
        }

        console.log(`${colors.red}🗑️  EMPTIED RECYCLE BIN (${deletedCount} items)${colors.reset}`);
        res.json({ message: 'Trash emptied successfully', deletedCount });
    } catch (e) {
        res.status(500).json({ error: 'Failed to empty trash' });
    }
});

// List trash contents
app.get('/api/trash', requireAuth, (req, res) => {
    try {
        const items = fs.readdirSync(trashDir);
        const itemInfos = items.map(item => {
            const itemPath = path.join(trashDir, item);
            try {
                const stats = fs.statSync(itemPath);
                return {
                    name: item,
                    size: stats.isDirectory() ? null : stats.size,
                    sizeFormatted: stats.isDirectory() ? null : formatBytes(stats.size),
                    deletedAt: stats.mtime,
                    isDirectory: stats.isDirectory()
                };
            } catch (e) {
                return null;
            }
        }).filter(Boolean).sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

        res.json(itemInfos);
    } catch (e) {
        res.status(500).json({ error: 'Failed to read trash' });
    }
});

// Server Health
app.get('/api/health', requireAuth, (req, res) => {
    try {
        const cpus = os.cpus();
        let idle = 0;
        let total = 0;
        cpus.forEach(cpu => {
            for (let type in cpu.times) {
                total += cpu.times[type];
            }
            idle += cpu.times.idle;
        });
        const cpuUsage = 100 - Math.round((idle / total) * 100);

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const uptime = os.uptime();

        res.json({
            cpuUsage,
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus.length,
            totalMem,
            totalMemFormatted: formatBytes(totalMem),
            freeMem,
            freeMemFormatted: formatBytes(freeMem),
            usedMem,
            usedMemFormatted: formatBytes(usedMem),
            uptime,
            uptimeFormatted: formatUptime(uptime),
            platform: os.platform(),
            arch: os.arch()
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get health info' });
    }
});

// Rename a file or folder
app.put('/api/rename', requireAuth, (req, res) => {
    const { oldPath, newName } = req.body;

    if (!newName || !oldPath) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }

    // Prevent path traversal in new name
    if (newName.includes('/') || newName.includes('\\')) {
        return res.status(400).json({ error: 'Invalid name' });
    }

    const oldPathResolved = getSafePath(oldPath);
    const newPath = path.join(path.dirname(oldPathResolved), newName);

    if (!fs.existsSync(oldPathResolved)) {
        return res.status(400).json({ error: 'Source not found' });
    }

    if (!newPath.startsWith(storageDir)) {
        return res.status(403).json({ error: 'Invalid path' });
    }

    if (fs.existsSync(newPath) && newPath.toLowerCase() !== oldPathResolved.toLowerCase()) {
        return res.status(400).json({ error: 'Name already exists' });
    }

    try {
        fs.renameSync(oldPathResolved, newPath);
        console.log(`${colors.yellow}✏️  RENAMED:${colors.reset} ${path.basename(oldPathResolved)} -> ${newName}`);
        res.json({ message: 'Renamed successfully', newName });
    } catch (e) {
        res.status(500).json({ error: 'Rename failed' });
    }
});

// Move a file or folder
app.put('/api/move', requireAuth, (req, res) => {
    const { oldPath, newParentPath } = req.body;

    const oldPathResolved = getSafePath(oldPath);
    const newParentPathResolved = getSafePath(newParentPath);

    if (!fs.existsSync(oldPathResolved)) {
        return res.status(400).json({ error: 'Source not found' });
    }

    if (!fs.existsSync(newParentPathResolved) || !fs.statSync(newParentPathResolved).isDirectory()) {
        return res.status(400).json({ error: 'Destination folder not found' });
    }

    const newPath = path.join(newParentPathResolved, path.basename(oldPathResolved));

    if (fs.existsSync(newPath)) {
        return res.status(400).json({ error: 'Destination already has an item with this name' });
    }

    try {
        fs.renameSync(oldPathResolved, newPath);
        console.log(`${colors.blue}🚚 MOVED:${colors.reset} ${path.basename(oldPathResolved)} to ${newParentPath}`);
        res.json({ message: 'Moved successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Move failed' });
    }
});

// Stream a media file
app.get('/api/stream', requireAuthQuery, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        console.log(`${colors.cyan}▶️  STREAMING:${colors.reset} ${path.basename(targetPath)}`);

        // Set appropriate content type
        const ext = path.extname(targetPath).toLowerCase();
        const mimeTypes = {
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.mov': 'video/quicktime',
            '.avi': 'video/x-msvideo',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml'
        };

        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');

        res.sendFile(targetPath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Preview image thumbnail
app.get('/api/preview', requireAuthQuery, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');
    const ext = path.extname(targetPath).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];

    if (!imageExts.includes(ext)) {
        return res.status(400).json({ error: 'Not an image file' });
    }

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        res.setHeader('Content-Type', `image/${ext.slice(1)}`);
        res.sendFile(targetPath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Download Folder as ZIP
app.get('/api/download-zip', requireAuthQuery, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        console.log(`${colors.yellow}🗜️  ZIPPING:${colors.reset} ${path.basename(targetPath)}`);

        const archive = new archiver.ZipArchive({ zlib: { level: 5 } });

        archive.on('error', function (err) {
            res.status(500).send({ error: err.message });
        });

        res.attachment(`${path.basename(targetPath) || 'root_backup'}.zip`);
        archive.pipe(res);
        archive.directory(targetPath, false);
        archive.finalize();
    } else {
        res.status(404).json({ error: 'Folder not found' });
    }
});

// ============ SHARE LINKS ============

// Create a share link
app.post('/api/share', requireAuth, (req, res) => {
    const { path: filePath, expiresIn } = req.body;
    const targetPath = getSafePath(filePath);

    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const shareId = uuidv4();
    const expiresAt = Date.now() + (expiresIn || 24) * 60 * 60 * 1000; // Default 24 hours

    shareLinks.set(shareId, {
        path: filePath,
        expiresAt,
        createdAt: Date.now()
    });

    console.log(`${colors.cyan}🔗 SHARE CREATED:${colors.reset} ${path.basename(targetPath)}`);
    res.json({
        shareId,
        expiresAt: new Date(expiresAt).toISOString(),
        url: `/api/shared/${shareId}`
    });
});

// Access share link
app.get('/api/shared/:shareId', (req, res) => {
    const { shareId } = req.params;
    const share = shareLinks.get(shareId);

    if (!share) {
        return res.status(404).json({ error: 'Share link not found or expired' });
    }

    if (Date.now() > share.expiresAt) {
        shareLinks.delete(shareId);
        return res.status(410).json({ error: 'Share link expired' });
    }

    const targetPath = getSafePath(share.path);

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        console.log(`${colors.cyan}🔗 SHARED FILE ACCESSED:${colors.reset} ${path.basename(targetPath)}`);
        res.download(targetPath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// List active shares
app.get('/api/shares', requireAuth, (req, res) => {
    const shares = [];
    const now = Date.now();

    for (const [id, share] of shareLinks) {
        if (now <= share.expiresAt) {
            shares.push({
                shareId: id,
                path: share.path,
                expiresAt: new Date(share.expiresAt).toISOString(),
                createdAt: new Date(share.createdAt).toISOString()
            });
        } else {
            shareLinks.delete(id);
        }
    }

    res.json(shares);
});

// Delete share link
app.delete('/api/share/:shareId', requireAuth, (req, res) => {
    const { shareId } = req.params;
    const deleted = shareLinks.delete(shareId);

    if (deleted) {
        console.log(`${colors.yellow}🔗 SHARE DELETED:${colors.reset} ${shareId}`);
    }

    res.json({ message: deleted ? 'Share deleted' : 'Share not found' });
});

// ============ GRACEFUL SHUTDOWN ============

function gracefulShutdown(signal) {
    console.log(`\n${colors.yellow}📤 Received ${signal}. Graceful shutdown...${colors.reset}`);

    // Close server
    server.close(() => {
        console.log(`${colors.green}✅ Server closed${colors.reset}`);
        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
        console.log(`${colors.red}⚠️  Forcing exit${colors.reset}`);
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============ START SERVER ============

// Load SSL certificates
let httpsServer;
try {
    const httpsOptions = {
        key: fs.readFileSync(path.join(__dirname, 'key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
    };
    httpsServer = https.createServer(httpsOptions, app);
} catch (e) {
    console.log(`${colors.yellow}⚠ SSL certificates not found, running in HTTP-only mode${colors.reset}`);
}

// Start HTTP server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.clear();
    console.log(colors.green + colors.bright);
    console.log(`
    ╔══════════════════════════════════════════════╗
    ║                                              ║
    ║   ███╗   ██╗ █████╗ ███████╗                 ║
    ║   ████╗  ██║██╔══██╗██╔════╝                 ║
    ║   ██╔██╗ ██║███████║███████╗                 ║
    ║   ██║╚██╗██║██╔══██║╚════██║                 ║
    ║   ██║ ╚████║██║  ██║███████║                 ║
    ║   ╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝                 ║
    ║                                              ║
    ║   Home NAS v2.0 - Enhanced Edition           ║
    ╚══════════════════════════════════════════════╝
    ` + colors.reset);
    console.log(`${colors.cyan}▶ Server Running:${colors.reset} http://localhost:${PORT}`);
    console.log(`${colors.cyan}▶ Server Running:${colors.reset} http://0.0.0.0:${PORT}`);
    if (httpsServer) {
        httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
            console.log(`${colors.cyan}▶ HTTPS Running:${colors.reset} https://localhost:${HTTPS_PORT}`);
            console.log(`${colors.cyan}▶ HTTPS Running:${colors.reset} https://0.0.0.0:${HTTPS_PORT}`);
            console.log(`${colors.yellow}⚠ Note: Accept the self-signed certificate warning in browser${colors.reset}`);
        });
    }
    console.log(`${colors.dim}▶ Security: Helmet + Rate Limiting Enabled${colors.reset}`);
    console.log(`${colors.dim}▶ Waiting for incoming connections...${colors.reset}\n`);
});