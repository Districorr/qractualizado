const resultBox = document.getElementById('qr-result');
const copyBtn = document.getElementById('copy-btn');
const exportBtn = document.getElementById('export-btn');
const parsedDataContainer = document.getElementById('parsed-data');
const cameraSelect = document.getElementById('camera-select');

let scannedData = [];

function parseGS1(text) {
  const fields = {};
  const pattern = /\((\d{2})\)([^\(]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const ai = match[1];
    const value = match[2].trim();
    fields[ai] = value;
  }
  return fields;
}

function displayParsedData(fields) {
  parsedDataContainer.innerHTML = '';
  const map = {
    '01': 'GTIN',
    '10': 'Lote',
    '21': 'Serie'
  };
  for (const key in fields) {
    const label = map[key] || 'AI ' + key;
    const p = document.createElement('p');
    p.textContent = `${label}: ${fields[key]}`;
    parsedDataContainer.appendChild(p);
  }
}

function onScanSuccess(decodedText, decodedResult) {
  resultBox.value = decodedText;
  const parsed = parseGS1(decodedText);
  displayParsedData(parsed);
  scannedData.push(parsed);
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
  let csvContent = "data:text/csv;charset=utf-8,GTIN,Lote,Serie\n";
  scannedData.forEach(row => {
    csvContent += `${row['01'] || ''},${row['10'] || ''},${row['21'] || ''}\n`;
  });
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "scaneos_qr.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});
