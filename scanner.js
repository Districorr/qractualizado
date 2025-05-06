let scanner;
let currentCameraId = null;
let html5QrCode = null; // Keep instance reference
let audioContext = null; // NUEVO: Para el sonido
let autoClearTimeout = null; // NUEVO: Para limpieza automática

// DOM Elements (cache for slight performance gain)
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
const copyButton = document.getElementById('copy-button'); // NUEVO
const clearButton = document.getElementById('clear-button'); // NUEVO
const soundToggle = document.getElementById('sound-toggle');     // NUEVO
const autoClearToggle = document.getElementById('auto-clear-toggle'); // NUEVO

// --- Initialization ---

// Initialize the scanner and camera selection
async function initScanner() {
    cameraStatus.textContent = ''; // Clear previous errors
    try {
        if (!navigator.mediaDevices) {
             cameraStatus.textContent = 'Error: MediaDevices API no soportada.';
             console.error('MediaDevices API not supported.');
             return;
        }

        // NUEVO: Inicializar AudioContext (requiere interacción del usuario a veces, mejor al primer uso)
        // audioContext = new (window.AudioContext || window.webkitAudioContext)();

        const devices = await Html5Qrcode.getCameras();
        cameraSelector.innerHTML = '<option value="">Seleccionar cámara...</option>'; // Clear previous options

        if (!devices || devices.length === 0) {
            cameraStatus.textContent = 'No se encontraron cámaras disponibles.';
            console.error('No cameras found.');
            return;
        }

        devices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.id;
            option.text = device.label || `Cámara ${index + 1} (ID: ${device.id.substring(0, 6)}...)`;
            cameraSelector.appendChild(option);
        });

        const backCam = devices.find(d =>
            d.label && (
                d.label.toLowerCase().includes('back') ||
                d.label.toLowerCase().includes('rear') ||
                d.label.toLowerCase().includes('trás')
            )
        ) || devices[0];

        currentCameraId = backCam.id;
        cameraSelector.value = backCam.id;
        await startScanner(backCam.id);

    } catch (error) {
        console.error('Error al obtener cámaras:', error);
        cameraStatus.textContent = `Error al acceder a la cámara: ${error.message}. Asegúrate de usar HTTPS o localhost.`;
    }
}

// --- Scanner Control ---

async function startScanner(cameraId) {
    if (!cameraId) {
        console.warn("No camera ID provided to startScanner.");
        return;
    }
    statusElement.textContent = "Iniciando cámara...";
    cameraStatus.textContent = '';

    try {
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop();
            console.log("Previous scanner stopped.");
        }

        if (!html5QrCode) {
            // Mantén verbose en false si no quieres logs detallados de la librería en consola
            html5QrCode = new Html5Qrcode("scanner-preview", /* verbose= */ false);
        }

        const config = {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            aspectRatio: 1.7777778,
            // *** CORRECCIÓN IMPORTANTE ***
            supportedScanTypes: [Html5Qrcode.Html5QrcodeScanType.SCAN_TYPE_CAMERA]
        };

        await html5QrCode.start(
            cameraId,
            config,
            onScanSuccess,
            onScanFailure
        );
        console.log(`Scanner started successfully with camera ID: ${cameraId}`);
        cameraStatus.textContent = '';
        currentCameraId = cameraId;
        statusElement.textContent = "Escaneando...";

    } catch (error) {
        console.error(`Error al iniciar escáner con cámara ${cameraId}:`, error);
        // MODIFICADO: Mensaje de error más específico
        cameraStatus.textContent = `Error al iniciar cámara: ${error.message}. Intenta seleccionar otra cámara.`;
         if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop().catch(e => console.error("Error stopping scanner after failed start:", e));
         }
         statusElement.textContent = "Error al iniciar.";
    }
}

async function stopScanner() {
    // NUEVO: Limpiar timeout de auto-limpieza si existe
    if (autoClearTimeout) {
        clearTimeout(autoClearTimeout);
        autoClearTimeout = null;
    }
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            await html5QrCode.stop();
            console.log("Scanner stopped.");
            currentCameraId = null;
            statusElement.textContent = "Escáner detenido.";
            scannerPreview.classList.remove('scan-success-border'); // NUEVO: Quitar borde verde
        } catch (error) {
            console.error("Error stopping the scanner: ", error);
            statusElement.textContent = "Error al detener.";
        }
    } else {
         console.log("Scanner not running or already stopped.");
         statusElement.textContent = "Escáner no activo.";
    }
}


// --- Callbacks ---

function onScanSuccess(decodedText, decodedResult) {
    resultadoElement.value = decodedText;
    statusElement.textContent = "Código detectado ✅";

    // NUEVO: Feedback Visual
    scannerPreview.classList.add('scan-success-border');
    setTimeout(() => {
        scannerPreview.classList.remove('scan-success-border');
    }, 500); // Quita el borde después de 500ms

    // NUEVO: Feedback Auditivo
    if (soundToggle.checked) {
        playBeep();
    }

    // Detección de proveedor
    let proveedor = "No identificado";
    if (decodedText.includes("BIO")) proveedor = "BIOPROTECE";
    else if (decodedText.includes("SAI")) proveedor = "SAI";
    proveedorAutoElement.textContent = proveedor;

    // Captura visual opcional
    if (window.html2canvas) {
        html2canvas(scannerPreview).then(canvas => {
            capturaContainer.innerHTML = "";
            capturaContainer.appendChild(canvas);
        }).catch(err => console.error("html2canvas error:", err));
    }

    // NUEVO: Limpieza automática opcional
    if (autoClearToggle.checked) {
        if (autoClearTimeout) clearTimeout(autoClearTimeout); // Limpiar timeout anterior si existe
        autoClearTimeout = setTimeout(() => {
            clearScanResults();
            autoClearTimeout = null; // Resetear referencia del timeout
        }, 3000); // Limpiar después de 3 segundos
    }
}

function onScanFailure(error) {
    if (!error.includes("찾을 수 없습니다.") && !error.includes("No QR code found")) {
       if (statusElement.textContent !== "Código detectado ✅") {
         statusElement.textContent = "Escaneando...";
       }
    } else {
         if (statusElement.textContent !== "Código detectado ✅") {
             statusElement.textContent = "Escaneando...";
         }
    }
    // NUEVO: Asegurarse que el borde verde no se quede si falla
    scannerPreview.classList.remove('scan-success-border');
}

// --- UI Control ---

function switchTab(targetId) {
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(sec => sec.classList.remove('active'));

    const targetTab = document.querySelector(`.tab[data-tab-target='${targetId}']`);
    const targetSection = document.getElementById(targetId);

    if (targetTab) targetTab.classList.add('active');
    if (targetSection) targetSection.classList.add('active');

    if (targetId === 'scan') {
        if (currentCameraId) {
            startScanner(currentCameraId);
        } else {
            initScanner();
        }
        statusElement.textContent = "Esperando código...";
    } else {
        stopScanner();
    }
}

function toggleDarkMode() {
    document.body.classList.toggle('dark');
    document.body.classList.toggle('light');
}

// NUEVO: Limpiar los resultados del escaneo
function clearScanResults() {
    resultadoElement.value = '';
    proveedorAutoElement.textContent = '---';
    capturaContainer.innerHTML = '';
    statusElement.textContent = html5QrCode && html5QrCode.isScanning ? "Escaneando..." : "Esperando código...";
    // Limpiar timeout si el usuario limpia manualmente
    if (autoClearTimeout) {
        clearTimeout(autoClearTimeout);
        autoClearTimeout = null;
    }
    console.log("Resultados limpiados.");
}

// NUEVO: Copiar resultado al portapapeles
function copyScanResult() {
    const textToCopy = resultadoElement.value;
    if (!textToCopy) {
        console.log("Nada que copiar.");
        // Opcional: mostrar un mensaje breve al usuario
        copyButton.innerText = "Vacío!";
        setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500);
        return;
    }

    navigator.clipboard.writeText(textToCopy).then(() => {
        console.log("Texto copiado al portapapeles");
        copyButton.innerText = "Copiado!";
        setTimeout(() => { copyButton.innerText = "Copiar"; }, 1500); // Resetear texto del botón
    }).catch(err => {
        console.error('Error al copiar: ', err);
        alert("Error al copiar al portapapeles."); // Mostrar error al usuario
    });
}

// NUEVO: Función para reproducir sonido
function playBeep() {
    try {
        // Inicializar AudioContext si no existe (importante para algunos navegadores)
        if (!audioContext) {
             audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (!audioContext) { // Si aún no se pudo crear
            console.warn("Web Audio API no soportada en este navegador.");
            return;
        }

        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        // Sube el volumen rápidamente
        gainNode.gain.linearRampToValueAtTime(0.6, audioContext.currentTime + 0.01); // Volumen máximo 0.6

        oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // Frecuencia (Hz) - La4 = 440, A5 = 880
        oscillator.type = 'square'; // Tipo de onda: 'sine', 'square', 'sawtooth', 'triangle'

        oscillator.start(audioContext.currentTime);
        // Baja el volumen rápidamente para crear el "beep"
        gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.1); // Duración del sonido = 0.1s
        oscillator.stop(audioContext.currentTime + 0.1);

    } catch (e) {
        console.error("Error al reproducir sonido:", e);
        // Desactivar checkbox si falla consistentemente? O solo loguear.
        // soundToggle.checked = false;
    }
}


// --- Event Listeners ---

document.addEventListener('DOMContentLoaded', () => {
    if (location.protocol !== 'https:') {
      if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        cameraStatus.textContent = 'Advertencia: La cámara requiere HTTPS para funcionar en la mayoría de los navegadores.';
        console.warn('Camera access requires HTTPS.');
      }
    }

    initScanner();

    // Setup Tab switching
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-tab-target');
            if (targetId) {
                switchTab(targetId);
            }
        });
    });

    if (darkModeToggle) {
        darkModeToggle.addEventListener('click', toggleDarkMode);
    }

    // NUEVO: Listeners para botones de acción
    if (copyButton) {
        copyButton.addEventListener('click', copyScanResult);
    }
    if (clearButton) {
        clearButton.addEventListener('click', clearScanResults);
    }

     // NUEVO: Listener para iniciar AudioContext con interacción del usuario (opcional pero recomendado)
     // Si el sonido no funciona, descomentar estas líneas podría ayudar
     /*
     function initAudio() {
         if (!audioContext) {
             try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log("AudioContext inicializado por interacción.");
             } catch(e) {
                console.error("No se pudo inicializar AudioContext", e);
             }
         }
         // Remover el listener una vez inicializado
         document.body.removeEventListener('click', initAudio);
         document.body.removeEventListener('touchstart', initAudio);
     }
     document.body.addEventListener('click', initAudio, { once: true });
     document.body.addEventListener('touchstart', initAudio, { once: true });
     */

});

// Make functions globally accessible if called directly from HTML `onchange`
window.changeCamera = changeCamera;
