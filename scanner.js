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
const startScanButton = document.getElementById('start-scan-button');
const stopScanButton = document.getElementById('stop-scan-button');
const scannerControlsDiv = document.getElementById('scanner-controls'); // Contenedor principal
const scannerActiveControlsDiv = document.getElementById('scanner-active-controls'); // Contenedor de controles activos

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
// ESTA FUNCIÓN AHORA SOLO PREPARA, NO INICIA EL ESCÁNER DIRECTAMENTE
async function initScanner() {
    cameraStatus.textContent = ''; // Limpiar estado previo
    statusElement.textContent = "Buscando cámaras...";

    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
             cameraStatus.textContent = 'Error: API de Cámara no soportada o bloqueada.';
             console.error('MediaDevices API not available.');
             statusElement.textContent = "Error API Cámara";
             // Mantener botón de inicio visible para reintentar si es un problema temporal
             return;
        }

        // Obtener permiso y enumerar cámaras
        const devices = await Html5Qrcode.getCameras();
        cameraSelector.innerHTML = '<option value="">Seleccionar cámara...</option>'; // Limpiar selector

        if (!devices || devices.length === 0) {
            cameraStatus.textContent = 'No se encontraron cámaras.';
            statusElement.textContent = "Sin Cámaras";
             // Mantener botón de inicio visible
            return;
        }

        devices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.id;
            option.text = device.label || `Cámara ${index + 1}`;
            cameraSelector.appendChild(option);
        });

        // Preseleccionar cámara trasera o la primera
        const backCam = devices.find(d => d.label && (d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('rear') || d.label.toLowerCase().includes('trás'))) || devices[0];

        if (backCam) {
            cameraSelector.value = backCam.id;
            currentCameraId = backCam.id; // Guardar ID seleccionado
             console.log("Cámaras encontradas, lista actualizada. Cámara preseleccionada:", backCam.label || backCam.id);
             // NO iniciar el escáner aquí, esperar al botón
             await startScanner(currentCameraId); // AHORA SÍ INICIAMOS
        } else {
            cameraStatus.textContent = 'No se pudo preseleccionar cámara.';
             statusElement.textContent = "Error selección";
             // Mantener botón de inicio visible
        }

    } catch (error) {
        console.error('Error inicializando cámaras:', error);
        if (`${error}`.toLowerCase().includes('permission denied') || `${error}`.toLowerCase().includes('notallowederror')) {
            cameraStatus.textContent = `Error: Permiso de cámara denegado. Revisa los permisos del navegador/sitio.`;
            statusElement.textContent = "Permiso Denegado";
        } else {
            cameraStatus.textContent = `Error al acceder cámara: ${error.name} - ${error.message}. (¿HTTPS necesario?)`;
            statusElement.textContent = "Error Cámara";
        }
        // Mantener botón de inicio visible
        showStartButtonUI(); // Asegurarse de que el botón de inicio esté visible si falla
    }
}

// --- Control del Escáner ---
async function startScanner(cameraId) {
    if (!cameraId) {
        cameraStatus.textContent = 'Error: No se seleccionó ID de cámara.';
        statusElement.textContent = "Error ID Cámara";
        showStartButtonUI(); // Mostrar botón de inicio si falla
        return;
    }
    statusElement.textContent = "Iniciando cámara...";
    cameraStatus.textContent = ''; // Limpiar error previo
    showScannerActiveUI(); // Mostrar UI del escáner activo

    try {
        if (html5QrCode && html5QrCode.isScanning) {
            console.log("Deteniendo escáner existente...");
            await html5QrCode.stop();
            console.log("Escáner detenido.");
        }
        if (!html5QrCode) {
            html5QrCode = new Html5Qrcode("scanner-preview", { verbose: false });
             console.log("Instancia Html5Qrcode creada.");
        }

        const config = {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            aspectRatio: 1.7777778 // 16:9 aprox.
        };

        console.log(`Iniciando escáner con cámara ID: ${cameraId}`, config);
        await html5QrCode.start(
            cameraId,
            config,
            onScanSuccess,
            onScanFailure
        );
        console.log("Escáner iniciado correctamente.");
        cameraStatus.textContent = ''; // Limpiar si hubo error antes
        currentCameraId = cameraId;
        statusElement.textContent = "Escaneando...";
        // UI ya se mostró al inicio de la función

    } catch (error) {
        console.error(`Error al iniciar escáner con cámara ${cameraId}:`, error);
        cameraStatus.textContent = `Error al iniciar: ${error.name} - ${error.message}. Intenta seleccionar otra cámara o recargar.`;
        statusElement.textContent = "Error al iniciar";
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop().catch(e => console.error("Error al detener tras fallo:", e));
        }
        currentCameraId = null;
        showStartButtonUI(); // Mostrar botón de inicio si falla
    }
}

async function stopScanner() {
    if (autoClearTimeout) clearTimeout(autoClearTimeout);
    autoClearTimeout = null;
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            console.log("Deteniendo escáner manualmente...");
            statusElement.textContent = "Deteniendo...";
            await html5QrCode.stop();
            console.log("Escáner detenido manualmente.");
        } catch (error) {
            console.error("Error al detener:", error);
            statusElement.textContent = "Error al detener.";
        } finally {
             currentCameraId = null; // Resetear cámara
             scannerPreview.innerHTML = ''; // Limpiar vista previa
             statusElement.textContent = "Escáner detenido.";
             showStartButtonUI(); // Mostrar UI inicial
        }
    } else {
        console.log("Intento de detener, pero el escáner no estaba activo.");
        showStartButtonUI(); // Asegurar que la UI esté en estado inicial
        statusElement.textContent = "Listo para iniciar.";
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
        // Asegurarse que el elemento de video exista dentro del preview
        const videoElement = scannerPreview.querySelector('video');
        if (videoElement) {
            html2canvas(videoElement, { // Capturar el video directamente si es posible
                useCORS: true // Puede ser necesario si el video viene de otra fuente (menos probable aquí)
            }).then(canvas => {
                capturaContainer.innerHTML = ""; // Limpiar contenedor previo
                // Forzar tamaño para que no sea gigante
                canvas.style.maxWidth = '150px';
                canvas.style.height = 'auto';
                capturaContainer.appendChild(canvas);
            }).catch(err => console.error("html2canvas error:", err));
        } else {
             console.warn("No se encontró elemento <video> para html2canvas");
        }
    } else {
         console.warn("html2canvas no está cargado.");
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
        statusElement.textContent = "Escaneando..."; // Resetear si hubo éxito previo
    }
    // No loguear errores comunes a menos que se esté depurando
    if (!`${error}`.includes("NotFoundException")) {
        // console.warn(`Scan Failure: ${error}`); // Descomentar para depurar
    }
    // Quitar borde verde si hubo un fallo después de un éxito
    scannerPreview.classList.remove('scan-success-border');
}

// --- Control de UI ---

// NUEVO: Funciones para manejar la visibilidad de la UI
function showStartButtonUI() {
    startScanButton.style.display = 'inline-block';
    scannerActiveControlsDiv.style.display = 'none';
    statusElement.textContent = "Listo para iniciar."; // Mensaje inicial
}

function showScannerActiveUI() {
    startScanButton.style.display = 'none';
    scannerActiveControlsDiv.style.display = 'block';
    // Asegurarse que stopScanButton esté visible
    stopScanButton.style.display = 'inline-block';
}

function switchTab(targetId) {
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(sec => sec.classList.remove('active'));
    const targetTab = document.querySelector(`.tab[data-tab-target='${targetId}']`);
    const targetSection = document.getElementById(targetId);
    if (targetTab) targetTab.classList.add('active');
    if (targetSection) targetSection.classList.add('active');

    if (targetId === 'scan') {
        // Al volver a la pestaña de scan, NO iniciar automáticamente.
        // Mostrar el botón de inicio para que el usuario decida.
        console.log("Cambiado a pestaña de Scan. Mostrando botón de inicio.");
        showStartButtonUI();
        statusElement.textContent = "Listo para iniciar.";
    } else {
        // Detener escáner al salir de la pestaña
        console.log("Saliendo de pestaña de Scan, deteniendo escáner si está activo...");
        stopScanner().catch(err => console.error("Error deteniendo escáner al cambiar de pestaña:", err));
    }
}

function toggleDarkMode() {
    document.body.classList.toggle('dark');
    document.body.classList.toggle('light'); // Añadir o quitar 'light'
    localStorage.setItem('darkMode', document.body.classList.contains('dark'));
    darkModeToggle.textContent = document.body.classList.contains('dark') ? '☀️' : '🌓';
}

function clearScanResults() {
    resultadoElement.value = '';
    proveedorAutoElement.textContent = '---';
    capturaContainer.innerHTML = '';
    gs1FieldsContainer.innerHTML = ''; // Limpiar datos GS1
    statusElement.textContent = html5QrCode && html5QrCode.isScanning ? "Escaneando..." : "Listo para iniciar.";
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
        try {
           const textArea = document.createElement("textarea");
           textArea.value = textToCopy;
           textArea.style.position = 'fixed'; // Evitar scroll
           textArea.style.left = '-9999px';
           document.body.appendChild(textArea);
           textArea.focus();
           textArea.select();
           document.execCommand('copy');
           document.body.removeChild(textArea);
           copyButton.innerText = "Copiado!";
           setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500);
        } catch (execErr) {
            console.error('Fallback copy failed:', execErr);
           alert("Error al copiar al portapapeles.");
        }
    });
}

function playBeep() {
    try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (!audioContext) { console.warn("Web Audio API no soportada."); return; }
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.01);
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
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
         // Podrías incluso deshabilitar el botón de inicio aquí si no es HTTPS
         // startScanButton.disabled = true;
         // startScanButton.title = "Se requiere HTTPS para usar la cámara";
    }

    // --- Listener para el botón de INICIO ---
    if (startScanButton) {
        startScanButton.addEventListener('click', () => {
            startScanButton.disabled = true; // Deshabilitar mientras inicia
            statusElement.textContent = "Solicitando permiso...";
            initScanner() // Llama a la función que ahora inicia el escáner
                .then(() => {
                    // initScanner ahora llama a startScanner, que actualiza la UI en éxito/fallo
                    // startScanButton.disabled = false; // Re-enable ONLY if init fails within its own catch block
                })
                .catch(err => {
                    console.error("Error en el flujo de inicio:", err);
                    statusElement.textContent = "Error al iniciar.";
                    startScanButton.disabled = false; // Re-habilitar si falla aquí
                    showStartButtonUI(); // Asegurar UI inicial
                });
        });
    }

     // --- Listener para el botón de DETENER ---
    if (stopScanButton) {
        stopScanButton.addEventListener('click', () => {
            stopScanButton.disabled = true; // Deshabilitar mientras detiene
            stopScanner().finally(() => {
                stopScanButton.disabled = false; // Re-habilitar después de intentar detener
            });
        });
    }


    // --- Listener para el selector de cámara ---
    if (cameraSelector) {
        cameraSelector.addEventListener('change', (event) => {
             const selectedCameraId = event.target.value;
             if (selectedCameraId && html5QrCode && html5QrCode.isScanning) {
                 // Solo cambiar si el escáner está activo
                 handleCameraChange(selectedCameraId);
             } else if (!selectedCameraId && html5QrCode && html5QrCode.isScanning) {
                 // Si seleccionan la opción vacía mientras escanea, detener.
                 stopScanner();
             } else if (selectedCameraId && !html5QrCode?.isScanning) {
                 // Si seleccionan una cámara pero no está escaneando, guardar el ID
                 // para usarlo la próxima vez que presionen "Iniciar"
                 currentCameraId = selectedCameraId;
                 console.log("Cámara preseleccionada para el próximo inicio:", selectedCameraId);
             }
        });
    }

    // Listeners para Tabs
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-tab-target');
            if (targetId) switchTab(targetId);
        });
    });

    // Listener para Modo Oscuro
    if (darkModeToggle) {
        if (localStorage.getItem('darkMode') === 'true') {
            document.body.classList.add('dark');
             document.body.classList.remove('light'); // Asegurarse que light no esté
        } else {
             document.body.classList.add('light');
             document.body.classList.remove('dark'); // Asegurarse que dark no esté
        }
        darkModeToggle.textContent = document.body.classList.contains('dark') ? '☀️' : '🌓';
        darkModeToggle.addEventListener('click', toggleDarkMode);
    }


    // Listeners para Botones de Acción (Copiar/Limpiar)
    if (copyButton) copyButton.addEventListener('click', copyScanResult);
    if (clearButton) clearButton.addEventListener('click', clearScanResults);

    // Registrar Service Worker para PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js')
            .then(reg => console.log('Service Worker Registrado:', reg.scope))
            .catch(err => console.error('Error registro Service Worker:', err));
    }

     // Estado inicial de la UI
     showStartButtonUI();

});

// --- Handler function for camera change ---
// ESTA FUNCIÓN AHORA SOLO REINICIA EL ESCÁNER SI YA ESTÁ CORRIENDO
async function handleCameraChange(cameraId) {
    if (!cameraId) {
        console.log("Selección de cámara vacía, deteniendo.");
        await stopScanner();
        return;
    }
    if (cameraId === currentCameraId) {
        console.log("Cámara seleccionada ya está activa.");
        return;
    }
    console.log(`Cambiando cámara a: ${cameraId}`);
    // Detener y reiniciar con la nueva cámara
    if (html5QrCode && html5QrCode.isScanning) {
        await stopScanner(); // Detiene y actualiza UI
        // El usuario tendrá que volver a pulsar "Iniciar" si quiere usar la cámara seleccionada
        // O podríamos iniciarla automáticamente aquí:
        currentCameraId = cameraId; // Guardamos la selección
        startScanButton.click(); // Simulamos clic en iniciar con la nueva cámara preseleccionada
        console.log("Cámara cambiada, reiniciando escaneo...");
        // await startScanner(cameraId); // Alternativa: iniciar directamente sin simular clic
    } else {
         currentCameraId = cameraId; // Solo guardar la selección si no estaba escaneando
         console.log("Cámara seleccionada para el próximo inicio:", cameraId);
    }
};

// Ya no se necesita la asignación global
// window.changeCamera = handleCameraChange;
