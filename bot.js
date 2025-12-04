process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
process.env["BAILEYS_FORCE_NODE_WS"] = "true";

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const SESSION_DIR = './session';

async function startBot() {
    // Crear carpeta de sesión si no existe
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\nESCANEA ESTE QR:\n');
            qrcode.generate(qr, { small: true });
            console.log('\n');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.toString();

            console.log('Desconectado. Código:', code, 'Razón:', reason);

            if (code === 401 || reason?.includes('MessageCounterError')) {
                console.log('Sesión inválida. Borrando ./session para reconectar...');
                fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                setTimeout(startBot, 1000);
            } else {
                console.log('Reconectando en 3s...');
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('BOT CONECTADO! Usa @all o @cs en un grupo.\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // === Manejo de @all y @cs en grupos ===
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (text !== '@all' && text !== '@cs') return; // ← Acepta ambos comandos

        try {
            if (!msg.key.remoteJid.endsWith('@g.us')) {
                return sock.sendMessage(msg.key.remoteJid, { text: 'Solo en grupos.' });
            }

            const group = await sock.groupMetadata(msg.key.remoteJid);
            const exclude = ['5491140656509@c.us']; // ← Número excluido
            const sender = msg.key.participant;

            const mentions = [];
            let textToSend = '';

            for (const p of group.participants) {
                if (p.id === sender) continue;
                if (exclude.includes(p.id)) continue;
                if (!p.id.endsWith('@lid') && !p.id.endsWith('@c.us') && !p.id.endsWith('@s.whatsapp.net')) continue;

                const num = p.id.replace(/@lid|@c\.us|@s\.whatsapp\.net/, '');
                textToSend += `@${num} `;
                mentions.push(p.id);
            }

            if (mentions.length === 0) {
                return sock.sendMessage(msg.key.remoteJid, { text: 'No hay usuarios.' });
            }

            await sock.sendMessage(msg.key.remoteJid, {
                text: textToSend.trim(),
                mentions: mentions
            });

        } catch (err) {
            console.error('Error al procesar @all o @cs:', err);
        }
    });
}

startBot().catch(err => console.error('Error iniciando bot:', err));