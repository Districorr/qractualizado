// ==================================================================
//                      Variables Globales
// ==================================================================
let scanner;
let currentCameraId = null;
let html5QrCode = null;
let audioContext = null;
let autoClearTimeout = null;
let selectedProvider = 'auto'; // ***** NUEVO ***** Guarda la selección del proveedor

// ==================================================================
//                 Referencias a Elementos del DOM
// ==================================================================
const startScanButton = document.getElementById('start-scan-button');
const stopScanButton = document.getElementById('stop-scan-button');
const scannerControlsDiv = document.getElementById('scanner-controls');
const scannerActiveControlsDiv = document.getElementById('scanner-active-controls');
const providerSelector = document.getElementById('provider-selector'); // ***** NUEVO *****

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
const gs1ParsedDataDiv = document.getElementById('gs1-parsed-data'); // ***** NUEVO ***** Referencia al div contenedor
const gs1FieldsContainer = document.getElementById('gs1-fields');

// ==================================================================
//                      Constantes y Mapeos GS1
// ==================================================================
const FNC1 = '\u001d'; // Caracter Separador de Grupo GS1 (GS)

// Mapeo básico de AIs a descripciones (expandir según necesidad)
const gs1AIDescriptions = {
    '00': 'SSCC', '01': 'GTIN', '02': 'GTIN Contenido', '10': 'Lote',
    '11': 'Fecha Producción', '13': 'Fecha Empaquetado', '15': 'Fecha Cons. Pref.',
    '17': 'Fecha Caducidad', '21': 'Número de Serie', '22': 'ID Artículo (Hier.)', // Añadido 22 para BioProtece
    '240': 'ID Artículo Adicional',
    '241': 'ID Cliente', '30': 'Cantidad Variable', '37': 'Cantidad (Unidades)',
    '310': 'Peso Neto (kg)', '392': 'Precio Pagar (Variable)', '393': 'Precio Pagar (ISO)',
    '400': 'Nº Pedido Cliente', '410': 'Expedido a (GLN)', '414': 'GLN Localización',
    '8005': 'Precio Unidad', '90': 'Info. Mutua Acordada',
    // Añade más AIs según necesites
};

// ==================================================================
//                      Funciones de Parseo GS1 Base
// ==================================================================

// (getGS1Description y formatGS1Date permanecen igual que antes)
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
        console.error("Error parsing date:", e);
        return { formatted: `${yyMMdd} (Error fecha)`, isExpired: null, dateObj: null };
    }
}

// Parsea genéricamente TODOS los AIs posibles de GS1
function parseGS1DataGeneric(data) {
    const parsed = {};
    if (!data) return parsed;

    const fixedLengthAIs = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6, '410': 13, '414': 13, '8005': 6 };
    const variableLengthAIsPrefixes = ['10', '21', '22', '90', '240', '241', '30', '37', '392', '393', '400', '310']; // Incluir prefijos de variables

    let remainingData = data;
    let currentIndex = 0;

    while (currentIndex < remainingData.length) {
        let ai = null;
        let aiLen = 0;

        // Intentar identificar AI (priorizar 4, luego 3, luego 2 dígitos)
        for (let len = 4; len >= 2; len--) {
            const potentialAI = remainingData.substring(currentIndex, currentIndex + len);
            if (/^\d+$/.test(potentialAI) && (gs1AIDescriptions[potentialAI] || fixedLengthAIs[potentialAI] || variableLengthAIsPrefixes.some(prefix => potentialAI.startsWith(prefix)))) {
                ai = potentialAI;
                aiLen = len;
                break;
            }
        }

        if (!ai) {
            console.warn("No se pudo encontrar AI GS1 conocido en:", remainingData.substring(currentIndex));
            break; // No se pudo identificar, detener
        }

        let value;
        let nextIndex;
        const isFixed = fixedLengthAIs[ai];
        const isVariable = variableLengthAIsPrefixes.some(prefix => ai.startsWith(prefix)) && !isFixed;

        if (isFixed) {
            const valueLength = fixedLengthAIs[ai];
            if (remainingData.length >= currentIndex + aiLen + valueLength) {
                value = remainingData.substring(currentIndex + aiLen, currentIndex + aiLen + valueLength);
                nextIndex = currentIndex + aiLen + valueLength;
            } else {
                value = remainingData.substring(currentIndex + aiLen); // Tomar lo que queda si no alcanza
                nextIndex = remainingData.length;
            }
        } else if (isVariable) { // Longitud variable
            const fnc1Pos = remainingData.indexOf(FNC1, currentIndex + aiLen);
            if (fnc1Pos !== -1) {
                value = remainingData.substring(currentIndex + aiLen, fnc1Pos);
                nextIndex = fnc1Pos + 1; // Saltar el FNC1
            } else {
                value = remainingData.substring(currentIndex + aiLen); // Hasta el final si no hay FNC1
                nextIndex = remainingData.length;
            }
        } else {
             console.warn("AI no reconocido como fijo ni variable:", ai);
             break; // AI no manejado
        }

        parsed[ai] = value;
        currentIndex = nextIndex;

        // Consumir FNC1 si está justo después (para casos fijos seguidos de variables)
         if (currentIndex < remainingData.length && remainingData.charAt(currentIndex) === FNC1) {
             currentIndex++;
         }
    }

    // Procesamiento adicional post-parseo (formateo fechas, pesos, etc.)
    Object.keys(parsed).forEach(ai => {
        // Formateo Fechas
        if (['11', '13', '15', '17'].includes(ai)) {
            const dateInfo = formatGS1Date(parsed[ai]);
            parsed[`${ai}_formatted`] = dateInfo.formatted;
             // Guardar valor raw también
             parsed[`${ai}_raw`] = parsed[ai];
            if (['15', '17'].includes(ai)) parsed[`${ai}_expired`] = dateInfo.isExpired;
        }
        // Formateo Pesos (ejemplo 310n)
        if (/^310\d$/.test(ai) && parsed[ai]) {
            const decimals = parseInt(ai[3], 10);
            const numValue = parseInt(parsed[ai], 10);
            if (!isNaN(numValue) && !isNaN(decimals)) {
                 parsed[`${ai}_numeric`] = numValue / Math.pow(10, decimals);
                 parsed[`${ai}_formatted`] = parsed[`${ai}_numeric`].toFixed(decimals) + ' kg';
            }
             parsed[`${ai}_raw`] = parsed[ai]; // Guardar valor raw
        }
        // Podrías añadir formateo para precios (392n, 393n) u otros aquí
    });

    return parsed;
}


// ***** NUEVO: Funciones de Parseo Específicas *****

function parseBioproteceData(data) {
    const genericParsed = parseGS1DataGeneric(data);
    const result = {
        provider: 'BIOPROTECE',
        fields: {},
        rawData: data
    };
    const relevantAIs = {
        '21': 'serie',
        '17': 'vencimiento',
        '10': 'lote',
        '22': 'codigoArticulo' // Usando AI '22' según instrucción
    };

    for (const ai in relevantAIs) {
        if (genericParsed[ai]) {
            const fieldName = relevantAIs[ai];
            if (ai === '17') { // Si es vencimiento, usar el formateado
                 result.fields[fieldName] = genericParsed[`${ai}_formatted`] || genericParsed[ai];
                 result.fields[`${fieldName}_raw`] = genericParsed[`${ai}_raw`] || genericParsed[ai];
                 result.fields[`${fieldName}_expired`] = genericParsed[`${ai}_expired`];
            } else {
                 result.fields[fieldName] = genericParsed[ai];
            }
        }
    }
    return result;
}

function parseSaiData(data) {
    const genericParsed = parseGS1DataGeneric(data);
    const result = {
        provider: 'SAI',
        fields: {},
        rawData: data
    };
    const relevantAIs = {
        '01': 'gtin',
        '17': 'vencimiento',
        '10': 'lote',
        '240': 'codigoArticulo' // Usando AI '240' según instrucción
    };

    for (const ai in relevantAIs) {
        if (genericParsed[ai]) {
            const fieldName = relevantAIs[ai];
            if (ai === '17') { // Si es vencimiento, usar el formateado
                 result.fields[fieldName] = genericParsed[`${ai}_formatted`] || genericParsed[ai];
                 result.fields[`${fieldName}_raw`] = genericParsed[`${ai}_raw`] || genericParsed[ai];
                 result.fields[`${fieldName}_expired`] = genericParsed[`${ai}_expired`];
            } else {
                 result.fields[fieldName] = genericParsed[ai];
            }
        }
    }
    return result;
}

// Función para parsear "Otros" o como fallback genérico
function parseGenericGS1(data) {
     const genericParsed = parseGS1DataGeneric(data);
     return {
         provider: 'GS1 Genérico',
         fields: genericParsed, // Devolver todos los campos parseados
         rawData: data
     };
}


/** // ***** MODIFICADO: displayParsedData ahora recibe el objeto estructurado *****
 * Muestra los datos parseados en el contenedor HTML correspondiente.
 * @param {object} parsedResultObject - El objeto resultante de las funciones de parseo específicas.
 */
function displayParsedData(parsedResultObject) {
    gs1FieldsContainer.innerHTML = ''; // Limpiar contenedor previo
    gs1ParsedDataDiv.style.display = 'none'; // Ocultar por defecto

    if (!parsedResultObject || !parsedResultObject.fields || Object.keys(parsedResultObject.fields).length === 0) {
        const p = document.createElement('p');
        p.textContent = `No se encontraron datos interpretables para ${parsedResultObject?.provider || 'el código'}.`;
        gs1FieldsContainer.appendChild(p);
        gs1ParsedDataDiv.style.display = 'block'; // Mostrar el mensaje
        return;
    }

    const title = document.createElement('h4');
    // Usar el nombre del proveedor del objeto resultado
    title.textContent = `Datos Interpretados (${parsedResultObject.provider}):`;
    gs1FieldsContainer.appendChild(title);

    gs1ParsedDataDiv.style.display = 'block'; // Mostrar contenedor

    // Mapeo de nombres internos a etiquetas legibles (ajustar según necesidad)
    const fieldLabels = {
        'serie': 'Serie',
        'lote': 'Lote',
        'vencimiento': 'Vencimiento',
        'vencimiento_raw': 'Vencimiento (Raw)', // Opcional mostrar raw
        'vencimiento_expired': null, // No mostrar directamente
        'codigoArticulo': 'Código Artículo',
        'gtin': 'GTIN',
        // ... añadir más mapeos si se usan otros nombres internos ...
    };

    // Si es genérico, iterar sobre los AIs directamente
    if (parsedResultObject.provider === 'GS1 Genérico') {
        for (const ai in parsedResultObject.fields) {
            // Saltar campos auxiliares internos (_formatted, _expired, _numeric, _raw)
            if (/_formatted$|_expired$|_numeric$|_raw$/.test(ai)) continue;

            const description = getGS1Description(ai);
            let displayValue = parsedResultObject.fields[`${ai}_formatted`] || parsedResultObject.fields[ai];

            const p = document.createElement('p');
            p.classList.add('gs1-field');
            p.innerHTML = `<strong>${ai} (${description}):</strong> `;

            const span = document.createElement('span');
            span.textContent = displayValue;
            // Resaltar si está expirado (para AI 15 y 17 genéricos)
            if (parsedResultObject.fields[`${ai}_expired`] === true && ['15', '17'].includes(ai)) {
                span.classList.add('expired');
            }
            p.appendChild(span);
            gs1FieldsContainer.appendChild(p);
        }
    } else { // Para proveedores específicos (SAI, BIOPROTECE)
        for (const fieldName in parsedResultObject.fields) {
            // Saltar campos _raw o _expired si no se quieren mostrar directamente
             if (fieldName.endsWith('_raw') || fieldName.endsWith('_expired')) continue;

            const label = fieldLabels[fieldName] || fieldName; // Usar etiqueta legible o el nombre interno
            let displayValue = parsedResultObject.fields[fieldName];

            const p = document.createElement('p');
            p.classList.add('gs1-field');
            p.innerHTML = `<strong>${label}:</strong> `;

            const span = document.createElement('span');
            span.textContent = displayValue;
            // Resaltar si es un campo de vencimiento y está expirado
            if (fieldName === 'vencimiento' && parsedResultObject.fields[`${fieldName}_expired`] === true) {
                span.classList.add('expired');
            }
            p.appendChild(span);
            gs1FieldsContainer.appendChild(p);
        }
    }
}

// --- Detección de Proveedor Mejorada ---
// (detectarProveedorMejorado permanece igual, se usa para el modo 'auto')
function detectarProveedorMejorado(textoCrudo, parsedGS1) {
    const patrones = {
        'BIOPROTECE': { gtinPrefix: '8411111', loteRegex: /^B\d{5,}$/i, textoSimple: 'BIOPROTECE', relevantAIs: ['21', '17', '10', '22'] },
        'SAI': { gtinPrefix: '8422222', serieRegex: /^SAI-[A-Z0-9]{4,}$/i, textoSimple: 'SAI', relevantAIs: ['01', '17', '10', '240'] }
    };

    // Prioridad: Verificar si los AIs presentes coinciden *exactamente* con los esperados (o un subset clave)
     if (parsedGS1) {
        const detectedAIs = Object.keys(parsedGS1).filter(k => !k.includes('_')); // Obtener AIs parseados
        for (const prov in patrones) {
            if (patrones[prov].relevantAIs) {
                // Verificar si los AIs clave están presentes
                 // Ejemplo simple: ¿está el AI diferenciador? (22 para Bio, 01/240 para SAI)
                 if (prov === 'BIOPROTECE' && detectedAIs.includes('22')) return `BIOPROTECE (por AI 22)`;
                 if (prov === 'SAI' && (detectedAIs.includes('01') || detectedAIs.includes('240'))) return `SAI (por AI 01/240)`;
            }
        }
     }


    // Luego intentar por patrones específicos si no hubo match por AIs clave
    if (parsedGS1 && parsedGS1['01']) {
        const gtin = parsedGS1['01'];
        for (const prov in patrones) {
            if (patrones[prov].gtinPrefix && gtin.startsWith(patrones[prov].gtinPrefix)) return `${prov} (por GTIN)`;
        }
    }
    if (parsedGS1 && parsedGS1['10']) {
        const lote = parsedGS1['10'];
        for (const prov in patrones) {
            if (patrones[prov].loteRegex && patrones[prov].loteRegex.test(lote)) return `${prov} (por Lote)`;
        }
    }
     if (parsedGS1 && parsedGS1['21']) { // Serie genérica puede aplicar a varios
        const serie = parsedGS1['21'];
        for (const prov in patrones) {
            if (patrones[prov].serieRegex && patrones[prov].serieRegex.test(serie)) return `${prov} (por Serie)`;
        }
    }
    // Fallback por texto
    const textoUpper = textoCrudo.toUpperCase();
    for (const prov in patrones) {
        if (patrones[prov].textoSimple && textoUpper.includes(patrones[prov].textoSimple.toUpperCase())) return `${prov} (por texto)`;
    }

    return "No identificado";
}


// --- Inicialización y Control del Escáner (sin cambios significativos respecto a la versión anterior) ---
async function initializeScannerAndCameraList() {
    cameraStatus.textContent = '';
    statusElement.textContent = "Buscando cámaras...";
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
             cameraStatus.textContent = 'Error: API de Cámara no soportada o bloqueada.';
             statusElement.textContent = "Error API Cámara";
             return null; // Indicar fallo
        }
        const devices = await Html5Qrcode.getCameras();
        cameraSelector.innerHTML = '<option value="">Seleccionar cámara...</option>';

        if (!devices || devices.length === 0) {
            cameraStatus.textContent = 'No se encontraron cámaras.';
            statusElement.textContent = "Sin Cámaras";
            return null; // Indicar fallo
        }

        devices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.id;
            option.text = device.label || `Cámara ${index + 1}`;
            cameraSelector.appendChild(option);
        });

        const backCam = devices.find(d => d.label && (d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('rear') || d.label.toLowerCase().includes('trás'))) || devices[0];

        if (backCam) {
            cameraSelector.value = backCam.id;
            console.log("Cámaras listas. Preseleccionada:", backCam.label || backCam.id);
            statusElement.textContent = "Listo para escanear";
            return backCam.id; // Devolver ID de cámara preseleccionada
        } else {
            cameraStatus.textContent = 'No se pudo preseleccionar cámara.';
            statusElement.textContent = "Error selección";
            return null; // Indicar fallo
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
        return null; // Indicar fallo
    }
}

async function startScanner(cameraId) {
    if (!cameraId) {
        cameraStatus.textContent = 'Error: No se proporcionó ID de cámara.';
        statusElement.textContent = "Error ID Cámara";
        showStartButtonUI();
        return;
    }
    statusElement.textContent = "Iniciando cámara...";
    cameraStatus.textContent = '';
    showScannerActiveUI();
    providerSelector.disabled = true; // ***** NUEVO ***** Deshabilitar selector al escanear
    cameraSelector.disabled = true; // ***** NUEVO ***** Deshabilitar selector al escanear

    try {
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop();
        }
        if (!html5QrCode) {
            html5QrCode = new Html5Qrcode("scanner-preview", { verbose: false });
        }

        const config = { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.7777778 };
        await html5QrCode.start(cameraId, config, onScanSuccess, onScanFailure);

        console.log("Escáner iniciado correctamente.");
        currentCameraId = cameraId;
        statusElement.textContent = "Escaneando...";
        cameraSelector.disabled = false; // ***** NUEVO ***** Habilitar selector después de iniciar

    } catch (error) {
        console.error(`Error al iniciar escáner con cámara ${cameraId}:`, error);
        cameraStatus.textContent = `Error al iniciar: ${error.name} - ${error.message}.`;
        statusElement.textContent = "Error al iniciar";
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop().catch(e => console.error("Error al detener tras fallo:", e));
        }
        currentCameraId = null;
        showStartButtonUI(); // Volver a UI inicial si falla
        providerSelector.disabled = false; // ***** NUEVO ***** Habilitar selector si falla
        cameraSelector.disabled = false; // ***** NUEVO ***** Habilitar selector si falla
    }
}

async function stopScanner() {
    if (autoClearTimeout) clearTimeout(autoClearTimeout);
    autoClearTimeout = null;
    providerSelector.disabled = false; // ***** NUEVO ***** Habilitar selector al detener
    cameraSelector.disabled = false; // ***** NUEVO ***** Habilitar selector al detener
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            console.log("Deteniendo escáner manualmente...");
            statusElement.textContent = "Deteniendo...";
            await html5QrCode.stop();
            console.log("Escáner detenido manualmente.");
        } catch (error) {
            console.error("Error al detener:", error);
        } finally {
             currentCameraId = null;
             scannerPreview.innerHTML = '';
             statusElement.textContent = "Escáner detenido.";
             showStartButtonUI();
        }
    } else {
        showStartButtonUI();
        statusElement.textContent = "Listo para iniciar.";
    }
}

// --- Callbacks de Escaneo ---
// ***** MODIFICADO: onScanSuccess ahora usa el proveedor seleccionado/detectado *****
function onScanSuccess(decodedText, decodedResult) {
    resultadoElement.value = decodedText;
    statusElement.textContent = "Código detectado ✅";
    gs1ParsedDataDiv.style.display = 'none'; // Ocultar mientras procesa

    scannerPreview.classList.add('scan-success-border');
    setTimeout(() => scannerPreview.classList.remove('scan-success-border'), 500);

    if (soundToggle.checked) playBeep();

    // Determinar qué proveedor usar
    let providerToUse = selectedProvider;
    let detectedProviderString = '---';
    let parsedData;

    if (providerToUse === 'auto') {
        const genericParsedForDetection = parseGS1DataGeneric(decodedText); // Parseo genérico para detectar
        detectedProviderString = detectarProveedorMejorado(decodedText, genericParsedForDetection);
        // Extraer el nombre base del proveedor detectado
        const detectedProvName = detectedProviderString.split(' ')[0].toLowerCase();
         console.log("Proveedor detectado:", detectedProvName);
        if (detectedProvName === 'bioprotece') {
            parsedData = parseBioproteceData(decodedText);
            providerToUse = 'BIOPROTECE (Auto)'; // Indicar que fue automático
        } else if (detectedProvName === 'sai') {
            parsedData = parseSaiData(decodedText);
            providerToUse = 'SAI (Auto)';
        } else {
             parsedData = parseGenericGS1(decodedText); // Fallback a genérico si no se detecta
             providerToUse = 'Otros (Auto)';
             detectedProviderString = "No Identificado (Genérico)"; // Actualizar string si no se detecta
        }
    } else if (providerToUse === 'bioprotece') {
        parsedData = parseBioproteceData(decodedText);
        detectedProviderString = 'BIOPROTECE (Manual)';
        providerToUse = 'BIOPROTECE (Manual)';
    } else if (providerToUse === 'sai') {
        parsedData = parseSaiData(decodedText);
        detectedProviderString = 'SAI (Manual)';
        providerToUse = 'SAI (Manual)';
    } else { // 'otros'
        parsedData = parseGenericGS1(decodedText);
        detectedProviderString = 'Otros (Manual)';
        providerToUse = 'Otros (Manual)';
    }

    // Mostrar el proveedor determinado
    proveedorAutoElement.textContent = detectedProviderString;

    // Mostrar los datos parseados según el proveedor
    displayParsedData(parsedData);

    // Captura Visual (sin cambios)
    if (window.html2canvas) {
        const videoElement = scannerPreview.querySelector('video');
        if (videoElement) {
            html2canvas(videoElement, { useCORS: true }).then(canvas => {
                capturaContainer.innerHTML = "";
                canvas.style.maxWidth = '150px';
                canvas.style.height = 'auto';
                capturaContainer.appendChild(canvas);
            }).catch(err => console.error("html2canvas error:", err));
        } else { console.warn("No <video> found for html2canvas"); }
    }

    // Limpieza Automática (sin cambios)
    if (autoClearToggle.checked) {
        if (autoClearTimeout) clearTimeout(autoClearTimeout);
        autoClearTimeout = setTimeout(clearScanResults, 3000);
    }
}

// (onScanFailure sin cambios significativos)
function onScanFailure(error) {
    if (statusElement.textContent === "Código detectado ✅") {
        statusElement.textContent = "Escaneando...";
    }
    if (!`${error}`.includes("NotFoundException")) {
         // console.warn(`Scan Failure: ${error}`);
    }
    scannerPreview.classList.remove('scan-success-border');
}

// --- Control de UI (sin cambios significativos) ---
function showStartButtonUI() {
    startScanButton.style.display = 'inline-block';
    scannerActiveControlsDiv.style.display = 'none';
    statusElement.textContent = "Listo para iniciar.";
    providerSelector.disabled = false; // Habilitar selector
    cameraSelector.disabled = true; // Deshabilitar selector cámara (no hay cámara activa)
}

function showScannerActiveUI() {
    startScanButton.style.display = 'none';
    scannerActiveControlsDiv.style.display = 'block';
    stopScanButton.style.display = 'inline-block';
     // Asegurarse que estén habilitados inicialmente (startScanner los deshabilitará/rehabilitará)
    providerSelector.disabled = true; // Deshabilitar mientras escanea
    cameraSelector.disabled = false;
}

function switchTab(targetId) {
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(sec => sec.classList.remove('active'));
    const targetTab = document.querySelector(`.tab[data-tab-target='${targetId}']`);
    const targetSection = document.getElementById(targetId);
    if (targetTab) targetTab.classList.add('active');
    if (targetSection) targetSection.classList.add('active');

    if (targetId === 'scan') {
        console.log("Cambiado a pestaña de Scan. Mostrando botón de inicio.");
        stopScanner(); // Detener si estaba activo en otra pestaña
        showStartButtonUI();
        statusElement.textContent = "Listo para iniciar.";
    } else {
        console.log("Saliendo de pestaña de Scan, deteniendo escáner si está activo...");
        stopScanner().catch(err => console.error("Error deteniendo escáner al cambiar de pestaña:", err));
    }
}

// (toggleDarkMode, clearScanResults, copyScanResult, playBeep sin cambios)
function toggleDarkMode() {
    document.body.classList.toggle('dark');
    document.body.classList.toggle('light');
    localStorage.setItem('darkMode', document.body.classList.contains('dark'));
    darkModeToggle.textContent = document.body.classList.contains('dark') ? '☀️' : '🌓';
}
function clearScanResults() {
    resultadoElement.value = '';
    proveedorAutoElement.textContent = '---';
    capturaContainer.innerHTML = '';
    gs1FieldsContainer.innerHTML = '';
    gs1ParsedDataDiv.style.display = 'none'; // Ocultar al limpiar
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
           textArea.value = textToCopy; textArea.style.position = 'fixed'; textArea.style.left = '-9999px';
           document.body.appendChild(textArea); textArea.focus(); textArea.select(); document.execCommand('copy');
           document.body.removeChild(textArea); copyButton.innerText = "Copiado!"; setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500);
        } catch (execErr) { console.error('Fallback copy failed:', execErr); alert("Error al copiar."); }
    });
}
function playBeep() {
    try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (!audioContext) { console.warn("Web Audio API no soportada."); return; }
        if (audioContext.state === 'suspended') { audioContext.resume(); }
        const oscillator = audioContext.createOscillator(); const gainNode = audioContext.createGain();
        oscillator.connect(gainNode); gainNode.connect(audioContext.destination);
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.01);
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime); oscillator.type = 'square';
        oscillator.start(audioContext.currentTime); gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.1);
        oscillator.stop(audioContext.currentTime + 0.1);
    } catch (e) { console.error("Error al reproducir sonido:", e); }
}

// --- Event Listeners y Arranque ---
document.addEventListener('DOMContentLoaded', () => {
    // Comprobar HTTPS
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
        cameraStatus.textContent = 'Advertencia: La cámara requiere HTTPS.';
        startScanButton.disabled = true;
        startScanButton.title = "Se requiere HTTPS para usar la cámara";
    }

    // --- Listener para el botón de INICIO ---
    if (startScanButton) {
        startScanButton.addEventListener('click', async () => {
            startScanButton.disabled = true;
            startScanButton.textContent = "Iniciando...";
            statusElement.textContent = "Buscando cámaras...";
            try {
                const cameraId = await initializeScannerAndCameraList(); // Obtiene cámaras y preselecciona
                if (cameraId) {
                    await startScanner(cameraId); // Inicia el escáner
                } else {
                     // El error ya se mostró en initializeScannerAndCameraList
                     showStartButtonUI(); // Mostrar botón de inicio de nuevo
                     startScanButton.textContent = "Iniciar Escaneo"; // Restaurar texto
                     startScanButton.disabled = false; // Habilitar botón
                }
            } catch (err) {
                console.error("Error en el flujo de inicio:", err);
                statusElement.textContent = "Error al iniciar.";
                startScanButton.disabled = false;
                startScanButton.textContent = "Iniciar Escaneo";
                showStartButtonUI();
            }
        });
    }

     // --- Listener para el botón de DETENER ---
    if (stopScanButton) {
        stopScanButton.addEventListener('click', () => {
            stopScanButton.disabled = true;
            stopScanner().finally(() => {
                stopScanButton.disabled = false;
                startScanButton.textContent = "Iniciar Escaneo"; // Restaurar texto botón inicio
            });
        });
    }

    // --- Listener para el selector de PROVEEDOR --- ***** NUEVO *****
    if (providerSelector) {
        providerSelector.addEventListener('change', (event) => {
            selectedProvider = event.target.value;
            console.log("Proveedor seleccionado:", selectedProvider);
            // Limpiar resultados anteriores si se cambia el proveedor manualmente
            // clearScanResults(); // Opcional: decidir si limpiar al cambiar proveedor
        });
    }

    // --- Listener para el selector de CÁMARA ---
    if (cameraSelector) {
        cameraSelector.addEventListener('change', (event) => {
             const selectedCameraId = event.target.value;
             handleCameraChange(selectedCameraId);
        });
    }

    // (Listeners para Tabs, Modo Oscuro, Botones Copiar/Limpiar, Service Worker sin cambios)
     tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-tab-target');
            if (targetId) switchTab(targetId);
        });
    });
    if (darkModeToggle) {
        if (localStorage.getItem('darkMode') === 'true') {
            document.body.classList.add('dark'); document.body.classList.remove('light');
        } else {
             document.body.classList.add('light'); document.body.classList.remove('dark');
        }
        darkModeToggle.textContent = document.body.classList.contains('dark') ? '☀️' : '🌓';
        darkModeToggle.addEventListener('click', toggleDarkMode);
    }
    if (copyButton) copyButton.addEventListener('click', copyScanResult);
    if (clearButton) clearButton.addEventListener('click', clearScanResults);
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js')
            .then(reg => console.log('SW Registrado:', reg.scope))
            .catch(err => console.error('Error registro SW:', err));
    }

     // Estado inicial de la UI
     showStartButtonUI();
     cameraSelector.disabled = true; // Deshabilitado hasta que se inicie

});

// --- Handler function for camera change ---
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

    if (html5QrCode && html5QrCode.isScanning) {
        // Detener primero
        await stopScanner();
        // Guardar el ID nuevo y simular clic en iniciar
        // (startScanner usará el currentCameraId actualizado)
        currentCameraId = cameraId;
        startScanButton.click();
         console.log("Cámara cambiada, reiniciando escaneo...");
    } else {
         // Si no estaba escaneando, solo guardar la selección
         currentCameraId = cameraId;
         cameraSelector.value = cameraId; // Asegurar que el select refleje la elección
         console.log("Cámara seleccionada para el próximo inicio:", cameraId);
    }
};
