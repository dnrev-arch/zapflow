const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');
const LEAD_LOCKS_FILE = path.join(__dirname, 'data', 'lead_locks.json');
const MESSAGE_CONTROL_FILE = path.join(__dirname, 'data', 'message_control.json');

// ============ MAPEAMENTO DE PRODUTOS ============
const PRODUCT_MAPPING = {
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS',
    '564bb9bb-718a-4e8b-a843-a2da62f616f0': 'CS',
    '668a73bc-2fca-4f12-9331-ef945181cd5c': 'FAB'
};

const PERFECTPAY_PLANS = {
    'PPLQQNCF7': 'CS',
    'PPLQQNCF8': 'CS',
};

const PERFECTPAY_PRODUCTS = {
    'PPU38CQ0GE8': 'CS',
};

function identifyPerfectPayProduct(productCode, planCode) {
    if (planCode && PERFECTPAY_PLANS[planCode]) {
        return PERFECTPAY_PLANS[planCode];
    }
    if (productCode && PERFECTPAY_PRODUCTS[productCode]) {
        return PERFECTPAY_PRODUCTS[productCode];
    }
    return 'CS';
}

// Instâncias Evolution
const INSTANCES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D13'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map(); // Índice de variações de telefone
let phoneVariations = new Map(); // NOVO: Índice reverso melhorado
let leadInstanceLocks = new Map(); // NOVO: Trava eterna de instância
let messageControl = new Map(); // NOVO: Controle anti-duplicata
let sendErrors = new Map(); // NOVO: Registro de erros
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();

// ============ SISTEMA DE SEGURANÇA MÁXIMA ============

// 🔒 FUNÇÃO 1: Trava Eterna de Instância
function lockLeadToInstance(phoneKey, instanceName) {
    if (leadInstanceLocks.has(phoneKey)) {
        const existingLock = leadInstanceLocks.get(phoneKey);
        console.log('⚠️ Lead já travado na instância:', existingLock.instance);
        return existingLock.instance;
    }
    
    const lock = {
        phoneKey: phoneKey,
        instance: instanceName,
        lockedAt: new Date(),
        firstMessageAt: new Date(),
        NEVER_CHANGE: true,
        totalMessages: 1
    };
    
    leadInstanceLocks.set(phoneKey, lock);
    
    addLog('INSTANCE_LOCKED', `🔒 Lead ${phoneKey} TRAVADO ETERNAMENTE na instância ${instanceName}`, lock);
    console.log('🔒🔒🔒 LEAD TRAVADO PARA SEMPRE NA INSTÂNCIA:', instanceName);
    
    saveLeadLocks();
    return instanceName;
}

// 🔒 FUNÇÃO 2: Obter Instância Travada
function getLockedInstance(phoneKey) {
    const lock = leadInstanceLocks.get(phoneKey);
    if (lock) {
        console.log('🔒 Lead usa instância travada:', lock.instance);
        return lock.instance;
    }
    return null;
}

// 🔒 FUNÇÃO 3: Controle Anti-Duplicata
function canSendMessage(phoneKey, stepId, funnelId) {
    const control = messageControl.get(phoneKey);
    const messageKey = `${funnelId}_${stepId}`;
    
    if (!control) {
        // Primeira mensagem do lead
        messageControl.set(phoneKey, {
            messages: new Set([messageKey]),
            lastSent: new Date(),
            history: [{
                messageKey,
                sentAt: new Date()
            }]
        });
        saveMessageControl();
        return true;
    }
    
    // Verifica se já enviou esta mensagem
    if (control.messages.has(messageKey)) {
        const lastSent = control.lastSent;
        const hoursSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
        
        if (hoursSince < 24) {
            addLog('MESSAGE_BLOCKED', `🚫 BLOQUEADO: Mensagem ${messageKey} já enviada há ${hoursSince.toFixed(1)}h`, {
                phoneKey,
                messageKey,
                lastSent,
                hoursSince
            });
            console.log('🚫🚫🚫 MENSAGEM BLOQUEADA - JÁ ENVIADA HÁ MENOS DE 24H');
            return false;
        }
    }
    
    // Atualiza controle
    control.messages.add(messageKey);
    control.lastSent = new Date();
    control.history.push({
        messageKey,
        sentAt: new Date()
    });
    
    messageControl.set(phoneKey, control);
    saveMessageControl();
    return true;
}

// 🔒 FUNÇÃO 4: Registrar Erro de Envio
function registerSendError(phoneKey, instanceName, error, stepId) {
    const errorRecord = {
        phoneKey,
        instance: instanceName,
        error: error,
        stepId,
        timestamp: new Date(),
        resolved: false
    };
    
    if (!sendErrors.has(phoneKey)) {
        sendErrors.set(phoneKey, []);
    }
    
    sendErrors.get(phoneKey).push(errorRecord);
    
    addLog('SEND_ERROR_REGISTERED', `❌ ERRO REGISTRADO: ${phoneKey} na instância ${instanceName}`, errorRecord);
    console.log('❌❌❌ ERRO DE ENVIO REGISTRADO - REQUER AÇÃO MANUAL');
    
    // Notificar administrador (implementar webhook ou email aqui)
    notifyAdmin(errorRecord);
}

// 🔒 FUNÇÃO 5: Notificar Administrador
function notifyAdmin(errorRecord) {
    console.log('\n🚨🚨🚨 ALERTA PARA ADMINISTRADOR 🚨🚨🚨');
    console.log('Lead:', errorRecord.phoneKey);
    console.log('Instância:', errorRecord.instance);
    console.log('Erro:', errorRecord.error);
    console.log('Ação necessária: Verificar instância ou contatar lead manualmente');
    console.log('🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n');
}

// ============ SISTEMA DE NORMALIZAÇÃO UNIVERSAL MELHORADO ============

function normalizePhoneKey(phone) {
    if (!phone) return null;
    const onlyNumbers = String(phone).replace(/\D/g, '');
    if (onlyNumbers.length < 8) return null;
    return onlyNumbers.slice(-8);
}

function registerPhoneUniversal(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    
    const cleaned = String(fullPhone).replace(/\D/g, '');
    
    // Registra TODAS as variações possíveis
    const variations = [
        cleaned,
        '55' + cleaned,
        cleaned.startsWith('55') ? cleaned.substring(2) : cleaned,
        cleaned.slice(-11),
        cleaned.slice(-10),
        cleaned.slice(-9),
        cleaned.slice(-8)
    ];
    
    // Adiciona variações com/sem o 9 do celular
    if (cleaned.length >= 11) {
        const last11 = cleaned.slice(-11);
        if (last11[2] === '9') {
            // Remove o 9
            variations.push(last11.substring(0, 2) + last11.substring(3));
        } else if (last11.length === 10) {
            // Adiciona o 9
            variations.push(last11.substring(0, 2) + '9' + last11.substring(2));
        }
    }
    
    // Registra todas as variações
    variations.forEach(variation => {
        if (variation && variation.length >= 8) {
            phoneIndex.set(variation, phoneKey);
            phoneVariations.set(variation, phoneKey);
        }
    });
    
    console.log('✅ Telefone registrado com', variations.length, 'variações');
    
    addLog('PHONE_REGISTERED', `📱 Telefone registrado: ${phoneKey}`, {
        original: cleaned,
        variations: variations.length,
        phoneKey
    });
}

function findConversationUniversal(phone) {
    const phoneKey = normalizePhoneKey(phone);
    
    if (!phoneKey) {
        console.log('❌ Telefone inválido:', phone);
        return null;
    }
    
    // 1. Busca direta pela phoneKey
    let conversation = conversations.get(phoneKey);
    if (conversation) {
        console.log('✅ Conversa encontrada (busca direta):', phoneKey);
        registerPhoneUniversal(phone, phoneKey);
        return conversation;
    }
    
    // 2. Busca pelo índice de variações
    const cleaned = String(phone).replace(/\D/g, '');
    const possibleVariations = [
        cleaned,
        '55' + cleaned,
        cleaned.startsWith('55') ? cleaned.substring(2) : cleaned,
        cleaned.slice(-11),
        cleaned.slice(-10),
        cleaned.slice(-9),
        cleaned.slice(-8),
        phoneKey
    ];
    
    for (const variation of possibleVariations) {
        const indexedKey = phoneIndex.get(variation) || phoneVariations.get(variation);
        if (indexedKey) {
            conversation = conversations.get(indexedKey);
            if (conversation) {
                console.log('✅ Conversa encontrada (índice):', indexedKey);
                registerPhoneUniversal(phone, indexedKey);
                return conversation;
            }
        }
    }
    
    // 3. Busca exaustiva em TODAS as conversas
    for (const [key, conv] of conversations.entries()) {
        if (key === phoneKey || key.endsWith(phoneKey.slice(-6))) {
            console.log('✅ Conversa encontrada (busca exaustiva):', key);
            registerPhoneUniversal(phone, key);
            return conv;
        }
    }
    
    console.log('❌ Conversa não encontrada:', phoneKey);
    addLog('CONVERSATION_NOT_FOUND', `❌ Conversa não encontrada: ${phoneKey}`, {
        searched: phone,
        normalizedKey: phoneKey,
        activeConversations: conversations.size
    });
    
    return null;
}

// ============ PERSISTÊNCIA ============

async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe');
    }
}

async function saveLeadLocks() {
    try {
        await ensureDataDir();
        const data = Array.from(leadInstanceLocks.entries());
        await fs.writeFile(LEAD_LOCKS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Erro ao salvar lead locks:', error);
    }
}

async function loadLeadLocks() {
    try {
        const data = await fs.readFile(LEAD_LOCKS_FILE, 'utf8');
        const entries = JSON.parse(data);
        leadInstanceLocks.clear();
        entries.forEach(([key, value]) => {
            leadInstanceLocks.set(key, {
                ...value,
                lockedAt: new Date(value.lockedAt),
                firstMessageAt: new Date(value.firstMessageAt)
            });
        });
        console.log('Lead locks carregados:', leadInstanceLocks.size);
    } catch (error) {
        console.log('Nenhum lead lock anterior');
    }
}

async function saveMessageControl() {
    try {
        await ensureDataDir();
        const data = Array.from(messageControl.entries()).map(([key, value]) => [
            key,
            {
                messages: Array.from(value.messages),
                lastSent: value.lastSent,
                history: value.history
            }
        ]);
        await fs.writeFile(MESSAGE_CONTROL_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Erro ao salvar message control:', error);
    }
}

async function loadMessageControl() {
    try {
        const data = await fs.readFile(MESSAGE_CONTROL_FILE, 'utf8');
        const entries = JSON.parse(data);
        messageControl.clear();
        entries.forEach(([key, value]) => {
            messageControl.set(key, {
                messages: new Set(value.messages),
                lastSent: new Date(value.lastSent),
                history: value.history.map(h => ({
                    ...h,
                    sentAt: new Date(h.sentAt)
                }))
            });
        });
        console.log('Message control carregado:', messageControl.size);
    } catch (error) {
        console.log('Nenhum message control anterior');
    }
}

async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', 'Funis salvos: ' + funnelsArray.length);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar funis: ' + error.message);
    }
}

async function loadFunnelsFromFile() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelsArray = JSON.parse(data);
        
        funis.clear();
        funnelsArray.forEach(funnel => {
            if (funnel.id.startsWith('CS_') || funnel.id.startsWith('FAB_')) {
                funis.set(funnel.id, funnel);
            }
        });
        
        addLog('DATA_LOAD', 'Funis carregados: ' + funis.size);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Usando funis padrão');
        return false;
    }
}

async function saveConversationsToFile() {
    try {
        await ensureDataDir();
        const conversationsArray = Array.from(conversations.entries()).map(([key, value]) => ({
            phoneKey: key,
            ...value,
            createdAt: value.createdAt.toISOString(),
            lastSystemMessage: value.lastSystemMessage ? value.lastSystemMessage.toISOString() : null,
            lastReply: value.lastReply ? value.lastReply.toISOString() : null,
            completedAt: value.completedAt ? value.completedAt.toISOString() : null,
            canceledAt: value.canceledAt ? value.canceledAt.toISOString() : null
        }));
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            phoneIndex: Array.from(phoneIndex.entries()),
            phoneVariations: Array.from(phoneVariations.entries()),
            leadInstanceLocks: Array.from(leadInstanceLocks.entries())
        }, null, 2));
        
        addLog('DATA_SAVE', 'Conversas salvas: ' + conversationsArray.length);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar conversas: ' + error.message);
    }
}

async function loadConversationsFromFile() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        conversations.clear();
        parsed.conversations.forEach(conv => {
            conversations.set(conv.phoneKey, {
                ...conv,
                createdAt: new Date(conv.createdAt),
                lastSystemMessage: conv.lastSystemMessage ? new Date(conv.lastSystemMessage) : null,
                lastReply: conv.lastReply ? new Date(conv.lastReply) : null,
                completedAt: conv.completedAt ? new Date(conv.completedAt) : null,
                canceledAt: conv.canceledAt ? new Date(conv.canceledAt) : null
            });
        });
        
        phoneIndex.clear();
        if (parsed.phoneIndex) {
            parsed.phoneIndex.forEach(([key, value]) => phoneIndex.set(key, value));
        }
        
        phoneVariations.clear();
        if (parsed.phoneVariations) {
            parsed.phoneVariations.forEach(([key, value]) => phoneVariations.set(key, value));
        }
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior');
        return false;
    }
}

// Salvar periodicamente
setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
    await saveLeadLocks();
    await saveMessageControl();
}, 30000);

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Parabéns! Seu pedido foi aprovado. Bem-vindo ao CS!',
                waitForReply: true
            },
            {
                id: 'step_1',
                type: 'text',
                text: 'Obrigado pela resposta! Agora me confirma se recebeu o acesso ao curso por email?',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Perfeito! Lembre-se de acessar nossa plataforma. Qualquer dúvida, estamos aqui!'
            },
            {
                id: 'step_3',
                type: 'delay',
                delaySeconds: 420
            },
            {
                id: 'step_4',
                type: 'text',
                text: 'Já está conseguindo acessar o conteúdo? Precisa de alguma ajuda?',
                waitForReply: true
            },
            {
                id: 'step_5',
                type: 'text',
                text: 'Ótimo! Aproveite o conteúdo e bons estudos!'
            }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Seu PIX foi gerado! Aguardamos o pagamento para liberar o acesso ao CS.',
                waitForReply: true
            },
            {
                id: 'step_1',
                type: 'text',
                text: 'Obrigado pelo contato! Me confirma que está com dificuldades no pagamento?',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Se precisar de ajuda com o pagamento, nossa equipe está disponível!'
            },
            {
                id: 'step_3',
                type: 'delay',
                delaySeconds: 1500
            },
            {
                id: 'step_4',
                type: 'text',
                text: 'Ainda não identificamos seu pagamento. Lembre-se que o PIX tem validade limitada.'
            }
        ]
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA',
        name: 'FAB - Compra Aprovada',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Parabéns! Seu pedido FAB foi aprovado. Bem-vindo!',
                waitForReply: true
            },
            {
                id: 'step_1',
                type: 'text',
                text: 'Obrigado pela resposta! Confirma se recebeu o acesso ao FAB por email?',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Perfeito! Aproveite o conteúdo FAB. Qualquer dúvida, estamos aqui!'
            }
        ]
    },
    'FAB_PIX': {
        id: 'FAB_PIX',
        name: 'FAB - PIX Pendente',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Seu PIX FAB foi gerado! Aguardamos o pagamento.',
                waitForReply: true
            },
            {
                id: 'step_1',
                type: 'text',
                text: 'Obrigado pelo contato! Está com dificuldades no pagamento?',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Nossa equipe está disponível para ajudar com o pagamento!'
            }
        ]
    }
};

Object.values(defaultFunnels).forEach(funnel => funis.set(funnel.id, funnel));

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============

function phoneToRemoteJid(phone) {
    const cleaned = phone.replace(/\D/g, '');
    let formatted = cleaned;
    
    if (!formatted.startsWith('55')) {
        formatted = '55' + formatted;
    }
    
    if (formatted.length === 12) {
        const ddd = formatted.substring(2, 4);
        const numero = formatted.substring(4);
        formatted = '55' + ddd + '9' + numero;
    }
    
    return formatted + '@s.whatsapp.net';
}

function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    return '[MENSAGEM]';
}

function addLog(type, message, data = null) {
    const log = {
        id: Date.now() + Math.random(),
        timestamp: new Date(),
        type,
        message,
        data
    };
    logs.unshift(log);
    if (logs.length > 1000) logs = logs.slice(0, 1000);
    console.log('[' + log.timestamp.toISOString() + '] ' + type + ': ' + message);
}

// ============ SISTEMA DE LOCK ============
async function acquireWebhookLock(phoneKey, timeout = 10000) {
    const startTime = Date.now();
    
    while (webhookLocks.get(phoneKey)) {
        if (Date.now() - startTime > timeout) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `Timeout esperando lock webhook para ${phoneKey}`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    webhookLocks.set(phoneKey, true);
    addLog('WEBHOOK_LOCK_ACQUIRED', `Lock webhook adquirido para ${phoneKey}`);
    return true;
}

function releaseWebhookLock(phoneKey) {
    webhookLocks.delete(phoneKey);
    addLog('WEBHOOK_LOCK_RELEASED', `Lock webhook liberado para ${phoneKey}`);
}

// ============ EVOLUTION API ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    try {
        addLog('EVOLUTION_REQUEST', `Enviando para ${instanceName}`, { 
            url, 
            endpoint,
            payloadKeys: Object.keys(payload)
        });
        
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 15000
        });
        
        addLog('EVOLUTION_SUCCESS', `Resposta OK de ${instanceName}`, { 
            status: response.status 
        });
        
        return { ok: true, data: response.data };
    } catch (error) {
        addLog('EVOLUTION_ERROR', `Erro ao enviar para ${instanceName}`, { 
            url,
            status: error.response?.status,
            error: error.response?.data || error.message,
            code: error.code
        });
        
        return { 
            ok: false, 
            error: error.response?.data || error.message,
            status: error.response?.status
        };
    }
}

async function sendText(remoteJid, text, instanceName) {
    return await sendToEvolution(instanceName, '/message/sendText', {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: text
    });
}

async function sendImage(remoteJid, imageUrl, caption, instanceName) {
    return await sendToEvolution(instanceName, '/message/sendMedia', {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'image',
        media: imageUrl,
        caption: caption || ''
    });
}

async function sendVideo(remoteJid, videoUrl, caption, instanceName) {
    return await sendToEvolution(instanceName, '/message/sendMedia', {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'video',
        media: videoUrl,
        caption: caption || ''
    });
}

async function sendAudio(remoteJid, audioUrl, instanceName) {
    try {
        addLog('AUDIO_SEND_START', `Enviando áudio para ${remoteJid}`, { instanceName });
        
        // Tenta enviar diretamente com URL
        const result = await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioUrl,
            delay: 1200
        });
        
        if (result.ok) {
            addLog('AUDIO_SENT_SUCCESS', `Áudio enviado com sucesso`, { instanceName });
            return result;
        }
        
        // Se falhar, tenta baixar e converter
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');
        const audioBase64 = `data:audio/mpeg;base64,${base64Audio}`;
        
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioBase64,
            delay: 1200,
            encoding: true
        });
        
    } catch (error) {
        addLog('AUDIO_ERROR', `Erro ao enviar áudio: ${error.message}`, { 
            instanceName,
            error: error.message 
        });
        return { ok: false, error: error.message };
    }
}

// ============ ENVIO COM SEGURANÇA MÁXIMA ============
async function sendWithSecurityMax(phoneKey, remoteJid, type, text, mediaUrl, stepId, funnelId) {
    // 1. Verificar se pode enviar esta mensagem
    if (!canSendMessage(phoneKey, stepId, funnelId)) {
        console.log('🚫 Mensagem bloqueada - já enviada nas últimas 24h');
        return { success: false, error: 'MESSAGE_ALREADY_SENT' };
    }
    
    // 2. Obter instância travada ou selecionar nova
    let instanceName = getLockedInstance(phoneKey);
    
    if (!instanceName) {
        // Primeira mensagem - selecionar instância de forma balanceada
        const randomIndex = Math.floor(Math.random() * INSTANCES.length);
        instanceName = INSTANCES[randomIndex];
        lockLeadToInstance(phoneKey, instanceName);
    }
    
    console.log('📤 Enviando para instância TRAVADA:', instanceName);
    
    // 3. Tentar enviar APENAS UMA VEZ na instância travada
    let result;
    
    try {
        if (type === 'text') {
            result = await sendText(remoteJid, text, instanceName);
        } else if (type === 'image') {
            result = await sendImage(remoteJid, mediaUrl, '', instanceName);
        } else if (type === 'image+text') {
            result = await sendImage(remoteJid, mediaUrl, text, instanceName);
        } else if (type === 'video') {
            result = await sendVideo(remoteJid, mediaUrl, '', instanceName);
        } else if (type === 'video+text') {
            result = await sendVideo(remoteJid, mediaUrl, text, instanceName);
        } else if (type === 'audio') {
            result = await sendAudio(remoteJid, mediaUrl, instanceName);
        }
        
        if (result && result.ok) {
            // Atualizar contador de mensagens no lock
            const lock = leadInstanceLocks.get(phoneKey);
            if (lock) {
                lock.totalMessages++;
                leadInstanceLocks.set(phoneKey, lock);
            }
            
            addLog('SEND_SUCCESS_SECURE', `✅ Mensagem enviada com segurança via ${instanceName}`, { 
                phoneKey, 
                type,
                stepId,
                instance: instanceName
            });
            
            return { success: true, instanceName };
        }
        
    } catch (error) {
        console.error('Erro ao enviar:', error);
    }
    
    // 4. Se falhou, NÃO tentar outra instância - registrar erro
    const errorMsg = result?.error || 'Falha ao enviar mensagem';
    registerSendError(phoneKey, instanceName, errorMsg, stepId);
    
    addLog('SEND_FAILED_SECURE', `❌ FALHA DEFINITIVA - Não será reenviado`, { 
        phoneKey,
        instanceName,
        error: errorMsg,
        stepId
    });
    
    return { success: false, error: errorMsg, requiresManualAction: true };
}

// ============ ORQUESTRAÇÃO ============

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    console.log('🔴 PIX Waiting - phoneKey:', phoneKey);
    
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId: productType + '_PIX',
        stepIndex: -1,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        pixWaiting: true,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    
    // Registrar todas as variações do telefone
    registerPhoneUniversal(remoteJid.split('@')[0], phoneKey);
    
    addLog('PIX_WAITING_CREATED', `PIX em espera para ${phoneKey}`, { orderCode, productType });
    
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.orderCode === orderCode && !conv.canceled && conv.pixWaiting) {
            addLog('PIX_TIMEOUT_TRIGGERED', `Timeout PIX disparado para ${phoneKey}`, { orderCode });
            
            conv.pixWaiting = false;
            conv.stepIndex = 0;
            conversations.set(phoneKey, conv);
            
            await sendStep(phoneKey);
        }
        pixTimeouts.delete(phoneKey);
    }, PIX_TIMEOUT);
    
    pixTimeouts.set(phoneKey, { timeout, orderCode, createdAt: new Date() });
}

async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    const pixConv = conversations.get(phoneKey);
    
    if (pixConv) {
        pixConv.canceled = true;
        pixConv.canceledAt = new Date();
        pixConv.cancelReason = 'PAYMENT_APPROVED';
        conversations.set(phoneKey, pixConv);
    }
    
    const pixTimeout = pixTimeouts.get(phoneKey);
    if (pixTimeout) {
        clearTimeout(pixTimeout.timeout);
        pixTimeouts.delete(phoneKey);
    }
    
    let startingStep = 0;
    
    if (pixConv && pixConv.stepIndex >= 0) {
        startingStep = 3;
        addLog('TRANSFER_SKIP_SIMILAR', `Cliente já interagiu, começando passo 3`, { phoneKey });
    }
    
    const approvedConv = {
        phoneKey,
        remoteJid,
        funnelId: productType + '_APROVADA',
        stepIndex: startingStep,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false,
        transferredFromPix: true
    };
    
    conversations.set(phoneKey, approvedConv);
    
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido para APROVADA`, { phoneKey, startingStep, productType });
    
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount) {
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId,
        stepIndex: 0,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    
    // Registrar todas as variações do telefone
    registerPhoneUniversal(remoteJid.split('@')[0], phoneKey);
    
    addLog('FUNNEL_START', `Iniciando ${funnelId} para ${phoneKey}`, { orderCode });
    
    await sendStep(phoneKey);
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled) return;
    
    if (conversation.pixWaiting) {
        addLog('STEP_PIX_WAITING', `Aguardando timeout PIX`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const stepId = `step_${conversation.stepIndex}`;
    
    addLog('STEP_SEND_START', `Enviando passo ${conversation.stepIndex}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepType: step.type,
        stepId
    });
    
    let result = { success: true };
    
    // Aplicar delays
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `Aguardando ${delaySeconds}s antes de enviar`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    if (step.showTyping) {
        addLog('STEP_SHOW_TYPING', `Mostrando "digitando..." por 3s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Processar tipo de mensagem
    if (step.type === 'delay') {
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', `Delay de ${delaySeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    } else {
        // USAR SISTEMA DE SEGURANÇA MÁXIMA
        result = await sendWithSecurityMax(
            phoneKey, 
            conversation.remoteJid, 
            step.type, 
            step.text, 
            step.mediaUrl,
            stepId,
            conversation.funnelId
        );
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            addLog('STEP_WAITING_REPLY', `✅ Aguardando resposta passo ${conversation.stepIndex}`, { 
                phoneKey,
                waiting_for_response: true 
            });
        } else {
            conversations.set(phoneKey, conversation);
            addLog('STEP_AUTO_ADVANCE', `Avançando automaticamente`, { phoneKey });
            await advanceConversation(phoneKey, null, 'auto');
        }
    } else {
        if (result.requiresManualAction) {
            conversation.hasError = true;
            conversation.errorMessage = result.error;
            conversation.requiresManualAction = true;
            conversations.set(phoneKey, conversation);
            
            addLog('CONVERSATION_ERROR', `❌ Conversa marcada com erro - requer ação manual`, { 
                phoneKey,
                error: result.error
            });
        }
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const nextStepIndex = conversation.stepIndex + 1;
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', `Funil ${conversation.funnelId} concluído`, { phoneKey });
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(phoneKey, conversation);
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(phoneKey, conversation);
    addLog('STEP_ADVANCE', `Avançando para passo ${nextStepIndex}`, { phoneKey, reason });
    
    await sendStep(phoneKey);
}

// ============ WEBHOOKS ============

// WEBHOOK KIRVANO
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        const event = String(data.event || '').toUpperCase();
        const status = String(data.status || data.payment_status || '').toUpperCase();
        const method = String(data.payment?.method || data.payment_method || '').toUpperCase();
        
        const saleId = data.sale_id || data.checkout_id;
        const orderCode = saleId || 'ORDER_' + Date.now();
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        
        const phoneKey = normalizePhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhoneUniversal(customerPhone, phoneKey);
        
        const productId = data.product_id || data.products?.[0]?.id;
        const productType = PRODUCT_MAPPING[productId] || 'CS';
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, { orderCode, phoneKey, method, productType });
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            const existingConv = findConversationUniversal(customerPhone);
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
            } else {
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', orderCode, customerName, productType, totalPrice);
            }
        } else if (isPix && event.includes('GENERATED')) {
            const existingConv = findConversationUniversal(customerPhone);
            if (existingConv && !existingConv.canceled) {
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
        }
        
        res.json({ success: true, phoneKey });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK PERFECTPAY
app.post('/webhook/perfectpay', async (req, res) => {
    try {
        const data = req.body;
        
        const statusEnum = parseInt(data.sale_status_enum);
        const saleCode = data.code;
        const productCode = data.product?.code;
        const planCode = data.plan?.code;
        const customerName = data.customer?.full_name || 'Cliente';
        const phoneAreaCode = data.customer?.phone_area_code || '';
        const phoneNumber = data.customer?.phone_number || '';
        const customerPhone = phoneAreaCode + phoneNumber;
        const saleAmount = data.sale_amount || 0;
        const totalPrice = 'R$ ' + (saleAmount / 100).toFixed(2).replace('.', ',');
        const paymentType = parseInt(data.payment_type_enum || 0);
        
        const phoneKey = normalizePhoneKey(customerPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhoneUniversal(customerPhone, phoneKey);
        
        const productType = identifyPerfectPayProduct(productCode, planCode);
        
        addLog('PERFECTPAY_WEBHOOK', `Status ${statusEnum}`, { 
            saleCode, 
            phoneKey, 
            productType,
            paymentType
        });
        
        if (statusEnum === 2) {
            const existingConv = findConversationUniversal(customerPhone);
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                await transferPixToApproved(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
            } else {
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', saleCode, customerName, productType, totalPrice);
            }
            
            res.json({ success: true, phoneKey, productType, action: 'approved' });
        }
        else if (statusEnum === 1 && paymentType !== 2) {
            const existingConv = findConversationUniversal(customerPhone);
            
            if (existingConv && !existingConv.canceled) {
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            await createPixWaitingConversation(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
            
            res.json({ success: true, phoneKey, productType, action: 'pix_waiting' });
        }
        else {
            res.json({ success: true, phoneKey, productType, action: 'status_' + statusEnum });
        }
        
    } catch (error) {
        addLog('PERFECTPAY_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK EVOLUTION
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const event = data.event;
        
        // Ignorar eventos que não são mensagens
        if (event && !event.includes('message')) {
            return res.json({ success: true });
        }
        
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        if (fromMe) {
            return res.json({ success: true });
        }
        
        const incomingPhone = remoteJid.split('@')[0];
        const phoneKey = normalizePhoneKey(incomingPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: true });
        }
        
        addLog('EVOLUTION_MESSAGE', `Mensagem recebida de ${phoneKey}`, {
            text: messageText.substring(0, 50)
        });
        
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            const conversation = findConversationUniversal(incomingPhone);
            
            if (!conversation || conversation.canceled || conversation.pixWaiting || !conversation.waiting_for_response) {
                return res.json({ success: true });
            }
            
            addLog('CLIENT_REPLY', `✅ Resposta processada`, { 
                phoneKey, 
                stepIndex: conversation.stepIndex
            });
            
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversations.set(phoneKey, conversation);
            
            await advanceConversation(phoneKey, messageText, 'reply');
            
            res.json({ success: true });
            
        } finally {
            releaseWebhookLock(phoneKey);
        }
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

app.get('/api/dashboard', (req, res) => {
    let activeCount = 0, waitingCount = 0, completedCount = 0, errorCount = 0;
    
    conversations.forEach(conv => {
        if (conv.completed) completedCount++;
        else if (conv.hasError || conv.requiresManualAction) errorCount++;
        else if (conv.waiting_for_response) waitingCount++;
        else activeCount++;
    });
    
    res.json({
        success: true,
        data: {
            active_conversations: activeCount,
            waiting_responses: waitingCount,
            completed_conversations: completedCount,
            error_conversations: errorCount,
            pending_pix: pixTimeouts.size,
            total_funnels: funis.size,
            lead_locks: leadInstanceLocks.size,
            message_control: messageControl.size,
            errors_pending: sendErrors.size
        }
    });
});

app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([phoneKey, conv]) => ({
        id: phoneKey,
        phone: conv.remoteJid.replace('@s.whatsapp.net', ''),
        phoneKey: phoneKey,
        customerName: conv.customerName,
        productType: conv.productType,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        pixWaiting: conv.pixWaiting || false,
        createdAt: conv.createdAt,
        orderCode: conv.orderCode,
        amount: conv.amount,
        lockedInstance: getLockedInstance(phoneKey),
        canceled: conv.canceled || false,
        completed: conv.completed || false,
        hasError: conv.hasError || false,
        requiresManualAction: conv.requiresManualAction || false,
        errorMessage: conv.errorMessage
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, data: conversationsList });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        message: log.message
    }));
    
    res.json({ success: true, data: recentLogs });
});

app.get('/api/errors', (req, res) => {
    const errorsList = [];
    
    sendErrors.forEach((errors, phoneKey) => {
        errors.forEach(error => {
            if (!error.resolved) {
                errorsList.push({
                    phoneKey,
                    ...error
                });
            }
        });
    });
    
    res.json({ success: true, data: errorsList });
});

app.get('/api/lead-locks', (req, res) => {
    const locks = Array.from(leadInstanceLocks.entries()).map(([phoneKey, lock]) => ({
        phoneKey,
        ...lock
    }));
    
    res.json({ success: true, data: locks });
});

app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values());
    res.json({ success: true, data: funnelsList });
});

app.post('/api/funnels', async (req, res) => {
    try {
        const funnel = req.body;
        
        if (!funnel.id || !funnel.name || !funnel.steps) {
            return res.status(400).json({ 
                success: false, 
                error: 'Campos obrigatórios: id, name, steps' 
            });
        }
        
        funis.set(funnel.id, funnel);
        await saveFunnelsToFile();
        
        res.json({ 
            success: true, 
            message: 'Funil salvo com sucesso', 
            data: funnel 
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ INICIALIZAÇÃO ============
async function initializeData() {
    console.log('🔄 Carregando dados...');
    
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    await loadLeadLocks();
    await loadMessageControl();
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('🔒 Lead Locks:', leadInstanceLocks.size);
    console.log('📝 Message Control:', messageControl.size);
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🛡️ KIRVANO v6.0 - SEGURANÇA MÁXIMA');
    console.log('='.repeat(70));
    console.log('✅ Porta:', PORT);
    console.log('✅ Evolution:', EVOLUTION_BASE_URL);
    console.log('✅ Instâncias:', INSTANCES.length);
    console.log('');
    console.log('🔒 SISTEMA DE SEGURANÇA:');
    console.log('  ✅ Trava Eterna de Instância');
    console.log('  ✅ Controle Anti-Duplicata 24h');
    console.log('  ✅ Busca Universal Melhorada');
    console.log('  ✅ Sem Fallback (Segurança Máxima)');
    console.log('  ✅ Registro de Erros');
    console.log('  ✅ Notificação de Admin');
    console.log('');
    console.log('⚠️ COMPORTAMENTO:');
    console.log('  • Lead trava em UMA instância PARA SEMPRE');
    console.log('  • Se instância falhar, NÃO tenta outra');
    console.log('  • Mensagens bloqueadas por 24h após envio');
    console.log('  • Erros requerem ação manual');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('📊 Erros: http://localhost:' + PORT + '/api/errors');
    console.log('🔒 Locks: http://localhost:' + PORT + '/api/lead-locks');
    console.log('='.repeat(70));
    
    await initializeData();
});
