const CACHE_NAME = 'gs1-scanner-cache-v1';
// Lista de archivos esenciales para el funcionamiento offline básico
const urlsToCache = [
  '/', // La página principal
  '/index.html',
  '/scanner.js',
  '/style.css',
  '/libs/html5-qrcode.min.js', // Asegúrate que la ruta sea correcta
  '/manifest.json',
  '/icons/icon-192x192.png', // Incluye los iconos
  '/icons/icon-512x512.png'
  // Puedes añadir más recursos si los usas (imágenes, fuentes, etc.)
];

// Evento 'install': Se dispara cuando el SW se instala por primera vez.
self.addEventListener('install', event => {
  console.log('Service Worker: Instalando...');
  // Espera hasta que el cache esté listo.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Cache abierto, añadiendo archivos principales.');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('Service Worker: Archivos principales cacheados.');
        // Forzar la activación inmediata del nuevo SW (útil durante desarrollo)
        // En producción, podrías querer esperar a que el usuario cierre todas las pestañas.
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('Service Worker: Falló el cacheo inicial', error);
      })
  );
});

// Evento 'activate': Se dispara después de 'install' y cuando el SW toma control.
// Es un buen lugar para limpiar caches antiguas.
self.addEventListener('activate', event => {
  console.log('Service Worker: Activado.');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Borrando cache antiguo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
        // Tomar control inmediato de las páginas abiertas
        console.log('Service Worker: Reclamando clientes...');
        return self.clients.claim();
    })
  );
});


// Evento 'fetch': Se dispara cada vez que la página pide un recurso (HTML, CSS, JS, img...).
self.addEventListener('fetch', event => {
  // Estrategia: Cache First (Intenta servir desde el cache, si no, va a la red)
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Si el recurso está en el cache, lo devuelve.
        if (response) {
          // console.log('Service Worker: Sirviendo desde cache:', event.request.url);
          return response;
        }

        // Si no está en el cache, intenta obtenerlo de la red.
        // console.log('Service Worker: Buscando en red:', event.request.url);
        return fetch(event.request).then(
          networkResponse => {
            // Si la respuesta de red es válida, la clona y la guarda en el cache para futuras peticiones.
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
              return networkResponse; // Devuelve la respuesta aunque no sea 'cacheable'
            }

            // Clonar la respuesta porque tanto el cache como el navegador la necesitan.
            // El stream de la respuesta solo se puede consumir una vez.
            const responseToCache = networkResponse.clone();

            caches.open(CACHE_NAME)
              .then(cache => {
                // console.log('Service Worker: Cacheando nuevo recurso:', event.request.url);
                cache.put(event.request, responseToCache);
              });

            return networkResponse; // Devuelve la respuesta original al navegador.
          }
        ).catch(error => {
            // Si falla la red y no está en cache, podría devolver una página offline genérica
            console.error('Service Worker: Fetch fallido para', event.request.url, error);
            // return caches.match('/offline.html'); // Necesitarías crear offline.html y cachearlo
        });
      })
  );
});
