require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const puppeteer = require('puppeteer');

// 🟢 DIAGNOSTIC 1: CHECK FFMPEG ON STARTUP
console.log("------------------------------------------------");
console.log("🔍 DIAGNOSTIC MODE: SERVER START");
if (ffmpegPath) {
    console.log(`✅ SUCCESS: FFmpeg found at: ${ffmpegPath}`);
    ffmpeg.setFfmpegPath(ffmpegPath);
} else {
    console.error("❌ CRITICAL FAILURE: FFmpeg binary is missing!");
}

// --- CONFIGURATION ---
const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const CHANNEL_ID = process.env.CHANNEL_ID ? process.env.CHANNEL_ID.trim() : ""; 
const MAX_SIZE_BYTES = 50 * 1024 * 1024; 

const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.aac', '.svg', '.glb', '.obj', '.fbx', '.gltf'];

// 🧠 SMART CATEGORY MAPPING (Added 3D support)
const CATEGORY_MAP = {
    'stockphoto': 'StockPhotos', 'stockphotos': 'StockPhotos', 'photo': 'StockPhotos',
    'video': 'Video', 'videos': 'Video',
    'music': 'Music', 'audio': 'Music',
    'sfx': 'SFX', 'soundfx': 'SFX',
    'greenscreen': 'GreenScreen', 'greenscreens': 'GreenScreen',
    'texture': 'Texture', 'textures': 'Texture',
    'gif': 'GIF', 'gifs': 'GIF',
    'illustration': 'Illustration', 'illustrations': 'Illustration',
    'background': 'Background', 'backgrounds': 'Background',
    'icon': 'Icon', 'icons': 'Icon',
    '3d': '3D', 'model': '3D', 'mesh': '3D' // 🟢 ADDED 3D MAPPING (Allows '3D' or '3d')
};

const VALID_CATEGORIES_DISPLAY = [...new Set(Object.values(CATEGORY_MAP))].join(', ');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const generateThumbnail = (videoPath, thumbPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: ['1.0'],
                filename: path.basename(thumbPath),
                folder: path.dirname(thumbPath),
                size: '640x360'
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });
};

const generateGLBThumbnail = async (glbBuffer, thumbPath) => {
    return new Promise(async (resolve, reject) => {
        let browser;
        try {
            // Spin up invisible Chrome
            browser = await puppeteer.launch({ 
    headless: "new", 
    args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-gpu',               // Tell Chrome we don't have a GPU
        '--disable-dev-shm-usage',     // Prevents memory crashes on Render
        '--use-gl=swiftshader',        // Force CPU to render 3D WebGL (Critical for Cloud)
        '--enable-webgl'
    ] 
});
            const page = await browser.newPage();
            await page.setViewport({ width: 500, height: 500 });

            // Convert GLB buffer to a Data URI so the browser can read it instantly
            const base64GLB = glbBuffer.toString('base64');
            const dataUri = `data:model/gltf-binary;base64,${base64GLB}`;

            // Create a mini webpage to render the 3D model
            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.3.0/model-viewer.min.js"></script>
                <style>body { margin: 0; background: #222; } model-viewer { width: 500px; height: 500px; }</style>
            </head>
            <body>
                <model-viewer src="${dataUri}" auto-rotate camera-controls exposure="1" environment-image="neutral" shadow-intensity="1"></model-viewer>
            </body>
            </html>
            `;

            await page.setContent(html);

            // Wait until the 3D model is fully loaded and visible on screen
            await page.waitForFunction(() => {
                const mv = document.querySelector('model-viewer');
                return mv && mv.modelIsVisible;
            }, { timeout: 45000 });

            // Wait 1 extra second for lighting/shadows to settle
            await new Promise(r => setTimeout(r, 1000));

            // Take the picture!
            await page.screenshot({ path: thumbPath, type: 'jpeg', quality: 90 });
            await browser.close();
            resolve();
        } catch (err) {
            if (browser) await browser.close();
            reject(err);
        }
    });
};

async function uploadToGithub(filename, buffer, releaseId) {
    try {
        const upload = await octokit.repos.uploadReleaseAsset({
            owner: OWNER, repo: REPO, release_id: releaseId, name: filename, data: buffer
        });
        return upload.data.browser_download_url;
    } catch (err) {
        if (err.response?.data?.errors?.[0]?.code === 'already_exists') {
            const ext = path.extname(filename);
            const name = path.basename(filename, ext);
            const tsName = `${name}_${Date.now()}${ext}`;
            const retry = await octokit.repos.uploadReleaseAsset({
                owner: OWNER, repo: REPO, release_id: releaseId, name: tsName, data: buffer
            });
            return retry.data.browser_download_url;
        }
        throw err;
    }
}

client.once('ready', () => {
    console.log(`🤖 Asset-Manager ONLINE as ${client.user.tag}`);
    console.log(`🎯 Watching Channel ID: '${CHANNEL_ID}'`);
    console.log("------------------------------------------------");
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.channel.id !== CHANNEL_ID) {
        return;
    }

    if (message.attachments.size > 0) {
        // 🟢 Track processed attachments so we don't upload a thumbnail twice
        const processedAttachments = new Set();

        for (const [key, attachment] of message.attachments) {
            
            // Skip if this file was already processed as a 3D thumbnail
            if (processedAttachments.has(key)) continue;

            // 1. SIZE CHECK
            if (attachment.size > MAX_SIZE_BYTES) {
                await message.reply(`⚠️ **File Too Big!** (${attachment.name})`);
                continue;
            }

            // 2. PARSE EXTENSION & NAME
            const rawExt = path.extname(attachment.name).toLowerCase();
            const nameWithoutExt = path.basename(attachment.name, rawExt);
            
            if (!ALLOWED_EXTS.includes(rawExt)) {
                await message.reply(`🚫 **Invalid File Extension:** \`${attachment.name}\``);
                continue;
            }

            // 3. REGEX CHECK (Allows hyphens and underscores)
            const namePattern = /^([a-zA-Z0-9]+)[ _]([a-zA-Z0-9-_]+)(?:[ _](.+))?$/;
            const match = nameWithoutExt.match(namePattern);

            if (!match) {
                await message.reply(`⚠️ **Naming Format Incorrect for:** \`${attachment.name}\`
**Correct:** \`Category Name.ext\` or \`Category_Name.ext\`
**Example:** \`3D_Laptop.glb\` or \`Texture Wood-Dark.jpg\``);
                continue;
            }

            let [fullMatch, rawPrefix, rawName, rawDesc] = match;
            
            // 4. CATEGORY CHECK
            const prefixKey = rawPrefix.toLowerCase();
            if (!CATEGORY_MAP[prefixKey]) {
                await message.reply(`🚫 **Unknown Category: "${rawPrefix}"**
Please start your filename with one of these: ${VALID_CATEGORIES_DISPLAY}`);
                continue;
            }

            // 5. SYMBOL CHECK
            const invalidChars = rawName.match(/[^a-zA-Z0-9\-\_]/g);
            if (invalidChars) {
                const uniqueBad = [...new Set(invalidChars)].join(', ');
                await message.reply(`❌ **Invalid Characters Detected**
Your filename contains restricted symbols: ${uniqueBad}
Please use only Letters, Numbers, Hyphens (-), or Underscores (_)`);
                continue;
            }

            // --- SETUP VARIABLES ---
            const internalCategory = CATEGORY_MAP[prefixKey];

            // 🟢 BLOCK NON-GLB 3D MODELS
            if (internalCategory === '3D' && rawExt !== '.glb') {
                await message.reply(`🚫 **Invalid 3D Format!**\nYou uploaded \`${attachment.name}\`.\nFor best performance in After Effects, we **only** accept **.glb** files for 3D models.\n\nPlease convert it and try again.`);
                continue;
            }

            const cleanName = rawName.trim();
            const cleanDesc = rawDesc ? rawDesc.replace(/\s+/g, '_').trim() : ""; 
            
            const baseFileName = cleanDesc 
                ? `${internalCategory}_${cleanName}_${cleanDesc}` 
                : `${internalCategory}_${cleanName}`;
            const mainFileName = `${baseFileName}${rawExt}`;
            const displayName = cleanName.replace(/_/g, ' ').replace(/-/g, '-');

            const statusMsg = await message.reply(`⏳ **Processing ${internalCategory}...**`);

            const tempDir = os.tmpdir();
            const tempFilePath = path.join(tempDir, `temp_${Date.now()}${rawExt}`); 
            const tempThumbPath = path.join(tempDir, `temp_thumb_${Date.now()}.jpg`);

            try {
                let release;
                try {
                    release = await octokit.repos.getReleaseByTag({ owner: OWNER, repo: REPO, tag: "storage" });
                } catch (e) {
                    release = await octokit.repos.createRelease({ owner: OWNER, repo: REPO, tag_name: "storage", name: "Asset Storage" });
                }

                // Download Main File to Buffer
                const fileResponse = await axios.get(attachment.url, { responseType: 'arraybuffer' });
                const mainBuffer = Buffer.from(fileResponse.data);
                
                await fs.writeFile(tempFilePath, mainBuffer);

                let mainDownloadUrl = "";
                let thumbDownloadUrl = "";
                const isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(rawExt);

                if (isVideo) {
                    console.log("🎥 Video detected. Running FFmpeg...");
                    try {
                        await generateThumbnail(tempFilePath, tempThumbPath);
                    } catch(err) {
                        console.error("❌ FFMPEG ERROR:", err);
                        await statusMsg.edit(`❌ Thumbnail Error: ${err.message}`);
                        return;
                    }
                    const thumbBuffer = await fs.readFile(tempThumbPath);
                    mainDownloadUrl = await uploadToGithub(mainFileName, mainBuffer, release.data.id);
                    thumbDownloadUrl = await uploadToGithub(`${baseFileName}_thumb.jpg`, thumbBuffer, release.data.id);
                } 
                // 🟢 NEW: AUTO-GENERATE 3D THUMBNAIL
                else if (rawExt === '.glb') {
                    console.log("🧊 3D Model detected. Auto-rendering thumbnail in headless browser...");
                    try {
                        // We pass the buffer directly to avoid disk read/write issues
                        await generateGLBThumbnail(mainBuffer, tempThumbPath);
                    } catch(err) {
                        console.error("❌ 3D RENDER ERROR:", err);
                        await statusMsg.edit(`❌ 3D Thumbnail Render Error: ${err.message}`);
                        return;
                    }

                    const thumbBuffer = await fs.readFile(tempThumbPath);
                    
                    // Upload both the GLB and the new auto-generated image to GitHub
                    mainDownloadUrl = await uploadToGithub(mainFileName, mainBuffer, release.data.id);
                    thumbDownloadUrl = await uploadToGithub(`${baseFileName}_thumb.jpg`, thumbBuffer, release.data.id);
                } 
                // STANDARD FILES (Images, Audio, etc)
                else {
                    mainDownloadUrl = await uploadToGithub(mainFileName, mainBuffer, release.data.id);
                    if (['.png','.jpg','.jpeg'].includes(rawExt)) thumbDownloadUrl = mainDownloadUrl;
                }

                // Update JSON
                let currentData = [];
                let sha = null;
                try {
                    const fileData = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: "assets.json" });
                    currentData = JSON.parse(Buffer.from(fileData.data.content, 'base64').toString());
                    sha = fileData.data.sha;
                } catch (e) { }

                const newEntry = {
                    id: mainFileName, 
                    name: displayName, 
                    category: internalCategory, 
                    description: cleanDesc, 
                    download_url: mainDownloadUrl, 
                    thumb: thumbDownloadUrl, 
                    source: message.author.username, 
                    date: new Date().toISOString()
                };
                currentData.unshift(newEntry);

                await octokit.repos.createOrUpdateFileContents({
                    owner: OWNER, repo: REPO, path: "assets.json", message: `Add ${mainFileName}`,
                    content: Buffer.from(JSON.stringify(currentData, null, 2)).toString('base64'),
                    sha: sha, committer: { name: "BridgeBot", email: "bot@assetstation.com" }
                });

                await statusMsg.edit(`✅ **Asset Archived!**
📂 **Category:** ${internalCategory}
🏷️ **Name:** ${displayName}`);

            } catch (error) {
                console.error("UPLOAD ERROR:", error);
                await statusMsg.edit(`❌ Error: ${error.message}`);
            } finally {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                if (fs.existsSync(tempThumbPath)) fs.unlinkSync(tempThumbPath);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
const http = require('http');
http.createServer((req, res) => res.end("Alive")).listen(process.env.PORT || 3000);