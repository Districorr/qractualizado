// ==================================================================
//                      Variables Globales
// ==================================================================
let scanner; // Instancia del lector de códigos (no usada directamente ahora)
let currentCameraId = null; // ID de la cámara activa
let html5QrCode = null; // Instancia principal de la librería Html5Qrcode
let audioContext = null; // Contexto para reproducir sonidos
let autoClearTimeout = null; // Referencia al timeout para auto-limpieza

// ==================================================================
//                 Referencias a Elementos del DOM
// ==================================================================
const cameraSelector = document.getElementById('camera-selector');
const scannerPreview = document.getElementById('scanner-preview');
const cameraStatus = document.getElementById('camera-status');
const statusElement = document.getElementById('status');
const proveedorAutoElement = document.getElementById('proveedor-auto');
const resultadoElement = document.getElementById('resultado');
const capturaContainer = document.getElementById('captura-container');
const tabs = document.querySelectorAll('.tab');
const sections = document.querySelectorAll('.section');
const darkModeToggle = document.querySelector('.dark-mode-toggle');
const copyButton = document.getElementById('copy-button');
const clearButton = document.getElementById('clear-button');
const soundToggle = document.getElementById('sound-toggle');
const autoClearToggle = document.getElementById('auto-clear-toggle');
const gs1FieldsContainer = document.getElementById('gs1-fields');

// ==================================================================
//                      Constantes y Mapeos GS1
// ==================================================================
const FNC1 = '\u001d'; // Caracter Separador de Grupo GS1 (GS)

// Mapeo básico de AIs a descripciones (expandir según necesidad)
const gs1AIDescriptions = {
    '00': 'SSCC', '01': 'GTIN', '02': 'GTIN Contenido', '10': 'Lote',
    '11': 'Fecha Producción', '13': 'Fecha Empaquetado', '15': 'Fecha Cons. Pref.',
    '17': 'Fecha Caducidad', '21': 'Número de Serie', '240': 'ID Artículo Adicional',
    '241': 'ID Cliente', '30': 'Cantidad Variable', '37': 'Cantidad (Unidades)',
    '310': 'Peso Neto (kg)', '392': 'Precio Pagar (Variable)', '393': 'Precio Pagar (ISO)',
    '400': 'Nº Pedido Cliente', '410': 'Expedido a (GLN)', '414': 'GLN Localización',
    '8005': 'Precio Unidad', '90': 'Info. Mutua Acordada',
    // Añade más AIs según necesites
};

// ==================================================================
//                      Funciones de Parseo GS1
// ==================================================================

/**
 * Obtiene una descripción legible para un Identificador de Aplicación (AI) GS1.
 * @param {string} ai - El Identificador de Aplicación (ej: '01', '10', '3103').
 * @returns {string} La descripción o 'Desconocido'.
 */
function getGS1Description(ai) {
    if (gs1AIDescriptions[ai]) return gs1AIDescriptions[ai];
    // Manejo simple para AIs con 'n' (decimales/longitud)
    if (/^310\d$/.test(ai)) return `Peso Neto (kg) - ${ai[3]} dec`;
    if (/^392\d$/.test(ai)) return `Precio Pagar (Var) - ${ai[3]} dec`;
    if (/^393\d$/.test(ai)) return `Precio Pagar (ISO) - ${ai[3]} dec`;
    return 'Desconocido';
}

/**
 * Formatea una fecha GS1 (YYMMDD) a DD/MM/YYYY y verifica si está expirada.
 * @param {string} yyMMdd - La fecha en formato YYMMDD.
 * @returns {object} Objeto con { formatted: string, isExpired: boolean|null, dateObj: Date|null }.
 */
function formatGS1Date(yyMMdd) {
    if (!/^\d{6}$/.test(yyMMdd)) return { formatted: yyMMdd, isExpired: null, dateObj: null };

    const year = parseInt(yyMMdd.substring(0, 2), 10);
    const month = parseInt(yyMMdd.substring(2, 4), 10);
    const day = parseInt(yyMMdd.substring(4, 6), 10);
    // Asume siglo 21. Ajustar si se manejan fechas fuera de 2000-2099.
    // Una lógica más robusta podría comparar con el año actual para decidir el siglo.
    const currentYearLastTwoDigits = new Date().getFullYear() % 100;
    const fullYear = year <= (currentYearLastTwoDigits + 10) ? 2000 + year : 1900 + year; // Heurística simple

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return { formatted: `${yyMMdd} (Fecha inválida)`, isExpired: null, dateObj: null };
    }
    try {
        const dateObj = new Date(Date.UTC(fullYear, month - 1, day));
        // Verificar si el objeto Date creado es válido (evita días inválidos como 31 de Feb)
        if (dateObj.getUTCFullYear() !== fullYear || dateObj.getUTCMonth() !== month - 1 || dateObj.getUTCDate() !== day) {
             return { formatted: `${yyMMdd} (Fecha inválida)`, isExpired: null, dateObj: null };
        }

        const today = new Date();
        const todayMidnightUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

        const isExpired = dateObj < todayMidnightUTC;
        const formattedDate = `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${fullYear}`;
        const status = isExpired ? ' (¡Vencido!)' : '';

        return { formatted: `${formattedDate}${status}`, isExpired: isExpired, dateObj: dateObj };
    } catch (e) {
        console.error("Error parsing date:", e);
        return { formatted: `${yyMMdd} (Error fecha)`, isExpired: null, dateObj: null };
    }
}

/**
 * Parsea una cadena de datos GS1 (con o sin FNC1) en un objeto de AI/Valor.
 * @param {string} data - La cadena de datos escaneada.
 * @returns {object} Un objeto donde las claves son los AIs y los valores son sus datos.
 */
function parseGS1Data(data) {
    const parsed = {};
    if (!data) return parsed;

    // Tabla de longitudes fijas conocidas (simplificada, expandir según sea necesario)
    const fixedLengthAIs = {
        '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6,
        '410': 13, '414': 13, '8005': 6
        // ... añadir más AIs de longitud fija
    };
    // AIs conocidos de longitud variable (simplificado, expandir)
    const variableLengthAIs = ['10', '21', '90', '240', '241', '400']; // Añadir más

    let remainingData = data;
    let currentIndex = 0;

    while (currentIndex < remainingData.length) {
        let foundAI = false;
        // Intentar identificar AI (priorizar 4, luego 3, luego 2 dígitos)
        for (let len = 4; len >= 2; len--) {
            const potentialAI = remainingData.substring(currentIndex, currentIndex + len);
            if (/^\d+$/.test(potentialAI) && (gs1AIDescriptions[potentialAI] || fixedLengthAIs[potentialAI] || variableLengthAIs.includes(potentialAI))) {
                let value;
                let nextIndex;
                const aiLength = len;

                if (fixedLengthAIs[potentialAI]) { // Longitud fija
                    const valueLength = fixedLengthAIs[potentialAI];
                    if (remainingData.length >= currentIndex + aiLength + valueLength) {
                        value = remainingData.substring(currentIndex + aiLength, currentIndex + aiLength + valueLength);
                        nextIndex = currentIndex + aiLength + valueLength;
                        // Consumir FNC1 si está justo después
                        if (remainingData.charAt(nextIndex) === FNC1) {
                            nextIndex++;
                        }
                    } else {
                        value = remainingData.substring(currentIndex + aiLength); // Tomar lo que queda
                        nextIndex = remainingData.length;
                    }
                } else { // Longitud variable (o no definida como fija)
                    const fnc1Pos = remainingData.indexOf(FNC1, currentIndex + aiLength);
                    if (fnc1Pos !== -1) {
                        value = remainingData.substring(currentIndex + aiLength, fnc1Pos);
                        nextIndex = fnc1Pos + 1; // Saltar el FNC1
                    } else {
                        value = remainingData.substring(currentIndex + aiLength); // Hasta el final
                        nextIndex = remainingData.length;
                    }
                }
                parsed[potentialAI] = value;
                currentIndex = nextIndex;
                foundAI = true;
                break; // Salir del bucle de longitud de AI una vez encontrado
            }
        }
        if (!foundAI) {
            // Si no se encontró un AI conocido, detener el parseo para evitar errores.
            console.warn("No se pudo encontrar AI GS1 conocido en:", remainingData.substring(currentIndex));
            break;
        }
    }

    // Procesamiento adicional post-parseo
    Object.keys(parsed).forEach(ai => {
        if (['11', '13', '15', '17'].includes(ai)) {
            const dateInfo = formatGS1Date(parsed[ai]);
            parsed[`${ai}_formatted`] = dateInfo.formatted;
            if (['15', '17'].includes(ai)) parsed[`${ai}_expired`] = dateInfo.isExpired;
        }
        if (/^310\d$/.test(ai) && parsed[ai]) {
            const decimals = parseInt(ai[3], 10);
            const numValue = parseInt(parsed[ai], 10);
            if (!isNaN(numValue) && !isNaN(decimals)) {
                 parsed[`${ai}_numeric`] = numValue / Math.pow(10, decimals);
                 parsed[`${ai}_formatted`] = parsed[`${ai}_numeric`].toFixed(decimals) + ' kg';
            }
        }
        // Añadir más lógica para otros AIs (ej: 392n, 393n) si es necesario
    });

    return parsed;
}


/**
 * Muestra los datos GS1 parseados en el contenedor HTML correspondiente.
 * @param {object} parsedData - El objeto resultante de parseGS1Data.
 */
function displayParsedData(parsedData) {
    gs1FieldsContainer.innerHTML = ''; // Limpiar contenedor
    if (!parsedData || Object.keys(parsedData).length === 0) {
        gs1FieldsContainer.innerHTML = '<p>No se encontraron datos GS1 interpretables.</p>';
        return;
    }

    const title = document.createElement('h4');
    title.textContent = "Datos GS1 Interpretados:";
    gs1FieldsContainer.appendChild(title);

    for (const ai in parsedData) {
        // Saltar campos auxiliares internos
        if (ai.endsWith('_formatted') || ai.endsWith('_expired') || ai.endsWith('_numeric')) continue;

        const description = getGS1Description(ai);
        let value = parsedData[ai];
        // Usar valor formateado si existe (para fechas, pesos, etc.)
        let displayValue = parsedData[`${ai}_formatted`] || value;

        const p = document.createElement('p');
        p.classList.add('gs1-field');
        p.innerHTML = `<strong>${ai} (${description}):</strong> `; // Usar innerHTML para strong

        const span = document.createElement('span');
        span.textContent = displayValue;
        // Resaltar si está expirado (para AI 15 y 17)
        if (parsedData[`${ai}_expired`] === true) {
            span.classList.add('expired');
        }
        p.appendChild(span);
        gs1FieldsContainer.appendChild(p);
    }
}

// --- Detección de Proveedor Mejorada ---
/**
 * Intenta detectar el proveedor basado en datos GS1 o texto crudo.
 * @param {string} textoCrudo - El texto original escaneado.
 * @param {object} parsedGS1 - El objeto con datos GS1 parseados.
 * @returns {string} El nombre del proveedor detectado o "No identificado".
 */
function detectarProveedorMejorado(textoCrudo, parsedGS1) {
    // **AJUSTA ESTOS PATRONES A LOS REALES DE TUS PROVEEDORES**
    const patrones = {
        'BIOPROTECE': {
            gtinPrefix: '8411111', // Ejemplo
            loteRegex: /^B\d{5,}$/i, // Ejemplo: B seguido de 5+ dígitos
            textoSimple: 'BIOPROTECE'
        },
        'SAI': {
            gtinPrefix: '8422222', // Ejemplo
            serieRegex: /^SAI-[A-Z0-9]{4,}$/i, // Ejemplo: SAI- seguido de 4+ alfanuméricos
            textoSimple: 'SAI'
        }
        // Añade más proveedores aquí
    };

    // 1. Por GTIN (AI 01)
    if (parsedGS1 && parsedGS1['01']) {
        const gtin = parsedGS1['01'];
        for (const prov in patrones) {
            if (patrones[prov].gtinPrefix && gtin.startsWith(patrones[prov].gtinPrefix)) {
                return `${prov} (por GTIN)`;
            }
        }
    }
    // 2. Por Lote (AI 10)
    if (parsedGS1 && parsedGS1['10']) {
        const lote = parsedGS1['10'];
        for (const prov in patrones) {
            if (patrones[prov].loteRegex && patrones[prov].loteRegex.test(lote)) {
                return `${prov} (por Lote)`;
            }
        }
    }
    // 3. Por Serie (AI 21)
    if (parsedGS1 && parsedGS1['21']) {
        const serie = parsedGS1['21'];
        for (const prov in patrones) {
            if (patrones[prov].serieRegex && patrones[prov].serieRegex.test(serie)) {
                return `${prov} (por Serie)`;
            }
        }
    }
    // 4. Fallback por texto simple
    const textoUpper = textoCrudo.toUpperCase();
    for (const prov in patrones) {
        if (patrones[prov].textoSimple && textoUpper.includes(patrones[prov].textoSimple.toUpperCase())) {
            return `${prov} (por texto)`;
        }
    }

    return "No identificado";
}


// --- Inicialización del Escáner ---
async function initScanner() {
    cameraStatus.textContent = '';
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
             cameraStatus.textContent = 'Error: MediaDevices API no soportada o bloqueada.';
             console.error('MediaDevices API not available.');
             return;
        }
        // Try to get permission first (might be needed for enumerateDevices in some browsers)
        try {
            await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            // Stop the stream immediately after getting permission if needed,
            // as enumerateDevices might work now.
            // Or keep it if you plan to start the scanner right away.
        } catch (permError) {
             console.warn("Permission denied or error before enumeration:", permError);
             // continue, maybe enumerateDevices still works
        }

        const devices = await Html5Qrcode.getCameras();
        cameraSelector.innerHTML = '<option value="">Seleccionar cámara...</option>';
        if (!devices || devices.length === 0) {
            cameraStatus.textContent = 'No se encontraron cámaras disponibles.'; return;
        }
        devices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.id;
            option.text = device.label || `Cámara ${index + 1}`;
            cameraSelector.appendChild(option);
        });

        // Try to select the back camera, otherwise the first one
        const backCam = devices.find(d => d.label && (d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('rear') || d.label.toLowerCase().includes('trás'))) || devices[0];

        if (backCam) {
            currentCameraId = backCam.id;
            cameraSelector.value = backCam.id;
            await startScanner(backCam.id);
        } else {
            cameraStatus.textContent = 'No se pudo seleccionar una cámara por defecto.';
        }

    } catch (error) {
        console.error('Error al obtener cámaras:', error);
        cameraStatus.textContent = `Error al acceder cámara: ${error.message}. (HTTPS/localhost requerido).`;
    }
}

// --- Control del Escáner ---
async function startScanner(cameraId) {
    if (!cameraId) return;
    statusElement.textContent = "Iniciando cámara...";
    cameraStatus.textContent = '';

    try {
        if (html5QrCode && html5QrCode.isScanning) {
            console.log("Stopping existing scanner...");
            await html5QrCode.stop();
            console.log("Scanner stopped.");
        }
        // Asegurarse que la instancia existe
        if (!html5QrCode) {
             // Pasar verbose=false para menos logs de la librería
            html5QrCode = new Html5Qrcode("scanner-preview", /* verbose= */ false);
             console.log("Html5Qrcode instance created.");
        }

        // *** CORRECCIÓN APLICADA ***
        // Remove `supportedScanTypes` from the core config for .start()
        const config = {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            aspectRatio: 1.7777778 // 16:9 aprox.
            // supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA] // REMOVED THIS LINE
        };

        console.log(`Starting scanner with camera ID: ${cameraId} and config:`, config);
        await html5QrCode.start(
            cameraId,
            config,
            onScanSuccess,
            onScanFailure
        );
        console.log("Scanner started successfully.");
        cameraStatus.textContent = ''; // Clear any previous error
        currentCameraId = cameraId;
        statusElement.textContent = "Escaneando...";

    } catch (error) {
        console.error(`Error al iniciar escáner con cámara ${cameraId}:`, error);
        // Mostrar mensaje más útil
        cameraStatus.textContent = `Error al iniciar cámara: ${error.name} - ${error.message}. Intenta seleccionar otra cámara.`;
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop().catch(e => console.error("Error al detener tras fallo:", e));
        }
        statusElement.textContent = "Error al iniciar.";
        // Reset camera ID if start failed
        currentCameraId = null;
    }
}

async function stopScanner() {
    if (autoClearTimeout) clearTimeout(autoClearTimeout);
    autoClearTimeout = null;
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            console.log("Stopping scanner manually...");
            await html5QrCode.stop();
            console.log("Scanner stopped manually.");
            currentCameraId = null; // Resetear cámara al detener manualmente
            statusElement.textContent = "Escáner detenido.";
            scannerPreview.classList.remove('scan-success-border');
            // Clear the preview area if needed
            scannerPreview.innerHTML = '';
            // Optional: Reset camera selector to default
            // cameraSelector.value = "";
        } catch (error) {
            console.error("Error al detener:", error);
            statusElement.textContent = "Error al detener.";
        }
    } else {
        statusElement.textContent = "Escáner no activo.";
    }
}

// --- Callbacks de Escaneo ---
function onScanSuccess(decodedText, decodedResult) {
    console.log("Scan successful:", decodedText, decodedResult);
    resultadoElement.value = decodedText;
    statusElement.textContent = "Código detectado ✅";

    // Feedback Visual
    scannerPreview.classList.add('scan-success-border');
    setTimeout(() => scannerPreview.classList.remove('scan-success-border'), 500);

    // Feedback Auditivo
    if (soundToggle.checked) playBeep();

    // Parseo GS1 y Detección de Proveedor
    const parsedData = parseGS1Data(decodedText);
    displayParsedData(parsedData);
    const proveedor = detectarProveedorMejorado(decodedText, parsedData);
    proveedorAutoElement.textContent = proveedor;

    // Captura Visual (Opcional)
    if (window.html2canvas) {
        html2canvas(scannerPreview).then(canvas => {
            capturaContainer.innerHTML = "";
            capturaContainer.appendChild(canvas);
        }).catch(err => console.error("html2canvas error:", err));
    }

    // Limpieza Automática (Opcional)
    if (autoClearToggle.checked) {
        if (autoClearTimeout) clearTimeout(autoClearTimeout);
        autoClearTimeout = setTimeout(clearScanResults, 3000);
    }
}

function onScanFailure(error) {
    // Evitar mostrar errores constantes de "no encontrado"
    if (statusElement.textContent === "Código detectado ✅") {
       // If we previously had a success, reset status after a failure
        statusElement.textContent = "Escaneando...";
    }
    // Don't log common errors like 'NotFoundException' unless debugging
    if (!`${error}`.includes("NotFoundException")) {
        console.warn(`Scan Failure: ${error}`);
    }
    // Quitar borde verde si hubo un fallo después de un éxito
    scannerPreview.classList.remove('scan-success-border');
}

// --- Control de UI ---
function switchTab(targetId) {
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(sec => sec.classList.remove('active'));
    const targetTab = document.querySelector(`.tab[data-tab-target='${targetId}']`);
    const targetSection = document.getElementById(targetId);
    if (targetTab) targetTab.classList.add('active');
    if (targetSection) targetSection.classList.add('active');

    if (targetId === 'scan') {
        // Reiniciar escáner al volver a la pestaña
        if (currentCameraId) {
            console.log("Switching to scan tab, restarting scanner...");
            startScanner(currentCameraId).catch(err => console.error("Error restarting scanner on tab switch:", err));
        } else {
            console.log("Switching to scan tab, initializing scanner...");
            initScanner().catch(err => console.error("Error initializing scanner on tab switch:", err));
        }
    } else {
        // Detener escáner al salir de la pestaña
        console.log("Switching away from scan tab, stopping scanner...");
        stopScanner().catch(err => console.error("Error stopping scanner on tab switch:", err));
    }
}

function toggleDarkMode() {
    document.body.classList.toggle('dark');
    // Opcional: Guardar preferencia
    localStorage.setItem('darkMode', document.body.classList.contains('dark'));
    // Update toggle button text/emoji if needed
    darkModeToggle.textContent = document.body.classList.contains('dark') ? '☀️' : '🌓';
}

function clearScanResults() {
    resultadoElement.value = '';
    proveedorAutoElement.textContent = '---';
    capturaContainer.innerHTML = '';
    gs1FieldsContainer.innerHTML = ''; // Limpiar datos GS1
    statusElement.textContent = html5QrCode && html5QrCode.isScanning ? "Escaneando..." : "Esperando código...";
    if (autoClearTimeout) clearTimeout(autoClearTimeout);
    autoClearTimeout = null;
    console.log("Resultados limpiados.");
}

function copyScanResult() {
    const textToCopy = resultadoElement.value;
    if (!textToCopy) {
        copyButton.innerText = "Vacío!";
        setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500);
        return;
    }
    navigator.clipboard.writeText(textToCopy).then(() => {
        copyButton.innerText = "Copiado!";
        setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500);
    }).catch(err => {
        console.error('Error al copiar: ', err);
        // Consider a more user-friendly fallback for older browsers or errors
        try {
           const textArea = document.createElement("textarea");
           textArea.value = textToCopy;
           document.body.appendChild(textArea);
           textArea.focus();
           textArea.select();
           document.execCommand('copy');
           document.body.removeChild(textArea);
           copyButton.innerText = "Copiado!";
           setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500);
        } catch (execErr) {
            console.error('Fallback copy failed:', execErr);
           alert("Error al copiar.");
        }
    });
}

function playBeep() {
    try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (!audioContext) { console.warn("Web Audio API no soportada."); return; }
         // Resume context if needed (user interaction might be required first)
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.01); // Volumen 0.5
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // Frecuencia A5
        oscillator.type = 'square';
        oscillator.start(audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.1);
        oscillator.stop(audioContext.currentTime + 0.1);
    } catch (e) {
        console.error("Error al reproducir sonido:", e);
    }
}

// --- Event Listeners y Arranque ---
document.addEventListener('DOMContentLoaded', () => {
    // Comprobar HTTPS (excepto localhost)
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
        cameraStatus.textContent = 'Advertencia: La cámara requiere HTTPS.';
        console.warn('Camera access requires HTTPS or localhost.');
    }

    // --- CORRECCIÓN ALTERNATIVA / MÁS ROBUSTA para changeCamera ---
    // Remove the `onchange` from the HTML select element
    // Add the listener here instead
    if (cameraSelector) {
        cameraSelector.addEventListener('change', (event) => {
             const selectedCameraId = event.target.value;
             handleCameraChange(selectedCameraId); // Call a new handler function
        });
    }
    // -------------------------------------------------------------

    initScanner().catch(err => console.error("Initial scanner init failed:", err)); // Iniciar búsqueda de cámaras y escáner

    // Listeners para Tabs
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-tab-target');
            if (targetId) switchTab(targetId);
        });
    });

    // Listener para Modo Oscuro
    if (darkModeToggle) {
        // Set initial dark mode state from localStorage
        if (localStorage.getItem('darkMode') === 'true') {
            document.body.classList.add('dark');
        } else {
             document.body.classList.add('light'); // Ensure one is set
        }
         // Set initial toggle text/emoji
        darkModeToggle.textContent = document.body.classList.contains('dark') ? '☀️' : '🌓';
        darkModeToggle.addEventListener('click', toggleDarkMode);
    }


    // Listeners para Botones de Acción
    if (copyButton) copyButton.addEventListener('click', copyScanResult);
    if (clearButton) clearButton.addEventListener('click', clearScanResults);

    // Registrar Service Worker para PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js') // Asegúrate que la ruta sea correcta
            .then(reg => console.log('Service Worker Registrado:', reg.scope))
            .catch(err => console.error('Error registro Service Worker:', err));
    }
});

// --- Handler function for camera change ---
async function handleCameraChange(cameraId) {
    if (!cameraId) {
        console.log("Camera selection cleared, stopping scanner.");
        await stopScanner();
        return;
    }
    if (cameraId === currentCameraId) {
        console.log("Selected camera is already active.");
        return; // No need to restart if the same camera is selected
    }
    console.log(`Changing camera to: ${cameraId}`);
    await startScanner(cameraId);
};

// --- REMOVE OR COMMENT OUT the old global assignment ---
// window.changeCamera = async (cameraId) => { ... };
