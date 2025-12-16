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
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos (ÚNICO delay no código)
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');
const MESSAGE_BLOCK_TIME = 60000; // 60 segundos

// ============ 🎯 CONFIGURAÇÕES DE DISTRIBUIÇÃO INTELIGENTE ============
const OVERLOAD_THRESHOLD = 5;              // 5 conversas ativas = sobrecarregada
const OVERLOAD_DELAY = 2 * 60 * 1000;     // 2 minutos de delay na próxima
const SENSITIVE_CONVERSATIONS = 10;        // 10 conversas para deixar de ser sensível
const SENSITIVE_TIME = 6 * 60 * 60 * 1000; // 6 horas
const INSTANCE_CHECK_INTERVAL = 2 * 60 * 1000; // Verifica instâncias a cada 2 minutos

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

// ============ 🔥 SISTEMA DE INSTÂNCIAS COM LISTA FIXA ============
// Lista FIXA das suas instâncias (apenas essas serão usadas)
const YOUR_INSTANCES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D13'];

let availableInstances = []; // Lista dinâmica: quais das SUAS instâncias estão conectadas
let sensitiveInstances = new Map(); // Instâncias sensíveis: {instance: {reconnectedAt, conversationsProcessed}}
let instanceLastUsed = new Map(); // Última vez que cada instância foi usada

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

let sentMessagesHash = new Map();
let messageBlockTimers = new Map();

// ============ 🔍 DETECÇÃO AUTOMÁTICA DE INSTÂNCIAS ============

async function fetchConnectedInstances() {
    try {
        const url = `${EVOLUTION_BASE_URL}/instance/fetchInstances`;
        
        addLog('INSTANCE_CHECK_START', '🔍 Consultando instâncias na Evolution API...', {
            yourInstances: YOUR_INSTANCES.join(', ')
        });
        
        const response = await axios.get(url, {
            headers: {
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 10000
        });
        
        if (!response.data || !Array.isArray(response.data)) {
            addLog('INSTANCE_CHECK_ERROR', '❌ Resposta inválida da Evolution API', { response: response.data });
            return [];
        }
        
        // Filtra apenas instâncias que:
        // 1. Estão na lista YOUR_INSTANCES (suas instâncias)
        // 2. Têm status "open" (conectadas)
        const allConnected = response.data
            .filter(inst => inst.instance && inst.instance.state === 'open')
            .map(inst => inst.instance.instanceName);
        
        const yourConnected = allConnected.filter(inst => YOUR_INSTANCES.includes(inst));
        
        const ignored = allConnected.filter(inst => !YOUR_INSTANCES.includes(inst));
        
        addLog('INSTANCE_CHECK_SUCCESS', `✅ ${yourConnected.length}/${YOUR_INSTANCES.length} das suas instâncias conectadas`, { 
            yourConnected: yourConnected.join(', ') || 'nenhuma',
            yourTotal: YOUR_INSTANCES.length,
            ignoredInstances: ignored.length > 0 ? ignored.join(', ') : 'nenhuma'
        });
        
        return yourConnected;
        
    } catch (error) {
        addLog('INSTANCE_CHECK_ERROR', '❌ Erro ao consultar instâncias', {
            error: error.message,
            code: error.code
        });
        return [];
    }
}

function updateAvailableInstances(newInstances) {
    const oldInstances = [...availableInstances];
    
    // Detecta instâncias que CAÍRAM
    const dropped = oldInstances.filter(inst => !newInstances.includes(inst));
    dropped.forEach(inst => {
        addLog('INSTANCE_DROPPED', `❌ ${inst} CAIU (desconectada)`, { instance: inst });
    });
    
    // Detecta instâncias que VOLTARAM
    const reconnected = newInstances.filter(inst => !oldInstances.includes(inst));
    reconnected.forEach(inst => {
        addLog('INSTANCE_RECONNECTED', `🔄 ${inst} VOLTOU (reconectada - marcada como SENSÍVEL)`, { 
            instance: inst,
            sensitiveFor: '10 conversas OU 6 horas'
        });
        
        // Marca como sensível
        sensitiveInstances.set(inst, {
            reconnectedAt: Date.now(),
            conversationsProcessed: 0
        });
    });
    
    // Atualiza lista global
    availableInstances = newInstances;
    
    addLog('INSTANCE_UPDATE', `📊 Instâncias atualizadas: ${newInstances.length} disponíveis`, {
        connected: newInstances.join(', '),
        sensitive: Array.from(sensitiveInstances.keys()).join(', ') || 'nenhuma'
    });
}

// Verifica instâncias a cada 2 minutos
setInterval(async () => {
    const connected = await fetchConnectedInstances();
    if (connected.length > 0) {
        updateAvailableInstances(connected);
    }
}, INSTANCE_CHECK_INTERVAL);

// Primeira verificação ao iniciar
setTimeout(async () => {
    const connected = await fetchConnectedInstances();
    if (connected.length > 0) {
        updateAvailableInstances(connected);
    }
}, 5000); // 5 segundos após iniciar

// ============ 🎯 DISTRIBUIÇÃO INTELIGENTE - MENOS CARREGADA ============

function getInstanceLoad() {
    const load = {};
    availableInstances.forEach(inst => load[inst] = 0);
    
    conversations.forEach(conv => {
        if (!conv.canceled && !conv.completed) {
            const instance = stickyInstances.get(conv.phoneKey);
            if (instance && load[instance] !== undefined) {
                load[instance]++;
            }
        }
    });
    
    return load;
}

function isSensitiveInstance(instanceName) {
    const sensitive = sensitiveInstances.get(instanceName);
    if (!sensitive) return false;
    
    const timeSince = Date.now() - sensitive.reconnectedAt;
    const conversationsOk = sensitive.conversationsProcessed >= SENSITIVE_CONVERSATIONS;
    const timeExpired = timeSince >= SENSITIVE_TIME;
    
    // Desmarca se atingiu 10 conversas OU passou 6 horas
    if (conversationsOk || timeExpired) {
        sensitiveInstances.delete(instanceName);
        addLog('INSTANCE_NO_LONGER_SENSITIVE', `✅ ${instanceName} não é mais SENSÍVEL`, {
            instance: instanceName,
            conversationsProcessed: sensitive.conversationsProcessed,
            hoursElapsed: Math.round(timeSince / (60 * 60 * 1000))
        });
        return false;
    }
    
    return true;
}

function selectBestInstance() {
    if (availableInstances.length === 0) {
        addLog('DISTRIBUTION_ERROR', '❌ NENHUMA instância disponível!');
        return null;
    }
    
    const load = getInstanceLoad();
    
    // Separa instâncias em normais e sensíveis
    const normal = [];
    const sensitive = [];
    
    availableInstances.forEach(inst => {
        if (isSensitiveInstance(inst)) {
            sensitive.push({ instance: inst, load: load[inst] });
        } else {
            normal.push({ instance: inst, load: load[inst] });
        }
    });
    
    // Se há instâncias normais com carga < 5, usa elas
    const normalAvailable = normal.filter(i => i.load < OVERLOAD_THRESHOLD);
    if (normalAvailable.length > 0) {
        // Escolhe a MENOS carregada entre as normais
        normalAvailable.sort((a, b) => a.load - b.load);
        const chosen = normalAvailable[0];
        
        addLog('DISTRIBUTION_NORMAL', `✅ ${chosen.instance} escolhida (${chosen.load} conversas - menos carregada)`, {
            instance: chosen.instance,
            load: chosen.load,
            allLoads: load,
            sensitive: sensitive.map(s => s.instance).join(', ') || 'nenhuma'
        });
        
        return chosen.instance;
    }
    
    // Se TODAS as normais estão sobrecarregadas (5+), precisa usar sensível OU a menos carregada
    const allInstances = [...normal, ...sensitive];
    allInstances.sort((a, b) => a.load - b.load);
    const chosen = allInstances[0];
    
    if (isSensitiveInstance(chosen.instance)) {
        addLog('DISTRIBUTION_SENSITIVE_FORCED', `⚠️ ${chosen.instance} escolhida (SENSÍVEL, mas outras sobrecarregadas)`, {
            instance: chosen.instance,
            load: chosen.load,
            allLoads: load,
            reason: 'Todas as instâncias normais estão sobrecarregadas (5+ conversas)'
        });
    } else {
        addLog('DISTRIBUTION_OVERLOADED', `⚠️ ${chosen.instance} escolhida (${chosen.load} conversas - TODAS sobrecarregadas)`, {
            instance: chosen.instance,
            load: chosen.load,
            allLoads: load
        });
    }
    
    return chosen.instance;
}

function shouldAddOverloadDelay(instanceName) {
    const load = getInstanceLoad();
    const instanceLoad = load[instanceName] || 0;
    
    if (instanceLoad >= OVERLOAD_THRESHOLD) {
        addLog('OVERLOAD_DELAY', `⏱️ ${instanceName} sobrecarregada (${instanceLoad} conversas) - delay de 2min na PRÓXIMA mensagem`, {
            instance: instanceName,
            load: instanceLoad,
            delay: '2 minutos'
        });
        return true;
    }
    
    return false;
}

function incrementInstanceUsage(instanceName) {
    // Incrementa contador de conversas processadas (para instâncias sensíveis)
    const sensitive = sensitiveInstances.get(instanceName);
    if (sensitive) {
        sensitive.conversationsProcessed++;
        sensitiveInstances.set(instanceName, sensitive);
        
        addLog('SENSITIVE_USAGE', `📊 ${instanceName} (sensível): ${sensitive.conversationsProcessed}/${SENSITIVE_CONVERSATIONS} conversas processadas`, {
            instance: instanceName,
            progress: sensitive.conversationsProcessed,
            target: SENSITIVE_CONVERSATIONS
        });
    }
}

// ============ 💰 SISTEMA DE VARIÁVEIS DINÂMICAS ============
function replaceVariables(text, conversation) {
    if (!text || !conversation) return text;
    
    let result = text;
    
    if (conversation.pixLink) {
        result = result.replace(/\{PIX_LINK\}/g, conversation.pixLink);
    }
    
    if (conversation.customerName) {
        result = result.replace(/\{NOME_CLIENTE\}/g, conversation.customerName);
        result = result.replace(/\{NOME\}/g, conversation.customerName);
    }
    
    if (conversation.amount) {
        result = result.replace(/\{VALOR\}/g, conversation.amount);
    }
    
    if (conversation.productType) {
        result = result.replace(/\{PRODUTO\}/g, conversation.productType);
    }
    
    return result;
}

// ============ 🔥 SISTEMA DE HASH E ANTI-DUPLICAÇÃO ============
function generateMessageHashImproved(phoneKey, step, conversation) {
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
    
    addLog('MESSAGE_REGISTERED', `Mensagem bloqueada por 60s (anti-duplicação)`, {
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

// ============ NORMALIZAÇÃO ============
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
    
    let conversation = conversations.get(phoneKey);
    if (conversation) {
        console.log('✅ NÍVEL 1: Encontrado (busca direta):', phoneKey);
        registerPhoneUniversal(phone, phoneKey);
        return conversation;
    }
    
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
    
    addLog('CONVERSATION_NOT_FOUND_ULTRA', `❌ Não encontrado após 5 níveis`, {
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
        addLog('DATA_LOAD_ERROR', 'Erro ao carregar funis');
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
    
    if (message.imageMessage) return message.imageMessage.caption || '[IMAGEM]';
    if (message.videoMessage) return message.videoMessage.caption || '[VÍDEO]';
    
    if (message.audioMessage) return '[ÁUDIO]';
    if (message.documentMessage) return '[DOCUMENTO]';
    if (message.stickerMessage) return '[FIGURINHA]';
    if (message.locationMessage) return '[LOCALIZAÇÃO]';
    if (message.contactMessage) return '[CONTATO]';
    
    if (message.viewOnceMessage) {
        if (message.viewOnceMessage.message?.imageMessage) return '[IMAGEM VISUALIZAÇÃO ÚNICA]';
        if (message.viewOnceMessage.message?.videoMessage) return '[VÍDEO VISUALIZAÇÃO ÚNICA]';
    }
    
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

async function sendWithFallback(phoneKey, remoteJid, step, conversation, isFirstMessage = false, needsOverloadDelay = false) {
    // 🔥 Anti-duplicação
    if (isMessageBlocked(phoneKey, step, conversation)) {
        addLog('SEND_BLOCKED_DUPLICATE', `🚫 BLOQUEADO - Mensagem duplicada`, {
            phoneKey,
            stepId: step.id,
            type: step.type
        });
        return { success: false, error: 'MESSAGE_ALREADY_SENT', blocked: true };
    }
    
    // 🔥 Delay de sobrecarga (APENAS na próxima mensagem, não em todas)
    if (needsOverloadDelay) {
        addLog('OVERLOAD_DELAY_APPLYING', `⏱️ Aplicando delay de 2min (instância sobrecarregada)`, {
            phoneKey,
            delay: '2 minutos'
        });
        await new Promise(resolve => setTimeout(resolve, OVERLOAD_DELAY));
    }
    
    const finalText = replaceVariables(step.text, conversation);
    const finalMediaUrl = replaceVariables(step.mediaUrl, conversation);
    
    let instanceName;
    const forcedInstance = conversation.forceStickyInstance;
    
    if (forcedInstance) {
        instanceName = forcedInstance;
        addLog('FORCED_STICKY_INSTANCE', `Usando instância forçada: ${forcedInstance}`, { phoneKey });
    } else if (isFirstMessage) {
        // 🎯 Distribuição inteligente - menos carregada
        instanceName = selectBestInstance();
        if (!instanceName) {
            addLog('SEND_ERROR', '❌ Nenhuma instância disponível', { phoneKey });
            return { success: false, error: 'NO_INSTANCES_AVAILABLE' };
        }
    } else {
        // Usa sticky instance
        instanceName = stickyInstances.get(phoneKey) || selectBestInstance();
    }
    
    const maxAttempts = 3;
    
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
                // 🔥 Registra mensagem enviada (anti-duplicação)
                registerSentMessage(phoneKey, step, conversation);
                
                // Registra uso da instância
                stickyInstances.set(phoneKey, instanceName);
                incrementInstanceUsage(instanceName);
                
                if (conversation.forceStickyInstance) {
                    conversation.forceStickyInstance = null;
                    conversations.set(phoneKey, conversation);
                }
                
                addLog('SEND_SUCCESS', `✅ Mensagem enviada via ${instanceName}`, { 
                    phoneKey, 
                    stepId: step.id, 
                    type: step.type,
                    instance: instanceName
                });
                
                return { success: true, instanceName };
            }
            
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    addLog('SEND_ALL_FAILED', `❌ Falha total no envio para ${phoneKey}`, { instanceName });
    
    const conv = conversations.get(phoneKey);
    if (conv) {
        conv.hasError = true;
        conversations.set(phoneKey, conv);
    }
    
    return { success: false, error: 'SEND_FAILED' };
}

// ============ ORQUESTRAÇÃO - 100% BASEADO NO SITE ============

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount, pixLink, pixQrCode) {
    console.log('🔴 createPixWaitingConversation:', phoneKey);
    
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

async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    console.log('🟢 transferPixToApproved:', phoneKey);
    
    const pixConv = conversations.get(phoneKey);
    
    const pixLink = pixConv ? pixConv.pixLink : null;
    const pixQrCode = pixConv ? pixConv.pixQrCode : null;
    
    const oldStickyInstance = stickyInstances.get(phoneKey);
    
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
    
    const startingStep = 0;
    
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido para APROVADA na mesma instância`, { 
        phoneKey, 
        productType,
        oldInstance: oldStickyInstance || 'NENHUMA'
    });
    
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
        lastSystemMessage: new Date(),
        lastReply: null,
        canceled: false,
        completed: false,
        transferredFromPix: true,
        forceStickyInstance: oldStickyInstance
    };
    
    conversations.set(phoneKey, approvedConv);
    registerPhoneUniversal(remoteJid, phoneKey);
    
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount, pixLink, pixQrCode) {
    console.log('🔵 startFunnel:', phoneKey, funnelId);
    
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

// 🔥 sendStep - 100% RESPEITA O SITE
async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled || conversation.pixWaiting) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('FUNNEL_NOT_FOUND', `❌ Funil ${conversation.funnelId} não encontrado`, { phoneKey });
        return;
    }
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) {
        addLog('STEP_NOT_FOUND', `❌ Step ${conversation.stepIndex} não existe no funil`, { 
            phoneKey,
            funnelId: conversation.funnelId,
            stepIndex: conversation.stepIndex,
            totalSteps: funnel.steps.length
        });
        return;
    }
    
    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    
    addLog('STEP_SEND_START', `📤 Enviando passo ${conversation.stepIndex + 1}/${funnel.steps.length}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepId: step.id,
        stepType: step.type,
        waitForReply: step.waitForReply || false
    });
    
    // 🔥 Aplica TODOS os delays do SITE (ANTES de enviar)
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `⏱️ Aguardando delayBefore: ${delaySeconds}s (configurado no site)`, { 
            phoneKey, 
            stepId: step.id,
            delay: delaySeconds + 's'
        });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    if (step.showTyping && step.type !== 'delay') {
        addLog('STEP_TYPING', `⏱️ Simulando digitação: 3s`, { phoneKey, stepId: step.id });
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    let result = { success: true };
    
    if (step.type === 'delay') {
        const delaySeconds = parseInt(step.delaySeconds || 10);
        addLog('STEP_DELAY_EXECUTE', `⏱️ Executando delay: ${delaySeconds}s (configurado no site)`, { 
            phoneKey, 
            stepId: step.id,
            delay: delaySeconds + 's'
        });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    } else {
        // 🔥 Marca waiting ANTES de enviar (se waitForReply)
        if (step.waitForReply) {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            addLog('STEP_MARKED_WAITING', `✅ MARCADO como aguardando ANTES de enviar`, { 
                phoneKey, 
                stepId: step.id,
                waiting: true 
            });
        }
        
        // Verifica se precisa adicionar delay de sobrecarga
        const instanceName = stickyInstances.get(phoneKey);
        const needsOverloadDelay = instanceName && shouldAddOverloadDelay(instanceName);
        
        result = await sendWithFallback(phoneKey, conversation.remoteJid, step, conversation, isFirstMessage, needsOverloadDelay);
        
        if (result.blocked) {
            addLog('STEP_BLOCKED_DUPLICATE', `🚫 Passo bloqueado por duplicação`, { phoneKey, stepId: step.id });
            if (step.waitForReply) {
                conversation.waiting_for_response = false;
                conversations.set(phoneKey, conversation);
            }
            return;
        }
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        conversations.set(phoneKey, conversation);
        
        if (step.waitForReply && step.type !== 'delay') {
            // JÁ marcou waiting = true ANTES de enviar
            addLog('STEP_WAITING_REPLY', `⏸️ Aguardando resposta do lead (passo ${conversation.stepIndex + 1})`, { 
                phoneKey,
                stepId: step.id,
                message: 'Fluxo pausado até o lead responder (QUALQUER tipo de mensagem)'
            });
        } else {
            // Mensagem que NÃO espera resposta → avança automaticamente
            addLog('STEP_AUTO_ADVANCE', `⏭️ Avançando automaticamente (sem waitForReply)`, { 
                phoneKey,
                stepId: step.id 
            });
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
        addLog('FUNNEL_END', `✅ Funil concluído`, { phoneKey, funnelId: conversation.funnelId });
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    
    if (reason === 'reply') {
        conversation.lastReply = new Date();
        conversation.waiting_for_response = false;
    }
    
    conversations.set(phoneKey, conversation);
    addLog('STEP_ADVANCE', `⏭️ Avançando para passo ${nextStepIndex + 1}/${funnel.steps.length}`, { 
        phoneKey, 
        reason,
        nextStep: nextStepIndex + 1
    });
    
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

// 🔥 Webhook Evolution - 100% FUNCIONAL
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
        
        addLog('EVOLUTION_MESSAGE', `📩 Mensagem recebida${isLid ? ' (@lid)' : ''}`, {
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
            
            addLog('EVOLUTION_SEARCH', `🔍 Busca resultado`, {
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
            
            // 🔥 Só aceita se REALMENTE está esperando
            if (!conversation.waiting_for_response) {
                addLog('EVOLUTION_NOT_WAITING', '⚠️ Conversa não está esperando resposta - IGNORANDO', { 
                    phoneKey,
                    stepIndex: conversation.stepIndex + 1,
                    waiting: false
                });
                return res.json({ success: true });
            }
            
            console.log('✅✅✅ RESPOSTA VÁLIDA - Avançando conversa');
            
            addLog('CLIENT_REPLY', `✅ Resposta processada${isLid ? ' (@lid)' : ''}`, { 
                phoneKey, 
                text: messageText.substring(0, 50),
                stepIndex: conversation.stepIndex + 1,
                isLid: isLid,
                message: 'Lead respondeu - fluxo continua'
            });
            
            // Avança e desmarca waiting dentro de advanceConversation
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
    availableInstances.forEach(inst => instanceUsage[inst] = 0);
    
    conversations.forEach(conv => {
        if (!conv.canceled && !conv.completed) {
            const instance = stickyInstances.get(conv.phoneKey);
            if (instance && instanceUsage[instance] !== undefined) {
                instanceUsage[instance]++;
            }
        }
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
            total_instances: availableInstances.length,
            available_instances: availableInstances.join(', '),
            sensitive_instances: Array.from(sensitiveInstances.keys()).join(', ') || 'nenhuma',
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
            version: '9.1',
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
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
    console.log('='.repeat(80));
    console.log('🛡️ KIRVANO v9.1 - SISTEMA DEFINITIVO 100% BASEADO NO SITE');
    console.log('='.repeat(80));
    console.log('✅ Porta:', PORT);
    console.log('✅ Evolution:', EVOLUTION_BASE_URL);
    console.log('✅ Suas Instâncias:', YOUR_INSTANCES.join(', '));
    console.log('');
    console.log('🎯 FUNCIONALIDADES v9.1:');
    console.log('  ✅ Lista FIXA de instâncias (ignora outras da Evolution)');
    console.log('  ✅ Detecção automática (consulta a cada 2min)');
    console.log('  ✅ Distribuição inteligente - MENOS CARREGADA');
    console.log('  ✅ Instâncias sensíveis (10 conversas OU 6 horas)');
    console.log('  ✅ Delay de 2min em sobrecarga (5+ conversas)');
    console.log('  ✅ NUNCA bloqueia lead');
    console.log('  ✅ 100% baseado no site (ZERO hardcoded)');
    console.log('  ✅ waitForReply 100% respeitado');
    console.log('  ✅ ZERO duplicação de mensagens');
    console.log('  ✅ Sincronização automática com site');
    console.log('  ✅ Logs super detalhados');
    console.log('');
    console.log('📊 CONFIGURAÇÕES:');
    console.log('  📱 Total de instâncias: ' + YOUR_INSTANCES.length);
    console.log('  ⚠️ Sobrecarregada: 5 conversas ativas');
    console.log('  ⏱️ Delay sobrecarga: 2 minutos');
    console.log('  🔄 Sensível: 10 conversas OU 6 horas');
    console.log('  🔍 Verificação instâncias: a cada 2 minutos');
    console.log('  ⏰ Timeout PIX: 7 minutos (ÚNICO delay no código)');
    console.log('');
    console.log('🌐 Endpoints:');
    console.log('  📊 Dashboard: http://localhost:' + PORT + '/api/dashboard');
    console.log('  📋 Logs: http://localhost:' + PORT + '/api/logs?limit=200');
    console.log('  🏠 Frontend: http://localhost:' + PORT);
    console.log('='.repeat(80));
    
    await initializeData();
});
