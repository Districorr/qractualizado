// --- Elementos DOM ---
const providerSelect = document.getElementById('provider-select');
const toggleBtn = document.getElementById('toggle-scan-mode');
const exportBtn = document.getElementById('export-btn');
const exportXlsxBtn = document.getElementById('export-xlsx-btn');
const fieldChecks = document.querySelectorAll('.field-selector input[type=checkbox]');
const notification = document.getElementById('notification');
const readerDiv = document.getElementById('reader');
const resultBox = document.getElementById('qr-result');
const parsedDataContainer = document.getElementById('parsed-data');
const tableContainer = document.getElementById('table-placeholder');
const startScanButton = document.getElementById('start-scan-button'); // Asumiendo que el HTML anterior lo tiene
const stopScanButton = document.getElementById('stop-scan-button'); // Asumiendo que el HTML anterior lo tiene
const scannerActiveControlsDiv = document.getElementById('scanner-active-controls'); // Asumiendo que el HTML anterior lo tiene
const cameraSelector = document.getElementById('camera-selector');
const cameraStatus = document.getElementById('camera-status');
const statusElement = document.getElementById('status');

// --- Estado de la Aplicación ---
let scanMode = 'qr';
let html5QrCode;
let isQuaggaInitialized = false;
let scannedData = JSON.parse(localStorage.getItem('scannedData')) || [];
let currentCameraId = null;
let availableCameras = [];
let isScanning = false;

// --- Constantes ---
const GS1_SEPARATOR_CHAR = '\u001d';
const AI_DEFINITIONS = {
    '00': { length: 18, type: 'fixed', desc: 'SSCC' },
    '01': { length: 14, type: 'fixed', desc: 'GTIN' },
    '02': { length: 14, type: 'fixed', desc: 'GTIN Contenido' },
    '10': { length: 20, type: 'variable', desc: 'Lote' }, // Max length 20
    '11': { length: 6, type: 'fixed', desc: 'Fecha Producción' },
    '13': { length: 6, type: 'fixed', desc: 'Fecha Empaquetado' },
    '15': { length: 6, type: 'fixed', desc: 'Fecha Cons. Pref.' },
    '17': { length: 6, type: 'fixed', desc: 'Fecha Caducidad' },
    '21': { length: 20, type: 'variable', desc: 'Número de Serie' }, // Max length 20
    '22': { length: 29, type: 'variable', desc: 'ID Artículo (Hier.)' }, // Max length 29
    '240': { length: 30, type: 'variable', desc: 'ID Artículo Adicional' }, // Max length 30
    '241': { length: 30, type: 'variable', desc: 'ID Cliente' }, // Max length 30
    '30': { length: 8, type: 'variable', desc: 'Cantidad Variable' }, // Max length 8
    '37': { length: 8, type: 'variable', desc: 'Cantidad (Unidades)' }, // Max length 8
    '400': { length: 30, type: 'variable', desc: 'Nº Pedido Cliente' }, // Max length 30
    '410': { length: 13, type: 'fixed', desc: 'Expedido a (GLN)' },
    '414': { length: 13, type: 'fixed', desc: 'GLN Localización' },
    '8005': { length: 6, type: 'fixed', desc: 'Precio Unidad' },
    '90': { length: 30, type: 'variable', desc: 'Info. Mutua Acordada' }, // Max length 30
    // Añadir AIs con indicador de longitud/decimales si es necesario
    // '310': { length: 6, type: 'fixed_plus_indicator', indicatorPos: 3, desc: 'Peso Neto (kg)' },
};

// --- Funciones ---

function showNotification(msg, type = 'success', duration = 3000) {
    notification.innerHTML = `<div class="notification ${type}">${msg}</div>`;
    setTimeout(() => { notification.innerHTML = ''; }, duration);
}

// --- Lógica de Parseo GS1 REVISADA ---

/**
 * Parsea una cadena GS1, manejando FNC1 y códigos concatenados.
 * @param {string} data Cadena GS1 (puede tener FNC1 o no).
 * @returns {object} Objeto con pares AI:Valor.
 */
function parseGS1Smart(data) {
    const fields = {};
    if (!data) return fields;

    // Reemplazar posibles separadores no estándar por el FNC1 oficial
    const sanitizedData = data.replace(/[^ -~]/g, GS1_SEPARATOR_CHAR);
    let remainingData = sanitizedData;
    let currentIndex = 0;
    const hasFNC1 = sanitizedData.includes(GS1_SEPARATOR_CHAR);

    while (currentIndex < remainingData.length) {
        let bestMatch = { ai: null, aiLen: 0, value: null, nextIndex: currentIndex, consumedFnc1: false };
        let foundMatch = false;

        // Intentar identificar el AI (empezar por los más largos)
        for (let len = 4; len >= 2; len--) {
            const potentialAI = remainingData.substring(currentIndex, currentIndex + len);
            const definition = AI_DEFINITIONS[potentialAI];

            if (definition) { // AI conocido
                let value = null;
                let currentReadEnd = currentIndex + len; // Dónde termina el AI
                let nextPotentialIndex = currentReadEnd;
                let consumedFnc1 = false;

                if (definition.type === 'fixed') {
                    const valueLength = definition.length;
                    if (currentReadEnd + valueLength <= remainingData.length) {
                        value = remainingData.substring(currentReadEnd, currentReadEnd + valueLength);
                        nextPotentialIndex = currentReadEnd + valueLength;
                    } else {
                        // No hay suficientes datos para longitud fija, tomar lo que queda
                        value = remainingData.substring(currentReadEnd);
                        nextPotentialIndex = remainingData.length;
                    }
                } else if (definition.type === 'variable') {
                    const maxLength = definition.length;
                    // Buscar FNC1 o fin de cadena o el inicio de otro AI conocido
                    let endPos = -1;
                    if (hasFNC1) {
                        endPos = remainingData.indexOf(GS1_SEPARATOR_CHAR, currentReadEnd);
                    }

                    if (endPos !== -1) { // Se encontró FNC1
                        value = remainingData.substring(currentReadEnd, endPos);
                        nextPotentialIndex = endPos + 1; // Saltar el FNC1
                        consumedFnc1 = true;
                    } else { // No hay FNC1 o no se usa
                        // Leer hasta max length O hasta que empiecen los siguientes 2-4 dígitos
                        // que parezcan OTRO AI conocido.
                        let readUntil = Math.min(currentReadEnd + maxLength, remainingData.length);
                        let nextKnownAIPos = remainingData.length; // Por defecto, hasta el final

                        // Mirar adelante para ver si empieza otro AI conocido
                        for (let lookaheadPos = currentReadEnd + 1; lookaheadPos < readUntil; lookaheadPos++) {
                            for(let nextAiLen = 4; nextAiLen >= 2; nextAiLen--) {
                                if (lookaheadPos + nextAiLen <= remainingData.length) {
                                    const nextPotentialAI = remainingData.substring(lookaheadPos, lookaheadPos + nextAiLen);
                                    if (AI_DEFINITIONS[nextPotentialAI]) {
                                        nextKnownAIPos = Math.min(nextKnownAIPos, lookaheadPos);
                                        break; // Encontrado el AI más largo posible que sigue
                                    }
                                }
                            }
                             if(nextKnownAIPos < remainingData.length) break; // Salir si ya encontramos un AI que sigue
                        }


                        readUntil = Math.min(readUntil, nextKnownAIPos);
                        value = remainingData.substring(currentReadEnd, readUntil);
                        nextPotentialIndex = readUntil;
                    }
                }
                 // Si se encontró un valor para este AI, es el mejor match hasta ahora
                 if (value !== null) {
                    bestMatch = { ai: potentialAI, aiLen: len, value: value.trim(), nextIndex: nextPotentialIndex, consumedFnc1: consumedFnc1 };
                    foundMatch = true;
                    break; // Encontrado el AI más largo posible, salir del bucle de longitud
                 }
            }
            // Si no es un AI conocido, continuar buscando uno más corto
        }

        if (!foundMatch) {
             // Si no se encontró ningún AI conocido, y estamos al principio sin FNC1, tratar como texto simple
             if (currentIndex === 0 && !hasFNC1) {
                 console.warn("Código no parece iniciar con AI GS1 conocido y no hay FNC1. Tratando como texto simple:", remainingData);
                 fields['TEXTO_SIMPLE'] = remainingData; // Guardar como campo especial
             } else {
                 console.warn("No se pudo identificar AI GS1 en:", remainingData.substring(currentIndex));
             }
            break; // Detener el parseo
        }

        // Guardar el mejor match encontrado
        fields[bestMatch.ai] = bestMatch.value;
        currentIndex = bestMatch.nextIndex;

        // Consumir FNC1 adicional si no fue consumido por un campo variable
        // y si está justo después de un campo de longitud fija.
        if (!bestMatch.consumedFnc1 && currentIndex < remainingData.length && remainingData.charAt(currentIndex) === GS1_SEPARATOR_CHAR) {
             if (AI_DEFINITIONS[bestMatch.ai]?.type === 'fixed') {
                currentIndex++;
             }
        }
    }

    return fields;
}


// --- Funciones de Estructura y Formateo (Ajustadas para usar `allFields`) ---
function formatGS1Date(yymmdd) { /* ...código igual que antes... */
     if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return yymmdd;
    try { const year = parseInt(yymmdd.substring(0, 2), 10); const month = parseInt(yymmdd.substring(2, 4), 10); const day = parseInt(yymmdd.substring(4, 6), 10); const currentYearLastTwoDigits = new Date().getFullYear() % 100; const fullYear = year <= (currentYearLastTwoDigits + 10) ? 2000 + year : 1900 + year; if (month < 1 || month > 12 || day < 1 || day > 31) return `${yymmdd} (Inválida)`; const dateObj = new Date(Date.UTC(fullYear, month - 1, day)); if (dateObj.getUTCDate() !== day || dateObj.getUTCMonth() !== month - 1 || dateObj.getUTCFullYear() !== fullYear) { return `${yymmdd} (Inválida)`; } const formattedDate = `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${fullYear}`; const today = new Date(); today.setHours(0, 0, 0, 0); dateObj.setUTCHours(0,0,0,0); const isExpired = dateObj < today; return `${formattedDate}${isExpired ? ' (¡Vencido!)' : ''}`; } catch (e) { console.error("Error formateando fecha:", e); return `${yymmdd} (Error)`; }
}
function structureBioproteceData(genericFields, rawData) {
    const structured = { provider: 'BIOPROTECE', fields: {}, rawData: rawData, allFields: genericFields };
    const mapping = { '21': 'Serie', '17': 'Vencimiento', '10': 'Lote', '22': 'Código Artículo' };
    for (const ai in mapping) {
        // Usar el valor de allFields para la lógica, formatear si es necesario
        if (genericFields[ai]) {
            structured.fields[mapping[ai]] = (ai === '17') ? formatGS1Date(genericFields[ai]) : genericFields[ai];
        } else { structured.fields[mapping[ai]] = ''; }
    }
    if (genericFields['01']) { structured.fields['GTIN'] = genericFields['01']; }
    return structured;
}
function structureSaiData(genericFields, rawData) {
    const structured = { provider: 'SAI', fields: {}, rawData: rawData, allFields: genericFields };
    const mapping = { '01': 'GTIN', '17': 'Vencimiento', '10': 'Lote', '240': 'Código Artículo' };
     for (const ai in mapping) {
        if (genericFields[ai]) {
             structured.fields[mapping[ai]] = (ai === '17') ? formatGS1Date(genericFields[ai]) : genericFields[ai];
         } else { structured.fields[mapping[ai]] = ''; }
    }
     if (genericFields['21']) { structured.fields['Serie'] = genericFields['21']; }
    return structured;
}
function structureGenericData(genericFields, rawData) {
     const structured = { provider: 'Genérico', fields: {}, rawData: rawData, allFields: genericFields };
     const commonMapping = { '01': 'GTIN', '10': 'Lote', '17': 'Vencimiento', '21': 'Serie', '22':'Código Art.(22)', '240':'Ref.(240)' };
     for (const ai in commonMapping) {
         if (genericFields[ai]) {
             structured.fields[commonMapping[ai]] = (ai === '17') ? formatGS1Date(genericFields[ai]) : genericFields[ai];
         }
     }
     for(const ai in genericFields) { if (!Object.values(commonMapping).includes(ai) && !commonMapping[ai]) { structured.fields[`AI(${ai})`] = genericFields[ai]; } }
     return structured;
}
function displayParsedFields(structuredData) { /* ...código igual que antes... */
    parsedDataContainer.innerHTML = '';
    if (!structuredData || !structuredData.fields || Object.keys(structuredData.fields).length === 0) { parsedDataContainer.innerHTML = '<p>No se pudieron extraer campos específicos.</p>'; return; }
    const title = document.createElement('h4'); title.textContent = `Datos (${structuredData.provider}):`; parsedDataContainer.appendChild(title);
    for (const fieldName in structuredData.fields) {
        if (structuredData.fields[fieldName]) {
            const p = document.createElement('p'); const value = structuredData.fields[fieldName]; const isExpired = value.includes && value.includes('¡Vencido!');
            p.innerHTML = `<strong>${fieldName}:</strong> <span class="${isExpired ? 'expired' : ''}">${value}</span>`; parsedDataContainer.appendChild(p);
        }
    }
}

// --- Lógica de la Tabla y Duplicados (Ajustada para usar allFields) ---
function isDuplicate(newStructuredData) {
    const newGTIN = newStructuredData.allFields?.['01']; // Usar optional chaining
    const newLote = newStructuredData.allFields?.['10'];
    const newSerie = newStructuredData.allFields?.['21'];

    // Si no hay GTIN, no podemos considerarlo duplicado basado en esta lógica
    if (!newGTIN) return false;

    return scannedData.some(existingRecord => {
        const existingGTIN = existingRecord.allFields?.['01'];
        const existingLote = existingRecord.allFields?.['10'];
        const existingSerie = existingRecord.allFields?.['21'];

        // Solo comparar si el GTIN existe y coincide
        if (!existingGTIN || existingGTIN !== newGTIN) {
            return false;
        }

        // Si GTIN coincide, verificar Lote y Serie
        const loteMatch = (!newLote && !existingLote) || (newLote && existingLote && newLote === existingLote);
        const serieMatch = (!newSerie && !existingSerie) || (newSerie && existingSerie && newSerie === existingSerie);

        // Es duplicado si GTIN coincide Y (lote coincide o no existe en ambos) Y (serie coincide o no existe en ambos)
        return loteMatch && serieMatch;
    });
}

// ***** MODIFICADO: renderTable ahora usa allFields para obtener valores *****
function renderTable() {
    tableContainer.innerHTML = '';
    if (scannedData.length === 0) {
        tableContainer.innerHTML = '<p>No hay datos escaneados aún.</p>';
        return;
    }

    const table = document.createElement('table');
    const header = table.insertRow();

    // Usar los checkboxes para definir columnas
    const cols = Array.from(fieldChecks)
                      .filter(ch => ch.checked)
                      .map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));

    // Crear cabecera
    header.innerHTML = cols.map(c => `<th>${c.text}</th>`).join('') + '<th>Acción</th>';

    // Crear filas de datos
    scannedData.forEach((storedRecord, idx) => {
        const tr = table.insertRow();
        const provider = storedRecord.provider || 'N/A';

        cols.forEach(col => {
            let cellValue = '';
            if (col.value === 'provider') {
                cellValue = provider;
            } else {
                // *** CLAVE: Buscar SIEMPRE en allFields usando el AI (col.value) ***
                cellValue = storedRecord.allFields?.[col.value] || ''; // Usar optional chaining

                // Formatear fecha si es la columna de vencimiento y el valor existe
                if (col.value === '17' && cellValue) {
                     cellValue = formatGS1Date(cellValue);
                }
                // Podrías añadir formateo para otros AIs aquí si es necesario
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
            renderTable();
        };
        cell.appendChild(btn);
        // Quitar animación para evitar re-aplicación constante al borrar
        // tr.classList.add('highlight');
    });

    tableContainer.appendChild(table);
     // Aplicar animación a la última fila añadida (si existe)
     const lastRow = table.rows[table.rows.length - 1];
     if(lastRow) {
         lastRow.classList.add('highlight');
     }
}


// --- Lógica de Exportación (Ajustada para usar allFields) ---
exportBtn.addEventListener('click', () => {
    if (scannedData.length === 0) return showNotification('No hay datos para exportar', 'error');
    const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));
    let csv = cols.map(c => `"${c.text}"`).join(',') + '\n'; // Encabezados CSV

    scannedData.forEach(storedRecord => {
        const rowValues = [];
        const provider = storedRecord.provider || 'N/A';

        cols.forEach(col => {
            let cellValue = '';
            if (col.value === 'provider') {
                cellValue = provider;
            } else {
                // *** Usar allFields para obtener el valor crudo ***
                cellValue = storedRecord.allFields?.[col.value] || '';
                 // Formatear fecha específicamente para la exportación si es AI 17
                 if (col.value === '17' && cellValue) {
                     cellValue = formatGS1Date(cellValue); // Usar la función de formateo
                 }
            }
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
    const provider = storedRecord.provider || 'N/A';

    cols.forEach(col => {
        let headerText = col.text;
        let cellValue = '';
         if (col.value === 'provider') {
             cellValue = provider;
         } else {
            // *** Usar allFields para obtener el valor crudo ***
            cellValue = storedRecord.allFields?.[col.value] || '';
             // Formatear fecha específicamente para la exportación si es AI 17
             if (col.value === '17' && cellValue) {
                 cellValue = formatGS1Date(cellValue);
             }
         }
        obj[headerText] = cellValue; // Usar texto del label como cabecera
    });
    return obj;
  });

  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Scaneos');
  XLSX.writeFile(wb, 'scaneos.xlsx');
  showNotification('XLSX exportado');
});

// --- Manejador Principal de Escaneo ---
function onScanSuccessMain(decodedText) {
    resultBox.value = decodedText;
    parsedDataContainer.innerHTML = '';
    const selectedProviderValue = providerSelect.value;
    let structuredData;
    try {
        // ***** Usar el nuevo parser inteligente *****
        const genericFields = parseGS1Smart(decodedText);

        if (genericFields['TEXTO_SIMPLE']) { // Manejar caso de texto simple detectado por el parser
            structuredData = { provider: selectedProviderValue || 'Texto Simple', fields: { 'Texto': genericFields['TEXTO_SIMPLE'] }, rawData: decodedText, allFields: {} };
            showNotification('Código leído como texto simple', 'warning');
        }
         else if (Object.keys(genericFields).length === 0 && decodedText.length > 0 && !decodedText.includes(GS1_SEPARATOR_CHAR)) {
             // Si el parser no encontró AIs pero hay texto y no parece GS1 (sin FNC1), tratar como texto
             structuredData = { provider: selectedProviderValue || 'Texto Simple', fields: { 'Texto': decodedText }, rawData: decodedText, allFields: {} };
             showNotification('Código leído como texto simple (sin AI)', 'warning');
        }
        else {
            // Proceder con la estructuración basada en proveedor
            switch (selectedProviderValue) {
                case 'bioprotece': structuredData = structureBioproteceData(genericFields, decodedText); break;
                case 'sai': structuredData = structureSaiData(genericFields, decodedText); break;
                default: structuredData = structureGenericData(genericFields, decodedText); break;
            }
         }

        displayParsedFields(structuredData);
        if (isDuplicate(structuredData)) { showNotification('Este código ya fue escaneado.', 'error'); return; }
        scannedData.push(structuredData); localStorage.setItem('scannedData', JSON.stringify(scannedData)); renderTable(); showNotification(`Escaneo (${structuredData.provider}) añadido`);
    } catch (error) { console.error("Error procesando el escaneo:", error); showNotification(`Error al procesar: ${error.message}`, 'error'); parsedDataContainer.innerHTML = `<p>Error al interpretar datos.</p>`; }
}
function onScanFailureQR(error) { /* No hacer nada */ }
function onQuaggaDetected(result) { /* ...código igual que antes... */
     if (result && result.codeResult && result.codeResult.code) { onScanSuccessMain(result.codeResult.code); }
}


// --- Lógica de UI (Mostrar/Ocultar Controles) ---
function showStartUI() { /* ...código igual que antes... */
    startScanButton.style.display = 'inline-block'; stopScanButton.style.display = 'none'; scannerActiveControlsDiv.style.display = 'none'; readerDiv.style.display = 'none'; statusElement.textContent = "Listo para iniciar."; providerSelect.disabled = false; toggleBtn.disabled = false; cameraSelector.disabled = true; cameraSelector.style.display = 'none'; cameraStatus.textContent = '';
}
function showScanningUI() { /* ...código igual que antes... */
     startScanButton.style.display = 'none'; stopScanButton.style.display = 'inline-block'; scannerActiveControlsDiv.style.display = 'block'; readerDiv.style.display = 'block'; statusElement.textContent = "Iniciando..."; providerSelect.disabled = true; toggleBtn.disabled = true; cameraSelector.disabled = false; cameraSelector.style.display = availableCameras.length > 1 ? 'inline-block' : 'none';
}

// --- Inicialización y Control de Escáneres ---
async function requestPermissionAndGetCameraId() { /* ...código igual que antes... */
    statusElement.textContent = "Solicitando permiso..."; cameraStatus.textContent = '';
    try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); console.log("Permiso concedido.");
        availableCameras = await Html5Qrcode.getCameras();
        if (availableCameras && availableCameras.length) {
            cameraSelector.innerHTML = '<option value="">-- Cambiar Cámara --</option>';
            availableCameras.forEach((device, index) => { const option = document.createElement('option'); option.value = device.id; option.text = device.label || `Cámara ${index + 1}`; cameraSelector.appendChild(option); });
            let selectedCamera = availableCameras.find(device => device.label && /back|rear|trás|trasera/i.test(device.label));
            if (!selectedCamera) { selectedCamera = availableCameras[0]; }
            console.log("Cámara seleccionada:", selectedCamera.label || selectedCamera.id); cameraSelector.value = selectedCamera.id; return selectedCamera.id;
        } else { cameraStatus.textContent = "No se encontraron cámaras."; statusElement.textContent = "Sin Cámaras"; return null; }
    } catch (err) { console.error("Error permiso/cámaras:", err); let errorMsg = "Error cámara."; if (`${err}`.toLowerCase().includes("permission denied") || `${err}`.toLowerCase().includes("notallowederror")) { errorMsg = "Permiso denegado."; } else if (`${err}`.toLowerCase().includes("notfounderror")) { errorMsg = "Cámara no encontrada."; } cameraStatus.textContent = errorMsg; statusElement.textContent = "Error Cámara"; return null; }
}
async function startQRScanner(cameraId) { /* ...código igual que antes... */
    if (!cameraId) { showNotification("ID cámara no válido.", "error"); isScanning = false; showStartUI(); return; }
    showScanningUI(); statusElement.textContent = "Iniciando QR..."; cameraStatus.textContent = "";
    stopBarcodeScanner(); readerDiv.innerHTML = ''; if (!html5QrCode) { html5QrCode = new Html5Qrcode("reader"); }
    const config = { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.777 };
    try {
        await html5QrCode.start(cameraId, config, onScanSuccessMain, onScanFailureQR); console.log(`QR iniciado ${cameraId}.`);
        statusElement.textContent = "Escaneando (QR)..."; currentCameraId = cameraId; isScanning = true; cameraSelector.disabled = availableCameras.length <= 1;
    } catch (err) { console.error(`Error QR ${cameraId}:`, err); cameraStatus.textContent = "Error QR: " + err.message; statusElement.textContent = "Error QR"; isScanning = false; showStartUI(); }
}
function stopQRScanner() { /* ...código igual que antes... */
     if (html5QrCode && html5QrCode.isScanning) { html5QrCode.stop().then(() => console.log("QR detenido.")).catch(err => console.error("Error stop QR:", err)).finally(() => { readerDiv.innerHTML = ''; currentCameraId = null; isScanning = false; }); } else { isScanning = false; }
}
async function startBarcodeScanner(cameraId) { /* ...código igual que antes... */
    if (!cameraId) { showNotification("ID cámara no válido.", "error"); isScanning = false; showStartUI(); return; }
    showScanningUI(); statusElement.textContent = "Iniciando Barras..."; cameraStatus.textContent = "";
    stopQRScanner(); readerDiv.innerHTML = '';
    const quaggaConfig = { inputStream: { name: "Live", type: "LiveStream", target: readerDiv, constraints: { deviceId: cameraId, facingMode: "environment" }, area: { top: "20%", bottom: "20%", left: "10%", right: "10%" } }, locator: { patchSize: "medium", halfSample: true }, numOfWorkers: Math.min(navigator.hardwareConcurrency || 2, 4), frequency: 10, decoder: { readers: ["code_128_reader", "ean_reader", "ean_8_reader", "code_39_reader", "codabar_reader", "upc_reader", "i2of5_reader"], }, locate: true };
    try {
        if (isQuaggaInitialized) { await Quagga.stop(); isQuaggaInitialized = false; }
        Quagga.init(quaggaConfig, (err) => { if (err) { throw err; } console.log(`Quagga init ${cameraId}.`); Quagga.start(); isQuaggaInitialized = true; statusElement.textContent = "Escaneando (Barras)..."; currentCameraId = cameraId; isScanning = true; cameraSelector.disabled = availableCameras.length <= 1; });
        Quagga.offDetected(onQuaggaDetected); Quagga.onDetected(onQuaggaDetected);
    } catch (err) { console.error("Error Quagga:", err); cameraStatus.textContent = "Error Barras: " + err.message; statusElement.textContent = "Error Barras"; isScanning = false; showStartUI(); }
}
function stopBarcodeScanner() { /* ...código igual que antes... */
    if (isQuaggaInitialized && typeof Quagga !== 'undefined' && Quagga.stop) { try { Quagga.stop(); console.log("Barras detenido."); } catch (err) { if (!err.message.includes("Cannot read property 'stop'")) { console.error("Error stop Quagga:", err); } } finally { readerDiv.innerHTML = ''; isQuaggaInitialized = false; currentCameraId = null; isScanning = false; } } else { isScanning = false; }
}
async function stopScan() { /* ...código igual que antes... */
     console.log("Deteniendo escaneo..."); stopScanButton.disabled = true; statusElement.textContent = "Deteniendo...";
    if (scanMode === 'qr') { await stopQRScanner(); } else { await stopBarcodeScanner(); }
    showStartUI(); stopScanButton.disabled = false;
}

// --- Event Listeners (Botones Inicio/Detener, Toggle Modo, Selector Cámara) ---
startScanButton.addEventListener('click', async () => { /* ...código igual que antes... */
    startScanButton.disabled = true; startScanButton.textContent = "Iniciando..."; cameraStatus.textContent = ''; statusElement.textContent = '';
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) { cameraStatus.textContent = 'Error: Requiere HTTPS.'; statusElement.textContent = "Error HTTPS"; startScanButton.disabled = false; startScanButton.textContent = "Iniciar Escaneo"; return; }
    const cameraId = await requestPermissionAndGetCameraId();
    if (cameraId) { currentCameraId = cameraId; if (scanMode === 'qr') { await startQRScanner(cameraId); } else { await startBarcodeScanner(cameraId); } }
    else { showStartUI(); startScanButton.disabled = false; startScanButton.textContent = "Iniciar Escaneo"; }
    if (!isScanning) { startScanButton.disabled = false; startScanButton.textContent = "Iniciar Escaneo"; }
});
stopScanButton.addEventListener('click', () => { stopScan(); });
toggleBtn.addEventListener('click', async () => { /* ...código igual que antes... */
    const wasScanning = isScanning; let targetCameraId = currentCameraId; await stopScan();
    if (!wasScanning) { targetCameraId = await requestPermissionAndGetCameraId(); if (!targetCameraId) { showStartUI(); return; } currentCameraId = targetCameraId; }
    if (scanMode === 'qr') { scanMode = 'barcode'; toggleBtn.textContent = 'Modo Barras'; if (wasScanning || targetCameraId) { startScanButton.click(); } }
    else { scanMode = 'qr'; toggleBtn.textContent = 'Modo QR'; if (wasScanning || targetCameraId) { startScanButton.click(); } }
});
cameraSelector.addEventListener('change', async (event) => { /* ...código igual que antes... */
    const newCameraId = event.target.value; if (!newCameraId || newCameraId === currentCameraId || !isScanning) { if (!newCameraId) cameraSelector.value = currentCameraId; return; }
    console.log(`Cambiando a cámara: ${newCameraId}`); cameraSelector.disabled = true; toggleBtn.disabled = true; stopScanButton.disabled = true; statusElement.textContent = `Cambiando cámara...`;
    if (scanMode === 'qr') { await stopQRScanner(); await startQRScanner(newCameraId); } else { await stopBarcodeScanner(); await startBarcodeScanner(newCameraId); }
    if (!isScanning) { cameraSelector.disabled = false; toggleBtn.disabled = false; stopScanButton.disabled = true; showStartUI(); }
});

// --- Inicialización al Cargar ---
document.addEventListener('DOMContentLoaded', () => {
  renderTable();
  showStartUI(); // Empezar mostrando solo el botón de inicio

  // Listener para checkboxes (sin cambios)
  fieldChecks.forEach(checkbox => {
    checkbox.addEventListener('change', renderTable);
  });
});
