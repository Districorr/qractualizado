const resultBox = document.getElementById('qr-result');
const copyBtn = document.getElementById('copy-btn');

function onScanSuccess(decodedText, decodedResult) {
  resultBox.value = decodedText;
}

const html5QrCode = new Html5Qrcode("reader");
Html5Qrcode.getCameras().then(cameras => {
  if (cameras && cameras.length) {
    html5QrCode.start(
      cameras[0].id,
      { fps: 10, qrbox: 250 },
      onScanSuccess
    );
  }
}).catch(err => {
  console.error("Error accediendo a la cámara:", err);
});

copyBtn.addEventListener('click', () => {
  resultBox.select();
  document.execCommand("copy");
});
