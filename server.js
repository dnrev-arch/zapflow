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

// ✅ CONFIGURAÇÕES DO SISTEMA DE HEALTH CHECK
const HEALTH_CHECK_INTERVAL = 30000; // 30 segundos
const HEALTH_CHECK_TIMEOUT = 10000; // 10 segundos por teste
const MAX_CONSECUTIVE_FAILURES = 3; // 3 falhas consecutivas = offline
const RECOVERY_CHECK_INTERVAL = 60000; // 1 minuto para instâncias offline

// Mapeamento dos produtos Kirvano
const PRODUCT_MAPPING = {
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS',
    '564bb9bb-718a-4e8b-a843-a2da62f616f0': 'CS',
    '668a73bc-2fca-4f12-9331-ef945181cd5c': 'FAB'
};

// Instâncias Evolution (fallback sequencial)
const INSTANCES = ['D01', 'D04', 'D05', 'D06', 'D07', 'D08', 'D10'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let idempotencyCache = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let logs = [];
let funis = new Map();
let instanceRoundRobin = 0;

// ✅ NOVO: SISTEMA DE MONITORAMENTO DE INSTÂNCIAS
let instanceHealth = new Map(); // Status de cada instância
let instanceStats = new Map(); // Estatísticas detalhadas
let systemAlerts = []; // Alertas do sistema
let healthCheckActive = false; // Controle do health check

// Inicializar health map
INSTANCES.forEach(instance => {
    instanceHealth.set(instance, {
        status: 'UNKNOWN', // ONLINE, OFFLINE, UNKNOWN, TESTING
        lastCheck: null,
        lastSuccess: null,
        lastError: null,
        consecutiveFailures: 0,
        responseTime: 0,
        uptime: 0,
        downtime: 0,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0
    });
    
    instanceStats.set(instance, {
        conversationsCount: 0,
        messagesThisHour: 0,
        averageResponseTime: 0,
        lastHourStats: []
    });
});

// ✅ FUNIS PADRÃO CORRIGIDOS
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Parabéns! Seu pedido foi aprovado. Bem-vindo ao CS!',
                waitForReply: true,
                timeoutMinutes: 60,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pela resposta! Aqui estão seus próximos passos...',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Lembre-se de acessar nossa plataforma. Qualquer dúvida, estamos aqui!',
                waitForReply: false
            }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Seu PIX foi gerado! Aguardamos o pagamento para liberar o acesso ao CS.',
                waitForReply: true,
                timeoutMinutes: 10,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pelo contato! Assim que o pagamento for confirmado, você receberá o acesso.',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato conosco para gerar um novo.',
                waitForReply: false
            }
        ]
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA',
        name: 'FAB - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Parabéns! Seu pedido FAB foi aprovado. Prepare-se para a transformação!',
                waitForReply: true,
                timeoutMinutes: 60,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Que bom que respondeu! Sua jornada FAB começa agora...',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Acesse nossa área de membros e comece sua transformação hoje mesmo!',
                waitForReply: false
            }
        ]
    },
    'FAB_PIX': {
        id: 'FAB_PIX',
        name: 'FAB - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Seu PIX FAB foi gerado! Aguardamos o pagamento para iniciar sua transformação.',
                waitForReply: true,
                timeoutMinutes: 10,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pelo contato! Logo após o pagamento, você terá acesso completo ao FAB.',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato para gerar um novo e não perder essa oportunidade.',
                waitForReply: false
            }
        ]
    }
};

// ============ SISTEMA DE ALERTAS ============
function createAlert(type, title, message, severity = 'warning', instanceId = null) {
    const alert = {
        id: uuidv4(),
        type, // INSTANCE_DOWN, INSTANCE_UP, MIGRATION, ERROR, etc.
        title,
        message,
        severity, // info, warning, error, critical
        instanceId,
        timestamp: new Date(),
        acknowledged: false
    };
    
    systemAlerts.unshift(alert);
    
    // Limitar a 100 alertas
    if (systemAlerts.length > 100) {
        systemAlerts = systemAlerts.slice(0, 100);
    }
    
    // Log do alerta
    addLog('SYSTEM_ALERT', `${title}: ${message}`, { alert });
    
    return alert;
}

// ============ HEALTH CHECK SISTEMA ============
async function checkInstanceHealth(instanceName) {
    const startTime = Date.now();
    const health = instanceHealth.get(instanceName);
    
    health.status = 'TESTING';
    health.lastCheck = new Date();
    health.totalRequests++;
    
    try {
        // Teste simples: verificar se instância responde
        const response = await axios.get(`${EVOLUTION_BASE_URL}/instance/connectionState/${instanceName}`, {
            headers: { 'apikey': EVOLUTION_API_KEY },
            timeout: HEALTH_CHECK_TIMEOUT,
            validateStatus: () => true // Aceita qualquer status para análise
        });
        
        const responseTime = Date.now() - startTime;
        health.responseTime = responseTime;
        
        // Considerar sucesso se status 200-299 ou instância conectada
        const isHealthy = response.status >= 200 && response.status < 300;
        
        if (isHealthy) {
            // SUCESSO
            health.status = 'ONLINE';
            health.lastSuccess = new Date();
            health.consecutiveFailures = 0;
            health.successfulRequests++;
            
            // Atualizar uptime
            if (health.lastError) {
                health.uptime += Date.now() - health.lastError.getTime();
            }
            
            addLog('HEALTH_CHECK_SUCCESS', `${instanceName}: ONLINE (${responseTime}ms)`, { 
                instanceName, 
                responseTime,
                status: response.status
            });
            
            return { success: true, responseTime, status: response.status };
            
        } else {
            throw new Error(`HTTP ${response.status}: ${response.data?.message || 'Instância não saudável'}`);
        }
        
    } catch (error) {
        // FALHA
        const responseTime = Date.now() - startTime;
        health.responseTime = responseTime;
        health.status = 'OFFLINE';
        health.lastError = new Date();
        health.consecutiveFailures++;
        health.failedRequests++;
        
        // Atualizar downtime
        if (health.lastSuccess) {
            health.downtime += Date.now() - health.lastSuccess.getTime();
        }
        
        addLog('HEALTH_CHECK_FAILED', `${instanceName}: OFFLINE (${health.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, { 
            instanceName, 
            error: error.message,
            consecutiveFailures: health.consecutiveFailures
        });
        
        // Criar alerta se atingiu limite de falhas
        if (health.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
            createAlert('INSTANCE_DOWN', 
                `Instância ${instanceName} OFFLINE`, 
                `Instância não responde após ${MAX_CONSECUTIVE_FAILURES} tentativas. Migração automática iniciada.`,
                'error',
                instanceName
            );
            
            // Iniciar migração automática
            await migrateConversationsFromInstance(instanceName);
        }
        
        return { success: false, error: error.message, responseTime };
    }
}

// ============ MIGRAÇÃO AUTOMÁTICA DE CONVERSAS ============
async function migrateConversationsFromInstance(offlineInstance) {
    const conversationsToMigrate = [];
    
    // Encontrar conversas sticky na instância offline
    stickyInstances.forEach((instanceName, remoteJid) => {
        if (instanceName === offlineInstance) {
            conversationsToMigrate.push(remoteJid);
        }
    });
    
    if (conversationsToMigrate.length === 0) {
        addLog('MIGRATION_NO_CONVERSATIONS', `Nenhuma conversa para migrar da ${offlineInstance}`);
        return;
    }
    
    // Encontrar melhor instância para migração (com menos conversas)
    const targetInstance = findBestInstanceForMigration();
    
    if (!targetInstance) {
        createAlert('MIGRATION_FAILED', 
            'Falha na migração automática', 
            `Não há instâncias saudáveis disponíveis para migrar ${conversationsToMigrate.length} conversas de ${offlineInstance}`,
            'critical',
            offlineInstance
        );
        return;
    }
    
    // Migrar conversas
    let migratedCount = 0;
    conversationsToMigrate.forEach(remoteJid => {
        stickyInstances.set(remoteJid, targetInstance);
        migratedCount++;
    });
    
    addLog('MIGRATION_SUCCESS', `${migratedCount} conversas migradas: ${offlineInstance} → ${targetInstance}`, {
        from: offlineInstance,
        to: targetInstance,
        count: migratedCount,
        conversations: conversationsToMigrate.slice(0, 5) // Primeiras 5 para log
    });
    
    createAlert('MIGRATION', 
        'Migração automática concluída', 
        `${migratedCount} conversas migradas de ${offlineInstance} para ${targetInstance}`,
        'warning',
        offlineInstance
    );
    
    // Atualizar estatísticas
    const targetStats = instanceStats.get(targetInstance);
    const offlineStats = instanceStats.get(offlineInstance);
    
    if (targetStats && offlineStats) {
        targetStats.conversationsCount += migratedCount;
        offlineStats.conversationsCount = 0;
    }
}

// ============ ENCONTRAR MELHOR INSTÂNCIA PARA MIGRAÇÃO ============
function findBestInstanceForMigration() {
    const healthyInstances = [];
    
    instanceHealth.forEach((health, instanceName) => {
        if (health.status === 'ONLINE') {
            const stats = instanceStats.get(instanceName);
            healthyInstances.push({
                name: instanceName,
                conversationsCount: stats.conversationsCount,
                responseTime: health.responseTime
            });
        }
    });
    
    if (healthyInstances.length === 0) {
        return null;
    }
    
    // Ordenar por menos conversas, depois por menor response time
    healthyInstances.sort((a, b) => {
        if (a.conversationsCount === b.conversationsCount) {
            return a.responseTime - b.responseTime;
        }
        return a.conversationsCount - b.conversationsCount;
    });
    
    return healthyInstances[0].name;
}

// ============ HEALTH CHECK LOOP PRINCIPAL ============
async function runHealthCheck() {
    if (!healthCheckActive) return;
    
    addLog('HEALTH_CHECK_START', 'Iniciando verificação de saúde das instâncias');
    
    const healthPromises = INSTANCES.map(instance => checkInstanceHealth(instance));
    
    try {
        await Promise.allSettled(healthPromises);
        
        // Atualizar estatísticas
        updateInstanceStatistics();
        
        // Verificar recuperação de instâncias
        await checkInstanceRecovery();
        
    } catch (error) {
        addLog('HEALTH_CHECK_ERROR', 'Erro no health check: ' + error.message);
    }
    
    addLog('HEALTH_CHECK_COMPLETE', 'Verificação de saúde concluída');
}

// ============ VERIFICAR RECUPERAÇÃO DE INSTÂNCIAS ============
async function checkInstanceRecovery() {
    const offlineInstances = [];
    
    instanceHealth.forEach((health, instanceName) => {
        if (health.status === 'OFFLINE' && health.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            offlineInstances.push(instanceName);
        }
    });
    
    if (offlineInstances.length === 0) return;
    
    addLog('RECOVERY_CHECK', `Verificando recuperação de ${offlineInstances.length} instâncias offline`);
    
    for (const instanceName of offlineInstances) {
        const result = await checkInstanceHealth(instanceName);
        
        if (result.success) {
            createAlert('INSTANCE_UP', 
                `Instância ${instanceName} RECUPERADA`, 
                `Instância voltou a responder e está disponível para novas conversas.`,
                'info',
                instanceName
            );
            
            addLog('INSTANCE_RECOVERED', `${instanceName} voltou online automaticamente`);
        }
    }
}

// ============ ATUALIZAR ESTATÍSTICAS ============
function updateInstanceStatistics() {
    // Contar conversas por instância
    const conversationCounts = new Map();
    INSTANCES.forEach(instance => conversationCounts.set(instance, 0));
    
    stickyInstances.forEach(instanceName => {
        const current = conversationCounts.get(instanceName) || 0;
        conversationCounts.set(instanceName, current + 1);
    });
    
    // Atualizar stats
    conversationCounts.forEach((count, instanceName) => {
        const stats = instanceStats.get(instanceName);
        if (stats) {
            stats.conversationsCount = count;
        }
    });
    
    // Limpar estatísticas antigas (manter apenas última hora)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    instanceStats.forEach(stats => {
        stats.lastHourStats = stats.lastHourStats.filter(s => s.timestamp > oneHourAgo);
    });
}

// ============ INICIALIZAR HEALTH CHECK ============
function startHealthCheckSystem() {
    healthCheckActive = true;
    
    addLog('HEALTH_SYSTEM_START', 'Sistema de monitoramento de instâncias iniciado', {
        interval: HEALTH_CHECK_INTERVAL,
        timeout: HEALTH_CHECK_TIMEOUT,
        maxFailures: MAX_CONSECUTIVE_FAILURES
    });
    
    createAlert('SYSTEM', 
        'Sistema de monitoramento iniciado', 
        `Health check ativo com intervalo de ${HEALTH_CHECK_INTERVAL/1000}s`,
        'info'
    );
    
    // Health check principal
    setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL);
    
    // Recovery check para instâncias offline
    setInterval(checkInstanceRecovery, RECOVERY_CHECK_INTERVAL);
    
    // Primeiro health check imediato
    setTimeout(runHealthCheck, 5000);
}

function stopHealthCheckSystem() {
    healthCheckActive = false;
    addLog('HEALTH_SYSTEM_STOP', 'Sistema de monitoramento de instâncias parado');
}

// ============ PERSISTÊNCIA DE DADOS ============

// Garantir que a pasta data existe
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe ou erro ao criar:', error.message);
    }
}

// Salvar funis no arquivo
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

// Carregar funis do arquivo
async function loadFunnelsFromFile() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelsArray = JSON.parse(data);
        
        // Limpar funis atuais e recarregar
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

// Salvar conversas ativas (para não perder o que está em andamento)
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

// Carregar conversas ativas
async function loadConversationsFromFile() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        // Recarregar conversas
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
        
        // Recarregar sticky instances
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

// Auto-save periódico (a cada 30 segundos)
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
app.use(express.static('public')); // Serve arquivos estáticos da pasta public

// ============ FUNÇÕES AUXILIARES ============
function normalizePhone(phone) {
    if (!phone) return '';
    
    // Remove todos os caracteres não numéricos
    let cleaned = phone.replace(/\D/g, '');
    
    // Se começar com +55, remove o +
    if (cleaned.startsWith('55')) {
        cleaned = cleaned.substring(2);
    }
    
    // ✅ NORMALIZAÇÃO ROBUSTA PARA NÚMEROS BRASILEIROS
    
    // Se tem 10 dígitos (DDD + 8 dígitos), adicionar 9
    if (cleaned.length === 10) {
        const ddd = cleaned.substring(0, 2);
        const numero = cleaned.substring(2);
        cleaned = ddd + '9' + numero; // Adiciona o 9
    }
    
    // Se tem 11 dígitos mas não tem 9 após o DDD, adicionar
    if (cleaned.length === 11) {
        const ddd = cleaned.substring(0, 2);
        const primeiroDigito = cleaned.substring(2, 3);
        
        // Se o primeiro dígito após DDD não é 9, adicionar 9
        if (primeiroDigito !== '9') {
            const numero = cleaned.substring(2);
            cleaned = ddd + '9' + numero;
        }
    }
    
    // Garantir que tem exatamente 11 dígitos no final
    if (cleaned.length === 11) {
        cleaned = '55' + cleaned; // Adicionar código do país
    } else if (cleaned.length === 13 && cleaned.startsWith('55')) {
        // Já tem 55 + 11 dígitos, está correto
    } else {
        // Formato não reconhecido, tentar com código do país
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

// ✅ CORREÇÃO 1: STICKY INSTANCE - Função corrigida para NÃO mover conversas
function findConversationByPhone(phone) {
    const normalized = normalizePhone(phone);
    const remoteJid = normalized + '@s.whatsapp.net';
    
    // Tentar encontrar conversa com número exato
    if (conversations.has(remoteJid)) {
        addLog('CONVERSATION_FOUND_EXACT', 'Conversa encontrada com número exato', { remoteJid });
        return { conversation: conversations.get(remoteJid), key: remoteJid };
    }
    
    // ✅ BUSCA FLEXÍVEL: Criar variações do número PARA BUSCA APENAS
    const phoneOnly = normalized.replace('55', ''); // Remove código do país
    const variations = [
        normalized + '@s.whatsapp.net',                    // 5575981734444@s.whatsapp.net
        '55' + phoneOnly + '@s.whatsapp.net',             // Com código país
        phoneOnly + '@s.whatsapp.net',                    // Sem código país: 75981734444@s.whatsapp.net
    ];
    
    // Se tem 11 dígitos, criar variação sem 9
    if (phoneOnly.length === 11 && phoneOnly.charAt(2) === '9') {
        const ddd = phoneOnly.substring(0, 2);
        const numeroSem9 = phoneOnly.substring(3);
        variations.push(ddd + numeroSem9 + '@s.whatsapp.net');           // 7581734444@s.whatsapp.net
        variations.push('55' + ddd + numeroSem9 + '@s.whatsapp.net');   // 557581734444@s.whatsapp.net
    }
    
    // Buscar em todas as variações MAS NÃO MOVER
    for (const variation of variations) {
        if (conversations.has(variation)) {
            addLog('CONVERSATION_FOUND_VARIATION', 'Conversa encontrada com variação (não movendo)', { 
                searched: remoteJid,
                found: variation,
                variations: variations
            });
            
            // ✅ IMPORTANTE: RETORNAR A CONVERSA COM A CHAVE ORIGINAL (não mover)
            return { conversation: conversations.get(variation), key: variation };
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
    const startTime = Date.now();
    
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 15000
        });
        
        // ✅ ATUALIZAR ESTATÍSTICAS DE SUCESSO
        const stats = instanceStats.get(instanceName);
        if (stats) {
            stats.messagesThisHour++;
            stats.lastHourStats.push({
                timestamp: Date.now(),
                success: true,
                responseTime: Date.now() - startTime
            });
        }
        
        return { ok: true, data: response.data };
    } catch (error) {
        // ✅ ATUALIZAR ESTATÍSTICAS DE FALHA
        const stats = instanceStats.get(instanceName);
        if (stats) {
            stats.lastHourStats.push({
                timestamp: Date.now(),
                success: false,
                responseTime: Date.now() - startTime,
                error: error.message
            });
        }
        
        return { 
            ok: false, 
            error: error.response?.data || error.message,
            status: error.response?.status
        };
    }
}

// ✅ CORREÇÃO: Funções de envio com formato correto para Evolution API
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

// ✅ CORREÇÃO 2: ÁUDIO - Função corrigida com payload completo
async function sendAudio(remoteJid, audioUrl, clientMessageId, instanceName) {
    // ✅ Payload corrigido para áudio - testando diferentes formatos
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'audio',
        media: audioUrl,
        fileName: 'audio.mp3'  // ✅ Adicionado fileName que pode ser necessário
    };
    
    addLog('AUDIO_SEND_ATTEMPT', 'Tentando enviar áudio', { 
        remoteJid, 
        audioUrl, 
        instanceName,
        payload 
    });
    
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

// ============ ENVIO COM FALLBACK INTELIGENTE (USANDO HEALTH CHECK) ============
async function sendWithFallback(remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    const clientMessageId = uuidv4();
    let instancesToTry = [];
    
    // ✅ CORREÇÃO 1: STICKY INSTANCE - Sempre verificar sticky instance primeiro
    const existingStickyInstance = stickyInstances.get(remoteJid);
    
    if (existingStickyInstance) {
        // ✅ NOVO: Verificar se sticky instance está saudável
        const stickyHealth = instanceHealth.get(existingStickyInstance);
        
        if (stickyHealth && stickyHealth.status === 'ONLINE') {
            // Sticky instance está saudável - usar ela primeiro
            instancesToTry = [existingStickyInstance, ...getHealthyInstancesExcept(existingStickyInstance)];
            addLog('STICKY_INSTANCE_HEALTHY', `Usando sticky instance saudável ${existingStickyInstance}`, { 
                remoteJid, 
                isFirstMessage 
            });
        } else {
            // ✅ NOVO: Sticky instance não está saudável - migrar automaticamente
            addLog('STICKY_INSTANCE_UNHEALTHY', `Sticky instance ${existingStickyInstance} não saudável, migrando...`, { 
                remoteJid,
                stickyHealth: stickyHealth?.status
            });
            
            // Migrar para instância saudável
            const newInstance = findBestInstanceForMigration();
            if (newInstance) {
                stickyInstances.set(remoteJid, newInstance);
                instancesToTry = [newInstance, ...getHealthyInstancesExcept(newInstance)];
                
                addLog('STICKY_INSTANCE_MIGRATED', `Conversa migrada automaticamente: ${existingStickyInstance} → ${newInstance}`, {
                    remoteJid,
                    from: existingStickyInstance,
                    to: newInstance
                });
                
                createAlert('MIGRATION', 
                    'Migração automática de conversa', 
                    `Conversa migrada de ${existingStickyInstance} (offline) para ${newInstance}`,
                    'warning',
                    existingStickyInstance
                );
            } else {
                // Nenhuma instância saudável disponível - usar todas e esperar o melhor
                instancesToTry = INSTANCES;
                addLog('NO_HEALTHY_INSTANCES', 'Nenhuma instância saudável disponível, tentando todas', { remoteJid });
            }
        }
    } else if (isFirstMessage) {
        // ✅ NOVO: Round-robin apenas entre instâncias saudáveis
        const healthyInstances = getHealthyInstances();
        
        if (healthyInstances.length > 0) {
            const primaryInstanceIndex = instanceRoundRobin % healthyInstances.length;
            const primaryInstance = healthyInstances[primaryInstanceIndex];
            instanceRoundRobin++;
            
            instancesToTry = [primaryInstance, ...healthyInstances.filter(i => i !== primaryInstance)];
            
            addLog('HEALTHY_ROUND_ROBIN', `Nova conversa distribuída para instância saudável ${primaryInstance}`, { 
                remoteJid,
                healthyInstances: healthyInstances.length,
                distributionNumber: instanceRoundRobin
            });
        } else {
            // Nenhuma instância marcada como saudável - usar todas
            instancesToTry = INSTANCES;
            instanceRoundRobin++;
            addLog('NO_HEALTHY_FIRST_MESSAGE', 'Nenhuma instância saudável para primeira mensagem, tentando todas', { remoteJid });
        }
    } else {
        // Mensagem subsequente sem sticky - usar instâncias saudáveis
        instancesToTry = getHealthyInstances();
        if (instancesToTry.length === 0) {
            instancesToTry = INSTANCES;
        }
    }
    
    let lastError = null;
    
    for (const instanceName of instancesToTry) {
        try {
            addLog('SEND_ATTEMPT', `Tentando ${instanceName}`, { 
                type, 
                remoteJid,
                instanceHealth: instanceHealth.get(instanceName)?.status,
                isFirstMessage
            });
            
            let result;
            
            // ✅ CORREÇÃO 2: ÁUDIO - Adicionado suporte completo a áudio
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
                // ✅ ÁUDIO agora vai funcionar corretamente
                result = await sendAudio(remoteJid, mediaUrl, clientMessageId, instanceName);
            }
            
            if (result && result.ok) {
                // ✅ Definir sticky instance apenas se não existir ainda
                if (!existingStickyInstance) {
                    stickyInstances.set(remoteJid, instanceName);
                    addLog('STICKY_INSTANCE_SET', `Nova sticky instance definida: ${instanceName}`, { 
                        remoteJid,
                        isFirstMessage 
                    });
                }
                
                addLog('SEND_SUCCESS', `Mensagem enviada com sucesso via ${instanceName}`, { 
                    remoteJid, 
                    type,
                    isFirstMessage,
                    instanceHealth: instanceHealth.get(instanceName)?.status
                });
                
                return { success: true, instanceName };
            } else {
                lastError = result.error;
                addLog('SEND_FAILED', `${instanceName} falhou: ${JSON.stringify(lastError)}`, { 
                    remoteJid, 
                    type,
                    instanceHealth: instanceHealth.get(instanceName)?.status
                });
            }
        } catch (error) {
            lastError = error.message;
            addLog('SEND_ERROR', `${instanceName} erro: ${error.message}`, { 
                remoteJid, 
                type,
                instanceHealth: instanceHealth.get(instanceName)?.status
            });
        }
    }
    
    // ✅ CRIAR ALERTA SE TODAS AS INSTÂNCIAS FALHARAM
    createAlert('SEND_FAILED', 
        'Falha no envio de mensagem', 
        `Todas as instâncias falharam para ${remoteJid}. Última falha: ${lastError}`,
        'error'
    );
    
    addLog('SEND_ALL_FAILED', 'Todas as instâncias falharam para ' + remoteJid, { lastError });
    return { success: false, error: lastError };
}

// ============ FUNÇÕES AUXILIARES DO HEALTH CHECK ============
function getHealthyInstances() {
    const healthy = [];
    instanceHealth.forEach((health, instanceName) => {
        if (health.status === 'ONLINE') {
            healthy.push(instanceName);
        }
    });
    return healthy;
}

function getHealthyInstancesExcept(excludeInstance) {
    return getHealthyInstances().filter(instance => instance !== excludeInstance);
}

// ============ ORQUESTRAÇÃO DE FUNIS ============
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
    
    // ✅ NOVA LÓGICA: Detectar primeira mensagem
    const isFirstMessage = conversation.stepIndex === 0;
    
    const idempotencyKey = 'SEND:' + remoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
    if (checkIdempotency(idempotencyKey)) {
        addLog('STEP_DUPLICATE', 'Passo duplicado ignorado: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
        return;
    }
    
    addLog('STEP_SEND', 'Enviando passo ' + conversation.stepIndex + ' do funil ' + conversation.funnelId, { 
        step,
        isFirstMessage 
    });
    
    // DELAY ANTES (se configurado)
    if (step.delayBefore && step.delayBefore > 0) {
        addLog('STEP_DELAY', 'Aguardando ' + step.delayBefore + 's antes do passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, step.delayBefore * 1000));
    }
    
    // MOSTRAR DIGITANDO (se configurado)
    if (step.showTyping) {
        await sendTypingIndicator(remoteJid);
    }
    
    let result = { success: true };
    
    // PROCESSAR TIPO DO PASSO
    if (step.type === 'delay') {
        // Passo de delay puro
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', 'Executando delay de ' + delaySeconds + 's no passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        
    } else if (step.type === 'typing') {
        // Passo de digitando puro
        const typingSeconds = step.typingSeconds || 3;
        addLog('STEP_TYPING', 'Mostrando digitando por ' + typingSeconds + 's no passo ' + conversation.stepIndex);
        await sendTypingIndicator(remoteJid, typingSeconds);
        
    } else {
        // ✅ ENVIO COM HEALTH CHECK INTELIGENTE
        result = await sendWithFallback(remoteJid, step.type, step.text, step.mediaUrl, isFirstMessage);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        // ✅ CORREÇÃO CRÍTICA: Verificar waitForReply corretamente
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            // Aguardar resposta em mensagens normais
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
            
            // ✅ IMPORTANTE: Salvar estado antes de aguardar resposta
            conversations.set(remoteJid, conversation);
        } else {
            // ✅ CORREÇÃO: Avançar automaticamente quando waitForReply é false
            addLog('STEP_AUTO_ADVANCE', 'Passo ' + conversation.stepIndex + ' avançando automaticamente', { 
                funnelId: conversation.funnelId, 
                waitForReply: step.waitForReply,
                stepType: step.type
            });
            
            // Salvar estado atual antes de avançar
            conversations.set(remoteJid, conversation);
            
            // Avançar automaticamente para o próximo passo
            await advanceConversation(remoteJid, null, 'auto');
        }
        
        addLog('STEP_SUCCESS', 'Passo executado com sucesso: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
    } else {
        addLog('STEP_FAILED', 'Falha no envio do passo: ' + result.error, { conversation });
    }
}

// Enviar indicador de digitação
async function sendTypingIndicator(remoteJid, durationSeconds = 3) {
    const instanceName = stickyInstances.get(remoteJid) || getHealthyInstances()[0] || INSTANCES[0];
    
    try {
        // Iniciar digitação
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'composing'
        });
        
        addLog('TYPING_START', 'Iniciando digitação para ' + remoteJid + ' por ' + durationSeconds + 's');
        
        // Aguardar o tempo especificado
        await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
        
        // Parar digitação
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
    
    // ✅ LOGS DETALHADOS para debug
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
        
        // ✅ Marcar conversa como finalizada mas manter no registro
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(remoteJid, conversation);
        return;
    }
    
    // ✅ Atualizar conversa
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
    
    // ✅ Enviar próximo passo
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
            const pixTimeout = pixTimeouts.get(remoteJid);
            if (pixTimeout) {
                clearTimeout(pixTimeout.timeout);
                pixTimeouts.delete(remoteJid);
                addLog('PIX_TIMEOUT_CANCELED', 'Timeout cancelado para ' + remoteJid, { orderCode });
            }
            
            funnelId = productType === 'FAB' ? 'FAB_APROVADA' : 'CS_APROVADA';
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
        } else if (isPix) {
            funnelId = productType === 'FAB' ? 'FAB_PIX' : 'CS_PIX';
            
            const existingTimeout = pixTimeouts.get(remoteJid);
            if (existingTimeout) {
                clearTimeout(existingTimeout.timeout);
            }
            
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
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

// ✅ CORREÇÃO 1: STICKY INSTANCE - Webhook corrigido para usar busca sem mover
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
            
            // ✅ CORREÇÃO 1: STICKY INSTANCE - Usar busca sem mover
            const conversationData = findConversationByPhone(incomingPhone);
            
            if (conversationData && conversationData.conversation.waiting_for_response) {
                const conversation = conversationData.conversation;
                const actualRemoteJid = conversationData.key; // ✅ Usar a chave ORIGINAL da conversa
                
                const idempotencyKey = 'REPLY:' + actualRemoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
                if (checkIdempotency(idempotencyKey)) {
                    addLog('WEBHOOK_DUPLICATE_REPLY', 'Resposta duplicada ignorada', { remoteJid: actualRemoteJid });
                    return res.json({ success: true, message: 'Resposta duplicada' });
                }
                
                addLog('CLIENT_REPLY', 'Resposta recebida e processada', { 
                    originalRemoteJid: remoteJid,
                    actualRemoteJid: actualRemoteJid,
                    text: messageText.substring(0, 100),
                    step: conversation.stepIndex,
                    funnelId: conversation.funnelId
                });
                
                // ✅ CORREÇÃO CRÍTICA: Usar a chave original da conversa (mantém sticky instance)
                await advanceConversation(actualRemoteJid, messageText, 'reply');
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

// ✅ NOVO: Endpoint de monitoramento de instâncias
app.get('/api/health', (req, res) => {
    const healthData = {};
    
    instanceHealth.forEach((health, instanceName) => {
        const stats = instanceStats.get(instanceName);
        
        healthData[instanceName] = {
            ...health,
            stats: {
                conversationsCount: stats.conversationsCount,
                messagesThisHour: stats.messagesThisHour,
                averageResponseTime: stats.averageResponseTime,
                successRate: health.totalRequests > 0 ? 
                    ((health.successfulRequests / health.totalRequests) * 100).toFixed(2) + '%' : 'N/A'
            }
        };
    });
    
    const systemOverview = {
        totalInstances: INSTANCES.length,
        onlineInstances: getHealthyInstances().length,
        offlineInstances: INSTANCES.length - getHealthyInstances().length,
        totalConversations: conversations.size,
        healthCheckActive: healthCheckActive,
        lastHealthCheck: Math.max(...Array.from(instanceHealth.values()).map(h => h.lastCheck ? h.lastCheck.getTime() : 0))
    };
    
    res.json({
        success: true,
        system: systemOverview,
        instances: healthData,
        timestamp: new Date().toISOString()
    });
});

// ✅ NOVO: Endpoint de alertas do sistema
app.get('/api/alerts', (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const unacknowledgedOnly = req.query.unacknowledged === 'true';
    
    let alerts = systemAlerts;
    
    if (unacknowledgedOnly) {
        alerts = alerts.filter(alert => !alert.acknowledged);
    }
    
    res.json({
        success: true,
        data: alerts.slice(0, limit),
        total: alerts.length,
        unacknowledged: systemAlerts.filter(a => !a.acknowledged).length
    });
});

// ✅ NOVO: Endpoint para reconhecer alertas
app.post('/api/alerts/:id/acknowledge', (req, res) => {
    const alertId = req.params.id;
    const alert = systemAlerts.find(a => a.id === alertId);
    
    if (alert) {
        alert.acknowledged = true;
        alert.acknowledgedAt = new Date();
        addLog('ALERT_ACKNOWLEDGED', `Alerta reconhecido: ${alert.title}`);
        res.json({ success: true, message: 'Alerta reconhecido' });
    } else {
        res.status(404).json({ success: false, error: 'Alerta não encontrado' });
    }
});

// ✅ NOVO: Endpoint para controlar health check
app.post('/api/health/toggle', (req, res) => {
    const { action } = req.body; // 'start' ou 'stop'
    
    if (action === 'start' && !healthCheckActive) {
        startHealthCheckSystem();
        res.json({ success: true, message: 'Health check iniciado', active: true });
    } else if (action === 'stop' && healthCheckActive) {
        stopHealthCheckSystem();
        res.json({ success: true, message: 'Health check parado', active: false });
    } else {
        res.json({ 
            success: true, 
            message: 'Nenhuma ação necessária', 
            active: healthCheckActive 
        });
    }
});

// Dashboard - estatísticas principais com distribuição de instâncias
app.get('/api/dashboard', (req, res) => {
    // Contar uso por instância
    const instanceUsage = {};
    const healthyInstancesCount = getHealthyInstances().length;
    
    INSTANCES.forEach(inst => {
        const health = instanceHealth.get(inst);
        const stats = instanceStats.get(inst);
        instanceUsage[inst] = {
            conversations: stats.conversationsCount,
            status: health.status,
            responseTime: health.responseTime
        };
    });
    
    // Calcular próxima instância na fila
    const nextInstanceIndex = instanceRoundRobin % INSTANCES.length;
    const nextInstance = INSTANCES[nextInstanceIndex];
    
    const stats = {
        active_conversations: conversations.size,
        pending_pix: pixTimeouts.size,
        total_funnels: funis.size,
        total_instances: INSTANCES.length,
        healthy_instances: healthyInstancesCount,
        offline_instances: INSTANCES.length - healthyInstancesCount,
        sticky_instances: stickyInstances.size,
        round_robin_counter: instanceRoundRobin,
        next_instance_in_queue: nextInstance,
        instance_distribution: instanceUsage,
        unacknowledged_alerts: systemAlerts.filter(a => !a.acknowledged).length,
        health_check_active: healthCheckActive
    };
    
    res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
    });
});

// Funis - CRUD completo
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
    
    // Salvar imediatamente no arquivo
    saveFunnelsToFile();
    
    res.json({ 
        success: true, 
        message: 'Funil salvo com sucesso',
        data: funnel
    });
});

app.delete('/api/funnels/:id', (req, res) => {
    const { id } = req.params;
    
    // Proteger funis padrão
    if (id.includes('_APROVADA') || id.includes('_PIX')) {
        return res.status(400).json({ 
            success: false, 
            error: 'Não é possível excluir funis padrão' 
        });
    }
    
    if (funis.has(id)) {
        funis.delete(id);
        addLog('FUNNEL_DELETED', 'Funil excluído: ' + id);
        
        // Salvar imediatamente no arquivo
        saveFunnelsToFile();
        
        res.json({ success: true, message: 'Funil excluído com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
});

// ✅ CORREÇÃO 3: EXPORT/IMPORT - Novos endpoints
app.get('/api/funnels/export', (req, res) => {
    try {
        const funnelsArray = Array.from(funis.values());
        const exportData = {
            version: '1.0',
            exportDate: new Date().toISOString(),
            totalFunnels: funnelsArray.length,
            funnels: funnelsArray
        };
        
        addLog('FUNNEL_EXPORT', 'Exportando ' + funnelsArray.length + ' funis');
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=kirvano-funnels-' + 
                     new Date().toISOString().split('T')[0] + '.json');
        
        res.json(exportData);
        
    } catch (error) {
        addLog('FUNNEL_EXPORT_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/funnels/import', (req, res) => {
    try {
        const importData = req.body;
        
        if (!importData.funnels || !Array.isArray(importData.funnels)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Formato de arquivo inválido' 
            });
        }
        
        let imported = 0;
        let skipped = 0;
        let errors = [];
        
        importData.funnels.forEach(funnel => {
            try {
                if (!funnel.id || !funnel.name || !funnel.steps) {
                    errors.push('Funil inválido: ' + (funnel.id || 'sem ID'));
                    return;
                }
                
                // Verificar se já existe (para evitar sobrescrever acidentalmente)
                if (funis.has(funnel.id)) {
                    skipped++;
                    addLog('FUNNEL_IMPORT_SKIP', 'Funil já existe: ' + funnel.id);
                } else {
                    funis.set(funnel.id, funnel);
                    imported++;
                    addLog('FUNNEL_IMPORT_SUCCESS', 'Funil importado: ' + funnel.id);
                }
            } catch (error) {
                errors.push('Erro ao importar ' + (funnel.id || 'funil') + ': ' + error.message);
            }
        });
        
        // Salvar no arquivo
        if (imported > 0) {
            saveFunnelsToFile();
        }
        
        addLog('FUNNEL_IMPORT_COMPLETE', `Importação concluída: ${imported} importados, ${skipped} ignorados, ${errors.length} erros`);
        
        res.json({
            success: true,
            message: 'Importação concluída',
            imported: imported,
            skipped: skipped,
            errors: errors
        });
        
    } catch (error) {
        addLog('FUNNEL_IMPORT_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Conversas/Envios
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
        stickyInstance: stickyInstances.get(remoteJid),
        instanceHealth: instanceHealth.get(stickyInstances.get(remoteJid))?.status
    }));
    
    // Ordenar por mais recente primeiro
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
        success: true,
        data: conversationsList
    });
});

// Logs recentes
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

// Debug da Evolution API
app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY.length,
        instances: INSTANCES,
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        round_robin_counter: instanceRoundRobin,
        health_check_active: healthCheckActive,
        test_results: []
    };
    
    // Testar conexão com primeiro endpoint
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
            validateStatus: () => true // Aceitar qualquer status para debug
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

// ============ SERVIR FRONTEND ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicialização - carregar dados persistidos
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

// ============ INICIALIZAÇÃO ============
app.listen(PORT, async () => {
    console.log('='.repeat(80));
    console.log('🚀 KIRVANO SYSTEM - SISTEMA AVANÇADO DE MONITORAMENTO');
    console.log('='.repeat(80));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('API Key configurada:', EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI');
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('🏥 SISTEMA DE HEALTH CHECK:');
    console.log('  ✅ Monitoramento automático a cada', HEALTH_CHECK_INTERVAL/1000, 'segundos');
    console.log('  ✅ Detecção de falhas após', MAX_CONSECUTIVE_FAILURES, 'tentativas');  
    console.log('  ✅ Migração automática de conversas');
    console.log('  ✅ Recovery automático quando instâncias voltam');
    console.log('  ✅ Dashboard visual em tempo real');
    console.log('  ✅ Sistema de alertas integrado');
    console.log('');
    console.log('🔧 FUNCIONALIDADES AVANÇADAS:');
    console.log('  ✅ Circuit Breaker Pattern');
    console.log('  ✅ Health Check inteligente');
    console.log('  ✅ Migração automática de conversas');
    console.log('  ✅ Sticky Instance mantida (corrigido)');
    console.log('  ✅ Suporte completo a áudio (corrigido)');
    console.log('  ✅ Export/Import de funis (corrigido)');
    console.log('  ✅ Distribuição inteligente por saúde');
    console.log('  ✅ Alertas em tempo real');
    console.log('  ✅ Estatísticas detalhadas');
    console.log('');
    console.log('📡 API Endpoints NOVOS:');
    console.log('  GET  /api/health              - Status detalhado das instâncias');
    console.log('  GET  /api/alerts              - Alertas do sistema');
    console.log('  POST /api/alerts/:id/acknowledge - Reconhecer alerta');
    console.log('  POST /api/health/toggle       - Controlar health check');
    console.log('');
    console.log('📡 API Endpoints EXISTENTES:');
    console.log('  GET  /api/dashboard           - Dashboard com health status');
    console.log('  GET  /api/funnels             - Listar funis');
    console.log('  POST /api/funnels             - Criar/editar funil');
    console.log('  GET  /api/funnels/export      - Exportar funis');
    console.log('  POST /api/funnels/import      - Importar funis');
    console.log('  GET  /api/conversations       - Conversas (com health status)');
    console.log('  GET  /api/logs                - Logs recentes');
    console.log('  POST /api/send-test           - Teste de envio');
    console.log('  GET  /api/debug/evolution     - Debug Evolution API');
    console.log('');
    console.log('📨 Webhooks:');
    console.log('  POST /webhook/kirvano         - Eventos Kirvano');
    console.log('  POST /webhook/evolution       - Eventos Evolution');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('🧪 Testes: http://localhost:' + PORT + '/test.html');
    console.log('='.repeat(80));
    
    // Carregar dados persistidos
    await initializeData();
    
    // ✅ INICIALIZAR SISTEMA DE HEALTH CHECK
    console.log('🏥 Iniciando sistema de monitoramento...');
    startHealthCheckSystem();
});
