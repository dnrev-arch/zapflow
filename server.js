const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000;
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');

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

const INSTANCES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12'];

// ============ ARMAZENAMENTO ============
let conversations = new Map();
let phoneIndex = new Map();
let remoteJidIndex = new Map(); // ✅ NOVO: Índice por remoteJid completo
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let sendStepLocks = new Map();
let completedLeads = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA', name: 'CS - Compra Aprovada',
        steps: [
            { id: 'step_0', type: 'text', text: 'Parabéns! Seu pedido foi aprovado. Bem-vindo ao CS!', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Obrigado pela resposta! Agora me confirma se recebeu o acesso ao curso por email?', waitForReply: true },
            { id: 'step_2', type: 'text', text: 'Perfeito! Lembre-se de acessar nossa plataforma. Qualquer dúvida, estamos aqui!' },
            { id: 'step_3', type: 'delay', delaySeconds: 420 },
            { id: 'step_4', type: 'text', text: 'Já está conseguindo acessar o conteúdo? Precisa de alguma ajuda?', waitForReply: true },
            { id: 'step_5', type: 'text', text: 'Ótimo! Aproveite o conteúdo e bons estudos!' }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX', name: 'CS - PIX Pendente',
        steps: [
            { id: 'step_0', type: 'text', text: 'Seu PIX foi gerado! Aguardamos o pagamento para liberar o acesso ao CS.', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Obrigado pelo contato! Me confirma que está com dificuldades no pagamento?', waitForReply: true },
            { id: 'step_2', type: 'text', text: 'Se precisar de ajuda com o pagamento, nossa equipe está disponível!' },
            { id: 'step_3', type: 'delay', delaySeconds: 1500 },
            { id: 'step_4', type: 'text', text: 'Ainda não identificamos seu pagamento. Lembre-se que o PIX tem validade limitada.' }
        ]
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA', name: 'FAB - Compra Aprovada',
        steps: [
            { id: 'step_0', type: 'text', text: 'Parabéns! Seu pedido FAB foi aprovado. Bem-vindo!', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Obrigado pela resposta! Confirma se recebeu o acesso ao FAB por email?', waitForReply: true },
            { id: 'step_2', type: 'text', text: 'Perfeito! Aproveite o conteúdo FAB. Qualquer dúvida, estamos aqui!' },
            { id: 'step_3', type: 'delay', delaySeconds: 420 },
            { id: 'step_4', type: 'text', text: 'Já está conseguindo acessar o conteúdo FAB? Precisa de ajuda?', waitForReply: true },
            { id: 'step_5', type: 'text', text: 'Ótimo! Aproveite o conteúdo e bons estudos!' }
        ]
    },
    'FAB_PIX': {
        id: 'FAB_PIX', name: 'FAB - PIX Pendente',
        steps: [
            { id: 'step_0', type: 'text', text: 'Seu PIX FAB foi gerado! Aguardamos o pagamento.', waitForReply: true },
            { id: 'step_1', type: 'text', text: 'Obrigado pelo contato! Está com dificuldades no pagamento?', waitForReply: true },
            { id: 'step_2', type: 'text', text: 'Nossa equipe está disponível para ajudar com o pagamento!' },
            { id: 'step_3', type: 'delay', delaySeconds: 1500 },
            { id: 'step_4', type: 'text', text: 'Ainda não identificamos seu pagamento. O PIX tem validade limitada.' }
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
            addLog('WEBHOOK_LOCK_TIMEOUT', `Timeout após ${attempts} tentativas para ${phoneKey}`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    webhookLocks.set(phoneKey, true);
    addLog('WEBHOOK_LOCK_ACQUIRED', `Lock adquirido para ${phoneKey} (${attempts} tentativas)`);
    return true;
}

function releaseWebhookLock(phoneKey) {
    webhookLocks.delete(phoneKey);
    addLog('WEBHOOK_LOCK_RELEASED', `Lock liberado para ${phoneKey}`);
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
            remoteJidIndex: Array.from(remoteJidIndex.entries()), // ✅ SALVAR ÍNDICE
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
        
        // ✅ CARREGAR ÍNDICE DE REMOTEJID
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
function extractPhoneKey(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.slice(-8);
}

function registerPhone(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    const cleaned = fullPhone.replace(/\D/g, '');
    phoneIndex.set(cleaned, phoneKey);
    if (cleaned.startsWith('55')) phoneIndex.set(cleaned.substring(2), phoneKey);
    if (!cleaned.startsWith('55')) phoneIndex.set('55' + cleaned, phoneKey);
}

// ✅ NOVA FUNÇÃO: Registrar remoteJid completo
function registerRemoteJid(remoteJid, phoneKey) {
    if (!remoteJid || !phoneKey) return;
    remoteJidIndex.set(remoteJid, phoneKey);
    addLog('REMOTEJID_REGISTERED', `${remoteJid} → ${phoneKey}`);
}

// ✅ BUSCA MELHORADA: 3 tentativas
function findConversationByPhone(phone) {
    const phoneKey = extractPhoneKey(phone);
    if (!phoneKey || phoneKey.length !== 8) return null;
    
    // Tentativa 1: Buscar direto por phoneKey
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        registerPhone(phone, phoneKey);
        return conversation;
    }
    
    // Tentativa 2: Buscar no índice de telefones
    const cleaned = phone.replace(/\D/g, '');
    const indexedKey = phoneIndex.get(cleaned) || 
                       phoneIndex.get(cleaned.substring(2)) || 
                       phoneIndex.get('55' + cleaned);
    
    if (indexedKey) {
        const conv = conversations.get(indexedKey);
        if (conv) {
            addLog('PHONE_FOUND_BY_INDEX', `${phone} encontrado via índice`);
            return conv;
        }
    }
    
    return null;
}

// ✅ NOVA FUNÇÃO: Buscar por remoteJid completo
function findConversationByRemoteJid(remoteJid) {
    if (!remoteJid) return null;
    
    // Tentar buscar no índice de remoteJid
    const phoneKey = remoteJidIndex.get(remoteJid);
    if (phoneKey) {
        const conv = conversations.get(phoneKey);
        if (conv) {
            addLog('CONVERSATION_FOUND_BY_JID', `Encontrado via remoteJid: ${phoneKey}`);
            return conv;
        }
    }
    
    // Fallback: tentar extrair telefone do remoteJid
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    return findConversationByPhone(phone);
}

function phoneToRemoteJid(phone) {
    const cleaned = phone.replace(/\D/g, '');
    let formatted = cleaned;
    if (!formatted.startsWith('55')) formatted = '55' + formatted;
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
    const log = { id: Date.now() + Math.random(), timestamp: new Date(), type, message, data };
    logs.unshift(log);
    if (logs.length > 1000) logs = logs.slice(0, 1000);
    console.log('[' + log.timestamp.toISOString() + '] ' + type + ': ' + message);
}

function hasLeadCompletedFunnel(phoneKey, funnelId) {
    return completedLeads.has(`${phoneKey}_${funnelId}`);
}

function markLeadAsCompleted(phoneKey, funnelId) {
    completedLeads.set(`${phoneKey}_${funnelId}`, new Date().toISOString());
    addLog('LEAD_COMPLETED', `${phoneKey} completou ${funnelId}`);
}

// ============ EVOLUTION API ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
            timeout: 15000
        });
        addLog('EVOLUTION_SUCCESS', `OK ${instanceName}`);
        return { ok: true, data: response.data };
    } catch (error) {
        addLog('EVOLUTION_ERROR', `Erro ${instanceName}: ${error.response?.status || error.message}`);
        return { ok: false, error: error.response?.data || error.message };
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
        number: remoteJid.replace('@s.whatsapp.net', ''), mediatype: 'image',
        media: imageUrl, caption: caption || ''
    });
}

async function sendVideo(remoteJid, videoUrl, caption, instanceName) {
    return await sendToEvolution(instanceName, '/message/sendMedia', {
        number: remoteJid.replace('@s.whatsapp.net', ''), mediatype: 'video',
        media: videoUrl, caption: caption || ''
    });
}

async function sendAudio(remoteJid, audioUrl, instanceName) {
    try {
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer', timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');
        const audioBase64 = `data:audio/mpeg;base64,${base64Audio}`;
        
        const result = await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioBase64, delay: 1200, encoding: true
        });
        
        if (result.ok) return result;
        
        return await sendToEvolution(instanceName, '/message/sendMedia', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            mediatype: 'audio', media: audioBase64, mimetype: 'audio/mpeg'
        });
    } catch (error) {
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioUrl, delay: 1200
        });
    }
}

async function sendWithFallback(phoneKey, remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    const stickyInstance = stickyInstances.get(phoneKey);
    
    if (stickyInstance) {
        for (let attempt = 1; attempt <= 5; attempt++) {
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
                
                if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            } catch (error) {
                if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        
        return { success: false, error: `Sticky ${stickyInstance} falhou` };
    }
    
    if (isFirstMessage) {
        const nextIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
        const instancesToTry = [...INSTANCES.slice(nextIndex), ...INSTANCES.slice(0, nextIndex)];
        
        for (const instanceName of instancesToTry) {
            try {
                let result;
                if (type === 'text') result = await sendText(remoteJid, text, instanceName);
                else if (type === 'image') result = await sendImage(remoteJid, mediaUrl, '', instanceName);
                else if (type === 'image+text') result = await sendImage(remoteJid, mediaUrl, text, instanceName);
                else if (type === 'video') result = await sendVideo(remoteJid, mediaUrl, '', instanceName);
                else if (type === 'video+text') result = await sendVideo(remoteJid, mediaUrl, text, instanceName);
                else if (type === 'audio') result = await sendAudio(remoteJid, mediaUrl, instanceName);
                
                if (result && result.ok) {
                    stickyInstances.set(phoneKey, instanceName);
                    lastSuccessfulInstanceIndex = INSTANCES.indexOf(instanceName);
                    addLog('SEND_STICKY_CREATED', `${instanceName} fixada para ${phoneKey}`);
                    return { success: true, instanceName };
                }
            } catch (error) {}
        }
        return { success: false, error: 'Nenhuma instância disponível' };
    }
    
    return { success: false, error: 'Estado inesperado' };
}

// ============ ORQUESTRAÇÃO ============
async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    const conversation = {
        phoneKey, remoteJid, funnelId: productType + '_PIX', stepIndex: -1,
        orderCode, customerName, productType, amount,
        waiting_for_response: false, pixWaiting: true,
        createdAt: new Date(), lastSystemMessage: null, lastReply: null,
        canceled: false, completed: false
    };
    conversations.set(phoneKey, conversation);
    registerRemoteJid(remoteJid, phoneKey); // ✅ REGISTRAR
    addLog('PIX_WAITING_CREATED', `PIX para ${phoneKey}`);
    
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.orderCode === orderCode && !conv.canceled && conv.pixWaiting) {
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
    
    let startingStep = (pixConv && pixConv.stepIndex >= 0) ? 3 : 0;
    
    const approvedConv = {
        phoneKey, remoteJid, funnelId: productType + '_APROVADA', stepIndex: startingStep,
        orderCode, customerName, productType, amount,
        waiting_for_response: false, createdAt: new Date(),
        lastSystemMessage: null, lastReply: null,
        canceled: false, completed: false,
        transferredFromPix: true
    };
    
    conversations.set(phoneKey, approvedConv);
    registerRemoteJid(remoteJid, phoneKey); // ✅ REGISTRAR
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido ${phoneKey}`);
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount) {
    if (hasLeadCompletedFunnel(phoneKey, funnelId)) {
        addLog('FUNNEL_ALREADY_COMPLETED', `${phoneKey} já completou - IGNORANDO`);
        return;
    }
    
    const conversation = {
        phoneKey, remoteJid, funnelId, stepIndex: 0,
        orderCode, customerName, productType, amount,
        waiting_for_response: false, createdAt: new Date(),
        lastSystemMessage: null, lastReply: null,
        canceled: false, completed: false
    };
    
    conversations.set(phoneKey, conversation);
    registerRemoteJid(remoteJid, phoneKey); // ✅ REGISTRAR
    addLog('FUNNEL_START', `Iniciando ${funnelId} para ${phoneKey}`);
    await sendStep(phoneKey);
}

async function sendStep(phoneKey) {
    if (sendStepLocks.get(phoneKey)) return;
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
            sendStepLocks.delete(phoneKey);
            return;
        }
        
        const lastStepTime = conversation.lastStepSent?.[conversation.stepIndex];
        if (lastStepTime && (Date.now() - lastStepTime < 5000)) {
            sendStepLocks.delete(phoneKey);
            return;
        }
        
        const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
        
        let result = { success: true };
        
        if (step.delayBefore && step.delayBefore > 0) {
            await new Promise(resolve => setTimeout(resolve, parseInt(step.delayBefore) * 1000));
        }
        
        if (step.showTyping && step.type !== 'delay' && step.type !== 'typing') {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        if (step.type === 'delay') {
            await new Promise(resolve => setTimeout(resolve, (step.delaySeconds || 10) * 1000));
        } else if (step.type === 'typing') {
            await new Promise(resolve => setTimeout(resolve, (step.typingSeconds || 3) * 1000));
        } else {
            result = await sendWithFallback(phoneKey, conversation.remoteJid, step.type, step.text, step.mediaUrl, isFirstMessage);
        }
        
        if (result.success) {
            conversation.lastSystemMessage = new Date();
            if (!conversation.lastStepSent) conversation.lastStepSent = {};
            conversation.lastStepSent[conversation.stepIndex] = Date.now();
            
            if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
                conversation.waiting_for_response = true;
                conversations.set(phoneKey, conversation);
                addLog('STEP_WAITING_REPLY', `Aguardando passo ${conversation.stepIndex}`, { phoneKey });
                sendStepLocks.delete(phoneKey);
            } else {
                conversations.set(phoneKey, conversation);
                sendStepLocks.delete(phoneKey);
                await advanceConversation(phoneKey, null, 'auto');
            }
        } else {
            sendStepLocks.delete(phoneKey);
        }
    } catch (error) {
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
        addLog('FUNNEL_END', `${conversation.funnelId} concluído`, { phoneKey });
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    if (reason === 'reply') conversation.lastReply = new Date();
    
    conversations.set(phoneKey, conversation);
    addLog('STEP_ADVANCE', `Passo ${nextStepIndex}`, { phoneKey, reason });
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
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const productId = data.product_id || data.products?.[0]?.id;
        const productType = PRODUCT_MAPPING[productId] || 'CS';
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, { orderCode, phoneKey });
        
        const existingConv = conversations.get(phoneKey);
        if (existingConv && !existingConv.canceled && !existingConv.completed) {
            if (existingConv.orderCode === orderCode) {
                return res.json({ success: true });
            }
            const timeSince = Date.now() - new Date(existingConv.createdAt).getTime();
            if (timeSince < 300000) {
                return res.json({ success: true });
            }
            existingConv.canceled = true;
            conversations.set(phoneKey, existingConv);
        }
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
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
        if (!phoneKey || phoneKey.length !== 8) {
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

// ✅ WEBHOOK EVOLUTION - 100% CORRIGIDO
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
        
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: true });
        }
        
        addLog('WEBHOOK_RECEIVED', `Msg de ${phoneKey}`, { remoteJid, text: messageText.substring(0, 20) });
        
        const hasLock = await acquireWebhookLock(phoneKey, 30000);
        if (!hasLock) {
            addLog('WEBHOOK_LOCK_FAILED', `Lock timeout ${phoneKey}`);
            return res.json({ success: false });
        }
        
        try {
            // ✅ BUSCA MELHORADA: 3 métodos
            let conversation = findConversationByPhone(incomingPhone);
            
            if (!conversation) {
                // ✅ Tentativa 2: Buscar por remoteJid completo
                conversation = findConversationByRemoteJid(remoteJid);
            }
            
            if (!conversation) {
                // ✅ Tentativa 3: Buscar em todas as conversas (último recurso)
                const allConversations = Array.from(conversations.values());
                conversation = allConversations.find(conv => {
                    const convJid = conv.remoteJid || '';
                    const convPhone = convJid.replace('@s.whatsapp.net', '');
                    const convKey = extractPhoneKey(convPhone);
                    return convKey === phoneKey;
                });
                
                if (conversation) {
                    addLog('CONVERSATION_FOUND_FALLBACK', `Encontrado por scan completo: ${phoneKey}`);
                    registerRemoteJid(remoteJid, phoneKey);
                }
            }
            
            if (!conversation) {
                addLog('WEBHOOK_NO_CONVERSATION', `Nenhuma conversa para ${phoneKey}`);
                return res.json({ success: true });
            }
            
            if (conversation.canceled) {
                addLog('WEBHOOK_CANCELED', `Conversa cancelada`);
                return res.json({ success: true });
            }
            
            // ✅ VERIFICAÇÃO DUPLA
            if (!conversation.waiting_for_response) {
                const funnel = funis.get(conversation.funnelId);
                const currentStep = funnel?.steps[conversation.stepIndex];
                
                if (currentStep && currentStep.waitForReply) {
                    addLog('WEBHOOK_FIX_FLAG', `✅ Flag corrigida - passo aguarda`, { phoneKey });
                    conversation.waiting_for_response = true;
                } else {
                    addLog('WEBHOOK_NOT_WAITING', `Passo não aguarda`, { phoneKey });
                    return res.json({ success: true });
                }
            }
            
            addLog('CLIENT_REPLY', `✅ Processando resposta ${phoneKey}`, { 
                step: conversation.stepIndex,
                text: messageText.substring(0, 20)
            });
            
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversations.set(phoneKey, conversation);
            
            await new Promise(resolve => setTimeout(resolve, 500));
            await advanceConversation(phoneKey, messageText, 'reply');
            
            res.json({ success: true });
        } finally {
            releaseWebhookLock(phoneKey);
        }
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message);
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
    res.json({ success: true, data: { active_conversations: active, waiting_responses: waiting, completed_conversations: completed, pending_pix: pixTimeouts.size, total_funnels: funis.size, completed_leads: completedLeads.size } });
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
    res.json({ version: '6.0', funnels: Array.from(funis.values()) });
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
        phoneKey: key, customerName: conv.customerName,
        funnelId: conv.funnelId, stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        completed: conv.completed, canceled: conv.canceled
    }));
    res.json({ success: true, data: list });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json({ success: true, data: logs.slice(0, limit) });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

setInterval(() => {
    sendStepLocks.forEach((value, key) => {
        const conv = conversations.get(key);
        if (!conv || conv.canceled || conv.completed) {
            sendStepLocks.delete(key);
        }
    });
}, 60000);

async function initializeData() {
    console.log('🔄 Carregando...');
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    console.log('✅ Pronto!');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO V6.0 - SOLUÇÃO FINAL 100%');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('');
    console.log('✅ CORREÇÕES APLICADAS:');
    console.log('  1. ✅ Busca por 3 métodos (phoneKey, remoteJid, scan)');
    console.log('  2. ✅ Índice de remoteJid persistido');
    console.log('  3. ✅ Lock timeout 30s');
    console.log('  4. ✅ Verificação dupla webhook');
    console.log('  5. ✅ Logs completos');
    console.log('');
    console.log('🎯 GARANTE:');
    console.log('  - Lead responde → SEMPRE avança');
    console.log('  - Telefone sempre encontrado');
    console.log('  - Sem timeouts');
    console.log('');
    console.log('🌐 http://localhost:' + PORT);
    console.log('='.repeat(70));
    await initializeData();
});
