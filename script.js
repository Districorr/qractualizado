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

// Elementos de Control del Escáner (añadidos en la versión anterior)
const startScanButton = document.getElementById('start-scan-button');
const stopScanButton = document.getElementById('stop-scan-button');
const scannerControlsDiv = document.getElementById('scanner-controls');
const scannerActiveControlsDiv = document.getElementById('scanner-active-controls');
const cameraSelector = document.getElementById('camera-selector'); // Referencia al selector de cámara
const cameraStatus = document.getElementById('camera-status');     // Referencia al párrafo de estado de cámara
const statusElement = document.getElementById('status');           // Referencia al párrafo de estado general

// --- Estado de la Aplicación ---
let scanMode = 'qr'; // 'qr' o 'barcode'
let html5QrCode;
let isQuaggaInitialized = false;
let scannedData = JSON.parse(localStorage.getItem('scannedData')) || [];
let currentCameraId = null; // ***** Guarda el ID de la cámara activa *****
let availableCameras = [];  // ***** Guarda la lista de cámaras encontradas *****

// --- Constantes ---
const GS1_SEPARATOR_CHAR = '\u001d'; // GS1 FNC1 (Group Separator)

// --- Funciones ---

// Notificaciones
function showNotification(msg, type = 'success', duration = 3000) {
    notification.innerHTML = `<div class="notification ${type}">${msg}</div>`;
    setTimeout(() => { notification.innerHTML = ''; }, duration);
}

// --- Lógica de Parseo GS1 (Sin cambios respecto a la versión anterior) ---
function parseGS1GenericWithFNC1(data) {
    const fields = {}; if (!data) return fields;
    const sanitizedData = data.replace(/[^ -~]/g, GS1_SEPARATOR_CHAR);
    const fixedLengthAIs = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6, '410': 13, '414': 13, '8005': 6 };
    const variableLengthAIPrefixes = ['393', '392', '241', '240', '25', '21', '22', '10', '30', '37', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99'];
    for (let i = 310; i <= 369; i++) variableLengthAIPrefixes.push(String(i));
    let remainingData = sanitizedData; let currentIndex = 0;
    while (currentIndex < remainingData.length) {
        let ai = null; let aiLen = 0; let value = null; let nextIndex = currentIndex; let found = false;
        for (let len = 4; len >= 2; len--) {
            const potentialAI = remainingData.substring(currentIndex, currentIndex + len);
            if (fixedLengthAIs[potentialAI] !== undefined) {
                ai = potentialAI; aiLen = len; const valueLength = fixedLengthAIs[ai];
                if (currentIndex + aiLen + valueLength <= remainingData.length) {
                    value = remainingData.substring(currentIndex + aiLen, currentIndex + aiLen + valueLength);
                    nextIndex = currentIndex + aiLen + valueLength; found = true; break;
                } else { value = remainingData.substring(currentIndex + aiLen); nextIndex = remainingData.length; found = true; break; }
            }
            if (variableLengthAIPrefixes.some(prefix => potentialAI.startsWith(prefix))) {
                ai = potentialAI; aiLen = len;
                const fnc1Pos = remainingData.indexOf(GS1_SEPARATOR_CHAR, currentIndex + aiLen);
                if (fnc1Pos !== -1) { value = remainingData.substring(currentIndex + aiLen, fnc1Pos); nextIndex = fnc1Pos + 1; }
                else { value = remainingData.substring(currentIndex + aiLen); nextIndex = remainingData.length; }
                found = true; break;
            }
        }
        if (!found) {
            if (!sanitizedData.includes(GS1_SEPARATOR_CHAR) && currentIndex === 0) {
                console.warn("No FNC1, intentando parseo simple.");
                const match = remainingData.match(/^(\d{2,4})(.+)/);
                if (match) { fields[match[1]] = match[2].trim(); }
            } else { console.warn("No se pudo identificar AI GS1 en:", remainingData.substring(currentIndex)); }
            break;
        }
        if (ai && value !== null) { fields[ai] = value.trim(); }
        currentIndex = nextIndex;
    } return fields;
}
function formatGS1Date(yymmdd) {
    if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return yymmdd;
    try {
        const year = parseInt(yymmdd.substring(0, 2), 10);
        const month = parseInt(yymmdd.substring(2, 4), 10);
        const day = parseInt(yymmdd.substring(4, 6), 10);
        const currentYearLastTwoDigits = new Date().getFullYear() % 100;
        const fullYear = year <= (currentYearLastTwoDigits + 10) ? 2000 + year : 1900 + year;
        if (month < 1 || month > 12 || day < 1 || day > 31) return `${yymmdd} (Inválida)`;
        const dateObj = new Date(Date.UTC(fullYear, month - 1, day));
        if (dateObj.getUTCDate() !== day || dateObj.getUTCMonth() !== month - 1 || dateObj.getUTCFullYear() !== fullYear) { return `${yymmdd} (Inválida)`; }
        const formattedDate = `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${fullYear}`;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        dateObj.setUTCHours(0,0,0,0);
        const isExpired = dateObj < today;
        return `${formattedDate}${isExpired ? ' (¡Vencido!)' : ''}`;
    } catch (e) { console.error("Error formateando fecha:", e); return `${yymmdd} (Error)`; }
}
function structureBioproteceData(genericFields, rawData) {
    const structured = { provider: 'BIOPROTECE', fields: {}, rawData: rawData, allFields: genericFields };
    const mapping = { '21': 'Serie', '17': 'Vencimiento', '10': 'Lote', '22': 'Código Artículo' };
    for (const ai in mapping) {
        if (genericFields[ai]) { let value = genericFields[ai]; if (ai === '17') { value = formatGS1Date(value); } structured.fields[mapping[ai]] = value; }
        else { structured.fields[mapping[ai]] = ''; }
    } if (genericFields['01']) { structured.fields['GTIN'] = genericFields['01']; } return structured;
}
function structureSaiData(genericFields, rawData) {
    const structured = { provider: 'SAI', fields: {}, rawData: rawData, allFields: genericFields };
    const mapping = { '01': 'GTIN', '17': 'Vencimiento', '10': 'Lote', '240': 'Código Artículo' };
    for (const ai in mapping) {
        if (genericFields[ai]) { let value = genericFields[ai]; if (ai === '17') { value = formatGS1Date(value); } structured.fields[mapping[ai]] = value; }
        else { structured.fields[mapping[ai]] = ''; }
    } if (genericFields['21']) { structured.fields['Serie'] = genericFields['21']; } return structured;
}
function structureGenericData(genericFields, rawData) {
    const structured = { provider: 'Genérico', fields: {}, rawData: rawData, allFields: genericFields };
    const commonMapping = { '01': 'GTIN', '10': 'Lote', '17': 'Vencimiento', '21': 'Serie', '22':'Código Art.(22)', '240':'Ref.(240)' };
    for (const ai in commonMapping) { if (genericFields[ai]) { let value = genericFields[ai]; if (ai === '17') value = formatGS1Date(value); structured.fields[commonMapping[ai]] = value; } }
    for(const ai in genericFields) { if (!Object.values(commonMapping).includes(ai) && !commonMapping[ai]) { structured.fields[`AI(${ai})`] = genericFields[ai]; } } return structured;
}
function displayParsedFields(structuredData) {
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

// --- Lógica de la Tabla y Duplicados (Sin cambios) ---
function isDuplicate(newStructuredData) {
    const newGTIN = newStructuredData.allFields ? newStructuredData.allFields['01'] : newStructuredData.fields['GTIN'];
    const newLote = newStructuredData.allFields ? newStructuredData.allFields['10'] : newStructuredData.fields['Lote'];
    const newSerie = newStructuredData.allFields ? newStructuredData.allFields['21'] : newStructuredData.fields['Serie'];
    return scannedData.some(existingRecord => {
        const existingGTIN = existingRecord.allFields ? existingRecord.allFields['01'] : existingRecord.fields['GTIN'];
        const existingLote = existingRecord.allFields ? existingRecord.allFields['10'] : existingRecord.fields['Lote'];
        const existingSerie = existingRecord.allFields ? existingRecord.allFields['21'] : existingRecord.fields['Serie'];
        let match = existingGTIN && existingGTIN === newGTIN;
        if (match && newLote && existingLote) { match = match && (existingLote === newLote); }
        if (match && newSerie && existingSerie) { match = match && (existingSerie === newSerie); }
        if (match && !newLote && !newSerie && !existingLote && !existingSerie) { return true; }
        return match;
    });
}
function renderTable() {
    tableContainer.innerHTML = '';
    if (scannedData.length === 0) { tableContainer.innerHTML = '<p>No hay datos escaneados aún.</p>'; return; }
    const table = document.createElement('table'); const header = table.insertRow();
    const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));
    header.innerHTML = cols.map(c => `<th>${c.text}</th>`).join('') + '<th>Acción</th>';
    scannedData.forEach((storedRecord, idx) => {
        const tr = table.insertRow(); const dataFields = storedRecord.allFields || storedRecord.fields; const provider = storedRecord.provider || 'N/A';
        cols.forEach(col => {
            let cellValue = '';
            if (col.value === 'provider') { cellValue = provider; }
            else {
                cellValue = (storedRecord.allFields?.[col.value] || dataFields[col.value] || '');
                if (col.value === '17' && cellValue && storedRecord.allFields && /^\d{6}$/.test(storedRecord.allFields['17'])) { cellValue = formatGS1Date(storedRecord.allFields['17']); }
            }
            tr.insertCell().textContent = cellValue;
        });
        const cell = tr.insertCell(); const btn = document.createElement('button'); btn.textContent = '🗑️';
        btn.onclick = () => { scannedData.splice(idx, 1); localStorage.setItem('scannedData', JSON.stringify(scannedData)); renderTable(); };
        cell.appendChild(btn); tr.classList.add('highlight');
    });
    tableContainer.appendChild(table);
}

// --- Lógica de Exportación (Sin cambios) ---
exportBtn.addEventListener('click', () => { /* ...código exportación CSV sin cambios... */
     if (scannedData.length === 0) return showNotification('No hay datos para exportar', 'error');
    const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));
    let csv = cols.map(c => `"${c.text}"`).join(',') + '\n';
    scannedData.forEach(storedRecord => {
        const rowValues = []; const dataFields = storedRecord.allFields || storedRecord.fields; const provider = storedRecord.provider || 'N/A';
        cols.forEach(col => {
            let cellValue = '';
            if (col.value === 'provider') { cellValue = provider; }
            else { cellValue = (storedRecord.allFields?.[col.value] || dataFields[col.value] || ''); if (col.value === '17' && cellValue && storedRecord.allFields && /^\d{6}$/.test(storedRecord.allFields['17'])) { cellValue = formatGS1Date(storedRecord.allFields['17']); } }
            cellValue = typeof cellValue === 'string' ? `"${cellValue.replace(/"/g, '""')}"` : cellValue; rowValues.push(cellValue);
        }); csv += rowValues.join(',') + '\n';
    });
    const uri = 'data:text/csv;charset=utf-8,' + encodeURI(csv); const link = document.createElement('a'); link.href = uri; link.download = 'escaneos.csv'; link.click(); showNotification('CSV exportado');
});
exportXlsxBtn.addEventListener('click', () => { /* ...código exportación XLSX sin cambios... */
    if (scannedData.length === 0) return showNotification('No hay datos para exportar', 'error');
    const wb = XLSX.utils.book_new(); const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ({ value: ch.value, text: ch.parentElement.textContent.trim() }));
    const data = scannedData.map(storedRecord => {
        let obj = {}; const dataFields = storedRecord.allFields || storedRecord.fields; const provider = storedRecord.provider || 'N/A';
        cols.forEach(col => {
            let headerText = col.text; let cellValue = '';
            if (col.value === 'provider') { cellValue = provider; }
            else { cellValue = (storedRecord.allFields?.[col.value] || dataFields[col.value] || ''); if (col.value === '17' && cellValue && storedRecord.allFields && /^\d{6}$/.test(storedRecord.allFields['17'])) { cellValue = formatGS1Date(storedRecord.allFields['17']); } }
            obj[headerText] = cellValue;
        }); return obj;
    });
    const ws = XLSX.utils.json_to_sheet(data); XLSX.utils.book_append_sheet(wb, ws, 'Scaneos'); XLSX.writeFile(wb, 'scaneos.xlsx'); showNotification('XLSX exportado');
});

// --- Manejador Principal de Escaneo (Sin cambios) ---
function onScanSuccessMain(decodedText) {
    resultBox.value = decodedText;
    parsedDataContainer.innerHTML = '';
    const selectedProviderValue = providerSelect.value;
    let structuredData;
    try {
        const genericFields = parseGS1GenericWithFNC1(decodedText);
        if (Object.keys(genericFields).length === 0 && decodedText.length > 0) {
             structuredData = { provider: selectedProviderValue || 'Texto Simple', fields: { 'Texto': decodedText }, rawData: decodedText, allFields: {} };
             showNotification('Código leído como texto simple', 'warning');
        } else {
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

function onScanFailureQR(error) { /* No hacer nada visualmente */ }
function onScanFailureQuagga(error) { /* No hacer nada visualmente */ }


// --- Inicialización y Control de Escáneres ---

/** ***** MODIFICADO: Ahora busca cámaras y devuelve el ID trasero o el primero *****
 * Obtiene la lista de cámaras y devuelve el ID de la cámara trasera o la primera.
 * @returns {Promise<string|null>} Promise que resuelve con el ID de la cámara o null si falla.
 */
async function getCameraIdForScanner() {
    try {
        availableCameras = await Html5Qrcode.getCameras();
        if (availableCameras && availableCameras.length) {
            // Poblar el selector (aunque esté oculto si solo hay 1)
             cameraSelector.innerHTML = '<option value="">-- Cambiar Cámara --</option>'; // Opción para claridad
            availableCameras.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.id;
                option.text = device.label || `Cámara ${index + 1}`;
                cameraSelector.appendChild(option);
            });
             cameraSelector.style.display = availableCameras.length > 1 ? 'inline-block' : 'none'; // Mostrar solo si hay > 1

            // Buscar cámara trasera
            let selectedCamera = availableCameras.find(device =>
                device.label && /back|rear|trás|trasera/i.test(device.label)
            );
            // Si no hay trasera, usar la primera
            if (!selectedCamera) {
                selectedCamera = availableCameras[0];
            }
             console.log("Cámara seleccionada para iniciar:", selectedCamera.label || selectedCamera.id);
            cameraSelector.value = selectedCamera.id; // Establecer valor en el select
            return selectedCamera.id;
        } else {
            showNotification("No se encontraron cámaras.", "error");
            return null;
        }
    } catch (err) {
        console.error("Error al obtener cámaras:", err);
         let errorMsg = "Error al obtener cámaras";
         if (`${err}`.includes("Permission denied") || `${err}`.includes("NotAllowedError")) {
            errorMsg = "Permiso de cámara denegado. Revise la configuración.";
         }
        showNotification(errorMsg, "error");
        return null;
    }
}

// QR Scanner (html5-qrcode)
async function startQRScanner(cameraId) {
    if (!cameraId) {
        showNotification("No se pudo seleccionar una cámara para QR.", "error");
        return;
    }
    stopBarcodeScanner(); // Asegurar que Quagga esté detenido
    readerDiv.innerHTML = ''; // Limpiar div
    if (!html5QrCode) {
         html5QrCode = new Html5Qrcode("reader");
    }
    const config = {
        fps: 10,
        qrbox: { width: 250, height: 150 }, // Ajustar según necesidad
         aspectRatio: 1.777 // Sugerir 16:9
        // supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA] // No necesario aquí
    };

    try {
        await html5QrCode.start(cameraId, config, onScanSuccessMain, onScanFailureQR);
        console.log(`Escáner QR iniciado con cámara ${cameraId}.`);
        showNotification("Escáner QR activo", "success", 1500);
        currentCameraId = cameraId; // Guardar cámara activa
        cameraSelector.disabled = false; // Habilitar selector de cámara
    } catch (err) {
        console.error(`Error al iniciar escáner QR con ${cameraId}:`, err);
        showNotification("Error al iniciar QR: " + err.message, "error");
        cameraSelector.disabled = true; // Deshabilitar si falla
    }
}

function stopQRScanner() {
    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => {
            console.log("Escáner QR detenido.");
            readerDiv.innerHTML = ''; // Limpiar vista previa
        }).catch(err => {
            console.error("Error al detener escáner QR:", err);
        }).finally(() => {
            currentCameraId = null;
            cameraSelector.disabled = true; // Deshabilitar selector
            cameraSelector.style.display = 'none'; // Ocultar selector
            // No liberar instancia html5QrCode aquí para poder reiniciar
        });
    } else {
         currentCameraId = null;
         cameraSelector.disabled = true;
         cameraSelector.style.display = 'none';
    }
}

// Barcode Scanner (QuaggaJS)
async function startBarcodeScanner(cameraId) {
     if (!cameraId) {
        showNotification("No se pudo seleccionar una cámara para Barras.", "error");
        return;
    }
    stopQRScanner(); // Asegurar que html5-qrcode esté detenido
    readerDiv.innerHTML = ''; // Limpiar div

     const quaggaConfig = {
        inputStream: {
            name: "Live",
            type: "LiveStream",
            target: readerDiv,
            constraints: {
                deviceId: cameraId, // Usar el ID de cámara seleccionado/detectado
                facingMode: "environment" // Intentar forzar trasera de nuevo
            },
            area: { top: "20%", bottom: "20%", left: "10%", right: "10%" }
        },
        locator: { patchSize: "medium", halfSample: true },
        numOfWorkers: Math.min(navigator.hardwareConcurrency || 2, 4), // Limitar workers
        frequency: 10,
        decoder: {
            readers: ["code_128_reader", "ean_reader", "ean_8_reader", "code_39_reader", "codabar_reader", "upc_reader", "i2of5_reader"],
        },
        locate: true
    };

     // Quagga necesita ser inicializado solo una vez o después de un stop completo
     // Si isQuaggaInitialized es true, podríamos solo llamar a Quagga.start()
     // pero es más seguro reinicializar si cambiamos cámara.
     try {
        // Detener cualquier instancia previa de Quagga antes de init
         if (isQuaggaInitialized) {
             await Quagga.stop(); // Esperar a que se detenga completamente
             isQuaggaInitialized = false;
         }

        Quagga.init(quaggaConfig, (err) => {
            if (err) {
                console.error("Error de inicialización Quagga:", err);
                showNotification("Error al iniciar Barras: " + err, "error");
                cameraSelector.disabled = true;
                return;
            }
            console.log(`Quagga inicializado con cámara ${cameraId}.`);
            Quagga.start();
            isQuaggaInitialized = true;
            showNotification("Escáner de Barras activo", "success", 1500);
            currentCameraId = cameraId;
            cameraSelector.disabled = false; // Habilitar selector
        });

         // Remover listeners anteriores si existían para evitar duplicados
         Quagga.offDetected(onQuaggaDetected); // Usar una función nombrada
         Quagga.onDetected(onQuaggaDetected); // Añadir el nuevo listener
         Quagga.offProcessed(); // Remover listener de procesado si existía
         // Quagga.onProcessed(result => { /* Dibujar cuadros si es necesario */ });

     } catch (err) {
         console.error("Excepción al inicializar/iniciar Quagga:", err);
         showNotification("Error crítico al iniciar escáner de barras.", "error");
          cameraSelector.disabled = true;
     }
}

// Función nombrada para el listener de Quagga
function onQuaggaDetected(result) {
    if (result && result.codeResult && result.codeResult.code) {
        onScanSuccessMain(result.codeResult.code);
    }
}

function stopBarcodeScanner() {
    if (isQuaggaInitialized && typeof Quagga !== 'undefined' && Quagga.stop) {
        try {
             Quagga.stop();
             isQuaggaInitialized = false; // Marcar como detenido para permitir re-init
             console.log("Escáner de Barras detenido.");
             readerDiv.innerHTML = ''; // Forzar limpieza
        } catch (err) {
            // Ignorar error "Cannot read property 'stop' of undefined" si Quagga ya se limpió
            if (!err.message.includes("Cannot read property 'stop'")) {
                 console.error("Error al detener Quagga:", err);
            }
        } finally {
             currentCameraId = null;
             cameraSelector.disabled = true;
             cameraSelector.style.display = 'none';
        }
    } else {
         currentCameraId = null;
         cameraSelector.disabled = true;
         cameraSelector.style.display = 'none';
    }
}

// --- Toggle de Modo ---
toggleBtn.addEventListener('click', async () => {
  const currentlyScanning = (html5QrCode && html5QrCode.isScanning) || isQuaggaInitialized;
  let targetCameraId = currentCameraId; // Usar la cámara actual si ya estaba activa

  // Si no estaba escaneando, obtener la cámara por defecto primero
  if (!currentlyScanning) {
      targetCameraId = await getCameraIdForScanner();
      if (!targetCameraId) return; // Falló la obtención de cámara
  }

  if (scanMode === 'qr') {
    stopQRScanner();
    toggleBtn.textContent = 'Cargando Barras...';
    toggleBtn.disabled = true;
    await startBarcodeScanner(targetCameraId); // Esperar inicio
    toggleBtn.textContent = 'Modo Barras';
    scanMode = 'barcode';
    toggleBtn.disabled = false;
  } else {
    stopBarcodeScanner();
    toggleBtn.textContent = 'Cargando QR...';
    toggleBtn.disabled = true;
    await startQRScanner(targetCameraId); // Esperar inicio
    toggleBtn.textContent = 'Modo QR';
    scanMode = 'qr';
    toggleBtn.disabled = false;
  }
});

// --- Selector de Cámara --- ***** NUEVO/MODIFICADO *****
cameraSelector.addEventListener('change', async (event) => {
    const newCameraId = event.target.value;
    if (!newCameraId || newCameraId === currentCameraId) {
        return; // No hacer nada si no cambia o seleccionan la opción vacía
    }
    console.log(`Cambiando a cámara: ${newCameraId}`);
    cameraSelector.disabled = true; // Deshabilitar mientras cambia
    toggleBtn.disabled = true;

    if (scanMode === 'qr') {
        stopQRScanner();
        await startQRScanner(newCameraId);
    } else { // Modo Barcode
        // Quagga requiere reinicialización para cambiar cámara
        await stopBarcodeScanner(); // Asegurar que esté completamente detenido
        await startBarcodeScanner(newCameraId);
    }
    cameraSelector.disabled = false; // Rehabilitar después del cambio
    toggleBtn.disabled = false;
});

// --- Inicialización al Cargar ---
document.addEventListener('DOMContentLoaded', async () => {
  renderTable(); // Mostrar tabla guardada al inicio
  cameraSelector.disabled = true; // Deshabilitado inicialmente
  cameraSelector.style.display = 'none'; // Oculto inicialmente

  // Obtener cámaras y preparar, pero no iniciar hasta que el usuario quiera
  const initialCameraId = await getCameraIdForScanner();
  currentCameraId = initialCameraId; // Guardar ID por defecto para usarlo al iniciar QR

  // Iniciar en modo QR por defecto
  startQRScanner(currentCameraId);

  // Listeners para checkboxes (sin cambios)
  fieldChecks.forEach(checkbox => {
    checkbox.addEventListener('change', renderTable);
  });
});
