// index.js
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parseVpnGateHtml } = require('./parser');

const today = new Date().toISOString().split('T')[0];

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const todayJsonFile = path.join(dataDir, `${today}.json`);
const dbFile = path.join(dataDir, "db.json");
const filesInfoFile = path.join(dataDir, "files.json");

const primaryUrl = process.env.VPNGATE_URL || 'https://www.vpngate.net/en/';
const mirrorUrls = (process.env.VPNGATE_MIRRORS ? process.env.VPNGATE_MIRRORS.split(',') : [])
    .map(u => u.trim())
    .filter(Boolean);
const candidateUrls = Array.from(new Set([primaryUrl, ...mirrorUrls]));

const userAgent = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS || '45000', 10);
const testHtmlPath = process.env.TEST_HTML_PATH;

/**
 * Fetches VPNGate HTML from local test file (if specified) or network URLs with failover.
 */
async function fetchHtml() {
    if (testHtmlPath) {
        const fullTestPath = path.isAbsolute(testHtmlPath) ? testHtmlPath : path.resolve(process.cwd(), testHtmlPath);
        if (fs.existsSync(fullTestPath)) {
            console.info(`Using local test HTML file: ${fullTestPath}`);
            return fs.readFileSync(fullTestPath, 'utf-8');
        } else {
            console.warn(`TEST_HTML_PATH specified but not found at ${fullTestPath}, falling back to network.`);
        }
    }

    for (const targetUrl of candidateUrls) {
        try {
            console.info(`Fetching VPNGate HTML from: ${targetUrl}`);
            const response = await axios.get(targetUrl, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                },
                timeout: requestTimeoutMs,
                responseType: 'text',
                maxRedirects: 5,
            });

            if (response.status === 200 && response.data && typeof response.data === 'string' && response.data.includes('vg_hosts_table_id')) {
                console.info(`Successfully fetched ${response.data.length} bytes from ${targetUrl}`);
                return response.data;
            } else {
                console.warn(`Response from ${targetUrl} (HTTP ${response.status}) did not contain expected table.`);
            }
        } catch (err) {
            console.warn(`Failed to fetch from ${targetUrl}: ${err.message}`);
        }
    }

    throw new Error('All VPNGate targets failed to return valid HTML.');
}

/**
 * Saves JSON array to specified file.
 */
function saveDataToJson(data, filePath) {
    console.info(`Saving data (${data.length} entries) to file: ${filePath}`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf-8');
}

/**
 * Updates db.json with unique IP:Port keys.
 */
function updateDb(ipPortList, dbFilePath) {
    let existingData = [];
    if (fs.existsSync(dbFilePath)) {
        try {
            const content = fs.readFileSync(dbFilePath, 'utf-8').trim();
            if (content) {
                existingData = JSON.parse(content);
                if (!Array.isArray(existingData)) {
                    existingData = [];
                }
            }
        } catch (err) {
            console.warn(`Error reading ${dbFilePath}: ${err.message}, resetting.`);
            existingData = [];
        }
    }

    const updatedData = Array.from(new Set([...existingData, ...ipPortList]));
    console.info(`Updated db.json with ${updatedData.length} unique entries (removed duplicates).`);
    fs.writeFileSync(dbFilePath, JSON.stringify(updatedData, null, 0), 'utf-8');
}

/**
 * Updates files.json metadata overview of all daily JSON files.
 */
function updateFilesInfo(directory, filesInfoFilePath) {
    console.info(`Updating files info in ${filesInfoFilePath}`);
    const fileData = [];

    fs.readdirSync(directory).forEach(fileName => {
        if (fileName.endsWith(".json") && fileName !== "db.json" && fileName !== "files.json") {
            const filePath = path.join(directory, fileName);
            try {
                const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                const uniqueIps = Array.isArray(fileContent) ? new Set(fileContent.map(entry => entry.key)).size : 0;
                const byteSize = fs.statSync(filePath).size;
                const creationTime = fs.statSync(filePath).ctimeMs;

                fileData.push({
                    name: fileName,
                    sstpCount: uniqueIps,
                    byteSize,
                    creationTime
                });
            } catch (err) {
                console.warn(`Skipping unparseable JSON file ${fileName}: ${err.message}`);
            }
        }
    });

    fileData.sort((a, b) => a.creationTime - b.creationTime);
    fileData.forEach(entry => delete entry.creationTime);

    fs.writeFileSync(filesInfoFilePath, JSON.stringify(fileData, null, 0), 'utf-8');
    console.info(`files.json updated with ${fileData.length} entries.`);
}

(async function main() {
    try {
        const html = await fetchHtml();
        const parsedData = parseVpnGateHtml(html);
        console.info(`Parsed ${parsedData.length} VPN relay servers from VPNGate HTML.`);

        if (parsedData.length === 0) {
            console.error('No servers were parsed from HTML. Aborting file updates.');
            return;
        }

        saveDataToJson(parsedData, todayJsonFile);

        const ipPortList = parsedData.map(entry => entry.key);
        updateDb(ipPortList, dbFile);

        updateFilesInfo(dataDir, filesInfoFile);
        console.info('VPNGate processing completed successfully.');
    } catch (err) {
        console.error(`Fatal error in VPNGate processing: ${err.message}`);
        process.exitCode = 1;
    }
})();
