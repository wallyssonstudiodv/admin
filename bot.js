const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    downloadContentFromMessage,
    jidDecode,
    proto,
    getContentType 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sharp = require('sharp');
const qrcode = require('qrcode');

class WhatsAppAdminBot {
    constructor() {
        this.sock = null;
        this.activeGroups = new Set();
        this.userInteractions = new Map();
        this.userWarnings = new Map();
        this.groupsList = new Map(); // Lista de grupos disponíveis
        this.connectionStatus = 'disconnected';
        this.qrCode = null;
        
        // Palavras ofensivas padrão (editáveis pelo painel)
        this.offensiveWords = [
            'porra', 'merda', 'caralho', 'puta', 'fdp', 'desgraçado',
            'otario', 'idiota', 'burro', 'imbecil', 'cuzão', 'babaca'
        ];
        
        this.linkRegex = /(https?:\/\/[^\s]+)/gi;
        
        // Inicializa servidor web
        this.initWebServer();
        this.loadBotData();
    }

    initWebServer() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server);

        // Middleware
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));

        // Rotas da API
        this.setupRoutes();
        
        // Socket.IO para atualizações em tempo real
        this.setupSocketIO();

        // Inicia servidor
        const PORT = process.env.PORT || 3000;
        this.server.listen(PORT, () => {
            console.log(`🌐 Painel web rodando em http://localhost:${PORT}`);
        });
    }

    setupRoutes() {
        // Página principal
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        // Status da conexão
        this.app.get('/api/status', (req, res) => {
            res.json({
                status: this.connectionStatus,
                qrCode: this.qrCode,
                activeGroupsCount: this.activeGroups.size,
                totalGroups: this.groupsList.size
            });
        });

        // Conectar WhatsApp
        this.app.post('/api/connect', async (req, res) => {
            try {
                await this.start();
                res.json({ success: true, message: 'Conectando WhatsApp...' });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Desconectar WhatsApp
        this.app.post('/api/disconnect', async (req, res) => {
            try {
                if (this.sock) {
                    await this.sock.logout();
                    this.sock = null;
                }
                this.connectionStatus = 'disconnected';
                this.io.emit('statusUpdate', { status: this.connectionStatus });
                res.json({ success: true, message: 'Desconectado com sucesso!' });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Listar grupos
        this.app.get('/api/groups', (req, res) => {
            const groups = Array.from(this.groupsList.entries()).map(([id, info]) => ({
                id,
                name: info.subject,
                active: this.activeGroups.has(id),
                participants: info.participants?.length || 0
            }));
            res.json(groups);
        });

        // Ativar/desativar grupo
        this.app.post('/api/groups/:groupId/toggle', (req, res) => {
            const { groupId } = req.params;
            const { active } = req.body;

            if (active) {
                this.activeGroups.add(groupId);
            } else {
                this.activeGroups.delete(groupId);
            }

            this.saveBotData();
            this.io.emit('groupsUpdate');
            
            res.json({ 
                success: true, 
                message: `Grupo ${active ? 'ativado' : 'desativado'} com sucesso!` 
            });
        });

        // Gerenciar palavras ofensivas
        this.app.get('/api/offensive-words', (req, res) => {
            res.json({ words: this.offensiveWords });
        });

        this.app.post('/api/offensive-words', (req, res) => {
            const { words } = req.body;
            if (Array.isArray(words)) {
                this.offensiveWords = words;
                this.saveBotData();
                res.json({ success: true, message: 'Palavras atualizadas!' });
            } else {
                res.status(400).json({ success: false, error: 'Formato inválido' });
            }
        });

        // Estatísticas
        this.app.get('/api/stats', (req, res) => {
            const totalInteractions = Array.from(this.userInteractions.values())
                .reduce((sum, count) => sum + count, 0);
            
            const totalWarnings = Array.from(this.userWarnings.values())
                .reduce((sum, count) => sum + count, 0);

            res.json({
                activeGroups: this.activeGroups.size,
                totalGroups: this.groupsList.size,
                totalInteractions,
                totalWarnings,
                offensiveWordsCount: this.offensiveWords.length
            });
        });

        // Limpar dados
        this.app.post('/api/clear-data', (req, res) => {
            const { type } = req.body;
            
            switch (type) {
                case 'interactions':
                    this.userInteractions.clear();
                    break;
                case 'warnings':
                    this.userWarnings.clear();
                    break;
                case 'all':
                    this.userInteractions.clear();
                    this.userWarnings.clear();
                    break;
            }
            
            this.saveBotData();
            res.json({ success: true, message: 'Dados limpos com sucesso!' });
        });
    }

    setupSocketIO() {
        this.io.on('connection', (socket) => {
            console.log('🔌 Cliente conectado ao painel');
            
            // Envia status atual
            socket.emit('statusUpdate', {
                status: this.connectionStatus,
                qrCode: this.qrCode
            });

            socket.on('disconnect', () => {
                console.log('🔌 Cliente desconectado do painel');
            });
        });
    }

    async start() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
            
            this.sock = makeWASocket({
                logger: pino({ level: 'silent' }),
                printQRInTerminal: true,
                auth: state,
                generateHighQualityLinkPreview: true,
            });

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    this.qrCode = await qrcode.toDataURL(qr);
                    this.connectionStatus = 'qr';
                    this.io.emit('statusUpdate', {
                        status: this.connectionStatus,
                        qrCode: this.qrCode
                    });
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                    this.connectionStatus = 'disconnected';
                    this.qrCode = null;
                    this.io.emit('statusUpdate', { 
                        status: this.connectionStatus,
                        qrCode: null 
                    });
                    
                    if (shouldReconnect) {
                        console.log('Reconectando...');
                        setTimeout(() => this.start(), 5000);
                    }
                } else if (connection === 'open') {
                    this.connectionStatus = 'connected';
                    this.qrCode = null;
                    console.log('🤖 Bot conectado com sucesso!');
                    
                    // Carrega lista de grupos
                    await this.loadGroups();
                    
                    this.io.emit('statusUpdate', { 
                        status: this.connectionStatus,
                        qrCode: null 
                    });
                    this.io.emit('groupsUpdate');
                }
            });

            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('messages.upsert', async (m) => {
                await this.handleMessage(m);
            });

        } catch (error) {
            console.error('Erro ao conectar:', error);
            this.connectionStatus = 'error';
            this.io.emit('statusUpdate', { 
                status: this.connectionStatus,
                error: error.message 
            });
        }
    }

    async loadGroups() {
        try {
            const groups = await this.sock.groupFetchAllParticipating();
            
            for (const [id, group] of Object.entries(groups)) {
                this.groupsList.set(id, {
                    subject: group.subject,
                    participants: group.participants
                });
            }
            
            console.log(`📱 ${this.groupsList.size} grupos carregados`);
        } catch (error) {
            console.error('Erro ao carregar grupos:', error);
        }
    }

    loadBotData() {
        try {
            if (fs.existsSync('./bot_data.json')) {
                const data = JSON.parse(fs.readFileSync('./bot_data.json', 'utf8'));
                this.activeGroups = new Set(data.activeGroups || []);
                this.userInteractions = new Map(data.userInteractions || []);
                this.userWarnings = new Map(data.userWarnings || []);
                this.offensiveWords = data.offensiveWords || this.offensiveWords;
                console.log('📊 Dados do bot carregados!');
            }
        } catch (error) {
            console.error('Erro ao carregar dados:', error);
        }
    }

    saveBotData() {
        try {
            const data = {
                activeGroups: Array.from(this.activeGroups),
                userInteractions: Array.from(this.userInteractions),
                userWarnings: Array.from(this.userWarnings),
                offensiveWords: this.offensiveWords
            };
            fs.writeFileSync('./bot_data.json', JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Erro ao salvar dados:', error);
        }
    }

    async handleMessage(m) {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const messageType = getContentType(msg.message);
            const text = msg.message?.conversation || 
                        msg.message?.extendedTextMessage?.text || 
                        msg.message?.imageMessage?.caption || '';
            
            const isGroup = msg.key.remoteJid?.endsWith('@g.us');
            const groupId = msg.key.remoteJid;
            const senderId = msg.key.participant || msg.key.remoteJid;

            // Só processa mensagens em grupos ativos
            if (!isGroup || !this.activeGroups.has(groupId)) return;

            // Atualiza contador de interações
            this.updateUserInteraction(senderId);

            // Processa comandos administrativos
            if (text.startsWith('!')) {
                await this.handleCommands(msg, text, groupId);
                return;
            }

            // Verifica palavras ofensivas e links
            await this.moderateMessage(msg, text, senderId, groupId);

            // Processa imagens para figurinhas
            if (messageType === 'imageMessage' && text.toLowerCase().includes('figurinha')) {
                await this.createSticker(msg);
            }

            // Atualiza estatísticas no painel
            this.io.emit('statsUpdate');

        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    }

    updateUserInteraction(senderId) {
        const current = this.userInteractions.get(senderId) || 0;
        this.userInteractions.set(senderId, current + 1);
        this.saveBotData();
    }

    async handleCommands(msg, text, groupId) {
        const command = text.toLowerCase().split(' ')[0];
        const senderId = msg.key.participant || msg.key.remoteJid;

        switch (command) {
            case '!ranking':
                await this.sendRanking(groupId);
                break;
            
            case '!tocaia':
                await this.sendLurkers(groupId);
                break;
            
            case '!limpar':
                const args = text.split(' ');
                if (args[1]) {
                    const targetUser = args[1].includes('@') ? args[1] : args[1] + '@s.whatsapp.net';
                    this.userWarnings.delete(targetUser);
                    this.saveBotData();
                    await this.sock.sendMessage(groupId, {
                        text: `✅ Avisos limpos para o usuário mencionado!`
                    });
                }
                break;
            
            case '!ajuda':
                await this.sendHelp(groupId);
                break;
        }
    }

    async moderateMessage(msg, text, senderId, groupId) {
        let violation = false;
        let reason = '';

        // Verifica palavras ofensivas
        const hasOffensiveWord = this.offensiveWords.some(word => 
            text.toLowerCase().includes(word.toLowerCase())
        );

        // Verifica links
        const hasLink = this.linkRegex.test(text);

        if (hasOffensiveWord) {
            violation = true;
            reason = 'palavra ofensiva';
        } else if (hasLink) {
            violation = true;
            reason = 'link não autorizado';
        }

        if (violation) {
            const warnings = this.userWarnings.get(senderId) || 0;
            this.userWarnings.set(senderId, warnings + 1);
            this.saveBotData();

            if (warnings === 0) {
                await this.sock.sendMessage(groupId, {
                    text: `⚠️ *Primeiro aviso!*\n\n@${senderId.split('@')[0]} por favor evite usar ${reason} no grupo.\n\n🤝 Vamos manter o respeito entre todos!`,
                    mentions: [senderId]
                });
            } else if (warnings === 1) {
                await this.sock.sendMessage(groupId, {
                    text: `🚨 *Segundo aviso!*\n\n@${senderId.split('@')[0]} já te avisei sobre ${reason}!\n\n😤 Se não parar, vai levar uma surra de chibata de boi! 🐂💢`,
                    mentions: [senderId]
                });
            } else {
                await this.sock.sendMessage(groupId, {
                    text: `💥 *TERCEIRO AVISO - CHIBATA DE BOI!* 💥\n\n@${senderId.split('@')[0]} EU AVISEI! \n\n🐂💢 *TOMOU CHIBATADA VIRTUAL!* 💢🐂\n*ZUPT ZUPT ZUPT ZUPT ZUPT!*\n\n🔥 Agora para com isso ou vai ser pior! \n(Avisos resetados, mas fique esperto!)`,
                    mentions: [senderId]
                });
                
                this.userWarnings.set(senderId, 0);
                this.saveBotData();
            }
        }
    }

    async createSticker(msg) {
        try {
            if (!msg.message.imageMessage) return;

            const quoted = msg.message.imageMessage;
            const stream = await downloadContentFromMessage(quoted, 'image');
            
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            const webpBuffer = await sharp(buffer)
                .resize(512, 512, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .webp({ quality: 80 })
                .toBuffer();

            await this.sock.sendMessage(msg.key.remoteJid, {
                sticker: webpBuffer
            });

            await this.sock.sendMessage(msg.key.remoteJid, {
                text: `🎨 *Figurinha criada com sucesso!* 🎨\n\n😂 Agora pode usar essa obra de arte nas conversas! 🎭`
            });

        } catch (error) {
            console.error('Erro ao criar figurinha:', error);
        }
    }

    async sendRanking(groupId) {
        const interactions = Array.from(this.userInteractions.entries())
            .filter(([userId]) => userId.includes(groupId.split('@')[0]))
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10);

        let rankingText = `🏆 *RANKING DOS MAIS ATIVOS* 🏆\n\n`;
        
        if (interactions.length === 0) {
            rankingText += `😴 Ninguém falou nada ainda...\nQuem vai quebrar o silêncio? 🤔`;
        } else {
            const medals = ['🥇', '🥈', '🥉', '🏅', '🎖️'];
            interactions.forEach(([userId, count], index) => {
                const medal = medals[index] || '🔥';
                const userNumber = userId.split('@')[0];
                rankingText += `${medal} @${userNumber} - ${count} msgs\n\n`;
            });
        }

        await this.sock.sendMessage(groupId, {
            text: rankingText,
            mentions: interactions.map(([userId]) => userId)
        });
    }

    async sendLurkers(groupId) {
        try {
            const groupMetadata = await this.sock.groupMetadata(groupId);
            const participants = groupMetadata.participants.map(p => p.id);
            
            const lurkers = participants.filter(userId => {
                const interactions = this.userInteractions.get(userId) || 0;
                return interactions < 3;
            }).slice(0, 10);

            let lurkersText = `👻 *GALERA DA TOCAIA* 👻\n\n`;
            
            if (lurkers.length === 0) {
                lurkersText += `🎉 Todo mundo participa aqui!\nNinguém tá de tocaia! 🗣️`;
            } else {
                lurkersText += `🕵️ Esses aqui só ficam espiando...\n\n`;
                lurkers.forEach(userId => {
                    const userNumber = userId.split('@')[0];
                    const interactions = this.userInteractions.get(userId) || 0;
                    lurkersText += `👤 @${userNumber} - ${interactions} msgs\n\n`;
                });
            }

            await this.sock.sendMessage(groupId, {
                text: lurkersText,
                mentions: lurkers
            });

        } catch (error) {
            console.error('Erro ao buscar lurkers:', error);
        }
    }

    async sendHelp(groupId) {
        const helpText = `🤖 *BOT ADMINISTRADOR* 🤖\n\n📊 *Comandos:*\n• !ranking - Ver os mais ativos\n• !tocaia - Ver quem só observa\n• !limpar @user - Limpar avisos\n• !ajuda - Este menu\n\n🎨 *Figurinhas:*\nEnvie imagem + "figurinha"\n\n⚠️ *Moderação automática ativa!*`;

        await this.sock.sendMessage(groupId, { text: helpText });
    }
}

// Inicialização
const bot = new WhatsAppAdminBot();

process.on('uncaughtException', (err) => {
    console.error('Erro:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Promise rejeitada:', err);
});

console.log('🚀 Iniciando Bot WhatsApp com Painel Web...');
console.log('🌐 Acesse: http://localhost:8033');

module.exports = WhatsAppAdminBot;
