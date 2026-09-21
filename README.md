# Weddy — Lembretes automáticos de RSVP (Cloud Function)

Este é o backend que faltava para a Fase 1 do roadmap (item "Reminders"):
uma Cloud Function agendada que, todos os dias, verifica quem ainda não
respondeu ao RSVP e está perto do prazo, e manda-lhe um email de lembrete
com o link para responder.

**Isto só funciona depois de fazeres o deploy tu mesmo** — eu não consigo
implantar Cloud Functions a partir deste ambiente (não tenho credenciais
da Firebase CLI nem acesso à faturação do projeto). Os passos abaixo são
tudo o que é preciso.

## O que precisas de ter antes de começar

1. **Plano Blaze no Firebase** (pay-as-you-go). Cloud Functions agendadas
   não correm no plano gratuito Spark. Na prática, para um casamento, o
   custo real deste tipo de função costuma ficar a zero ou a cêntimos —
   mas o projeto tem de estar no Blaze para a função sequer poder existir.
   Muda isto em: Consola Firebase → weddy-premium-teste → Upgrade.
2. **Uma conta de email para enviar os lembretes** (SMTP). Pode ser uma
   conta Gmail normal com "palavra-passe de aplicação", ou um serviço como
   SendGrid/Mailgun/Amazon SES. Não crio nem giro esta conta por ti.
3. **Firebase CLI instalada** no teu computador (`npm install -g
   firebase-tools`) e sessão iniciada (`firebase login`).

## Passo a passo

1. Se ainda não tiveres uma pasta `functions/` no projeto:
   ```
   firebase init functions
   ```
   Escolhe JavaScript, o projeto `weddy-premium-teste`, e diz que sim a
   instalar as dependências.

2. Copia `index.js` e `package.json` (os dois ficheiros ao lado deste
   README) para dentro dessa pasta `functions/`, substituindo o que lá
   estiver.

3. Dentro de `functions/`:
   ```
   npm install
   ```

4. Configura o SMTP — cria um ficheiro `functions/.env.weddy-premium-teste`
   (o sufixo tem de ser exatamente o ID do projeto) com:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=oteuemail@gmail.com
   SMTP_PASS=a-tua-palavra-passe-de-aplicacao
   SMTP_FROM="Weddy <oteuemail@gmail.com>"
   ```
   **Nunca** envies este ficheiro para um repositório público — junta-o ao
   `.gitignore`.

5. Deploy:
   ```
   firebase deploy --only functions:sendRsvpReminders
   ```

6. Para testar sem esperar pelo agendamento diário: Consola Google Cloud →
   Cloud Scheduler → job `firebase-schedule-sendRsvpReminders-...` →
   "Executar agora".

## Antes de ativar isto a sério: verifica as regras do Firestore

As regras de segurança da coleção `guests` que já tens definidas no
projeto podem estar a restringir explicitamente que campos um convidado
(sem sessão iniciada) pode escrever no próprio documento, e que campos o
casal (dono autenticado) pode escrever ao criar/gerir convites. Com o
RSVP de família e os lembretes automáticos, os documentos `guests/{token}`
passam a poder ter também:

- `isFamily`, `members`, `responses` (mapa por pessoa) — em vez dos
  campos `attending`/`meal`/... diretamente no topo, só quando é um
  convite de família.
- `email` (convite individual) ou `emails` (mapa por pessoa, convite de
  família) — escrito pelo casal, nunca pelo convidado.
- `remindersSent`/`lastReminderDay`/`lastReminderAt`, ou o equivalente em
  `reminders.{memberId}.*` para família — escrito só pela própria Cloud
  Function (que usa o Admin SDK e por isso nunca passa pelas regras de
  segurança, ao contrário da app e do rsvp.html).

Confirma na Consola Firebase → Firestore Database → Regras que a escrita
de `responses`/`isFamily`/`members` pelo lado do convidado (sem sessão) e
de `email`/`emails` pelo lado do casal continuam permitidas antes de
divulgares links de RSVP de família a sério. Se preferires, posso rever o
conteúdo atual das tuas regras e sugerir o ajuste exato — basta colares
aqui o ficheiro `firestore.rules` que tens neste momento.

## Limitações importantes (para não haver surpresas)

- **Só envia email, a quem tiver um email guardado.** A app já tem um
  campo opcional "Email para lembretes automáticos" em Definições →
  Convites RSVP, mas o casal tem de o preencher à mão por convidado — a
  app nunca inventa nem adivinha emails, e sem isso a função não tem para
  onde mandar nada.
- **Sem SMS, WhatsApp ou notificações push** — só email.
- **Máximo de 3 lembretes por pessoa**, enviados a 7, 3 e 1 dia(s) do
  prazo (ajustável no topo do `index.js`, constantes
  `REMINDER_DAYS_BEFORE` e `MAX_REMINDERS`).
- Continua a valer tudo o resto sobre isolamento de dados: a função só
  lê/escreve a coleção `guests` (nunca a lista completa de convidados nem
  o orçamento), e corre só contra o Firestore do projeto
  `weddy-premium-teste` — nunca toca em `weddy-app-bd12f`.
