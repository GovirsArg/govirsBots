process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const puppeteer = require('puppeteer');
const pino = require('pino');

// ===================== CONFIGURACIÓN =====================
const SESSION_DIR = './session_igbot';
const GROUP_JID = '120363403167481041@g.us';           // ← Tu grupo de WhatsApp
const IG_USERNAME = 'csgocasescom';                    // ← Perfil de Instagram a monitorear
const CHECK_INTERVAL = 180000;                         // 3 minutos
const PROCESSED_FILE = './processed_posts.json';       // Posts ya enviados
const COOKIES_FILE = './ig_cookies.json';              // Sesión de Instagram
const MENTION_STATE_FILE = './mention_state.json';     // Estado del último @all

let sock;
let browser = null;
let isScraping = false;
let mentionState = { lastPostUrl: null, lastMentionId: null };

const delay = ms => new Promise(res => setTimeout(res, ms));

// ===================== ESTADO DE MENCIÓN =====================
function loadMentionState() {
    if (fs.existsSync(MENTION_STATE_FILE)) {
        try {
            mentionState = JSON.parse(fs.readFileSync(MENTION_STATE_FILE, 'utf8'));
        } catch (err) {
            mentionState = { lastPostUrl: null, lastMentionId: null };
        }
    }
}

function saveMentionState() {
    fs.writeFileSync(MENTION_STATE_FILE, JSON.stringify(mentionState, null, 2));
}

// ===================== MENCIÓN @ALL =====================
async function mentionAll(postUrl) {
    try {
        const group = await sock.groupMetadata(GROUP_JID);
        const mentions = [];
        const seen = new Set();
        let text = '';

        for (const participant of group.participants) {
            const num = participant.id.split('@')[0];
            if (seen.has(num)) continue;
            seen.add(num);
            text += `@${num} `;
            mentions.push(participant.id);
        }

        if (seen.size === 0) return;

        console.log(`Enviando @all a ${seen.size} personas...`);
        const msg = await sock.sendMessage(GROUP_JID, { text: text.trim(), mentions });

        mentionState.lastPostUrl = postUrl;
        mentionState.lastMentionId = msg.key.id;
        saveMentionState();
        console.log('Mención @all enviada!\n');
    } catch (err) {
        console.error('Error al enviar @all:', err.message);
    }
}

// ===================== NAVEGADOR =====================
async function launchBrowser(headless = true) {
    if (browser) await browser.close().catch(() => {});
    browser = await puppeteer.launch({
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--disable-gpu',
            '--window-size=1366,768'
        ],
        userDataDir: './puppeteer_data'
    });
}

// ===================== LOGIN MANUAL (solo 1 vez) =====================
async function ensureLogin() {
    if (fs.existsSync(COOKIES_FILE)) {
        const page = await browser.newPage();
        const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
        await page.setCookie(...cookies);
        await page.goto(`https://www.instagram.com/${IG_USERNAME}/`, { waitUntil: 'networkidle2', timeout: 30000 });

        if (page.url().includes(IG_USERNAME) && !page.url().includes('login')) {
            console.log('Sesión activa con cookies guardadas');
            await page.close();
            return true;
        }
        await page.close();
    }

    console.log('\n=== LOGIN MANUAL REQUERIDO (solo esta vez) ===');
    console.log('Se abrirá Chrome. Inicia sesión y ve al perfil:', IG_USERNAME);

    await launchBrowser(false); // Ventana visible
    const page = await browser.newPage();
    await page.goto('https://www.instagram.com/accounts/login/');

    while (true) {
        await delay(5000);
        const url = page.url();

        if (url.includes(`/${IG_USERNAME}/`) && !url.includes('login')) {
            const cookies = await page.cookies();
            fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
            console.log('Cookies guardadas correctamente! Ya no tendrás que volver a loguearte.');
            await page.close();
            await launchBrowser(true); // Vuelve a modo oculto
            return true;
        }

        if (!browser?.process?.()) break;
    }

    console.log('Error en login. Cerrando...');
    process.exit(1);
}

// ===================== SCRAPER INSTAGRAM =====================
async function scrapeIGProfile() {
    if (isScraping) return;
    isScraping = true;
    let page;

    try {
        // Cargar posts ya enviados
        const processed = fs.existsSync(PROCESSED_FILE)
            ? JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'))
            : [];

        page = await browser.newPage();

        // Stealth anti-detección
        await page.evaluateOnNewDocument(() => {
            delete navigator.__proto__.webdriver;
            window.chrome = { runtime: {}, app: {}, webstore: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es'] });
        });

        // Cargar cookies
        if (fs.existsSync(COOKIES_FILE)) {
            const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
            await page.setCookie(...cookies);
        }

        console.log('Abriendo perfil de Instagram:', IG_USERNAME);
        await page.goto(`https://www.instagram.com/${IG_USERNAME}/`, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        await delay(6000);

        // Detectar último post/reel
        const latestPostUrl = await page.evaluate(() => {
            const links = [...document.querySelectorAll('a')];
            for (const a of links) {
                if (a.href.includes('/p/') || a.href.includes('/reel/')) {
                    return a.href;
                }
            }
            return null;
        });

        if (!latestPostUrl || processed.includes(latestPostUrl)) {
            console.log('No hay posts nuevos.');
            await page.close();
            isScraping = false;
            return;
        }

        console.log('NUEVO POST DETECTADO →', latestPostUrl);

        // Ir al post
        await page.goto(latestPostUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        // Extraer caption real + imagen HD
        const { caption, imageUrl } = await page.evaluate(() => {
            let caption = 'Nuevo código disponible';
            const spans = document.querySelectorAll('span[dir="auto"]');
            for (const s of spans) {
                const t = s.innerText.trim();
                if (t && t.length > 5 && !t.includes('Hace') && !t.includes('Patrocinado') && !t.match(/^\d/)) {
                    caption = t;
                    break;
                }
            }

            let imgUrl = '';
            const img = document.querySelector('img[style*="object-fit"]') || document.querySelector('img[srcset]');
            if (img?.srcset) {
                const parts = img.srcset.split(',');
                imgUrl = parts[parts.length - 1].trim().split(' ')[0];
            } else if (img?.src) {
                imgUrl = img.src;
            }

            return { caption, imageUrl: imgUrl };
        });

        if (!imageUrl) {
            console.log('No se encontró imagen.');
            await page.close();
            isScraping = false;
            return;
        }

        // Descargar imagen
        const response = await page.goto(imageUrl, { timeout: 60000 });
        const buffer = await response.buffer();

        // Enviar a WhatsApp
        await sock.sendMessage(GROUP_JID, {
            image: buffer,
            caption: `${caption}\n\nEnlace original: ${latestPostUrl}`
        });
        console.log('Post enviado con imagen HD y caption real');

        // @all automático
        await delay(3000);
        await mentionAll(latestPostUrl);

        // Guardar como enviado
        processed.push(latestPostUrl);
        fs.writeFileSync(PROCESSED_FILE, JSON.stringify(processed, null, 2));

        console.log('Post marcado como enviado. Esperando el siguiente...\n');

    } catch (err) {
        console.error('Error en scraper:', err.message);
    } finally {
        if (page) await page.close().catch(() => {});
        isScraping = false;
    }
}

// ===================== INICIAR BOT =====================
async function startBot() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    loadMentionState();

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;

        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            console.log('Conexión perdida. Reconectando en 5 segundos...');
            setTimeout(startBot, 5000);
        }

        if (connection === 'open') {
            console.log('BOT DE INSTAGRAM CONECTADO!');
            await launchBrowser(true);

            if (!fs.existsSync(COOKIES_FILE)) {
                await ensureLogin();
            }

            setTimeout(scrapeIGProfile, 10000);
            setInterval(scrapeIGProfile, CHECK_INTERVAL);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ===================== CIERRE LIMPIO =====================
process.on('SIGINT', async () => {
    console.log('\nCerrando bot de Instagram...');
    saveMentionState();
    if (browser) await browser.close();
    process.exit(0);
});

// ===================== INICIO =====================
startBot().catch(console.error);