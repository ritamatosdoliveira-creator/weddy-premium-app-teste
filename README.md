# Weddy — Cloud Functions (lembretes de RSVP + classificador de IA)

Este ficheiro cobre as duas Cloud Functions que vivem no mesmo `index.js`:

1. **`sendRsvpReminders`** — lembretes automáticos de RSVP por email (Fase 1
   do roadmap). Corre sozinha, todos os dias.
2. **`classifyWeddyIntent`** — o classificador de intenção por IA (Fase
   3B.1) usado pelo Weddy Concierge e pelo Assistente Weddy só quando as
   regex locais não reconhecem uma mensagem. Ver a secção própria mais
   abaixo — é opcional e independente da primeira.

**Isto só funciona depois de fazeres o deploy tu mesmo** — eu não consigo
implantar Cloud Functions a partir deste ambiente (não tenho credenciais
da Firebase CLI nem acesso à faturação do projeto, nem a nenhuma chave de
API de IA). Os passos abaixo são tudo o que é preciso.

As duas funções podem ser implantadas juntas ou em separado
(`firebase deploy --only functions:sendRsvpReminders,functions:classifyWeddyIntent`,
ou só uma de cada vez) — usam o mesmo ficheiro `.env.<project-id>` para as
suas respetivas variáveis, mas não dependem uma da outra.

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

---

## Ligar o classificador de IA — `classifyWeddyIntent` (Fase 3B.1)

Isto é **opcional**. Sem isto configurado, o Weddy Concierge e o
Assistente Weddy continuam a funcionar exatamente como hoje — só por
regras — e simplesmente respondem com a mensagem genérica de "não
percebi" quando uma pergunta não bate com nenhuma regra.

### O que esta função faz e não faz

- Recebe só o **texto** de uma pergunta que as regex locais não
  reconheceram, e devolve qual de uma lista fixa de intenções (ex:
  `GET_VENUE`, `CONFIRM_ATTENDANCE`) melhor a descreve.
- **Nunca** recebe os dados do casamento, **nunca** inventa uma resposta,
  e **nunca** escreve nada no Firestore (fora do próprio contador de
  utilização — ver "Custo e limites" abaixo). A resposta final ao
  convidado ou ao casal continua sempre a vir do `WeddyActions` no
  frontend, com os dados reais — a IA só ajuda a "apontar" para a
  intenção certa.
- Separa automaticamente o que um **convidado** pode pedir (Weddy
  Concierge) do que só os **noivos** podem pedir (Assistente Weddy) — e
  isto não depende do que o pedido diz que é: só é tratado como "noivos"
  quem chamar a função com uma sessão Firebase Auth válida.
- **(Fase 3B.5)** O `weddingId` usado para o limite de utilização nunca é
  aceite diretamente do frontend — é sempre derivado no servidor: para os
  noivos, a partir do email da sessão Firebase Auth (procurando o
  casamento cujo `ownerEmails` contém esse email); para o convidado, a
  partir do `guestToken` do seu próprio link de RSVP (lendo o campo
  `weddingId` do documento `guests/{guestToken}`). Ninguém consegue gastar
  ou "emprestar" quota de utilização de um casamento que não é o seu.

### O que precisas de ter antes de começar

1. **Plano Blaze no Firebase**, tal como para os lembretes de RSVP acima
   (uma Cloud Function chamar uma API externa como a da OpenAI exige
   sempre o plano Blaze, independentemente de ser agendada ou não).
2. **Uma API key da OpenAI, com faturação ativa** — cria uma em
   [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
   Ao contrário do Gemini, a OpenAI normalmente não tem nível gratuito
   contínuo — vais precisar de associar um cartão à tua conta OpenAI.
   Confirma o nome exato e o preço atual do modelo (`gpt-5.6-luna` neste
   ficheiro, ou o que puseres na constante `OPENAI_MODEL`) na própria
   consola antes de usar isto a sério — o uso é faturado à tua conta
   OpenAI, não à Anthropic nem a mim.

### Passo a passo

1. Se ainda não tiveres a pasta `functions/` com o `sendRsvpReminders` já
   configurado, segue primeiro os passos 1–3 da secção anterior deste
   README.
2. No mesmo ficheiro `functions/.env.weddy-premium-teste` que já usas
   para o SMTP, acrescenta uma linha nova:
   ```
   OPENAI_API_KEY=a-tua-chave-aqui
   ```
   **Nunca** coloques esta chave em `index.html`, `rsvp.html`, nem em
   nenhum outro ficheiro do frontend — só aqui, no backend. E, tal como o
   ficheiro do SMTP, este ficheiro nunca deve ir para um repositório
   público. (Se já tinhas configurado a versão anterior com Gemini, podes
   apagar a linha `GEMINI_API_KEY=...` — já não é usada.)
3. Deploy:
   ```
   firebase deploy --only functions:classifyWeddyIntent
   ```
4. Confirma que `index.html` e `rsvp.html` já incluem o script
   `firebase-functions-compat.js` (já vem incluído se estiveres a usar a
   versão mais recente destes ficheiros) e que a região no frontend
   (`WEDDY_FUNCTIONS_REGION`, no início do `<script>` de cada um) continua
   `'europe-west1'` — tem de bater sempre certo com a região do deploy
   acima.

### Testar

Abre o Assistente Weddy (ou o Weddy Concierge num link de convidado) e faz
uma pergunta que sabes não bater com nenhuma regra — por exemplo "acho que
me esqueci de alguma coisa, o que me falta tratar esta semana?" ou algo
fora do guião. Se a IA estiver bem configurada, deves ver uma breve
mensagem "A pensar…" antes da resposta. Para depurar sem gastar chamadas à
API, usa o emulador local (`firebase emulators:start`) e olha para os
logs da função no terminal.

Nota sobre o modelo: `gpt-5.6-luna` e a Responses API da OpenAI usados
neste ficheiro são posteriores ao que eu consigo verificar diretamente
daqui (não tenho acesso à documentação viva da OpenAI nem forma de testar
uma chamada real a partir deste ambiente). Antes do primeiro deploy a
sério, vale a pena confirmares na consola/documentação da OpenAI que o
nome do modelo e o formato do pedido (`/v1/responses` com
`text.format.type: "json_schema"`) ainda batem certo — se algo tiver
mudado, diz-me o que a documentação atual mostra e eu ajusto o código.

### Custo e limites

Cada chamada (que não seja bloqueada pelo limite abaixo) consome a tua
quota/faturação da OpenAI API — isto é completamente independente do
preço do Firebase.

Por decisão tua, esta função tem agora um **limite diário de chamadas por
casamento**: a constante `AI_DAILY_LIMIT_PER_WEDDING` no topo do
`index.js` (60 por omissão, ajustável à vontade). O contador vive na
coleção `aiUsage` do Firestore (um documento por `weddingId`) e reinicia
à meia-noite UTC. Ao atingir o limite num dia, a função passa a devolver
`{ intent: "UNKNOWN" }` sem chamar a OpenAI — o Concierge/Assistente
caem na resposta genérica de sempre, sem erro nem crash.

Isto continua a ser uma proteção de **custo**, não de acesso a dados — a
função nunca leu nem escreveu dados do casamento, com ou sem limite. Mas
desde a Fase 3B.5 o `weddingId` usado para contar já não é um valor que o
frontend possa inventar: é sempre derivado no servidor (ver secção
acima), por isso um casamento já não consegue consumir ou distorcer a
quota de outro.

## Estado da Fase 3B (para acompanhares o que falta)

| Etapa | O quê | Estado |
|---|---|---|
| 3B.0 | Fornecedor/configuração (Gemini → OpenAI) | ✅ feito |
| 3B.1 | `AIService` + Cloud Function `classifyWeddyIntent` | ✅ feito |
| 3B.2 | Saída estruturada (`json_schema`) + validação server-side | ✅ feito |
| 3B.3 | Limite diário de chamadas por casamento | ✅ feito |
| 3B.4 | Teste real contra a API da OpenAI | 🔜 **por fazer — só tu consegues fazer isto** |
| 3B.5 | `weddingId` derivado da sessão/guestToken, nunca do cliente | ✅ feito |
| 3B.6 | Deploy de produção | 🔜 depois do 3B.4 |

**Sobre a 3B.4 — preciso de ser direto:** não consigo fazer chamadas de
rede a APIs externas como a da OpenAI a partir deste ambiente (o acesso à
rede daqui está limitado a um conjunto fixo de sites, e mesmo que não
estivesse, não tenho nem posso pedir a tua API key). Isto não é algo que
eu vá conseguir "verificar por ti" mais tarde — é um passo que só tu
consegues dar, depois do deploy. A lista de testes que sugeriste (pergunta
normal, pergunta `UNKNOWN`, uma `read`, uma tentativa de `write`, o
limite de 60, e wedding A não conseguir influenciar wedding B) é a lista
certa — mas se quiseres, faço uma coisa complementar: escrevo-te um
guião passo a passo com exatamente o que escrever no chat do Concierge/
Assistente para cada um desses casos, e o que deves ver em cada um, para
tornares esse teste manual mais rápido e sistemático. Diz-me se queres
isso.
