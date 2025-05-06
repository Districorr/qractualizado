// Variables globales para el estado del escáner
let scanner;
let currentCameraId = null;
let html5QrCode = null; // Mantener referencia a la instancia
let audioContext = null; // Para el sonido
let autoClearTimeout = null; // Para limpieza automática

// Referencias a elementos del DOM (cache)
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
const gs1FieldsContainer = document.getElementById('gs1-fields'); // Para datos GS1

// --- Constantes y Mapeos GS1 ---
const FNC1 = '\u001d'; // Caracter Separador de Grupo GS1

// Mapeo básico de AIs a descripciones (expandir según necesidad)
const gs1AIDescriptions = {
    '00': 'SSCC', '01': 'GTIN', '02': 'GTIN Contenido', '10': 'Lote',
    '11': 'Fecha Producción', '13': 'Fecha Empaquetado', '15': 'Fecha Cons. Pref.',
    '17': 'Fecha Caducidad', '21': 'Número de Serie', '240': 'ID Artículo Adicional',
    '241': 'ID Cliente', '30': 'Cantidad Variable', '37': 'Cantidad (Unidades)',
    '310': 'Peso Neto (kg)', '392': 'Precio Pagar (Variable)', '393': 'Precio Pagar (ISO)',
    '400': 'Nº Pedido Cliente', '410': 'Expedido a (GLN)', '414': 'GLN Localización',
    '8005': 'Precio Unidad', '90': 'Info. Mutua Acordada',
    // ... añadir más AIs ...
};

// --- Funciones de Parseo GS1 ---

function getGS1Description(ai) {
    if (gs1AIDescriptions[ai]) return gs1AIDescriptions[ai];
    // Manejo simple para AIs con 'n' (decimales/longitud)
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
    const fullYear = 2000 + year; // Asumir siglo 21

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return { formatted: `${yyMMdd} (Fecha inválida)`, isExpired: null, dateObj: null };
    }
    try {
        const dateObj = new Date(Date.UTC(fullYear, month - 1, day));
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
        return { formatted: `${yyMMdd} (Error fecha)`, isExpired: null, dateObj: null };
    }
}

function parseGS1Data(data) {
    const parsed = {};
    if (!data) return parsed;

    let remainingData = data;
    let currentIndex = 0;

    // Función auxiliar para extraer AI y valor
    const extractAI = (input, index) => {
        for (let len = 4; len >= 2; len--) {
            const potentialAI = input.substring(index, index + len);
            if (/^\d+$/.test(potentialAI) && gs1AIDescriptions[potentialAI]) {
                // Determinar longitud fija o variable (simplificado)
                // Una implementación completa requeriría una tabla de longitudes fijas/máximas
                let valueLength;
                let isVariable = false;
                // Ejemplos simples (necesita tabla completa para ser robusto)
                if (['01', '02'].includes(potentialAI)) valueLength = 14;
                else if (['11', '13', '15', '17'].includes(potentialAI)) valueLength = 6;
                else if (potentialAI === '10') isVariable = true; // Lote es variable
                else if (potentialAI === '21') isVariable = true; // Serie es variable
                else valueLength = 20; // Asumir una longitud máxima por defecto si no se conoce

                let value;
                let nextAIPos = input.indexOf(FNC1, index + len);

                if (isVariable) {
                    if (nextAIPos !== -1) {
                        value = input.substring(index + len, nextAIPos);
                    } else {
                        value = input.substring(index + len); // Hasta el final si no hay FNC1
                    }
                } else {
                     if (input.length >= index + len + valueLength) {
                         value = input.substring(index + len, index + len + valueLength);
                         // Verificar si el siguiente caracter es FNC1 y consumirlo si es así
                         if (input.charAt(index + len + valueLength) === FNC1) {
                             nextAIPos = index + len + valueLength; // Posición del FNC1
                         } else {
                             nextAIPos = index + len + valueLength -1; // Asumir que el siguiente AI empieza justo después
                         }
                     } else {
                         value = input.substring(index + len); // Tomar lo que queda si no alcanza
                         nextAIPos = -1; // Fin de la cadena
                     }
                }

                // Si encontramos un FNC1, el siguiente índice es después de él
                // Si no, es después del valor extraído
                const nextIndex = (nextAIPos !== -1) ? nextAIPos + 1 : index + len + value.length;
                return { ai: potentialAI, value: value, nextIndex: nextIndex };
            }
        }
        return null; // No se encontró un AI conocido al inicio
    };

    while (currentIndex < remainingData.length) {
        const result = extractAI(remainingData, currentIndex);
        if (result) {
            parsed[result.ai] = result.value;
            currentIndex = result.nextIndex;
        } else {
            // Si no se encuentra un AI, podría haber terminado o haber datos no estándar
            console.warn("No se pudo encontrar AI GS1 en:", remainingData.substring(currentIndex));
            break; // Salir del bucle si no se puede continuar parseando
        }
    }


    // Procesamiento adicional (fechas, etc.)
    Object.keys(parsed).forEach(ai => {
        if (['11', '13', '15', '17'].includes(ai)) {
            const dateInfo = formatGS1Date(parsed[ai]);
            parsed[`${ai}_formatted`] = dateInfo.formatted;
            if (ai === '17' || ai === '15') { // Caducidad o Cons. Pref.
                parsed[`${ai}_expired`] = dateInfo.isExpired;
            }
        }
        // Añadir lógica para decimales si es necesario (ej: AI 310n)
        if (/^310\d$/.test(ai) && parsed[ai]) {
            const decimals = parseInt(ai[3], 10);
            const numValue = parseInt(parsed[ai], 10);
            if (!isNaN(numValue) && !isNaN(decimals)) {
                 parsed[`${ai}_numeric`] = numValue / Math.pow(10, decimals);
                 parsed[`${ai}_formatted`] = parsed[`${ai}_numeric`].toFixed(decimals) + ' kg';
            }
        }
    });

    return parsed;
}


function displayParsedData(parsedData) {
    gs1FieldsContainer.innerHTML = ''; // Limpiar anterior
    if (Object.keys(parsedData).length === 0) {
        gs1FieldsContainer.innerHTML = '<p>No se encontraron datos GS1 interpretables.</p>';
        return;
    }

    const title = document.createElement('h4');
    title.textContent = "Datos GS1 Interpretados:";
    gs1FieldsContainer.appendChild(title);

    for (const ai in parsedData) {
        if (ai.endsWith('_formatted') || ai.endsWith('_expired') || ai.endsWith('_numeric')) continue;

        const description = getGS1Description(ai);
        let value = parsedData[ai];
        let displayValue = parsedData[`${ai}_formatted`] || value; // Usar formateado si existe

        const p = document.createElement('p');
        p.classList.add('gs1-field');
        p.innerHTML = `<strong>${ai} (${description}):</strong> `;

        const span = document.createElement('span');
        span.textContent = displayValue;
        if (parsedData[`${ai}_expired`] === true) {
            span.classList.add('expired');
        }
        p.appendChild(span);
        gs1FieldsContainer.appendChild(p);
    }
}

// --- Detección de Proveedor Mejorada ---
function detectarProveedorMejorado(textoCrudo, parsedGS1) {
    if (parsedGS1 && parsedGS1['01']) {
        const gtin = parsedGS1['01'];
        if (gtin.startsWith('8411111')) return "BIOPROTECE (por GTIN)"; // Ejemplo
        if (gtin.startsWith('8422222')) return "SAI (por GTIN)"; // Ejemplo
    }
    if (parsedGS1 && parsedGS1['10']) {
        const lote = parsedGS1['10'];
        if (/^B\d{5,}$/i.test(lote)) return "BIOPROTECE (por Lote)"; // Ejemplo: B seguido de 5+ dígitos
    }
     if (parsedGS1 && parsedGS1['21']) {
        const serie = parsedGS1['21'];
        if (/^SAI-[A-Z0-9]{4,}$/i.test(serie)) return "SAI (por Serie)"; // Ejemplo: SAI- seguido de 4+ alfanuméricos
    }
    // Fallback a texto simple
    if (textoCrudo.toUpperCase().includes("BIOPROTECE")) return "BIOPROTECE (por texto)";
    if (textoCrudo.toUpperCase().includes("SAI")) return "SAI (por texto)";

    return "No identificado";
}

// --- Inicialización ---
async function initScanner() {
    cameraStatus.textContent = '';
    try {
        if (!navigator.mediaDevices) {
             cameraStatus.textContent = 'Error: MediaDevices API no soportada.';
             return;
        }
        const devices = await Html5Qrcode.getCameras();
        cameraSelector.innerHTML = '<option value="">Seleccionar cámara...</option>';
        if (!devices || devices.length === 0) {
            cameraStatus.textContent = 'No se encontraron cámaras disponibles.';
            return;
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
        await startScanner(backCam.id);
    } catch (error) {
        console.error('Error al obtener cámaras:', error);
        cameraStatus.textContent = `Error al acceder a la cámara: ${error.message}. Asegúrate de usar HTTPS o localhost.`;
    }
}

// --- Control del Escáner ---
async function startScanner(cameraId) {
    if (!cameraId) return;
    statusElement.textContent = "Iniciando cámara...";
    cameraStatus.textContent = '';

    try {
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop();
        }
        if (!html5QrCode) {
            html5QrCode = new Html5Qrcode("scanner-preview", false);
        }
        const config = {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            aspectRatio: 1.7777778,
            // *** CORRECCIÓN DEFINITIVA ***
            supportedScanTypes: [Html5Qrcode.Html5QrcodeScanType.SCAN_TYPE_CAMERA]
        };
        await html5QrCode.start(cameraId, config, onScanSuccess, onScanFailure);
        cameraStatus.textContent = '';
        currentCameraId = cameraId;
        statusElement.textContent = "Escaneando...";
    } catch (error) {
        console.error(`Error al iniciar escáner con cámara ${cameraId}:`, error);
        cameraStatus.textContent = `Error al iniciar cámara: ${error.message}. Intenta seleccionar otra cámara.`;
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop().catch(e => console.error("Error al detener tras fallo:", e));
        }
        statusElement.textContent = "Error al iniciar.";
    }
}

async function stopScanner() {
    if (autoClearTimeout) clearTimeout(autoClearTimeout);
    autoClearTimeout = null;
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            await html5QrCode.stop();
            currentCameraId = null;
            statusElement.textContent = "Escáner detenido.";
            scannerPreview.classList.remove('scan-success-border');
        } catch (error) {
            console.error("Error al detener:", error);
            statusElement.textContent = "Error al detener.";
        }
    } else {
        statusElement.textContent = "Escáner no activo.";
    }
}

// --- Callbacks ---
function onScanSuccess(decodedText, decodedResult) {
    resultadoElement.value = decodedText;
    statusElement.textContent = "Código detectado ✅";

    scannerPreview.classList.add('scan-success-border');
    setTimeout(() => scannerPreview.classList.remove('scan-success-border'), 500);

    if (soundToggle.checked) playBeep();

    // Parseo GS1 y detección de proveedor
    const parsedData = parseGS1Data(decodedText);
    displayParsedData(parsedData);
    const proveedor = detectarProveedorMejorado(decodedText, parsedData);
    proveedorAutoElement.textContent = proveedor;

    if (window.html2canvas) {
        html2canvas(scannerPreview).then(canvas => {
            capturaContainer.innerHTML = "";
            capturaContainer.appendChild(canvas);
        }).catch(err => console.error("html2canvas error:", err));
    }

    if (autoClearToggle.checked) {
        if (autoClearTimeout) clearTimeout(autoClearTimeout);
        autoClearTimeout = setTimeout(clearScanResults, 3000);
    }
}

function onScanFailure(error) {
    // No mostrar errores comunes de "no encontrado" continuamente
    if (!error.includes("NotFoundException") && !error.includes("No QR code found")) {
         // console.warn(`Scan Failure: ${error}`); // Loguear si se desea
    }
    if (statusElement.textContent !== "Código detectado ✅") {
        statusElement.textContent = "Escaneando...";
    }
    scannerPreview.classList.remove('scan-success-border');
}

// --- Control UI ---
function switchTab(targetId) {
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(sec => sec.classList.remove('active'));
    const targetTab = document.querySelector(`.tab[data-tab-target='${targetId}']`);
    const targetSection = document.getElementById(targetId);
    if (targetTab) targetTab.classList.add('active');
    if (targetSection) targetSection.classList.add('active');

    if (targetId === 'scan') {
        if (currentCameraId) startScanner(currentCameraId);
        else initScanner();
        statusElement.textContent = "Esperando código...";
    } else {
        stopScanner();
    }
}

function toggleDarkMode() {
    document.body.classList.toggle('dark');
    document.body.classList.toggle('light');
}

function clearScanResults() {
    resultadoElement.value = '';
    proveedorAutoElement.textContent = '---';
    capturaContainer.innerHTML = '';
    gs1FieldsContainer.innerHTML = ''; // Limpiar datos GS1
    statusElement.textContent = html5QrCode && html5QrCode.isScanning ? "Escaneando..." : "Esperando código...";
    if (autoClearTimeout) clearTimeout(autoClearTimeout);
    autoClearTimeout = null;
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
        alert("Error al copiar.");
    });
}

function playBeep() {
    try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (!audioContext) return;
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.6, audioContext.currentTime + 0.01);
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
        oscillator.type = 'square';
        oscillator.start(audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.1);
        oscillator.stop(audioContext.currentTime + 0.1);
    } catch (e) {
        console.error("Error al reproducir sonido:", e);
    }
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        cameraStatus.textContent = 'Advertencia: La cámara requiere HTTPS.';
    }
    initScanner();

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
        navigator.serviceWorker.register('/service-worker.js') // Ajusta la ruta si es necesario
            .then(reg => console.log('Service Worker Registrado', reg))
            .catch(err => console.error('Error registro Service Worker', err));
    }
});

// --- Hacer funciones globales si se llaman desde HTML ---
// CORRECCIÓN: Asegurar que changeCamera esté disponible globalmente
window.changeCamera = changeCamera;
