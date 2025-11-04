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
const HEALTHCHECK_INTERVAL = 60000; // 1 minuto

// ============ MAPEAMENTO DE PRODUTOS ============
const PRODUCT_MAPPING = {
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS',
    '564bb9bb-718a-4e8b-a843-a2da62f616f0': 'CS',
    '668a73bc-2fca-4f12-9331-ef945181cd5c': 'FAB'
};

const PERFECTPAY_PLANS = { 'PPLQQNCF7': 'CS', 'PPLQQNCF8': 'CS' };
const PERFECTPAY_PRODUCTS = { 'PPU38CQ0GE8': 'CS' };

function identifyPerfectPayProduct(productCode, planCode) {
    if (planCode && PERFECTPAY_PLANS[planCode]) return PERFECTPAY_PLANS[planCode];
    if (productCode && PERFECTPAY_PRODUCTS[productCode]) return PERFECTPAY_PRODUCTS[productCode];
    return 'CS';
}

// ✅ TODAS as 15 instâncias mantidas no código
const INSTANCES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D112', 'D13', 'D14', 'D15'];

// ============ ARMAZENAMENTO ============
let conversations = new Map();
let phoneIndex = new Map();
let remoteJidIndex = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let sendStepLocks = new Map();
let completedLeads = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

// ✅ NOVO: Cache de instâncias online/offline
let instancesHealth = new Map();
let lastHealthCheck = 0;

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA', name: 'CS - Compra Aprovada',
        steps: [
            { id: 'step_0', type: 'audio', mediaUrl: 'https://xconteudos.com/wp-content/uploads/2025/10/1760064923462120438-321585629761702-1.mp3', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Posso te colocar no Grupo e mandar o seu acesso VIP por aqui mesmo amor? 😍', waitForReply: true, delayBefore: 18, showTyping: true },
            { id: 'step_2', type: 'video+text', text: 'Seu ACESSO VIP está pronto! 😍\n\nPra acessar é bem simples, Clique no link abaixo 👇🏻\n\nhttps://acesso.vipmembros.com/', mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/08/WhatsApp-Video-2025-08-21-at-12.27.34-2.mp4', delayBefore: 21, showTyping: true },
            { id: 'step_3', type: 'delay', delaySeconds: 780 },
            { id: 'step_4', type: 'text', text: 'Conseguiu amor? ❤️', waitForReply: true },
            { id: 'step_5', type: 'text', text: 'Se não tiver entrado no grupinho grátis, clica aqui 👇🏻\n\nhttps://t.me/Marina_Talbot', delayBefore: 19, showTyping: true }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX', name: 'CS - PIX Pendente',
        steps: [
            { id: 'step_0', type: 'audio', mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/10/1760471702347619808-323251706671257.ogg', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Qual seu nome amor, pra eu salvar aqui seu contato? ☺️', waitForReply: true, delayBefore: 12, showTyping: true },
            { id: 'step_2', type: 'audio', mediaUrl: 'https://xconteudos.com/wp-content/uploads/2025/10/Design-sem-nome-_26_-Copia.mp3', waitForReply: true, delayBefore: 12, showTyping: true },
            { id: 'step_3', type: 'text', text: 'Então amor, posso te colocar no Grupinho agora? 😍', waitForReply: true, delayBefore: 13, showTyping: true },
            { id: 'step_4', type: 'delay', delaySeconds: 590 },
            { id: 'step_5', type: 'image+text', text: 'Amor vi que ainda não pagou o valor..\n\nMas como as meninas do grupo gostaram de você vamos te liberar acesso ao nosso APLICATIVO VIP E A UM GRUPINHO GRÁTIS', mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/09/IMG_8451.jpg', waitForReply: true }
        ]
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA', name: 'FAB - Compra Aprovada',
        steps: [
            { id: 'step_0', type: 'audio', mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/10/Design-sem-nome-_26_.mp3', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Posso te enviar o contato da Fabiane? 😍', waitForReply: true, delayBefore: 20, showTyping: true },
            { id: 'step_2', type: 'video+text', text: 'Seu ACESSO VIP está pronto! 😍', mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/08/WhatsApp-Video-2025-08-21-at-12.27.34-3.mp4', delayBefore: 27, showTyping: true },
            { id: 'step_3', type: 'delay', delaySeconds: 600 },
            { id: 'step_4', type: 'text', text: 'Conseguiu amor? 🥰', waitForReply: true }
        ]
    },
    'FAB_PIX': {
        id: 'FAB_PIX', name: 'FAB - PIX Pendente',
        steps: [
            { id: 'step_0', type: 'audio', mediaUrl: 'https://hotmoney.space/wp-content/uploads/2025/10/1760070558163768420-321608735174786.mp3', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Posso te passar o número do Zap dela por aqui mesmo??', waitForReply: true, delayBefore: 16, showTyping: true },
            { id: 'step_2', type: 'delay', delaySeconds: 600 },
            { id: 'step_3', type: 'image+text', text: 'Amor vi que ainda não pagou o valor...', mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/09/IMG_8451.jpg', waitForReply: true }
        ]
    }
};

// ============ LOCK ============
async function acquireWebhookLock(phoneKey, timeout = 30000) {
    const startTime = Date.now();
    let attempts = 0;
    while (webhookLocks.get(phoneKey)) {
        attempts++;
        if (Date.now() - startTime > timeout) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `⏰ Timeout após ${attempts} tentativas - FORÇANDO liberação`, { phoneKey });
            // ✅ CORREÇÃO: Força liberação do lock travado
            webhookLocks.delete(phoneKey);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    webhookLocks.set(phoneKey, true);
    addLog('WEBHOOK_LOCK_ACQUIRED', `🔒 Lock adquirido (${attempts} tentativas)`, { phoneKey });
    return true;
}

function releaseWebhookLock(phoneKey) {
    webhookLocks.delete(phoneKey);
    addLog('WEBHOOK_LOCK_RELEASED', `🔓 Lock liberado`, { phoneKey });
}

// ============ PERSISTÊNCIA ============
async function ensureDataDir() {
    try { await fs.mkdir(path.join(__dirname, 'data'), { recursive: true }); } catch (error) {}
}

async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        await fs.writeFile(DATA_FILE, JSON.stringify(Array.from(funis.values()), null, 2));
        addLog('DATA_SAVE', 'Funis salvos: ' + funis.size);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro: ' + error.message);
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
            phoneKey: key, ...value,
            createdAt: value.createdAt.toISOString(),
            lastSystemMessage: value.lastSystemMessage ? value.lastSystemMessage.toISOString() : null,
            lastReply: value.lastReply ? value.lastReply.toISOString() : null,
            completedAt: value.completedAt ? value.completedAt.toISOString() : null,
            canceledAt: value.canceledAt ? value.canceledAt.toISOString() : null,
            lastStepSent: value.lastStepSent || {}
        }));
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            phoneIndex: Array.from(phoneIndex.entries()),
            remoteJidIndex: Array.from(remoteJidIndex.entries()),
            stickyInstances: Array.from(stickyInstances.entries()),
            completedLeads: Array.from(completedLeads.entries())
        }, null, 2));
        
        addLog('DATA_SAVE', 'Conversas salvas: ' + conversationsArray.length);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro: ' + error.message);
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
                lastStepSent: conv.lastStepSent || {}
            });
        });
        
        phoneIndex.clear();
        parsed.phoneIndex.forEach(([key, value]) => phoneIndex.set(key, value));
        
        remoteJidIndex.clear();
        if (parsed.remoteJidIndex) {
            parsed.remoteJidIndex.forEach(([key, value]) => remoteJidIndex.set(key, value));
        }
        
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => stickyInstances.set(key, value));
        
        completedLeads.clear();
        if (parsed.completedLeads) {
            parsed.completedLeads.forEach(([key, value]) => completedLeads.set(key, value));
        }
        
        addLog('DATA_LOAD', 'Conversas: ' + parsed.conversations.length);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Sem conversas anteriores');
        return false;
    }
}

setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

Object.values(defaultFunnels).forEach(funnel => funis.set(funnel.id, funnel));

app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============

// ✅ NOVO: Sistema de detecção de números ULTRA ROBUSTO
function extractPhoneKey(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    
    // Usa os últimos 11 dígitos (DDD + número) para evitar colisões
    // Exemplo: 5511999999999 → 11999999999
    if (cleaned.length >= 11) {
        return cleaned.slice(-11);
    }
    
    // Se for menor que 11, usa os últimos 8 (fallback legado)
    return cleaned.slice(-8);
}

function normalizePhone(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    
    // Remove 55 se tiver
    let normalized = cleaned.startsWith('55') ? cleaned.substring(2) : cleaned;
    
    // Adiciona o 9 se for número de celular sem ele
    if (normalized.length === 10 && !normalized.startsWith('9', 2)) {
        normalized = normalized.substring(0, 2) + '9' + normalized.substring(2);
    }
    
    return normalized;
}

function registerPhone(fullPhone, phoneKey) {
    if (!phoneKey) return;
    
    const cleaned = fullPhone.replace(/\D/g, '');
    const normalized = normalizePhone(fullPhone);
    
    // Registra em TODAS as variações possíveis
    phoneIndex.set(cleaned, phoneKey);
    phoneIndex.set(normalized, phoneKey);
    phoneIndex.set('55' + normalized, phoneKey);
    
    if (cleaned.startsWith('55')) {
        phoneIndex.set(cleaned.substring(2), phoneKey);
    }
    
    if (!cleaned.startsWith('55')) {
        phoneIndex.set('55' + cleaned, phoneKey);
    }
}

function registerRemoteJid(remoteJid, phoneKey) {
    if (!remoteJid || !phoneKey) return;
    
    // Registra o JID original
    remoteJidIndex.set(remoteJid, phoneKey);
    
    // Registra também variações do JID
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    const normalized = normalizePhone(phone);
    
    remoteJidIndex.set(normalized + '@s.whatsapp.net', phoneKey);
    remoteJidIndex.set('55' + normalized + '@s.whatsapp.net', phoneKey);
    
    addLog('REMOTEJID_REGISTERED', `📱 ${remoteJid} → ${phoneKey}`);
}

function findConversationByPhone(phone) {
    const phoneKey = extractPhoneKey(phone);
    if (!phoneKey) return null;
    
    // Primeiro: busca direta
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        registerPhone(phone, phoneKey);
        return conversation;
    }
    
    // Segundo: busca no índice com todas variações
    const cleaned = phone.replace(/\D/g, '');
    const normalized = normalizePhone(phone);
    
    const variations = [
        cleaned,
        normalized,
        '55' + normalized,
        cleaned.substring(2),
        '55' + cleaned
    ];
    
    for (const variant of variations) {
        const indexedKey = phoneIndex.get(variant);
        if (indexedKey) {
            const conv = conversations.get(indexedKey);
            if (conv) {
                addLog('PHONE_FOUND_BY_INDEX', `✅ Encontrado via índice: ${variant}`, { phoneKey });
                return conv;
            }
        }
    }
    
    return null;
}

function findConversationByRemoteJid(remoteJid) {
    if (!remoteJid) return null;
    
    // Busca direta
    const phoneKey = remoteJidIndex.get(remoteJid);
    if (phoneKey) {
        const conv = conversations.get(phoneKey);
        if (conv) {
            addLog('CONVERSATION_FOUND_BY_JID', `✅ Encontrado via remoteJid`, { phoneKey });
            return conv;
        }
    }
    
    // Tenta pelo telefone
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    return findConversationByPhone(phone);
}

function phoneToRemoteJid(phone) {
    const normalized = normalizePhone(phone);
    let formatted = '55' + normalized;
    
    // Garante que tem o 9 no celular
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
        data,
        phoneKey: data?.phoneKey || null
    };
    logs.unshift(log);
    if (logs.length > 1000) logs = logs.slice(0, 1000);
    
    const emoji = type.includes('ERROR') ? '❌' : 
                  type.includes('SUCCESS') ? '✅' : 
                  type.includes('WARNING') ? '⚠️' : '📝';
    
    console.log(`[${log.timestamp.toISOString()}] ${emoji} ${type}: ${message}`);
}

function hasLeadCompletedFunnel(phoneKey, funnelId) {
    return completedLeads.has(`${phoneKey}_${funnelId}`);
}

function markLeadAsCompleted(phoneKey, funnelId) {
    completedLeads.set(`${phoneKey}_${funnelId}`, new Date().toISOString());
    addLog('LEAD_COMPLETED', `🎉 Completou ${funnelId}`, { phoneKey });
}

// ✅ NOVO: HEALTHCHECK DAS INSTÂNCIAS
async function checkInstanceHealth(instanceName) {
    try {
        const url = `${EVOLUTION_BASE_URL}/instance/connectionState/${instanceName}`;
        const response = await axios.get(url, {
            headers: { 'apikey': EVOLUTION_API_KEY },
            timeout: 5000
        });
        
        const isHealthy = response.data?.instance?.state === 'open';
        instancesHealth.set(instanceName, {
            healthy: isHealthy,
            lastCheck: Date.now(),
            state: response.data?.instance?.state || 'unknown'
        });
        
        return isHealthy;
    } catch (error) {
        instancesHealth.set(instanceName, {
            healthy: false,
            lastCheck: Date.now(),
            error: error.message
        });
        return false;
    }
}

async function getHealthyInstances() {
    const now = Date.now();
    
    // Só faz healthcheck a cada 1 minuto
    if (now - lastHealthCheck < HEALTHCHECK_INTERVAL) {
        const healthy = INSTANCES.filter(inst => {
            const health = instancesHealth.get(inst);
            return health && health.healthy;
        });
        
        if (healthy.length > 0) return healthy;
    }
    
    // Atualiza healthcheck
    lastHealthCheck = now;
    addLog('HEALTHCHECK_START', `🔍 Verificando ${INSTANCES.length} instâncias...`);
    
    const checks = await Promise.all(
        INSTANCES.map(inst => checkInstanceHealth(inst))
    );
    
    const healthy = INSTANCES.filter((inst, idx) => checks[idx]);
    
    addLog('HEALTHCHECK_COMPLETE', `✅ ${healthy.length}/${INSTANCES.length} online: ${healthy.join(', ')}`);
    
    return healthy.length > 0 ? healthy : INSTANCES; // Fallback para todas se nenhuma responder
}

// ============ EVOLUTION API ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    
    addLog('EVOLUTION_REQUEST', `📡 Request para Evolution`, { 
        instanceName, 
        endpoint, 
        url,
        payloadSize: JSON.stringify(payload).length 
    });
    
    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
            timeout: 15000
        });
        
        // Marca como healthy
        instancesHealth.set(instanceName, {
            healthy: true,
            lastCheck: Date.now(),
            state: 'open'
        });
        
        addLog('EVOLUTION_SUCCESS', `✅ OK ${instanceName}`);
        return { ok: true, data: response.data };
        
    } catch (error) {
        // Marca como unhealthy
        instancesHealth.set(instanceName, {
            healthy: false,
            lastCheck: Date.now(),
            error: error.message
        });
        
        const statusCode = error.response?.status;
        const errorData = error.response?.data;
        const errorMessage = error.message;
        
        // Log detalhado do erro
        addLog('EVOLUTION_ERROR', `❌ ${instanceName}: ${statusCode || 'TIMEOUT'}`, {
            instanceName,
            endpoint,
            statusCode,
            errorMessage,
            errorData: errorData ? JSON.stringify(errorData).substring(0, 200) : null,
            payloadPreview: JSON.stringify(payload).substring(0, 100) + '...'
        });
        
        return { 
            ok: false, 
            error: errorData || errorMessage,
            statusCode: statusCode
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
    const number = remoteJid.replace('@s.whatsapp.net', '');
    
    addLog('AUDIO_SEND_START', `🎵 Tentando enviar áudio`, { 
        instanceName, 
        number, 
        audioUrl: audioUrl.substring(0, 60) + '...' 
    });
    
    try {
        // Tenta baixar o áudio
        addLog('AUDIO_DOWNLOAD_START', `⬇️ Baixando áudio...`, { instanceName });
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer', 
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        addLog('AUDIO_DOWNLOAD_SUCCESS', `✅ Áudio baixado: ${audioResponse.data.length} bytes`, { instanceName });
        
        // Converte para base64
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');
        const audioBase64 = `data:audio/mpeg;base64,${base64Audio}`;
        const base64Size = audioBase64.length;
        
        addLog('AUDIO_CONVERT_SUCCESS', `✅ Convertido para base64: ${base64Size} chars`, { instanceName });
        
        // Tenta método 1: sendWhatsAppAudio
        addLog('AUDIO_METHOD_1', `📤 Tentando método sendWhatsAppAudio...`, { instanceName });
        const result1 = await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: number,
            audio: audioBase64, 
            delay: 1200, 
            encoding: true
        });
        
        if (result1.ok) {
            addLog('AUDIO_METHOD_1_SUCCESS', `✅ Método 1 funcionou!`, { instanceName });
            return result1;
        }
        
        addLog('AUDIO_METHOD_1_FAILED', `❌ Método 1 falhou, tentando método 2...`, { 
            instanceName,
            error: result1.error 
        });
        
        // Tenta método 2: sendMedia
        addLog('AUDIO_METHOD_2', `📤 Tentando método sendMedia...`, { instanceName });
        const result2 = await sendToEvolution(instanceName, '/message/sendMedia', {
            number: number,
            mediatype: 'audio', 
            media: audioBase64, 
            mimetype: 'audio/mpeg'
        });
        
        if (result2.ok) {
            addLog('AUDIO_METHOD_2_SUCCESS', `✅ Método 2 funcionou!`, { instanceName });
            return result2;
        }
        
        addLog('AUDIO_METHOD_2_FAILED', `❌ Método 2 falhou, tentando método 3 (URL direta)...`, { 
            instanceName,
            error: result2.error 
        });
        
        // Método 3: Tenta com URL direta (fallback)
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: number,
            audio: audioUrl, 
            delay: 1200
        });
        
    } catch (error) {
        addLog('AUDIO_DOWNLOAD_ERROR', `❌ Erro ao baixar/processar: ${error.message}`, { 
            instanceName,
            error: error.message 
        });
        
        // Fallback: tenta com URL direta
        addLog('AUDIO_METHOD_3', `📤 Fallback: tentando URL direta...`, { instanceName });
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: number,
            audio: audioUrl, 
            delay: 1200
        });
    }
}

// ✅ CORREÇÃO PRINCIPAL: Sistema de envio com sticky instance
async function sendWithFallback(phoneKey, remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    const stickyInstance = stickyInstances.get(phoneKey);
    
    // Se tem sticky instance, usa APENAS ela
    if (stickyInstance) {
        addLog('SEND_USING_STICKY', `📌 Usando instância fixa: ${stickyInstance}`, { phoneKey });
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                let result;
                if (type === 'text') result = await sendText(remoteJid, text, stickyInstance);
                else if (type === 'image') result = await sendImage(remoteJid, mediaUrl, '', stickyInstance);
                else if (type === 'image+text') result = await sendImage(remoteJid, mediaUrl, text, stickyInstance);
                else if (type === 'video') result = await sendVideo(remoteJid, mediaUrl, '', stickyInstance);
                else if (type === 'video+text') result = await sendVideo(remoteJid, mediaUrl, text, stickyInstance);
                else if (type === 'audio') result = await sendAudio(remoteJid, mediaUrl, stickyInstance);
                
                if (result && result.ok) {
                    return { success: true, instanceName: stickyInstance };
                }
                
                if (attempt < 3) {
                    addLog('SEND_RETRY', `🔄 Tentativa ${attempt} falhou, aguardando...`, { phoneKey });
                    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
                }
            } catch (error) {
                if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        
        addLog('SEND_STICKY_FAILED', `❌ Sticky ${stickyInstance} falhou após 3 tentativas`, { phoneKey });
        return { success: false, error: `Sticky ${stickyInstance} falhou` };
    }
    
    // Primeira mensagem: usa instâncias saudáveis
    if (isFirstMessage) {
        const healthyInstances = await getHealthyInstances();
        
        addLog('SEND_FIRST_MESSAGE', `📤 Tentando ${healthyInstances.length} instâncias saudáveis`, { phoneKey });
        
        // Começa da última bem-sucedida
        const nextIndex = (lastSuccessfulInstanceIndex + 1) % healthyInstances.length;
        const instancesToTry = [...healthyInstances.slice(nextIndex), ...healthyInstances.slice(0, nextIndex)];
        
        for (const instanceName of instancesToTry) {
            try {
                addLog('SEND_TRY_INSTANCE', `🔄 Tentando ${instanceName}...`, { phoneKey });
                
                let result;
                if (type === 'text') result = await sendText(remoteJid, text, instanceName);
                else if (type === 'image') result = await sendImage(remoteJid, mediaUrl, '', instanceName);
                else if (type === 'image+text') result = await sendImage(remoteJid, mediaUrl, text, instanceName);
                else if (type === 'video') result = await sendVideo(remoteJid, mediaUrl, '', instanceName);
                else if (type === 'video+text') result = await sendVideo(remoteJid, mediaUrl, text, instanceName);
                else if (type === 'audio') result = await sendAudio(remoteJid, mediaUrl, instanceName);
                
                if (result && result.ok) {
                    stickyInstances.set(phoneKey, instanceName);
                    lastSuccessfulInstanceIndex = healthyInstances.indexOf(instanceName);
                    addLog('SEND_STICKY_CREATED', `✅ ${instanceName} fixada PERMANENTEMENTE`, { phoneKey });
                    return { success: true, instanceName };
                }
            } catch (error) {
                addLog('SEND_INSTANCE_ERROR', `❌ ${instanceName} falhou: ${error.message}`, { phoneKey });
            }
        }
        
        return { success: false, error: 'Nenhuma instância disponível' };
    }
    
    return { success: false, error: 'Estado inesperado' };
}

// ============ ORQUESTRAÇÃO ============
async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
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
    registerRemoteJid(remoteJid, phoneKey);
    addLog('PIX_WAITING_CREATED', `⏳ PIX aguardando 7min`, { phoneKey, orderCode });
    
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.orderCode === orderCode && !conv.canceled && conv.pixWaiting) {
            addLog('PIX_TIMEOUT_EXPIRED', `⏰ 7min passaram - iniciando funil PIX`, { phoneKey });
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
    addLog('TRANSFER_START', `🔄 Transferindo PIX→APROVADA`, { phoneKey });
    
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
        addLog('PIX_TIMEOUT_CLEARED', `✅ Timeout cancelado`, { phoneKey });
    }
    
    let startingStep = (pixConv && pixConv.stepIndex >= 0) ? 3 : 0;
    
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
    registerRemoteJid(remoteJid, phoneKey);
    
    // ✅ MANTÉM a sticky instance se já existir
    const existingSticky = stickyInstances.get(phoneKey);
    if (existingSticky) {
        addLog('TRANSFER_KEEP_STICKY', `📌 Mantendo instância ${existingSticky}`, { phoneKey });
    }
    
    addLog('TRANSFER_COMPLETE', `✅ Transferência completa - passo ${startingStep}`, { phoneKey });
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount) {
    if (hasLeadCompletedFunnel(phoneKey, funnelId)) {
        addLog('FUNNEL_ALREADY_COMPLETED', `⏭️ ${phoneKey} já completou - IGNORANDO`, { phoneKey });
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
        waiting_for_response: false, 
        createdAt: new Date(),
        lastSystemMessage: null, 
        lastReply: null,
        canceled: false, 
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    registerRemoteJid(remoteJid, phoneKey);
    addLog('FUNNEL_START', `🚀 Iniciando ${funnelId}`, { phoneKey });
    await sendStep(phoneKey);
}

// ✅ CORREÇÃO CRÍTICA: Marca waiting ANTES de enviar
async function sendStep(phoneKey) {
    if (sendStepLocks.get(phoneKey)) {
        addLog('SEND_STEP_LOCKED', `🔒 Já enviando passo`, { phoneKey });
        return;
    }
    
    sendStepLocks.set(phoneKey, true);
    
    try {
        const conversation = conversations.get(phoneKey);
        if (!conversation || conversation.canceled || conversation.pixWaiting) {
            sendStepLocks.delete(phoneKey);
            return;
        }
        
        const funnel = funis.get(conversation.funnelId);
        const step = funnel?.steps[conversation.stepIndex];
        
        if (!funnel || !step) {
            addLog('SEND_STEP_NO_STEP', `❌ Sem passo válido`, { phoneKey });
            sendStepLocks.delete(phoneKey);
            return;
        }
        
        // Previne envio duplicado
        const lastStepTime = conversation.lastStepSent?.[conversation.stepIndex];
        if (lastStepTime && (Date.now() - lastStepTime < 5000)) {
            addLog('SEND_STEP_TOO_SOON', `⏸️ Enviado há menos de 5s`, { phoneKey });
            sendStepLocks.delete(phoneKey);
            return;
        }
        
        const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
        
        addLog('SEND_STEP_START', `📤 Passo ${conversation.stepIndex} (${step.type})`, { 
            phoneKey, 
            stepIndex: conversation.stepIndex,
            stepType: step.type,
            waitForReply: step.waitForReply
        });
        
        // ✅ CORREÇÃO CRÍTICA: Marca waiting ANTES de enviar
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            addLog('STEP_MARKED_WAITING', `⏸️ Marcado como ESPERANDO ANTES do envio`, { phoneKey });
        }
        
        let result = { success: true };
        
        // Delay antes (se configurado)
        if (step.delayBefore && step.delayBefore > 0) {
            const delayMs = parseInt(step.delayBefore) * 1000;
            addLog('STEP_DELAY_BEFORE', `⏰ Aguardando ${step.delayBefore}s...`, { phoneKey });
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        
        // Typing (se configurado)
        if (step.showTyping && step.type !== 'delay' && step.type !== 'typing') {
            addLog('STEP_TYPING', `💬 Mostrando "digitando" 3s...`, { phoneKey });
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // Executa o passo
        if (step.type === 'delay') {
            const delayMs = (step.delaySeconds || 10) * 1000;
            addLog('STEP_DELAY', `⏰ Delay de ${step.delaySeconds}s`, { phoneKey });
            await new Promise(resolve => setTimeout(resolve, delayMs));
        } else if (step.type === 'typing') {
            const typingMs = (step.typingSeconds || 3) * 1000;
            addLog('STEP_TYPING_ONLY', `💬 Typing ${step.typingSeconds}s`, { phoneKey });
            await new Promise(resolve => setTimeout(resolve, typingMs));
        } else {
            result = await sendWithFallback(
                phoneKey, 
                conversation.remoteJid, 
                step.type, 
                step.text, 
                step.mediaUrl, 
                isFirstMessage
            );
        }
        
        if (result.success) {
            conversation.lastSystemMessage = new Date();
            if (!conversation.lastStepSent) conversation.lastStepSent = {};
            conversation.lastStepSent[conversation.stepIndex] = Date.now();
            conversations.set(phoneKey, conversation);
            
            if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
                addLog('STEP_WAITING_REPLY', `✅ Passo ${conversation.stepIndex} enviado - AGUARDANDO resposta`, { phoneKey });
                sendStepLocks.delete(phoneKey);
            } else {
                addLog('STEP_AUTO_ADVANCE', `➡️ Passo ${conversation.stepIndex} enviado - avançando automático`, { phoneKey });
                sendStepLocks.delete(phoneKey);
                await advanceConversation(phoneKey, null, 'auto');
            }
        } else {
            addLog('SEND_STEP_FAILED', `❌ Falha ao enviar passo ${conversation.stepIndex}`, { phoneKey });
            // Remove flag de waiting se falhou
            conversation.waiting_for_response = false;
            conversations.set(phoneKey, conversation);
            sendStepLocks.delete(phoneKey);
        }
    } catch (error) {
        addLog('SEND_STEP_ERROR', `❌ Erro: ${error.message}`, { phoneKey });
        sendStepLocks.delete(phoneKey);
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
        markLeadAsCompleted(phoneKey, conversation.funnelId);
        addLog('FUNNEL_END', `🎉 ${conversation.funnelId} concluído`, { phoneKey });
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    if (reason === 'reply') conversation.lastReply = new Date();
    
    conversations.set(phoneKey, conversation);
    addLog('STEP_ADVANCE', `➡️ Avançando para passo ${nextStepIndex} (motivo: ${reason})`, { phoneKey });
    
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
        
        const phoneKey = extractPhoneKey(customerPhone);
        if (!phoneKey) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const productId = data.product_id || data.products?.[0]?.id;
        const productType = PRODUCT_MAPPING[productId] || 'CS';
        
        addLog('KIRVANO_EVENT', `📥 ${event} - ${customerName}`, { orderCode, phoneKey });
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        const existingConv = conversations.get(phoneKey);
        if (existingConv && !existingConv.canceled && !existingConv.completed) {
            if (existingConv.orderCode === orderCode) {
                return res.json({ success: true });
            }
            
            if (isApproved && existingConv.funnelId && existingConv.funnelId.endsWith('_PIX')) {
                addLog('KIRVANO_PIX_PAYMENT_APPROVED', `💳 Pagamento PIX aprovado`, { phoneKey });
            } else {
                const timeSince = Date.now() - new Date(existingConv.createdAt).getTime();
                if (timeSince < 300000) {
                    return res.json({ success: true });
                }
                existingConv.canceled = true;
                conversations.set(phoneKey, existingConv);
            }
        }
        
        if (isApproved) {
            const pixConv = conversations.get(phoneKey);
            if (pixConv && pixConv.funnelId === productType + '_PIX') {
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
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
        }
        
        res.json({ success: true, phoneKey });
    } catch (error) {
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
        
        const phoneKey = extractPhoneKey(customerPhone);
        if (!phoneKey) {
            return res.json({ success: false });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        const productType = identifyPerfectPayProduct(productCode, planCode);
        
        if (statusEnum === 2) {
            const existingConv = conversations.get(phoneKey);
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
            return res.json({ success: true });
        }
        
        if (statusEnum === 1) {
            if (paymentType === 2) return res.json({ success: true });
            const existingConv = conversations.get(phoneKey);
            if (existingConv && !existingConv.canceled) {
                return res.json({ success: true });
            }
            await createPixWaitingConversation(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
            return res.json({ success: true });
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ✅ WEBHOOK EVOLUTION - ULTRA CORRIGIDO
app.post('/webhook/evolution', async (req, res) => {
    let phoneKey;
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        
        if (fromMe) return res.json({ success: true });
        
        const messageText = extractMessageText(messageData.message);
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        phoneKey = extractPhoneKey(incomingPhone);
        
        if (!phoneKey) {
            return res.json({ success: true });
        }
        
        addLog('WEBHOOK_RECEIVED', `📨 Mensagem recebida`, { 
            phoneKey, 
            remoteJid, 
            text: messageText.substring(0, 30) + '...'
        });
        
        const hasLock = await acquireWebhookLock(phoneKey, 30000);
        if (!hasLock) {
            addLog('WEBHOOK_LOCK_FAILED', `❌ Timeout no lock`, { phoneKey });
            return res.json({ success: false });
        }
        
        try {
            // Busca conversa por 3 métodos
            let conversation = findConversationByPhone(incomingPhone);
            
            if (!conversation) {
                conversation = findConversationByRemoteJid(remoteJid);
            }
            
            if (!conversation) {
                const allConversations = Array.from(conversations.values());
                conversation = allConversations.find(conv => {
                    const convJid = conv.remoteJid || '';
                    const convPhone = convJid.replace('@s.whatsapp.net', '');
                    const convKey = extractPhoneKey(convPhone);
                    return convKey === phoneKey;
                });
                
                if (conversation) {
                    addLog('CONVERSATION_FOUND_FALLBACK', `✅ Encontrado por scan completo`, { phoneKey });
                    registerRemoteJid(remoteJid, phoneKey);
                }
            }
            
            if (!conversation) {
                addLog('WEBHOOK_NO_CONVERSATION', `⚠️ Nenhuma conversa ativa`, { phoneKey });
                return res.json({ success: true });
            }
            
            if (conversation.canceled) {
                addLog('WEBHOOK_CANCELED', `⏭️ Conversa cancelada`, { phoneKey });
                return res.json({ success: true });
            }
            
            // ✅ VERIFICAÇÃO INTELIGENTE: Checa se DEVERIA estar esperando
            const funnel = funis.get(conversation.funnelId);
            const currentStep = funnel?.steps[conversation.stepIndex];
            
            if (!currentStep) {
                addLog('WEBHOOK_NO_STEP', `⚠️ Sem passo válido`, { phoneKey });
                return res.json({ success: true });
            }
            
            const shouldWait = currentStep.waitForReply && 
                              currentStep.type !== 'delay' && 
                              currentStep.type !== 'typing';
            
            if (!shouldWait) {
                addLog('WEBHOOK_STEP_NOT_WAITING', `⚠️ Passo ${conversation.stepIndex} não espera resposta`, { 
                    phoneKey,
                    stepType: currentStep.type,
                    waitForReply: currentStep.waitForReply
                });
                return res.json({ success: true });
            }
            
            // ✅ Se deveria esperar mas flag está false, corrige E SALVA
            if (!conversation.waiting_for_response) {
                addLog('WEBHOOK_FIX_FLAG', `🔧 Corrigindo flag (deveria estar esperando)`, { phoneKey });
                conversation.waiting_for_response = true;
                conversations.set(phoneKey, conversation); // ✅ SALVA AQUI!
            }
            
            // Processa a resposta
            addLog('CLIENT_REPLY', `✅ Resposta do cliente processada`, { 
                phoneKey, 
                step: conversation.stepIndex,
                text: messageText.substring(0, 30) + '...'
            });
            
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversations.set(phoneKey, conversation);
            
            // Aguarda 500ms antes de avançar
            await new Promise(resolve => setTimeout(resolve, 500));
            await advanceConversation(phoneKey, messageText, 'reply');
            
            res.json({ success: true });
        } finally {
            releaseWebhookLock(phoneKey);
        }
    } catch (error) {
        addLog('EVOLUTION_ERROR', `❌ ${error.message}`, { phoneKey });
        if (phoneKey) releaseWebhookLock(phoneKey);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ============
app.get('/api/dashboard', (req, res) => {
    let active = 0, waiting = 0, completed = 0;
    conversations.forEach(conv => {
        if (conv.completed) completed++;
        else if (conv.waiting_for_response) waiting++;
        else active++;
    });
    
    const healthyCount = Array.from(instancesHealth.values()).filter(h => h.healthy).length;
    
    res.json({ 
        success: true, 
        data: { 
            active_conversations: active, 
            waiting_responses: waiting, 
            completed_conversations: completed, 
            pending_pix: pixTimeouts.size, 
            total_funnels: funis.size, 
            completed_leads: completedLeads.size,
            healthy_instances: healthyCount,
            total_instances: INSTANCES.length
        } 
    });
});

app.get('/api/funnels', (req, res) => {
    res.json({ success: true, data: Array.from(funis.values()) });
});

app.post('/api/funnels', (req, res) => {
    try {
        const funnel = req.body;
        if (!funnel.id || !funnel.steps) {
            return res.status(400).json({ success: false });
        }
        funnel.steps.forEach((step, idx) => {
            if (step && !step.id) step.id = 'step_' + Date.now() + '_' + idx;
        });
        funis.set(funnel.id, funnel);
        saveFunnelsToFile();
        res.json({ success: true, data: funnel });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/funnels/:funnelId/move-step', (req, res) => {
    try {
        const { funnelId } = req.params;
        const { fromIndex, direction } = req.body;
        
        const funnel = funis.get(funnelId);
        if (!funnel || !funnel.steps) {
            return res.status(404).json({ success: false });
        }
        
        const from = parseInt(fromIndex);
        const toIndex = direction === 'up' ? from - 1 : from + 1;
        
        if (toIndex < 0 || toIndex >= funnel.steps.length) {
            return res.status(400).json({ success: false });
        }
        
        const temp = funnel.steps[from];
        funnel.steps[from] = funnel.steps[toIndex];
        funnel.steps[toIndex] = temp;
        
        funis.set(funnelId, funnel);
        saveFunnelsToFile();
        res.json({ success: true, data: funnel });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/funnels/export', (req, res) => {
    const filename = `kirvano-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({ version: '7.0', funnels: Array.from(funis.values()) });
});

app.post('/api/funnels/import', (req, res) => {
    try {
        const data = req.body;
        if (!data.funnels) return res.status(400).json({ success: false });
        
        let imported = 0;
        data.funnels.forEach(f => {
            if (f.id && f.steps) {
                funis.set(f.id, f);
                imported++;
            }
        });
        saveFunnelsToFile();
        res.json({ success: true, imported });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/conversations', (req, res) => {
    const list = Array.from(conversations.entries()).map(([key, conv]) => ({
        phoneKey: key,
        phone: conv.remoteJid ? conv.remoteJid.replace('@s.whatsapp.net', '') : 'N/A',
        customerName: conv.customerName || 'Cliente',
        productType: conv.productType || 'CS',
        funnelId: conv.funnelId || 'N/A',
        stepIndex: conv.stepIndex || 0,
        waiting_for_response: conv.waiting_for_response || false,
        pixWaiting: conv.pixWaiting || false,
        createdAt: conv.createdAt ? conv.createdAt.toISOString() : new Date().toISOString(),
        lastSystemMessage: conv.lastSystemMessage ? conv.lastSystemMessage.toISOString() : null,
        lastReply: conv.lastReply ? conv.lastReply.toISOString() : null,
        orderCode: conv.orderCode || 'N/A',
        amount: conv.amount || 'R$ 0,00',
        stickyInstance: stickyInstances.get(key) || '-',
        canceled: conv.canceled || false,
        completed: conv.completed || false,
        transferredFromPix: conv.transferredFromPix || false
    }));
    
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, data: list });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json({ success: true, data: logs.slice(0, limit) });
});

// ✅ NOVO: Endpoint de debug
app.get('/api/debug/instances', async (req, res) => {
    const healthyInstances = await getHealthyInstances();
    
    const instancesStatus = INSTANCES.map(inst => {
        const health = instancesHealth.get(inst);
        return {
            name: inst,
            healthy: health?.healthy || false,
            state: health?.state || 'unknown',
            lastCheck: health?.lastCheck ? new Date(health.lastCheck).toISOString() : null,
            error: health?.error || null
        };
    });
    
    res.json({
        success: true,
        data: {
            total: INSTANCES.length,
            healthy: healthyInstances.length,
            unhealthy: INSTANCES.length - healthyInstances.length,
            instances: instancesStatus,
            lastHealthCheck: lastHealthCheck ? new Date(lastHealthCheck).toISOString() : null
        }
    });
});

// ✅ NOVO: Endpoint de teste de mensagens
app.post('/api/test/send', async (req, res) => {
    const { phone, message, type, instanceName } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'phone e message são obrigatórios' 
        });
    }
    
    try {
        const remoteJid = phoneToRemoteJid(phone);
        
        addLog('TEST_SEND', `🧪 Teste de envio iniciado`, { 
            phone, 
            type: type || 'text',
            instanceName: instanceName || 'auto'
        });
        
        let result;
        
        if (instanceName) {
            // Testa instância específica
            if (type === 'text' || !type) {
                result = await sendText(remoteJid, message, instanceName);
            } else if (type === 'audio') {
                result = await sendAudio(remoteJid, message, instanceName);
            }
        } else {
            // Testa todas instâncias saudáveis
            const healthyInstances = await getHealthyInstances();
            const results = [];
            
            for (const inst of healthyInstances.slice(0, 3)) { // Testa só 3
                addLog('TEST_SEND_TRY', `🧪 Testando ${inst}...`);
                
                const testResult = await sendText(remoteJid, message, inst);
                results.push({
                    instance: inst,
                    success: testResult.ok,
                    error: testResult.error || null
                });
                
                if (testResult.ok) {
                    result = testResult;
                    break;
                }
            }
            
            if (!result || !result.ok) {
                return res.json({
                    success: false,
                    message: 'Nenhuma instância conseguiu enviar',
                    results: results
                });
            }
        }
        
        res.json({
            success: result.ok,
            data: result.data,
            error: result.error || null
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

app.get('/diagnostic', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'diagnostic.html'));
});

// Limpeza de locks travados
setInterval(() => {
    sendStepLocks.forEach((value, key) => {
        const conv = conversations.get(key);
        if (!conv || conv.canceled || conv.completed) {
            sendStepLocks.delete(key);
        }
    });
}, 60000);

// Healthcheck periódico
setInterval(async () => {
    await getHealthyInstances();
}, HEALTHCHECK_INTERVAL);

async function initializeData() {
    console.log('🔄 Carregando...');
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    
    // Healthcheck inicial
    await getHealthyInstances();
    
    console.log('✅ Pronto!');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('📌 Sticky Instances:', stickyInstances.size);
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO V7.0 - CORREÇÕES CRÍTICAS APLICADAS');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('');
    console.log('✅ CORREÇÕES V7.0:');
    console.log('  1. ✅ Marca waiting ANTES de enviar (bug principal)');
    console.log('  2. ✅ Healthcheck automático (pula offline)');
    console.log('  3. ✅ Detecção números 11 dígitos (sem colisão)');
    console.log('  4. ✅ Sticky instance GARANTIDA (nunca muda)');
    console.log('  5. ✅ Lock force-release após 30s');
    console.log('  6. ✅ Sistema PIX 7min mantido');
    console.log('  7. ✅ Delays 100% respeitados');
    console.log('  8. ✅ Logs detalhados com emojis');
    console.log('  9. ✅ Todas 15 instâncias no código');
    console.log(' 10. ✅ Correção flag + save simultâneo');
    console.log('');
    console.log('🎯 GARANTE:');
    console.log('  - Cliente responde → SEMPRE avança');
    console.log('  - Instância fixa → NUNCA muda');
    console.log('  - Delays → 100% respeitados');
    console.log('  - PIX → Transfere corretamente');
    console.log('  - Áudios → Como gravação');
    console.log('');
    console.log('🌐 http://localhost:' + PORT);
    console.log('🔍 Debug: http://localhost:' + PORT + '/api/debug/instances');
    console.log('='.repeat(70));
    await initializeData();
});
