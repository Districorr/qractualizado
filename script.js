
const resultBox = document.getElementById('qr-result');
const copyBtn = document.getElementById('copy-btn');
const exportBtn = document.getElementById('export-btn');
const parsedDataContainer = document.getElementById('parsed-data');
const cameraSelect = document.getElementById('camera-select');

let scannedData = JSON.parse(localStorage.getItem('scannedData')) || [];

const SEPARATOR = String.fromCharCode(29);

function parseGS1(text) {
  const fields = {};
  const parts = text.split(SEPARATOR).length > 1 ? text.split(SEPARATOR) : text.match(/(\d{2})([^\d\x1D]+)/g) || [];

  for (const part of parts) {
    const code = part.slice(0, 2);
    const value = part.slice(2).trim();

    if (['01', '10', '17', '21', '22'].includes(code)) {
      fields[code] = value;
    }
  }
  return fields;
}

function validateFields(fields) {
  if (fields['17']) {
    const dateStr = fields['17'];
    if (/^\d{6}$/.test(dateStr)) {
      const year = parseInt('20' + dateStr.slice(0, 2));
      const month = parseInt(dateStr.slice(2, 4)) - 1;
      const day = parseInt(dateStr.slice(4, 6));
      const date = new Date(year, month, day);
      if (!isNaN(date)) {
        const now = new Date();
        if (date < now) {
          fields['17'] += ' (¡Vencido!)';
        } else {
          fields['17'] += ` (Vence: ${day}/${month + 1}/${year})`;
        }
      }
    } else {
      fields['17'] += ' (Formato inválido)';
    }
  }
}

function renderTable() {
  parsedDataContainer.innerHTML = '';
  const table = document.createElement('table');
  table.style.width = "100%";
  table.setAttribute('border', '1');

  const header = table.insertRow();
  header.innerHTML = "<th>GTIN</th><th>Lote</th><th>Vencimiento</th><th>Serie</th><th>Código</th><th>Eliminar</th>";

  scannedData.forEach((row, index) => {
    const tr = table.insertRow();
    tr.insertCell().textContent = row['01'] || '';
    tr.insertCell().textContent = row['10'] || '';
    tr.insertCell().textContent = row['17'] || '';
    tr.insertCell().textContent = row['21'] || '';
    tr.insertCell().textContent = row['22'] || '';

    const delCell = tr.insertCell();
    const btn = document.createElement('button');
    btn.textContent = '🗑️';
    btn.onclick = () => {
      scannedData.splice(index, 1);
      localStorage.setItem('scannedData', JSON.stringify(scannedData));
      renderTable();
    };
    delCell.appendChild(btn);
  });

  parsedDataContainer.appendChild(table);
}

function isDuplicate(newRow) {
  return scannedData.some(row =>
    row['01'] === newRow['01'] &&
    row['10'] === newRow['10'] &&
    row['21'] === newRow['21']
  );
}

function onScanSuccess(decodedText, decodedResult) {
  resultBox.value = decodedText;
  const parsed = parseGS1(decodedText);
  validateFields(parsed);

  if (isDuplicate(parsed)) {
    alert("Este código ya ha sido escaneado.");
    return;
  }

  scannedData.push(parsed);
  localStorage.setItem('scannedData', JSON.stringify(scannedData));
  renderTable();
}

const html5QrCode = new Html5Qrcode("reader");

Html5Qrcode.getCameras().then(cameras => {
  if (cameras.length) {
    cameras.forEach((camera, idx) => {
      const option = document.createElement('option');
      option.value = camera.id;
      option.text = camera.label || `Cámara ${idx + 1}`;
      cameraSelect.appendChild(option);
    });

    const selectedId = cameraSelect.value || cameras[0].id;
    html5QrCode.start(selectedId, { fps: 10, qrbox: 250 }, onScanSuccess);
  }

  cameraSelect.addEventListener('change', () => {
    html5QrCode.stop().then(() => {
      html5QrCode.start(cameraSelect.value, { fps: 10, qrbox: 250 }, onScanSuccess);
    });
  });
}).catch(err => {
  console.error("Error accediendo a la cámara:", err);
});

copyBtn.addEventListener('click', () => {
  resultBox.select();
  document.execCommand("copy");
});

exportBtn.addEventListener('click', () => {
  let csvContent = "data:text/csv;charset=utf-8,GTIN,Lote,Vencimiento,Serie,Código\n";
  scannedData.forEach(row => {
    csvContent += `${row['01'] || ''},${row['10'] || ''},${row['17'] || ''},${row['21'] || ''},${row['22'] || ''}\n`;
  });
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "scaneos_qr.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

// Cargar tabla al iniciar
renderTable();
