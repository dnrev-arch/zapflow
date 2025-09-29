// ============================================
// KIRVANO - SISTEMA DE FUNIS WHATSAPP
// VERSÃO CORRIGIDA - Áudio PTT + Indicadores
// ============================================

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';

// ✅ INSTÂNCIAS - Configure suas instâncias aqui
const INSTANCES = process.env.INSTANCES 
    ? process.env.INSTANCES.split(',') 
    : ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D10'];

// ============ ESTRUTURA DE DADOS ============
let funis = new Map();
let conversations = new Map();
let pixTimeouts = new Map();
let stickyInstances = new Map();
let instanceRoundRobin = 0;
let logs = [];

const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const DATA_DIR = path.join(__dirname, 'data');
const FUNNELS_FILE = path.join(DATA_DIR, 'funnels.json');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');

app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============

function addLog(type, message, data = null, showInConsole = true) {
    const log = {
        timestamp: new Date(),
        type,
        message,
        data
    };
    logs.push(log);
    if (logs.length > 500) logs.shift();
    
    if (showInConsole) {
        console.log(`[${log.timestamp.toISOString()}] ${type}: ${message}`);
        if (data) console.log('  Data:', data);
    }
}

// ============ PERSISTÊNCIA ============

async function initializeData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        // Carregar funis
        try {
            const funnelsData = await fs.readFile(FUNNELS_FILE, 'utf8');
            const parsed = JSON.parse(funnelsData);
            funis = new Map(Object.entries(parsed));
            addLog('SYSTEM', `${funis.size} funis carregados`);
        } catch (err) {
            addLog('WARNING', 'Nenhum funil encontrado, usando padrão', null, true);
            await loadDefaultFunnels();
        }
        
        // Carregar conversas
        try {
            const convsData = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
            const parsed = JSON.parse(convsData);
            conversations = new Map(Object.entries(parsed));
            addLog('SYSTEM', `${conversations.size} conversas carregadas`);
        } catch (err) {
            addLog('INFO', 'Nenhuma conversa salva encontrada');
        }
    } catch (error) {
        addLog('ERROR', 'Erro ao inicializar dados', error);
    }
}

async function loadDefaultFunnels() {
    // ✅ FUNIS PADRÃO CORRIGIDOS - CS_APROVADA COMPLETO
    const defaultFunnels = {
        'CS_APROVADA': {
            id: 'CS_APROVADA',
            name: 'CS - Compra Aprovada',
            steps: [
                {
                    id: 'step_1',
                    type: 'text',
                    text: 'Oiie Amor, Tudo bem? Aqui é a Gabriela da equipe do GRUPINHO DAS CASADAS! Posso te colocar no Grupo e mandar o seu acesso VIP? 😍',
                    waitForReply: true
                },
                {
                    id: 'step_2',
                    type: 'video+text',
                    text: 'Seu ACESSO VIP está pronto! 😍\n\nPra acessar é bem simples, Clique no link abaixo 👇🏻\n\nhttps://acesso.vipmembros.com/\n\nE entre usando seu e-mail de compra.\n\nLá dentro você vai encontrar o acesso ao Grupo, fotos, vídeos e todo o conteúdo exclusivo só pros VIPs liberados pra você! 🔥\n\nCorre lá, que as mulheres do grupo estão te esperando... ❤️',
                    mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/08/WhatsApp-Video-2025-08-21-at-12.27.34-2.mp4',
                    waitForReply: true
                },
                {
                    id: 'step_3',
                    type: 'delay',
                    delaySeconds: 780,
                    waitForReply: false
                },
                {
                    id: 'step_4',
                    type: 'text',
                    text: 'Conseguiu amor? ❤️',
                    waitForReply: true
                },
                {
                    id: 'step_5',
                    type: 'text',
                    text: 'Se não tiver entrado no grupinho grátis, clica aqui que a Marina te coloca agora la dentro 👇🏻\n\nhttps://t.me/Marina_Talbot',
                    waitForReply: true,
                    delayBefore: 12
                },
                {
                    id: 'step_6',
                    type: 'delay',
                    delaySeconds: 220,
                    waitForReply: false
                },
                {
                    id: 'step_7',
                    type: 'image+text',
                    text: 'Eii, deixa eu te falar... A Fabiane está a 2km de você! *Ela é casada* e gostou muito de você e pediu pra te mandar o Zap dela agora... So clicar no Link pra falar diretamente com ela pelo APP 👇🏻\n\nhttps://app.vipchats.com.br/fab1',
                    mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/06/PHOTO-2025-05-13-14-33-32-2.jpg',
                    waitForReply: false,
                    delayBefore: 10
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
                    text: '😍 Aqui é a Gaby, te chamei pra te colocar no grupinho das casadas Posso te colocar lá agora?',
                    mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2024/07/OI-MEU-LINDO.mp3',
                    waitForReply: true
                },
                {
                    id: 'step_2',
                    type: 'image+text',
                    text: 'Acabei de ver no sistema que você gerou o Pix mas ainda não pagou…Por isso não posso te colocar ainda...\n\nVou te envir o Link para você finalizar o pagamento e entra no grupinho que estão esperando você 👇🏻\n\nhttps://e-volutionn.com/grupinho1/',
                    mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/09/Design-sem-nome-9.png',
                    waitForReply: false,
                    showTyping: true,
                    delayBefore: 8
                },
                {
                    id: 'step_3',
                    type: 'audio',
                    text: 'Assim que finalizar só me enviar comprovante que te coloco no grupo 😘',
                    mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2024/07/pagar-e-receber-conteudo.mp3',
                    waitForReply: true
                },
                {
                    id: 'step_4',
                    type: 'delay',
                    delaySeconds: 590,
                    waitForReply: false
                },
                {
                    id: 'step_5',
                    type: 'image+text',
                    text: 'Amor vi que ainda não pagou o valor..\n\nMas como as meninas do grupo gostaram de você vamos te liberar acesso ao nosso APLICATIVO VIP E A UM GRUPINHO GRÁTIS\n\nSó clicar no link abaixo e entrar 👇🏻\n\nhttps://acesso.vipmembros.com/\n\nSe depois quiser entrar no GRUPINHO VIP DAS CASADAS é só me chamar  😘',
                    mediaUrl: 'https://e-volutionn.com/wp-content/uploads/2025/09/IMG_8451.jpg',
                    waitForReply: true
                },
                {
                    id: 'step_6',
                    type: 'delay',
                    delaySeconds: 450,
                    waitForReply: false
                },
                {
                    id: 'step_7',
                    type: 'text',
                    text: 'Conseguiu amor? 🥰',
                    waitForReply: true
                },
                {
                    id: 'step_8',
                    type: 'text',
                    text: 'Se não tiver entrado no grupinho grátis, clica aqui que a Marina te coloca agora la dentro 👇🏻\n\nhttps://t.me/Marina_Talbot',
                    waitForReply: false,
                    delayBefore: 9
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
                    type: 'text',
                    text: 'Seu PIX FAB foi gerado! Aguardamos o pagamento para iniciar sua transformação.',
                    waitForReply: true
                }
            ]
        }
    };
    
    funis = new Map(Object.entries(defaultFunnels));
    await saveFunnels();
    addLog('SYSTEM', 'Funis padrão carregados e salvos');
}

async function saveFunnels() {
    try {
        const data = Object.fromEntries(funis);
        await fs.writeFile(FUNNELS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        addLog('ERROR', 'Erro ao salvar funis', error);
    }
}

async function saveConversations() {
    try {
        const data = Object.fromEntries(conversations);
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        addLog('ERROR', 'Erro ao salvar conversas', error);
    }
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

// ✅ CORREÇÃO CRÍTICA: INDICADORES DE PRESENÇA
async function sendPresenceUpdate(remoteJid, presence, instanceName, duration = 3) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        presence: presence, // 'composing' (digitando) ou 'recording' (gravando áudio)
        delay: duration * 1000
    };
    
    addLog('PRESENCE_UPDATE', `Enviando presença: ${presence} por ${duration}s`, { remoteJid, instanceName });
    
    return await sendToEvolution(instanceName, '/chat/sendPresence', payload);
}

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

// ✅ CORREÇÃO CRÍTICA: ÁUDIO COMO PTT (Push to Talk - Mensagem de Voz)
async function sendAudio(remoteJid, audioUrl, caption, clientMessageId, instanceName) {
    // Envia o texto ANTES se houver
    if (caption && caption.trim()) {
        await sendText(remoteJid, caption, clientMessageId, instanceName);
        await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    // ✅ SOLUÇÃO: Usar endpoint específico de áudio PTT para parecer mensagem gravada
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        audio: audioUrl,  // ✅ Usar 'audio' ao invés de 'media' + 'mediatype'
        encoding: true    // ✅ Forçar encoding como PTT (mensagem de voz)
    };
    
    addLog('AUDIO_PTT_SEND', `Enviando áudio PTT${caption ? ' com texto' : ''}`, { 
        remoteJid, 
        audioUrl,
        hasCaption: !!caption,
        instanceName 
    });
    
    // ✅ Usar endpoint específico de áudio WhatsApp (PTT)
    return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', payload);
}

// ============ ENVIO COM FALLBACK ============

async function sendWithFallback(remoteJid, type, text, mediaUrl, instanceName) {
    const clientMessageId = uuidv4();
    
    try {
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
            // ✅ CORREÇÃO: Passar o texto para aparecer com o áudio
            result = await sendAudio(remoteJid, mediaUrl, text, clientMessageId, instanceName);
        }
        
        if (result && result.ok) {
            addLog('SEND_SUCCESS', `Mensagem ${type} enviada via ${instanceName}`);
            return { success: true, instance: instanceName };
        }
        
        return { success: false, error: result?.error };
        
    } catch (error) {
        addLog('SEND_ERROR', `Falha ao enviar: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ============ LÓGICA DO FUNIL ============

async function startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice) {
    // Verificar sticky instance
    let instanceName = stickyInstances.get(remoteJid);
    
    if (!instanceName) {
        // Round-robin para nova conversa
        const primaryInstanceIndex = instanceRoundRobin % INSTANCES.length;
        instanceName = INSTANCES[primaryInstanceIndex];
        instanceRoundRobin++;
        stickyInstances.set(remoteJid, instanceName);
        addLog('INSTANCE_ASSIGNED', `Nova conversa atribuída a ${instanceName}`);
    } else {
        addLog('STICKY_INSTANCE', `Usando sticky instance ${instanceName}`);
    }
    
    const conversation = {
        remoteJid,
        funnelId,
        stepIndex: 0,
        orderCode,
        customerName,
        productType,
        totalPrice,
        instanceName,  // ✅ Salvar a instância na conversa
        waiting_for_response: false,
        lastSystemMessage: new Date(),
        createdAt: new Date()
    };
    
    conversations.set(remoteJid, conversation);
    await saveConversations();
    
    addLog('FUNNEL_START', `Iniciando funil ${funnelId} para ${customerName}`, { orderCode, instanceName });
    
    await sendStep(remoteJid);
}

async function sendStep(remoteJid) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) {
        addLog('ERROR', 'Conversa não encontrada', { remoteJid });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('ERROR', 'Funil não encontrado', { funnelId: conversation.funnelId });
        return;
    }
    
    if (conversation.stepIndex >= funnel.steps.length) {
        addLog('FUNNEL_COMPLETE', `Funil ${conversation.funnelId} completo para ${conversation.customerName}`);
        conversations.delete(remoteJid);
        await saveConversations();
        return;
    }
    
    const step = funnel.steps[conversation.stepIndex];
    const instanceName = conversation.instanceName;  // ✅ Usar sempre a mesma instância
    
    addLog('STEP_SEND', `Enviando passo ${conversation.stepIndex + 1}/${funnel.steps.length} do funil ${conversation.funnelId}`, {
        stepType: step.type,
        instanceName
    });
    
    // ✅ CORREÇÃO CRÍTICA: DELAY ANTES (Converter para número e garantir funcionamento)
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `⏱️  Aguardando ${delaySeconds}s antes do passo...`, null, true);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    // ✅ CORREÇÃO CRÍTICA: INDICADOR DE PRESENÇA (Digitando/Gravando)
    if (step.showTyping) {
        const presenceType = step.type === 'audio' ? 'recording' : 'composing';
        const presenceDuration = step.type === 'audio' ? 5 : 3; // Áudio grava por mais tempo
        
        addLog('PRESENCE_INDICATOR', `📝 Mostrando "${presenceType}" por ${presenceDuration}s...`, null, true);
        
        // Enviar indicador de presença
        await sendPresenceUpdate(remoteJid, presenceType, instanceName, presenceDuration);
        
        // Aguardar o tempo do indicador
        await new Promise(resolve => setTimeout(resolve, presenceDuration * 1000));
    }
    
    let result = { success: true };
    
    // Processar tipo do passo
    if (step.type === 'delay') {
        const delaySeconds = parseInt(step.delaySeconds) || 10;
        addLog('STEP_DELAY_PURE', `⏱️  Executando delay puro de ${delaySeconds}s...`, null, true);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        
    } else if (step.type === 'typing') {
        const typingSeconds = parseInt(step.typingSeconds) || 3;
        addLog('STEP_TYPING_PURE', `📝 Mostrando digitando puro por ${typingSeconds}s...`, null, true);
        await sendPresenceUpdate(remoteJid, 'composing', instanceName, typingSeconds);
        await new Promise(resolve => setTimeout(resolve, typingSeconds * 1000));
        
    } else {
        // ✅ Enviar mensagem usando a instância sticky
        result = await sendWithFallback(remoteJid, step.type, step.text, step.mediaUrl, instanceName);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
            conversation.waiting_for_response = true;
            addLog('STEP_WAITING', `⏸️  Aguardando resposta do cliente no passo ${conversation.stepIndex + 1}`, null, true);
            
            if (step.timeoutMinutes) {
                setTimeout(() => {
                    handleStepTimeout(remoteJid, conversation.stepIndex);
                }, step.timeoutMinutes * 60 * 1000);
            }
            
            conversations.set(remoteJid, conversation);
            await saveConversations();
        } else {
            conversation.stepIndex++;
            conversation.waiting_for_response = false;
            conversations.set(remoteJid, conversation);
            await saveConversations();
            
            // Pequeno delay entre steps automáticos
            setTimeout(() => sendStep(remoteJid), 1000);
        }
    } else {
        addLog('ERROR', 'Falha ao enviar passo', { step: conversation.stepIndex, error: result.error });
    }
}

async function handleStepTimeout(remoteJid, stepIndex) {
    const conversation = conversations.get(remoteJid);
    if (!conversation || conversation.stepIndex !== stepIndex) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[stepIndex];
    if (!step.nextOnTimeout) {
        conversation.stepIndex++;
    } else {
        conversation.stepIndex = step.nextOnTimeout;
    }
    
    conversation.waiting_for_response = false;
    conversations.set(remoteJid, conversation);
    await saveConversations();
    
    await sendStep(remoteJid);
}

// ============ WEBHOOKS ============

app.post('/webhook/kirvano', async (req, res) => {
    try {
        addLog('KIRVANO_WEBHOOK', 'Webhook recebido', req.body);
        
        const data = req.body;
        const event = data.event;
        const status = data.status;
        const orderCode = data.sale_id || data.checkout_id;
        const customerName = data.customer?.name;
        const customerPhone = data.customer?.phone_number;
        const productType = data.products?.[0]?.offer_name || 'CS';
        const totalPrice = data.fiscal?.total_value || data.total_price;
        
        if (!customerPhone) {
            return res.json({ success: false, error: 'Telefone não encontrado' });
        }
        
        const remoteJid = customerPhone.replace(/\D/g, '') + '@s.whatsapp.net';
        
        const isApproved = event === 'SALE_APPROVED' && status === 'APPROVED';
        const isPix = event === 'PIX_GENERATED';
        
        if (isApproved) {
            const existingTimeout = pixTimeouts.get(remoteJid);
            if (existingTimeout) {
                clearTimeout(existingTimeout.timeout);
                pixTimeouts.delete(remoteJid);
            }
            
            const funnelId = productType === 'FAB' ? 'FAB_APROVADA' : 'CS_APROVADA';
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
        } else if (isPix) {
            const funnelId = productType === 'FAB' ? 'FAB_PIX' : 'CS_PIX';
            
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
        
        res.json({ success: true, message: 'Processado' });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.status(200).json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        
        if (fromMe) {
            return res.status(200).json({ success: true, message: 'Mensagem do sistema' });
        }
        
        const conversation = conversations.get(remoteJid);
        if (!conversation || !conversation.waiting_for_response) {
            return res.status(200).json({ success: true, message: 'Nenhuma ação necessária' });
        }
        
        addLog('CLIENT_REPLY', `Cliente respondeu no passo ${conversation.stepIndex + 1}`);
        
        const funnel = funis.get(conversation.funnelId);
        const step = funnel.steps[conversation.stepIndex];
        
        if (step.nextOnReply !== undefined) {
            conversation.stepIndex = step.nextOnReply;
        } else {
            conversation.stepIndex++;
        }
        
        conversation.waiting_for_response = false;
        conversations.set(remoteJid, conversation);
        await saveConversations();
        
        setTimeout(() => sendStep(remoteJid), 1000);
        
        res.json({ success: true, message: 'Resposta processada' });
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

app.get('/api/funnels', (req, res) => {
    const funnelsArray = Array.from(funis.values());
    res.json({ success: true, data: funnelsArray });
});

app.get('/api/funnels/:id', (req, res) => {
    const funnel = funis.get(req.params.id);
    if (!funnel) {
        return res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
    res.json({ success: true, data: funnel });
});

app.put('/api/funnels/:id', async (req, res) => {
    try {
        const funnel = req.body;
        funis.set(req.params.id, funnel);
        await saveFunnels();
        res.json({ success: true, data: funnel });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/conversations', (req, res) => {
    const convsArray = Array.from(conversations.values());
    res.json({ success: true, data: convsArray });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json({ success: true, data: logs.slice(-limit) });
});

app.post('/api/funnels/export', (req, res) => {
    const data = Object.fromEntries(funis);
    res.json({ success: true, data });
});

app.post('/api/funnels/import', async (req, res) => {
    try {
        const imported = req.body;
        funis = new Map(Object.entries(imported));
        await saveFunnels();
        res.json({ success: true, message: `${funis.size} funis importados` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ INICIALIZAÇÃO ============

app.listen(PORT, async () => {
    console.log(`\n${'='.repeat(80)}`);
    console.log('🚀 KIRVANO - SISTEMA DE FUNIS WHATSAPP - TOTALMENTE CORRIGIDO');
    console.log(`${'='.repeat(80)}`);
    console.log(`📡 Porta: ${PORT}`);
    console.log(`🔗 Evolution: ${EVOLUTION_BASE_URL}`);
    console.log(`📱 Instâncias: ${INSTANCES.length} configuradas`);
    console.log(`\n✅ CORREÇÕES CRÍTICAS APLICADAS:\n`);
    console.log(`  🎙️  Áudio enviado como PTT (mensagem de voz gravada)`);
    console.log(`  📝 Indicador "digitando" funciona corretamente`);
    console.log(`  🎤 Indicador "gravando áudio" funciona corretamente`);
    console.log(`  ⏱️  Delays respeitados antes de cada mensagem`);
    console.log(`  📌 Sticky instance mantém lead na mesma instância`);
    console.log(`  📨 Texto + Áudio enviados juntos naturalmente`);
    console.log(`  ✅ CS_APROVADA completo com 7 steps`);
    console.log(`  ✅ CS_PIX completo com 8 steps`);
    console.log(`\n📚 Endpoints da Evolution API usados:\n`);
    console.log(`  - /message/sendText - Mensagens de texto`);
    console.log(`  - /message/sendMedia - Imagens e vídeos`);
    console.log(`  - /message/sendWhatsAppAudio - Áudio PTT (voz gravada) ✅`);
    console.log(`  - /chat/sendPresence - Indicadores (digitando/gravando) ✅`);
    console.log(`${'='.repeat(80)}\n`);
    
    await initializeData();
});
