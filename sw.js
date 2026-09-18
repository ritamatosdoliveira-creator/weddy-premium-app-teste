const CACHE_NAME = 'weddy-v64';
const FILES_TO_CACHE = ['./','./index.html','./manifest.json','./icon-180.png','./icon-192.png','./icon-512.png','./login-bg.jpg','./logo-happybox.png','./logo-dgpublicidade.png','./logo-jtestudios.png','./logo-quintasantoandre.png'];
const EXTERNAL_FILES_TO_CACHE = [
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js'
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Os ficheiros da própria app são obrigatórios: se algum destes falhar,
      // faz sentido a instalação da atualização falhar mesmo (algo está mal).
      // Mas um recurso EXTERNO (ex: o CDN que gera o Excel) pode estar
      // temporariamente em baixo, bloqueado, ou instável na rede da pessoa —
      // isso NUNCA deve impedir o resto da app de atualizar. Por isso tenta
      // cada um à parte, sem deixar uma falha travar tudo o resto.
      return cache.addAll(FILES_TO_CACHE).then(() =>
        Promise.allSettled(EXTERNAL_FILES_TO_CACHE.map(url => cache.add(url).catch(()=>{})))
      );
    })
  );
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  if (!url.startsWith('http')) return;
  // CRÍTICO: nunca intercetar pedidos ao Firebase/Google — isto inclui a
  // ligação em tempo real ao Firestore (onSnapshot), autenticação, etc.
  // Um pedido desses guardado em cache por engano podia fazer a app "ouvir"
  // uma versão antiga/vazia dos dados em vez da ligação real, e isso podia
  // levar a gravar esse estado vazio por cima dos dados verdadeiros. Estes
  // pedidos vão SEMPRE diretos à rede, nunca passam pela cache.
  const isGoogleOrFirebase = /(^|\.)googleapis\.com$|(^|\.)firebaseio\.com$|(^|\.)gstatic\.com$|(^|\.)google\.com$|(^|\.)firebaseapp\.com$/.test(new URL(url).hostname);
  if (isGoogleOrFirebase) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(()=>{});
      return response;
    }).catch(() => cached))
  );
});
