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
    // 🔴🔴🔴 LOG EXTREMO 🔴🔴🔴
    console.log('🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴');
    console.log('🔴 createPixWaitingConversation CHAMADA!!!');
    console.log('🔴 Timestamp:', Date.now());
    console.log('🔴 phoneKey:', phoneKey);
    console.log('🔴 orderCode:', orderCode);
    console.log('🔴 productType:', productType);
    console.log('🔴 Map size ANTES:', conversations.size);
    console.log('🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴');
    
    addLog('CREATE_PIX_EXTREMO', '🔴🔴🔴 FUNÇÃO CHAMADA', { phoneKey, orderCode, productType });
    
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
    
    console.log('🔴 Conversa adicionada ao Map');
    console.log('🔴 Map size DEPOIS:', conversations.size);
    console.log('🔴 Has phoneKey?', conversations.has(phoneKey));
    
    addLog('PIX_WAITING_CREATED', `PIX em espera para ${phoneKey}`, { orderCode, productType });
    
    const timeout = setTimeout(async () => {
        console.log('⏰⏰⏰ TIMEOUT PIX DISPARADO para', phoneKey);
        
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
    
    console.log('🔴 Timeout configurado:', PIX_TIMEOUT, 'ms');
    console.log('🔴🔴🔴 FIM createPixWaitingConversation 🔴🔴🔴\n');
}

async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    // 🟢🟢🟢 LOG EXTREMO 🟢🟢🟢
    console.log('🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢');
    console.log('🟢 transferPixToApproved CHAMADA!!!');
    console.log('🟢 Timestamp:', Date.now());
    console.log('🟢 phoneKey:', phoneKey);
    console.log('🟢 orderCode:', orderCode);
    console.log('🟢 Map size ANTES:', conversations.size);
    console.log('🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢');
    
    addLog('TRANSFER_PIX_EXTREMO', '🟢🟢🟢 FUNÇÃO CHAMADA', { phoneKey, orderCode });
    
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
    
    console.log('🟢 Conversa transferida para APROVADA');
    console.log('🟢 Map size DEPOIS:', conversations.size);
    console.log('🟢 Has phoneKey?', conversations.has(phoneKey));
    
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido para APROVADA`, { phoneKey, startingStep, productType });
    
    await sendStep(phoneKey);
    
    console.log('🟢🟢🟢 FIM transferPixToApproved 🟢🟢🟢\n');
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount) {
    // 🔵🔵🔵 LOG EXTREMO 🔵🔵🔵
    console.log('🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵');
    console.log('🔵 startFunnel CHAMADA!!!');
    console.log('🔵 Timestamp:', Date.now());
    console.log('🔵 phoneKey:', phoneKey);
    console.log('🔵 funnelId:', funnelId);
    console.log('🔵 orderCode:', orderCode);
    console.log('🔵 Map size ANTES:', conversations.size);
    console.log('🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵🔵');
    
    addLog('START_FUNNEL_EXTREMO', '🔵🔵🔵 FUNÇÃO CHAMADA', { phoneKey, funnelId, orderCode });
    
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
    
    console.log('🔵 Conversa criada');
    console.log('🔵 Map size DEPOIS:', conversations.size);
    console.log('🔵 Has phoneKey?', conversations.has(phoneKey));
    
    addLog('FUNNEL_START', `Iniciando ${funnelId} para ${phoneKey}`, { orderCode });
    
    await sendStep(phoneKey);
    
    console.log('🔵🔵🔵 FIM startFunnel 🔵🔵🔵\n');
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) return;
    
    if (conversation.canceled) {
        addLog('STEP_CANCELED', `Conversa cancelada`, { phoneKey });
        return;
    }
    
    if (conversation.pixWaiting) {
        addLog('STEP_PIX_WAITING', `Aguardando timeout PIX`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    
    addLog('STEP_SEND_START', `Enviando passo ${conversation.stepIndex}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepType: step.type
    });
    
    let result = { success: true };
    
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `Aguardando ${delaySeconds}s antes de enviar`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    if (step.showTyping && step.type !== 'delay' && step.type !== 'typing') {
        addLog('STEP_SHOW_TYPING', `Mostrando "digitando..." por 3s`, { phoneKey });
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
        result = await sendWithFallback(phoneKey, conversation.remoteJid, step.type, step.text, step.mediaUrl, isFirstMessage);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            addLog('STEP_WAITING_REPLY', `Aguardando resposta passo ${conversation.stepIndex}`, { phoneKey });
        } else {
            conversations.set(phoneKey, conversation);
            addLog('STEP_AUTO_ADVANCE', `Avançando automaticamente passo ${conversation.stepIndex}`, { phoneKey });
            await advanceConversation(phoneKey, null, 'auto');
        }
    } else {
        addLog('STEP_FAILED', `Falha no envio`, { phoneKey, error: result.error });
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
        // 🟡🟡🟡 LOG EXTREMO 🟡🟡🟡
        console.log('\n🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡');
        console.log('🟡 WEBHOOK KIRVANO RECEBIDO!!!');
        console.log('🟡 Timestamp:', Date.now());
        console.log('🟡 Map size atual:', conversations.size);
        console.log('🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡🟡');
        
        const data = req.body;
        const event = String(data.event || '').toUpperCase();
        const status = String(data.status || data.payment_status || '').toUpperCase();
        const method = String(data.payment?.method || data.payment_method || '').toUpperCase();
        
        console.log('🟡 Event:', event);
        console.log('🟡 Status:', status);
        console.log('🟡 Method:', method);
        
        const saleId = data.sale_id || data.checkout_id;
        const orderCode = saleId || 'ORDER_' + Date.now();
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        
        const phoneKey = extractPhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) {
            console.log('🟡 TELEFONE INVÁLIDO');
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        console.log('🟡 PhoneKey:', phoneKey);
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const productId = data.product_id || data.products?.[0]?.id;
        const productType = PRODUCT_MAPPING[productId] || 'CS';
        
        console.log('🟡 ProductType:', productType);
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, { orderCode, phoneKey, method, productType });
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            console.log('🟡 ✅ APROVADO detectado');
            
            const existingConv = conversations.get(phoneKey);
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                console.log('🟡 Chamando transferPixToApproved...');
                addLog('KIRVANO_PIX_TO_APPROVED', `Cliente pagou PIX`, { phoneKey, orderCode, productType });
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
            } else {
                console.log('🟡 Chamando startFunnel APROVADA...');
                addLog('KIRVANO_DIRECT_APPROVED', `Pagamento aprovado direto`, { phoneKey, orderCode, productType });
                
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', orderCode, customerName, productType, totalPrice);
            }
        } else if (isPix && event.includes('GENERATED')) {
            console.log('🟡 💰 PIX GERADO detectado');
            
            addLog('KIRVANO_PIX_GENERATED', `PIX gerado, aguardando 7min`, { phoneKey, orderCode, productType });
            
            const existingConv = conversations.get(phoneKey);
            if (existingConv && !existingConv.canceled) {
                console.log('🟡 Conversa já existe, ignorando');
                addLog('KIRVANO_PIX_DUPLICATE', `Conversa já existe`, { phoneKey });
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            console.log('🟡 Chamando createPixWaitingConversation...');
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
        }
        
        console.log('🟡🟡🟡 FIM WEBHOOK KIRVANO 🟡🟡🟡\n');
        
        res.json({ success: true, phoneKey });
        
    } catch (error) {
        console.log('🟡 ❌ ERRO no webhook Kirvano:', error.message);
        addLog('KIRVANO_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ✨ WEBHOOK PERFECTPAY COM DEBUG ULTRA DETALHADO
app.post('/webhook/perfectpay', async (req, res) => {
    try {
        // 🟣🟣🟣 LOG EXTREMO 🟣🟣🟣
        console.log('\n🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣');
        console.log('🟣 WEBHOOK PERFECTPAY RECEBIDO!!!');
        console.log('🟣 Timestamp:', Date.now());
        console.log('🟣 Map size atual:', conversations.size);
        console.log('🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣🟣');
        
        addLog('PERFECTPAY_WEBHOOK_RECEIVED', '🟣 Webhook recebido', {
            timestamp: new Date().toISOString(),
            bodySize: JSON.stringify(req.body).length
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
        
        console.log('🟣 Status:', statusEnum);
        console.log('🟣 PaymentType:', paymentType);
        console.log('🟣 Phone:', customerPhone);
        
        const phoneKey = extractPhoneKey(customerPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            console.log('🟣 TELEFONE INVÁLIDO');
            addLog('PERFECTPAY_INVALID_PHONE', 'Telefone inválido', { customerPhone, phoneKey });
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        console.log('🟣 PhoneKey:', phoneKey);
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const productType = identifyPerfectPayProduct(productCode, planCode);
        
        console.log('🟣 ProductType:', productType);
        
        addLog('PERFECTPAY_WEBHOOK_STATUS', `Status ${statusEnum}`, { 
            saleCode, 
            phoneKey, 
            productType,
            paymentType
        });
        
        if (statusEnum === 2) {
            console.log('🟣 ✅ STATUS 2 (APROVADO) detectado');
            
            const existingConv = conversations.get(phoneKey);
            
            if (existingConv && existingConv.funnelId === productType + '_PIX') {
                console.log('🟣 Chamando transferPixToApproved...');
                addLog('PERFECTPAY_PIX_TO_APPROVED', 'Transferindo PIX → APROVADA', { phoneKey, saleCode });
                await transferPixToApproved(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
            } else {
                console.log('🟣 Chamando startFunnel APROVADA...');
                addLog('PERFECTPAY_DIRECT_APPROVED', 'Iniciando APROVADA direto', { phoneKey, saleCode });
                
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                await startFunnel(phoneKey, remoteJid, productType + '_APROVADA', saleCode, customerName, productType, totalPrice);
            }
            
            console.log('🟣🟣🟣 FIM WEBHOOK PERFECTPAY (APROVADO) 🟣🟣🟣\n');
            
            res.json({ success: true, phoneKey, productType, action: 'approved' });
            return;
        }
        
        else if (statusEnum === 1) {
            console.log('🟣 ⏳ STATUS 1 (PENDENTE) detectado');
            
            if (paymentType === 2) {
                console.log('🟣 Boleto detectado - IGNORANDO');
                addLog('PERFECTPAY_BOLETO_IGNORED', 'Boleto ignorado', { phoneKey, saleCode });
                return res.json({ success: true, message: 'Boleto ignorado' });
            }
            
            console.log('🟣 💰 PIX PENDENTE detectado');
            
            const existingConv = conversations.get(phoneKey);
            
            if (existingConv && !existingConv.canceled) {
                console.log('🟣 Conversa já existe - IGNORANDO');
                addLog('PERFECTPAY_PIX_DUPLICATE', 'Conversa já existe', { phoneKey });
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            console.log('🟣 Chamando createPixWaitingConversation...');
            await createPixWaitingConversation(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
            
            console.log('🟣🟣🟣 FIM WEBHOOK PERFECTPAY (PIX PENDENTE) 🟣🟣🟣\n');
            
            res.json({ success: true, phoneKey, productType, action: 'pix_waiting_created' });
            return;
        }
        
        else {
            console.log('🟣 Status outro:', statusEnum);
            addLog('PERFECTPAY_STATUS_OTHER', `Status ${statusEnum}`, { phoneKey, saleCode });
            res.json({ success: true, phoneKey, productType, action: 'status_' + statusEnum });
        }
        
    } catch (error) {
        console.log('🟣 ❌ ERRO no webhook PerfectPay:', error.message);
        addLog('PERFECTPAY_ERROR', 'Erro crítico', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK EVOLUTION
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
        
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        const phoneKey = extractPhoneKey(incomingPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: true });
        }
        
        if (fromMe) {
            return res.json({ success: true });
        }
        
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            const conversation = findConversationByPhone(incomingPhone);
            
            if (!conversation || conversation.canceled || !conversation.waiting_for_response) {
                addLog('WEBHOOK_NOT_WAITING', `Não aguardando resposta`, { phoneKey });
                return res.json({ success: true });
            }
            
            addLog('CLIENT_REPLY', `Resposta recebida`, { phoneKey, text: messageText.substring(0, 50) });
            
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
        releaseWebhookLock(phoneKey);
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
            version: '4.3',
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
        instances_configured: INSTANCES,
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/teste.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'teste.html'));
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

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO + PERFECTPAY - DEBUG EXTREMO 🔍🔍🔍');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('Instâncias:', INSTANCES.length, '-', INSTANCES.join(', '));
    console.log('');
    console.log('🔴🟢🔵 LOGS EXTREMOS ATIVADOS!');
    console.log('  🔴 createPixWaitingConversation');
    console.log('  🟢 transferPixToApproved');
    console.log('  🔵 startFunnel');
    console.log('  🟡 Webhook Kirvano');
    console.log('  🟣 Webhook PerfectPay');
    console.log('');
    console.log('📡 Quando venda entrar, você verá emojis coloridos nos logs!');
    console.log('   Se NÃO aparecer emojis = código não está rodando');
    console.log('   Se aparecer emojis = código está rodando e vamos descobrir o bug');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('='.repeat(70));
    
    await initializeData();
});
