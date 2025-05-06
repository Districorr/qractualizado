// --- Elementos DOM ---
const providerSelect = document.getElementById('provider-select');
const toggleBtn = document.getElementById('toggle-scan-mode');
// ... (resto de las variables DOM como estaban) ...
const startScanButton = document.getElementById('start-scan-button');
const stopScanButton = document.getElementById('stop-scan-button');
const scannerControlsDiv = document.getElementById('scanner-controls');
const scannerActiveControlsDiv = document.getElementById('scanner-active-controls');
const cameraSelector = document.getElementById('camera-selector');
const cameraStatus = document.getElementById('camera-status');
const statusElement = document.getElementById('status');
const cameraSelectLabel = document.getElementById('camera-select-label');
const readerDiv = document.getElementById('reader');
const resultBox = document.getElementById('qr-result');
const parsedDataContainer = document.getElementById('parsed-data');
const tableContainer = document.getElementById('table-placeholder');
const notification = document.getElementById('notification');
const exportBtn = document.getElementById('export-btn');
const exportXlsxBtn = document.getElementById('export-xlsx-btn');
const fieldChecks = document.querySelectorAll('.field-selector input[type=checkbox]');


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

// --- Funciones ---
function showNotification(msg, type = 'success', duration = 3000) { /* ...sin cambios... */
    notification.innerHTML = `<div class="notification ${type}">${msg}</div>`;
    setTimeout(() => { notification.innerHTML = ''; }, duration);
}
function parseGS1GenericWithFNC1(data) { /* ...sin cambios... */
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
                 console.warn("No FNC1, intentando parseo simple."); const match = remainingData.match(/^(\d{2,4})(.+)/); if (match) { fields[match[1]] = match[2].trim(); }
             } else { console.warn("No se pudo identificar AI GS1 en:", remainingData.substring(currentIndex)); } break;
        }
        if (ai && value !== null) { fields[ai] = value.trim(); } currentIndex = nextIndex;
    } return fields;
}
function formatGS1Date(yymmdd) { /* ...sin cambios... */
    if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return yymmdd;
    try {
        const year = parseInt(yymmdd.substring(0, 2), 10); const month = parseInt(yymmdd.substring(2, 4), 10); const day = parseInt(yymmdd.substring(4, 6), 10);
        const currentYearLastTwoDigits = new Date().getFullYear() % 100; const fullYear = year <= (currentYearLastTwoDigits + 10) ? 2000 + year : 1900 + year;
        if (month < 1 || month > 12 || day < 1 || day > 31) return `${yymmdd} (Inválida)`;
        const dateObj = new Date(Date.UTC(fullYear, month - 1, day));
        if (dateObj.getUTCDate() !== day || dateObj.getUTCMonth() !== month - 1 || dateObj.getUTCFullYear() !== fullYear) { return `${yymmdd} (Inválida)`; }
        const formattedDate = `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${fullYear}`;
        const today = new Date(); today.setHours(0, 0, 0, 0); dateObj.setUTCHours(0,0,0,0); const isExpired = dateObj < today;
        return `${formattedDate}${isExpired ? ' (¡Vencido!)' : ''}`;
    } catch (e) { console.error("Error formateando fecha:", e); return `${yymmdd} (Error)`; }
}
function structureBioproteceData(genericFields, rawData) { /* ...sin cambios... */
    const structured = { provider: 'BIOPROTECE', fields: {}, rawData: rawData, allFields: genericFields };
    const mapping = { '21': 'Serie', '17': 'Vencimiento', '10': 'Lote', '22': 'Código Artículo' };
    for (const ai in mapping) { if (genericFields[ai]) { let value = genericFields[ai]; if (ai === '17') { value = formatGS1Date(value); } structured.fields[mapping[ai]] = value; } else { structured.fields[mapping[ai]] = ''; } }
    if (genericFields['01']) { structured.fields['GTIN'] = genericFields['01']; } return structured;
}
function structureSaiData(genericFields, rawData) { /* ...sin cambios... */
    const structured = { provider: 'SAI', fields: {}, rawData: rawData, allFields: genericFields };
    const mapping = { '01': 'GTIN', '17': 'Vencimiento', '10': 'Lote', '240': 'Código Artículo' };
    for (const ai in mapping) { if (genericFields[ai]) { let value = genericFields[ai]; if (ai === '17') { value = formatGS1Date(value); } structured.fields[mapping[ai]] = value; } else { structured.fields[mapping[ai]] = ''; } }
    if (genericFields['21']) { structured.fields['Serie'] = genericFields['21']; } return structured;
}
function structureGenericData(genericFields, rawData) { /* ...sin cambios... */
    const structured = { provider: 'Genérico', fields: {}, rawData: rawData, allFields: genericFields };
    const commonMapping = { '01': 'GTIN', '10': 'Lote', '17': 'Vencimiento', '21': 'Serie', '22':'Código Art.(22)', '240':'Ref.(240)' };
    for (const ai in commonMapping) { if (genericFields[ai]) { let value = genericFields[ai]; if (ai === '17') value = formatGS1Date(value); structured.fields[commonMapping[ai]] = value; } }
    for(const ai in genericFields) { if (!Object.values(commonMapping).includes(ai) && !commonMapping[ai]) { structured.fields[`AI(${ai})`] = genericFields[ai]; } } return structured;
}
function displayParsedFields(structuredData) { /* ...sin cambios... */
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
function isDuplicate(newStructuredData) { /* ...sin cambios... */
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
function renderTable() { /* ...sin cambios... */
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
            else { cellValue = (storedRecord.allFields?.[col.value] || dataFields[col.value] || ''); if (col.value === '17' && cellValue && storedRecord.allFields && /^\d{6}$/.test(storedRecord.allFields['17'])) { cellValue = formatGS1Date(storedRecord.allFields['17']); } }
            tr.insertCell().textContent = cellValue;
        });
        const cell = tr.insertCell(); const btn = document.createElement('button'); btn.textContent = '🗑️';
        btn.onclick = () => { scannedData.splice(idx, 1); localStorage.setItem('scannedData', JSON.stringify(scannedData)); renderTable(); };
        cell.appendChild(btn); tr.classList.add('highlight');
    }); tableContainer.appendChild(table);
}
exportBtn.addEventListener('click', () => { /* ...sin cambios... */
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
    }); const uri = 'data:text/csv;charset=utf-8,' + encodeURI(csv); const link = document.createElement('a'); link.href = uri; link.download = 'escaneos.csv'; link.click(); showNotification('CSV exportado');
});
exportXlsxBtn.addEventListener('click', () => { /* ...sin cambios... */
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
    }); const ws = XLSX.utils.json_to_sheet(data); XLSX.utils.book_append_sheet(wb, ws, 'Scaneos'); XLSX.writeFile(wb, 'scaneos.xlsx'); showNotification('XLSX exportado');
});
function onScanSuccessMain(decodedText) { /* ...sin cambios... */
    resultBox.value = decodedText; parsedDataContainer.innerHTML = '';
    const selectedProviderValue = providerSelect.value; let structuredData;
    try {
        const genericFields = parseGS1GenericWithFNC1(decodedText);
        if (Object.keys(genericFields).length === 0 && decodedText.length > 0) { structuredData = { provider: selectedProviderValue || 'Texto Simple', fields: { 'Texto': decodedText }, rawData: decodedText, allFields: {} }; showNotification('Código leído como texto simple', 'warning'); }
        else { switch (selectedProviderValue) { case 'bioprotece': structuredData = structureBioproteceData(genericFields, decodedText); break; case 'sai': structuredData = structureSaiData(genericFields, decodedText); break; default: structuredData = structureGenericData(genericFields, decodedText); break; } }
        displayParsedFields(structuredData); if (isDuplicate(structuredData)) { showNotification('Este código ya fue escaneado.', 'error'); return; }
        scannedData.push(structuredData); localStorage.setItem('scannedData', JSON.stringify(scannedData)); renderTable(); showNotification(`Escaneo (${structuredData.provider}) añadido`);
    } catch (error) { console.error("Error procesando el escaneo:", error); showNotification(`Error al procesar: ${error.message}`, 'error'); parsedDataContainer.innerHTML = `<p>Error al interpretar datos.</p>`; }
}
function onScanFailureQR(error) { console.log("QR Scan Error: ", error); } // Añadido log para depurar
function onQuaggaDetected(result) { if (result && result.codeResult && result.codeResult.code) { onScanSuccessMain(result.codeResult.code); } }

// --- Lógica de UI (Mostrar/Ocultar Controles) ---
function showStartUI() {
    startScanButton.style.display = 'inline-block';
    stopScanButton.style.display = 'none';
    scannerActiveControlsDiv.style.display = 'none';
    readerDiv.innerHTML = ''; // Asegurarse que el visor esté limpio
    readerDiv.style.display = 'none';
    statusElement.textContent = "Listo para iniciar.";
    providerSelect.disabled = false;
    toggleBtn.disabled = false;
    cameraSelector.disabled = true;
    cameraSelectLabel.style.display = 'none';
    cameraSelector.style.display = 'none';
    cameraStatus.textContent = '';
    isScanning = false; // Marcar como no escaneando
}

function showScanningUI() {
    startScanButton.style.display = 'none';
    stopScanButton.style.display = 'inline-block';
    scannerActiveControlsDiv.style.display = 'block';
    readerDiv.style.display = 'block'; // Mostrar el visor
    statusElement.textContent = "Iniciando...";
    providerSelect.disabled = true;
    toggleBtn.disabled = true;
    cameraSelector.disabled = false; // Habilitar para que el usuario pueda cambiar
    cameraSelectLabel.style.display = availableCameras.length > 1 ? 'inline-block' : 'none';
    cameraSelector.style.display = availableCameras.length > 1 ? 'inline-block' : 'none';
}

// --- Inicialización y Control de Escáneres ---
async function requestPermissionAndGetCameraId() {
    statusElement.textContent = "Solicitando permiso...";
    cameraStatus.textContent = '';
    console.log("Requesting camera permission...");
    try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        console.log("Permiso de cámara concedido.");
        availableCameras = await Html5Qrcode.getCameras();
        console.log("Cámaras disponibles:", availableCameras);
        if (availableCameras && availableCameras.length) {
            cameraSelector.innerHTML = '<option value="">-- Cambiar Cámara --</option>';
            availableCameras.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.id;
                option.text = device.label || `Cámara ${index + 1}`;
                cameraSelector.appendChild(option);
            });
            let selectedCamera = availableCameras.find(device => device.label && /back|rear|trás|trasera/i.test(device.label)) || availableCameras[0];
            console.log("Cámara seleccionada para iniciar:", selectedCamera.label || selectedCamera.id);
            cameraSelector.value = selectedCamera.id;
            return selectedCamera.id;
        } else {
            cameraStatus.textContent = "No se encontraron cámaras."; statusElement.textContent = "Sin Cámaras"; console.warn("No cameras found."); return null;
        }
    } catch (err) {
        console.error("Error en requestPermissionAndGetCameraId:", err);
        let errorMsg = "Error al acceder a la cámara.";
        if (`${err}`.toLowerCase().includes("permission denied") || `${err}`.toLowerCase().includes("notallowederror")) { errorMsg = "Permiso de cámara denegado."; }
        else if (`${err}`.toLowerCase().includes("notfounderror")) { errorMsg = "No se encontró una cámara compatible."; }
        cameraStatus.textContent = errorMsg; statusElement.textContent = "Error Cámara"; return null;
    }
}

async function startQRScanner(cameraId) {
    console.log(`Intentando iniciar QR Scanner con cameraID: ${cameraId}`);
    if (!cameraId) {
        showNotification("ID de cámara no válido para QR.", "error");
        isScanning = false; showStartUI(); return;
    }
    showScanningUI(); statusElement.textContent = "Iniciando QR..."; cameraStatus.textContent = "";
    await stopBarcodeScanner(); readerDiv.innerHTML = '';
    if (!html5QrCode) { html5QrCode = new Html5Qrcode("reader", { verbose: false }); } // verbose:false para menos logs de librería
    const config = { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.777 };
    try {
        await html5QrCode.start(cameraId, config, onScanSuccessMain, onScanFailureQR);
        console.log(`Escáner QR iniciado exitosamente con cámara ${cameraId}.`);
        statusElement.textContent = "Escaneando (QR)..."; currentCameraId = cameraId; isScanning = true; cameraSelector.disabled = availableCameras.length <= 1;
    } catch (err) {
        console.error(`Error al iniciar escáner QR con ${cameraId}:`, err);
        cameraStatus.textContent = "Error al iniciar QR: " + err.name + " - " + err.message; statusElement.textContent = "Error QR";
        isScanning = false; showStartUI(); // Volver a UI inicial si falla
    }
}

async function stopQRScanner() {
    console.log("Intentando detener QR Scanner...");
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            await html5QrCode.stop(); console.log("Escáner QR detenido.");
        } catch (err) { console.error("Error al detener QR:", err); }
        finally { readerDiv.innerHTML = ''; currentCameraId = null; isScanning = false; }
    } else { isScanning = false; console.log("QR Scanner no estaba activo o ya detenido."); }
}

async function startBarcodeScanner(cameraId) {
    console.log(`Intentando iniciar Barcode Scanner con cameraID: ${cameraId}`);
    if (!cameraId) {
        showNotification("ID de cámara no válido para Barras.", "error");
        isScanning = false; showStartUI(); return;
    }
    showScanningUI(); statusElement.textContent = "Iniciando Barras..."; cameraStatus.textContent = "";
    await stopQRScanner(); readerDiv.innerHTML = '';
    const quaggaConfig = { /* ...configuración Quagga... */
        inputStream: { name: "Live", type: "LiveStream", target: readerDiv, constraints: { deviceId: cameraId, facingMode: "environment" }, area: { top: "20%", bottom: "20%", left: "10%", right: "10%" } },
        locator: { patchSize: "medium", halfSample: true }, numOfWorkers: Math.min(navigator.hardwareConcurrency || 2, 4), frequency: 10,
        decoder: { readers: ["code_128_reader", "ean_reader", "ean_8_reader", "code_39_reader", "codabar_reader", "upc_reader", "i2of5_reader"], }, locate: true
    };
    try {
        if (isQuaggaInitialized) { console.log("Quagga ya inicializado, intentando detener..."); await Quagga.stop(); isQuaggaInitialized = false; }
        console.log("Inicializando Quagga...");
        Quagga.init(quaggaConfig, (err) => {
            if (err) {
                console.error("Error de inicialización Quagga:", err);
                cameraStatus.textContent = "Error al iniciar Barras: " + err; statusElement.textContent = "Error Barras";
                isScanning = false; showStartUI(); return;
            }
            console.log(`Quagga inicializado con cámara ${cameraId}. Iniciando Quagga...`);
            Quagga.start();
            isQuaggaInitialized = true; statusElement.textContent = "Escaneando (Barras)..."; currentCameraId = cameraId; isScanning = true; cameraSelector.disabled = availableCameras.length <= 1;
        });
        Quagga.offDetected(onQuaggaDetected); Quagga.onDetected(onQuaggaDetected);
    } catch (err) {
        console.error("Excepción al iniciar Quagga:", err); cameraStatus.textContent = "Error al iniciar Barras: " + err.message; statusElement.textContent = "Error Barras";
        isScanning = false; showStartUI();
    }
}

async function stopBarcodeScanner() {
    console.log("Intentando detener Barcode Scanner...");
    if (isQuaggaInitialized && typeof Quagga !== 'undefined' && Quagga.stop) {
        try {
            await Quagga.stop(); console.log("Escáner de Barras detenido.");
        } catch (err) { if (!err.message.includes("Cannot read property 'stop'")) { console.error("Error al detener Quagga:", err); }}
        finally { readerDiv.innerHTML = ''; isQuaggaInitialized = false; currentCameraId = null; isScanning = false; }
    } else { isScanning = false; console.log("Barcode Scanner (Quagga) no estaba activo o ya detenido."); }
}

async function stopScan() {
    console.log("Función stopScan llamada.");
    if (!isScanning && !(html5QrCode && html5QrCode.isScanning) && !isQuaggaInitialized) {
        console.log("Ningún escáner activo para detener.");
        showStartUI(); // Asegurar que la UI esté en estado inicial
        return;
    }
    stopScanButton.disabled = true; statusElement.textContent = "Deteniendo...";
    if (scanMode === 'qr') { await stopQRScanner(); }
    else { await stopBarcodeScanner(); }
    showStartUI(); stopScanButton.disabled = false;
}

// --- Botón de Inicio ---
startScanButton.addEventListener('click', async () => {
    console.log("Botón Iniciar Escaneo presionado.");
    startScanButton.disabled = true; startScanButton.textContent = "Iniciando...";
    cameraStatus.textContent = ''; statusElement.textContent = '';
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
        cameraStatus.textContent = 'Error: Se requiere HTTPS.'; statusElement.textContent = "Error HTTPS";
        startScanButton.disabled = false; startScanButton.textContent = "Iniciar Escaneo"; return;
    }
    const cameraId = await requestPermissionAndGetCameraId();
    if (cameraId) {
        currentCameraId = cameraId; // Guardar ID para cambios posteriores
        console.log(`Permiso obtenido y cámara ID: ${cameraId}. Modo actual: ${scanMode}`);
        if (scanMode === 'qr') { await startQRScanner(cameraId); }
        else { await startBarcodeScanner(cameraId); }
    } else {
        console.warn("No se obtuvo cameraId después de solicitar permiso.");
        showStartUI(); startScanButton.disabled = false; startScanButton.textContent = "Iniciar Escaneo";
    }
    if (!isScanning) { // Si el inicio falló, rehabilitar botón
        console.log("El escaneo no se inició, rehabilitando botón de inicio.");
        startScanButton.disabled = false; startScanButton.textContent = "Iniciar Escaneo";
        showStartUI(); // Asegurar que la UI se muestre correctamente
    }
});

// --- Botón de Detener ---
stopScanButton.addEventListener('click', () => { stopScan(); });

// --- Toggle de Modo ---
toggleBtn.addEventListener('click', async () => {
    console.log("Botón Toggle presionado. Modo actual:", scanMode);
    const wasScanningPreviously = isScanning;
    let targetCameraId = currentCameraId;

    if (isScanning) { // Solo detener si realmente estaba escaneando
        await stopScan();
    } else { // Si no estaba escaneando, mostrar UI inicial por si acaso
        showStartUI();
    }

    if (!wasScanningPreviously && !currentCameraId) { // Si no escaneaba y no hay cámara guardada
        console.log("No había escaneo previo y no hay cámara guardada, solicitando permiso...");
        targetCameraId = await requestPermissionAndGetCameraId();
        if (!targetCameraId) { console.warn("No se pudo obtener cámara para cambiar modo."); showStartUI(); return; }
        currentCameraId = targetCameraId;
    } else if (!targetCameraId && availableCameras.length > 0) { // Si no hay cámara actual pero sí disponibles
        targetCameraId = availableCameras[0].id; // Usar la primera como fallback
        currentCameraId = targetCameraId;
         cameraSelector.value = targetCameraId; // Actualizar el select
         console.log("No había cámara actual, usando la primera disponible:", targetCameraId);
    }


    if (scanMode === 'qr') {
        scanMode = 'barcode'; toggleBtn.textContent = 'Modo Barras';
        console.log("Cambiado a modo Barras.");
    } else {
        scanMode = 'qr'; toggleBtn.textContent = 'Modo QR';
        console.log("Cambiado a modo QR.");
    }

    // Si tenemos un ID de cámara (ya sea porque estaba escaneando o se obtuvo)
    // simular clic en Iniciar para que el flujo de inicio se active con el nuevo modo.
    if (targetCameraId) {
        console.log("Simulando clic en Iniciar para el nuevo modo.");
        startScanButton.click();
    } else {
         console.warn("No hay targetCameraId para iniciar el nuevo modo.");
         showStartUI(); // Mantener UI inicial si no hay cámara
    }
});

// --- Selector de Cámara ---
cameraSelector.addEventListener('change', async (event) => {
    const newCameraId = event.target.value;
    if (!newCameraId || newCameraId === currentCameraId || !isScanning) {
        if (!newCameraId && currentCameraId) cameraSelector.value = currentCameraId;
        return;
    }
    console.log(`Cambiando a cámara: ${newCameraId}`);
    cameraSelector.disabled = true; toggleBtn.disabled = true; stopScanButton.disabled = true;
    statusElement.textContent = `Cambiando a cámara...`;
    // Detener el escáner actual
    if (scanMode === 'qr') { await stopQRScanner(); } else { await stopBarcodeScanner(); }
    currentCameraId = newCameraId; // Actualizar el ID actual
    // Reiniciar el escáner en el mismo modo con la nueva cámara
    if (scanMode === 'qr') { await startQRScanner(newCameraId); }
    else { await startBarcodeScanner(newCameraId); }

    if (!isScanning) { cameraSelector.disabled = false; toggleBtn.disabled = false; stopScanButton.disabled = true; showStartUI(); }
    else { cameraSelector.disabled = availableCameras.length <= 1; toggleBtn.disabled = false; stopScanButton.disabled = false;}
});

// --- Inicialización al Cargar ---
document.addEventListener('DOMContentLoaded', () => {
  console.log("DOM Cargado. Configurando UI inicial.");
  renderTable();
  showStartUI();
  fieldChecks.forEach(checkbox => { checkbox.addEventListener('change', renderTable); });
});
