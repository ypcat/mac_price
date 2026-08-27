const https = require('https');
const zlib = require('zlib');
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

// Number of simultaneous in-flight requests to apple.com
const CONCURRENCY = parseInt(process.env.CRAWLER_CONCURRENCY || '8', 10);

// Run fn over items with at most `limit` promises in flight at once
async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

// Helper to fetch url with redirect following and timeout
function fetchWithRedirect(target, headers = {}, timeoutMs = 15000, redirects = 0) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(target);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Encoding': 'gzip, deflate',
                ...headers
            }
        };

        let isSettled = false;

        const req = https.get(options, (res) => {
            if (isSettled) return;

            if (res.statusCode === 301 || res.statusCode === 302) {
                isSettled = true;
                res.resume();
                if (redirects >= 5) {
                    reject(new Error('Too many redirects'));
                    return;
                }
                let redirectUrl = res.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    redirectUrl = `https://${parsedUrl.hostname}${redirectUrl}`;
                }
                resolve(fetchWithRedirect(redirectUrl, headers, timeoutMs, redirects + 1));
            } else if (res.statusCode === 200) {
                const enc = (res.headers['content-encoding'] || '').toLowerCase();
                const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
                    : enc === 'deflate' ? res.pipe(zlib.createInflate())
                    : res;
                const chunks = [];
                stream.on('data', (chunk) => { chunks.push(chunk); });
                stream.on('error', (err) => {
                    if (isSettled) return;
                    isSettled = true;
                    reject(err);
                });
                stream.on('end', () => {
                    if (isSettled) return;
                    isSettled = true;
                    resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: target, redirected: redirects > 0 });
                });
            } else {
                isSettled = true;
                res.resume();
                reject(new Error(`Failed with status: ${res.statusCode}`));
            }
        });

        req.on('error', (err) => {
            if (isSettled) return;
            isSettled = true;
            reject(err);
        });

        // Set timeout
        req.setTimeout(timeoutMs, () => {
            if (isSettled) return;
            isSettled = true;
            req.destroy();
            reject(new Error(`Request timed out after ${timeoutMs}ms`));
        });
    });
}

// Pull window.PRODUCT_SELECTION_BOOTSTRAP out of a buy page
function parseSelectionBootstrap(html) {
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
        const scriptContent = match[1];
        if (scriptContent.includes('window.PRODUCT_SELECTION_BOOTSTRAP')) {
            const sandbox = { window: {} };
            vm.createContext(sandbox);
            vm.runInContext(scriptContent, sandbox);
            const bootstrap = sandbox.window.PRODUCT_SELECTION_BOOTSTRAP;
            if (bootstrap && bootstrap.productSelectionData) return bootstrap.productSelectionData;
        }
    }
    return null;
}

// Fetch retail part numbers plus the live BTO option lists Apple publishes for a family
async function getFamilyCatalog(name, targetUrl) {
    console.log(`[CRAWL] Fetching retail models and BTO options for ${name}...`);
    try {
        const { html } = await fetchWithRedirect(targetUrl);
        const data = parseSelectionBootstrap(html);
        if (!data) throw new Error('PRODUCT_SELECTION_BOOTSTRAP not found');

        const parts = [];
        for (const prod of Object.values(data.products || {})) {
            if (prod.btrOrFdPartNumber) parts.push(prod.btrOrFdPartNumber);
        }

        // Every memory capacity Apple lists for this family (union across chips)
        const memoryDim = (data.configDisplayValues || {})['memory-dimensionMemory'] || {};
        const memoryOptions = (memoryDim.variantOrder || [])
            .map((v) => ({ key: v, gb: parseInt(v, 10) }))
            .filter((v) => !isNaN(v.gb));

        // Every chip / CPU-core / GPU-core combination Apple lists for this family
        const procDim = (data.mainDisplayValues || {})['processor-dimensionChip-cpuCoreCount-gpuCoreCount'] || {};
        const processorOptions = [];
        for (const [key, val] of Object.entries(procDim)) {
            if (key === 'variantOrder' || !val || !val.dimensionComponents) continue;
            const dc = val.dimensionComponents;
            processorOptions.push({
                chipKey: dc.dimensionChip,
                cpu: parseInt(dc.cpuCoreCount, 10),
                gpu: parseInt(dc.gpuCoreCount, 10)
            });
        }

        console.log(`[SUCCESS] ${name}: ${parts.length} retail models, ` +
            `memory ${memoryOptions.map((m) => m.key).join('/')}, ` +
            `processors ${processorOptions.map((p) => `${p.cpu}c/${p.gpu}g`).join(', ')}`);
        return { parts, memoryOptions, processorOptions };
    } catch (e) {
        console.error(`[ERROR] Failed to fetch catalog for ${name}:`, e.message);
        return { parts: [], memoryOptions: [], processorOptions: [] };
    }
}

// Parse the specs Apple states in the page <title> — authoritative for whatever config actually loaded
function parseSpecsFromTitle(html) {
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = (titleMatch ? titleMatch[1] : '').replace(/\u00a0/g, ' ').trim();

    const specs = {
        chip: "未知",
        cpu: "未知",
        gpu: "未知",
        ram: "未知",
        ssd: "未知",
        display: "無 (外接)",
        color: "未知"
    };

    // Chip: M4, M5 Pro, M5 Max, M3 Ultra etc.
    const chipMatch = title.match(/([M\d]+(?:\s*(?:Pro|Max|Ultra))?)\s*晶片/i);
    if (chipMatch) specs.chip = chipMatch[1].trim();

    const cpuMatch = title.match(/(\d+)\s*核心\s*CPU/i);
    if (cpuMatch) specs.cpu = `${cpuMatch[1]} 核心`;

    const gpuMatch = title.match(/(\d+)\s*核心\s*GPU/i);
    if (gpuMatch) specs.gpu = `${gpuMatch[1]} 核心`;

    const ramMatch = title.match(/(\d+GB)\s*(?:記憶體|統一記憶體)/i);
    if (ramMatch) specs.ram = ramMatch[1];

    const ssdMatch = title.match(/(\d+(?:GB|TB))\s*(?:儲存裝置|SSD)/i);
    if (ssdMatch) specs.ssd = ssdMatch[1];

    // Display: matching 13 吋, 14 吋, 15 吋, 16 吋, 24-吋
    const displayMatch = title.match(/(\d+(?:\.\d+)?)\s*[-－—]?\s*吋/i);
    if (displayMatch) specs.display = `${displayMatch[1]} 吋`;

    const colorWords = ["星光色", "午夜色", "銀色", "天藍色", "太空黑色", "綠色", "粉紅色", "藍色", "橙色", "紫色", "黃色"];
    for (const word of colorWords) {
        if (title.includes(word)) { specs.color = word; break; }
    }

    return specs;
}

// Parse PDP page html into exact specs
function parsePdp(name, part, html, finalUrl) {
    const specs = parseSpecsFromTitle(html);
    const price = parsePriceFromHtml(html);

    let ramGb = 16;
    if (specs.ram && specs.ram.includes("GB")) {
        ramGb = parseInt(specs.ram.replace("GB", ""));
    }

    const pricePerGbRam = price ? parseFloat((price / ramGb).toFixed(2)) : null;

    return {
        sku: part,
        name,
        ...specs,
        ram_gb: ramGb,
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
        const { html } = await fetchWithRedirect(url, {}, 10000);
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

const MEMORY_SLUG_RE = /(\d+)(gb|tb)-記憶體/i;
const CORES_SLUG_RE = /(\d+)-核心-cpu-(\d+)-核心-gpu/i;

// Rewrite a known-good configuration URL into a different memory / core-count combination
function buildConfigUrl(storeUrl, memoryKey, processor) {
    const parsed = new URL(storeUrl);
    let slug = decodeURIComponent(parsed.pathname);
    if (!MEMORY_SLUG_RE.test(slug) || !CORES_SLUG_RE.test(slug)) return null;
    slug = slug.replace(MEMORY_SLUG_RE, `${memoryKey}-記憶體`);
    slug = slug.replace(CORES_SLUG_RE, `${processor.cpu}-核心-cpu-${processor.gpu}-核心-gpu`);
    return `${parsed.origin}${encodeURI(slug)}`;
}

// Read the base memory / core counts back out of a configuration URL
function readSlugDimensions(storeUrl) {
    const slug = decodeURIComponent(new URL(storeUrl).pathname);
    const mem = slug.match(MEMORY_SLUG_RE);
    const cores = slug.match(CORES_SLUG_RE);
    if (!mem || !cores) return null;
    return {
        memoryKey: `${mem[1]}${mem[2]}`.toLowerCase(),
        cpu: parseInt(cores[1], 10),
        gpu: parseInt(cores[2], 10)
    };
}

async function processConfigs(configs, catalogs) {
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
    // url -> the retail group it was derived from, so BTO rows inherit colour / SKU lineage
    const candidates = new Map();

    for (const item of Object.values(grouped)) {
        const colorsList = Array.from(item.colors)[0] || '標準色';
        const skusList = Array.from(item.skus).join(', ');
        item.colorsList = colorsList;
        item.skusList = skusList;

        // Retail configuration — price and shipTime already parsed live from the PDP crawl
        expandedList.push({
            sku: skusList,
            name: item.name,
            chip: item.chip,
            cpu: item.cpu,
            gpu: item.gpu,
            ram: item.ram,
            ram_gb: item.ram_gb,
            ssd: item.ssd,
            display: item.display,
            color: colorsList,
            price: item.basePrice,
            price_per_gb_ram: parseFloat((item.basePrice / item.ram_gb).toFixed(2)),
            shipTime: item.shipTime || "有現貨 (通常於 1 個工作天出貨)",
            store_url: item.store_url
        });

        const catalog = catalogs[item.name];
        const base = readSlugDimensions(item.store_url);
        if (!catalog || !base) continue;

        // The chip this retail model uses, identified by its core counts
        const baseProc = catalog.processorOptions.find((p) => p.cpu === base.cpu && p.gpu === base.gpu);
        // A larger memory tier may only be orderable on a higher CPU/GPU bin of the same chip, so try each
        const procVariants = baseProc
            ? catalog.processorOptions.filter((p) => p.chipKey === baseProc.chipKey && p.cpu >= base.cpu && p.gpu >= base.gpu)
            : [{ cpu: base.cpu, gpu: base.gpu }];

        for (const mem of catalog.memoryOptions) {
            if (mem.key === base.memoryKey) continue;
            for (const proc of procVariants) {
                const url = buildConfigUrl(item.store_url, mem.key, proc);
                if (!url || candidates.has(url)) continue;
                candidates.set(url, item);
            }
        }
    }

    const candidateUrls = Array.from(candidates.keys());
    console.log(`[VERIFY] Validating ${candidateUrls.length} candidate BTO configuration URLs (concurrency ${CONCURRENCY})...`);

    const verified = await mapPool(candidateUrls, CONCURRENCY, async (url) => {
        const group = candidates.get(url);
        try {
            const { html, finalUrl } = await fetchWithRedirect(url, {}, 15000);
            // Apple bounces unavailable combinations back to the family landing page, which carries no offer
            const price = parsePriceFromHtml(html);
            if (!price) return null;

            // Trust the page over our guess: read back the config Apple actually served
            const specs = parseSpecsFromTitle(html);
            if (!specs.ram.includes('GB')) return null;
            const ramGb = parseInt(specs.ram.replace('GB', ''));

            const skuInfo = parseSkuFromHtml(html);
            return { group, url: finalUrl, price, specs, ramGb, baseBtoSku: skuInfo && skuInfo.baseBtoSku };
        } catch (err) {
            console.log(`[EXCLUDE] Excluded BTO configuration (Error ${err.message}): ${decodeURIComponent(url)}`);
            return null;
        }
    });

    const found = verified.filter(Boolean);
    console.log(`[VERIFY] ${found.length} of ${candidateUrls.length} candidates are orderable; fetching shipping windows...`);

    const shipTimes = await mapPool(found, CONCURRENCY, async (entry) => {
        if (!entry.baseBtoSku) return "通常於 3 - 5 個工作天出貨 (客製化配置)";
        const sbaRange = await fetchShippingRange(entry.baseBtoSku);
        return calculateShipTime(sbaRange, true, entry.ramGb);
    });

    found.forEach((entry, i) => {
        const { group, specs, price, ramGb, url } = entry;
        console.log(`[INCLUDE] Verified BTO (Price NT$${price}): ${group.name} (${specs.chip}, ${specs.cpu}/${specs.gpu}, ${specs.ram})`);
        expandedList.push({
            sku: `${group.skusList.split(', ')[0] || 'CTO'}/BTO-${specs.ram}`,
            name: group.name,
            chip: specs.chip,
            cpu: specs.cpu,
            gpu: specs.gpu,
            ram: specs.ram,
            ram_gb: ramGb,
            ssd: specs.ssd,
            display: specs.display,
            color: group.colorsList,
            price: price,
            price_per_gb_ram: parseFloat((price / ramGb).toFixed(2)),
            shipTime: shipTimes[i],
            store_url: url
        });
    });

    // Deduplicate the expanded configs list to merge identical specs
    const dedupedList = [];
    const seen = new Map();

    for (const item of expandedList) {
        const key = `${item.name}|${item.chip}|${item.cpu}|${item.gpu}|${item.ram_gb}|${item.ssd}|${item.display}|${item.price}`;
        const existing = seen.get(key);
        if (!existing) {
            seen.set(key, item);
            dedupedList.push(item);
        } else {
            const combined = Array.from(new Set([...existing.sku.split(', '), ...item.sku.split(', ')])).join(', ');
            existing.sku = combined;
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
    const started = Date.now();

    // Fetch every family catalog at once
    const families = Object.entries(urls);
    const catalogList = await Promise.all(families.map(([name, buyUrl]) => getFamilyCatalog(name, buyUrl)));
    const catalogs = {};
    families.forEach(([name], i) => { catalogs[name] = catalogList[i]; });

    // Flatten every retail part number and scrape their PDPs concurrently
    const partJobs = [];
    for (const [name] of families) {
        for (const part of catalogs[name].parts) partJobs.push({ name, part });
    }
    console.log(`[CRAWL] Scraping ${partJobs.length} retail product pages (concurrency ${CONCURRENCY})...`);

    const scraped = await mapPool(partJobs, CONCURRENCY, async ({ name, part }) => {
        try {
            const pdpUrl = `https://www.apple.com/tw/shop/product/${part}`;
            const { html, finalUrl } = await fetchWithRedirect(pdpUrl, {}, 15000);
            const parsed = parsePdp(name, part, html, finalUrl);
            if (!parsed.price) {
                console.warn(`[WARN] No pricing found for SKU: ${part}`);
                return null;
            }
            const sbaRange = await fetchShippingRange(part);
            parsed.shipTime = calculateShipTime(sbaRange, false, parsed.ram_gb);
            console.log(`[PARSED] ${parsed.name} (${parsed.chip}, ${parsed.ram}/${parsed.ssd}): NT$${parsed.price}, Ship: ${parsed.shipTime}`);
            return parsed;
        } catch (err) {
            console.error(`[ERROR] Failed scraping PDP for SKU: ${part}:`, err.message);
            return null;
        }
    });

    const allConfigs = scraped.filter(Boolean);
    console.log(`[SUCCESS] Crawled a total of ${allConfigs.length} retail configurations!`);

    // Process, expand BTO and programmatically verify each URL
    const processedConfigs = await processConfigs(allConfigs, catalogs);
    console.log(`[SUCCESS] Verified and expanded into ${processedConfigs.length} configurations!`);

    // Save to JSON
    const jsonPath = path.join(__dirname, "mac_configs.json");
    fs.writeFileSync(jsonPath, JSON.stringify(processedConfigs, null, 2), 'utf8');
    console.log(`[SUCCESS] Saved configs JSON file to: ${jsonPath}`);

    // Generate dashboard index.html
    generateHtml(processedConfigs);

    console.log(`[SUCCESS] Finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

run();
