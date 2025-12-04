const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const puppeteer = require('puppeteer');

// ====================== CONFIG ======================
const PUPPETEER_SESSION_FILE = process.env.PUPPETEER_SESSION_FILE || './puppeteer_session_fb.json';
const PUPPETEER_USER_DATA_DIR = process.env.PUPPETEER_USER_DATA_DIR || './puppeteer_data_fb';
const SESSION_DIR = './session_fbot';
const GROUP_JID = '120363403167481041@g.us';
const FB_USERNAME = 'csgocasescom';
const CHECK_INTERVAL = 30;
const PROCESSED_POSTS_FILE = './processed_posts_fb.json';

let sock;
let browser = null;
let isScraping = false;
let scrapingInterval = null;

// ====================== UTILIDADES ======================
function normalizeJid(jid) {
    return jid.replace(/@lid|@c\.us|@s\.whatsapp\.net/, '');
}

async function delay(min, max = min) {
    const ms = min + Math.random() * (max - min);
    return new Promise(r => setTimeout(r, ms));
}

async function mentionAll(groupJid) {
    try {
        if (!groupJid.endsWith('@g.us')) return;
        const group = await sock.groupMetadata(groupJid);
        const mentions = [];
        let text = '';
        for (const p of group.participants) {
            if (!p.id.endsWith('@lid') && !p.id.endsWith('@c.us') && !p.id.endsWith('@s.whatsapp.net')) continue;
            const num = normalizeJid(p.id);
            text += `@${num} `;
            mentions.push(p.id);
        }
        if (!mentions.length) return;
        await sock.sendMessage(groupJid, { text: text.trim(), mentions });
        console.log('Mención enviada (Facebook).');
    } catch (e) { console.error('Error en mención:', e); }
}

// ====================== PUPPETEER ======================
async function launchBrowser(headless = true) {
    if (browser) { try { await browser.close(); } catch {} browser = null; }

    const args = [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security',
        '--disable-gpu', '--disable-extensions', '--disable-blink-features=AutomationControlled',
        '--disable-infobars', '--disable-dev-shm-usage',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    if (!headless) args.push('--start-maximized', '--window-size=1366,768');

    browser = await puppeteer.launch({
        headless,
        args,
        userDataDir: PUPPETEER_USER_DATA_DIR,
        defaultViewport: null,
        ignoreDefaultArgs: ['--disable-extensions']
    });
    browser.on('disconnected', () => { browser = null; });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    });
    return page;
}

// ====================== LOGIN ======================
async function isLoggedIn(page) {
    try {
        await delay(2000, 3000);
        const url = page.url();
        console.log(`Chequeando URL: ${url}`);
        if (url.includes('/login') || url.includes('/checkpoint') || url.includes('bloqueado')) return false;

        const selectors = [
            'div[role="main"]',
            '[aria-label="Publicar"]',
            'a[href*="/home"]',
            'div[data-pagelet="ProfileTimeline"]',
            `div[role="banner"] a[href="/${FB_USERNAME}"]`
        ];
        for (const s of selectors) if (await page.$(s)) return true;

        const title = await page.title();
        if (title.includes(FB_USERNAME) || title.includes('Facebook')) return true;

        const body = await page.$eval('body', el => el.innerText).catch(() => '');
        if (body.includes('bloqueó') || body.includes('blocked')) {
            console.error('DETECTADO BLOQUEO: Reinicia sesión o espera.');
            return false;
        }
        return false;
    } catch (e) { return false; }
}

async function ensureLogin() {
    if (fs.existsSync(PUPPETEER_SESSION_FILE)) {
        try {
            const page = await launchBrowser(true);
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
            await page.setCookie(...JSON.parse(fs.readFileSync(PUPPETEER_SESSION_FILE, 'utf8')));
            console.log(`${(await page.cookies()).length} cookies cargados.`);
            await page.goto(`https://www.facebook.com/${FB_USERNAME}`, { waitUntil: 'networkidle2', timeout: 30000 });
            if (await isLoggedIn(page)) { await page.close(); return true; }
            await page.close();
            console.log('Sesión inválida → re-login.');
            fs.unlinkSync(PUPPETEER_SESSION_FILE);
        } catch (e) { console.log('Error con sesión:', e.message); }
    }

    console.log('=== LOGIN MANUAL ===');
    console.log('1. Abre ventana → ingresa usuario/contraseña');
    console.log('2. Completa 2FA si pide');
    console.log('3. Ve a https://www.facebook.com/' + FB_USERNAME);
    console.log('4. Cierra la ventana.');

    const page = await launchBrowser(false);
    await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2', timeout: 60000 });

    let attempts = 0;
    while (attempts < 240) {
        if (!browser?.isConnected()) break;
        await page.goto(`https://www.facebook.com/${FB_USERNAME}`, { waitUntil: 'networkidle2', timeout: 30000 });
        if (await isLoggedIn(page)) {
            const cookies = await page.cookies();
            fs.writeFileSync(PUPPETEER_SESSION_FILE, JSON.stringify(cookies, null, 2));
            console.log('Sesión guardada:', PUPPETEER_SESSION_FILE);
            await page.close();
            return true;
        }
        await delay(3000, 5000);
        attempts++;
        if (attempts % 20 === 0) console.log(`Esperando login... (${attempts * 3}s)`);
    }
    console.log('Timeout. Cierra y reinicia.');
    if (page) await page.close();
    return false;
}

// ====================== VERSIÓN FINAL: IMAGEN REAL + NUNCA REPITE (CSGOCASESCOM 2025) ======================
async function scrapeFBProfile() {
    if (isScraping || !browser) return;
    isScraping = true;
    let page;

    try {
        let processedPosts = [];
        if (fs.existsSync(PROCESSED_POSTS_FILE)) {
            processedPosts = JSON.parse(fs.readFileSync(PROCESSED_POSTS_FILE, 'utf8') || '[]');
        }

        page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        if (fs.existsSync(PUPPETEER_SESSION_FILE)) {
            await page.setCookie(...JSON.parse(fs.readFileSync(PUPPETEER_SESSION_FILE, 'utf8')));
        }

        await page.goto(`https://www.facebook.com/${FB_USERNAME}`, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(10000, 14000);

        if (!(await isLoggedIn(page))) {
            console.error("Sesión inválida");
            isScraping = false;
            return;
        }

        await page.evaluate(() => window.scrollTo(0, 1000));
        await delay(8000, 10000);

        // OBTENER LA URL DE LA IMAGEN MÁS RECIENTE (la grande del giveaway)
        const imageUrl = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('img'));
            for (const img of imgs) {
                const alt = (img.alt || '').toLowerCase();
                if (/giveaway|famas|awp|case|skin|dragon|athena|promo|48h/i.test(alt)) {
                    if (img.srcset) {
                        return img.srcset.split(',').pop().trim().split(' ')[0]; // Máxima calidad
                    }
                    if (img.src?.includes('fbcdn.net')) return img.src;
                }
            }
            return null;
        });

        if (!imageUrl) {
            console.log("No se encontró imagen de giveaway (puede que no haya nuevo)");
            isScraping = false;
            return;
        }

        // GENERAR UN ID ÚNICO BASADO EN LA URL LIMPIA DE LA IMAGEN
        const cleanUrl = imageUrl.split('?')[0]; // Quitamos parámetros que cambian
        const postId = require('crypto').createHash('md5').update(cleanUrl).digest('hex');

        // COMPROBAR SI YA FUE ENVIADO
        if (processedPosts.includes(postId)) {
            console.log("Este giveaway ya fue enviado antes → ignorado");
            isScraping = false;
            return;
        }

        console.log("NUEVO GIVEAWAY DETECTADO → enviando imagen real...");

        // DESCARGAR LA IMAGEN REAL
        const view = await browser.newPage();
        await view.setCookie(...await page.cookies());
        await view.setExtraHTTPHeaders({ 'Referer': 'https://www.facebook.com/' });
        const response = await view.goto(imageUrl, { timeout: 40000 });
        const buffer = await response.buffer();
        await view.close();

        // ENVIAR A WHATSAPP
        await sock.sendMessage(GROUP_JID, {
            image: buffer,
            caption: `NUEVO GIVEAWAY / PROMOCODE\n\n@csgocasescom\n\nhttps://www.facebook.com/csgocasescom`
        });

        setTimeout(() => mentionAll(GROUP_JID), 2000);

        // GUARDAR EL ID PARA NUNCA REPETIR
        processedPosts.unshift(postId);
        if (processedPosts.length > 200) processedPosts.pop();
        fs.writeFileSync(PROCESSED_POSTS_FILE, JSON.stringify(processedPosts, null, 2));

        console.log("ENVIADO Y GUARDADO → nunca se repetirá este post");

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        if (page) await page.close();
        isScraping = false;
    }
}
// ====================== BOT ======================
async function startBot() {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) { console.log('\nQR FACEBOOK:\n'); qrcode.generate(qr, { small: true }); }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401) { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); setTimeout(startBot, 1000); }
            else setTimeout(startBot, 3000);
        } else if (connection === 'open') {
            console.log('BOT FACEBOOK CONECTADO');
            if (!(await ensureLogin())) { console.error('Login fallido.'); setTimeout(() => sock.ws.close(), 10000); return; }
            await launchBrowser(true);
            scrapingInterval = setInterval(scrapeFBProfile, CHECK_INTERVAL);
            setTimeout(scrapeFBProfile, 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

process.on('SIGINT', async () => {
    console.log('\nApagando...');
    if (scrapingInterval) clearInterval(scrapingInterval);
    if (browser) await browser.close();
    process.exit();
});

startBot().catch(console.error);