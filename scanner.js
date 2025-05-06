let scanner;
let currentCameraId = null;
let html5QrCode = null; // Keep instance reference

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

        const devices = await Html5Qrcode.getCameras();
        cameraSelector.innerHTML = '<option value="">Seleccionar cámara...</option>'; // Clear previous options

        if (!devices || devices.length === 0) {
            cameraStatus.textContent = 'No se encontraron cámaras disponibles.';
            console.error('No cameras found.');
            return;
        }

        // Populate camera selector
        devices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.id;
            // Ensure unique label even if browser doesn't provide one
            option.text = device.label || `Cámara ${index + 1} (ID: ${device.id.substring(0, 6)}...)`;
            cameraSelector.appendChild(option);
        });

        // Attempt to select the back camera by default
        const backCam = devices.find(d =>
            d.label && (
                d.label.toLowerCase().includes('back') ||
                d.label.toLowerCase().includes('rear') ||
                d.label.toLowerCase().includes('trás') // Spanish 'trasera'
            )
        ) || devices[0]; // Fallback to the first camera

        currentCameraId = backCam.id;
        cameraSelector.value = backCam.id;
        await startScanner(backCam.id);

    } catch (error) {
        console.error('Error al obtener cámaras:', error);
        cameraStatus.textContent = `Error al acceder a la cámara: ${error.message}. Asegúrate de usar HTTPS o localhost.`;
    }
}

// --- Scanner Control ---

// Start the scanner with a specific camera
async function startScanner(cameraId) {
    if (!cameraId) {
        console.warn("No camera ID provided to startScanner.");
        return;
    }
    statusElement.textContent = "Iniciando cámara...";
    cameraStatus.textContent = ''; // Clear previous errors

    try {
        // Stop the existing scanner if it's running
        if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop();
             console.log("Previous scanner stopped.");
        }

        // Ensure the html5QrCode instance exists
        if (!html5QrCode) {
            html5QrCode = new Html5Qrcode("scanner-preview", /* verbose= */ false);
        }

        // Configuration optimized for mobiles
        const config = {
            fps: 10,
            qrbox: { width: 250, height: 150 }, // Rectangular might be better for barcodes
            // facingMode: 'environment', // Less relevant when specifying exact camera ID
            aspectRatio: 1.7777778, // 16:9 aspect ratio often works well
             // *** THIS IS THE CRITICAL FIX ***
            supportedScanTypes: [Html5Qrcode.Html5QrcodeScanType.SCAN_TYPE_CAMERA]
        };

        await html5QrCode.start(
            cameraId,
            config,
            onScanSuccess,
            onScanFailure
        );
         console.log(`Scanner started successfully with camera ID: ${cameraId}`);
        cameraStatus.textContent = ''; // Clear status on success
        currentCameraId = cameraId;
        statusElement.textContent = "Escaneando...";

    } catch (error) {
        console.error(`Error al iniciar escáner con cámara ${cameraId}:`, error);
        cameraStatus.textContent = `Error al iniciar cámara: ${error.message}. Intenta seleccionar otra cámara.`;
         // Optionally stop if failed
         if (html5QrCode && html5QrCode.isScanning) {
            await html5QrCode.stop().catch(e => console.error("Error stopping scanner after failed start:", e));
         }
         statusElement.textContent = "Error al iniciar.";
    }
}

// Stop the scanner
async function stopScanner() {
    if (html5QrCode && html5QrCode.isScanning) {
        try {
            await html5QrCode.stop();
            console.log("Scanner stopped.");
            currentCameraId = null; // Reset current camera when stopped manually
            statusElement.textContent = "Escáner detenido.";
        } catch (error) {
            console.error("Error stopping the scanner: ", error);
            statusElement.textContent = "Error al detener.";
        }
    } else {
         console.log("Scanner not running or already stopped.");
         statusElement.textContent = "Escáner no activo.";
    }
}


// Callback for successful scan
function onScanSuccess(decodedText, decodedResult) {
    resultadoElement.value = decodedText;
    statusElement.textContent = "Código detectado ✅";

    // Basic provider detection
    let proveedor = "No identificado";
    if (decodedText.includes("BIO")) {
        proveedor = "BIOPROTECE";
    } else if (decodedText.includes("SAI")) {
        proveedor = "SAI";
    }
    proveedorAutoElement.textContent = proveedor;

    // Optional: Visual capture using html2canvas (ensure it's needed)
    if (window.html2canvas) {
        html2canvas(scannerPreview).then(canvas => {
            capturaContainer.innerHTML = ""; // Clear previous capture
            // Optional: Resize canvas for display if needed
            // canvas.style.width = '100px';
            // canvas.style.height = 'auto';
            capturaContainer.appendChild(canvas);
        }).catch(err => {
            console.error("html2canvas error:", err);
        });
    }

    // Consider stopping scan after success if desired:
    // stopScanner();
}

// Callback for scan failures (or continuous scanning updates)
function onScanFailure(error) {
    // Don't display error messages for "QR code not found" during continuous scan
    if (!error.includes("찾을 수 없습니다.") && !error.includes("No QR code found")) {
       // cameraStatus.textContent = `Error de escaneo: ${error}`;
       // console.warn(`Scan Failure: ${error}`);
       // Keep statusElement showing "Escaneando..." or similar
       if (statusElement.textContent !== "Código detectado ✅") {
         statusElement.textContent = "Escaneando...";
       }
    } else {
         if (statusElement.textContent !== "Código detectado ✅") {
             statusElement.textContent = "Escaneando...";
         }
    }
}

// Change camera function called by selector
async function changeCamera(cameraId) {
    if (!cameraId) {
        console.log("Camera selection cleared or invalid.");
        await stopScanner(); // Stop if no camera is selected
        return;
    }
    if (cameraId === currentCameraId) {
        console.log(`Camera ${cameraId} already selected.`);
        return;
    }
    console.log(`Changing camera to ID: ${cameraId}`);
    await startScanner(cameraId);
}

// --- UI Control ---

// Switch between Scan and Records tabs
function switchTab(targetId) {
    // Deactivate all tabs and sections
    tabs.forEach(tab => tab.classList.remove('active'));
    sections.forEach(sec => sec.classList.remove('active'));

    // Activate the selected tab and section
    const targetTab = document.querySelector(`.tab[data-tab-target='${targetId}']`);
    const targetSection = document.getElementById(targetId);

    if (targetTab) targetTab.classList.add('active');
    if (targetSection) targetSection.classList.add('active');

    // Handle scanner state when switching tabs
    if (targetId === 'scan') {
        // If switching back to scan tab, try restarting with the last used camera
        if (currentCameraId) {
            startScanner(currentCameraId);
        } else {
            // If no camera was active, re-initialize to find cameras
            initScanner();
        }
        statusElement.textContent = "Esperando código..."; // Reset status
    } else {
        // If switching away from scan tab, stop the scanner
        stopScanner();
    }
}

// Dark mode toggle functionality
function toggleDarkMode() {
    document.body.classList.toggle('dark');
    document.body.classList.toggle('light');
    // Optionally save preference to localStorage
    // localStorage.setItem('darkMode', document.body.classList.contains('dark'));
}

// --- Event Listeners ---

// Initialize scanner when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
     // Check for HTTPS
    if (location.protocol !== 'https:') {
      // Allow localhost without HTTPS
      if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        cameraStatus.textContent = 'Advertencia: La cámara requiere HTTPS para funcionar en la mayoría de los navegadores.';
        console.warn('Camera access requires HTTPS.');
        // Don't initialize scanner if not secure and not localhost
        // return;
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

     // Dark Mode Toggle Listener
    if (darkModeToggle) {
        darkModeToggle.addEventListener('click', toggleDarkMode);
    }

     // Optional: Check localStorage for saved dark mode preference
    // if (localStorage.getItem('darkMode') === 'true') {
    //    document.body.classList.add('dark');
    //    document.body.classList.remove('light');
    // } else {
    //    document.body.classList.add('light');
    //    document.body.classList.remove('dark');
    // }
});

// Make functions globally accessible if called directly from HTML `onchange`
window.changeCamera = changeCamera;
// window.switchTab = switchTab; // No longer needed if using data attributes + event listener
