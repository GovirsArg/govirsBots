const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const puppeteer = require('puppeteer');

const SESSION_DIR = './session_xbot';
const GROUP_JID = '120363403167481041@g.us';
const X_USERNAME = 'csgocasescom';
const CHECK_INTERVAL = 180000;
const PROCESSED_TWEETS_FILE = './processed_tweets.json';
const PUPPETEER_SESSION_FILE = './puppeteer_session.json';

let sock;
let isScraping = false;
let scrapingInterval = null;
let browser = null;

function normalizeJid(jid) {
    return jid.replace(/@lid|@c\.us|@s\.whatsapp\.net/, '');
}

async function mentionAll(groupJid) {
    try {
        const group = await sock.groupMetadata(groupJid);
        const mentions = [];
        let textToSend = '';

        for (const p of group.participants) {
            if (!p.id.endsWith('@lid') && !p.id.endsWith('@c.us') && !p.id.endsWith('@s.whatsapp.net')) continue;
            const num = normalizeJid(p.id);
            textToSend += `@${num} `;
            mentions.push(p.id);
        }

        await sock.sendMessage(groupJid, {
            text: textToSend.trim(),
            mentions
        });

        console.log('✔ Mención enviada');

    } catch (err) {
        console.error('❌ Error en mentionAll:', err);
    }
}

async function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function launchBrowser(headless = false) {
    if (browser && browser.isConnected()) return browser.newPage();

    if (browser) {
        try { await browser.close(); } catch {}
        browser = null;
    }

    browser = await puppeteer.launch({
        headless,
        userDataDir: './puppeteer_data_x',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-gpu'
        ]
    });

    browser.on('disconnected', () => { browser = null; });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    return page;
}

async function isLoggedIn(page) {
    try {
        const url = page.url();
        if (url.includes('/home') || url.includes(X_USERNAME)) return true;

        const selectors = [
            'a[data-testid="AppTabBar_Profile_Link"]',
            '[data-testid="SideNav_AccountSwitcher_Button"]'
        ];
        for (const sel of selectors) {
            if (await page.$(sel)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function ensureLogin() {
    if (fs.existsSync(PUPPETEER_SESSION_FILE)) {
        const page = await launchBrowser(true);
        await page.goto('https://x.com/home', { waitUntil: 'networkidle2' });

        if (await isLoggedIn(page)) {
            await page.close();
            console.log('✔ Sesión detectada (headless)');
            return true;
        }
        await page.close();
    }

    console.log('🔓 LOGIN MANUAL NECESARIO');
    const page = await launchBrowser(false);
    await page.goto('https://x.com/login', { waitUntil: 'networkidle2' });

    while (true) {
        if (await isLoggedIn(page)) {
            const cookies = await page.cookies();
            fs.writeFileSync(PUPPETEER_SESSION_FILE, JSON.stringify(cookies, null, 2));
            await page.close();
            console.log('✔ Sesión guardada. Continúa el bot.');
            return true;
        }
        await delay(2000);
    }
}

async function scrapeXProfile() {
    if (isScraping || !browser) return;
    isScraping = true;

    let page;
    try {
        // Crear archivo si no existe
        if (!fs.existsSync(PROCESSED_TWEETS_FILE))
            fs.writeFileSync(PROCESSED_TWEETS_FILE, JSON.stringify([], null, 2));

        let processedTweets = JSON.parse(fs.readFileSync(PROCESSED_TWEETS_FILE));

        page = await browser.newPage();
        await page.goto(`https://x.com/${X_USERNAME}`, { waitUntil: 'networkidle2' });

        await page.evaluate('window.scrollBy(0, 800)');
        await delay(1500);

        const tweets = await page.$$('article[data-testid="tweet"]');

        if (tweets.length === 0) {
            console.log('⚠ No se detectaron tweets');
            return;
        }

        const tweet = tweets[0];

        const img = await tweet.$('img[src*="media"]');
        if (!img) {
            console.log('⛔ Primera publicación no tiene imagen');
            return;
        }

        const src = await img.evaluate(e => e.src);

        const link = await tweet.$('a[href*="/status/"] time');
        const href = link ? await link.evaluate(a => a.parentElement.href) : null;
        const tweetId = href?.split('/status/')[1]?.split('?')[0];

        if (!tweetId) {
            console.log('❌ No se pudo obtener el ID del tweet');
            return;
        }

        if (processedTweets.includes(tweetId)) {
            console.log('⏩ Ya procesado');
            return;
        }

        const text = await tweet.$eval('div[data-testid="tweetText"]', e => e.innerText).catch(() => '');

        console.log(`📸 Nueva imagen detectada: ${tweetId}`);

        const imgPage = await browser.newPage();
        const res = await imgPage.goto(src);
        const buffer = await res.buffer();
        await imgPage.close();

        await sock.sendMessage(GROUP_JID, {
            image: buffer,
            caption:
                `Nueva publicación de @${X_USERNAME}\n\n${text}\n\nhttps://x.com/${X_USERNAME}/status/${tweetId}`
        });

        console.log('📤 Imagen enviada');

        setTimeout(() => mentionAll(GROUP_JID), 2000);

        processedTweets.push(tweetId);
        fs.writeFileSync(PROCESSED_TWEETS_FILE, JSON.stringify(processedTweets, null, 2));

        console.log('✔ Tweet guardado');

    } catch (err) {
        console.error('❌ Error en scraper:', err);
    } finally {
        if (page) await page.close();
        isScraping = false;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('connection.update', async ({ connection, qr }) => {
        if (qr) {
            console.log('🔑 ESCANEA EL QR:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('🤖 BOT CONECTADO');

            if (!(await ensureLogin())) return;

            await launchBrowser(true);

            scrapingInterval = setInterval(scrapeXProfile, CHECK_INTERVAL);
            setTimeout(scrapeXProfile, 5000);
        }

        if (connection === 'close') {
            console.log('🔄 Reconectando...');
            setTimeout(startBot, 2000);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

process.on('SIGINT', async () => {
    if (scrapingInterval) clearInterval(scrapingInterval);
    if (browser) await browser.close();
    process.exit();
});

startBot();
