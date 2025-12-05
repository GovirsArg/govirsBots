const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const pino = require('pino');

const PUPPETEER_USER_DATA_DIR = './puppeteer_data_ds';
const SESSION_DIR = './session_dsbot';
const GROUP_JID = '120363403167481041@g.us';
const GUILD_URL = 'https://discord.com/channels/1263461920791466055/1279122419994595361';
const CHECK_INTERVAL = 180000; // 3 minutos
const PROCESSED_FILE = './processed_discord_images.json';

let sock;
let browser = null;
let isChecking = false;

// Cargar hashes procesados (usamos Set para evitar duplicados)
const processedHashes = new Set();
if (fs.existsSync(PROCESSED_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
        data.forEach(h => processedHashes.add(h));
    } catch (e) { }
}

function saveProcessed() {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedHashes], null, 2));
}

// Reutilizar navegador (más rápido y estable)
async function getBrowser() {
    if (browser && !browser.isConnected()) browser = null;
    if (!browser) {
        browser = await puppeteer.launch({
            headless: true,
            userDataDir: PUPPETEER_USER_DATA_DIR,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run', '--no-zygote', '--disable-dev-shm-usage'
            ],
            defaultViewport: { width: 1366, height: 768 }
        });
    }
    return browser;
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Verificar sesión Discord
async function checkDiscordSession() {
    if (!fs.existsSync(PUPPETEER_USER_DATA_DIR)) {
        console.log('[ERROR] No existe perfil de Discord. Ejecuta una vez con headless: false para loguearte.');
        return false;
    }
    try {
        const br = await getBrowser();
        const page = await br.newPage();
        await page.goto(GUILD_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        const currentUrl = page.url();
        await page.close();

        if (currentUrl.includes('login') || currentUrl.includes('auth')) {
            console.log('[ERROR] Sesión de Discord expirada. Borra la carpeta puppeteer_data_ds/');
            return false;
        }
        console.log('[OK] Sesión de Discord válida');
        return true;
    } catch (err) {
        console.log('[ERROR] Fallo al verificar Discord:', err.message);
        return false;
    }
}

// Mencionar a todos
async function mentionAll() {
    try {
        const group = await sock.groupMetadata(GROUP_JID);
        const mentions = group.participants.map(p => p.id);
        const text = mentions.map(jid => `@${jid.split('@')[0]}`).join(' ');

        await sock.sendMessage(GROUP_JID, { text, mentions });
        console.log(`[SUCCESS] @everyone enviado a ${mentions.length} miembros`);
    } catch (err) {
        console.log('[ERROR] Error al mencionar:', err.message);
    }
}

// FUNCIÓN PRINCIPAL: Detectar y enviar nueva imagen (tu método original que SÍ funciona)
async function captureImage() {
    if (isChecking) {
        console.log('[INFO] Ya hay un chequeo en curso, esperando...');
        return;
    }
    isChecking = true;
    let page = null;

    try {
        console.log('[INFO] Revisando canal por nuevo promocode...');
        const br = await getBrowser();
        page = await br.newPage();

        // Anti-detección
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });

        await page.goto(GUILD_URL, { waitUntil: 'networkidle2', timeout: 45000 });

        // Scroll para cargar imágenes
        for (let i = 0; i < 12; i++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await delay(1000);
        }

        // Screenshot de depuración
        await page.screenshot({ path: 'debug_canal_actual.png', fullPage: true });
        console.log('[DEBUG] Screenshot guardado: debug_canal_actual.png');

        // Buscar la imagen más reciente válida
        const result = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('img'))
                .filter(img => img.complete && img.naturalWidth > 250 && img.naturalHeight > 250)
                .filter(img => img.src.includes('media.discordapp.net/attachments') || img.src.includes('cdn.discordapp.com/attachments'))
                .filter(img => !img.src.includes('emojis') && !img.src.includes('avatars'))
                .reverse();

            for (const img of imgs) {
                const src = img.src;
                const container = img.closest('div[role="listitem"]') || img.closest('li') || document.body;
                const text = (container.innerText || 'NUEVO PROMOCODE').substring(0, 200);
                return { url: src, text };
            }
            return null;
        });

        if (!result) {
            console.log('[INFO] No hay imagen nueva de promocode.');
            return;
        }

        const { url, text } = result;
        const cleanUrl = url.split('?')[0]; // Quitamos parámetros para hash estable
        const hash = crypto.createHash('md5').update(cleanUrl).digest('hex');

        if (processedHashes.has(hash)) {
            console.log('[INFO] Esta imagen ya fue enviada antes. Ignorando...');
            return;
        }

        console.log('[SUCCESS] ¡NUEVA IMAGEN DETECTADA!');
        console.log('[LINK] ' + url);

        // ← TU MÉTODO ORIGINAL QUE NUNCA FALLA ↓
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        const buffer = await response.buffer();

        await sock.sendMessage(GROUP_JID, {
            image: buffer,
            caption: `¡NUEVO PROMOCODE!\n\n${text}\n\n${GUILD_URL}`
        });

        console.log('[SUCCESS] Imagen enviada al grupo!');

        // Mencionar 2 segundos después
        setTimeout(mentionAll, 2000);

        // Guardar hash
        processedHashes.add(hash);
        saveProcessed();
        console.log('[SUCCESS] Imagen registrada. No se repetirá.');

    } catch (err) {
        console.error('[ERROR] Fallo al capturar imagen:', err.message);
    } finally {
        if (page) await page.close().catch(() => {});
        isChecking = false;
    }
}

// Conexión WhatsApp con reconexión automática
async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const status = lastDisconnect?.error?.output?.statusCode;
            if (status === DisconnectReason.loggedOut) {
                console.log('[FATAL] Sesión cerrada (logged out). Borra la carpeta session_dsbot/ y escanea QR de nuevo.');
                process.exit(1);
            } else {
                console.log('[WA] Conexión perdida. Reconectando en 5 segundos...');
                setTimeout(connectWA, 5000);
            }
        } else if (connection === 'open') {
            console.log('[SUCCESS] WhatsApp conectado correctamente!');
            if (await checkDiscordSession()) {
                await captureImage(); // Primera ejecución inmediata
                setInterval(captureImage, CHECK_INTERVAL);
            } else {
                process.exit(1);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Apagar limpiamente
process.on('SIGINT', async () => {
    console.log('\n[APAGANDO] Cerrando navegador y bot...');
    if (browser) await browser.close();
    process.exit(0);
});

// INICIAR
connectWA().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});