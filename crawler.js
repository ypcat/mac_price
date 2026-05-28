const https = require('https');
const url = require('url');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const urls = {
    'MacBook Air': "https://www.apple.com/tw/shop/buy-mac/macbook-air",
    'MacBook Pro': "https://www.apple.com/tw/shop/buy-mac/macbook-pro",
    'iMac': "https://www.apple.com/tw/shop/buy-mac/imac",
    'Mac mini': "https://www.apple.com/tw/shop/buy-mac/mac-mini",
    'Mac Studio': "https://www.apple.com/tw/shop/buy-mac/mac-studio"
};

// Sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to fetch url with redirect following and timeout
function fetchWithRedirect(target, headers = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(target);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...headers
            }
        };

        let isSettled = false;

        const req = https.get(options, (res) => {
            if (isSettled) return;
            
            if (res.statusCode === 301 || res.statusCode === 302) {
                let redirectUrl = res.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    redirectUrl = `https://${parsedUrl.hostname}${redirectUrl}`;
                }
                resolve(fetchWithRedirect(redirectUrl, headers, timeoutMs));
                isSettled = true;
            } else if (res.statusCode === 200) {
                let html = '';
                res.on('data', (chunk) => { html += chunk; });
                res.on('end', () => {
                    resolve({ html, finalUrl: target });
                    isSettled = true;
                });
            } else {
                reject(new Error(`Failed with status: ${res.statusCode}`));
                isSettled = true;
            }
        });

        req.on('error', (err) => {
            if (isSettled) return;
            reject(err);
            isSettled = true;
        });

        // Set timeout
        req.setTimeout(timeoutMs, () => {
            if (isSettled) return;
            req.destroy();
            reject(new Error(`Request timed out after ${timeoutMs}ms`));
            isSettled = true;
        });
    });
}

// Fetch all retail part numbers for a buy page
async function getPartNumbers(name, targetUrl) {
    console.log(`[CRAWL] Fetching retail models for ${name}...`);
    try {
        const { html } = await fetchWithRedirect(targetUrl);
        const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        
        while ((match = scriptRegex.exec(html)) !== null) {
            const scriptContent = match[1];
            if (scriptContent.includes('window.PRODUCT_SELECTION_BOOTSTRAP')) {
                const sandbox = { window: {} };
                vm.createContext(sandbox);
                vm.runInContext(scriptContent, sandbox);
                const bootstrap = sandbox.window.PRODUCT_SELECTION_BOOTSTRAP;
                if (bootstrap && bootstrap.productSelectionData) {
                    const parts = [];
                    for (const prod of Object.values(bootstrap.productSelectionData.products)) {
                        if (prod.btrOrFdPartNumber) {
                            parts.push(prod.btrOrFdPartNumber);
                        }
                    }
                    console.log(`[SUCCESS] ${name}: Found ${parts.length} retail models`);
                    return parts;
                }
            }
        }
    } catch (e) {
        console.error(`[ERROR] Failed to fetch part numbers for ${name}:`, e.message);
    }
    return [];
}

// Parse PDP page html into exact specs
function parsePdp(name, part, html, finalUrl) {
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    let chip = "未知";
    let cpu = "未知";
    let gpu = "未知";
    let ram = "未知";
    let ssd = "未知";
    let display = "無 (外接)";
    let color = "未知";

    // Chip: M4, M5 Pro, M5 Max, M3 Ultra etc.
    const chipMatch = title.match(/([M\d]+(?:\s*(?:Pro|Max|Ultra))?)\s*晶片/i);
    if (chipMatch) chip = chipMatch[1].replace(/\u00a0/g, ' ').trim();

    // CPU Cores
    const cpuMatch = title.match(/(\d+)\s*核心\s*CPU/i);
    if (cpuMatch) cpu = `${cpuMatch[1]} 核心`;

    // GPU Cores
    const gpuMatch = title.match(/(\d+)\s*核心\s*GPU/i);
    if (gpuMatch) gpu = `${gpuMatch[1]} 核心`;

    // RAM
    const ramMatch = title.match(/(\d+GB)\s*(?:記憶體|統一記憶體)/i);
    if (ramMatch) ram = ramMatch[1];

    // SSD
    const ssdMatch = title.match(/(\d+(?:GB|TB))\s*(?:儲存裝置|SSD)/i);
    if (ssdMatch) ssd = ssdMatch[1];

    // Display: matching 13 吋, 14 吋, 15 吋, 16 吋, 24-吋
    const displayMatch = title.match(/(\d+(?:\.\d+)?)\s*[-－—]?\s*吋/i);
    if (displayMatch) {
        display = `${displayMatch[1]} 吋`;
    }

    // Color
    const colorWords = ["星光色", "午夜色", "銀色", "天藍色", "太空黑色", "綠色", "粉紅色", "藍色", "橙色", "紫色", "黃色"];
    for (const word of colorWords) {
        if (title.includes(word)) {
            color = word;
            break;
        }
    }

    // Parse Price
    let price = null;
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(ldMatch[1]);
            if (parsed['@type'] === 'Product' || parsed['@type'] === 'AggregateOffer') {
                if (parsed.offers) {
                    const offer = Array.isArray(parsed.offers) ? parsed.offers[0] : parsed.offers;
                    price = parseFloat(offer.price);
                }
            }
        } catch (e) {}
    }

    // Numeric RAM in GB
    let ramGb = 16;
    if (ram && ram.includes("GB")) {
        ramGb = parseInt(ram.replace("GB", ""));
    }

    // Calculate Price / GB RAM
    const pricePerGbRam = price ? parseFloat((price / ramGb).toFixed(2)) : null;

    return {
        sku: part,
        name,
        chip,
        cpu,
        gpu,
        ram,
        ram_gb: ramGb,
        ssd,
        display,
        color,
        price: price,
        price_per_gb_ram: pricePerGbRam,
        shipTime: "有現貨 (通常於 1 個工作天出貨)",
        store_url: finalUrl
    };
}

// Fetch shipping range from SBA API
async function fetchShippingRange(sku) {
    try {
        const url = `https://www.apple.com/tw/shop/sba/availability-message?parts.0=${encodeURIComponent(sku)}`;
        const { html } = await fetchWithRedirect(url, {}, 5000);
        const parsed = JSON.parse(html);
        if (parsed.body && parsed.body.content && parsed.body.content.length > 0) {
            const content = parsed.body.content[0];
            if (content.deliveryMessage && content.deliveryMessage.deliveryOptions && content.deliveryMessage.deliveryOptions.length > 0) {
                return content.deliveryMessage.deliveryOptions[0].date;
            }
        }
    } catch (e) {
        console.error(`[ERROR] Failed to fetch shipping range for SKU ${sku}:`, e.message);
    }
    return null;
}

// Calculate ship time from SBA date range
function calculateShipTime(dateRange, isBto, ramGb) {
    if (!dateRange) {
        return isBto ? "通常於 3 - 5 個工作天出貨 (客製化配置)" : "有現貨 (通常於 1 個工作天出貨)";
    }
    if (dateRange.includes("今天") || dateRange.includes("明天") || dateRange.includes("1 個工作天")) {
        return "有現貨 (通常於 1 個工作天出貨)";
    }
    
    const dates = dateRange.split(/[–\-至~]/);
    if (dates.length < 2) return `通常於 ${dateRange} 出貨`;
    
    const d1 = new Date(dates[0].trim());
    const d2 = new Date(dates[1].trim());
    
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
        return `通常於 ${dateRange} 出貨`;
    }
    
    const today = new Date();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    let w1 = Math.round((d1 - today) / oneWeekMs);
    let w2 = Math.round((d2 - today) / oneWeekMs);
    
    if (w1 <= 0 && w2 <= 1) {
        return "有現貨 (通常於 1 - 3 個工作天出貨)";
    }
    
    // Add smart scaling buffer for highly constrained memory configurations (e.g. 48GB RAM or above)
    if (isBto && ramGb >= 48) {
        w1 = Math.max(w1 + 5, 8);
        w2 = Math.max(w2 + 6, 10);
    }
    
    if (w1 === w2) {
        return `通常於 ${w1} 星期內出貨${isBto ? " (客製化配置)" : ""}`;
    }
    
    return `通常於 ${w1} - ${w2} 星期內出貨${isBto ? " (客製化配置)" : ""}`;
}

// Helper to parse price from HTML schema ld+json
function parsePriceFromHtml(html) {
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(ldMatch[1]);
            if (parsed['@type'] === 'Product' || parsed['@type'] === 'AggregateOffer') {
                if (parsed.offers) {
                    const offer = Array.isArray(parsed.offers) ? parsed.offers[0] : parsed.offers;
                    if (offer.price) return parseFloat(offer.price);
                }
            }
        } catch (e) {}
    }
    return null;
}

// Helper to parse SKU from HTML schema ld+json
function parseSkuFromHtml(html) {
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(ldMatch[1]);
            if (parsed['@type'] === 'Product' || parsed['@type'] === 'AggregateOffer') {
                if (parsed.offers) {
                    const offer = Array.isArray(parsed.offers) ? parsed.offers[0] : parsed.offers;
                    if (offer.sku) {
                        const fullSku = offer.sku;
                        const baseBtoSku = fullSku.split('+')[0];
                        return { fullSku, baseBtoSku };
                    }
                }
            }
        } catch (e) {}
    }
    return null;
}

function getBtoOptions(chip, cpu, gpu, baseRamGb) {
    const chipLower = chip.toLowerCase();
    const options = [];
    
    // Default base option
    options.push({ ramGb: baseRamGb, ramText: `${baseRamGb}GB` });
    
    if (chipLower.includes('ultra')) {
        if (baseRamGb === 96) {
            options.push({ ramGb: 192, ramText: "192GB" });
        } else if (baseRamGb === 64) {
            options.push({ ramGb: 128, ramText: "128GB" });
            options.push({ ramGb: 192, ramText: "192GB" });
        }
    } else if (chipLower.includes('max')) {
        if (baseRamGb === 36) {
            options.push({ ramGb: 64, ramText: "64GB" });
            options.push({ ramGb: 96, ramText: "96GB" });
            options.push({ ramGb: 128, ramText: "128GB" });
        } else if (baseRamGb === 48) {
            options.push({ ramGb: 64, ramText: "64GB" });
            options.push({ ramGb: 96, ramText: "96GB" });
            options.push({ ramGb: 128, ramText: "128GB" });
        }
    } else if (chipLower.includes('pro')) {
        if (baseRamGb === 24) {
            options.push({ ramGb: 48, ramText: "48GB" });
        }
    } else {
        if (baseRamGb === 16) {
            options.push({ ramGb: 24, ramText: "24GB" });
            options.push({ ramGb: 32, ramText: "32GB" });
        } else if (baseRamGb === 8) {
            options.push({ ramGb: 16, ramText: "16GB" });
            options.push({ ramGb: 24, ramText: "24GB" });
        }
    }
    
    return options;
}

async function processConfigs(configs) {
    const grouped = {};
    
    for (const item of configs) {
        const key = `${item.name}|${item.chip}|${item.cpu}|${item.gpu}|${item.ssd}|${item.display}`;
        if (!grouped[key]) {
            grouped[key] = {
                name: item.name,
                chip: item.chip,
                cpu: item.cpu,
                gpu: item.gpu,
                ram_gb: item.ram_gb,
                ram: item.ram,
                ssd: item.ssd,
                display: item.display,
                basePrice: item.price,
                shipTime: item.shipTime,
                colors: new Set(),
                skus: new Set(),
                store_url: item.store_url
            };
        }
        if (item.color && item.color !== '未知') {
            grouped[key].colors.add(item.color);
        }
        if (item.sku) {
            grouped[key].skus.add(item.sku);
        }
    }
    
    const expandedList = [];
    
    for (const item of Object.values(grouped)) {
        const colorsList = Array.from(item.colors)[0] || '標準色';
        const skusList = Array.from(item.skus).join(', ');
        
        const btoOptions = getBtoOptions(item.chip, item.cpu, item.gpu, item.ram_gb);
        
        for (const opt of btoOptions) {
            const ramGb = opt.ramGb;
            const ramText = opt.ramText;
            const isBto = ramGb !== item.ram_gb;
            
            if (!isBto) {
                // Retail configuration - already has dynamically parsed price and shipTime from PDP crawl!
                const pricePerGbRam = parseFloat((item.basePrice / ramGb).toFixed(2));
                expandedList.push({
                    sku: skusList,
                    name: item.name,
                    chip: item.chip,
                    cpu: item.cpu,
                    gpu: item.gpu,
                    ram: ramText,
                    ram_gb: ramGb,
                    ssd: item.ssd,
                    display: item.display,
                    color: colorsList || '標準色',
                    price: item.basePrice,
                    price_per_gb_ram: pricePerGbRam,
                    shipTime: item.shipTime || "有現貨 (通常於 1 個工作天出貨)",
                    store_url: item.store_url
                });
            } else {
                // BTO configured model
                // Construct BTO URL by replacing standard RAM capacity with upgrade RAM capacity
                let btoUrl = item.store_url;
                const regex = new RegExp(item.ram, 'i');
                btoUrl = item.store_url.replace(regex, ramText.toLowerCase());
                
                let targetCpu = item.cpu;
                let targetGpu = item.gpu;
                
                // Special CPU/GPU upgrades for high-memory configurations of Max chips
                if (item.chip.toLowerCase().includes('max') && item.ram_gb === 36) {
                    if (ramGb === 64 || ramGb === 128) {
                        if (item.name === 'MacBook Pro') {
                            btoUrl = btoUrl.replace("32-%E6%A0%B8%E5%BF%83-gpu", "40-%E6%A0%B8%E5%BF%83-gpu");
                            targetGpu = "40 核心";
                        } else if (item.name === 'Mac Studio') {
                            btoUrl = btoUrl.replace("14-%E6%A0%B8%E5%BF%83-cpu", "16-%E6%A0%B8%E5%BF%83-cpu");
                            btoUrl = btoUrl.replace("32-%E6%A0%B8%E5%BF%83-gpu", "40-%E6%A0%B8%E5%BF%83-gpu");
                            targetCpu = "16 核心";
                            targetGpu = "40 核心";
                        }
                    }
                }
                
                console.log(`[VERIFY] Validating BTO configuration URL: ${item.name} (${item.chip}, ${ramText})...`);
                
                try {
                    await sleep(300); // Throttle slightly
                    const { html, finalUrl } = await fetchWithRedirect(btoUrl, {}, 8000);
                    
                    // Parse exact price directly from ld+json
                    const btoPrice = parsePriceFromHtml(html);
                    if (!btoPrice) {
                        console.log(`[EXCLUDE] Excluded BTO (No Price parsed): ${item.name} (${item.chip}, ${ramText})`);
                        continue;
                    }
                    
                    // Parse SKU and BTO base SKU from BTO page HTML
                    const btoSkuInfo = parseSkuFromHtml(html);
                    let shipTime = "通常於 3 - 5 個工作天出貨 (客製化配置)";
                    if (btoSkuInfo && btoSkuInfo.baseBtoSku) {
                        console.log(`[VERIFY] Fetching BTO shipping date for base BTO SKU: ${btoSkuInfo.baseBtoSku}...`);
                        await sleep(200);
                        const sbaRange = await fetchShippingRange(btoSkuInfo.baseBtoSku);
                        shipTime = calculateShipTime(sbaRange, true, ramGb);
                    }
                    
                    console.log(`[INCLUDE] Verified BTO (Price NT$${btoPrice}, Ship: ${shipTime}): ${item.name} (${item.chip}, ${ramText})`);
                    const pricePerGbRam = parseFloat((btoPrice / ramGb).toFixed(2));
                    
                    expandedList.push({
                        sku: `${skusList.split(', ')[0] || 'CTO'}/BTO-${ramText}`,
                        name: item.name,
                        chip: item.chip,
                        cpu: targetCpu,
                        gpu: targetGpu,
                        ram: ramText,
                        ram_gb: ramGb,
                        ssd: item.ssd,
                        display: item.display,
                        color: colorsList || '標準色',
                        price: btoPrice,
                        price_per_gb_ram: pricePerGbRam,
                        shipTime: shipTime,
                        store_url: btoUrl
                    });
                    
                } catch (err) {
                    console.log(`[EXCLUDE] Excluded BTO configuration (Error ${err.message}): ${item.name} (${item.chip}, ${ramText})`);
                    continue;
                }
            }
        }
    }
    
    // Deduplicate the expanded configs list to merge identical specs
    const dedupedList = [];
    const seen = new Set();
    
    for (const item of expandedList) {
        const key = `${item.name}|${item.chip}|${item.cpu}|${item.gpu}|${item.ram_gb}|${item.ssd}|${item.display}|${item.price}`;
        if (!seen.has(key)) {
            seen.add(key);
            dedupedList.push(item);
        } else {
            const existing = dedupedList.find(x => 
                x.name === item.name &&
                x.chip === item.chip &&
                x.cpu === item.cpu &&
                x.gpu === item.gpu &&
                x.ram_gb === item.ram_gb &&
                x.ssd === item.ssd &&
                x.display === item.display &&
                x.price === item.price
            );
            if (existing) {
                const existingSkus = existing.sku.split(', ');
                const newSkus = item.sku.split(', ');
                const combined = Array.from(new Set([...existingSkus, ...newSkus])).join(', ');
                existing.sku = combined;
            }
        }
    }
    
    return dedupedList;
}

// Generate premium index.html dashboard
function generateHtml(configs) {
    try {
        const templatePath = path.join(__dirname, "index_template.html");
        let htmlContent = fs.readFileSync(templatePath, 'utf8');
        
        // Replace placeholders
        const dateStr = new Date().toLocaleString('zh-TW');
        htmlContent = htmlContent.replace('/* DATE_PLACEHOLDER */', `"${dateStr}"`);
        htmlContent = htmlContent.replace('/* DATA_PLACEHOLDER */', JSON.stringify(configs, null, 2));
        
        const outputPath = path.join(__dirname, "index.html");
        fs.writeFileSync(outputPath, htmlContent, 'utf8');
        console.log(`[SUCCESS] Generated sorting HTML dashboard page at: ${outputPath}`);
    } catch (err) {
        console.error(`[ERROR] Failed to generate HTML:`, err.message);
    }
}

async function run() {
    const allConfigs = [];
    
    // Fetch and scrape
    for (const [name, buyUrl] of Object.entries(urls)) {
        let parts = [];
        try {
            parts = await getPartNumbers(name, buyUrl);
        } catch (err) {
            console.error(`[ERROR] Failed to collect part numbers for ${name}:`, err.message);
            continue;
        }
        
        // Loop standard parts
        for (const part of parts) {
            try {
                // Throttle requests slightly
                await sleep(500);
                
                const pdpUrl = `https://www.apple.com/tw/shop/product/${part}`;
                console.log(`[CRAWL] Scrape product specifications for: ${part}...`);
                
                // Wrap in a try-catch with timeout to ensure individual SKU failure doesn't halt execution
                const { html, finalUrl } = await fetchWithRedirect(pdpUrl, {}, 8000);
                const parsed = parsePdp(name, part, html, finalUrl);
                
                if (parsed.price) {
                    // Fetch real-time shipping dynamically for retail models
                    await sleep(200);
                    const sbaRange = await fetchShippingRange(part);
                    parsed.shipTime = calculateShipTime(sbaRange, false, parsed.ram_gb);
                    
                    console.log(`[PARSED] ${parsed.name} (${parsed.chip}, ${parsed.ram}/${parsed.ssd}): NT$${parsed.price}, Ship: ${parsed.shipTime}`);
                    allConfigs.push(parsed);
                } else {
                    console.warn(`[WARN] No pricing found for SKU: ${part}`);
                }
            } catch (err) {
                console.error(`[ERROR] Failed scraping PDP for SKU: ${part}:`, err.message);
            }
        }
    }

    console.log(`[SUCCESS] Crawled a total of ${allConfigs.length} retail configurations!`);
    
    // Process, expand BTO and programmatically verify each URL
    const processedConfigs = await processConfigs(allConfigs);
    console.log(`[SUCCESS] Verified and expanded into ${processedConfigs.length} configurations!`);
    
    // Save to JSON
    const jsonPath = path.join(__dirname, "mac_configs.json");
    fs.writeFileSync(jsonPath, JSON.stringify(processedConfigs, null, 2), 'utf8');
    console.log(`[SUCCESS] Saved configs JSON file to: ${jsonPath}`);
    
    // Generate dashboard index.html
    generateHtml(processedConfigs);
}

run();
