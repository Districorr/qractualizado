/**
 * scanner.js
 * Lógica principal para el escáner de códigos de barras y GS1.
 * Versión revisada para corregir errores de carga y referencia.
 */

// ==================================================================
//                      Variables Globales
// ==================================================================
// Dejamos solo las que realmente necesitan ser globales para el estado
let currentCameraId = null;
let html5QrCode = null; // La instancia se creará después de cargar la librería
let audioContext = null;
let autoClearTimeout = null;

// ==================================================================
//                 Referencias a Elementos del DOM
// ==================================================================
// Se inicializarán dentro de DOMContentLoaded
let cameraSelector, scannerPreview, cameraStatus, statusElement,
    proveedorAutoElement, resultadoElement, capturaContainer,
    tabs, sections, darkModeToggle, copyButton, clearButton,
    soundToggle, autoClearToggle, gs1FieldsContainer;

// ==================================================================
//                      Constantes y Mapeos GS1
// ==================================================================
const FNC1 = '\u001d';
const gs1AIDescriptions = {
    '00': 'SSCC', '01': 'GTIN', '02': 'GTIN Contenido', '10': 'Lote',
    '11': 'Fecha Producción', '13': 'Fecha Empaquetado', '15': 'Fecha Cons. Pref.',
    '17': 'Fecha Caducidad', '21': 'Número de Serie', '240': 'ID Artículo Adicional',
    '241': 'ID Cliente', '30': 'Cantidad Variable', '37': 'Cantidad (Unidades)',
    '310': 'Peso Neto (kg)', '392': 'Precio Pagar (Variable)', '393': 'Precio Pagar (ISO)',
    '400': 'Nº Pedido Cliente', '410': 'Expedido a (GLN)', '414': 'GLN Localización',
    '8005': 'Precio Unidad', '90': 'Info. Mutua Acordada',
};

// ==================================================================
//                      Funciones de Parseo GS1
// ==================================================================
function getGS1Description(ai) {
    if (gs1AIDescriptions[ai]) return gs1AIDescriptions[ai];
    if (/^310\d$/.test(ai)) return `Peso Neto (kg) - ${ai[3]} dec`;
    if (/^392\d$/.test(ai)) return `Precio Pagar (Var) - ${ai[3]} dec`;
    if (/^393\d$/.test(ai)) return `Precio Pagar (ISO) - ${ai[3]} dec`;
    return 'Desconocido';
}

function formatGS1Date(yyMMdd) {
    if (!/^\d{6}$/.test(yyMMdd)) return { formatted: yyMMdd, isExpired: null, dateObj: null };
    const year = parseInt(yyMMdd.substring(0, 2), 10);
    const month = parseInt(yyMMdd.substring(2, 4), 10);
    const day = parseInt(yyMMdd.substring(4, 6), 10);
    const currentYearLastTwoDigits = new Date().getFullYear() % 100;
    const fullYear = year <= (currentYearLastTwoDigits + 10) ? 2000 + year : 1900 + year;
    if (month < 1 || month > 12 || day < 1 || day > 31) return { formatted: `${yyMMdd} (Fecha inválida)`, isExpired: null, dateObj: null };
    try {
        const dateObj = new Date(Date.UTC(fullYear, month - 1, day));
        if (dateObj.getUTCFullYear() !== fullYear || dateObj.getUTCMonth() !== month - 1 || dateObj.getUTCDate() !== day) return { formatted: `${yyMMdd} (Fecha inválida)`, isExpired: null, dateObj: null };
        const today = new Date();
        const todayMidnightUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        const isExpired = dateObj < todayMidnightUTC;
        const formattedDate = `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${fullYear}`;
        const status = isExpired ? ' (¡Vencido!)' : '';
        return { formatted: `${formattedDate}${status}`, isExpired: isExpired, dateObj: dateObj };
    } catch (e) { return { formatted: `${yyMMdd} (Error fecha)`, isExpired: null, dateObj: null }; }
}

function parseGS1Data(data) {
    const parsed = {};
    if (!data) return parsed;
    const fixedLengthAIs = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6, '410': 13, '414': 13, '8005': 6 };
    const variableLengthAIs = ['10', '21', '90', '240', '241', '400'];
    let remainingData = data;
    let currentIndex = 0;
    while (currentIndex < remainingData.length) {
        let foundAI = false;
        for (let len = 4; len >= 2; len--) {
            const potentialAI = remainingData.substring(currentIndex, currentIndex + len);
            if (/^\d+$/.test(potentialAI) && (gs1AIDescriptions[potentialAI] || fixedLengthAIs[potentialAI] || variableLengthAIs.includes(potentialAI))) {
                let value; let nextIndex; const aiLength = len;
                if (fixedLengthAIs[potentialAI]) {
                    const valueLength = fixedLengthAIs[potentialAI];
                    if (remainingData.length >= currentIndex + aiLength + valueLength) { value = remainingData.substring(currentIndex + aiLength, currentIndex + aiLength + valueLength); nextIndex = currentIndex + aiLength + valueLength; if (remainingData.charAt(nextIndex) === FNC1) nextIndex++; }
                    else { value = remainingData.substring(currentIndex + aiLength); nextIndex = remainingData.length; }
                } else {
                    const fnc1Pos = remainingData.indexOf(FNC1, currentIndex + aiLength);
                    if (fnc1Pos !== -1) { value = remainingData.substring(currentIndex + aiLength, fnc1Pos); nextIndex = fnc1Pos + 1; }
                    else { value = remainingData.substring(currentIndex + aiLength); nextIndex = remainingData.length; }
                }
                parsed[potentialAI] = value; currentIndex = nextIndex; foundAI = true; break;
            }
        }
        if (!foundAI) { console.warn("No se pudo encontrar AI GS1 conocido en:", remainingData.substring(currentIndex)); break; }
    }
    Object.keys(parsed).forEach(ai => {
        if (['11', '13', '15', '17'].includes(ai)) { const dateInfo = formatGS1Date(parsed[ai]); parsed[`${ai}_formatted`] = dateInfo.formatted; if (['15', '17'].includes(ai)) parsed[`${ai}_expired`] = dateInfo.isExpired; }
        if (/^310\d$/.test(ai) && parsed[ai]) { const decimals = parseInt(ai[3], 10); const numValue = parseInt(parsed[ai], 10); if (!isNaN(numValue) && !isNaN(decimals)) { parsed[`${ai}_numeric`] = numValue / Math.pow(10, decimals); parsed[`${ai}_formatted`] = parsed[`${ai}_numeric`].toFixed(decimals) + ' kg'; } }
    });
    return parsed;
}

function displayParsedData(parsedData) {
    if (!gs1FieldsContainer) return; // Asegurar que el elemento existe
    gs1FieldsContainer.innerHTML = '';
    if (!parsedData || Object.keys(parsedData).length === 0) { gs1FieldsContainer.innerHTML = '<p>No se encontraron datos GS1 interpretables.</p>'; return; }
    const title = document.createElement('h4'); title.textContent = "Datos GS1 Interpretados:"; gs1FieldsContainer.appendChild(title);
    for (const ai in parsedData) {
        if (ai.endsWith('_formatted') || ai.endsWith('_expired') || ai.endsWith('_numeric')) continue;
        const description = getGS1Description(ai); let displayValue = parsedData[`${ai}_formatted`] || parsedData[ai];
        const p = document.createElement('p'); p.classList.add('gs1-field'); p.innerHTML = `<strong>${ai} (${description}):</strong> `;
        const span = document.createElement('span'); span.textContent = displayValue; if (parsedData[`${ai}_expired`] === true) span.classList.add('expired');
        p.appendChild(span); gs1FieldsContainer.appendChild(p);
    }
}

// --- Detección de Proveedor Mejorada ---
function detectarProveedorMejorado(textoCrudo, parsedGS1) {
    // **AJUSTA ESTOS PATRONES A LOS REALES**
    const patrones = { 'BIOPROTECE': { gtinPrefix: '8411111', loteRegex: /^B\d{5,}$/i, textoSimple: 'BIOPROTECE' }, 'SAI': { gtinPrefix: '8422222', serieRegex: /^SAI-[A-Z0-9]{4,}$/i, textoSimple: 'SAI' } };
    if (parsedGS1 && parsedGS1['01']) { const gtin = parsedGS1['01']; for (const prov in patrones) if (patrones[prov].gtinPrefix && gtin.startsWith(patrones[prov].gtinPrefix)) return `${prov} (por GTIN)`; }
    if (parsedGS1 && parsedGS1['10']) { const lote = parsedGS1['10']; for (const prov in patrones) if (patrones[prov].loteRegex && patrones[prov].loteRegex.test(lote)) return `${prov} (por Lote)`; }
    if (parsedGS1 && parsedGS1['21']) { const serie = parsedGS1['21']; for (const prov in patrones) if (patrones[prov].serieRegex && patrones[prov].serieRegex.test(serie)) return `${prov} (por Serie)`; }
    const textoUpper = textoCrudo.toUpperCase(); for (const prov in patrones) if (patrones[prov].textoSimple && textoUpper.includes(patrones[prov].textoSimple.toUpperCase())) return `${prov} (por texto)`;
    return "No identificado";
}

// --- Inicialización del Escáner ---
async function initScanner() {
    console.log('scanner.js: Ejecutando initScanner...');
    if (!cameraStatus) { console.error("Error: cameraStatus no encontrado en el DOM."); return; } // Verificación temprana
    cameraStatus.textContent = '';
    try {
        // Verificar que Html5Qrcode esté cargado ANTES de usarlo
        if (typeof Html5Qrcode === 'undefined') {
            throw new Error("La librería Html5Qrcode no se ha cargado correctamente.");
        }
        console.log('scanner.js: Html5Qrcode está definido.');

        if (!navigator.mediaDevices) {
             cameraStatus.textContent = 'Error: MediaDevices API no soportada.'; return;
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
        const backCam = devices.find(d => d.label && (d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('rear') || d.label.toLowerCase().includes('trás'))) || devices[0];
        currentCameraId = backCam.id;
        cameraSelector.value = backCam.id;
        console.log(`scanner.js: Cámara por defecto seleccionada: ${currentCameraId}`);
        await startScanner(currentCameraId); // Iniciar con la cámara por defecto
    } catch (error) {
        console.error('Error en initScanner:', error);
        if (error.name === 'NotAllowedError') {
             cameraStatus.textContent = `Error: Permiso de cámara denegado. Revisa la configuración del navegador/sitio.`;
        } else {
             cameraStatus.textContent = `Error al inicializar: ${error.message}. (HTTPS/localhost requerido).`;
        }
    }
}

// --- Control del Escáner ---
async function startScanner(cameraId) {
    if (!cameraId) { console.warn("startScanner llamado sin cameraId"); return; }
    console.log(`scanner.js: Intentando iniciar escáner con cámara ${cameraId}...`);
    if (!statusElement || !cameraStatus) { console.error("Elementos de estado no encontrados"); return; }
    statusElement.textContent = "Iniciando cámara...";
    cameraStatus.textContent = '';

    try {
        // Verificar librería OTRA VEZ justo antes de usarla
        if (typeof Html5Qrcode === 'undefined') throw new Error("Html5Qrcode no definido.");
        if (typeof Html5Qrcode.Html5QrcodeScanType === 'undefined') throw new Error("Html5Qrcode.Html5QrcodeScanType no definido.");

        // Crear instancia si no existe o si se detuvo previamente
        if (!html5QrCode) {
            html5QrCode = new Html5Qrcode("scanner-preview", /* verbose= */ false);
            console.log("Nueva instancia de Html5Qrcode creada.");
        }

        // Detener escáner anterior si está activo
        if (html5QrCode.isScanning) {
            console.log("Deteniendo escáner anterior...");
            await html5QrCode.stop();
            console.log("Escáner anterior detenido.");
        }

        const config = {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            aspectRatio: 1.7777778,
            supportedScanTypes: [Html5Qrcode.Html5QrcodeScanType.SCAN_TYPE_CAMERA] // CORREGIDO Y VERIFICADO
        };
        console.log("Configuración para start:", config);

        await html5QrCode.start(cameraId, config, onScanSuccess, onScanFailure);

        console.log(`Scanner iniciado con éxito con cámara: ${cameraId}`);
        cameraStatus.textContent = '';
        currentCameraId = cameraId;
        statusElement.textContent = "Escaneando...";

    } catch (error) {
        console.error(`Error al iniciar escáner con cámara ${cameraId}:`, error);
        if (error.name === 'NotAllowedError') {
             cameraStatus.textContent = `Error: Permiso de cámara denegado. Revisa la configuración.`;
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
             cameraStatus.textContent = `Error: Cámara no encontrada o no disponible.`;
        } else {
             // Captura el error específico de SCAN_TYPE_CAMERA si ocurre aquí
             cameraStatus.textContent = `Error al iniciar cámara: ${error.message}. Intenta otra.`;
        }
        // No intentar detener si la instancia falló al crearse o iniciar
        // if (html5QrCode && html5QrCode.isScanning) {
        //    await html5QrCode.stop().catch(e => console.error("Error al detener tras fallo:", e));
        // }
        statusElement.textContent = "Error al iniciar.";
        currentCameraId = null; // Indicar que no hay cámara activa
    }
}

async function stopScanner() {
    if (autoClearTimeout) clearTimeout(autoClearTimeout); autoClearTimeout = null;
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            console.log("Deteniendo escáner...");
            await html5QrCode.stop();
            console.log("Escáner detenido.");
            currentCameraId = null;
            statusElement.textContent = "Escáner detenido.";
            scannerPreview.classList.remove('scan-success-border');
        } catch (error) { console.error("Error al detener:", error); statusElement.textContent = "Error al detener."; }
    } else { statusElement.textContent = "Escáner no activo."; }
}

// --- Callbacks de Escaneo ---
function onScanSuccess(decodedText, decodedResult) {
    if (!resultadoElement || !statusElement || !scannerPreview || !soundToggle || !proveedorAutoElement || !capturaContainer || !autoClearToggle) return; // Verificar elementos
    resultadoElement.value = decodedText; statusElement.textContent = "Código detectado ✅";
    scannerPreview.classList.add('scan-success-border'); setTimeout(() => scannerPreview.classList.remove('scan-success-border'), 500);
    if (soundToggle.checked) playBeep();
    const parsedData = parseGS1Data(decodedText); displayParsedData(parsedData);
    const proveedor = detectarProveedorMejorado(decodedText, parsedData); proveedorAutoElement.textContent = proveedor;
    if (window.html2canvas) { html2canvas(scannerPreview).then(canvas => { capturaContainer.innerHTML = ""; capturaContainer.appendChild(canvas); }).catch(err => console.error("html2canvas error:", err)); }
    if (autoClearToggle.checked) { if (autoClearTimeout) clearTimeout(autoClearTimeout); autoClearTimeout = setTimeout(clearScanResults, 3000); }
}
function onScanFailure(error) {
    if (!statusElement || !scannerPreview) return;
    if (!error.includes("NotFoundException") && !error.includes("No QR code found")) { /* console.warn(`Scan Failure: ${error}`); */ }
    if (statusElement.textContent !== "Código detectado ✅") statusElement.textContent = "Escaneando...";
    scannerPreview.classList.remove('scan-success-border');
}

// --- Control de UI ---
function switchTab(targetId) {
    if (!tabs || !sections) return;
    tabs.forEach(tab => tab.classList.remove('active')); sections.forEach(sec => sec.classList.remove('active'));
    const targetTab = document.querySelector(`.tab[data-tab-target='${targetId}']`); const targetSection = document.getElementById(targetId);
    if (targetTab) targetTab.classList.add('active'); if (targetSection) targetSection.classList.add('active');
    if (targetId === 'scan') { if (currentCameraId) startScanner(currentCameraId); else initScanner(); statusElement.textContent = "Esperando código..."; }
    else { stopScanner(); }
}
function toggleDarkMode() { document.body.classList.toggle('dark'); document.body.classList.toggle('light'); }
function clearScanResults() {
    if (!resultadoElement || !proveedorAutoElement || !capturaContainer || !gs1FieldsContainer || !statusElement) return;
    resultadoElement.value = ''; proveedorAutoElement.textContent = '---'; capturaContainer.innerHTML = ''; gs1FieldsContainer.innerHTML = '';
    statusElement.textContent = html5QrCode && html5QrCode.isScanning ? "Escaneando..." : "Esperando código...";
    if (autoClearTimeout) clearTimeout(autoClearTimeout); autoClearTimeout = null;
}
function copyScanResult() {
    if (!resultadoElement || !copyButton) return;
    const textToCopy = resultadoElement.value; if (!textToCopy) { copyButton.innerText = "Vacío!"; setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500); return; }
    navigator.clipboard.writeText(textToCopy).then(() => { copyButton.innerText = "Copiado!"; setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500); }).catch(err => { console.error('Error al copiar: ', err); alert("Error al copiar."); });
}
function playBeep() {
    try { if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)(); if (!audioContext) return; if (audioContext.state === 'suspended') audioContext.resume(); const oscillator = audioContext.createOscillator(); const gainNode = audioContext.createGain(); oscillator.connect(gainNode); gainNode.connect(audioContext.destination); gainNode.gain.setValueAtTime(0, audioContext.currentTime); gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.01); oscillator.frequency.setValueAtTime(880, audioContext.currentTime); oscillator.type = 'square'; oscillator.start(audioContext.currentTime); gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.1); oscillator.stop(audioContext.currentTime + 0.1); } catch (e) { console.error("Error al reproducir sonido:", e); }
}

// --- Función changeCamera (definida antes de asignarla a window) ---
async function changeCameraGlobal(cameraId) { // Renombrada internamente para claridad
    console.log(`Llamada a changeCameraGlobal con ID: ${cameraId}`);
    if (!cameraId) { await stopScanner(); return; }
    if (cameraId === currentCameraId) { console.log(`Cámara ${cameraId} ya seleccionada.`); return; }
    await startScanner(cameraId);
}

// --- Event Listeners y Arranque ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM completamente cargado y parseado.");

    // Cachear elementos del DOM AHORA
    cameraSelector = document.getElementById('camera-selector');
    scannerPreview = document.getElementById('scanner-preview');
    cameraStatus = document.getElementById('camera-status');
    statusElement = document.getElementById('status');
    proveedorAutoElement = document.getElementById('proveedor-auto');
    resultadoElement = document.getElementById('resultado');
    capturaContainer = document.getElementById('captura-container');
    tabs = document.querySelectorAll('.tab');
    sections = document.querySelectorAll('.section');
    darkModeToggle = document.querySelector('.dark-mode-toggle');
    copyButton = document.getElementById('copy-button');
    clearButton = document.getElementById('clear-button');
    soundToggle = document.getElementById('sound-toggle');
    autoClearToggle = document.getElementById('auto-clear-toggle');
    gs1FieldsContainer = document.getElementById('gs1-fields');

    // Verificar que los elementos esenciales existen
    if (!cameraSelector || !scannerPreview || !cameraStatus || !statusElement) {
        console.error("Error crítico: Faltan elementos HTML esenciales (selector, preview, status).");
        alert("Error: Faltan elementos HTML para iniciar el escáner.");
        return;
    }

    // Verificar que la librería esté cargada ANTES de hacer nada
    if (typeof Html5Qrcode === 'undefined') {
        console.error("¡ERROR CRÍTICO! La librería Html5Qrcode no está disponible en DOMContentLoaded.");
        cameraStatus.textContent = "Error: No se pudo cargar la librería del escáner. Revisa la ruta en index.html y la consola.";
        return; // Detener ejecución
    }
    console.log("Html5Qrcode está disponible en DOMContentLoaded.");

    // Comprobar HTTPS
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
        cameraStatus.textContent = 'Advertencia: La cámara requiere HTTPS.';
        console.warn('Camera access requires HTTPS or localhost.');
    }

    // Iniciar el proceso dentro de un try...catch
    try {
        initScanner();
    } catch (error) {
        console.error("Error durante la inicialización:", error);
        cameraStatus.textContent = `Error fatal al iniciar: ${error.message}`;
    }

    // Configurar Listeners
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-tab-target');
            if (targetId) switchTab(targetId);
        });
    });
    if (darkModeToggle) darkModeToggle.addEventListener('click', toggleDarkMode);
    if (copyButton) copyButton.addEventListener('click', copyScanResult);
    if (clearButton) clearButton.addEventListener('click', clearScanResults);

    // Registrar Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js') // Ajusta la ruta si es necesario
            .then(reg => console.log('Service Worker Registrado:', reg.scope))
            .catch(err => console.error('Error registro Service Worker:', err));
    }

    // Asignar a window DESPUÉS de que la función esté definida y el DOM listo
    window.changeCamera = changeCameraGlobal; // Usar la función renombrada internamente
    console.log("Función changeCamera asignada a window.");

});

console.log("scanner.js parseado completamente.");

--- FIN DEL ARCHIVO scanner.js (REVISADO) ---
