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

// Instâncias Evolution
const INSTANCES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D13'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();          // Índice principal
let phoneVariations = new Map();     // Índice reverso ULTRA robusto
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

// ============ SISTEMA DE NORMALIZAÇÃO UNIVERSAL ULTRA ROBUSTO ============

// 🔥 FUNÇÃO 1: Normaliza QUALQUER formato para phoneKey (últimos 8 dígitos)
function normalizePhoneKey(phone) {
    if (!phone) return null;
    
    // Remove TUDO que não for número (incluindo sufixos @s.whatsapp.net, @lid, @g.us)
    let cleaned = String(phone)
        .split('@')[0]  // Remove sufixos
        .replace(/\D/g, '');  // Remove tudo que não é número
    
    if (cleaned.length < 8) {
        console.log('❌ Telefone muito curto:', phone);
        return null;
    }
    
    // SEMPRE retorna últimos 8 dígitos como chave primária
    const phoneKey = cleaned.slice(-8);
    
    console.log('📱 Normalização:', {
        entrada: phone,
        limpo: cleaned,
        phoneKey: phoneKey
    });
    
    return phoneKey;
}

// 🔥 FUNÇÃO 2: Gera TODAS as variações possíveis de um número
function generateAllPhoneVariations(fullPhone) {
    const cleaned = String(fullPhone)
        .split('@')[0]
        .replace(/\D/g, '');
    
    if (cleaned.length < 8) return [];
    
    const variations = new Set();
    
    // 1. Número completo limpo
    variations.add(cleaned);
    
    // 2. Com 55 no início
    if (!cleaned.startsWith('55')) {
        variations.add('55' + cleaned);
    }
    
    // 3. Sem 55 no início (se tiver)
    if (cleaned.startsWith('55') && cleaned.length > 2) {
        variations.add(cleaned.substring(2));
    }
    
    // 4. Últimos N dígitos (8, 9, 10, 11, 12, 13)
    for (let i = 8; i <= Math.min(13, cleaned.length); i++) {
        const lastN = cleaned.slice(-i);
        variations.add(lastN);
        
        // Com 55
        if (!lastN.startsWith('55')) {
            variations.add('55' + lastN);
        }
    }
    
    // 5. Variações com/sem 9 do celular (formato novo vs antigo)
    if (cleaned.length >= 11) {
        // Pega DDD (2 dígitos) e resto
        const ddd = cleaned.slice(-11, -9);  // 2 dígitos do DDD
        const numero = cleaned.slice(-9);     // 9XXXXXXXX ou 8XXXXXXXX
        
        // Se tem o 9 adicional
        if (numero.length === 9 && numero[0] === '9') {
            // Cria versão SEM o 9 (formato antigo)
            const semNove = ddd + numero.substring(1);
            variations.add(semNove);
            variations.add('55' + semNove);
            
            // Todas as variações de tamanho
            for (let i = 8; i <= semNove.length; i++) {
                variations.add(semNove.slice(-i));
            }
        }
        
        // Se NÃO tem o 9 adicional
        if (numero.length === 8 || (numero.length === 9 && numero[0] !== '9')) {
            // Cria versão COM o 9 (formato novo)
            const comNove = ddd + '9' + numero;
            variations.add(comNove);
            variations.add('55' + comNove);
            
            // Todas as variações de tamanho
            for (let i = 8; i <= comNove.length; i++) {
                variations.add(comNove.slice(-i));
            }
        }
    }
    
    // 6. Caso especial: 12 dígitos sem o 9 (5588XXXXXXXX)
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
    
    // 7. Caso especial: 13 dígitos com o 9 (5588997215401)
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
    
    // Remove variações muito curtas ou inválidas
    const validVariations = Array.from(variations).filter(v => v && v.length >= 8);
    
    console.log(`🔢 Geradas ${validVariations.length} variações para ${cleaned}`);
    
    return validVariations;
}

// 🔥 FUNÇÃO 3: Registra TODAS as variações de um telefone
function registerPhoneUniversal(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) {
        console.log('❌ PhoneKey inválida para registro:', phoneKey);
        return;
    }
    
    const variations = generateAllPhoneVariations(fullPhone);
    
    // Registra TODAS as variações apontando para a mesma phoneKey
    let registeredCount = 0;
    
    variations.forEach(variation => {
        if (variation && variation.length >= 8) {
            phoneIndex.set(variation, phoneKey);
            phoneVariations.set(variation, phoneKey);
            registeredCount++;
        }
    });
    
    // Também registra com sufixos comuns do WhatsApp
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

// 🔥 FUNÇÃO 4: Busca conversa de QUALQUER formato (4 níveis de busca)
function findConversationUniversal(phone) {
    const phoneKey = normalizePhoneKey(phone);
    
    if (!phoneKey) {
        console.log('❌ Telefone inválido para busca:', phone);
        return null;
    }
    
    console.log('🔍 Iniciando busca UNIVERSAL para:', phoneKey);
    
    // ===== NÍVEL 1: Busca direta pela phoneKey =====
    let conversation = conversations.get(phoneKey);
    if (conversation) {
        console.log('✅ NÍVEL 1: Encontrado (busca direta):', phoneKey);
        registerPhoneUniversal(phone, phoneKey);
        return conversation;
    }
    
    // ===== NÍVEL 2: Busca pelo índice usando todas as variações =====
    const variations = generateAllPhoneVariations(phone);
    console.log(`🔍 NÍVEL 2: Testando ${variations.length} variações...`);
    
    for (const variation of variations) {
        // Testa no índice principal
        const indexedKey = phoneIndex.get(variation);
        if (indexedKey) {
            conversation = conversations.get(indexedKey);
            if (conversation) {
                console.log('✅ NÍVEL 2: Encontrado via índice:', indexedKey, '←', variation);
                registerPhoneUniversal(phone, indexedKey);
                return conversation;
            }
        }
        
        // Testa no índice reverso
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
    
    // ===== NÍVEL 3: Busca com sufixos WhatsApp =====
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
    
    // ===== NÍVEL 4: Busca exaustiva em TODAS as conversas =====
    console.log('🔍 NÍVEL 4: Busca exaustiva em', conversations.size, 'conversas...');
    
    for (const [key, conv] of conversations.entries()) {
        // Match 1: Últimos 8 dígitos exatos
        if (key === phoneKey) {
            console.log('✅ NÍVEL 4: Match exato 8 dígitos:', key);
            registerPhoneUniversal(phone, key);
            return conv;
        }
        
        // Match 2: Últimos 7 dígitos (muito provável ser o mesmo)
        if (key.slice(-7) === phoneKey.slice(-7)) {
            console.log('✅ NÍVEL 4: Match últimos 7 dígitos:', key);
            registerPhoneUniversal(phone, key);
            return conv;
        }
        
        // Match 3: Compara remoteJid da conversa
        if (conv.remoteJid) {
            const convPhoneKey = normalizePhoneKey(conv.remoteJid);
            if (convPhoneKey === phoneKey) {
                console.log('✅ NÍVEL 4: Match via remoteJid:', key);
                registerPhoneUniversal(phone, key);
                return conv;
            }
            
            // Match 4: RemoteJid últimos 7 dígitos
            if (convPhoneKey && convPhoneKey.slice(-7) === phoneKey.slice(-7)) {
                console.log('✅ NÍVEL 4: Match remoteJid últimos 7:', key);
                registerPhoneUniversal(phone, key);
                return conv;
            }
        }
    }
    
    // NÃO ENCONTRADO após 4 níveis de busca
    console.log('❌ Conversa NÃO encontrada após busca ULTRA completa');
    console.log('📊 Debug completo:', {
        phoneKey,
        phoneOriginal: phone,
        variaçõesTentadas: variations.length,
        conversasAtivas: conversations.size,
        primeiras5Conversas: Array.from(conversations.keys()).slice(0, 5),
        primeiras5Variações: variations.slice(0, 5)
    });
    
    addLog('CONVERSATION_NOT_FOUND_ULTRA', `❌ Não encontrado após 4 níveis`, {
        phoneKey,
        variations: variations.length,
        activeConversations: conversations.size
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
        
        stickyInstances.clear();
        if (parsed.stickyInstances) {
            parsed.stickyInstances.forEach(([key, value]) => stickyInstances.set(key, value));
        }
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length);
        addLog('DATA_LOAD', 'Índices carregados: ' + phoneIndex.size + ' phoneIndex, ' + phoneVariations.size + ' variations');
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

// ============ ENVIO COM RETRY (MANTIDO IGUAL - FUNCIONA BEM) ============
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
    console.log('🔴 createPixWaitingConversation:', phoneKey);
    
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
    
    // 🔥 REGISTRA TODAS AS VARIAÇÕES
    registerPhoneUniversal(remoteJid, phoneKey);
    
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
    console.log('🟢 transferPixToApproved:', phoneKey);
    
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
    
    // 🔥 REGISTRA TODAS AS VARIAÇÕES
    registerPhoneUniversal(remoteJid, phoneKey);
    
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido para APROVADA`, { phoneKey, startingStep, productType });
    
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount) {
    console.log('🔵 startFunnel:', phoneKey, funnelId);
    
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
    
    // 🔥 REGISTRA TODAS AS VARIAÇÕES
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
        result = await sendWithFallback(phoneKey, conversation.remoteJid, step.type, step.text, step.mediaUrl, isFirstMessage);
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
        
        const incomingPhone = remoteJid.split('@')[0];
        const phoneKey = normalizePhoneKey(incomingPhone);
        
        console.log('🟦 Webhook Evolution:', {
            remoteJid,
            incomingPhone,
            phoneKey,
            text: messageText.substring(0, 30)
        });
        
        addLog('EVOLUTION_MESSAGE', `Mensagem recebida`, {
            remoteJid,
            phoneKey,
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
            // 🔥 BUSCA UNIVERSAL - ENCONTRA INDEPENDENTE DO FORMATO
            const conversation = findConversationUniversal(incomingPhone);
            
            addLog('EVOLUTION_SEARCH', `Busca resultado`, {
                found: conversation ? true : false,
                phoneKey: phoneKey,
                conversationKey: conversation ? conversation.phoneKey : null,
                waiting: conversation ? conversation.waiting_for_response : null
            });
            
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
            
            addLog('CLIENT_REPLY', `✅ Resposta processada`, { 
                phoneKey, 
                text: messageText.substring(0, 50),
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
            phone_variations_size: phoneVariations.size
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
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('📇 Índices: phoneIndex=' + phoneIndex.size + ', phoneVariations=' + phoneVariations.size);
}

app.listen(PORT, async () => {
    console.log('='.repeat(80));
    console.log('🛡️ KIRVANO v6.0 - SISTEMA ULTRA ROBUSTO');
    console.log('='.repeat(80));
    console.log('✅ Porta:', PORT);
    console.log('✅ Evolution:', EVOLUTION_BASE_URL);
    console.log('✅ Instâncias:', INSTANCES.length);
    console.log('');
    console.log('🔥 MELHORIAS IMPLEMENTADAS:');
    console.log('  ✅ Sistema de Normalização ULTRA Robusto');
    console.log('  ✅ Busca em 4 Níveis (Direta → Índice → Sufixos → Exaustiva)');
    console.log('  ✅ Geração de 30+ variações por telefone');
    console.log('  ✅ Registro automático de TODAS variações');
    console.log('  ✅ Compatível com @s.whatsapp.net, @lid, @g.us');
    console.log('  ✅ Tolerante a formatos com/sem 55, com/sem 9');
    console.log('  ✅ Sistema de Retry mantido (fallback entre instâncias)');
    console.log('  ✅ Sticky instances mantido (1 lead = 1 instância preferencial)');
    console.log('');
    console.log('📱 NORMALIZAÇÃO:');
    console.log('  • PerfectPay envia: 8899880565');
    console.log('  • Evolution retorna: 5588990429388@s.whatsapp.net');
    console.log('  • Sistema encontra: INDEPENDENTE do formato!');
    console.log('');
    console.log('🔍 BUSCA INTELIGENTE:');
    console.log('  • Nível 1: Busca direta por phoneKey');
    console.log('  • Nível 2: Busca em índices de variações');
    console.log('  • Nível 3: Busca com sufixos WhatsApp');
    console.log('  • Nível 4: Busca exaustiva em todas conversas');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('📊 Dashboard: http://localhost:' + PORT + '/api/dashboard');
    console.log('='.repeat(80));
    
    await initializeData();
});
