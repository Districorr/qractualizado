const providerSelect = document.getElementById('provider-select');
const toggleBtn = document.getElementById('toggle-scan-mode');
const exportBtn = document.getElementById('export-btn');
const exportXlsxBtn = document.getElementById('export-xlsx-btn');
const fieldChecks = document.querySelectorAll('.field-selector input[type=checkbox]');
const notification = document.getElementById('notification');
const resultBox = document.getElementById('qr-result');
const parsedDataContainer = document.getElementById('parsed-data');
let scanMode = 'qr';
let html5QrCode;
let scannedData = JSON.parse(localStorage.getItem('scannedData')) || [];

// GS1 Separator
const SEPARATOR = String.fromCharCode(29);

function showNotification(msg, type='success') {
  notification.innerHTML = `<div class="notification ${type}">${msg}</div>`;
  setTimeout(() => { notification.innerHTML = ''; }, 3000);
}

function parseGS1(text) {
  let parts = text.split(SEPARATOR).length > 1 
    ? text.split(SEPARATOR) 
    : text.match(/(\d{2,3})([^\d\x1D]+)/g) || [];
  const fields = {};
  for (const part of parts) {
    const code = part.slice(0, part.length- part.replace(/^(\d{2,3})/, '$1').length);
    const key = part.match(/^\d{2,3}/)?.[0];
    const value = part.slice(key.length).trim();
    fields[key] = value;
  }
  return fields;
}

function validateFields(fields) {
  if (fields['17']) {
    const d = fields['17'];
    if (/^\d{6}$/.test(d)) {
      const y=+('20'+d.slice(0,2)), m=+d.slice(2,4)-1, day=+d.slice(4,6);
      const dt=new Date(y,m,day), now=new Date();
      fields['17'] += dt < now ? ' (¡Vencido!)' : ` (Vence: ${day}/${m+1}/${y})`;
    }
  }
}

function isDuplicate(newRow) {
  return scannedData.some(r => 
    r['01']===newRow['01'] && r['10']===newRow['10'] && r['21']===newRow['21']
  );
}

function onScanSuccess(decoded) {
  resultBox.value = decoded;
  let parsed = parseGS1(decoded);
  validateFields(parsed);
  parsed.provider = providerSelect.value;
  if (!parsed['01']) return showNotification('GTIN no encontrado', 'error');
  if (isDuplicate(parsed)) return showNotification('Ya escaneado', 'error');

  scannedData.push(parsed);
  localStorage.setItem('scannedData', JSON.stringify(scannedData));
  renderTable();
  showNotification('Añadido con éxito');
}

function renderTable() {
  parsedDataContainer.innerHTML = '';
  const table = document.createElement('table');
  const header = table.insertRow();
  const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ch.value);
  header.innerHTML = ['Proveedor', ...cols].map(c => '<th>'+c+'</th>').join('') + '<th>Acción</th>';

  scannedData.forEach((row, idx) => {
    const tr = table.insertRow();
    tr.insertCell().textContent = row.provider || '';
    cols.forEach(c => tr.insertCell().textContent = row[c] || '');
    const cell = tr.insertCell();
    const btn = document.createElement('button');
    btn.textContent = '🗑️';
    btn.onclick = () => { scannedData.splice(idx,1); localStorage.setItem('scannedData', JSON.stringify(scannedData)); renderTable(); };
    cell.appendChild(btn);
    tr.classList.add('highlight');
  });
  parsedDataContainer.appendChild(table);
}

exportBtn.addEventListener('click', () => {
  const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ch.value);
  let csv = ['Proveedor', ...cols].join(',') + '\n';
  scannedData.forEach(r => {
    csv += [r.provider, ...cols.map(c => r[c]||'')].join(',') + '\n';
  });
  const uri = 'data:text/csv;charset=utf-8,' + encodeURI(csv);
  const link = document.createElement('a');
  link.href = uri; link.download = 'scaneos.csv';
  link.click();
});

exportXlsxBtn.addEventListener('click', () => {
  const wb = XLSX.utils.book_new();
  const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ch.value);
  const data = scannedData.map(r => {
    let obj = { Proveedor: r.provider };
    cols.forEach(c => obj[c] = r[c]||'');
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Scaneos');
  XLSX.writeFile(wb, 'scaneos.xlsx');
});

// QR Scanner
function startQR() {
  html5QrCode = new Html5Qrcode("reader");
  Html5Qrcode.getCameras().then(cameras => {
    if (cameras.length) {
      html5QrCode.start(cameras[0].id, { fps: 10, qrbox: 250 }, txt => onScanSuccess(txt), err => {})
    }
  });
}
function stopQR() { if (html5QrCode) html5QrCode.stop(); }

// Barcode Scanner
function startBarcode() {
  Quagga.init({
    inputStream: { name: "Live", type: "LiveStream", target: document.getElementById("reader") },
    decoder: { readers: ["code_128_reader","ean_reader"] }
  }, err => { if (!err) Quagga.start(); });
  Quagga.onDetected(data => onScanSuccess(data.codeResult.code));
}
function stopBarcode() {
  Quagga.stop();
  Quagga.offDetected();
}

// Toggle
toggleBtn.addEventListener('click', () => {
  if (scanMode === 'qr') {
    stopQR(); startBarcode();
    toggleBtn.textContent = 'Modo Barras'; scanMode='barcode';
  } else {
    stopBarcode(); startQR();
    toggleBtn.textContent = 'Modo QR'; scanMode='qr';
  }
});

// Initialize
renderTable();
startQR();
