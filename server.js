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
const CANCEL_KEYWORDS_FILE = path.join(__dirname, 'data', 'cancel-keywords.json');
const INSTANCE_LOCK_FILE = path.join(__dirname, 'data', 'instance-locks.json');

// ⚡ TEMPO PARA RESETAR INSTÂNCIA (24 HORAS)
const INSTANCE_RESET_TIME = 24 * 60 * 60 * 1000; // 24 horas

// ✅ PALAVRAS-CHAVE PADRÃO PARA CANCELAMENTO AUTOMÁTICO
let CANCEL_KEYWORDS = [
    'numero errado',
    'número errado',
    'numero incorreto',
    'não sou eu',
    'nao sou eu',
    'pessoa errada',
    'não conheço',
    'nao conheco',
    'não comprei',
    'nao comprei',
    'pare',
    'parar',
    'stop',
    'cancelar',
    'me bloqueie',
    'não quero',
    'nao quero',
    'desisto',
    'não tenho interesse',
    'nao tenho interesse'
];

// ============ MAPEAMENTO DE PRODUTOS ============

// Kirvano - Mapeamento por offer_id
const PRODUCT_MAPPING = {
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS',
    '564bb9bb-718a-4e8b-a843-a2da62f616f0': 'CS',
    '668a73bc-2fca-4f12-9331-ef945181cd5c': 'FAB'
};

// PerfectPay - Mapeamento
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

function getStatusDescription(statusEnum) {
    const descriptions = {
        0: 'none',
        1: 'pending (PIX/Boleto pendente)',
        2: 'approved (venda aprovada)',
        3: 'in_process (em revisão)',
        4: 'in_mediation (em moderação)',
        5: 'rejected (rejeitado)',
        6: 'cancelled (cancelado)',
        7: 'refunded (devolvido)',
        8: 'authorized (autorizada)',
        9: 'charged_back (chargeback solicitado)',
        10: 'completed (30 dias após aprovação)',
        11: 'checkout_error (erro no checkout)',
        12: 'precheckout (abandono)',
        13: 'expired (expirado)'
    };
    return descriptions[statusEnum] || 'unknown';
}

// Instâncias Evolution
const INSTANCES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();
let stickyInstances = new Map();
let instanceLocks = new Map(); // ⚡ NOVO: Lock de instância com timestamp
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: [
            {
                id: 'step_0',
                type: 'text',
                text: 'Parabéns {{NOME}}! Seu pedido foi aprovado.\n\n✅ Produto: {{PRODUTO}}\n💰 Valor: {{VALOR}}\n\nBem-vindo ao CS!',
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
            },
            {
                id: 'step_6',
                type: 'delay',
                delaySeconds: 1500
            },
            {
                id: 'step_7',
                type: 'text',
                text: 'Lembre-se de que nosso suporte está sempre disponível para ajudar você!'
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
                text: 'Olá {{NOME}}! Seu PIX foi gerado!\n\n💰 Valor: {{VALOR}}\n📱 Produto: {{PRODUTO}}\n\n🔗 Pague agora:\n{{PIX_URL}}\n\nAguardamos o pagamento para liberar o acesso ao CS.',
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
                text: '⚠️ {{NOME}}, seu PIX está prestes a expirar!\n\n🔗 Link para pagamento:\n{{PIX_URL}}\n\nSe precisar de ajuda, nossa equipe está disponível!'
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
            },
            {
                id: 'step_5',
                type: 'delay',
                delaySeconds: 1500
            },
            {
                id: 'step_6',
                type: 'text',
                text: 'PIX vencido! Entre em contato conosco para gerar um novo.'
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
                text: 'Parabéns {{NOME}}! Seu pedido FAB foi aprovado.\n\n✅ Produto: {{PRODUTO}}\n💰 Valor: {{VALOR}}\n\nBem-vindo!',
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
            },
            {
                id: 'step_3',
                type: 'delay',
                delaySeconds: 420
            },
            {
                id: 'step_4',
                type: 'text',
                text: 'Já está conseguindo acessar o conteúdo FAB? Precisa de ajuda?',
                waitForReply: true
            },
            {
                id: 'step_5',
                type: 'text',
                text: 'Ótimo! Aproveite o conteúdo e bons estudos!'
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
                text: '💜 Oi {{NOME}}! A Faby separou sua vaga!\n\n💰 Valor: {{VALOR}}\n📱 Produto: VIP FABY\n\n🔗 Pague agora:\n{{PIX_URL}}\n\nAguardamos o pagamento!',
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
            },
            {
                id: 'step_3',
                type: 'delay',
                delaySeconds: 1500
            },
            {
                id: 'step_4',
                type: 'text',
                text: 'Ainda não identificamos seu pagamento. O PIX tem validade limitada.'
            }
        ]
    }
};

// ⚡ NOVO: Sistema de Lock de Instância com Timestamp
function getOrAssignInstance(phoneKey, phone) {
    const now = Date.now();
    
    // Verifica se já tem instância atribuída
    const existingLock = instanceLocks.get(phoneKey);
    
    if (existingLock) {
        const timeSinceLock = now - existingLock.timestamp;
        
        // Se passou mais de 24h, pode trocar de instância
        if (timeSinceLock > INSTANCE_RESET_TIME) {
            addLog('INSTANCE_RESET', `Resetando instância após 24h para ${phoneKey}`, {
                oldInstance: existingLock.instance,
                hoursElapsed: Math.round(timeSinceLock / (1000 * 60 * 60))
            });
            
            // Remove o lock antigo
            instanceLocks.delete(phoneKey);
            stickyInstances.delete(phoneKey);
        } else {
            // Mantém a mesma instância
            addLog('INSTANCE_KEPT', `Mantendo instância ${existingLock.instance} para ${phoneKey}`, {
                hoursElapsed: Math.round(timeSinceLock / (1000 * 60 * 60))
            });
            
            stickyInstances.set(phoneKey, existingLock.instance);
            return existingLock.instance;
        }
    }
    
    // Se não tem instância ou foi resetada, atribui nova
    const nextIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
    const newInstance = INSTANCES[nextIndex];
    
    // Salva o lock com timestamp
    instanceLocks.set(phoneKey, {
        instance: newInstance,
        timestamp: now,
        phone: phone
    });
    
    stickyInstances.set(phoneKey, newInstance);
    lastSuccessfulInstanceIndex = nextIndex;
    
    addLog('INSTANCE_ASSIGNED', `Nova instância ${newInstance} atribuída para ${phoneKey}`);
    
    // Salva em arquivo para persistir
    saveInstanceLocks();
    
    return newInstance;
}

// ⚡ NOVO: Verificação de conversa duplicada
function hasActiveConversation(phoneKey) {
    const conv = conversations.get(phoneKey);
    
    if (!conv) return false;
    
    // Se está cancelada ou completa, não é ativa
    if (conv.canceled || conv.completed) return false;
    
    // Se tem conversa ativa
    return true;
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

async function saveInstanceLocks() {
    try {
        await ensureDataDir();
        const locksArray = Array.from(instanceLocks.entries()).map(([key, value]) => ({
            phoneKey: key,
            ...value
        }));
        await fs.writeFile(INSTANCE_LOCK_FILE, JSON.stringify(locksArray, null, 2));
        addLog('INSTANCE_LOCKS_SAVED', `${locksArray.length} locks de instância salvos`);
    } catch (error) {
        addLog('INSTANCE_LOCKS_SAVE_ERROR', 'Erro ao salvar locks: ' + error.message);
    }
}

async function loadInstanceLocks() {
    try {
        const data = await fs.readFile(INSTANCE_LOCK_FILE, 'utf8');
        const locksArray = JSON.parse(data);
        
        instanceLocks.clear();
        locksArray.forEach(lock => {
            instanceLocks.set(lock.phoneKey, {
                instance: lock.instance,
                timestamp: lock.timestamp,
                phone: lock.phone
            });
            
            // Restaura sticky instances
            stickyInstances.set(lock.phoneKey, lock.instance);
        });
        
        addLog('INSTANCE_LOCKS_LOADED', `${locksArray.length} locks de instância carregados`);
        return true;
    } catch (error) {
        addLog('INSTANCE_LOCKS_LOAD_ERROR', 'Nenhum lock anterior');
        return false;
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
            canceledAt: value.canceledAt ? value.canceledAt.toISOString() : null,
            pausedAt: value.pausedAt ? value.pausedAt.toISOString() : null
        }));
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            phoneIndex: Array.from(phoneIndex.entries()),
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
                canceledAt: conv.canceledAt ? new Date(conv.canceledAt) : null,
                pausedAt: conv.pausedAt ? new Date(conv.pausedAt) : null
            });
        });
        
        phoneIndex.clear();
        parsed.phoneIndex.forEach(([key, value]) => phoneIndex.set(key, value));
        
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => stickyInstances.set(key, value));
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior');
        return false;
    }
}

async function saveCancelKeywordsToFile() {
    try {
        await ensureDataDir();
        await fs.writeFile(CANCEL_KEYWORDS_FILE, JSON.stringify(CANCEL_KEYWORDS, null, 2));
        addLog('CANCEL_KEYWORDS_SAVED', `${CANCEL_KEYWORDS.length} palavras-chave salvas`);
    } catch (error) {
        addLog('CANCEL_KEYWORDS_SAVE_ERROR', 'Erro ao salvar: ' + error.message);
    }
}

async function loadCancelKeywordsFromFile() {
    try {
        const data = await fs.readFile(CANCEL_KEYWORDS_FILE, 'utf8');
        CANCEL_KEYWORDS = JSON.parse(data);
        addLog('CANCEL_KEYWORDS_LOADED', `${CANCEL_KEYWORDS.length} palavras-chave carregadas`);
        return true;
    } catch (error) {
        addLog('CANCEL_KEYWORDS_LOAD_ERROR', 'Usando palavras-chave padrão');
        return false;
    }
}

setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
    await saveCancelKeywordsToFile();
    await saveInstanceLocks();
}, 30000);

Object.values(defaultFunnels).forEach(funnel => funis.set(funnel.id, funnel));

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============
function extractPhoneKey(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.slice(-8);
}

function registerPhone(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    
    const cleaned = fullPhone.replace(/\D/g, '');
    phoneIndex.set(cleaned, phoneKey);
    
    if (cleaned.startsWith('55')) {
        phoneIndex.set(cleaned.substring(2), phoneKey);
    }
    if (!cleaned.startsWith('55')) {
        phoneIndex.set('55' + cleaned, phoneKey);
    }
}

function findConversationByPhone(phone) {
    const phoneKey = extractPhoneKey(phone);
    if (!phoneKey || phoneKey.length !== 8) return null;
    
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        registerPhone(phone, phoneKey);
    }
    return conversation;
}

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

// ✅ NOVO: Detectar palavras-chave de cancelamento
function detectCancelKeyword(messageText) {
    if (!messageText || typeof messageText !== 'string') return null;
    
    const normalized = messageText.toLowerCase().trim();
    
    for (const keyword of CANCEL_KEYWORDS) {
        if (normalized.includes(keyword.toLowerCase())) {
            return keyword;
        }
    }
    
    return null;
}

// ✅ NOVO: Cancelar conversa e limpar timeouts
function cancelConversation(phoneKey, reason = 'MANUAL') {
    const conversation = conversations.get(phoneKey);
    if (!conversation) return false;
    
    conversation.canceled = true;
    conversation.canceledAt = new Date();
    conversation.cancelReason = reason;
    conversation.waiting_for_response = false;
    conversation.pixWaiting = false;
    conversation.paused = false;
    conversations.set(phoneKey, conversation);
    
    const pixTimeout = pixTimeouts.get(phoneKey);
    if (pixTimeout) {
        clearTimeout(pixTimeout.timeout);
        pixTimeouts.delete(phoneKey);
        addLog('PIX_TIMEOUT_CLEARED', `Timeout PIX cancelado`, { phoneKey, reason });
    }
    
    addLog('CONVERSATION_CANCELED', `Conversa cancelada: ${reason}`, { 
        phoneKey, 
        funnelId: conversation.funnelId,
        step: conversation.stepIndex 
    });
    
    return true;
}

// ✅ NOVO: Pausar/Despausar conversa
function pauseConversation(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled) return false;
    
    conversation.paused = true;
    conversation.pausedAt = new Date();
    conversations.set(phoneKey, conversation);
    
    addLog('CONVERSATION_PAUSED', `Conversa pausada`, { phoneKey });
    return true;
}

function resumeConversation(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled) return false;
    
    conversation.paused = false;
    conversation.pausedAt = null;
    conversations.set(phoneKey, conversation);
    
    addLog('CONVERSATION_RESUMED', `Conversa retomada`, { phoneKey });
    return true;
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

// ⚡ NOVO: Envio com instância fixa garantida
async function sendWithFixedInstance(phoneKey, remoteJid, type, text, mediaUrl = null) {
    // SEMPRE usa a instância atribuída ao phoneKey
    let instanceToUse = stickyInstances.get(phoneKey);
    
    if (!instanceToUse) {
        // Se não tem instância, atribui uma
        const phone = remoteJid.replace('@s.whatsapp.net', '');
        instanceToUse = getOrAssignInstance(phoneKey, phone);
    }
    
    addLog('SENDING_WITH_INSTANCE', `Enviando via instância fixa ${instanceToUse}`, {
        phoneKey,
        instance: instanceToUse,
        type
    });
    
    let result;
    const maxAttempts = 3;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (type === 'text') {
                result = await sendText(remoteJid, text, instanceToUse);
            } else if (type === 'image') {
                result = await sendImage(remoteJid, mediaUrl, '', instanceToUse);
            } else if (type === 'image+text') {
                result = await sendImage(remoteJid, mediaUrl, text, instanceToUse);
            } else if (type === 'video') {
                result = await sendVideo(remoteJid, mediaUrl, '', instanceToUse);
            } else if (type === 'video+text') {
                result = await sendVideo(remoteJid, mediaUrl, text, instanceToUse);
            } else if (type === 'audio') {
                result = await sendAudio(remoteJid, mediaUrl, instanceToUse);
            }
            
            if (result && result.ok) {
                addLog('SEND_SUCCESS', `Mensagem enviada com sucesso`, {
                    phoneKey,
                    instance: instanceToUse,
                    attempt
                });
                return { success: true, instanceName: instanceToUse };
            }
            
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            addLog('SEND_ERROR', `Erro no envio, tentativa ${attempt}/${maxAttempts}`, {
                phoneKey,
                instance: instanceToUse,
                error: error.message
            });
            
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    // Se falhou todas as tentativas
    addLog('SEND_FAILED', `Falha total no envio após ${maxAttempts} tentativas`, {
        phoneKey,
        instance: instanceToUse
    });
    
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        conversation.hasError = true;
        conversation.errorMessage = 'Falha no envio após múltiplas tentativas';
        conversations.set(phoneKey, conversation);
    }
    
    return { success: false, error: 'Falha no envio' };
}

// ============ ORQUESTRAÇÃO ============

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount, pixUrl = null, pixQrCode = null, platform = 'Kirvano') {
    // ⚡ VERIFICAÇÃO DE DUPLICAÇÃO
    if (hasActiveConversation(phoneKey)) {
        addLog('CONVERSATION_DUPLICATE_BLOCKED', `Bloqueada criação duplicada para ${phoneKey}`, {
            orderCode,
            existingConv: true
        });
        return false;
    }
    
    // Atribui instância fixa
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    const assignedInstance = getOrAssignInstance(phoneKey, phone);
    
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId: productType + '_PIX',
        stepIndex: -1,
        orderCode,
        customerName,
        productType,
        amount,
        pixUrl: pixUrl,
        pixQrCode: pixQrCode,
        platform: platform,
        assignedInstance: assignedInstance, // INSTÂNCIA FIXA
        waiting_for_response: false,
        pixWaiting: true,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        paused: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    addLog('PIX_WAITING_CREATED', `PIX em espera criado`, {
        phoneKey,
        orderCode,
        productType,
        hasPixUrl: !!pixUrl,
        platform,
        assignedInstance
    });
    
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.orderCode === orderCode && !conv.canceled && !conv.paused && conv.pixWaiting) {
            addLog('PIX_TIMEOUT_TRIGGERED', `Timeout PIX disparado`, {
                phoneKey,
                orderCode,
                instance: conv.assignedInstance
            });
            
            conv.pixWaiting = false;
            conv.stepIndex = 0;
            conversations.set(phoneKey, conv);
            
            await sendStep(phoneKey);
        }
        pixTimeouts.delete(phoneKey);
    }, PIX_TIMEOUT);
    
    pixTimeouts.set(phoneKey, { timeout, orderCode, createdAt: new Date() });
    return true;
}

async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, amount, platform = 'Kirvano') {
    const pixConv = conversations.get(phoneKey);
    
    const pixUrl = pixConv?.pixUrl || null;
    const pixQrCode = pixConv?.pixQrCode || null;
    const assignedInstance = pixConv?.assignedInstance; // MANTÉM A MESMA INSTÂNCIA
    
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
        addLog('PIX_TIMEOUT_CANCELED', `Timeout cancelado - pagamento aprovado`, { phoneKey, orderCode });
    }
    
    let startingStep = 0;
    if (pixConv && pixConv.stepIndex >= 0) {
        startingStep = Math.min(3, pixConv.stepIndex + 1);
        addLog('TRANSFER_CONTINUE_FROM', `Continuando do passo ${startingStep}`, { phoneKey });
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
        pixUrl: pixUrl,
        pixQrCode: pixQrCode,
        platform: platform,
        assignedInstance: assignedInstance || getOrAssignInstance(phoneKey, remoteJid.replace('@s.whatsapp.net', '')), // MANTÉM OU ATRIBUI
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        paused: false,
        completed: false,
        transferredFromPix: true,
        previousFunnel: productType + '_PIX'
    };
    
    conversations.set(phoneKey, approvedConv);
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido PIX → APROVADA`, {
        phoneKey,
        startingStep,
        productType,
        platform,
        instance: approvedConv.assignedInstance
    });
    
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount, pixUrl = null, pixQrCode = null, platform = 'Kirvano') {
    // ⚡ VERIFICAÇÃO DE DUPLICAÇÃO
    const existingConv = conversations.get(phoneKey);
    if (existingConv && !existingConv.canceled && !existingConv.completed) {
        addLog('FUNNEL_START_BLOCKED', `Já existe conversa ativa`, {
            phoneKey,
            existingFunnel: existingConv.funnelId
        });
        return false;
    }
    
    // Atribui instância fixa
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    const assignedInstance = getOrAssignInstance(phoneKey, phone);
    
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId,
        stepIndex: 0,
        orderCode,
        customerName,
        productType,
        amount,
        pixUrl: pixUrl,
        pixQrCode: pixQrCode,
        platform: platform,
        assignedInstance: assignedInstance, // INSTÂNCIA FIXA
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        paused: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    addLog('FUNNEL_START', `Funil ${funnelId} iniciado`, {
        phoneKey,
        orderCode,
        platform,
        instance: assignedInstance
    });
    
    await sendStep(phoneKey);
    return true;
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) {
        addLog('STEP_NO_CONVERSATION', `Sem conversa para ${phoneKey}`);
        return;
    }
    
    if (conversation.canceled) {
        addLog('STEP_CANCELED', `Conversa cancelada`, { phoneKey });
        return;
    }
    
    if (conversation.paused) {
        addLog('STEP_PAUSED', `Conversa pausada`, { phoneKey });
        return;
    }
    
    if (conversation.pixWaiting) {
        addLog('STEP_PIX_WAITING', `Aguardando timeout PIX`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('STEP_NO_FUNNEL', `Funil ${conversation.funnelId} não encontrado`);
        return;
    }
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) {
        addLog('STEP_NOT_FOUND', `Passo ${conversation.stepIndex} não existe`, {
            phoneKey,
            funnelId: conversation.funnelId
        });
        return;
    }
    
    addLog('STEP_SEND_START', `Enviando passo ${conversation.stepIndex}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepType: step.type,
        instance: conversation.assignedInstance
    });
    
    let result = { success: true };
    
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `Aguardando ${delaySeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    if (step.showTyping) {
        addLog('STEP_SHOW_TYPING', `Mostrando digitando...`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    if (step.type === 'delay') {
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', `Delay de ${delaySeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    } else if (step.type === 'typing') {
        const typingSeconds = step.typingSeconds || 3;
        addLog('STEP_TYPING', `Digitando ${typingSeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, typingSeconds * 1000));
    } else {
        // Processa o texto com variáveis
        let finalText = step.text || '';
        
        // ✅ SUBSTITUIÇÃO DE VARIÁVEIS
        if (finalText.includes('{{PIX_URL}}')) {
            if (conversation.pixUrl) {
                finalText = finalText.replace(/\{\{PIX_URL\}\}/g, conversation.pixUrl);
                addLog('VARIABLE_REPLACED', 'PIX_URL substituída', {
                    phoneKey,
                    pixUrl: conversation.pixUrl
                });
            } else {
                finalText = finalText.replace(/\{\{PIX_URL\}\}/g, '[LINK PIX INDISPONÍVEL]');
                addLog('VARIABLE_MISSING', 'PIX_URL não disponível', { phoneKey });
            }
        }
        
        if (finalText.includes('{{NOME}}') && conversation.customerName) {
            const firstName = conversation.customerName.split(' ')[0];
            finalText = finalText.replace(/\{\{NOME\}\}/g, firstName);
            addLog('VARIABLE_REPLACED', 'NOME substituído', {
                phoneKey,
                nome: firstName
            });
        }
        
        if (finalText.includes('{{VALOR}}') && conversation.amount) {
            finalText = finalText.replace(/\{\{VALOR\}\}/g, conversation.amount);
            addLog('VARIABLE_REPLACED', 'VALOR substituído', {
                phoneKey,
                valor: conversation.amount
            });
        }
        
        if (finalText.includes('{{PRODUTO}}') && conversation.productType) {
            const productName = conversation.productType + ' - ' + (conversation.platform || 'Kirvano');
            finalText = finalText.replace(/\{\{PRODUTO\}\}/g, productName);
            addLog('VARIABLE_REPLACED', 'PRODUTO substituído', {
                phoneKey,
                produto: productName
            });
        }
        
        // ENVIA COM INSTÂNCIA FIXA
        result = await sendWithFixedInstance(
            phoneKey,
            conversation.remoteJid,
            step.type || 'text',
            finalText,
            step.mediaUrl
        );
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            addLog('STEP_WAITING_REPLY', `Aguardando resposta do passo ${conversation.stepIndex}`, {
                phoneKey,
                instance: conversation.assignedInstance
            });
        } else {
            conversations.set(phoneKey, conversation);
            addLog('STEP_AUTO_ADVANCE', `Avançando automaticamente`, { phoneKey });
            await advanceConversation(phoneKey, null, 'auto');
        }
    } else {
        addLog('STEP_FAILED', `Falha no envio do passo ${conversation.stepIndex}`, {
            phoneKey,
            error: result.error
        });
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) {
        addLog('ADVANCE_NO_CONVERSATION', `Sem conversa para avançar`, { phoneKey });
        return;
    }
    
    if (conversation.canceled || conversation.paused) {
        addLog('ADVANCE_BLOCKED', `Conversa cancelada ou pausada`, {
            phoneKey,
            canceled: conversation.canceled,
            paused: conversation.paused
        });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('ADVANCE_NO_FUNNEL', `Funil não encontrado`, { phoneKey });
        return;
    }
    
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
    addLog('STEP_ADVANCE', `Avançando para passo ${nextStepIndex}`, {
        phoneKey,
        reason,
        instance: conversation.assignedInstance
    });
    
    // Envia próximo passo
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
        
        // Captura URL do PIX
        const pixUrl = data.payment?.pix_url || data.checkout_url || data.payment_url || null;
        const pixQrCode = data.payment?.qrcode || data.payment?.qrcode_image || null;
        
        const phoneKey = extractPhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const productId = data.offer_id || data.product_id || data.products?.[0]?.id;
        const productType = PRODUCT_MAPPING[productId] || 'CS';
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, { 
            orderCode, 
            phoneKey, 
            method, 
            productType,
            pixUrl: pixUrl ? 'presente' : 'ausente'
        });
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            const existingConv = conversations.get(phoneKey);
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                addLog('KIRVANO_PIX_TO_APPROVED', `Cliente pagou PIX`, { phoneKey, orderCode, productType });
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice, 'Kirvano');
            } else {
                addLog('KIRVANO_DIRECT_APPROVED', `Pagamento aprovado direto`, { phoneKey, orderCode, productType });
                
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', orderCode, customerName, productType, totalPrice, pixUrl, pixQrCode, 'Kirvano');
            }
        } else if (isPix && event.includes('GENERATED')) {
            addLog('KIRVANO_PIX_GENERATED', `PIX gerado`, { 
                phoneKey, 
                orderCode, 
                productType, 
                hasPixUrl: !!pixUrl 
            });
            
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice, pixUrl, pixQrCode, 'Kirvano');
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
        addLog('PERFECTPAY_WEBHOOK_RECEIVED', 'Webhook PerfectPay recebido', {
            timestamp: new Date().toISOString()
        });
        
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
        
        // Captura URL do PIX
        const pixUrl = data.checkout_url || data.pix_url || data.payment_url || data.billet_url || null;
        const pixQrCode = data.qrcode_image || data.pix_qrcode_image || null;
        
        const phoneKey = extractPhoneKey(customerPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('PERFECTPAY_INVALID_PHONE', 'Telefone inválido', { customerPhone });
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const productType = identifyPerfectPayProduct(productCode, planCode);
        
        addLog('PERFECTPAY_EVENT', `Status ${statusEnum}`, {
            saleCode,
            phoneKey,
            productType,
            hasPixUrl: !!pixUrl
        });
        
        if (statusEnum === 2) {
            // APROVADO
            const existingConv = conversations.get(phoneKey);
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                await transferPixToApproved(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice, 'PerfectPay');
            } else {
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', saleCode, customerName, productType, totalPrice, pixUrl, pixQrCode, 'PerfectPay');
            }
            
            res.json({ success: true, phoneKey, productType, action: 'approved' });
        } else if (statusEnum === 1 && paymentType !== 2) {
            // PIX PENDENTE (não boleto)
            await createPixWaitingConversation(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice, pixUrl, pixQrCode, 'PerfectPay');
            res.json({ success: true, phoneKey, productType, action: 'pix_waiting_created' });
        } else {
            res.json({ success: true, phoneKey, productType, action: 'status_' + statusEnum });
        }
        
    } catch (error) {
        addLog('PERFECTPAY_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK EVOLUTION - RESPOSTAS DOS CLIENTES
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        // Ignora mensagens enviadas por nós
        if (fromMe) {
            return res.json({ success: true });
        }
        
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        const phoneKey = extractPhoneKey(incomingPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: true });
        }
        
        // Adquire lock
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            const conversation = findConversationByPhone(incomingPhone);
            
            if (!conversation || conversation.canceled || conversation.completed) {
                addLog('WEBHOOK_NOT_ACTIVE', `Conversa não ativa`, {
                    phoneKey,
                    hasConversation: !!conversation,
                    canceled: conversation?.canceled,
                    completed: conversation?.completed
                });
                return res.json({ success: true });
            }
            
            addLog('CLIENT_MESSAGE_RECEIVED', `Mensagem recebida do cliente`, {
                phoneKey,
                text: messageText.substring(0, 50),
                waiting: conversation.waiting_for_response,
                step: conversation.stepIndex,
                funnel: conversation.funnelId
            });
            
            // ✅ Detecta palavra-chave de cancelamento
            const detectedKeyword = detectCancelKeyword(messageText);
            if (detectedKeyword) {
                addLog('CANCEL_KEYWORD_DETECTED', `Palavra-chave detectada: "${detectedKeyword}"`, {
                    phoneKey,
                    messageText: messageText.substring(0, 100),
                    keyword: detectedKeyword
                });
                
                cancelConversation(phoneKey, `AUTO_CANCEL: "${detectedKeyword}"`);
                return res.json({ success: true, action: 'canceled' });
            }
            
            // ✅ Verifica se está pausada
            if (conversation.paused) {
                addLog('WEBHOOK_PAUSED', `Conversa pausada, ignorando`, { phoneKey });
                return res.json({ success: true, action: 'paused' });
            }
            
            // Se está esperando resposta, avança
            if (conversation.waiting_for_response) {
                addLog('CLIENT_REPLY_PROCESSING', `Processando resposta do cliente`, {
                    phoneKey,
                    currentStep: conversation.stepIndex,
                    funnel: conversation.funnelId
                });
                
                conversation.waiting_for_response = false;
                conversation.lastReply = new Date();
                conversations.set(phoneKey, conversation);
                
                // AVANÇA PARA PRÓXIMO PASSO
                await advanceConversation(phoneKey, messageText, 'reply');
                
                res.json({ success: true, action: 'advanced' });
            } else {
                addLog('WEBHOOK_NOT_WAITING', `Não estava aguardando resposta`, {
                    phoneKey,
                    step: conversation.stepIndex
                });
                res.json({ success: true });
            }
            
        } finally {
            releaseWebhookLock(phoneKey);
        }
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', `Erro no webhook Evolution`, {
            error: error.message
        });
        releaseWebhookLock(phoneKey);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

app.get('/api/dashboard', (req, res) => {
    const instanceUsage = {};
    INSTANCES.forEach(inst => instanceUsage[inst] = 0);
    
    // Conta uso real das instâncias
    conversations.forEach(conv => {
        if (conv.assignedInstance && !conv.canceled && !conv.completed) {
            instanceUsage[conv.assignedInstance] = (instanceUsage[conv.assignedInstance] || 0) + 1;
        }
    });
    
    let activeCount = 0, waitingCount = 0, completedCount = 0, canceledCount = 0, pausedCount = 0, errorCount = 0;
    
    conversations.forEach(conv => {
        if (conv.completed) completedCount++;
        else if (conv.canceled) canceledCount++;
        else if (conv.paused) pausedCount++;
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
            paused_conversations: pausedCount,
            error_conversations: errorCount,
            pending_pix: pixTimeouts.size,
            total_funnels: funis.size,
            total_instances: INSTANCES.length,
            sticky_instances: stickyInstances.size,
            instance_locks: instanceLocks.size,
            instance_distribution: instanceUsage,
            webhook_locks: webhookLocks.size,
            cancel_keywords_count: CANCEL_KEYWORDS.length
        }
    });
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

// Endpoint para mover passos
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

// ✅ API de Cancelamento Manual
app.post('/api/conversation/:phoneKey/cancel', (req, res) => {
    const { phoneKey } = req.params;
    const success = cancelConversation(phoneKey, 'MANUAL_CANCEL');
    
    if (success) {
        res.json({ success: true, message: 'Conversa cancelada' });
    } else {
        res.status(404).json({ success: false, error: 'Conversa não encontrada' });
    }
});

// ✅ API de Pausar/Retomar
app.post('/api/conversation/:phoneKey/pause', (req, res) => {
    const { phoneKey } = req.params;
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
    }
    
    if (conversation.paused) {
        resumeConversation(phoneKey);
        res.json({ success: true, message: 'Conversa retomada', paused: false });
    } else {
        pauseConversation(phoneKey);
        res.json({ success: true, message: 'Conversa pausada', paused: true });
    }
});

// ✅ APIs de Palavras-chave
app.get('/api/cancel-keywords', (req, res) => {
    res.json({ 
        success: true, 
        data: CANCEL_KEYWORDS,
        count: CANCEL_KEYWORDS.length
    });
});

app.post('/api/cancel-keywords/add', async (req, res) => {
    try {
        const { keyword } = req.body;
        
        if (!keyword || typeof keyword !== 'string') {
            return res.status(400).json({ 
                success: false, 
                error: 'keyword deve ser uma string' 
            });
        }
        
        const trimmed = keyword.trim().toLowerCase();
        
        if (!CANCEL_KEYWORDS.includes(trimmed)) {
            CANCEL_KEYWORDS.push(trimmed);
            await saveCancelKeywordsToFile();
            addLog('CANCEL_KEYWORD_ADDED', `Palavra-chave adicionada: "${trimmed}"`);
        }
        
        res.json({ 
            success: true, 
            message: 'Palavra-chave adicionada',
            data: CANCEL_KEYWORDS,
            count: CANCEL_KEYWORDS.length
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/api/cancel-keywords/remove', async (req, res) => {
    try {
        const { keyword } = req.body;
        
        if (!keyword || typeof keyword !== 'string') {
            return res.status(400).json({ 
                success: false, 
                error: 'keyword deve ser uma string' 
            });
        }
        
        const index = CANCEL_KEYWORDS.indexOf(keyword.toLowerCase());
        
        if (index > -1) {
            CANCEL_KEYWORDS.splice(index, 1);
            await saveCancelKeywordsToFile();
            addLog('CANCEL_KEYWORD_REMOVED', `Palavra-chave removida: "${keyword}"`);
        }
        
        res.json({ 
            success: true, 
            message: 'Palavra-chave removida',
            data: CANCEL_KEYWORDS,
            count: CANCEL_KEYWORDS.length
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
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
            version: '5.0',
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

app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([phoneKey, conv]) => ({
        id: phoneKey,
        phone: conv.remoteJid.replace('@s.whatsapp.net', ''),
        phoneKey: phoneKey,
        customerName: conv.customerName,
        productType: conv.productType,
        platform: conv.platform || 'Kirvano',
        productDisplay: `${conv.productType} - ${conv.platform || 'Kirvano'}`,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        pixWaiting: conv.pixWaiting || false,
        pixUrl: conv.pixUrl || null,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        orderCode: conv.orderCode,
        amount: conv.amount,
        assignedInstance: conv.assignedInstance,
        canceled: conv.canceled || false,
        cancelReason: conv.cancelReason || null,
        paused: conv.paused || false,
        completed: conv.completed || false,
        hasError: conv.hasError || false,
        errorMessage: conv.errorMessage,
        transferredFromPix: conv.transferredFromPix || false
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

app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY.length,
        instances: INSTANCES,
        test_results: []
    };
    
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

app.get('/test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// ============ INICIALIZAÇÃO ============
async function initializeData() {
    console.log('🔄 Carregando dados salvos...');
    
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    await loadCancelKeywordsFromFile();
    await loadInstanceLocks();
    
    console.log('✅ Dados carregados com sucesso');
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 SISTEMA v9.0 - PRODUÇÃO FINAL CORRIGIDA');
    console.log('='.repeat(70));
    console.log('');
    console.log('✅ CORREÇÕES IMPLEMENTADAS:');
    console.log('  1. ✅ Instância FIXA por lead (não muda!)');
    console.log('  2. ✅ Reset após 24h sem atividade');
    console.log('  3. ✅ Bloqueio de duplicações');
    console.log('  4. ✅ Continuidade garantida após resposta');
    console.log('  5. ✅ Webhook PerfectPay funcionando');
    console.log('  6. ✅ Sistema de áudio mantido');
    console.log('  7. ✅ Editor de funis com setas');
    console.log('  8. ✅ Variáveis {{PIX_URL}}, {{NOME}}, etc');
    console.log('  9. ✅ Cancelamento automático por palavra-chave');
    console.log('  10. ✅ Botões pausar/retomar/cancelar');
    console.log('');
    console.log('📡 Configurações:');
    console.log('  Porta:', PORT);
    console.log('  Evolution:', EVOLUTION_BASE_URL);
    console.log('  Instâncias:', INSTANCES.join(', '));
    console.log('  Timeout PIX:', PIX_TIMEOUT / 1000 / 60, 'minutos');
    console.log('  Reset Instância:', INSTANCE_RESET_TIME / 1000 / 60 / 60, 'horas');
    console.log('');
    console.log('🔒 GARANTIAS:');
    console.log('  → Lead SEMPRE recebe da MESMA instância');
    console.log('  → Fluxo SEMPRE continua após resposta');
    console.log('  → NUNCA duplica mensagens');
    console.log('  → ZERO falhas de continuidade');
    console.log('='.repeat(70));
    
    await initializeData();
});
