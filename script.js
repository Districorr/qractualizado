// --- Elementos DOM ---
const providerSelect = document.getElementById('provider-select');
const toggleBtn = document.getElementById('toggle-scan-mode');
const exportBtn = document.getElementById('export-btn');
const exportXlsxBtn = document.getElementById('export-xlsx-btn');
const fieldChecks = document.querySelectorAll('.field-selector input[type=checkbox]');
const notification = document.getElementById('notification');
const readerDiv = document.getElementById('reader');
const resultBox = document.getElementById('qr-result');
const parsedDataContainer = document.getElementById('parsed-data'); // Div para detalles del último escaneo
const tableContainer = document.getElementById('table-placeholder'); // Div para la tabla de historial

// --- Estado de la Aplicación ---
let scanMode = 'qr'; // 'qr' o 'barcode'
let html5QrCode;
let isQuaggaInitialized = false;
let scannedData = JSON.parse(localStorage.getItem('scannedData')) || [];

// --- Constantes ---
const GS1_SEPARATOR_CHAR = '\u001d'; // GS1 FNC1 (Group Separator)
const GS1_SEPARATOR_REGEX = /\u001d/g;

// --- Funciones ---

// Notificaciones
function showNotification(msg, type = 'success', duration = 3000) {
    notification.innerHTML = `<div class="notification ${type}">${msg}</div>`;
    setTimeout(() => { notification.innerHTML = ''; }, duration);
}

// --- Lógica de Parseo GS1 ---

/**
 * Parsea una cadena GS1 (con o sin FNC1) en un objeto {ai: valor}.
 * Prioriza FNC1 como separador si existe.
 * @param {string} data Cadena GS1
 * @returns {object} Objeto con pares AI:Valor
 */
function parseGS1GenericWithFNC1(data) {
    const fields = {};
    if (!data) return fields;

    // Reemplazar posibles caracteres no imprimibles que a veces aparecen en lugar de FNC1
    const sanitizedData = data.replace(/[^ -~]/g, GS1_SEPARATOR_CHAR); // Mantener imprimibles + FNC1

    // Tabla de longitudes fijas conocidas
    const fixedLengthAIs = {
        '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6,
        '410': 13, '414': 13, '8005': 6, /* ... añadir más si son necesarios */
    };
    // AIs conocidos de longitud variable (solo los prefijos iniciales)
     // Ordenar por longitud descendente para evitar coincidencias parciales (ej: 310 antes de 31)
    const variableLengthAIPrefixes = ['393', '392', '241', '240', '25', '21', '22', '10', '30', '37', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99'];
     // Añadir prefijos de AIs con longitud variable definida por el 4to dígito (ej: 310n)
     for (let i = 310; i <= 369; i++) variableLengthAIPrefixes.push(String(i));


    let remainingData = sanitizedData;
    let currentIndex = 0;

    while (currentIndex < remainingData.length) {
        let ai = null;
        let aiLen = 0;
        let value = null;
        let nextIndex = currentIndex;
        let found = false;

        // Buscar el AI más largo posible que coincida
        for (let len = 4; len >= 2; len--) {
            const potentialAI = remainingData.substring(currentIndex, currentIndex + len);
            // Es un AI conocido de longitud fija?
            if (fixedLengthAIs[potentialAI] !== undefined) {
                ai = potentialAI;
                aiLen = len;
                const valueLength = fixedLengthAIs[ai];
                if (currentIndex + aiLen + valueLength <= remainingData.length) {
                    value = remainingData.substring(currentIndex + aiLen, currentIndex + aiLen + valueLength);
                    nextIndex = currentIndex + aiLen + valueLength;
                    found = true;
                    break;
                } else { // No hay suficientes datos para la longitud fija
                    value = remainingData.substring(currentIndex + aiLen); // Tomar lo que queda
                    nextIndex = remainingData.length;
                    found = true; // Aceptarlo aunque sea corto
                    break;
                }
            }
            // Es un AI conocido de longitud variable? (verificar prefijos)
             if (variableLengthAIPrefixes.some(prefix => potentialAI.startsWith(prefix))) {
                ai = potentialAI;
                aiLen = len;
                 // Buscar el próximo FNC1 o el final de la cadena
                 const fnc1Pos = remainingData.indexOf(GS1_SEPARATOR_CHAR, currentIndex + aiLen);
                 if (fnc1Pos !== -1) {
                     value = remainingData.substring(currentIndex + aiLen, fnc1Pos);
                     nextIndex = fnc1Pos + 1; // Saltar el FNC1
                 } else {
                     value = remainingData.substring(currentIndex + aiLen);
                     nextIndex = remainingData.length;
                 }
                 found = true;
                 break;
             }
        }

        if (!found) {
            // Si no se encontró un AI conocido, podría ser un código no GS1 o mal formado.
            // O podríamos intentar un parseo más simple si no hay FNC1.
             if (!sanitizedData.includes(GS1_SEPARATOR_CHAR) && currentIndex === 0) {
                 // Intento de parseo simple si no hay FNC1 (menos fiable)
                 console.warn("No se detectó FNC1, intentando parseo simple basado en prefijos comunes.");
                 // Este parseo simple es MUY básico y propenso a errores.
                 const match = remainingData.match(/^(\d{2,4})(.+)/);
                 if (match) {
                     fields[match[1]] = match[2].trim();
                 }
             } else {
                 console.warn("No se pudo identificar AI GS1 en:", remainingData.substring(currentIndex));
             }
            break; // Detener el parseo si no se identifica AI
        }

        if (ai && value !== null) {
            fields[ai] = value.trim(); // Guardar valor sin espacios extra
        }
        currentIndex = nextIndex;
    }

    return fields;
}


/**
 * Formatea una fecha GS1 YYMMDD a DD/MM/YYYY
 * @param {string} yymmdd Fecha en formato YYMMDD
 * @returns {string} Fecha formateada o la original si es inválida
 */
function formatGS1Date(yymmdd) {
    if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return yymmdd; // Devuelve original si no es válido
    try {
        const year = parseInt(yymmdd.substring(0, 2), 10);
        const month = parseInt(yymmdd.substring(2, 4), 10);
        const day = parseInt(yymmdd.substring(4, 6), 10);
        const currentYearLastTwoDigits = new Date().getFullYear() % 100;
        const fullYear = year <= (currentYearLastTwoDigits + 10) ? 2000 + year : 1900 + year; // Heurística simple para el siglo

        // Validación básica de fecha
        if (month < 1 || month > 12 || day < 1 || day > 31) return `${yymmdd} (Inválida)`;

        // Usar Date para validación más robusta (ej. 31 de Feb)
        const dateObj = new Date(Date.UTC(fullYear, month - 1, day));
        if (dateObj.getUTCDate() !== day || dateObj.getUTCMonth() !== month - 1 || dateObj.getUTCFullYear() !== fullYear) {
            return `${yymmdd} (Inválida)`;
        }

        const formattedDate = `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${fullYear}`;

        // Chequeo de Vencimiento
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Comparar solo fechas
        dateObj.setUTCHours(0,0,0,0); // Asegurar comparación UTC correcta
        const isExpired = dateObj < today;

        return `${formattedDate}${isExpired ? ' (¡Vencido!)' : ''}`;
    } catch (e) {
        console.error("Error formateando fecha:", e);
        return `${yymmdd} (Error)`; // Devuelve original con error
    }
}

/**
 * Estructura los datos parseados genéricamente según las reglas de BIOPROTECE.
 * @param {object} genericFields Objeto con campos parseados genéricamente.
 * @param {string} rawData Datos crudos escaneados.
 * @returns {object} Objeto estructurado para BIOPROTECE.
 */
function structureBioproteceData(genericFields, rawData) {
    const structured = {
        provider: 'BIOPROTECE',
        fields: {},
        rawData: rawData
    };
    // Mapeo de AI a nombre de campo deseado
    const mapping = { '21': 'Serie', '17': 'Vencimiento', '10': 'Lote', '22': 'Código Artículo' };
    for (const ai in mapping) {
        if (genericFields[ai]) {
            let value = genericFields[ai];
            if (ai === '17') {
                value = formatGS1Date(value); // Formatear fecha
            }
            structured.fields[mapping[ai]] = value;
        } else {
            structured.fields[mapping[ai]] = ''; // Añadir campo vacío si no se encontró
        }
    }
    // Añadir GTIN si existe, aunque no sea específico de la regla
    if (genericFields['01']) {
        structured.fields['GTIN'] = genericFields['01'];
    }

    return structured;
}

/**
 * Estructura los datos parseados genéricamente según las reglas de SAI.
 * @param {object} genericFields Objeto con campos parseados genéricamente.
 * @param {string} rawData Datos crudos escaneados.
 * @returns {object} Objeto estructurado para SAI.
 */
function structureSaiData(genericFields, rawData) {
    const structured = {
        provider: 'SAI',
        fields: {},
        rawData: rawData
    };
    // Mapeo de AI a nombre de campo deseado
    const mapping = { '01': 'GTIN', '17': 'Vencimiento', '10': 'Lote', '240': 'Código Artículo' };
     for (const ai in mapping) {
        if (genericFields[ai]) {
            let value = genericFields[ai];
            if (ai === '17') {
                value = formatGS1Date(value); // Formatear fecha
            }
            structured.fields[mapping[ai]] = value;
        } else {
             structured.fields[mapping[ai]] = ''; // Añadir campo vacío si no se encontró
        }
    }
     // Añadir Serie si existe
     if (genericFields['21']) {
        structured.fields['Serie'] = genericFields['21'];
     }

    return structured;
}

/**
 * Estructura los datos parseados genéricamente sin reglas específicas.
 * @param {object} genericFields Objeto con campos parseados genéricamente.
 * @param {string} rawData Datos crudos escaneados.
 * @returns {object} Objeto estructurado genérico.
 */
function structureGenericData(genericFields, rawData) {
     const structured = {
        provider: 'Genérico',
        fields: {}, // Campos específicos a mostrar
        rawData: rawData,
        allFields: genericFields // Guardar todos los campos parseados
    };
    // Mapear los AIs más comunes a nombres legibles para la visualización
    const commonMapping = { '01': 'GTIN', '10': 'Lote', '17': 'Vencimiento', '21': 'Serie', '22':'Código Art.(22)', '240':'Ref.(240)'};
     for (const ai in commonMapping) {
         if (genericFields[ai]) {
             let value = genericFields[ai];
             if (ai === '17') value = formatGS1Date(value);
             structured.fields[commonMapping[ai]] = value;
         }
     }
     // Opcional: Añadir otros campos detectados que no estén en el mapeo común
     for(const ai in genericFields) {
         if (!Object.values(commonMapping).includes(ai) && !commonMapping[ai]) { // Si no está ya mapeado
             structured.fields[`AI(${ai})`] = genericFields[ai];
         }
     }
     return structured;
}


/**
 * Muestra los campos específicos del último escaneo en el div #parsed-data.
 * @param {object} structuredData Objeto resultado de structureXxxData.
 */
function displayParsedFields(structuredData) {
    parsedDataContainer.innerHTML = ''; // Limpiar anterior
    if (!structuredData || !structuredData.fields || Object.keys(structuredData.fields).length === 0) {
        parsedDataContainer.innerHTML = '<p>No se pudieron extraer campos específicos.</p>';
        return;
    }

    const title = document.createElement('h4');
    title.textContent = `Datos (${structuredData.provider}):`;
    parsedDataContainer.appendChild(title);

    for (const fieldName in structuredData.fields) {
        if (structuredData.fields[fieldName]) { // Mostrar solo si tiene valor
            const p = document.createElement('p');
            const value = structuredData.fields[fieldName];
            const isExpired = value.includes && value.includes('¡Vencido!'); // Simple check

            p.innerHTML = `<strong>${fieldName}:</strong> <span class="${isExpired ? 'expired' : ''}">${value}</span>`;
            parsedDataContainer.appendChild(p);
        }
    }
}

// --- Lógica de la Tabla y Duplicados ---

function isDuplicate(newStructuredData) {
    // Ajustar la lógica de duplicados según sea necesario.
    // Este ejemplo busca duplicados por GTIN + Lote + Serie si existen.
    const newGTIN = newStructuredData.allFields ? newStructuredData.allFields['01'] : newStructuredData.fields['GTIN'];
    const newLote = newStructuredData.allFields ? newStructuredData.allFields['10'] : newStructuredData.fields['Lote'];
    const newSerie = newStructuredData.allFields ? newStructuredData.allFields['21'] : newStructuredData.fields['Serie'];

    return scannedData.some(existingRecord => {
        const existingGTIN = existingRecord.allFields ? existingRecord.allFields['01'] : existingRecord.fields['GTIN'];
        const existingLote = existingRecord.allFields ? existingRecord.allFields['10'] : existingRecord.fields['Lote'];
        const existingSerie = existingRecord.allFields ? existingRecord.allFields['21'] : existingRecord.fields['Serie'];

        // Considerar duplicado si GTIN coincide y (Lote O Serie coinciden, si ambos existen)
        // O adaptar según la necesidad real de unicidad.
         let match = existingGTIN && existingGTIN === newGTIN;
         if (match && newLote && existingLote) { // Si ambos tienen lote, deben coincidir
             match = match && (existingLote === newLote);
         }
         if (match && newSerie && existingSerie) { // Si ambos tienen serie, deben coincidir
            match = match && (existingSerie === newSerie);
         }
         // Si solo uno tiene lote o serie, ¿se considera duplicado? Ajustar aquí.
         // Ejemplo: si GTIN coincide y no hay ni lote ni serie en ambos, es duplicado.
         if (match && !newLote && !newSerie && !existingLote && !existingSerie) {
             return true;
         }

        return match;
    });
}

function renderTable() {
    tableContainer.innerHTML = ''; // Limpiar tabla anterior
    if (scannedData.length === 0) {
        tableContainer.innerHTML = '<p>No hay datos escaneados aún.</p>';
        return;
    }

    const table = document.createElement('table');
    const header = table.insertRow();

    // Usar los checkboxes para definir columnas a mostrar/exportar
    const cols = Array.from(fieldChecks)
                      .filter(ch => ch.checked)
                      .map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));

    // Crear cabecera
    header.innerHTML = cols.map(c => `<th>${c.text}</th>`).join('') + '<th>Acción</th>';

    // Crear filas de datos
    scannedData.forEach((storedRecord, idx) => {
        const tr = table.insertRow();
        // Usar allFields si existe (genérico) o fields (específico)
        const dataFields = storedRecord.allFields || storedRecord.fields;
        const provider = storedRecord.provider || 'N/A';

        cols.forEach(col => {
            let cellValue = '';
            if (col.value === 'provider') {
                cellValue = provider;
            } else {
                // Buscar el valor usando el AI como clave en dataFields (para genérico)
                // O buscar por nombre de campo si es específico (requeriría más lógica o almacenar AI también)
                // Simplificación: buscar por AI en allFields si está, si no, buscar en fields por nombre
                if (storedRecord.allFields && storedRecord.allFields[col.value]) {
                    cellValue = storedRecord.allFields[col.value];
                    // Formatear fecha si es AI 17
                    if (col.value === '17') {
                         cellValue = formatGS1Date(cellValue);
                    }
                } else {
                    // Buscar por el texto del label (ej: "GTIN(01)") podría ser frágil
                    // Una mejor forma sería que cols tuviera { value: '01', keyInFields: 'GTIN' }
                    // Por ahora, buscamos el valor del AI directamente
                     cellValue = dataFields[col.value] || '';
                     if (col.value === '17' && cellValue) { // Re-formatear si viene de fields
                         // Necesitamos el raw value aquí, esto se complica...
                         // Mejor guardar AIs siempre en la estructura almacenada
                         // --> Ajustaremos structureXyxData para guardar AIs también
                         // Por ahora, puede mostrar el valor formateado si viene de 'fields'
                     }
                }
            }
            tr.insertCell().textContent = cellValue;
        });

        // Botón de eliminar
        const cell = tr.insertCell();
        const btn = document.createElement('button');
        btn.textContent = '🗑️';
        btn.onclick = () => {
            scannedData.splice(idx, 1);
            localStorage.setItem('scannedData', JSON.stringify(scannedData));
            renderTable(); // Volver a renderizar la tabla
        };
        cell.appendChild(btn);
        tr.classList.add('highlight'); // Añadir animación
    });

    tableContainer.appendChild(table);
}


// --- Lógica de Exportación (Usa Checkboxes) ---
exportBtn.addEventListener('click', () => {
    if (scannedData.length === 0) return showNotification('No hay datos para exportar', 'error');
    const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));
    let csv = cols.map(c => `"${c.text}"`).join(',') + '\n'; // Encabezados CSV

    scannedData.forEach(storedRecord => {
        const rowValues = [];
        const dataFields = storedRecord.allFields || storedRecord.fields;
        const provider = storedRecord.provider || 'N/A';

        cols.forEach(col => {
            let cellValue = '';
            if (col.value === 'provider') {
                cellValue = provider;
            } else {
                cellValue = (storedRecord.allFields?.[col.value] || dataFields[col.value] || '');
                if (col.value === '17' && cellValue && /^\d{6}$/.test(storedRecord.allFields?.[col.value])) { // Solo formatear si es YYMMDD
                     cellValue = formatGS1Date(storedRecord.allFields[col.value]);
                 }
            }
             // Escapar comas y comillas para CSV
            cellValue = typeof cellValue === 'string' ? `"${cellValue.replace(/"/g, '""')}"` : cellValue;
            rowValues.push(cellValue);
        });
        csv += rowValues.join(',') + '\n';
    });

    const uri = 'data:text/csv;charset=utf-8,' + encodeURI(csv);
    const link = document.createElement('a');
    link.href = uri;
    link.download = 'escaneos.csv';
    link.click();
    showNotification('CSV exportado');
});

exportXlsxBtn.addEventListener('click', () => {
  if (scannedData.length === 0) return showNotification('No hay datos para exportar', 'error');
  const wb = XLSX.utils.book_new();
  const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));

  const data = scannedData.map(storedRecord => {
    let obj = {};
    const dataFields = storedRecord.allFields || storedRecord.fields;
    const provider = storedRecord.provider || 'N/A';

    cols.forEach(col => {
        let headerText = col.text; // Usar el texto del label como cabecera
        let cellValue = '';
         if (col.value === 'provider') {
             cellValue = provider;
         } else {
            cellValue = (storedRecord.allFields?.[col.value] || dataFields[col.value] || '');
             if (col.value === '17' && cellValue && /^\d{6}$/.test(storedRecord.allFields?.[col.value])) { // Formatear fecha si es YYMMDD
                 cellValue = formatGS1Date(storedRecord.allFields[col.value]);
             }
         }
        obj[headerText] = cellValue;
    });
    return obj;
  });

  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Scaneos');
  XLSX.writeFile(wb, 'scaneos.xlsx');
  showNotification('XLSX exportado');
});


// --- Manejador Principal de Escaneo ---
function onScanSuccess(decodedText) {
    resultBox.value = decodedText; // Mostrar resultado crudo siempre
    parsedDataContainer.innerHTML = ''; // Limpiar detalles previos

    const selectedProviderValue = providerSelect.value;
    let structuredData;

    try {
        const genericFields = parseGS1GenericWithFNC1(decodedText);

        if (Object.keys(genericFields).length === 0 && decodedText.length > 0) {
             // Si el parseo GS1 no encontró nada pero hay texto, tratarlo como texto simple
             structuredData = {
                 provider: selectedProviderValue || 'Texto Simple',
                 fields: { 'Texto': decodedText },
                 rawData: decodedText,
                 allFields: {} // Sin campos GS1
             };
              showNotification('Código leído como texto simple', 'warning');
        } else {
             // Proceder con la estructuración basada en proveedor
            switch (selectedProviderValue) {
                case 'bioprotece':
                    structuredData = structureBioproteceData(genericFields, decodedText);
                    break;
                case 'sai':
                    structuredData = structureSaiData(genericFields, decodedText);
                    break;
                default: // Automático o Genérico
                    structuredData = structureGenericData(genericFields, decodedText);
                    // Podríamos intentar detectar aquí si es automático, pero por ahora lo dejamos genérico
                    break;
            }
         }

        // Validar campos esenciales (opcional, ej: GTIN)
        // const gtin = structuredData.allFields ? structuredData.allFields['01'] : structuredData.fields['GTIN'];
        // if (!gtin) {
        //      showNotification('Advertencia: Código GTIN (01) no encontrado en el escaneo.', 'warning');
        //      // Podrías decidir no añadirlo a la tabla si GTIN es obligatorio
        //      // return;
        // }


        // Mostrar campos parseados del último escaneo
        displayParsedFields(structuredData);

        // Verificar duplicados ANTES de añadir
        if (isDuplicate(structuredData)) {
            showNotification('Este código ya fue escaneado anteriormente.', 'error');
            return; // No añadir duplicado
        }

        // Añadir a la lista y guardar
        scannedData.push(structuredData);
        localStorage.setItem('scannedData', JSON.stringify(scannedData));
        renderTable(); // Actualizar tabla de historial
        showNotification(`Escaneo (${structuredData.provider}) añadido con éxito`);

    } catch (error) {
        console.error("Error procesando el escaneo:", error);
        showNotification(`Error al procesar: ${error.message}`, 'error');
         // Mostrar sólo el texto crudo si el parseo falla
         parsedDataContainer.innerHTML = `<p>Error al interpretar los datos.</p>`;
    }
}

function onScanFailure(error) {
    // No mostrar errores frecuentes de "no encontrado" en consola
    // console.warn(`Error de escaneo: ${error}`);
}

// --- Inicialización y Control de Escáneres ---

// QR Scanner (html5-qrcode)
function startQRScanner() {
    stopBarcodeScanner(); // Asegurar que Quagga esté detenido
    readerDiv.innerHTML = ''; // Limpiar div por si Quagga dejó algo
    html5QrCode = new Html5Qrcode("reader");
    const config = { fps: 10, qrbox: { width: 250, height: 150 } }; // Config simple

    Html5Qrcode.getCameras().then(cameras => {
        if (cameras && cameras.length) {
            // Intentar usar la última cámara o la primera trasera/frontal disponible
            const cameraId = cameras[0].id; // Simplificado: usar la primera cámara
            html5QrCode.start(cameraId, config, onScanSuccess, onScanFailure)
                .then(() => {
                    console.log("Escáner QR iniciado.");
                    showNotification("Escáner QR activo", "success", 1500);
                })
                .catch(err => {
                    console.error("Error al iniciar escáner QR:", err);
                    showNotification("Error al iniciar QR: " + err, "error");
                });
        } else {
            console.error("No se encontraron cámaras.");
            showNotification("No se encontraron cámaras", "error");
        }
    }).catch(err => {
        console.error("Error al obtener cámaras:", err);
        showNotification("Error al obtener cámaras: " + err, "error");
    });
}

function stopQRScanner() {
    if (html5QrCode) {
        html5QrCode.stop().then(() => {
            console.log("Escáner QR detenido.");
            readerDiv.innerHTML = ''; // Limpiar vista previa
        }).catch(err => {
            console.error("Error al detener escáner QR:", err);
        });
        html5QrCode = null; // Liberar instancia
    }
}

// Barcode Scanner (QuaggaJS) - Más propenso a errores en móviles
function startBarcodeScanner() {
    stopQRScanner(); // Asegurar que html5-qrcode esté detenido
    readerDiv.innerHTML = ''; // Limpiar div

    if (!isQuaggaInitialized) {
         try {
            Quagga.init({
                inputStream: {
                    name: "Live",
                    type: "LiveStream",
                    target: readerDiv, // Adjuntar al div #reader
                    constraints: { // Intentar forzar cámara trasera
                        //width: 640, // Reducir resolución puede ayudar
                        //height: 480,
                        facingMode: "environment"
                    },
                    area: { // Opcional: restringir área de detección
                         top: "20%", bottom: "20%", left: "10%", right: "10%"
                    }
                },
                locator: { patchSize: "medium", halfSample: true },
                 numOfWorkers: navigator.hardwareConcurrency || 2, // Usar cores disponibles
                 frequency: 10, // Intentos por segundo
                decoder: {
                    readers: [
                        "code_128_reader",
                        "ean_reader",
                        "ean_8_reader",
                        "code_39_reader",
                        "codabar_reader",
                        "upc_reader",
                        "i2of5_reader" // ITF
                    ],
                    debug: { // Opcional: mostrar líneas de detección
                         // drawBoundingBox: true, drawScanline: true
                     }
                },
                locate: true
            }, (err) => {
                if (err) {
                    console.error("Error de inicialización Quagga:", err);
                    showNotification("Error al iniciar escáner de barras: " + err, "error");
                    return;
                }
                console.log("Quagga inicializado.");
                isQuaggaInitialized = true;
                Quagga.start();
                showNotification("Escáner de Barras activo", "success", 1500);
            });
        } catch (err) {
             console.error("Excepción al inicializar Quagga:", err);
              showNotification("Error crítico al iniciar escáner de barras.", "error");
        }

        Quagga.onDetected((result) => {
            if (result && result.codeResult && result.codeResult.code) {
                onScanSuccess(result.codeResult.code);
                // Podríamos detener Quagga aquí para evitar escaneos múltiples rápidos
                 // stopBarcodeScanner();
                 // setTimeout(startBarcodeScanner, 1000); // Reiniciar después de un delay
            }
        });

         Quagga.onProcessed(result => {
             // Se puede usar para dibujar cuadros, etc.
         });

    } else {
         // Si ya está inicializado, solo iniciar
         Quagga.start();
         showNotification("Escáner de Barras activo", "success", 1500);
    }
}

function stopBarcodeScanner() {
    if (isQuaggaInitialized) { // Solo detener si se inicializó o inició
        try {
             Quagga.stop();
             console.log("Escáner de Barras detenido.");
             // Quagga a veces no limpia el video, forzar limpieza:
             const video = readerDiv.querySelector('video');
             if (video) readerDiv.removeChild(video);
             const canvas = readerDiv.querySelector('canvas');
              if (canvas) readerDiv.removeChild(canvas);
              // No resetear isQuaggaInitialized aquí si queremos reanudar rápido
             // isQuaggaInitialized = false; // Descomentar si se quiere forzar re-init
        } catch (err) {
            console.error("Error al detener Quagga:", err);
        }

    }
}

// --- Toggle de Modo ---
toggleBtn.addEventListener('click', () => {
  if (scanMode === 'qr') {
    stopQRScanner();
    startBarcodeScanner();
    toggleBtn.textContent = 'Modo Barras';
    scanMode = 'barcode';
  } else {
    stopBarcodeScanner();
    startQRScanner();
    toggleBtn.textContent = 'Modo QR';
    scanMode = 'qr';
  }
});

// --- Inicialización al Cargar ---
document.addEventListener('DOMContentLoaded', () => {
  renderTable(); // Mostrar tabla guardada al inicio
  startQRScanner(); // Iniciar en modo QR por defecto
});

// Listener para los checkboxes de exportación (para actualizar la tabla si cambian)
fieldChecks.forEach(checkbox => {
    checkbox.addEventListener('change', renderTable);
});
