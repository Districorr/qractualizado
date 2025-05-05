// Element references
const providerSelect = document.getElementById('provider-select');
const cameraSelect = document.getElementById('camera-select');
const toggleBtn = document.getElementById('toggle-scan-mode');
const exportBtn = document.getElementById('export-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportXlsxBtn = document.getElementById('export-xlsx-btn');
const printLabelsBtn = document.getElementById('print-labels-btn');
const statsBtn = document.getElementById('stats-btn');
const filterBtn = document.getElementById('filter-btn');
const filterFrom = document.getElementById('filter-from');
const filterTo = document.getElementById('filter-to');
const fieldChecks = document.querySelectorAll('.field-selector input[type=checkbox]');
const notification = document.getElementById('notification');
const resultBox = document.getElementById('qr-result');
const parsedDataContainer = document.getElementById('parsed-data');
const statsContainer = document.getElementById('stats-container');
const statsChartEl = document.getElementById('stats-chart');
let scanMode = 'qr';
let html5QrCode;
let scannedData = JSON.parse(localStorage.getItem('scannedData')) || [];

// Utility Notification
function showNotification(msg, type='success') {
  notification.innerHTML = `<div class="notification ${type}">${msg}</div>`;
  setTimeout(() => notification.innerHTML = '', 3000);
}

// GS1 parsing and validation
const SEPARATOR = String.fromCharCode(29);
function parseGS1(text) {
  let parts = text.includes(SEPARATOR) ? text.split(SEPARATOR) : text.match(/(\d{2,3})([^\d\x1D]+)/g) || [];
  const fields = {};
  parts.forEach(part => {
    const key = part.match(/^\d{2,3}/)?.[0];
    const value = part.slice(key.length).trim();
    fields[key] = value;
  });
  fields.scanDate = new Date().toISOString().slice(0,10);
  return fields;
}
function validateFields(fields) {
  if (fields['17'] && /^\d{6}$/.test(fields['17'])) {
    const d = fields['17'];
    let y=+('20'+d.slice(0,2)), m=+d.slice(2,4)-1, day=+d.slice(4,6);
    let dt=new Date(y,m,day), now=new Date();
    fields['17'] += dt < now? ' (¡Vencido!)': ` (Vence: ${day}/${m+1}/${y})`;
  }
}

// Check duplicates
function isDuplicate(newRow) {
  return scannedData.some(r => r['01']===newRow['01'] && r['10']===newRow['10'] && r['21']===newRow['21']);
}

// Render table with optional filter
function renderTable(data=scannedData) {
  parsedDataContainer.innerHTML = '';
  const table = document.createElement('table');
  const header = table.insertRow();
  const cols = Array.from(fieldChecks).filter(ch => ch.checked).map(ch => ch.value);
  header.innerHTML = ['Proveedor', ...cols, 'Fecha Escaneo', 'Acción'].map(c => '<th>'+c+'</th>').join('');
  data.forEach((row, idx) => {
    const tr = table.insertRow();
    tr.insertCell().textContent = row.provider||'';
    cols.forEach(c => tr.insertCell().textContent = row[c]||'');
    tr.insertCell().textContent = row.scanDate || '';
    const cell = tr.insertCell();
    const btn = document.createElement('button'); btn.textContent='🗑️';
    btn.onclick = ()=>{ scsplice(idx); renderTable(filteredData()); };
    cell.appendChild(btn);
    tr.classList.add('highlight');
  });
  parsedDataContainer.appendChild(table);
}

// Filtering
function filteredData() {
  let from = filterFrom.value, to = filterTo.value;
  if (!from && !to) return scannedData;
  return scannedData.filter(r=>{
    if (!r.scanDate) return false;
    return (!from||r.scanDate>=from) && (!to||r.scanDate<=to);
  });
}

// Export CSV
exportBtn.addEventListener('click', ()=>{
  const cols = Array.from(fieldChecks).filter(ch=>ch.checked).map(ch=>ch.value);
  let csv=['Proveedor',...cols,'FechaEscaneo'].join(',')+'\n';
  filteredData().forEach(r=>{
    csv+=[r.provider,...cols.map(c=>r[c]||''),r.scanDate].join(',')+'\n';
  });
  const uri='data:text/csv;charset=utf-8,'+encodeURI(csv);
  const link=document.createElement('a'); link.href=uri; link.download='scaneos.csv'; link.click();
});

// Export JSON
exportJsonBtn.addEventListener('click', ()=>{
  const data = filteredData();
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const link = document.createElement('a'); link.href=URL.createObjectURL(blob);
  link.download='scaneos.json'; link.click();
});

// Export XLSX
exportXlsxBtn.addEventListener('click', ()=>{
  const wb = XLSX.utils.book_new();
  const cols = Array.from(fieldChecks).filter(ch=>ch.checked).map(ch=>ch.value);
  const data = filteredData().map(r=>{
    let obj={Proveedor:r.provider, FechaEscaneo:r.scanDate};
    cols.forEach(c=>obj[c]=r[c]||'');
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Scaneos');
  XLSX.writeFile(wb, 'scaneos.xlsx');
});

// Print PDF Labels
printLabelsBtn.addEventListener('click', ()=>{
  import('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js').then(jsPDF=>{
    const { jsPDF: PDF } = jsPDF;
    const doc = new PDF({unit:'pt',format:'A4'});
    let x=40,y=40;
    filteredData().forEach((r,i)=>{
      doc.text(`GTIN:${r['01']}`,x,y);
      doc.text(`Lote:${r['10']}`,x,y+12);
      JsBarcode.create(r['01'],{format:'ean13'}).options({width:1,height:20});
      doc.addImage(JsBarcode.toDataURL(), 'PNG', x, y+20, 100, 40);
      y+=100;
      if (y>700){ doc.addPage(); y=40;}
    });
    doc.save('etiquetas.pdf');
  });
});

// Statistics
statsBtn.addEventListener('click', ()=>{
  const data = filteredData();
  const countsByProvider = {};
  data.forEach(r=>countsByProvider[r.provider]=(countsByProvider[r.provider]||0)+1);
  const labels = Object.keys(countsByProvider);
  const values = labels.map(l=>countsByProvider[l]);
  statsContainer.classList.remove('hidden');
  new Chart(statsChartEl, {
    type: 'bar',
    data: { labels, datasets:[{ label:'Escaneos por Proveedor', data: values }] }
  });
});

// Scanner init with camera selection
function setupCameras(){
  Html5Qrcode.getCameras().then(cams=>{
    cams.forEach(c=> {
      const opt=document.createElement('option');
      opt.value=c.id; opt.textContent=c.label||c.id;
      cameraSelect.appendChild(opt);
    });
    if(cams.length) startScan(cams[0].id);
  });
}

function startScan(camId){
  stopQR(); stopBarcode();
  if(scanMode==='qr'){
    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(camId,{fps:10,qrbox:250},txt=>onScanSuccess(txt),err=>{});
  } else {
    Quagga.init({inputStream:{name:'Live',type:'LiveStream',target:document.getElementById('reader'),constraints:{deviceId:camId}},decoder:{readers:['code_128_reader','ean_reader']}},err=>{if(!err)Quagga.start();});
    Quagga.onDetected(data=>onScanSuccess(data.codeResult.code));
  }
}

// Stop scanners
function stopQR(){ if(html5QrCode) html5QrCode.stop(); }
function stopBarcode(){ Quagga && Quagga.stop(); Quagga && Quagga.offDetected(); }

// On toggle
toggleBtn.addEventListener('click',()=>{
  scanMode = scanMode==='qr'?'barcode':'qr';
  toggleBtn.textContent = scanMode==='qr'?'Modo QR':'Modo Barras';
  startScan(cameraSelect.value);
});

// On camera change
cameraSelect.addEventListener('change', ()=> startScan(cameraSelect.value));

// On filter
filterBtn.addEventListener('click', ()=> renderTable(filteredData()));

// On scan success
function onScanSuccess(decoded){
  resultBox.value = decoded;
  const parsed = parseGS1(decoded);
  validateFields(parsed);
  parsed.provider = providerSelect.value;
  if(!parsed['01']) return showNotification('GTIN no encontrado','error');
  if(isDuplicate(parsed)) return showNotification('Ya escaneado','error');
  scannedData.push(parsed);
  localStorage.setItem('scannedData', JSON.stringify(scannedData));
  renderTable();
  showNotification('Añadido con éxito');
}

// Initialize
renderTable();
setupCameras();
