document.addEventListener('DOMContentLoaded', () => {

    // --- ELEMENTOS DEL DOM ---
    const generarBtn = document.getElementById('generar-dino-btn');
    const loadingIndicator = document.getElementById('loading-indicator');
    const museoContainer = document.querySelector('.museo-container');
    const fondo = document.querySelector('.fondo-paralax');
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const mainMenu = document.getElementById('main-menu');
    const showModelInfoBtn = document.getElementById('show-model-info-btn');
    const modalOverlay = document.getElementById('modal-overlay');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const modalContentArea = document.getElementById('modal-content-area');
    const marcosDisponibles = ['./static/Marcos/1.png', './static/Marcos/2.png', './static/Marcos/3.png'];
    const chatOverlay = document.getElementById('chat-overlay');
    const closeChatBtn = document.getElementById('close-chat-btn');
    const chatTitle = document.getElementById('chat-title');
    const dinoChatName = document.getElementById('dino-chat-name');
    const chatHistory = document.getElementById('chat-history');
    const userInput = document.getElementById('chat-user-input');
    const sendBtn = document.getElementById('chat-send-btn');

    // Variable para almacenar el contexto del dinosaurio actual
    let currentDinoContext = '';
    let currentDinoAvatarUrl = '';
    const userAvatarUrl = './static/Marcos/usuario.jpg';
    // --- EFECTO PARALLAX ---
    const moveStrength = 50;
    window.addEventListener('mousemove', (e) => {
        const { clientX, clientY } = e;
        const { innerWidth, innerHeight } = window;
        const xPercent = (clientX / innerWidth - 0.5) * 2;
        const yPercent = (clientY / innerHeight - 0.5) * 2;
        const moveX = xPercent * (moveStrength / 2);
        const moveY = yPercent * (moveStrength / 2);
        fondo.style.transform = `translate3d(${moveX}px, ${moveY}px, 0)`;
    });
    
// --- LÓGICA DEL MENÚ Y MODAL ---
    menuToggleBtn.addEventListener('click', () => mainMenu.classList.toggle('active'));
    const showModal = () => modalOverlay.classList.remove('hidden');
    const hideModal = () => modalOverlay.classList.add('hidden');
    closeModalBtn.addEventListener('click', hideModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) hideModal(); });

    showModelInfoBtn.addEventListener('click', async () => {
        showModal();
        modalContentArea.innerHTML = '<div class="spinner"></div><p>Cargando informe del modelo...</p>';
        await displayModelReport();
    });

    // --- FUNCIONES DE FORMATO PARA EL INFORME ---

    function createSamplesTable(samplesData) {
        let tableHTML = `<table class="report-table"><thead><tr><th>Temperatura</th><th>Top-K</th><th>Top-P</th><th>Nombres Generados</th></tr></thead><tbody>`;
        for (const key in samplesData) {
            const params = key.match(/t([\d.]+)_k(\d+)_p([\d.]+)/);
            if (!params) continue;
            const [_, temp, k, p] = params;
            const names = samplesData[key].map(name => `<li>${name}</li>`).join('');
            tableHTML += `<tr><td>${temp}</td><td>${k}</td><td>${p}</td><td><ul>${names}</ul></td></tr>`;
        }
        return tableHTML + `</tbody></table>`;
    }

    function createMetricsSummary(metricsData) {
        const getLast = arr => arr && arr.length > 0 ? arr[arr.length - 1].toFixed(4) : 'N/A';
        const finalMetrics = {
            'Pérdida (Validación)': getLast(metricsData.val_loss),
            'Precisión (Validación)': getLast(metricsData.val_accuracy),
            'Pérdida (Entrenamiento)': getLast(metricsData.loss),
            'Precisión (Entrenamiento)': getLast(metricsData.accuracy),
        };
        let cardsHTML = '<div class="metrics-summary">';
        for (const key in finalMetrics) {
            cardsHTML += `<div class="metric-card"><div class="metric-card-title">${key}</div><div class="metric-card-value">${finalMetrics[key]}</div></div>`;
        }
        return cardsHTML + '</div>';
    }

    function createArchitectureInfo(archText) {
        // Expresiones regulares para capturar las secciones
        const summaryRegex = /Layer \(type\)\s*Output Shape\s*Param #\n([\s\S]*?)Total params:/;
        const totalParamsRegex = /(Total params:[\s\S]*?(Optimizer params: .*|Non-trainable params:.*))/;
        const vocabSizeRegex = /embed \(Embedding\).*?(\d{1,3}(,\d{3})*)/;

        let html = '';

        // Tarjeta de Vocabulario
        const vocabMatch = archText.match(vocabSizeRegex);
        if (vocabMatch) {
            html += `<div class="metrics-summary">
                <div class="metric-card">
                    <div class="metric-card-title">Longitud máxima de la secuencia representada por T</div>
                    <div class="metric-card-value">${vocabMatch[1]}</div>
                </div>
            </div>`;
        }

        // Tabla de Resumen del Modelo
        const summaryMatch = archText.match(summaryRegex);
        if (summaryMatch) {
            html += `<h3>Resumen de Capas</h3><table class="report-table">
                <thead><tr><th>Capa (Tipo)</th><th>Tamaño de Salida</th><th>Parámetros #</th></tr></thead><tbody>`;
            const lines = summaryMatch[1].trim().split('\n');
            lines.forEach(line => {
                const parts = line.match(/(\w+\s*\(.*?)\)\s+(\(.*\))\s+([\d,]+)/);
                if (parts && parts.length === 4) {
                    html += `<tr><td>${parts[1]}</td><td>${parts[2]}</td><td>${parts[3]}</td></tr>`;
                }
            });
            html += `</tbody></table>`;
        }

        // Tarjetas de Parámetros Totales
        const totalParamsMatch = archText.match(totalParamsRegex);
        if (totalParamsMatch) {
            const paramsLines = totalParamsMatch[1].trim().split('\n');
            html += '<h3>Parámetros del Modelo</h3><div class="metrics-summary">';
            paramsLines.forEach(line => {
                const [title, value] = line.split(':').map(s => s.trim());
                html += `<div class="metric-card">
                    <div class="metric-card-title">${title}</div>
                    <div class="metric-card-value">${value}</div>
                </div>`;
            });
            html += '</div>';
        }
        return html;
    }

    /** Función principal que carga y muestra todo el informe del modelo. */
    async function displayModelReport() {
        try {
            const reportPath = './static/report_20251016_170934/';
            const [archResponse, metricsResponse, samplesResponse] = await Promise.all([
                fetch(`${reportPath}architecture.txt`),
                fetch(`${reportPath}history_saved.json`),
                fetch(`${reportPath}generated_samples.json`)
            ]);

            if (!archResponse.ok || !metricsResponse.ok || !samplesResponse.ok) {
                throw new Error("No se pudieron cargar todos los archivos del informe.");
            }

            const archText = await archResponse.text();
            const metricsData = await metricsResponse.json();
            const samplesData = await samplesResponse.json();

            // --- Construcción del HTML en el orden solicitado ---
            modalContentArea.innerHTML = `
                <h3>Arquitectura y Preprocesamiento</h3>
                <p class="analysis-note">
                    El modelo es una <strong>Red Neuronal Recurrente (RNN) de tipo decoder-only</strong>, diseñada para predecir el siguiente carácter de forma autorregresiva. La elección de celdas <strong>GRU (Gated Recurrent Unit)</strong> es estratégica ya que gracias a sus mecanismos de "compuertas" (reset y update) le permiten gestionar eficientemente la memoria a largo plazo, decidiendo qué información de caracteres pasados retener y cuál descartar. Esto es crucial para aprender patrones complejos en los nombres de dinosaurios y mitiga el problema del desvanecimiento del gradiente (La red olvida las dependencias a largo plazo porque la información del error no llega hasta el principio), común en RNNs simples. La arquitectura, con dos capas GRU apiladas, aumenta la capacidad del modelo para capturar jerarquías de patrones más abstractas.
                </p>
                <h4>Flujo de Preprocesamiento de Datos</h4>
                <div class="preprocess-flow">
                    <div class="flow-step">Normalizar Texto</div>
                    <div class="flow-arrow">→</div>
                    <div class="flow-step">Añadir Tokens (SOS/EOS)</div>
                    <div class="flow-arrow">→</div>
                    <div class="flow-step">Definir la longitud máxima (T)</div>
                    <div class="flow-arrow">→</div>
                    <div class="flow-step">Aplicar Padding</div>
                    <div class="flow-arrow">→</div>
                    <div class="flow-step">Crear Secuencias (X, Y)</div>
                </div>
                <div class="metrics-summary" style="grid-template-columns: 1fr; max-width: 250px; margin: 15px 0;">
                    <div class="metric-card">
                        <div class="metric-card-title">Nombres para Entrenamiento</div>
                        <div class="metric-card-value">1536</div>
                    </div>
                </div>
                ${createArchitectureInfo(archText)}

                <h3>Métricas de Evaluación Finales</h3>
                <p class="analysis-note">El modelo alcanzó una <strong>precisión de validación final de ~77.2%</strong> y una pérdida de ~0.825. Esto indica la capacidad para predecir el siguiente carácter en secuencias no vistas, demostrando que ha generalizado bien a partir de los datos de entrenamiento. El rendimiento es bueno para una tarea de generación a nivel de carácter, donde la ambigüedad es inherente.</p>
                ${createMetricsSummary(metricsData)}

                <h3>Curvas de Aprendizaje</h3>
                <p class="analysis-note">Las gráficas ilustran un proceso de aprendizaje estable. La pérdida (loss) de entrenamiento disminuye consistentemente, mientras que la de validación desciende y luego se estabiliza. La detención temprana (EarlyStopping) previno el sobreajuste, deteniendo el entrenamiento cuando la pérdida de validación dejó de mejorar significativamente.</p>
                <div class="curves-container">
                    <img src="${reportPath}loss_curve.png" alt="Curva de Pérdida">
                    <img src="${reportPath}acc_curve.png" alt="Curva de Precisión">
                </div>

                <h3>Análisis Comparativo y Muestras</h3>
                <p class="analysis-note">Los resultados del muestreo validan la teoría: la configuración con <strong>Temperatura de 0.7 y Top-K de 5</strong> produjo los nombres más coherentes con base al dataset como lo es "Ligantosaurus". Aumentar la temperatura introduce más aleatoriedad, resultando en creatividad a costa de coherencia (ej. "Byarripovurebogasudeus"). El método Top-P (nucleus sampling) ofrece un equilibrio, restringiendo la selección a un subconjunto de tokens cuya probabilidad acumulada supera un umbral, lo que resulta en nombres diversos pero generalmente coherentes.</p>
                ${createSamplesTable(samplesData)}
            `;
        } catch (error) {
            console.error("Error al cargar los datos del modelo:", error);
            modalContentArea.innerHTML = `<p style="color: red;">Error: No se pudo cargar el informe del modelo. Verifique que la carpeta 'report' esté en 'static' y que los archivos existan.</p>`;
        }
    }

    // --- FUNCIONES AUXILIARES ---

    function formatTextToHtml(texto) {
        if (!texto) return '<p>No hay información disponible.</p>';
        const parrafos = texto
            .replace(/--- FICHA DE ESPÉCIMEN ---/g, '').replace(/## FICHA DE ESPÉCIMEN/g, '').trim()
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .split(/\n{2,}/);
        return parrafos.map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`).join('');
    }

    function updateSlicerHeight(slicerContainer) {
        const wrapper = slicerContainer.querySelector('.placa-wrapper');
        const placas = slicerContainer.querySelectorAll('.dino-placa');
        const isSlid = wrapper.classList.contains('slide-active');
        const visiblePlaqueIndex = isSlid ? 1 : 0;
        const newHeight = placas[visiblePlaqueIndex].scrollHeight;
        slicerContainer.style.height = `${newHeight}px`;
    }
    
    
    function openChatWithDino(name, description, imageUrl) { // Recibe la URL de la imagen
        chatTitle.textContent = `Hablando con ${name}`;
        currentDinoContext = description;
        currentDinoAvatarUrl = imageUrl; // La guardamos para usarla después
    
        chatHistory.innerHTML = `
            <div class="chat-message bot">
                <img src="${currentDinoAvatarUrl}" alt="Avatar" class="chat-avatar">
                <p>¡Hola! Soy ${name}. ¿Qué te gustaría saber sobre mí?</p>
            </div>
        `;
        userInput.value = '';
        chatOverlay.classList.remove('hidden');
    }
    
    /** Cierra el modal del chat. */
    function closeChat() {
        chatOverlay.classList.add('hidden');
    }
    
    /**
     * Añade un mensaje con avatar a la ventana del chat.
     */
    function addMessageToHistory(message, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${sender}`;
    
        const avatarImg = document.createElement('img');
        avatarImg.className = 'chat-avatar';
        avatarImg.src = (sender === 'bot') ? currentDinoAvatarUrl : userAvatarUrl;
    
        const messageP = document.createElement('p');
        messageP.innerHTML = message;
    
        messageDiv.appendChild(avatarImg);
        messageDiv.appendChild(messageP);
        chatHistory.appendChild(messageDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }
    /**
     * Función principal para manejar el envío de mensajes.
     */
    async function handleSendMessage() {
    const question = userInput.value.trim();
    if (!question) return;

    addMessageToHistory(question, 'user');
    userInput.value = '';
    sendBtn.disabled = true;

    // Mostrar el indicador de "escribiendo..."
    const typingIndicatorId = 'typing-' + Date.now(); // ID único
    addMessageToHistory(`<div class="typing-indicator"><span></span><span></span><span></span></div>`, 'bot');
    document.querySelector('.chat-message:last-child').id = typingIndicatorId;

    try {
        const response = await fetch('/api/chat-with-dino', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dino_context: currentDinoContext,
                user_question: question
            }),
        });

        // Eliminar indicador de carga
        const indicator = document.getElementById(typingIndicatorId);
        if (indicator) indicator.remove();

        if (!response.ok) {
            throw new Error(`Error del servidor: ${response.status}`);
        }

        const data = await response.json(); // Leemos la respuesta completa
        addMessageToHistory(data.answer, 'bot'); // La mostramos de golpe

    } catch (error) {
        console.error("Error al chatear:", error);
        const indicator = document.getElementById(typingIndicatorId);
        if (indicator) indicator.remove();
        addMessageToHistory(`<b>¡GRRR!</b> Mis pensamientos se nublan...`, 'bot');
    } finally {
        sendBtn.disabled = false;
        userInput.focus();
    }
}
    
    closeChatBtn.addEventListener('click', closeChat);
    chatOverlay.addEventListener('click', (e) => {
        if (e.target === chatOverlay) {
            closeChat();
        }
    });
    sendBtn.addEventListener('click', handleSendMessage);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
    

    /**
     * Función centralizada para crear un exhibidor de dinosaurio completo en el DOM.
     * @param {string} nombre - El nombre del dinosaurio.
     * @param {string} descripcion - La descripción completa.
     * @param {string} urlImagen - La URL de la imagen del dinosaurio.
     * @returns {HTMLElement} - El elemento div.dino-exhibit completo.
     */
    function crearDinoExhibit(nombre, descripcion, urlImagen) {
        const exhibit = document.createElement('div');
        exhibit.className = 'dino-exhibit';
    
        // Guardamos los datos del dino directamente en el elemento para un fácil acceso
        exhibit.dataset.dinoName = nombre;
        exhibit.dataset.dinoDescription = descripcion;
    
        // --- Tu código para crear el cuadro de imagen (esto no se toca) ---
        const cuadro = document.createElement('div');
        cuadro.className = 'dino-cuadro';
        const img = document.createElement('img');
        img.src = urlImagen || './static/placeholder.png';
        img.alt = nombre;
        img.className = 'dino-img';
        const marco = document.createElement('img');
        marco.className = 'dino-marco';
        const indiceAleatorio = Math.floor(Math.random() * marcosDisponibles.length);
        marco.src = marcosDisponibles[indiceAleatorio];
        cuadro.appendChild(img);
        cuadro.appendChild(marco);
    
        // --- Tu código para crear la placa de descripción (esto no se toca) ---
        let textoPrincipal = descripcion;
        let textoSecundario = "<strong>Descripción Física:</strong> No disponible.";
        const separadorRegex = /(\*){0,2}\s*Descripción Física:\s*(\*){0,2}/i;
        const match = descripcion.match(separadorRegex);
        if (match) {
            const indexSeparador = match.index;
            textoPrincipal = descripcion.substring(0, indexSeparador);
            textoSecundario = descripcion.substring(indexSeparador);
        }
        const slicerContainer = document.createElement('div');
        slicerContainer.className = 'placa-slicer-container';
        const wrapper = document.createElement('div');
        wrapper.className = 'placa-wrapper';
        const placaPrincipal = document.createElement('div');
        placaPrincipal.className = 'dino-placa';
        placaPrincipal.innerHTML = formatTextToHtml(textoPrincipal);
        const placaSecundaria = document.createElement('div');
        placaSecundaria.className = 'dino-placa';
        placaSecundaria.innerHTML = formatTextToHtml(textoSecundario);
        wrapper.appendChild(placaPrincipal);
        wrapper.appendChild(placaSecundaria);
        const arrowPrev = document.createElement('button');
        arrowPrev.className = 'slicer-arrow prev'; arrowPrev.innerHTML = '‹';
        const arrowNext = document.createElement('button');
        arrowNext.className = 'slicer-arrow next'; arrowNext.innerHTML = '›';
        arrowNext.addEventListener('click', (e) => { e.stopPropagation(); wrapper.classList.add('slide-active'); updateSlicerHeight(slicerContainer); });
        arrowPrev.addEventListener('click', (e) => { e.stopPropagation(); wrapper.classList.remove('slide-active'); updateSlicerHeight(slicerContainer); });
        slicerContainer.appendChild(wrapper);
        slicerContainer.appendChild(arrowPrev);
        slicerContainer.appendChild(arrowNext);
    
        exhibit.appendChild(cuadro);
        exhibit.appendChild(slicerContainer);
    
        // --- LA CORRECCIÓN ESTÁ AQUÍ ---
        // Reemplazamos el listener viejo por este, que usa las variables correctas.
        exhibit.addEventListener('click', () => {
            // Usamos las variables que ya tenemos: nombre, descripcion, y urlImagen
            openChatWithDino(nombre, descripcion, urlImagen); // ¡Este SÍ pasa la urlImagen!
        });
    
        return exhibit;
    }

    /**
     * Carga todos los dinosaurios desde el JSON y los muestra en la galería.
     */
    async function cargarGaleriaCompleta() {
        try {
            // Se añade un timestamp para evitar que el navegador use una versión en caché del archivo
            const response = await fetch(`./static/dino_descriptions.json?v=${new Date().getTime()}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const datosDinos = await response.json();

            // Limpiamos la galería antes de volver a llenarla
            museoContainer.innerHTML = '';
            
            // Obtenemos los nombres de las imágenes en la carpeta generated
            // Esto es un truco, idealmente el JSON debería contener la ruta de la imagen
            const nombresDeDinos = Object.keys(datosDinos);

            for (const nombreDino of nombresDeDinos) {
                const descripcion = datosDinos[nombreDino];
                // Asumimos que la imagen se llama igual que el dinosaurio
                const safe_filename = nombreDino.replace(/[^a-zA-Z0-9 _]/g, '').trimEnd();
                const urlImagen = `./static/Carpetanosaurio rex/${safe_filename}.png`; 
                
                const exhibitElement = crearDinoExhibit(nombreDino, descripcion, urlImagen);
                museoContainer.appendChild(exhibitElement);
                // Usamos un pequeño delay para asegurar que el DOM se actualice antes de medir
                setTimeout(() => updateSlicerHeight(exhibitElement.querySelector('.placa-slicer-container')), 100);
            }

        } catch (error) {
            console.error("No se pudieron cargar los datos de la galería:", error);
            museoContainer.innerHTML = '<p class="error-msg">No se pudo cargar la galería. Inténtalo de nuevo más tarde.</p>';
        }
    }


    // --- LÓGICA DEL BOTÓN DE GENERACIÓN ---
    generarBtn.addEventListener('click', async () => {
        generarBtn.disabled = true;
        loadingIndicator.classList.remove('hidden');

        try {
            const response = await fetch('/api/generar-nombre');
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || `Error del servidor: ${response.status}`);
            }
            
            // No necesitamos hacer nada con la respuesta, porque el backend ya actualizó el JSON.
            // Simplemente volvemos a cargar toda la galería desde el archivo actualizado.
            console.log("Nuevo espécimen generado. Recargando galería...");
            await cargarGaleriaCompleta();

        } catch (error) {
            console.error("Error al generar el dinosaurio:", error);
            alert(`No se pudo generar el nuevo espécimen. Error: ${error.message}`);
        } finally {
            generarBtn.disabled = false;
            loadingIndicator.classList.add('hidden');
        }
    });

    // --- CARGA INICIAL ---
    cargarGaleriaCompleta();

});