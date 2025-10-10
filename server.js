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

// Mapeamento dos produtos Kirvano
const PRODUCT_MAPPING = {
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS',
    '564bb9bb-718a-4e8b-a843-a2da62f616f0': 'CS',
    '668a73bc-2fca-4f12-9331-ef945181cd5c': 'FAB',
    // Mapeamento para testes
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FAB'
};

// Instâncias Evolution
const INSTANCES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let idempotencyCache = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let logs = [];
let funis = new Map();
let instanceRoundRobin = 0;

// FUNIS PADRÃO
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: []
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: []
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA',
        name: 'FAB - Compra Aprovada',
        steps: []
    },
    'FAB_PIX': {
        id: 'FAB_PIX',
        name: 'FAB - PIX Pendente',
        steps: []
    }
};

// ============ PERSISTÊNCIA DE DADOS ============
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe ou erro ao criar:', error.message);
    }
}

async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', 'Funis salvos em arquivo: ' + funnelsArray.length + ' funis');
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
            funis.set(funnel.id, funnel);
        });
        addLog('DATA_LOAD', 'Funis carregados do arquivo: ' + funnelsArray.length + ' funis');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Erro ao carregar funis (usando padrões): ' + error.message);
        return false;
    }
}

async function saveConversationsToFile() {
    try {
        await ensureDataDir();
        const conversationsArray = Array.from(conversations.entries()).map(([key, value]) => ({
            remoteJid: key,
            ...value,
            createdAt: value.createdAt.toISOString(),
            lastSystemMessage: value.lastSystemMessage ? value.lastSystemMessage.toISOString() : null,
            lastReply: value.lastReply ? value.lastReply.toISOString() : null
        }));
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            stickyInstances: Array.from(stickyInstances.entries())
        }, null, 2));
        
        addLog('DATA_SAVE', 'Conversas salvas: ' + conversationsArray.length + ' conversas');
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
            const conversation = {
                ...conv,
                createdAt: new Date(conv.createdAt),
                lastSystemMessage: conv.lastSystemMessage ? new Date(conv.lastSystemMessage) : null,
                lastReply: conv.lastReply ? new Date(conv.lastReply) : null
            };
            conversations.set(conv.remoteJid, conversation);
        });
        
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => {
            stickyInstances.set(key, value);
        });
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length + ' conversas');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior encontrada: ' + error.message);
        return false;
    }
}

// Auto-save periódico
setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

// Inicializar funis padrão
Object.values(defaultFunnels).forEach(funnel => {
    funis.set(funnel.id, funnel);
});

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============
function normalizePhone(phone) {
    if (!phone) return '';
    
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('55')) {
        cleaned = cleaned.substring(2);
    }
    
    if (cleaned.length === 10) {
        const ddd = cleaned.substring(0, 2);
        const numero = cleaned.substring(2);
        cleaned = ddd + '9' + numero;
    }
    
    if (cleaned.length === 11) {
        const ddd = cleaned.substring(0, 2);
        const primeiroDigito = cleaned.substring(2, 3);
        
        if (primeiroDigito !== '9') {
            const numero = cleaned.substring(2);
            cleaned = ddd + '9' + numero;
        }
    }
    
    if (cleaned.length === 11) {
        cleaned = '55' + cleaned;
    } else if (cleaned.length === 13 && cleaned.startsWith('55')) {
        // Já está correto
    } else {
        if (!cleaned.startsWith('55')) {
            cleaned = '55' + cleaned;
        }
    }
    
    addLog('PHONE_NORMALIZE', 'Número normalizado', { 
        input: phone, 
        output: cleaned,
        length: cleaned.length
    });
    
    return cleaned;
}

function phoneToRemoteJid(phone) {
    const normalized = normalizePhone(phone);
    return normalized + '@s.whatsapp.net';
}

function findConversationByPhone(phone) {
    const normalized = normalizePhone(phone);
    const remoteJid = normalized + '@s.whatsapp.net';
    
    if (conversations.has(remoteJid)) {
        addLog('CONVERSATION_FOUND_EXACT', 'Conversa encontrada com número exato', { remoteJid });
        return conversations.get(remoteJid);
    }
    
    const phoneOnly = normalized.replace('55', '');
    const variations = [
        normalized + '@s.whatsapp.net',
        '55' + phoneOnly + '@s.whatsapp.net',
        phoneOnly + '@s.whatsapp.net',
    ];
    
    if (phoneOnly.length === 11 && phoneOnly.charAt(2) === '9') {
        const ddd = phoneOnly.substring(0, 2);
        const numeroSem9 = phoneOnly.substring(3);
        variations.push(ddd + numeroSem9 + '@s.whatsapp.net');
        variations.push('55' + ddd + numeroSem9 + '@s.whatsapp.net');
    }
    
    for (const variation of variations) {
        if (conversations.has(variation)) {
            addLog('CONVERSATION_FOUND_VARIATION', 'Conversa encontrada com variação', { 
                searched: remoteJid,
                found: variation,
                variations: variations
            });
            
            const conversation = conversations.get(variation);
            conversations.delete(variation);
            conversations.set(remoteJid, conversation);
            
            if (stickyInstances.has(variation)) {
                const instance = stickyInstances.get(variation);
                stickyInstances.delete(variation);
                stickyInstances.set(remoteJid, instance);
            }
            
            return conversation;
        }
    }
    
    addLog('CONVERSATION_NOT_FOUND', 'Nenhuma conversa encontrada', { 
        searched: remoteJid,
        variations: variations,
        existingConversations: Array.from(conversations.keys())
    });
    
    return null;
}

function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.buttonsResponseMessage?.selectedDisplayText) 
        return message.buttonsResponseMessage.selectedDisplayText;
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
        return message.listResponseMessage.singleSelectReply.selectedRowId;
    if (message.templateButtonReplyMessage?.selectedId)
        return message.templateButtonReplyMessage.selectedId;
    return '';
}

function checkIdempotency(key, ttl = 5 * 60 * 1000) {
    const now = Date.now();
    for (const [k, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > ttl) {
            idempotencyCache.delete(k);
        }
    }
    if (idempotencyCache.has(key)) return true;
    idempotencyCache.set(key, now);
    return false;
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
    if (logs.length > 1000) {
        logs = logs.slice(0, 1000);
    }
    console.log('[' + log.timestamp.toISOString() + '] ' + type + ': ' + message);
}

// ============ EVOLUTION API ADAPTER ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 15000
        });
        return { ok: true, data: response.data };
    } catch (error) {
        return { 
            ok: false, 
            error: error.response?.data || error.message,
            status: error.response?.status
        };
    }
}

// Funções de envio corrigidas
async function sendText(remoteJid, text, clientMessageId, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: text
    };
    return await sendToEvolution(instanceName, '/message/sendText', payload);
}

async function sendImage(remoteJid, imageUrl, caption, clientMessageId, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'image',
        media: imageUrl,
        caption: caption || ''
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

async function sendVideo(remoteJid, videoUrl, caption, clientMessageId, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'video',
        media: videoUrl,
        caption: caption || ''
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

// CORREÇÃO: Áudio enviado como gravação normal
async function sendAudio(remoteJid, audioUrl, clientMessageId, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'audio',
        media: audioUrl,
        mimetype: 'audio/mpeg', // Força MP3
        ptt: true // Importante: marca como áudio de voz
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

// ============ ENVIO COM FALLBACK E INSTÂNCIA FIXA ============
async function sendWithFallback(remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    const clientMessageId = uuidv4();
    let instancesToTry = [...INSTANCES];
    
    // Se é primeira mensagem, distribuir round-robin
    if (isFirstMessage) {
        const primaryInstanceIndex = instanceRoundRobin % INSTANCES.length;
        const primaryInstance = INSTANCES[primaryInstanceIndex];
        instanceRoundRobin++;
        
        instancesToTry = [
            primaryInstance,
            ...INSTANCES.slice(primaryInstanceIndex + 1),
            ...INSTANCES.slice(0, primaryInstanceIndex)
        ];
        
        addLog('INSTANCE_DISTRIBUTION', `Nova conversa #${instanceRoundRobin} distribuída para ${primaryInstance}`, { 
            remoteJid,
            primaryInstance,
            fallbackOrder: instancesToTry 
        });
    } else {
        // Usar instância fixa
        const stickyInstance = stickyInstances.get(remoteJid);
        if (stickyInstance) {
            instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
        }
    }
    
    let lastError = null;
    
    for (const instanceName of instancesToTry) {
        try {
            addLog('SEND_ATTEMPT', 'Tentando ' + instanceName + ' para ' + remoteJid, { 
                type, 
                clientMessageId,
                isFirstMessage 
            });
            
            let result;
            
            if (type === 'text') {
                result = await sendText(remoteJid, text, clientMessageId, instanceName);
            } else if (type === 'image') {
                result = await sendImage(remoteJid, mediaUrl, '', clientMessageId, instanceName);
            } else if (type === 'image+text') {
                result = await sendImage(remoteJid, mediaUrl, text, clientMessageId, instanceName);
            } else if (type === 'video') {
                result = await sendVideo(remoteJid, mediaUrl, '', clientMessageId, instanceName);
            } else if (type === 'video+text') {
                result = await sendVideo(remoteJid, mediaUrl, text, clientMessageId, instanceName);
            } else if (type === 'audio') {
                result = await sendAudio(remoteJid, mediaUrl, clientMessageId, instanceName);
            }
            
            if (result && result.ok) {
                // Fixar instância
                stickyInstances.set(remoteJid, instanceName);
                
                addLog('SEND_SUCCESS', 'Mensagem enviada com sucesso via ' + instanceName, { 
                    remoteJid, 
                    type,
                    isFirstMessage,
                    distributionNumber: isFirstMessage ? instanceRoundRobin : null
                });
                
                return { success: true, instanceName };
            } else {
                lastError = result.error;
                addLog('SEND_FAILED', instanceName + ' falhou: ' + JSON.stringify(lastError), { remoteJid, type });
            }
        } catch (error) {
            lastError = error.message;
            addLog('SEND_ERROR', instanceName + ' erro: ' + error.message, { remoteJid, type });
        }
    }
    
    addLog('SEND_ALL_FAILED', 'Todas as instâncias falharam para ' + remoteJid, { lastError });
    return { success: false, error: lastError };
}

// ============ ORQUESTRAÇÃO DE FUNIS CORRIGIDA ============

// NOVA FUNÇÃO: Trocar funil mantendo instância
async function changeFunnel(remoteJid, newFunnelId, orderCode, customerName, productType, amount) {
    const existingConversation = findConversationByPhone(remoteJid.replace('@s.whatsapp.net', ''));
    
    if (existingConversation) {
        // MANTER a instância fixa!
        const existingInstance = stickyInstances.get(existingConversation.remoteJid);
        
        addLog('FUNNEL_CHANGE', `Trocando funil: ${existingConversation.funnelId} → ${newFunnelId}`, {
            remoteJid,
            oldFunnel: existingConversation.funnelId,
            newFunnel: newFunnelId,
            keepInstance: existingInstance
        });
        
        // Cancelar timers antigos se existirem
        const pixTimeout = pixTimeouts.get(existingConversation.remoteJid);
        if (pixTimeout) {
            clearTimeout(pixTimeout.timeout);
            pixTimeouts.delete(existingConversation.remoteJid);
        }
        
        // Atualizar conversa existente
        existingConversation.funnelId = newFunnelId;
        existingConversation.stepIndex = 0;
        existingConversation.orderCode = orderCode;
        existingConversation.amount = amount;
        existingConversation.waiting_for_response = false;
        existingConversation.lastSystemMessage = null;
        
        // IMPORTANTE: Manter a mesma instância
        if (existingInstance) {
            stickyInstances.set(remoteJid, existingInstance);
        }
        
        conversations.set(remoteJid, existingConversation);
        
        // Iniciar novo funil com a instância mantida
        await sendStep(remoteJid);
    } else {
        // Se não existe conversa, criar nova
        await startFunnel(remoteJid, newFunnelId, orderCode, customerName, productType, amount);
    }
}

async function startFunnel(remoteJid, funnelId, orderCode, customerName, productType, amount) {
    const conversation = {
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
        lastReply: null
    };
    
    conversations.set(remoteJid, conversation);
    addLog('FUNNEL_START', 'Iniciando funil ' + funnelId + ' para ' + remoteJid, { orderCode, productType });
    await sendStep(remoteJid);
}

async function sendStep(remoteJid) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const isFirstMessage = conversation.stepIndex === 0 && !stickyInstances.has(remoteJid);
    
    const idempotencyKey = 'SEND:' + remoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
    if (checkIdempotency(idempotencyKey)) {
        addLog('STEP_DUPLICATE', 'Passo duplicado ignorado: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
        return;
    }
    
    addLog('STEP_SEND', 'Enviando passo ' + conversation.stepIndex + ' do funil ' + conversation.funnelId, { 
        step,
        isFirstMessage 
    });
    
    // DELAY ANTES
    if (step.delayBefore && step.delayBefore > 0) {
        addLog('STEP_DELAY', 'Aguardando ' + step.delayBefore + 's antes do passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, step.delayBefore * 1000));
    }
    
    // MOSTRAR DIGITANDO
    if (step.showTyping) {
        await sendTypingIndicator(remoteJid);
    }
    
    let result = { success: true };
    
    // PROCESSAR TIPO DO PASSO
    if (step.type === 'delay') {
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', 'Executando delay de ' + delaySeconds + 's no passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        
    } else if (step.type === 'typing') {
        const typingSeconds = step.typingSeconds || 3;
        addLog('STEP_TYPING', 'Mostrando digitando por ' + typingSeconds + 's no passo ' + conversation.stepIndex);
        await sendTypingIndicator(remoteJid, typingSeconds);
        
    } else {
        result = await sendWithFallback(remoteJid, step.type, step.text, step.mediaUrl, isFirstMessage);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            conversation.waiting_for_response = true;
            addLog('STEP_WAITING_REPLY', 'Passo ' + conversation.stepIndex + ' aguardando resposta do cliente', { 
                funnelId: conversation.funnelId, 
                waitForReply: step.waitForReply,
                stepType: step.type
            });
            
            if (step.timeoutMinutes) {
                setTimeout(() => {
                    handleStepTimeout(remoteJid, conversation.stepIndex);
                }, step.timeoutMinutes * 60 * 1000);
            }
            
            conversations.set(remoteJid, conversation);
        } else {
            addLog('STEP_AUTO_ADVANCE', 'Passo ' + conversation.stepIndex + ' avançando automaticamente', { 
                funnelId: conversation.funnelId, 
                waitForReply: step.waitForReply,
                stepType: step.type
            });
            
            conversations.set(remoteJid, conversation);
            await advanceConversation(remoteJid, null, 'auto');
        }
        
        addLog('STEP_SUCCESS', 'Passo executado com sucesso: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
    } else {
        addLog('STEP_FAILED', 'Falha no envio do passo: ' + result.error, { conversation });
    }
}

async function sendTypingIndicator(remoteJid, durationSeconds = 3) {
    const instanceName = stickyInstances.get(remoteJid) || INSTANCES[0];
    
    try {
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'composing'
        });
        
        addLog('TYPING_START', 'Iniciando digitação para ' + remoteJid + ' por ' + durationSeconds + 's');
        
        await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
        
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'paused'
        });
        
        addLog('TYPING_END', 'Finalizando digitação para ' + remoteJid);
        
    } catch (error) {
        addLog('TYPING_ERROR', 'Erro ao enviar digitação: ' + error.message, { remoteJid });
    }
}

async function advanceConversation(remoteJid, replyText, reason) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) {
        addLog('ADVANCE_ERROR', 'Tentativa de avançar conversa inexistente: ' + remoteJid);
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('ADVANCE_ERROR', 'Funil não encontrado: ' + conversation.funnelId, { remoteJid });
        return;
    }
    
    const currentStep = funnel.steps[conversation.stepIndex];
    if (!currentStep) {
        addLog('ADVANCE_ERROR', 'Passo atual não encontrado: ' + conversation.stepIndex, { 
            remoteJid, 
            funnelId: conversation.funnelId 
        });
        return;
    }
    
    addLog('ADVANCE_START', 'Iniciando avanço da conversa', {
        remoteJid: remoteJid,
        currentStep: conversation.stepIndex,
        funnelId: conversation.funnelId,
        reason: reason,
        currentStepType: currentStep.type,
        waitingForResponse: conversation.waiting_for_response,
        nextOnReply: currentStep.nextOnReply,
        nextOnTimeout: currentStep.nextOnTimeout
    });
    
    let nextStepIndex;
    if (reason === 'reply' && currentStep.nextOnReply !== undefined) {
        nextStepIndex = currentStep.nextOnReply;
        addLog('ADVANCE_LOGIC', 'Usando nextOnReply: ' + nextStepIndex, { reason, currentStep: conversation.stepIndex });
    } else if (reason === 'timeout' && currentStep.nextOnTimeout !== undefined) {
        nextStepIndex = currentStep.nextOnTimeout;
        addLog('ADVANCE_LOGIC', 'Usando nextOnTimeout: ' + nextStepIndex, { reason, currentStep: conversation.stepIndex });
    } else {
        nextStepIndex = conversation.stepIndex + 1;
        addLog('ADVANCE_LOGIC', 'Usando próximo sequencial: ' + nextStepIndex, { reason, currentStep: conversation.stepIndex });
    }
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', 'Funil ' + conversation.funnelId + ' concluído para ' + remoteJid, {
            totalSteps: funnel.steps.length,
            finalStep: conversation.stepIndex
        });
        
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(remoteJid, conversation);
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(remoteJid, conversation);
    
    addLog('STEP_ADVANCE', 'Avançando para passo ' + nextStepIndex + ' (motivo: ' + reason + ')', { 
        remoteJid,
        funnelId: conversation.funnelId,
        previousStep: conversation.stepIndex - 1,
        nextStep: nextStepIndex,
        reason: reason
    });
    
    await sendStep(remoteJid);
}

async function handleStepTimeout(remoteJid, expectedStepIndex) {
    const conversation = conversations.get(remoteJid);
    if (!conversation || conversation.stepIndex !== expectedStepIndex || !conversation.waiting_for_response) {
        return;
    }
    addLog('STEP_TIMEOUT', 'Timeout do passo ' + expectedStepIndex + ' para ' + remoteJid);
    await advanceConversation(remoteJid, null, 'timeout');
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
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        if (!remoteJid || remoteJid === '@s.whatsapp.net') {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const idempotencyKey = 'KIRVANO:' + event + ':' + remoteJid + ':' + orderCode;
        if (checkIdempotency(idempotencyKey)) {
            return res.json({ success: true, message: 'Evento duplicado ignorado' });
        }
        
        let productType = 'UNKNOWN';
        if (data.products && data.products.length > 0) {
            const offerId = data.products[0].offer_id;
            productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
        }
        
        addLog('KIRVANO_EVENT', event + ' - ' + productType + ' - ' + customerName, { orderCode, remoteJid });
        
        let funnelId;
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            // CORREÇÃO: Usar changeFunnel ao invés de startFunnel
            const pixTimeout = pixTimeouts.get(remoteJid);
            if (pixTimeout) {
                clearTimeout(pixTimeout.timeout);
                pixTimeouts.delete(remoteJid);
                addLog('PIX_TIMEOUT_CANCELED', 'Timeout cancelado para ' + remoteJid, { orderCode });
            }
            
            funnelId = productType === 'FAB' ? 'FAB_APROVADA' : 'CS_APROVADA';
            await changeFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
        } else if (isPix) {
            funnelId = productType === 'FAB' ? 'FAB_PIX' : 'CS_PIX';
            
            const existingTimeout = pixTimeouts.get(remoteJid);
            if (existingTimeout) {
                clearTimeout(existingTimeout.timeout);
            }
            
            // Se já tem conversa, usar changeFunnel
            const existingConversation = findConversationByPhone(customerPhone);
            if (existingConversation) {
                await changeFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            } else {
                await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            }
            
            const timeout = setTimeout(async () => {
                const conversation = conversations.get(remoteJid);
                if (conversation && conversation.orderCode === orderCode) {
                    const funnel = funis.get(conversation.funnelId);
                    if (funnel && funnel.steps[2]) {
                        conversation.stepIndex = 2;
                        conversation.waiting_for_response = false;
                        conversations.set(remoteJid, conversation);
                        await sendStep(remoteJid);
                    }
                }
                pixTimeouts.delete(remoteJid);
            }, PIX_TIMEOUT);
            
            pixTimeouts.set(remoteJid, { timeout, orderCode, createdAt: new Date() });
        }
        
        res.json({ success: true, message: 'Processado', funnelId });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/evolution', async (req, res) => {
    console.log('===== WEBHOOK EVOLUTION RECEBIDO =====');
    console.log(JSON.stringify(req.body, null, 2));
    addLog('WEBHOOK_RECEIVED', 'Webhook Evolution recebido', req.body);
    
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            addLog('WEBHOOK_IGNORED', 'Webhook sem dados de mensagem');
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        addLog('WEBHOOK_DETAILS', 'Processando mensagem', { 
            remoteJid, 
            fromMe, 
            messageText: messageText.substring(0, 100),
            hasConversation: conversations.has(remoteJid)
        });
        
        if (fromMe) {
            addLog('WEBHOOK_FROM_ME', 'Mensagem enviada por nós ignorada', { remoteJid });
            return res.json({ success: true });
        } else {
            const incomingPhone = messageData.key.remoteJid.replace('@s.whatsapp.net', '');
            const conversation = findConversationByPhone(incomingPhone);
            
            if (conversation && conversation.waiting_for_response) {
                const normalizedRemoteJid = normalizePhone(incomingPhone) + '@s.whatsapp.net';
                
                const idempotencyKey = 'REPLY:' + normalizedRemoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
                if (checkIdempotency(idempotencyKey)) {
                    addLog('WEBHOOK_DUPLICATE_REPLY', 'Resposta duplicada ignorada', { remoteJid: normalizedRemoteJid });
                    return res.json({ success: true, message: 'Resposta duplicada' });
                }
                
                addLog('CLIENT_REPLY', 'Resposta recebida e processada', { 
                    originalRemoteJid: remoteJid,
                    normalizedRemoteJid: normalizedRemoteJid,
                    text: messageText.substring(0, 100),
                    step: conversation.stepIndex,
                    funnelId: conversation.funnelId
                });
                
                await advanceConversation(normalizedRemoteJid, messageText, 'reply');
            } else {
                addLog('WEBHOOK_NO_CONVERSATION', 'Mensagem recebida mas sem conversa ativa', { 
                    remoteJid, 
                    incomingPhone,
                    normalizedPhone: normalizePhone(incomingPhone),
                    messageText: messageText.substring(0, 50),
                    existingConversations: Array.from(conversations.keys()).slice(0, 3)
                });
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

// Dashboard
app.get('/api/dashboard', (req, res) => {
    const instanceUsage = {};
    INSTANCES.forEach(inst => {
        instanceUsage[inst] = 0;
    });
    
    stickyInstances.forEach((instance) => {
        if (instanceUsage[instance] !== undefined) {
            instanceUsage[instance]++;
        }
    });
    
    const nextInstanceIndex = instanceRoundRobin % INSTANCES.length;
    const nextInstance = INSTANCES[nextInstanceIndex];
    
    const stats = {
        active_conversations: conversations.size,
        pending_pix: pixTimeouts.size,
        total_funnels: funis.size,
        total_instances: INSTANCES.length,
        sticky_instances: stickyInstances.size,
        round_robin_counter: instanceRoundRobin,
        next_instance_in_queue: nextInstance,
        instance_distribution: instanceUsage,
        conversations_per_instance: Math.round(conversations.size / INSTANCES.length)
    };
    
    res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
    });
});

// Funis - CRUD
app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values()).map(funnel => ({
        ...funnel,
        isDefault: funnel.id.includes('_APROVADA') || funnel.id.includes('_PIX'),
        stepCount: funnel.steps.length
    }));
    
    res.json({
        success: true,
        data: funnelsList
    });
});

app.post('/api/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ 
            success: false, 
            error: 'ID, nome e passos são obrigatórios' 
        });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_SAVED', 'Funil salvo: ' + funnel.id);
    
    saveFunnelsToFile();
    
    res.json({ 
        success: true, 
        message: 'Funil salvo com sucesso',
        data: funnel
    });
});

// NOVO: Exportar funis
app.get('/api/funnels/export', (req, res) => {
    const funnelsArray = Array.from(funis.values());
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="kirvano_funnels_' + Date.now() + '.json"');
    
    res.json({
        version: '1.0',
        exportDate: new Date().toISOString(),
        funnels: funnelsArray
    });
});

// NOVO: Importar funis
app.post('/api/funnels/import', (req, res) => {
    try {
        const data = req.body;
        
        if (!data.funnels || !Array.isArray(data.funnels)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Formato inválido. Esperado: { funnels: [...] }' 
            });
        }
        
        // Limpar funis atuais
        funis.clear();
        
        // Importar novos funis
        data.funnels.forEach(funnel => {
            if (funnel.id && funnel.name && funnel.steps) {
                funis.set(funnel.id, funnel);
            }
        });
        
        // Se não importou nada, restaurar padrões
        if (funis.size === 0) {
            Object.values(defaultFunnels).forEach(funnel => {
                funis.set(funnel.id, funnel);
            });
        }
        
        saveFunnelsToFile();
        
        addLog('FUNNELS_IMPORTED', 'Funis importados: ' + funis.size);
        
        res.json({ 
            success: true, 
            message: funis.size + ' funis importados com sucesso',
            count: funis.size
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Erro ao importar: ' + error.message 
        });
    }
});

app.delete('/api/funnels/:id', (req, res) => {
    const { id } = req.params;
    
    if (id.includes('_APROVADA') || id.includes('_PIX')) {
        return res.status(400).json({ 
            success: false, 
            error: 'Não é possível excluir funis padrão' 
        });
    }
    
    if (funis.has(id)) {
        funis.delete(id);
        addLog('FUNNEL_DELETED', 'Funil excluído: ' + id);
        saveFunnelsToFile();
        res.json({ success: true, message: 'Funil excluído com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
});

// Conversas
app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([remoteJid, conv]) => ({
        id: remoteJid,
        phone: remoteJid.replace('@s.whatsapp.net', ''),
        customerName: conv.customerName,
        productType: conv.productType,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        orderCode: conv.orderCode,
        amount: conv.amount,
        stickyInstance: stickyInstances.get(remoteJid)
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
        success: true,
        data: conversationsList
    });
});

// Logs
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        message: log.message
    }));
    
    res.json({
        success: true,
        data: recentLogs
    });
});

// Teste de envio
app.post('/api/send-test', async (req, res) => {
    const { remoteJid, type, text, mediaUrl } = req.body;
    
    if (!remoteJid || !type) {
        return res.status(400).json({ 
            success: false, 
            error: 'remoteJid e type são obrigatórios' 
        });
    }
    
    addLog('TEST_SEND', 'Teste de envio: ' + type + ' para ' + remoteJid);
    
    const result = await sendWithFallback(remoteJid, type, text, mediaUrl);
    
    if (result.success) {
        res.json({ 
            success: true, 
            message: 'Mensagem enviada com sucesso!',
            instanceUsed: result.instanceName
        });
    } else {
        res.status(500).json({ success: false, error: result.error });
    }
});

// Debug Evolution API
app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY.length,
        instances: INSTANCES,
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        round_robin_counter: instanceRoundRobin,
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
            url: url,
            status: response.status,
            response: response.data,
            headers: response.headers
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

// Servir frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicialização
async function initializeData() {
    console.log('🔄 Carregando dados persistidos...');
    
    const funnelsLoaded = await loadFunnelsFromFile();
    if (!funnelsLoaded) {
        console.log('📋 Usando funis padrão');
    }
    
    const conversationsLoaded = await loadConversationsFromFile();
    if (!conversationsLoaded) {
        console.log('💬 Nenhuma conversa anterior encontrada');
    }
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis carregados:', funis.size);
    console.log('💬 Conversas ativas:', conversations.size);
}

app.listen(PORT, async () => {
    console.log('='.repeat(60));
    console.log('🚀 KIRVANO SYSTEM - VERSÃO CORRIGIDA');
    console.log('='.repeat(60));
    console.log('');
    console.log('✅ CORREÇÕES APLICADAS:');
    console.log('  1. Instâncias fixas por lead');
    console.log('  2. Troca de funil mantém instância');
    console.log('  3. Áudio como gravação normal');
    console.log('  4. Endpoints de import/export');
    console.log('');
    console.log('📡 NOVOS ENDPOINTS:');
    console.log('  GET  /api/funnels/export - Baixar backup');
    console.log('  POST /api/funnels/import - Restaurar backup');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('🧪 Testes: http://localhost:' + PORT + '/test.html');
    console.log('='.repeat(60));
    
    await initializeData();
});
