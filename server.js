const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');
const MESSAGE_BLOCK_TIME = 60000; // 60 segundos de bloqueio por mensagem

// ============ MAPEAMENTO DE PRODUTOS ============

// Kirvano - Mapeamento por offer_id
const PRODUCT_MAPPING = {
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS',
    '564bb9bb-718a-4e8b-a843-a2da62f616f0': 'CS',
    '668a73bc-2fca-4f12-9331-ef945181cd5c': 'FAB'
};

// ✨ PERFECTPAY - Mapeamento
const PERFECTPAY_PLANS = {
    'PPLQQNCF7': 'CS',  // ZAP VIP - CS 19
    'PPLQQNCF8': 'CS',  // ZAP VIP - CS 29
};

const PERFECTPAY_PRODUCTS = {
    'PPU38CQ0GE8': 'CS',  // ZAP VIP (fallback)
};

// Função para identificar produto PerfectPay
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
let phoneIndex = new Map();
let phoneVariations = new Map();
let lidMapping = new Map();
let phoneToLid = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

// 🔥 Sistema de bloqueio de mensagens duplicadas
let sentMessagesHash = new Map();
let messageBlockTimers = new Map();

// ============ 💰 SISTEMA DE VARIÁVEIS DINÂMICAS ============

function replaceVariables(text, conversation) {
    if (!text || !conversation) return text;
    
    let result = text;
    
    // {PIX_LINK} - Link do PIX gerado
    if (conversation.pixLink) {
        result = result.replace(/\{PIX_LINK\}/g, conversation.pixLink);
    }
    
    // {NOME_CLIENTE} - Nome do cliente
    if (conversation.customerName) {
        result = result.replace(/\{NOME_CLIENTE\}/g, conversation.customerName);
        result = result.replace(/\{NOME\}/g, conversation.customerName);
    }
    
    // {VALOR} - Valor da compra
    if (conversation.amount) {
        result = result.replace(/\{VALOR\}/g, conversation.amount);
    }
    
    // {PRODUTO} - Tipo do produto
    if (conversation.productType) {
        result = result.replace(/\{PRODUTO\}/g, conversation.productType);
    }
    
    return result;
}

// ============ 🔥 SISTEMA DE HASH MELHORADO ============

function generateMessageHashImproved(phoneKey, step, conversation) {
    // Gera hash ANTES de substituir variáveis
    // Usa: phoneKey + tipo + template original (sem variáveis substituídas)
    const baseContent = step.text || step.mediaUrl || '';
    const data = `${phoneKey}|${step.type}|${baseContent}|${step.id}`;
    return crypto.createHash('md5').update(data).digest('hex');
}

function isMessageBlocked(phoneKey, step, conversation) {
    const hash = generateMessageHashImproved(phoneKey, step, conversation);
    
    const lastSent = messageBlockTimers.get(hash);
    if (lastSent) {
        const timeSince = Date.now() - lastSent;
        if (timeSince < MESSAGE_BLOCK_TIME) {
            console.log(`🚫 MENSAGEM BLOQUEADA - Enviada há ${Math.round(timeSince/1000)}s`, {
                phoneKey,
                hash: hash.substring(0, 8),
                stepId: step.id,
                type: step.type
            });
            return true;
        }
    }
    
    return false;
}

function registerSentMessage(phoneKey, step, conversation) {
    const hash = generateMessageHashImproved(phoneKey, step, conversation);
    
    messageBlockTimers.set(hash, Date.now());
    
    if (!sentMessagesHash.has(phoneKey)) {
        sentMessagesHash.set(phoneKey, new Set());
    }
    sentMessagesHash.get(phoneKey).add(hash);
    
    console.log('✅ Mensagem registrada no bloqueio', {
        phoneKey,
        hash: hash.substring(0, 8),
        stepId: step.id,
        total: sentMessagesHash.get(phoneKey).size
    });
    
    addLog('MESSAGE_REGISTERED', `Mensagem bloqueada por 60s`, {
        phoneKey,
        hash: hash.substring(0, 8),
        stepId: step.id
    });
}

setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [hash, timestamp] of messageBlockTimers.entries()) {
        if (now - timestamp > MESSAGE_BLOCK_TIME) {
            messageBlockTimers.delete(hash);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`🧹 Limpeza: ${cleanedCount} bloqueios expirados removidos`);
    }
}, 120000);

// ============ SISTEMA DE NORMALIZAÇÃO UNIVERSAL ULTRA ROBUSTO ============

function normalizePhoneKey(phone) {
    if (!phone) return null;
    
    let cleaned = String(phone)
        .split('@')[0]
        .replace(/\D/g, '');
    
    if (cleaned.length < 8) {
        console.log('❌ Telefone muito curto:', phone);
        return null;
    }
    
    const phoneKey = cleaned.slice(-8);
    
    console.log('📱 Normalização:', {
        entrada: phone,
        limpo: cleaned,
        phoneKey: phoneKey
    });
    
    return phoneKey;
}

function generateAllPhoneVariations(fullPhone) {
    const cleaned = String(fullPhone)
        .split('@')[0]
        .replace(/\D/g, '');
    
    if (cleaned.length < 8) return [];
    
    const variations = new Set();
    
    variations.add(cleaned);
    
    if (!cleaned.startsWith('55')) {
        variations.add('55' + cleaned);
    }
    
    if (cleaned.startsWith('55') && cleaned.length > 2) {
        variations.add(cleaned.substring(2));
    }
    
    for (let i = 8; i <= Math.min(13, cleaned.length); i++) {
        const lastN = cleaned.slice(-i);
        variations.add(lastN);
        
        if (!lastN.startsWith('55')) {
            variations.add('55' + lastN);
        }
    }
    
    if (cleaned.length >= 11) {
        const ddd = cleaned.slice(-11, -9);
        const numero = cleaned.slice(-9);
        
        if (numero.length === 9 && numero[0] === '9') {
            const semNove = ddd + numero.substring(1);
            variations.add(semNove);
            variations.add('55' + semNove);
            
            for (let i = 8; i <= semNove.length; i++) {
                variations.add(semNove.slice(-i));
            }
        }
        
        if (numero.length === 8 || (numero.length === 9 && numero[0] !== '9')) {
            const comNove = ddd + '9' + numero;
            variations.add(comNove);
            variations.add('55' + comNove);
            
            for (let i = 8; i <= comNove.length; i++) {
                variations.add(comNove.slice(-i));
            }
        }
    }
    
    if (cleaned.length === 12 && cleaned.startsWith('55')) {
        const ddd = cleaned.substring(2, 4);
        const numero = cleaned.substring(4);
        const comNove = '55' + ddd + '9' + numero;
        
        variations.add(comNove);
        variations.add(comNove.substring(2));
        
        for (let i = 8; i <= comNove.length; i++) {
            variations.add(comNove.slice(-i));
        }
    }
    
    if (cleaned.length === 13 && cleaned.startsWith('55')) {
        const ddd = cleaned.substring(2, 4);
        const numeroComNove = cleaned.substring(4);
        const numeroSemNove = cleaned.substring(0, 4) + cleaned.substring(5);
        
        variations.add(numeroSemNove);
        variations.add(numeroSemNove.substring(2));
        
        for (let i = 8; i <= numeroSemNove.length; i++) {
            variations.add(numeroSemNove.slice(-i));
        }
    }
    
    const validVariations = Array.from(variations).filter(v => v && v.length >= 8);
    
    console.log(`🔢 Geradas ${validVariations.length} variações para ${cleaned}`);
    
    return validVariations;
}

function registerPhoneUniversal(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) {
        console.log('❌ PhoneKey inválida para registro:', phoneKey);
        return;
    }
    
    const variations = generateAllPhoneVariations(fullPhone);
    
    let registeredCount = 0;
    
    variations.forEach(variation => {
        if (variation && variation.length >= 8) {
            phoneIndex.set(variation, phoneKey);
            phoneVariations.set(variation, phoneKey);
            registeredCount++;
        }
    });
    
    const suffixes = ['@s.whatsapp.net', '@lid', '@g.us'];
    const cleaned = String(fullPhone).split('@')[0].replace(/\D/g, '');
    
    suffixes.forEach(suffix => {
        phoneIndex.set(cleaned + suffix, phoneKey);
        phoneVariations.set(cleaned + suffix, phoneKey);
        
        variations.forEach(variation => {
            phoneIndex.set(variation + suffix, phoneKey);
            phoneVariations.set(variation + suffix, phoneKey);
            registeredCount += 2;
        });
    });
    
    console.log(`✅ Telefone ${phoneKey} registrado com ${registeredCount} variações`);
    
    addLog('PHONE_REGISTERED_ULTRA', `📱 ${registeredCount} variações registradas`, {
        phoneKey,
        total: registeredCount,
        sample: variations.slice(0, 5)
    });
}

function registerLidMapping(lidJid, phoneKey, realNumber) {
    if (!lidJid || !phoneKey) return;
    
    lidMapping.set(lidJid, phoneKey);
    phoneToLid.set(phoneKey, lidJid);
    
    const lidCleaned = lidJid.split('@')[0].replace(/\D/g, '');
    if (lidCleaned) {
        lidMapping.set(lidCleaned, phoneKey);
        lidMapping.set(lidCleaned + '@lid', phoneKey);
    }
    
    console.log('🆔 Mapeamento @lid registrado:', {
        lid: lidJid,
        phoneKey: phoneKey,
        realNumber: realNumber
    });
    
    addLog('LID_MAPPING_REGISTERED', '🆔 Mapeamento @lid criado', {
        lid: lidJid,
        phoneKey: phoneKey
    });
}

function findConversationUniversal(phone) {
    const phoneKey = normalizePhoneKey(phone);
    
    if (!phoneKey) {
        console.log('❌ Telefone inválido para busca:', phone);
        return null;
    }
    
    console.log('🔍 Iniciando busca UNIVERSAL para:', phoneKey);
    
    // NÍVEL 1: Busca direta
    let conversation = conversations.get(phoneKey);
    if (conversation) {
        console.log('✅ NÍVEL 1: Encontrado (busca direta):', phoneKey);
        registerPhoneUniversal(phone, phoneKey);
        return conversation;
    }
    
    // NÍVEL 2: Busca por variações
    const variations = generateAllPhoneVariations(phone);
    console.log(`🔍 NÍVEL 2: Testando ${variations.length} variações...`);
    
    for (const variation of variations) {
        const indexedKey = phoneIndex.get(variation);
        if (indexedKey) {
            conversation = conversations.get(indexedKey);
            if (conversation) {
                console.log('✅ NÍVEL 2: Encontrado via índice:', indexedKey, '←', variation);
                registerPhoneUniversal(phone, indexedKey);
                return conversation;
            }
        }
        
        const varKey = phoneVariations.get(variation);
        if (varKey) {
            conversation = conversations.get(varKey);
            if (conversation) {
                console.log('✅ NÍVEL 2: Encontrado via variações:', varKey, '←', variation);
                registerPhoneUniversal(phone, varKey);
                return conversation;
            }
        }
    }
    
    // NÍVEL 3: Busca com sufixos
    console.log('🔍 NÍVEL 3: Testando sufixos WhatsApp...');
    const suffixes = ['@s.whatsapp.net', '@lid', '@g.us', ''];
    
    for (const suffix of suffixes) {
        for (const variation of variations) {
            const withSuffix = variation + suffix;
            
            const indexedKey = phoneIndex.get(withSuffix) || phoneVariations.get(withSuffix);
            if (indexedKey) {
                conversation = conversations.get(indexedKey);
                if (conversation) {
                    console.log('✅ NÍVEL 3: Encontrado com sufixo:', indexedKey, '←', withSuffix);
                    registerPhoneUniversal(phone, indexedKey);
                    return conversation;
                }
            }
        }
    }
    
    // NÍVEL 4: Busca exaustiva
    console.log('🔍 NÍVEL 4: Busca exaustiva em', conversations.size, 'conversas...');
    
    for (const [key, conv] of conversations.entries()) {
        if (key === phoneKey) {
            console.log('✅ NÍVEL 4: Match exato 8 dígitos:', key);
            registerPhoneUniversal(phone, key);
            return conv;
        }
        
        if (key.slice(-7) === phoneKey.slice(-7)) {
            console.log('✅ NÍVEL 4: Match últimos 7 dígitos:', key);
            registerPhoneUniversal(phone, key);
            return conv;
        }
        
        if (conv.remoteJid) {
            const convPhoneKey = normalizePhoneKey(conv.remoteJid);
            if (convPhoneKey === phoneKey) {
                console.log('✅ NÍVEL 4: Match via remoteJid:', key);
                registerPhoneUniversal(phone, key);
                return conv;
            }
            
            if (convPhoneKey && convPhoneKey.slice(-7) === phoneKey.slice(-7)) {
                console.log('✅ NÍVEL 4: Match remoteJid últimos 7:', key);
                registerPhoneUniversal(phone, key);
                return conv;
            }
        }
    }
    
    // NÍVEL 5: Busca por @lid
    console.log('🔍 NÍVEL 5: Testando mapeamento @lid...');
    
    if (String(phone).includes('@lid')) {
        const mappedKey = lidMapping.get(phone);
        if (mappedKey) {
            conversation = conversations.get(mappedKey);
            if (conversation) {
                console.log('✅ NÍVEL 5: Encontrado via @lid mapping:', mappedKey, '←', phone);
                return conversation;
            }
        }
        
        const phoneCleaned = String(phone).split('@')[0];
        const mappedKey2 = lidMapping.get(phoneCleaned);
        if (mappedKey2) {
            conversation = conversations.get(mappedKey2);
            if (conversation) {
                console.log('✅ NÍVEL 5: Encontrado via @lid limpo:', mappedKey2, '←', phoneCleaned);
                return conversation;
            }
        }
    }
    
    console.log('❌ Conversa NÃO encontrada após busca ULTRA completa');
    console.log('📊 Debug completo:', {
        phoneKey,
        phoneOriginal: phone,
        variaçõesTentadas: variations.length,
        conversasAtivas: conversations.size,
        lidMappings: lidMapping.size,
        primeiras5Conversas: Array.from(conversations.keys()).slice(0, 5),
        primeiras5Variações: variations.slice(0, 5)
    });
    
    addLog('CONVERSATION_NOT_FOUND_ULTRA', `❌ Não encontrado após 5 níveis`, {
        phoneKey,
        variations: variations.length,
        activeConversations: conversations.size,
        lidMappings: lidMapping.size
    });
    
    return null;
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

// ============ PERSISTÊNCIA ============
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe');
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
            lidMapping: Array.from(lidMapping.entries()),
            phoneToLid: Array.from(phoneToLid.entries()),
            stickyInstances: Array.from(stickyInstances.entries())
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
        
        lidMapping.clear();
        if (parsed.lidMapping) {
            parsed.lidMapping.forEach(([key, value]) => lidMapping.set(key, value));
        }
        
        phoneToLid.clear();
        if (parsed.phoneToLid) {
            parsed.phoneToLid.forEach(([key, value]) => phoneToLid.set(key, value));
        }
        
        stickyInstances.clear();
        if (parsed.stickyInstances) {
            parsed.stickyInstances.forEach(([key, value]) => stickyInstances.set(key, value));
        }
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length);
        addLog('DATA_LOAD', 'Índices: phoneIndex=' + phoneIndex.size + ', variations=' + phoneVariations.size + ', @lid=' + lidMapping.size);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior');
        return false;
    }
}

setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

// ============ 🔧 FUNIS PADRÃO (APENAS COMO BACKUP SE O ARQUIVO NÃO EXISTIR) ============
// ⚠️ ESTES FUNIS SÃO APENAS FALLBACK - OS FUNIS SALVOS NO EDITOR TÊM PRIORIDADE
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'audio',
                text: '',
                mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/11/1760064923462120438-321585629761702-1.mp3',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Posso te colocar no Grupo e mandar o seu acesso VIP por aqui mesmo amor? 😍',
                mediaUrl: '',
                waitForReply: true,
                showTyping: true,
                delayBefore: '18'
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Clica aqui que a Marina te coloca agora la dentro 👇🏻\n\nhttps://t.me/Marina_Talbot\n',
                mediaUrl: '',
                waitForReply: false,
                showTyping: true,
                delayBefore: '19'
            },
            {
                id: 'step_4',
                type: 'text',
                text: 'Caso você não esteja conseguindo digitar agora, só aguardar q já já libera pra você ta bom? é pq vc acabou de entrar, aí é normal',
                mediaUrl: '',
                waitForReply: true,
                showTyping: true,
                delayBefore: '10'
            },
            {
                id: 'step_5',
                type: 'delay',
                text: '',
                mediaUrl: '',
                waitForReply: false,
                delaySeconds: '450'
            },
            {
                id: 'step_6',
                type: 'audio',
                text: '',
                mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/11/1764027713284340189-337817154416728.mp3',
                waitForReply: false,
                showTyping: true,
                delayBefore: '11'
            }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'audio',
                text: '',
                mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/10/1760471702347619808-323251706671257.ogg',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Ok, pera...',
                mediaUrl: '',
                waitForReply: false,
                delayBefore: '12',
                showTyping: true
            }
        ]
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA',
        name: 'FAB - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'audio',
                text: '',
                mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/10/Design-sem-nome-_26_.mp3',
                waitForReply: true
            }
        ]
    },
    'FAB_PIX': {
        id: 'FAB_PIX',
        name: 'FAB - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'audio',
                text: '',
                mediaUrl: 'https://hotmoney.space/wp-content/uploads/2025/10/1760070558163768420-321608735174786.mp3',
                waitForReply: true
            }
        ]
    }
};

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
        addLog('AUDIO_DOWNLOAD_START', `Baixando áudio de ${audioUrl}`, { phoneKey: remoteJid });
        
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');
        const audioBase64 = `data:audio/mpeg;base64,${base64Audio}`;
        
        addLog('AUDIO_CONVERTED', `Áudio convertido para base64 (${Math.round(base64Audio.length / 1024)}KB)`, { phoneKey: remoteJid });
        
        const result = await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioBase64,
            delay: 1200,
            encoding: true
        });
        
        if (result.ok) {
            addLog('AUDIO_SENT_SUCCESS', `Áudio PTT enviado com sucesso`, { phoneKey: remoteJid });
            return result;
        }
        
        addLog('AUDIO_RETRY_ALTERNATIVE', `Tentando formato alternativo`, { phoneKey: remoteJid });
        
        return await sendToEvolution(instanceName, '/message/sendMedia', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            mediatype: 'audio',
            media: audioBase64,
            mimetype: 'audio/mpeg'
        });
        
    } catch (error) {
        addLog('AUDIO_ERROR', `Erro ao processar áudio: ${error.message}`, { 
            phoneKey: remoteJid,
            url: audioUrl,
            error: error.message 
        });
        
        addLog('AUDIO_FALLBACK_URL', `Usando fallback com URL direta`, { phoneKey: remoteJid });
        
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioUrl,
            delay: 1200
        });
    }
}

// ============ 🔥 ENVIO COM PROTEÇÃO ANTI-DUPLICAÇÃO MELHORADA ============
async function sendWithFallback(phoneKey, remoteJid, step, conversation, isFirstMessage = false) {
    // 🔥 PROTEÇÃO 1: Verifica se mensagem já foi enviada recentemente (USA STEP COMPLETO)
    if (isMessageBlocked(phoneKey, step, conversation)) {
        addLog('SEND_BLOCKED_DUPLICATE', `🚫 BLOQUEADO - Mensagem duplicada`, {
            phoneKey,
            stepId: step.id,
            type: step.type
        });
        return { success: false, error: 'MESSAGE_ALREADY_SENT', blocked: true };
    }
    
    // Substitui variáveis DEPOIS de gerar hash
    const finalText = replaceVariables(step.text, conversation);
    const finalMediaUrl = replaceVariables(step.mediaUrl, conversation);
    
    let instancesToTry = [...INSTANCES];
    const stickyInstance = stickyInstances.get(phoneKey);
    
    if (stickyInstance && !isFirstMessage) {
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
    } else if (isFirstMessage) {
        const nextIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
        instancesToTry = [...INSTANCES.slice(nextIndex), ...INSTANCES.slice(0, nextIndex)];
    }
    
    let lastError = null;
    const maxAttempts = 3;
    
    for (const instanceName of instancesToTry) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                let result;
                
                if (step.type === 'text') result = await sendText(remoteJid, finalText, instanceName);
                else if (step.type === 'image') result = await sendImage(remoteJid, finalMediaUrl, '', instanceName);
                else if (step.type === 'image+text') result = await sendImage(remoteJid, finalMediaUrl, finalText, instanceName);
                else if (step.type === 'video') result = await sendVideo(remoteJid, finalMediaUrl, '', instanceName);
                else if (step.type === 'video+text') result = await sendVideo(remoteJid, finalMediaUrl, finalText, instanceName);
                else if (step.type === 'audio') result = await sendAudio(remoteJid, finalMediaUrl, instanceName);
                
                if (result && result.ok) {
                    // 🔥 REGISTRA MENSAGEM ENVIADA (USA STEP COMPLETO)
                    registerSentMessage(phoneKey, step, conversation);
                    
                    stickyInstances.set(phoneKey, instanceName);
                    if (isFirstMessage) {
                        lastSuccessfulInstanceIndex = INSTANCES.indexOf(instanceName);
                    }
                    addLog('SEND_SUCCESS', `✅ Mensagem enviada via ${instanceName}`, { phoneKey, stepId: step.id, type: step.type });
                    return { success: true, instanceName };
                }
                
                lastError = result.error;
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                lastError = error.message;
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
    }
    
    addLog('SEND_ALL_FAILED', `❌ Falha total no envio para ${phoneKey}`, { lastError });
    
    const conv = conversations.get(phoneKey);
    if (conv) {
        conv.hasError = true;
        conv.errorMessage = lastError;
        conversations.set(phoneKey, conv);
    }
    
    return { success: false, error: lastError };
}

// ============ ORQUESTRAÇÃO ============

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount, pixLink, pixQrCode) {
    console.log('🔴 createPixWaitingConversation:', phoneKey);
    
    // 🔥 PROTEÇÃO 2: Verifica se já existe conversa ativa
    const existing = conversations.get(phoneKey);
    if (existing && !existing.canceled) {
        console.log('⚠️ BLOQUEADO - Conversa já existe:', phoneKey);
        addLog('PIX_CREATION_BLOCKED', '🚫 Conversa já existe', { phoneKey, orderCode });
        return;
    }
    
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId: productType + '_PIX',
        stepIndex: -1,
        orderCode,
        customerName,
        productType,
        amount,
        pixLink: pixLink || null,
        pixQrCode: pixQrCode || null,
        waiting_for_response: false,
        pixWaiting: true,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    registerPhoneUniversal(remoteJid, phoneKey);
    
    addLog('PIX_WAITING_CREATED', `PIX em espera para ${phoneKey}`, { orderCode, productType, pixLink });
    
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

// ✅ FUNÇÃO CORRIGIDA - SEMPRE COMEÇA DO PASSO 0
async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    console.log('🟢 transferPixToApproved:', phoneKey);
    
    const pixConv = conversations.get(phoneKey);
    
    const pixLink = pixConv ? pixConv.pixLink : null;
    const pixQrCode = pixConv ? pixConv.pixQrCode : null;
    
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
    
    // ✅ CORREÇÃO: Sempre começa do passo 0 (início do funil)
    const startingStep = 0;
    
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido para APROVADA, começando do passo 0`, { phoneKey, productType });
    
    const approvedConv = {
        phoneKey,
        remoteJid,
        funnelId: productType + '_APROVADA',
        stepIndex: startingStep,
        orderCode,
        customerName,
        productType,
        amount,
        pixLink: pixLink,
        pixQrCode: pixQrCode,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false,
        transferredFromPix: true
    };
    
    conversations.set(phoneKey, approvedConv);
    registerPhoneUniversal(remoteJid, phoneKey);
    
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount, pixLink, pixQrCode) {
    console.log('🔵 startFunnel:', phoneKey, funnelId);
    
    // 🔥 PROTEÇÃO 3: Verifica se já existe conversa ativa
    const existing = conversations.get(phoneKey);
    if (existing && !existing.canceled) {
        console.log('⚠️ BLOQUEADO - Conversa já existe:', phoneKey);
        addLog('FUNNEL_CREATION_BLOCKED', '🚫 Conversa já existe', { phoneKey, funnelId });
        return;
    }
    
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId,
        stepIndex: 0,
        orderCode,
        customerName,
        productType,
        amount,
        pixLink: pixLink || null,
        pixQrCode: pixQrCode || null,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    registerPhoneUniversal(remoteJid, phoneKey);
    
    addLog('FUNNEL_START', `Iniciando ${funnelId} para ${phoneKey}`, { orderCode });
    
    await sendStep(phoneKey);
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled || conversation.pixWaiting) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    
    addLog('STEP_SEND_START', `Enviando passo ${conversation.stepIndex}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepId: step.id,
        stepType: step.type
    });
    
    let result = { success: true };
    
    if (step.delayBefore && step.delayBefore > 0) {
        await new Promise(resolve => setTimeout(resolve, parseInt(step.delayBefore) * 1000));
    }
    
    if (step.showTyping && step.type !== 'delay') {
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    if (step.type === 'delay') {
        await new Promise(resolve => setTimeout(resolve, (step.delaySeconds || 10) * 1000));
    } else {
        result = await sendWithFallback(phoneKey, conversation.remoteJid, step, conversation, isFirstMessage);
        
        // 🔥 PROTEÇÃO 4: Se mensagem foi bloqueada por duplicação, não avança
        if (result.blocked) {
            addLog('STEP_BLOCKED_DUPLICATE', `🚫 Passo bloqueado por duplicação`, { phoneKey, stepId: step.id });
            return;
        }
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            console.log('✅ MARCADO waiting_for_response = TRUE');
            addLog('STEP_WAITING_REPLY', `✅ Aguardando resposta passo ${conversation.stepIndex}`, { phoneKey });
        } else {
            conversations.set(phoneKey, conversation);
            await advanceConversation(phoneKey, null, 'auto');
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
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(phoneKey, conversation);
        addLog('FUNNEL_END', `Funil concluído`, { phoneKey });
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
        
        const pixLink = data.payment?.pix_url || data.payment?.checkout_url || data.payment?.payment_url || null;
        const pixQrCode = data.payment?.qrcode_image || data.payment?.pix_qrcode || null;
        
        const phoneKey = normalizePhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhoneUniversal(customerPhone, phoneKey);
        
        const productId = data.product_id || data.products?.[0]?.id;
        const productType = PRODUCT_MAPPING[productId] || 'CS';
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, { 
            orderCode, 
            phoneKey, 
            method, 
            productType,
            pixLink: pixLink ? 'CAPTURADO' : 'N/A' 
        });
        
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
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', orderCode, customerName, productType, totalPrice, pixLink, pixQrCode);
            }
        } else if (isPix && event.includes('GENERATED')) {
            const existingConv = findConversationUniversal(customerPhone);
            if (existingConv && !existingConv.canceled) {
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice, pixLink, pixQrCode);
        }
        
        res.json({ success: true, phoneKey });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
        
        const pixLink = data.billet_url || data.checkout_url || data.pix_url || data.payment_url || null;
        const pixQrCode = data.billet_number || data.pix_qrcode || data.pix_emv || null;
        
        const phoneKey = normalizePhoneKey(customerPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('PERFECTPAY_INVALID_PHONE', 'Telefone inválido', { customerPhone, phoneKey });
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhoneUniversal(customerPhone, phoneKey);
        
        const productType = identifyPerfectPayProduct(productCode, planCode);
        
        addLog('PERFECTPAY_WEBHOOK', `Status ${statusEnum}`, { 
            saleCode, 
            phoneKey, 
            productType,
            paymentType,
            pixLink: pixLink ? 'CAPTURADO' : 'N/A'
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
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', saleCode, customerName, productType, totalPrice, pixLink, pixQrCode);
            }
            
            res.json({ success: true, phoneKey, productType, action: 'approved' });
        }
        else if (statusEnum === 1 && paymentType !== 2) {
            const existingConv = findConversationUniversal(customerPhone);
            
            if (existingConv && !existingConv.canceled) {
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            await createPixWaitingConversation(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice, pixLink, pixQrCode);
            
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

app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const event = data.event;
        
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
        
        const isLid = remoteJid.includes('@lid');
        let phoneToSearch = remoteJid;
        let lidJid = null;
        
        if (isLid) {
            lidJid = remoteJid;
            
            addLog('LID_DETECTED', '🔴 @lid detectado!', { 
                lid: remoteJid,
                hasParticipant: !!messageData.key.participant
            });
            
            if (messageData.key.participant) {
                phoneToSearch = messageData.key.participant;
                
                addLog('LID_PARTICIPANT_FOUND', '✅ Número real extraído do participant', { 
                    lid: remoteJid,
                    participant: phoneToSearch
                });
            } else {
                const mappedKey = lidMapping.get(remoteJid);
                if (mappedKey) {
                    const mappedConv = conversations.get(mappedKey);
                    if (mappedConv) {
                        phoneToSearch = mappedConv.remoteJid;
                        addLog('LID_MAPPING_USED', '✅ Usando mapping @lid existente', {
                            lid: remoteJid,
                            mappedKey: mappedKey,
                            remoteJid: phoneToSearch
                        });
                    }
                }
            }
        }
        
        const incomingPhone = phoneToSearch.split('@')[0];
        const phoneKey = normalizePhoneKey(incomingPhone);
        
        console.log('🟦 Webhook Evolution:', {
            remoteJid,
            isLid,
            phoneToSearch,
            incomingPhone,
            phoneKey,
            text: messageText.substring(0, 30)
        });
        
        addLog('EVOLUTION_MESSAGE', `Mensagem recebida${isLid ? ' (@lid)' : ''}`, {
            remoteJid,
            phoneKey,
            isLid,
            text: messageText.substring(0, 50)
        });
        
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('EVOLUTION_INVALID_PHONE', 'PhoneKey inválido', { incomingPhone, phoneKey });
            return res.json({ success: true });
        }
        
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            const conversation = findConversationUniversal(phoneToSearch);
            
            addLog('EVOLUTION_SEARCH', `Busca resultado`, {
                found: conversation ? true : false,
                phoneKey: phoneKey,
                conversationKey: conversation ? conversation.phoneKey : null,
                waiting: conversation ? conversation.waiting_for_response : null,
                isLid: isLid
            });
            
            if (conversation && isLid && lidJid) {
                registerLidMapping(lidJid, conversation.phoneKey, phoneToSearch);
            }
            
            if (!conversation || conversation.canceled || conversation.pixWaiting) {
                addLog('EVOLUTION_IGNORED', 'Conversa cancelada/inexistente/pixWaiting', { phoneKey });
                return res.json({ success: true });
            }
            
            if (!conversation.waiting_for_response) {
                addLog('EVOLUTION_NOT_WAITING', 'Não aguardando resposta', { 
                    phoneKey,
                    stepIndex: conversation.stepIndex
                });
                return res.json({ success: true });
            }
            
            console.log('✅✅✅ RESPOSTA VÁLIDA - Avançando conversa');
            
            addLog('CLIENT_REPLY', `✅ Resposta processada${isLid ? ' (@lid)' : ''}`, { 
                phoneKey, 
                text: messageText.substring(0, 50),
                stepIndex: conversation.stepIndex,
                isLid: isLid
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
    const instanceUsage = {};
    INSTANCES.forEach(inst => instanceUsage[inst] = 0);
    stickyInstances.forEach(instance => {
        if (instanceUsage[instance] !== undefined) instanceUsage[instance]++;
    });
    
    let activeCount = 0, waitingCount = 0, completedCount = 0, canceledCount = 0, errorCount = 0;
    
    conversations.forEach(conv => {
        if (conv.completed) completedCount++;
        else if (conv.canceled) canceledCount++;
        else if (conv.hasError) errorCount++;
        else if (conv.waiting_for_response) waitingCount++;
        else activeCount++;
    });
    
    res.json({
        success: true,
        data: {
            active_conversations: activeCount,
            waiting_responses: waitingCount,
            completed_conversations: completedCount,
            canceled_conversations: canceledCount,
            error_conversations: errorCount,
            pending_pix: pixTimeouts.size,
            total_funnels: funis.size,
            total_instances: INSTANCES.length,
            sticky_instances: stickyInstances.size,
            instance_distribution: instanceUsage,
            webhook_locks: webhookLocks.size,
            phone_index_size: phoneIndex.size,
            phone_variations_size: phoneVariations.size,
            lid_mappings_size: lidMapping.size,
            sent_messages_cache: sentMessagesHash.size,
            blocked_messages_count: messageBlockTimers.size
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
        pixLink: conv.pixLink || null,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        orderCode: conv.orderCode,
        amount: conv.amount,
        stickyInstance: stickyInstances.get(phoneKey),
        canceled: conv.canceled || false,
        completed: conv.completed || false,
        hasError: conv.hasError || false,
        errorMessage: conv.errorMessage,
        transferredFromPix: conv.transferredFromPix || false,
        hasLidMapping: phoneToLid.has(phoneKey)
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

app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values()).map(funnel => ({
        ...funnel,
        isDefault: funnel.id === 'CS_APROVADA' || funnel.id === 'CS_PIX' || funnel.id === 'FAB_APROVADA' || funnel.id === 'FAB_PIX',
        stepCount: funnel.steps.length
    }));
    
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
        
        if (!funnel.id.startsWith('CS_') && !funnel.id.startsWith('FAB_')) {
            return res.status(400).json({ 
                success: false, 
                error: 'Apenas funis CS e FAB são permitidos' 
            });
        }
        
        if (!Array.isArray(funnel.steps)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Steps deve ser um array' 
            });
        }
        
        funnel.steps.forEach((step, idx) => {
            if (step && !step.id) {
                step.id = 'step_' + Date.now() + '_' + idx;
            }
        });
        
        funis.set(funnel.id, funnel);
        addLog('FUNNEL_SAVED', 'Funil salvo: ' + funnel.id, {
            stepCount: funnel.steps.length
        });
        
        await saveFunnelsToFile();
        
        res.json({ 
            success: true, 
            message: 'Funil salvo com sucesso', 
            data: funnel 
        });
        
    } catch (error) {
        console.error('Erro ao salvar funil:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Erro ao salvar funil: ' + error.message 
        });
    }
});

app.post('/api/funnels/:funnelId/move-step', (req, res) => {
    try {
        const { funnelId } = req.params;
        const { fromIndex, direction } = req.body;
        
        if (fromIndex === undefined || fromIndex === null || !direction) {
            return res.status(400).json({ 
                success: false, 
                error: 'Parâmetros obrigatórios: fromIndex e direction' 
            });
        }
        
        const funnel = funis.get(funnelId);
        if (!funnel) {
            return res.status(404).json({ 
                success: false, 
                error: `Funil ${funnelId} não encontrado` 
            });
        }
        
        if (!funnel.steps || !Array.isArray(funnel.steps) || funnel.steps.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Funil não possui passos válidos' 
            });
        }
        
        const from = parseInt(fromIndex);
        
        if (isNaN(from) || from < 0 || from >= funnel.steps.length) {
            return res.status(400).json({ 
                success: false, 
                error: `Índice ${from} fora do intervalo (0-${funnel.steps.length - 1})` 
            });
        }
        
        const toIndex = direction === 'up' ? from - 1 : from + 1;
        
        if (toIndex < 0 || toIndex >= funnel.steps.length) {
            return res.status(400).json({ 
                success: false, 
                error: `Não é possível mover o passo ${from} para ${direction}` 
            });
        }
        
        const updatedFunnel = JSON.parse(JSON.stringify(funnel));
        
        if (!updatedFunnel.steps[from] || !updatedFunnel.steps[toIndex]) {
            return res.status(400).json({ 
                success: false, 
                error: 'Passos inválidos para troca' 
            });
        }
        
        const temp = updatedFunnel.steps[from];
        updatedFunnel.steps[from] = updatedFunnel.steps[toIndex];
        updatedFunnel.steps[toIndex] = temp;
        
        updatedFunnel.steps.forEach((step, idx) => {
            if (step && !step.id) {
                step.id = 'step_' + Date.now() + '_' + idx;
            }
        });
        
        funis.set(funnelId, updatedFunnel);
        
        saveFunnelsToFile();
        
        addLog('STEP_MOVED', `Passo ${from} movido para ${toIndex}`, { 
            funnelId, 
            direction,
            totalSteps: updatedFunnel.steps.length 
        });
        
        res.json({ 
            success: true, 
            message: `Passo movido de ${from} para ${toIndex}`,
            data: updatedFunnel 
        });
        
    } catch (error) {
        console.error('Erro ao mover passo:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Erro interno: ' + error.message 
        });
    }
});

app.get('/api/funnels/export', (req, res) => {
    try {
        const funnelsArray = Array.from(funis.values());
        const filename = `kirvano-funis-${new Date().toISOString().split('T')[0]}.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify({
            version: '8.3',
            exportDate: new Date().toISOString(),
            totalFunnels: funnelsArray.length,
            funnels: funnelsArray
        }, null, 2));
        
        addLog('FUNNELS_EXPORT', `Export: ${funnelsArray.length} funis`);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/funnels/import', (req, res) => {
    try {
        const importData = req.body;
        
        if (!importData.funnels || !Array.isArray(importData.funnels)) {
            return res.status(400).json({ success: false, error: 'Arquivo inválido' });
        }
        
        let importedCount = 0, skippedCount = 0;
        
        importData.funnels.forEach(funnel => {
            if (funnel.id && funnel.name && funnel.steps && (funnel.id.startsWith('CS_') || funnel.id.startsWith('FAB_'))) {
                funis.set(funnel.id, funnel);
                importedCount++;
            } else {
                skippedCount++;
            }
        });
        
        saveFunnelsToFile();
        addLog('FUNNELS_IMPORT', `Import: ${importedCount} importados, ${skippedCount} ignorados`);
        
        res.json({ 
            success: true, 
            imported: importedCount,
            skipped: skippedCount,
            total: importData.funnels.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 🔧 ENDPOINTS DE DEBUG ============

app.get('/api/debug/conversation/:phoneKey', (req, res) => {
    const { phoneKey } = req.params;
    
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.json({ 
            success: false, 
            error: 'Conversa não encontrada',
            phoneKey 
        });
    }
    
    const funnel = funis.get(conversation.funnelId);
    
    const messageHistory = [];
    const hashes = sentMessagesHash.get(phoneKey) || new Set();
    
    hashes.forEach(hash => {
        const timestamp = messageBlockTimers.get(hash);
        messageHistory.push({
            hash: hash.substring(0, 8),
            timestamp: timestamp ? new Date(timestamp).toISOString() : null,
            blocked: timestamp ? (Date.now() - timestamp < MESSAGE_BLOCK_TIME) : false
        });
    });
    
    const debug = {
        conversation: {
            phoneKey: conversation.phoneKey,
            customerName: conversation.customerName,
            funnelId: conversation.funnelId,
            currentStep: conversation.stepIndex,
            totalSteps: funnel ? funnel.steps.length : 0,
            waiting: conversation.waiting_for_response,
            pixWaiting: conversation.pixWaiting,
            canceled: conversation.canceled,
            completed: conversation.completed,
            createdAt: conversation.createdAt,
            lastSystemMessage: conversation.lastSystemMessage,
            lastReply: conversation.lastReply
        },
        funnel: funnel ? {
            id: funnel.id,
            name: funnel.name,
            steps: funnel.steps.map((step, idx) => ({
                index: idx,
                id: step.id,
                type: step.type,
                text: step.text ? step.text.substring(0, 50) + '...' : null,
                mediaUrl: step.mediaUrl ? step.mediaUrl.substring(0, 50) + '...' : null,
                waitForReply: step.waitForReply,
                delayBefore: step.delayBefore,
                showTyping: step.showTyping,
                delaySeconds: step.delaySeconds,
                isCurrent: idx === conversation.stepIndex,
                isDuplicate: funnel.steps.filter(s => s.id === step.id).length > 1
            }))
        } : null,
        antiDuplication: {
            totalHashes: hashes.size,
            messageHistory: messageHistory,
            blocked: messageHistory.filter(m => m.blocked).length,
            expired: messageHistory.filter(m => !m.blocked).length
        },
        variations: {
            phoneIndex: Array.from(phoneIndex.entries())
                .filter(([key]) => key.includes(phoneKey.substring(4)))
                .slice(0, 10),
            phoneVariations: Array.from(phoneVariations.entries())
                .filter(([key]) => key.includes(phoneKey.substring(4)))
                .slice(0, 10),
            lidMapping: phoneToLid.get(phoneKey) || null
        }
    };
    
    res.json({ success: true, data: debug });
});

app.get('/api/debug/duplicates', (req, res) => {
    const issues = [];
    
    funis.forEach(funnel => {
        const stepIds = funnel.steps.map(s => s.id);
        const duplicates = stepIds.filter((id, idx) => stepIds.indexOf(id) !== idx);
        
        if (duplicates.length > 0) {
            issues.push({
                funnelId: funnel.id,
                funnelName: funnel.name,
                duplicateIds: [...new Set(duplicates)],
                totalSteps: funnel.steps.length,
                steps: funnel.steps.map((s, idx) => ({
                    index: idx,
                    id: s.id,
                    type: s.type,
                    isDuplicate: duplicates.includes(s.id)
                }))
            });
        }
    });
    
    res.json({
        success: true,
        totalIssues: issues.length,
        issues: issues
    });
});

app.get('/api/debug/blocked-messages', (req, res) => {
    const blockedMessages = [];
    
    messageBlockTimers.forEach((timestamp, hash) => {
        const timeSince = Date.now() - timestamp;
        const isBlocked = timeSince < MESSAGE_BLOCK_TIME;
        
        blockedMessages.push({
            hash: hash.substring(0, 8),
            timestamp: new Date(timestamp).toISOString(),
            timeSince: Math.round(timeSince / 1000) + 's',
            blocked: isBlocked,
            expiresIn: isBlocked ? Math.round((MESSAGE_BLOCK_TIME - timeSince) / 1000) + 's' : 'EXPIRADO'
        });
    });
    
    blockedMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json({
        success: true,
        total: blockedMessages.length,
        blocked: blockedMessages.filter(m => m.blocked).length,
        expired: blockedMessages.filter(m => !m.blocked).length,
        messages: blockedMessages
    });
});

app.post('/api/funnels/:funnelId/fix-ids', (req, res) => {
    try {
        const { funnelId } = req.params;
        
        const funnel = funis.get(funnelId);
        if (!funnel) {
            return res.status(404).json({ 
                success: false, 
                error: 'Funil não encontrado' 
            });
        }
        
        const before = JSON.parse(JSON.stringify(funnel.steps));
        
        funnel.steps.forEach((step, index) => {
            const newId = 'step_' + (index + 1);
            console.log(`Renomeando: ${step.id} → ${newId}`);
            step.id = newId;
        });
        
        funis.set(funnelId, funnel);
        saveFunnelsToFile();
        
        const duplicatesBefore = before.map(s => s.id).filter((id, idx, arr) => arr.indexOf(id) !== idx);
        const duplicatesAfter = funnel.steps.map(s => s.id).filter((id, idx, arr) => arr.indexOf(id) !== idx);
        
        addLog('IDS_FIXED', `Funil ${funnelId} corrigido`, {
            totalSteps: funnel.steps.length,
            duplicatesBefore: duplicatesBefore.length,
            duplicatesAfter: duplicatesAfter.length
        });
        
        res.json({
            success: true,
            message: 'IDs corrigidos com sucesso!',
            funnelId: funnelId,
            totalSteps: funnel.steps.length,
            duplicatesBefore: duplicatesBefore,
            duplicatesAfter: duplicatesAfter,
            fixed: duplicatesBefore.length - duplicatesAfter.length
        });
        
    } catch (error) {
        console.error('Erro ao corrigir IDs:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/api/funnels/fix-all-ids', async (req, res) => {
    try {
        const results = [];
        
        for (const [funnelId, funnel] of funis.entries()) {
            const before = funnel.steps.map(s => s.id);
            
            funnel.steps.forEach((step, index) => {
                step.id = 'step_' + (index + 1);
            });
            
            const after = funnel.steps.map(s => s.id);
            const duplicatesBefore = before.filter((id, idx, arr) => arr.indexOf(id) !== idx);
            const duplicatesAfter = after.filter((id, idx, arr) => arr.indexOf(id) !== idx);
            
            results.push({
                funnelId,
                totalSteps: funnel.steps.length,
                duplicatesBefore: duplicatesBefore.length,
                duplicatesAfter: duplicatesAfter.length,
                fixed: duplicatesBefore.length > 0
            });
            
            funis.set(funnelId, funnel);
        }
        
        await saveFunnelsToFile();
        
        const totalFixed = results.filter(r => r.fixed).length;
        
        addLog('ALL_IDS_FIXED', `${totalFixed} funis corrigidos`);
        
        res.json({
            success: true,
            message: `${totalFixed} funis corrigidos!`,
            results: results
        });
        
    } catch (error) {
        console.error('Erro ao corrigir todos:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY.length,
        instances: INSTANCES,
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        pix_timeouts_active: pixTimeouts.size,
        webhook_locks_active: webhookLocks.size,
        phone_index_size: phoneIndex.size,
        phone_variations_size: phoneVariations.size,
        lid_mappings_size: lidMapping.size,
        sent_messages_cache: sentMessagesHash.size,
        blocked_messages_count: messageBlockTimers.size,
        test_results: [],
        available_instances: []
    };
    
    try {
        const listUrl = EVOLUTION_BASE_URL + '/instance/fetchInstances';
        const listResponse = await axios.get(listUrl, {
            headers: {
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 10000,
            validateStatus: () => true
        });
        
        debugInfo.available_instances = listResponse.data;
        debugInfo.list_status = listResponse.status;
    } catch (error) {
        debugInfo.list_error = error.message;
    }
    
    try {
        const testInstance = INSTANCES[0];
        const url = EVOLUTION_BASE_URL + '/message/sendText/' + testInstance;
        
        const response = await axios.post(url, {
            number: '5511999999999',
            text: 'teste'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 10000,
            validateStatus: () => true
        });
        
        debugInfo.test_results.push({
            instance: testInstance,
            status: response.status,
            response: response.data,
            url: url
        });
    } catch (error) {
        debugInfo.test_results.push({
            instance: INSTANCES[0],
            error: error.message,
            code: error.code
        });
    }
    
    res.json(debugInfo);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// ============ INICIALIZAÇÃO ============
async function initializeData() {
    console.log('🔄 Carregando dados...');
    
    const loaded = await loadFunnelsFromFile();
    
    // ✅ SE NÃO CARREGOU DO ARQUIVO, USA OS FUNIS PADRÃO APENAS COMO FALLBACK
    if (!loaded) {
        console.log('⚠️ Arquivo não encontrado, usando funis padrão como fallback');
        Object.values(defaultFunnels).forEach(funnel => {
            if (!funis.has(funnel.id)) {
                funis.set(funnel.id, funnel);
            }
        });
    }
    
    await loadConversationsFromFile();
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('📇 Índices: phoneIndex=' + phoneIndex.size + ', phoneVariations=' + phoneVariations.size + ', @lid=' + lidMapping.size);
}

app.listen(PORT, async () => {
    console.log('='.repeat(80));
    console.log('🛡️ KIRVANO v8.3 - CORREÇÃO PIX→APROVADA SEMPRE PASSO 0');
    console.log('='.repeat(80));
    console.log('✅ Porta:', PORT);
    console.log('✅ Evolution:', EVOLUTION_BASE_URL);
    console.log('✅ Instâncias:', INSTANCES.length);
    console.log('');
    console.log('🔧 CORREÇÃO v8.3:');
    console.log('  ✅ transferPixToApproved() SEMPRE começa do passo 0');
    console.log('  ✅ Funis salvos no editor TÊM PRIORIDADE sobre hardcoded');
    console.log('  ✅ Funis hardcoded são APENAS fallback se arquivo não existir');
    console.log('');
    console.log('🔥 PROTEÇÕES ATIVAS:');
    console.log('  ✅ Hash melhorado (ignora variáveis dinâmicas)');
    console.log('  ✅ Bloqueio de Conversa Duplicada');
    console.log('  ✅ Bloqueio de Início de Funil Duplicado');
    console.log('  ✅ Bloqueio de Envio de Step Duplicado');
    console.log('');
    console.log('💰 RECURSOS:');
    console.log('  ✅ Sistema de PIX Link (Kirvano + PerfectPay)');
    console.log('  ✅ Variáveis dinâmicas: {PIX_LINK}, {NOME_CLIENTE}, {VALOR}');
    console.log('  ✅ Reenvio do MESMO link PIX gerado');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('📊 Dashboard: http://localhost:' + PORT + '/api/dashboard');
    console.log('='.repeat(80));
    
    await initializeData();
});
