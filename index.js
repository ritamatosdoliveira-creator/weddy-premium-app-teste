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
