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

// ✨ Função auxiliar para descrição de status PerfectPay
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
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

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
        await ensureDataDir();
        
        // Verifica se o arquivo existe
        try {
            await fs.access(DATA_FILE);
        } catch {
            // Arquivo não existe, copiar do padrão
            addLog('DATA_LOAD', 'Arquivo de funis não existe, copiando padrão...');
            try {
                const defaultFunnels = await fs.readFile('./funnels-default.json', 'utf8');
                await fs.writeFile(DATA_FILE, defaultFunnels);
                addLog('DATA_LOAD', 'Funis padrão copiados com sucesso');
            } catch (error) {
                addLog('DATA_LOAD_ERROR', 'Erro ao copiar funis padrão: ' + error.message);
                return false;
            }
        }
        
        // Agora carregar do arquivo
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
        addLog('DATA_LOAD_ERROR', 'Erro ao carregar funis: ' + error.message);
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

setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============
function extractPhoneKey(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.slice(-8);
}

// ✅ V4.5 - FUNÇÃO MELHORADA: Registra telefone em TODOS os formatos possíveis
function registerPhone(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    
    const cleaned = fullPhone.replace(/\D/g, '');
    
    // Registrar todas as variações possíveis
    const variations = new Set([
        cleaned,                                    // 5561986160340
        cleaned.replace(/^55/, ''),                 // 61986160340
        '55' + cleaned.replace(/^55/, ''),          // 5561986160340
        phoneKey,                                   // 86160340
        cleaned.slice(-11),                         // 61986160340
        cleaned.slice(-10),                         // 6186160340
        cleaned.slice(-9),                          // 986160340
        cleaned.slice(-8)                           // 86160340
    ]);
    
    // Registrar todas as variações
    variations.forEach(variation => {
        if (variation && variation.length >= 8) {
            phoneIndex.set(variation, phoneKey);
        }
    });
    
    addLog('PHONE_REGISTERED', `Telefone registrado em ${variations.size} formatos`, {
        phoneKey,
        fullPhone: cleaned,
        variations: Array.from(variations)
    });
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

// ✅ V4.5 - NOVA FUNÇÃO: Busca ULTRA robusta de conversa
function findConversationRobust(incomingPhone, remoteJid) {
    const cleaned = incomingPhone.replace(/\D/g, '');
    const phoneKey = extractPhoneKey(incomingPhone);
    
    addLog('FIND_CONVERSATION_START', 'Iniciando busca robusta', {
        incomingPhone,
        cleaned,
        phoneKey,
        remoteJid
    });
    
    // NÍVEL 1: Busca direta por phoneKey
    let conversation = conversations.get(phoneKey);
    if (conversation) {
        addLog('FIND_CONVERSATION_SUCCESS', 'Encontrado: Busca direta phoneKey', { phoneKey });
        return { conversation, phoneKey, method: 'direct_phonekey' };
    }
    
    // NÍVEL 2: Busca por phoneIndex (múltiplas variações)
    const variations = [
        cleaned,
        cleaned.replace(/^55/, ''),
        '55' + cleaned.replace(/^55/, ''),
        cleaned.slice(-11),
        cleaned.slice(-10),
        cleaned.slice(-9),
        cleaned.slice(-8)
    ];
    
    for (const variation of variations) {
        const foundKey = phoneIndex.get(variation);
        if (foundKey) {
            conversation = conversations.get(foundKey);
            if (conversation) {
                addLog('FIND_CONVERSATION_SUCCESS', 'Encontrado: phoneIndex variation', { 
                    variation, 
                    foundKey 
                });
                return { conversation, phoneKey: foundKey, method: 'phoneindex' };
            }
        }
    }
    
    // NÍVEL 3: Busca por remoteJid
    for (const [key, conv] of conversations.entries()) {
        if (conv.remoteJid === remoteJid) {
            addLog('FIND_CONVERSATION_SUCCESS', 'Encontrado: remoteJid match', { key, remoteJid });
            return { conversation: conv, phoneKey: key, method: 'remotejid' };
        }
    }
    
    // NÍVEL 4: Busca por match parcial de telefone (último recurso)
    for (const [key, conv] of conversations.entries()) {
        const convPhone = conv.phone.replace(/\D/g, '');
        
        // Testa se os últimos 8 dígitos batem
        if (convPhone.slice(-8) === cleaned.slice(-8)) {
            addLog('FIND_CONVERSATION_SUCCESS', 'Encontrado: partial match (últimos 8)', { 
                key, 
                convPhone: convPhone.slice(-8),
                incomingPhone: cleaned.slice(-8)
            });
            return { conversation: conv, phoneKey: key, method: 'partial_match' };
        }
        
        // Testa se um contém o outro
        if (cleaned.includes(convPhone) || convPhone.includes(cleaned)) {
            addLog('FIND_CONVERSATION_SUCCESS', 'Encontrado: includes match', { key });
            return { conversation: conv, phoneKey: key, method: 'includes' };
        }
    }
    
    addLog('FIND_CONVERSATION_FAILED', 'Nenhuma conversa encontrada após 4 níveis', {
        incomingPhone,
        cleaned,
        phoneKey,
        totalConversations: conversations.size,
        allPhoneKeys: Array.from(conversations.keys())
    });
    
    return null;
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

// ============ ENVIO COM RETRY ============
async function sendWithFallback(phoneKey, remoteJid, type, text, mediaUrl, isFirstMessage = false) {
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
                
                if (type === 'text') result = await sendText(remoteJid, text, instanceName);
                else if (type === 'image') result = await sendImage(remoteJid, mediaUrl, '', instanceName);
                else if (type === 'image+text') result = await sendImage(remoteJid, mediaUrl, text, instanceName);
                else if (type === 'video') result = await sendVideo(remoteJid, mediaUrl, '', instanceName);
                else if (type === 'video+text') result = await sendVideo(remoteJid, mediaUrl, text, instanceName);
                else if (type === 'audio') result = await sendAudio(remoteJid, mediaUrl, instanceName);
                
                if (result && result.ok) {
                    stickyInstances.set(phoneKey, instanceName);
                    if (isFirstMessage) {
                        lastSuccessfulInstanceIndex = INSTANCES.indexOf(instanceName);
                    }
                    addLog('SEND_SUCCESS', `Mensagem enviada via ${instanceName}`, { phoneKey, type });
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
    
    addLog('SEND_ALL_FAILED', `Falha total no envio para ${phoneKey}`, { lastError });
    
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        conversation.hasError = true;
        conversation.errorMessage = lastError;
        conversations.set(phoneKey, conversation);
    }
    
    return { success: false, error: lastError };
}

// ============ ORQUESTRAÇÃO ============

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    addLog('CREATE_PIX_START', '🔴 INICIANDO criação PIX', { 
        phoneKey, 
        orderCode,
        conversationsBefore: conversations.size 
    });
    
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
    
    addLog('CREATE_PIX_BEFORE_SET', '🟡 ANTES de conversations.set', { 
        phoneKey,
        conversationsSize: conversations.size,
        conversationData: JSON.stringify(conversation)
    });
    
    conversations.set(phoneKey, conversation);
    
    addLog('CREATE_PIX_AFTER_SET', '🟢 DEPOIS de conversations.set', { 
        phoneKey,
        conversationsSize: conversations.size,
        conversationExists: conversations.has(phoneKey),
        conversationData: conversations.get(phoneKey) ? 'EXISTS' : 'NOT FOUND'
    });
    
    await saveConversationsToFile(); // 💾 SALVAR IMEDIATAMENTE
    
    addLog('CREATE_PIX_AFTER_SAVE', '💾 DEPOIS de salvar', { 
        phoneKey,
        conversationsSize: conversations.size
    });
    
    addLog('PIX_WAITING_CREATED', `PIX em espera para ${phoneKey}`, { orderCode, productType });
    
    const timeout = setTimeout(async () => {
        addLog('PIX_TIMEOUT_START', '⏰ Timeout PIX DISPARANDO', { phoneKey, orderCode });
        
        const conv = conversations.get(phoneKey);
        
        addLog('PIX_TIMEOUT_CHECK', '🔍 Verificando conversa no timeout', {
            phoneKey,
            conversationExists: !!conv,
            conversationsSize: conversations.size,
            conversationData: conv ? JSON.stringify(conv) : 'NOT FOUND'
        });
        
        if (conv && conv.orderCode === orderCode && !conv.canceled && conv.pixWaiting) {
            addLog('PIX_TIMEOUT_TRIGGERED', `Timeout PIX disparado para ${phoneKey}`, { orderCode });
            
            conv.pixWaiting = false;
            conv.stepIndex = 0;
            conversations.set(phoneKey, conv);
            await saveConversationsToFile(); // 💾 SALVAR IMEDIATAMENTE
            
            addLog('PIX_TIMEOUT_BEFORE_SENDSTEP', '📤 Antes de sendStep', {
                phoneKey,
                stepIndex: conv.stepIndex,
                funnelId: conv.funnelId
            });
            
            await sendStep(phoneKey);
            
            addLog('PIX_TIMEOUT_AFTER_SENDSTEP', '✅ Depois de sendStep', { phoneKey });
        } else {
            addLog('PIX_TIMEOUT_SKIP', '⏭️ Timeout ignorado', {
                phoneKey,
                hasConv: !!conv,
                orderMatch: conv?.orderCode === orderCode,
                notCanceled: !conv?.canceled,
                pixWaiting: conv?.pixWaiting
            });
        }
        pixTimeouts.delete(phoneKey);
    }, PIX_TIMEOUT);
    
    pixTimeouts.set(phoneKey, { timeout, orderCode, createdAt: new Date() });
    
    addLog('CREATE_PIX_COMPLETE', '✅ CRIAÇÃO PIX COMPLETA', {
        phoneKey,
        conversationsSize: conversations.size,
        pixTimeoutsSize: pixTimeouts.size
    });
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
        addLog('PIX_TIMEOUT_CANCELED', `Timeout cancelado para ${phoneKey}`, { orderCode });
    }
    
    let startingStep = 0;
    
    if (pixConv && pixConv.stepIndex >= 0) {
        startingStep = 3;
        addLog('TRANSFER_SKIP_SIMILAR', `Cliente já interagiu, começando passo 3`, { phoneKey });
    } else {
        addLog('TRANSFER_FROM_BEGINNING', `Cliente não interagiu, começando passo 0`, { phoneKey });
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
        transferredFromPix: true,
        previousFunnel: productType + '_PIX'
    };
    
    conversations.set(phoneKey, approvedConv);
    await saveConversationsToFile(); // 💾 SALVAR IMEDIATAMENTE
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
    await saveConversationsToFile(); // 💾 SALVAR IMEDIATAMENTE
    addLog('FUNNEL_START', `Iniciando ${funnelId} para ${phoneKey}`, { orderCode });
    await sendStep(phoneKey);
}

// ✅ ============ SENDSTEP CORRIGIDO V4.4 ============
async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) {
        addLog('SENDSTEP_NO_CONV', `Conversa não encontrada`, { phoneKey });
        return;
    }
    
    if (conversation.canceled) {
        addLog('STEP_CANCELED', `Conversa cancelada`, { phoneKey });
        return;
    }
    
    if (conversation.pixWaiting) {
        addLog('STEP_PIX_WAITING', `Aguardando timeout PIX`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('SENDSTEP_NO_FUNNEL', `Funil não encontrado`, { 
            phoneKey, 
            funnelId: conversation.funnelId 
        });
        return;
    }
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) {
        addLog('SENDSTEP_NO_STEP', `Passo não encontrado`, { 
            phoneKey, 
            stepIndex: conversation.stepIndex,
            totalSteps: funnel.steps.length 
        });
        return;
    }
    
    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    
    addLog('STEP_SEND_START', `📤 Enviando passo ${conversation.stepIndex}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepType: step.type,
        waitForReply: step.waitForReply,
        isFirstMessage
    });
    
    let result = { success: true };
    
    // Delay antes (se configurado)
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `⏰ Aguardando ${delaySeconds}s antes de enviar`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    // Mostrar "digitando..." (se configurado)
    if (step.showTyping && step.type !== 'delay' && step.type !== 'typing') {
        addLog('STEP_SHOW_TYPING', `💬 Mostrando "digitando..." por 3s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Processar o passo
    if (step.type === 'delay') {
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', `⏰ Delay de ${delaySeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    } else if (step.type === 'typing') {
        const typingSeconds = step.typingSeconds || 3;
        addLog('STEP_TYPING', `💬 Digitando ${typingSeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, typingSeconds * 1000));
    } else {
        // Enviar mensagem real
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
        
        // ✅ MUDANÇA CRÍTICA: Salvar IMEDIATAMENTE após marcar waiting_for_response
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            
            // ✅ SALVAR IMEDIATAMENTE!
            await saveConversationsToFile();
            
            addLog('STEP_WAITING_REPLY', `⏸️ Aguardando resposta passo ${conversation.stepIndex}`, { 
                phoneKey,
                waitingSince: new Date().toISOString()
            });
        } else {
            conversations.set(phoneKey, conversation);
            addLog('STEP_AUTO_ADVANCE', `➡️ Avançando automaticamente passo ${conversation.stepIndex}`, { phoneKey });
            await advanceConversation(phoneKey, null, 'auto');
        }
    } else {
        addLog('STEP_FAILED', `❌ Falha no envio`, { 
            phoneKey, 
            error: result.error,
            stepIndex: conversation.stepIndex,
            stepType: step.type
        });
        
        // ✅ Marcar erro na conversa
        conversation.hasError = true;
        conversation.errorMessage = result.error;
        conversation.errorAt = new Date();
        conversations.set(phoneKey, conversation);
        await saveConversationsToFile();
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) return;
    
    if (conversation.canceled) {
        addLog('ADVANCE_CANCELED', `Conversa cancelada`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const nextStepIndex = conversation.stepIndex + 1;
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', `Funil ${conversation.funnelId} concluído`, { phoneKey });
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(phoneKey, conversation);
        await saveConversationsToFile(); // 💾 SALVAR IMEDIATAMENTE
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(phoneKey, conversation);
    await saveConversationsToFile(); // 💾 SALVAR IMEDIATAMENTE
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
        
        const phoneKey = extractPhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const productId = data.product_id || data.products?.[0]?.id;
        const productType = PRODUCT_MAPPING[productId] || 'CS';
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, { orderCode, phoneKey, method, productType });
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            const existingConv = conversations.get(phoneKey);
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                addLog('KIRVANO_PIX_TO_APPROVED', `Cliente pagou PIX`, { phoneKey, orderCode, productType });
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
            } else {
                addLog('KIRVANO_DIRECT_APPROVED', `Pagamento aprovado direto`, { phoneKey, orderCode, productType });
                
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', orderCode, customerName, productType, totalPrice);
            }
        } else if (isPix && event.includes('GENERATED')) {
            addLog('KIRVANO_PIX_GENERATED', `PIX gerado, aguardando 7min`, { phoneKey, orderCode, productType });
            
            const existingConv = conversations.get(phoneKey);
            if (existingConv && !existingConv.canceled) {
                addLog('KIRVANO_PIX_DUPLICATE', `Conversa já existe`, { phoneKey });
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
        addLog('PERFECTPAY_WEBHOOK_RECEIVED', '🎯 Webhook PerfectPay RECEBIDO!', {
            timestamp: new Date().toISOString(),
            bodySize: JSON.stringify(req.body).length,
            hasBody: !!req.body
        });
        
        addLog('PERFECTPAY_RAW_BODY', 'Body completo do webhook', {
            rawBody: JSON.stringify(req.body, null, 2)
        });
        
        const data = req.body;
        
        addLog('PERFECTPAY_MAIN_FIELDS', 'Campos principais extraídos', {
            hasCode: !!data.code,
            code: data.code,
            hasSaleStatusEnum: !!data.sale_status_enum,
            saleStatusEnum: data.sale_status_enum,
            hasProduct: !!data.product,
            productCode: data.product?.code,
            hasPlan: !!data.plan,
            planCode: data.plan?.code,
            hasCustomer: !!data.customer,
            customerFullName: data.customer?.full_name,
            hasPaymentTypeEnum: !!data.payment_type_enum,
            paymentTypeEnum: data.payment_type_enum
        });
        
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
        
        addLog('PERFECTPAY_PROCESSED_DATA', 'Dados após processamento', {
            statusEnum,
            saleCode,
            productCode,
            planCode,
            customerName,
            phoneAreaCode,
            phoneNumber,
            customerPhone,
            saleAmount,
            totalPrice,
            paymentType
        });
        
        addLog('PERFECTPAY_PHONE_VALIDATION_START', 'Iniciando validação do telefone', {
            customerPhone,
            phoneLength: customerPhone.length
        });
        
        const phoneKey = extractPhoneKey(customerPhone);
        
        addLog('PERFECTPAY_PHONE_EXTRACTED', 'Telefone extraído', {
            customerPhone,
            phoneKey,
            phoneKeyLength: phoneKey?.length,
            isValid: phoneKey && phoneKey.length === 8
        });
        
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('PERFECTPAY_INVALID_PHONE', '❌ TELEFONE INVÁLIDO!', {
                customerPhone,
                phoneAreaCode,
                phoneNumber,
                phoneKey,
                phoneKeyLength: phoneKey?.length,
                expectedLength: 8
            });
            return res.json({ success: false, message: 'Telefone inválido', debug: { customerPhone, phoneKey } });
        }
        
        addLog('PERFECTPAY_PHONE_VALID', '✅ Telefone válido!', { phoneKey });
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        addLog('PERFECTPAY_PHONE_REGISTERED', 'Telefone registrado', {
            phoneKey,
            remoteJid
        });
        
        addLog('PERFECTPAY_PRODUCT_IDENTIFICATION', 'Identificando produto', {
            productCode,
            planCode,
            availablePlans: Object.keys(PERFECTPAY_PLANS),
            availableProducts: Object.keys(PERFECTPAY_PRODUCTS)
        });
        
        const productType = identifyPerfectPayProduct(productCode, planCode);
        
        addLog('PERFECTPAY_PRODUCT_IDENTIFIED', '✅ Produto identificado', {
            productCode,
            planCode,
            productType,
            usedPlan: PERFECTPAY_PLANS[planCode] ? true : false,
            usedProduct: PERFECTPAY_PRODUCTS[productCode] ? true : false
        });
        
        addLog('PERFECTPAY_STATUS_ANALYSIS', 'Analisando status do webhook', {
            statusEnum,
            statusEnumType: typeof statusEnum,
            isStatus1: statusEnum === 1,
            isStatus2: statusEnum === 2,
            paymentType,
            paymentTypeType: typeof paymentType,
            isBoleto: paymentType === 2
        });
        
        addLog('PERFECTPAY_WEBHOOK_STATUS', `Status ${statusEnum} processando`, { 
            saleCode, 
            phoneKey, 
            productType,
            productCode,
            planCode,
            totalPrice,
            statusEnum,
            paymentType,
            customerName
        });
        
        if (statusEnum === 2) {
            addLog('PERFECTPAY_STATUS_2_DETECTED', '✅ STATUS 2 - APROVADO DETECTADO!', { 
                phoneKey, 
                saleCode,
                productType 
            });
            
            const existingConv = conversations.get(phoneKey);
            
            addLog('PERFECTPAY_CHECK_EXISTING_CONV', 'Verificando conversa existente', {
                phoneKey,
                hasExistingConv: !!existingConv,
                existingFunnelId: existingConv?.funnelId,
                expectedPixFunnelId: productType + '_PIX',
                isPixFunnel: existingConv?.funnelId === productType + '_PIX'
            });
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                addLog('PERFECTPAY_PIX_TO_APPROVED', '🔄 Transferindo PIX → APROVADA', { 
                    phoneKey, 
                    saleCode, 
                    productType,
                    plan: planCode 
                });
                await transferPixToApproved(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
                addLog('PERFECTPAY_PIX_TO_APPROVED_DONE', '✅ Transferência concluída', { phoneKey });
            } else {
                addLog('PERFECTPAY_DIRECT_APPROVED', '🚀 Iniciando funil APROVADA direto', { 
                    phoneKey, 
                    saleCode, 
                    productType,
                    plan: planCode 
                });
                
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                    addLog('PERFECTPAY_PIX_TIMEOUT_CLEARED', 'Timeout PIX cancelado', { phoneKey });
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', saleCode, customerName, productType, totalPrice);
                addLog('PERFECTPAY_DIRECT_APPROVED_DONE', '✅ Funil APROVADA iniciado', { phoneKey });
            }
            
            res.json({ success: true, phoneKey, productType, action: 'approved' });
            return;
        }
        
        else if (statusEnum === 1) {
            addLog('PERFECTPAY_STATUS_1_DETECTED', '⏳ STATUS 1 - PENDENTE DETECTADO!', { 
                phoneKey, 
                saleCode,
                paymentType,
                isBoleto: paymentType === 2
            });
            
            if (paymentType === 2) {
                addLog('PERFECTPAY_BOLETO_IGNORED', '📄 Boleto detectado - IGNORANDO', { 
                    phoneKey, 
                    saleCode,
                    reason: 'Sistema só processa PIX'
                });
                return res.json({ success: true, message: 'Boleto ignorado', action: 'boleto_ignored' });
            }
            
            addLog('PERFECTPAY_PIX_DETECTED', '💰 PIX PENDENTE DETECTADO!', { 
                phoneKey, 
                saleCode, 
                productType,
                plan: planCode 
            });
            
            const existingConv = conversations.get(phoneKey);
            
            addLog('PERFECTPAY_CHECK_DUPLICATE', 'Verificando duplicação', {
                phoneKey,
                hasExistingConv: !!existingConv,
                isCanceled: existingConv?.canceled
            });
            
            if (existingConv && !existingConv.canceled) {
                addLog('PERFECTPAY_PIX_DUPLICATE', '⚠️ Conversa já existe - IGNORANDO', { 
                    phoneKey,
                    existingFunnelId: existingConv.funnelId,
                    existingOrderCode: existingConv.orderCode
                });
                return res.json({ success: true, message: 'Conversa já existe', action: 'duplicate_ignored' });
            }
            
            addLog('PERFECTPAY_CREATING_PIX_WAITING', '🔄 Criando conversa PIX aguardando...', {
                phoneKey,
                saleCode,
                productType,
                customerName,
                totalPrice
            });
            
            await createPixWaitingConversation(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
            
            addLog('PERFECTPAY_PIX_WAITING_CREATED', '✅ PIX aguardando criado com sucesso!', {
                phoneKey,
                saleCode,
                funnelId: productType + '_PIX',
                timeout: '7 minutos'
            });
            
            res.json({ success: true, phoneKey, productType, action: 'pix_waiting_created' });
            return;
        }
        
        else {
            addLog('PERFECTPAY_STATUS_OTHER', `ℹ️ Status ${statusEnum} - Outros`, { 
                phoneKey, 
                saleCode,
                statusEnum,
                statusDescription: getStatusDescription(statusEnum)
            });
            
            res.json({ success: true, phoneKey, productType, action: 'status_' + statusEnum });
            return;
        }
        
    } catch (error) {
        addLog('PERFECTPAY_ERROR', '❌ ERRO CRÍTICO no webhook!', { 
            errorMessage: error.message,
            errorStack: error.stack,
            bodyReceived: JSON.stringify(req.body)
        });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ✅ ============ WEBHOOK EVOLUTION CORRIGIDO V4.4 ============
app.post('/webhook/evolution', async (req, res) => {
    const debugId = Date.now();
    
    try {
        addLog('WEBHOOK_RECEIVED', `[${debugId}] 📥 Webhook recebido`, {
            bodySize: JSON.stringify(req.body).length,
            timestamp: new Date().toISOString()
        });
        
        const data = req.body;
        const messageData = data.data;
        
        // ✅ Log completo do payload
        addLog('WEBHOOK_RAW_DATA', `[${debugId}] 📦 Payload completo`, {
            hasData: !!data,
            hasMessageData: !!messageData,
            hasKey: !!messageData?.key,
            fullPayload: JSON.stringify(data, null, 2)
        });
        
        if (!messageData || !messageData.key) {
            addLog('WEBHOOK_INVALID', `[${debugId}] ❌ Payload inválido - sem messageData ou key`, { data });
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        const messageType = Object.keys(messageData.message || {})[0];
        
        addLog('WEBHOOK_PARSED', `[${debugId}] 🔍 Dados extraídos`, {
            remoteJid,
            fromMe,
            messageType,
            messageText: messageText.substring(0, 100),
            hasMessage: !!messageData.message
        });
        
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        const initialPhoneKey = extractPhoneKey(incomingPhone);
        let phoneKey = initialPhoneKey;
        
        addLog('WEBHOOK_PHONE_EXTRACTED', `[${debugId}] 📞 Telefone processado`, {
            remoteJid,
            incomingPhone,
            phoneKey: initialPhoneKey,
            phoneKeyLength: initialPhoneKey?.length,
            phoneKeyValid: initialPhoneKey && initialPhoneKey.length === 8
        });
        
        if (!initialPhoneKey || initialPhoneKey.length !== 8) {
            addLog('WEBHOOK_INVALID_PHONE', `[${debugId}] ❌ Telefone inválido`, { 
                incomingPhone, 
                phoneKey: initialPhoneKey,
                phoneKeyLength: initialPhoneKey?.length 
            });
            return res.json({ success: true });
        }
        
        if (fromMe) {
            addLog('WEBHOOK_FROM_ME', `[${debugId}] 🤖 Mensagem do sistema - ignorando`, { phoneKey: initialPhoneKey });
            return res.json({ success: true });
        }
        
        // ✅ V4.5: BUSCA ROBUSTA COM 4 NÍVEIS
        const result = findConversationRobust(incomingPhone, remoteJid);
        let conversation = null;
        
        if (result) {
            conversation = result.conversation;
            phoneKey = result.phoneKey; // Atualizar phoneKey com o correto
            
            addLog('WEBHOOK_CONVERSATION_FOUND', `[${debugId}] ✅ Conversa encontrada!`, {
                method: result.method,
                phoneKey,
                funnelId: conversation.funnelId,
                stepIndex: conversation.stepIndex
            });
        }
        
        addLog('WEBHOOK_CONVERSATION_STATUS', `[${debugId}] 💬 Status da conversa`, {
            phoneKey,
            found: !!conversation,
            canceled: conversation?.canceled,
            completed: conversation?.completed,
            waiting_for_response: conversation?.waiting_for_response,
            pixWaiting: conversation?.pixWaiting,
            funnelId: conversation?.funnelId,
            stepIndex: conversation?.stepIndex,
            lastSystemMessage: conversation?.lastSystemMessage?.toISOString(),
            lastReply: conversation?.lastReply?.toISOString(),
            totalConversations: conversations.size
        });
        
        if (!conversation) {
            addLog('WEBHOOK_NO_CONVERSATION', `[${debugId}] ⚠️ Nenhuma conversa encontrada`, { 
                phoneKey,
                incomingPhone,
                remoteJid,
                allPhoneKeys: Array.from(conversations.keys()),
                allPhones: Array.from(conversations.values()).map(c => ({
                    key: c.phoneKey,
                    phone: c.phone,
                    remoteJid: c.remoteJid
                }))
            });
            return res.json({ success: true });
        }
        
        if (conversation.canceled) {
            addLog('WEBHOOK_CANCELED', `[${debugId}] ⛔ Conversa cancelada`, { 
                phoneKey,
                cancelReason: conversation.cancelReason,
                canceledAt: conversation.canceledAt 
            });
            return res.json({ success: true });
        }
        
        if (conversation.completed) {
            addLog('WEBHOOK_COMPLETED', `[${debugId}] ✅ Conversa já concluída`, { 
                phoneKey,
                completedAt: conversation.completedAt 
            });
            return res.json({ success: true });
        }
        
        if (conversation.pixWaiting) {
            addLog('WEBHOOK_PIX_WAITING', `[${debugId}] ⏳ PIX ainda aguardando timeout`, { 
                phoneKey,
                orderCode: conversation.orderCode 
            });
            // ✅ NOVO: Registrar que cliente respondeu durante PIX waiting
            conversation.repliedDuringPixWait = true;
            conversation.pixWaitReplyAt = new Date();
            conversations.set(phoneKey, conversation);
            await saveConversationsToFile(); // Salvar imediatamente
            return res.json({ success: true });
        }
        
        // ✅ Adquirir lock
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `[${debugId}] ⏱️ Timeout no lock`, { phoneKey });
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
        // ✅ V4.7: ACEITAR QUALQUER RESPOSTA - SEMPRE AVANÇAR
        if (!conversation.waiting_for_response) {
            addLog('WEBHOOK_NOT_WAITING', `[${debugId}] ℹ️ Não estava aguardando, MAS VAI PROCESSAR MESMO ASSIM`, { 
                phoneKey,
                stepIndex: conversation.stepIndex,
                funnelId: conversation.funnelId
            });
            
            // ✅ FORÇAR waiting_for_response = false para poder avançar
            conversation.waiting_for_response = false;
        }
        
        addLog('CLIENT_REPLY', `[${debugId}] 💬 Resposta do cliente (SEMPRE ACEITA)`, { 
            phoneKey, 
            text: messageText.substring(0, 100),
            messageType,
            stepIndex: conversation.stepIndex,
            funnelId: conversation.funnelId
        });
        
        // ✅ Atualizar estado
        conversation.waiting_for_response = false;
        conversation.lastReply = new Date();
        conversation.lastReplyText = messageText;
        conversations.set(phoneKey, conversation);
        
        // ✅ Salvar imediatamente
        await saveConversationsToFile();
        
        addLog('WEBHOOK_ADVANCING', `[${debugId}] ➡️ AVANÇANDO conversa SEMPRE`, { phoneKey });
        
        // ✅ Avançar conversa SEMPRE
        await advanceConversation(phoneKey, messageText, 'reply');
        
        addLog('WEBHOOK_SUCCESS', `[${debugId}] ✅ Processamento completo`, { phoneKey });
            
            res.json({ success: true, phoneKey, debugId });
            
        } finally {
            if (phoneKey) {
                releaseWebhookLock(phoneKey);
                addLog('WEBHOOK_LOCK_RELEASED', `[${debugId}] 🔓 Lock liberado`, { phoneKey });
            }
        }
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', `[${debugId}] ❌ ERRO CRÍTICO`, { 
            error: error.message,
            stack: error.stack
        });
        
        if (phoneKey) {
            releaseWebhookLock(phoneKey);
        }
        
        res.status(500).json({ 
            success: false, 
            error: error.message,
            debugId 
        });
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
            webhook_locks: webhookLocks.size
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

app.post('/api/funnels', (req, res) => {
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
        
        saveFunnelsToFile();
        
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
            version: '4.4',
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
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        pixWaiting: conv.pixWaiting || false,
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
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        pix_timeouts_active: pixTimeouts.size,
        webhook_locks_active: webhookLocks.size,
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

// ✅ ============ ENDPOINTS DE DEBUG V4.4 ============

app.get('/api/debug/conversation/:phoneKey', (req, res) => {
    const { phoneKey } = req.params;
    
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.json({
            success: false,
            message: 'Conversa não encontrada',
            phoneKey,
            totalConversations: conversations.size,
            allPhoneKeys: Array.from(conversations.keys())
        });
    }
    
    const funnel = funis.get(conversation.funnelId);
    const currentStep = funnel?.steps[conversation.stepIndex];
    
    res.json({
        success: true,
        conversation: {
            phoneKey,
            remoteJid: conversation.remoteJid,
            customerName: conversation.customerName,
            productType: conversation.productType,
            funnelId: conversation.funnelId,
            stepIndex: conversation.stepIndex,
            totalSteps: funnel?.steps.length || 0,
            currentStepType: currentStep?.type,
            currentStepWaitsReply: currentStep?.waitForReply,
            waiting_for_response: conversation.waiting_for_response,
            pixWaiting: conversation.pixWaiting,
            canceled: conversation.canceled,
            completed: conversation.completed,
            hasError: conversation.hasError,
            errorMessage: conversation.errorMessage,
            createdAt: conversation.createdAt,
            lastSystemMessage: conversation.lastSystemMessage,
            lastReply: conversation.lastReply,
            lastReplyText: conversation.lastReplyText,
            stickyInstance: stickyInstances.get(phoneKey),
            hasPixTimeout: pixTimeouts.has(phoneKey),
            hasWebhookLock: webhookLocks.has(phoneKey)
        },
        currentStep: currentStep,
        funnel: {
            id: funnel?.id,
            name: funnel?.name,
            totalSteps: funnel?.steps.length
        }
    });
});

app.post('/api/debug/simulate-reply', async (req, res) => {
    const { phoneKey, messageText } = req.body;
    
    if (!phoneKey) {
        return res.status(400).json({
            success: false,
            error: 'phoneKey obrigatório'
        });
    }
    
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.status(404).json({
            success: false,
            error: 'Conversa não encontrada',
            phoneKey
        });
    }
    
    addLog('DEBUG_SIMULATE_REPLY', `🧪 Simulando resposta`, { 
        phoneKey, 
        messageText: messageText?.substring(0, 50) 
    });
    
    try {
        if (conversation.waiting_for_response) {
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversation.lastReplyText = messageText || 'Resposta simulada';
            conversations.set(phoneKey, conversation);
            
            await saveConversationsToFile();
            await advanceConversation(phoneKey, messageText || 'Resposta simulada', 'reply');
            
            res.json({
                success: true,
                message: 'Resposta simulada e conversa avançada',
                phoneKey,
                newStepIndex: conversations.get(phoneKey)?.stepIndex
            });
        } else {
            res.json({
                success: false,
                message: 'Conversa não estava aguardando resposta',
                phoneKey,
                waiting_for_response: conversation.waiting_for_response,
                stepIndex: conversation.stepIndex
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/debug/force-advance', async (req, res) => {
    const { phoneKey } = req.body;
    
    if (!phoneKey) {
        return res.status(400).json({
            success: false,
            error: 'phoneKey obrigatório'
        });
    }
    
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        return res.status(404).json({
            success: false,
            error: 'Conversa não encontrada',
            phoneKey
        });
    }
    
    addLog('DEBUG_FORCE_ADVANCE', `🚀 Forçando avanço`, { phoneKey });
    
    try {
        conversation.waiting_for_response = false;
        conversations.set(phoneKey, conversation);
        
        await advanceConversation(phoneKey, null, 'manual-debug');
        
        res.json({
            success: true,
            message: 'Conversa avançada manualmente',
            phoneKey,
            newStepIndex: conversations.get(phoneKey)?.stepIndex
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/debug/phone-matching/:phone', (req, res) => {
    const { phone } = req.params;
    
    const phoneKey = extractPhoneKey(phone);
    const remoteJid = phoneToRemoteJid(phone);
    const conversation = findConversationByPhone(phone);
    
    const directMatch = conversations.get(phoneKey);
    
    let jidMatch = null;
    for (const [key, conv] of conversations.entries()) {
        if (conv.remoteJid === remoteJid) {
            jidMatch = { phoneKey: key, conversation: conv };
            break;
        }
    }
    
    res.json({
        success: true,
        input: {
            phone,
            phoneKey,
            phoneKeyLength: phoneKey?.length,
            remoteJid
        },
        matches: {
            findConversationByPhone: !!conversation,
            directPhoneKeyMatch: !!directMatch,
            remoteJidMatch: !!jidMatch
        },
        phoneIndex: {
            size: phoneIndex.size,
            hasPhone: phoneIndex.has(phone),
            hasPhoneKey: phoneIndex.has(phoneKey),
            value: phoneIndex.get(phone) || phoneIndex.get(phoneKey)
        },
        allConversations: Array.from(conversations.entries()).map(([key, conv]) => ({
            phoneKey: key,
            remoteJid: conv.remoteJid,
            customerName: conv.customerName
        }))
    });
});

app.post('/api/debug/test-evolution', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone) {
        return res.status(400).json({
            success: false,
            error: 'Telefone obrigatório'
        });
    }
    
    const remoteJid = phoneToRemoteJid(phone);
    const testMessage = message || 'Teste do sistema Kirvano';
    
    addLog('DEBUG_TEST_EVOLUTION', `🧪 Testando Evolution`, { phone, remoteJid });
    
    const results = [];
    
    for (const instance of INSTANCES.slice(0, 3)) {
        try {
            const result = await sendText(remoteJid, testMessage, instance);
            
            results.push({
                instance,
                success: result.ok,
                data: result.data,
                error: result.error
            });
            
            if (result.ok) break;
        } catch (error) {
            results.push({
                instance,
                success: false,
                error: error.message
            });
        }
    }
    
    res.json({
        success: results.some(r => r.success),
        phone,
        remoteJid,
        testMessage,
        results
    });
});

// ============ ROTAS FRONTEND ============

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

app.get('/diagnostico.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'diagnostico.html'));
});

// ============ INICIALIZAÇÃO ============
async function initializeData() {
    console.log('🔄 Carregando dados...');
    
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
}

// 🔍 DIAGNÓSTICO DO MAP
app.get('/api/debug/map-status', (req, res) => {
    const conversationsArray = Array.from(conversations.entries());
    const phoneIndexArray = Array.from(phoneIndex.entries());
    const pixTimeoutsArray = Array.from(pixTimeouts.entries());
    
    res.json({
        success: true,
        timestamp: new Date().toISOString(),
        maps: {
            conversations: {
                size: conversations.size,
                keys: Array.from(conversations.keys()),
                entries: conversationsArray.map(([key, value]) => ({
                    key,
                    phoneKey: value.phoneKey,
                    funnelId: value.funnelId,
                    stepIndex: value.stepIndex,
                    pixWaiting: value.pixWaiting,
                    waiting_for_response: value.waiting_for_response
                }))
            },
            phoneIndex: {
                size: phoneIndex.size,
                entries: phoneIndexArray
            },
            pixTimeouts: {
                size: pixTimeouts.size,
                entries: pixTimeoutsArray.map(([key, value]) => ({
                    key,
                    orderCode: value.orderCode,
                    createdAt: value.createdAt
                }))
            }
        },
        systemInfo: {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
        }
    });
});

// 🔍 DIAGNÓSTICO COMPLETO
app.get('/api/diagnostico', (req, res) => {
    const conversationsArray = Array.from(conversations.entries()).map(([key, conv]) => ({
        phoneKey: key,
        ...conv,
        createdAt: conv.createdAt?.toISOString(),
        lastSystemMessage: conv.lastSystemMessage?.toISOString(),
        lastReply: conv.lastReply?.toISOString()
    }));
    
    const pixTimeoutsArray = Array.from(pixTimeouts.entries()).map(([key, data]) => ({
        phoneKey: key,
        orderCode: data.orderCode,
        createdAt: data.createdAt?.toISOString(),
        hasTimeout: !!data.timeout
    }));
    
    const funisArray = Array.from(funis.entries()).map(([id, funnel]) => ({
        id,
        name: funnel.name,
        stepCount: funnel.steps?.length || 0
    }));
    
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        system: {
            version: 'V4.6.1',
            uptime: process.uptime(),
            instances: INSTANCES
        },
        funis: {
            total: funis.size,
            list: funisArray
        },
        conversas: {
            total: conversations.size,
            list: conversationsArray
        },
        pixTimeouts: {
            total: pixTimeouts.size,
            list: pixTimeoutsArray
        },
        lastLogs: logs.slice(-10)
    });
});

// 🧪 TESTE FORÇA BRUTA - Criar e iniciar imediatamente
app.post('/api/test/force-start', async (req, res) => {
    try {
        const testPhone = req.body.phone || '5511972322430';
        const funnelId = req.body.funnelId || 'CS_APROVADA';
        
        const phoneKey = extractPhoneKey(testPhone);
        const remoteJid = phoneToRemoteJid(testPhone);
        const orderCode = 'FORCE_' + Date.now();
        
        addLog('FORCE_START', '💪 FORÇANDO criação e início', { 
            phoneKey, 
            funnelId,
            orderCode 
        });
        
        // Registrar telefone em TODAS as variações
        registerPhone(testPhone, phoneKey);
        
        // Criar conversa DIRETAMENTE no Map
        const conversation = {
            phoneKey,
            phone: testPhone,
            remoteJid,
            funnelId,
            stepIndex: 0,  // Começar no passo 0
            orderCode,
            customerName: 'Teste Force',
            productType: 'CS',
            amount: 'R$ 197,00',
            waiting_for_response: false,
            pixWaiting: false,  // NÃO está esperando PIX
            createdAt: new Date(),
            lastSystemMessage: null,
            lastReply: null,
            canceled: false,
            completed: false,
            forceCreated: true
        };
        
        conversations.set(phoneKey, conversation);
        
        addLog('FORCE_CREATED', '✅ Conversa FORÇADA criada', {
            phoneKey,
            conversationsSize: conversations.size,
            hasConversation: conversations.has(phoneKey)
        });
        
        // Salvar imediatamente
        await saveConversationsToFile();
        
        // Enviar PRIMEIRO PASSO AGORA
        addLog('FORCE_SENDING', '📤 Enviando primeiro passo', { phoneKey });
        await sendStep(phoneKey);
        
        res.json({
            success: true,
            message: 'Conversa forçada criada e iniciada',
            phoneKey,
            phone: testPhone,
            funnelId,
            orderCode,
            conversationsSize: conversations.size,
            info: 'Agora envie QUALQUER mensagem do WhatsApp que o sistema vai continuar'
        });
        
    } catch (error) {
        addLog('FORCE_ERROR', '❌ Erro ao forçar', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🧪 TESTE CS PIX - Criar conversa com timeout de 7 minutos
app.post('/api/test/cs-pix', async (req, res) => {
    try {
        const testPhone = '5511972322430';
        const phoneKey = extractPhoneKey(testPhone);
        const remoteJid = phoneToRemoteJid(testPhone);
        const orderCode = 'TEST_' + Date.now();
        
        addLog('TEST_CS_PIX', '🧪 Criando teste CS PIX', { phoneKey, orderCode });
        
        // Registrar telefone
        registerPhone(testPhone, phoneKey);
        
        // Criar conversa PIX
        await createPixWaitingConversation(
            phoneKey,
            remoteJid,
            orderCode,
            'Cliente Teste',
            'CS',
            'R$ 197,00'
        );
        
        addLog('TEST_CS_PIX_CREATED', '✅ Teste criado com sucesso', { phoneKey });
        
        res.json({
            success: true,
            message: 'Conversa teste criada',
            phoneKey,
            phone: testPhone,
            orderCode,
            remoteJid,
            info: 'Aguarde 7 minutos ou envie uma mensagem do WhatsApp'
        });
        
    } catch (error) {
        addLog('TEST_ERROR', '❌ Erro no teste', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🧪 TESTE DIRETO - ENVIAR MENSAGEM AGORA
app.post('/api/teste-envio', async (req, res) => {
    try {
        const { phone, message } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ 
                error: 'Necessário: phone e message',
                example: { phone: '5511999999999', message: 'Teste' }
            });
        }
        
        const instance = INSTANCES[0];
        const remoteJid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        
        addLog('TESTE_ENVIO_START', `Testando envio para ${phone}`, { instance });
        
        const response = await axios.post(
            `${EVOLUTION_BASE_URL}/message/sendText/${instance}`,
            {
                number: remoteJid,
                text: message
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );
        
        addLog('TESTE_ENVIO_SUCCESS', 'Mensagem enviada com sucesso!');
        
        res.json({
            success: true,
            message: 'Mensagem enviada!',
            data: response.data
        });
        
    } catch (error) {
        addLog('TESTE_ENVIO_ERROR', `Erro: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
    }
});

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO + PERFECTPAY V5.0 FINAL - SEM FUNIS HARDCODED ✨✨✨');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('Instâncias:', INSTANCES.length, '-', INSTANCES.join(', '));
    console.log('');
    console.log('✅ V5.0 - VERSÃO FINAL LIMPA:');
    console.log('  🔥 REMOVIDO: Funis hardcoded (agora usa APENAS funnels-default.json)');
    console.log('  💪 Webhook aceita QUALQUER resposta');
    console.log('  🔍 Logs extremos em cada etapa');
    console.log('  💾 Salvamento imediato');
    console.log('  📱 Sistema continua conversa após cliente responder');
    console.log('');
    console.log('📡 Endpoints:');
    console.log('  POST /api/test/force-start           - CRIAR E INICIAR AGORA');
    console.log('  POST /api/test/cs-pix                - Teste PIX (7min)');
    console.log('  GET  /api/debug/map-status           - Ver estado do Map');
    console.log('  GET  /api/conversations              - Ver conversas');
    console.log('  GET  /api/logs?limit=200             - Ver logs');
    console.log('');
    console.log('🎯 IMPORTANTE:');
    console.log('  ✅ Sistema carrega funis de funnels-default.json');
    console.log('  ✅ Suas mensagens configuradas serão usadas');
    console.log('  ✅ Cliente responde QUALQUER coisa → sistema continua');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('='.repeat(70));
    
    await initializeData();
});
