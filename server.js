const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;
const storageDir = path.join(__dirname, 'storage');
const trashDir = path.join(storageDir, '.trash');
const hiddenDir = path.join(storageDir, '.hidden');

// Ensure directories exist
if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
if (!fs.existsSync(hiddenDir)) fs.mkdirSync(hiddenDir, { recursive: true });

// Helper to prevent path traversal
function getSafePath(userPath) {
    if (!userPath) return storageDir;
    const resolvedPath = path.resolve(storageDir, userPath);
    if (!resolvedPath.startsWith(storageDir)) {
        return storageDir;
    }
    return resolvedPath;
}

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
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    return ip.replace(/^.*:/, ''); // clean IPv6 prefixes
}

// Middleware
app.use(cors());
app.use(express.json());

// Cool Logger
app.use((req, res, next) => {
    const ip = getClientIp(req);
    const time = new Date().toLocaleTimeString();

    let methodColor = colors.green;
    if (req.method === 'POST') methodColor = colors.yellow;
    if (req.method === 'DELETE') methodColor = colors.red;

    res.on('finish', () => {
        let statusColor = res.statusCode < 400 ? colors.green : colors.red;
        console.log(`${colors.dim}[${time}]${colors.reset} ${methodColor}${req.method}${colors.reset} ${colors.cyan}${req.originalUrl}${colors.reset} ${colors.dim}->${colors.reset} ${statusColor}${res.statusCode}${colors.reset} ${colors.dim}(IP: ${ip})${colors.reset}`);
    });

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
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// API Routes
const PASSWORD = process.env.NAS_PASSWORD || '112007';

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${PASSWORD}`) {
        const ip = getClientIp(req);
        console.log(`${colors.red}${colors.bright}⚠️  SECURITY ALERT:${colors.reset} ${colors.red}Blocked unauthorized API access from IP: ${ip}${colors.reset}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function requireAuthQuery(req, res, next) {
    const token = req.query.token;
    if (!token || token !== PASSWORD) {
        const ip = getClientIp(req);
        console.log(`${colors.red}${colors.bright}⚠️  SECURITY ALERT:${colors.reset} ${colors.red}Blocked unauthorized download from IP: ${ip}${colors.reset}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Get storage info
app.get('/api/storage', requireAuth, (req, res) => {
    try {
        const stats = fs.statfsSync(storageDir);
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        const used = total - free;
        res.json({ total, free, used });
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

    fs.readdir(targetPath, (err, items) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to read directory' });
        }

        const itemInfos = items.map(item => {
            // Hide .trash and .hidden from root
            if (targetPath === storageDir && (item === '.trash' || item === '.hidden')) return null;

            const itemPath = path.join(targetPath, item);
            try {
                const stats = fs.statSync(itemPath);
                return {
                    name: item,
                    size: stats.isDirectory() ? null : stats.size,
                    createdAt: stats.birthtime,
                    isDirectory: stats.isDirectory()
                };
            } catch (e) {
                return null;
            }
        }).filter(Boolean).sort((a, b) => {
            // Folders first, then by date
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return b.createdAt - a.createdAt;
        });

        res.json(itemInfos);
    });
});

// Search files and folders globally
app.get('/api/search', requireAuth, (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    const ip = getClientIp(req);

    if (!query) return res.json([]);

    console.log(`${colors.cyan}🔍 SEARCHING:${colors.reset} "${query}" (IP: ${ip})`);

    const results = [];

    function searchDir(dirPath, relativePath = '') {
        try {
            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                if (dirPath === storageDir && (item === '.trash' || item === '.hidden')) continue; // Skip special dirs in search

                const fullPath = path.join(dirPath, item);
                const itemRelative = relativePath ? `${relativePath}/${item}` : item;

                try {
                    const stats = fs.statSync(fullPath);

                    if (item.toLowerCase().includes(query)) {
                        results.push({
                            name: item,
                            path: itemRelative,
                            size: stats.isDirectory() ? null : stats.size,
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
    const targetPath = getSafePath(req.body.path || '');

    if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
        console.log(`${colors.blue}📁 FOLDER CREATED:${colors.reset} ${targetPath}`);
        res.json({ message: 'Folder created successfully' });
    } else {
        res.status(400).json({ error: 'Folder already exists' });
    }
});

// Upload a file
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    console.log(`${colors.magenta}📦 FILE UPLOADED:${colors.reset} ${req.file.originalname}`);
    res.json({ message: 'File uploaded successfully', file: req.file });
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

// Delete a file or folder (Move to .trash or permanent delete)
app.delete('/api/files', requireAuth, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');
    const permanent = req.query.permanent === 'true';

    if (targetPath === storageDir) {
        return res.status(400).json({ error: 'Cannot delete root directory' });
    }

    if (fs.existsSync(targetPath)) {
        const stats = fs.statSync(targetPath);
        const itemName = path.basename(targetPath);

        // If it's already in .trash, or permanent flag is true
        if (targetPath.startsWith(trashDir) || permanent) {
            if (stats.isDirectory()) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(targetPath);
            }
            console.log(`${colors.red}🗑️  PERMANENTLY DELETED:${colors.reset} ${itemName}`);
            return res.json({ message: 'Deleted permanently' });
        } else {
            // Move to .trash
            const timestamp = Date.now();
            const trashPath = path.join(trashDir, `${itemName}_${timestamp}`);
            try {
                fs.renameSync(targetPath, trashPath);
                console.log(`${colors.yellow}♻️  MOVED TO TRASH:${colors.reset} ${itemName}`);
                return res.json({ message: 'Moved to Recycle Bin' });
            } catch (e) {
                return res.status(500).json({ error: 'Failed to move to trash' });
            }
        }
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// Empty Recycle Bin
app.delete('/api/trash/empty', requireAuth, (req, res) => {
    try {
        const items = fs.readdirSync(trashDir);
        for (const item of items) {
            const itemPath = path.join(trashDir, item);
            const stats = fs.statSync(itemPath);
            if (stats.isDirectory()) fs.rmSync(itemPath, { recursive: true, force: true });
            else fs.unlinkSync(itemPath);
        }
        console.log(`${colors.red}🗑️  EMPTIED RECYCLE BIN${colors.reset}`);
        res.json({ message: 'Trash emptied successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to empty trash' });
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
            totalMem,
            freeMem,
            usedMem,
            uptime
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get health info' });
    }
});

// Rename a file or folder
app.put('/api/rename', requireAuth, (req, res) => {
    const oldPath = getSafePath(req.body.oldPath || '');
    const newName = req.body.newName || '';

    if (!newName || !fs.existsSync(oldPath)) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }

    const newPath = path.join(path.dirname(oldPath), newName);

    // Prevent moving outside storageDir
    if (!newPath.startsWith(storageDir)) {
        return res.status(403).json({ error: 'Invalid new path' });
    }

    if (fs.existsSync(newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
        return res.status(400).json({ error: 'Name already exists' });
    }

    try {
        fs.renameSync(oldPath, newPath);
        console.log(`${colors.yellow}✏️  RENAMED:${colors.reset} ${path.basename(oldPath)} -> ${newName}`);
        res.json({ message: 'Renamed successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Rename failed' });
    }
});

// Move a file or folder
app.put('/api/move', requireAuth, (req, res) => {
    const oldPath = getSafePath(req.body.oldPath || '');
    const newParentPath = getSafePath(req.body.newParentPath || '');

    if (!fs.existsSync(oldPath)) {
        return res.status(400).json({ error: 'Source not found' });
    }

    if (!fs.existsSync(newParentPath) || !fs.statSync(newParentPath).isDirectory()) {
        return res.status(400).json({ error: 'Destination folder not found' });
    }

    const newPath = path.join(newParentPath, path.basename(oldPath));

    if (fs.existsSync(newPath)) {
        return res.status(400).json({ error: 'Destination already has an item with this name' });
    }

    try {
        fs.renameSync(oldPath, newPath);
        console.log(`${colors.blue}🚚 MOVED:${colors.reset} ${path.basename(oldPath)}`);
        res.json({ message: 'Moved successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Move failed' });
    }
});

// Stream a media file (video/audio/image)
app.get('/api/stream', requireAuthQuery, (req, res) => {
    const targetPath = getSafePath(req.query.path || '');

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        console.log(`${colors.cyan}▶️  STREAMING:${colors.reset} ${path.basename(targetPath)}`);
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

// Start the server
app.listen(PORT, '0.0.0.0', () => {
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
    ║   Home NAS System Initialized                ║
    ╚══════════════════════════════════════════════╝
    ` + colors.reset);
    console.log(`${colors.cyan}▶ Server Running:${colors.reset} http://0.0.0.0:${PORT}`);
    console.log(`${colors.dim}▶ Waiting for incoming connections...${colors.reset}\n`);
});
