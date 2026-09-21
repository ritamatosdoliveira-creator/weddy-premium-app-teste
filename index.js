/**
 * Weddy — Lembretes automáticos de RSVP (Cloud Function)
 * ========================================================
 *
 * O QUE ISTO FAZ
 * Corre uma vez por dia (agendado) e, para cada convidado com um link de
 * RSVP gerado que AINDA não respondeu (nem "sim" nem "não"), verifica se
 * está a 7, 3 ou 1 dia(s) do prazo definido pelo casal (rsvpDeadline) e,
 * se tiver um email guardado, envia-lhe um email de lembrete simpático com
 * o link para responder. Cada convidado recebe no máximo 3 lembretes.
 *
 * O QUE ISTO NÃO FAZ (limitações importantes, por favor lê)
 * - Só consegue enviar um lembrete a quem tiver um EMAIL guardado. A app
 *   Weddy (index.html) já tem um campo opcional "Email para lembretes
 *   automáticos" em Definições → Convites RSVP, mas o casal tem de o
 *   preencher manualmente por convidado — a app nunca inventa nem
 *   adivinha emails.
 * - Não manda SMS, WhatsApp nem notificações push — só email, através de
 *   um servidor SMTP que tens de configurar (ver abaixo).
 * - Não substitui o link individual de cada convidado — o lembrete é só
 *   um empurrãozinho a apontar para o mesmo link que já existia.
 *
 * PRÉ-REQUISITOS PARA ISTO FUNCIONAR
 * 1) O projeto Firebase (weddy-premium-teste, ou o de produção quando
 *    decidires promover isto) tem de estar no plano Blaze (pay-as-you-go).
 *    Cloud Functions agendadas (pubsub/scheduler) não funcionam no plano
 *    gratuito Spark, mesmo que o custo real fique a zero ou perto disso.
 * 2) Um servidor SMTP para enviar os emails — pode ser uma conta Gmail
 *    com "palavra-passe de aplicação", um serviço como SendGrid, Mailgun,
 *    Amazon SES, etc. Isto tem de ser configurado por ti (ver "Configurar
 *    o SMTP" abaixo) — eu não consigo criar nem gerir essa conta.
 *
 * COMO INSTALAR (passo a passo)
 * 1) Se ainda não tiveres a pasta "functions" no teu projeto:
 *      firebase init functions
 *    (escolhe JavaScript, o projeto weddy-premium-teste, e quando
 *    perguntar se instala dependências, diz que sim)
 * 2) Copia este ficheiro (index.js) e o package.json para dentro dessa
 *    pasta "functions", substituindo o que lá estiver.
 * 3) Dentro da pasta functions, corre:
 *      npm install
 * 4) Configura o SMTP (ver secção abaixo).
 * 5) Faz deploy:
 *      firebase deploy --only functions:sendRsvpReminders
 *
 * CONFIGURAR O SMTP (exemplo com Gmail)
 * Cria uma "palavra-passe de aplicação" na tua conta Google (Definições
 * da conta Google → Segurança → Verificação em 2 passos → Palavras-passe
 * de aplicação). Depois, na pasta functions, cria um ficheiro chamado
 * ".env.weddy-premium-teste" (ajusta ao nome exato do teu projeto) com:
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_USER=oteuemail@gmail.com
 *   SMTP_PASS=a-palavra-passe-de-aplicacao-de-16-letras
 *   SMTP_FROM="Weddy <oteuemail@gmail.com>"
 *
 * (Qualquer outro fornecedor SMTP funciona da mesma forma — só muda o
 * SMTP_HOST/SMTP_PORT.) Este ficheiro NUNCA deve ser enviado para um
 * repositório público — junta-o ao .gitignore.
 *
 * TESTAR SEM ESPERAR PELO AGENDAMENTO
 * Depois do deploy, podes forçar uma execução imediata a partir da
 * Google Cloud Console → Cloud Scheduler → encontra o job
 * "firebase-schedule-sendRsvpReminders-..." → "Executar agora". Ou usa
 * o emulador local (firebase emulators:start) para testar sem gastar
 * nada nem mandar emails a sério (troca o transporter por um "stream"
 * de teste do nodemailer enquanto testas).
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

// Lidos de variáveis de ambiente (.env.<project-id> — ver instruções acima).
const SMTP_HOST = defineString('SMTP_HOST');
const SMTP_PORT = defineString('SMTP_PORT', { default: '465' });
const SMTP_USER = defineString('SMTP_USER');
const SMTP_PASS = defineString('SMTP_PASS');
const SMTP_FROM = defineString('SMTP_FROM');
// Só é preciso se ligares o classificador de IA (ver classifyWeddyIntent,
// mais abaixo) — não tem nada a ver com os lembretes de RSVP acima.
const GEMINI_API_KEY = defineString('GEMINI_API_KEY', { default: '' });

const RSVP_BASE_URL = 'https://ritamatosdoliveira-creator.github.io/weddy-premium-app-teste/rsvp.html';

// Dias antes do prazo em que se tenta um lembrete (ajusta à vontade).
const REMINDER_DAYS_BEFORE = [7, 3, 1];
// Nunca manda mais do que isto à mesma pessoa, mesmo que o prazo demore.
const MAX_REMINDERS = 3;

function buildTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port: Number(SMTP_PORT.value()) || 465,
    secure: Number(SMTP_PORT.value()) !== 587, // 465 = SSL direto, 587 = STARTTLS
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() },
  });
}

function reminderEmailHtml({ guestName, coupleName1, coupleName2, deadline, link, daysLeft }) {
  const prazoTxt = deadline ? `até ${deadline}` : 'brevemente';
  const diasTxt = daysLeft === 0 ? 'hoje' : daysLeft === 1 ? 'amanhã' : `daqui a ${daysLeft} dias`;
  return `
  <div style="font-family:Georgia,serif; max-width:480px; margin:0 auto; color:#3a3330;">
    <p>Olá ${guestName || ''},</p>
    <p>É só um lembrete simpático de ${coupleName1 || ''} & ${coupleName2 || ''} — o prazo para confirmares presença no casamento termina ${prazoTxt} (${diasTxt}).</p>
    <p><a href="${link}" style="display:inline-block; padding:12px 22px; background:#a8503a; color:#fff; text-decoration:none; border-radius:10px; font-weight:bold;">Responder agora</a></p>
    <p style="font-size:12px; color:#8a7d75;">Se o botão não funcionar, copia este link: ${link}</p>
  </div>`;
}

async function sendReminderEmail(transporter, job) {
  const html = reminderEmailHtml({
    guestName: job.name,
    coupleName1: job.data.coupleName1,
    coupleName2: job.data.coupleName2,
    deadline: job.data.rsvpDeadline,
    link: RSVP_BASE_URL + '?g=' + job.docId,
    daysLeft: job.daysLeft,
  });
  await transporter.sendMail({
    from: SMTP_FROM.value(),
    to: job.email,
    subject: `Lembrete: confirma a tua presença — ${job.data.coupleName1 || ''} & ${job.data.coupleName2 || ''}`,
    html,
  });
}

// Corre todos os dias às 09:00 (hora de Lisboa). Ajusta a expressão cron
// se quiseres outra hora/frequência.
exports.sendRsvpReminders = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'Europe/Lisbon', region: 'europe-west1' },
  async () => {
    const snap = await db.collection('guests').get();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const jobs = [];

    snap.forEach((doc) => {
      const data = doc.data();
      if (!data.rsvpDeadline) return;
      const deadline = new Date(data.rsvpDeadline + 'T00:00:00');
      const daysLeft = Math.ceil((deadline - today) / 86400000);
      if (daysLeft < 0 || !REMINDER_DAYS_BEFORE.includes(daysLeft)) return;

      if (data.isFamily) {
        const members = Array.isArray(data.members) ? data.members : [];
        const responses = data.responses || {};
        const emails = data.emails || {};
        const reminders = data.reminders || {};
        members.forEach((m) => {
          const r = responses[m.guestId];
          const answered = r && (r.attending === true || r.attending === false);
          if (answered) return;
          const email = emails[m.guestId];
          if (!email) return;
          const rem = reminders[m.guestId] || { remindersSent: 0, lastReminderDay: null };
          if ((rem.remindersSent || 0) >= MAX_REMINDERS) return;
          if (rem.lastReminderDay === daysLeft) return;
          jobs.push({ docId: doc.id, isFamily: true, memberId: m.guestId, name: m.name, email, daysLeft, data });
        });
      } else {
        const answered = data.attending === true || data.attending === false;
        if (answered) return;
        const email = data.email;
        if (!email) return;
        if ((data.remindersSent || 0) >= MAX_REMINDERS) return;
        if (data.lastReminderDay === daysLeft) return;
        jobs.push({ docId: doc.id, isFamily: false, name: data.name, email, daysLeft, data });
      }
    });

    if (!jobs.length) {
      logger.info('Lembretes de RSVP: nada para enviar hoje.');
      return;
    }

    const transporter = buildTransporter();
    let sent = 0;
    for (const job of jobs) {
      try {
        await sendReminderEmail(transporter, job);
        if (job.isFamily) {
          await db.collection('guests').doc(job.docId).update({
            [`reminders.${job.memberId}.remindersSent`]: admin.firestore.FieldValue.increment(1),
            [`reminders.${job.memberId}.lastReminderDay`]: job.daysLeft,
            [`reminders.${job.memberId}.lastReminderAt`]: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          await db.collection('guests').doc(job.docId).update({
            remindersSent: admin.firestore.FieldValue.increment(1),
            lastReminderDay: job.daysLeft,
            lastReminderAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        sent++;
      } catch (err) {
        logger.error(`Erro ao enviar lembrete para ${job.email} (convite ${job.docId}):`, err);
      }
    }
    logger.info(`Lembretes de RSVP: ${sent}/${jobs.length} enviados com sucesso.`);
  }
);

/**
 * ========================================================
 * classifyWeddyIntent — classificador de intenção por IA (Fase 3B.1)
 * ========================================================
 *
 * O QUE ISTO FAZ
 * O Weddy Concierge (rsvp.html) e o Assistente Weddy (index.html) já
 * respondem a tudo por regras (regex/keywords) sobre os dados reais do
 * casamento — isso não muda aqui. Esta função só entra quando essas
 * regras NÃO reconhecem a mensagem: recebe o texto da pergunta e devolve
 * qual das intenções já existentes melhor a descreve (ex: "GET_VENUE",
 * "CONFIRM_ATTENDANCE"), usando o Gemini só para essa classificação.
 *
 * A IA NUNCA vê os dados do casamento (nem os recebe, nem os pode
 * inventar) e NUNCA escreve a resposta final — isso continua a ser
 * sempre feito no frontend, a partir do WeddyActions, com os dados reais.
 * Esta função também não escreve nada no Firestore por si própria.
 *
 * PERMISSÕES — "guest" só pode receber intenções da lista de convidado,
 * "couple" só as do lado dos noivos, e isso NUNCA depende do que o
 * cliente diz que é: só é tratado como "couple" quem chamar esta função
 * com uma sessão Firebase Auth válida (o rsvp.html nunca faz login, por
 * isso um convidado não consegue fingir ser o casal só mudando o valor
 * enviado no pedido). A própria lista de intenções permitidas (enviada ao
 * Gemini como "enum" no schema da resposta) é outra camada da mesma
 * proteção: o modelo não consegue devolver uma intenção fora da lista.
 *
 * PRÉ-REQUISITOS PARA ISTO FUNCIONAR
 * 1) Uma API key da Gemini API (aistudio.google.com/apikey — conta
 *    Google gratuita chega para começar, mas o uso em produção pode ter
 *    custo; consulta os preços atuais na própria consola).
 * 2) A mesma pasta "functions" e o mesmo ficheiro ".env.<project-id>" que
 *    já usas para os lembretes de RSVP (ver topo deste ficheiro) — não é
 *    preciso nenhum projeto Firebase novo nem nenhuma função separada.
 *
 * COMO INSTALAR
 * 1) Cria a tua API key em aistudio.google.com/apikey.
 * 2) No ficheiro ".env.weddy-premium-teste" dentro de "functions/" (o
 *    mesmo do SMTP), acrescenta uma linha nova:
 *      GEMINI_API_KEY=a-tua-chave-aqui
 *    Nunca coloques esta chave em nenhum ficheiro do frontend
 *    (index.html/rsvp.html) — só aqui, no backend.
 * 3) Deploy:
 *      firebase deploy --only functions:classifyWeddyIntent
 *
 * SEM CHAVE CONFIGURADA
 * A função devolve sempre { intent: "UNKNOWN" } sem tentar chamar o
 * Gemini — o Concierge/Assistente continuam a funcionar exatamente como
 * hoje, só sem a segunda opinião da IA para perguntas fora das regex.
 *
 * CUSTO
 * Cada chamada desta função consome a tua quota/faturação da Gemini API
 * (fora do controlo da Firebase) — não há, por agora, nenhum limite de
 * chamadas por casal/dia aqui dentro. Se um dia quiseres um limite,
 * dá para acrescentar um contador simples no Firestore antes da chamada
 * ao Gemini (pergunta-me quando quiseres isso).
 */

// Modelo do Gemini a usar — muda aqui se quiseres experimentar outro
// (confirma sempre o nome exato/disponibilidade na consola do Gemini,
// já que isto muda com alguma frequência).
const GEMINI_MODEL = 'gemini-2.0-flash';

// Intenções que o CONVIDADO (rsvp.html / Weddy Concierge) pode pedir.
// Tem de bater certo com WEDDY_INTENTS em clone-app/rsvp.html.
const GUEST_INTENTS = [
  'GET_VENUE', 'GET_SCHEDULE', 'GET_DRESS_CODE', 'GET_PARKING', 'GET_TRANSPORT',
  'GET_ACCOMMODATION', 'GET_GIFTS', 'GET_CONTACT', 'GET_FAQ', 'GET_TABLE', 'GET_RSVP',
  'ASK_CHILDREN', 'CONFIRM_ATTENDANCE', 'DECLINE_ATTENDANCE', 'SET_RSVP_UNDECIDED',
  'ADD_COMPANION', 'SET_DIETARY_RESTRICTION',
];
// Intenções que os NOIVOS (index.html / Assistente Weddy) podem pedir.
// Tem de bater certo com WEDDY_COPILOT_INTENTS em clone-app/index.html.
const COUPLE_INTENTS = [
  'CREATE_TASK', 'GET_UPCOMING_TASKS', 'GET_PENDING_RSVPS', 'GET_DIETARY_LIST',
  'GET_REMAINING_PAYMENTS', 'GET_RSVP_INFO', 'GET_GUEST_COUNT', 'GET_BUDGET',
  'GET_COUNTDOWN', 'GET_TABLE_COUNT', 'SEARCH_DOCUMENTS',
];

function buildClassifyPrompt(question, allowedIntents) {
  return [
    'Classificas mensagens de um chat de casamento numa de várias intenções pré-definidas.',
    'Nunca respondes à pergunta nem inventas informação sobre nenhum casamento — só decides qual das intenções abaixo melhor descreve a mensagem.',
    'Intenções possíveis: ' + allowedIntents.join(', ') + ', UNKNOWN.',
    'Se nenhuma intenção corresponder claramente, usa UNKNOWN.',
    'Se a intenção envolver um valor extraído da própria mensagem (por exemplo, uma restrição alimentar dita pela pessoa, ou o texto de uma tarefa a criar), inclui-o em "value", tal como a pessoa escreveu, sem reformular nem resumir. Caso contrário, não incluas "value".',
    `Mensagem: "${String(question).replace(/"/g, '\\"').slice(0, 500)}"`,
  ].join('\n');
}

async function callGemini(question, allowedIntents) {
  const key = GEMINI_API_KEY.value();
  if (!key) return { intent: 'UNKNOWN' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildClassifyPrompt(question, allowedIntents) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          intent: { type: 'STRING', enum: [...allowedIntents, 'UNKNOWN'] },
          value: { type: 'STRING' },
        },
        required: ['intent'],
      },
      temperature: 0,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini respondeu ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = await res.json();
  const text = json.candidates && json.candidates[0] && json.candidates[0].content
    && json.candidates[0].content.parts && json.candidates[0].content.parts[0]
    && json.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Resposta vazia do Gemini.');
  const parsed = JSON.parse(text);
  // Nunca confiar cegamente no que voltou, mesmo com responseSchema —
  // é a validação final antes de devolver ao frontend.
  if (!parsed || typeof parsed.intent !== 'string' || !allowedIntents.includes(parsed.intent)) {
    return { intent: 'UNKNOWN' };
  }
  const out = { intent: parsed.intent };
  if (typeof parsed.value === 'string' && parsed.value.trim()) {
    out.value = parsed.value.trim().slice(0, 200);
  }
  return out;
}

exports.classifyWeddyIntent = onCall({ region: 'europe-west1' }, async (request) => {
  const question = request.data && request.data.question;
  const requestedRole = request.data && request.data.role;
  if (!question || typeof question !== 'string' || !question.trim() || question.length > 500) {
    throw new HttpsError('invalid-argument', 'Pergunta em falta, vazia ou demasiado longa.');
  }

  // O papel nunca vem só do que o cliente diz: só é tratado como "couple"
  // quem tiver mesmo uma sessão Firebase Auth válida neste pedido — o
  // rsvp.html (lado do convidado) nunca inicia sessão, por isso não há
  // forma de um convidado se fazer passar pelo casal só mudando "role".
  const isCouple = !!request.auth && requestedRole === 'couple';
  const allowedIntents = isCouple ? COUPLE_INTENTS : GUEST_INTENTS;

  try {
    return await callGemini(question.trim(), allowedIntents);
  } catch (err) {
    logger.error('Erro a chamar o Gemini em classifyWeddyIntent:', err);
    // Nunca propaga o erro ao frontend como falha — do ponto de vista de
    // quem está a conversar, "não percebi" é sempre uma resposta válida,
    // e o Concierge/Assistente já sabem cair na resposta genérica quando
    // recebem UNKNOWN.
    return { intent: 'UNKNOWN' };
  }
});
