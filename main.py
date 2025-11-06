import os
import io
import string
import numpy as np
import tensorflow as tf
import time
import requests
import uvicorn
import json
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from langchain_ollama import ChatOllama
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from pydantic import BaseModel

# --- 1. Configuración Inicial y Carga de Recursos ---

# Crea la aplicación FastAPI
app = FastAPI(title="Generador de Nombres con Keras")
# --- Montar el directorio estático para servir imágenes generadas ---
# Esto permite que el navegador acceda a las imágenes guardadas
# Por ejemplo: http://127.0.0.1:8000/static/generated/Nuevodino.png
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Variables Globales para el Modelo y Vocabulario ---
# Estos recursos se cargarán una sola vez al iniciar la API
model = None
char_to_index = None
index_to_char = None
MODEL_FILE = './static/report_20251016_170934/dino_generator.h5' # Asegúrate que el modelo esté en la misma carpeta

# Tokens especiales que probablemente usaste
PAD_TOKEN = "<PAD>"
SOS_TOKEN = "<SOS>"
EOS_TOKEN = "<EOS>"

# Modelo Pydantic para la solicitud del chatbot
class ChatRequest(BaseModel):
    dino_context: str
    user_question: str

@app.on_event("startup")
def load_resources():
    global model, char_to_index, index_to_char
    print("🚀 Iniciando servidor y cargando recursos...")

    if not os.path.exists(MODEL_FILE):
        raise FileNotFoundError(f"Error: El archivo del modelo '{MODEL_FILE}' no se encontró.")
    
    model = tf.keras.models.load_model(MODEL_FILE, compile=False)
    print("✅ Modelo cargado con éxito.")

    all_chars = sorted(list(string.ascii_lowercase))
    specials = [PAD_TOKEN, SOS_TOKEN, EOS_TOKEN]
    vocab = specials + all_chars
    char_to_index = {char: i for i, char in enumerate(vocab)}
    index_to_char = {i: char for char, i in char_to_index.items()}
    print(f"✅ Vocabulario reconstruido con {len(vocab)} caracteres.")
    
    os.makedirs("./static/generated", exist_ok=True)
    print("✨ Servidor listo.")

# Configuración de plantillas Jinja2 para servir el HTML
templates = Jinja2Templates(directory="templates")

# --- 2. Lógica de Generación del Nombre (Tus funciones) ---

def apply_temperature(probs, temperature):
    """Ajusta las probabilidades para controlar la aleatoriedad."""
    temperature = max(0.01, temperature)
    preds = np.log(probs + 1e-12) / float(temperature)
    exp_preds = np.exp(preds)
    return exp_preds / np.sum(exp_preds)

def generate_name_from_model(temperature=0.7, max_len=50):
    if model is None or char_to_index is None:
        raise RuntimeError("El modelo o el vocabulario no están cargados.")

    try:
        timesteps = model.input_shape[1] if model.input_shape[1] is not None else 40
    except Exception:
        timesteps = 40

    seq = [char_to_index.get(PAD_TOKEN, 0)] * timesteps
    if SOS_TOKEN in char_to_index:
        seq[0] = char_to_index[SOS_TOKEN]

    generated_chars = []
    for pos in range(1, timesteps):
        if len(generated_chars) >= max_len: break
        
        preds_all = model.predict(np.array([seq]), verbose=0)
        probs_raw = preds_all[0, pos - 1]
        probs_temp = apply_temperature(probs_raw, temperature)
        next_char_idx = np.random.choice(len(probs_temp), p=probs_temp)
        next_char = index_to_char.get(next_char_idx, "")

        if next_char in (EOS_TOKEN, PAD_TOKEN): break
            
        generated_chars.append(next_char)
        if pos < timesteps: seq[pos] = next_char_idx

    return "".join(generated_chars).capitalize()

# ======================================================================
# ==========[ FUNCIÓN PARA EXTRAER DESCRIPCIÓN FÍSICA ]==========
# Esta es la lógica que me pediste para el Colab, pero es más eficiente
# hacerla aquí directamente antes de enviar la petición.
def extract_physical_description(full_text: str) -> str:
    """
    Extrae solo la sección de 'Descripción Física' del texto completo.
    """
    try:
        # Divide el texto en la palabra clave
        parts = full_text.split("**Descripción Física:**")
        if len(parts) > 1:
            # Toma la segunda parte y elimina espacios en blanco
            return parts[1].strip()
        else:
            # Si no se encuentra, devuelve una descripción genérica
            return "No se encontró una descripción física detallada."
    except Exception:
        return "Error al procesar la descripción."
# ======================================================================

# --- 3. Endpoints de la API ---

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "title": "Generador de Nombres"})
    
def update_dino_json(dino_name: str, full_description: str):
    """
    Lee el archivo JSON, añade el nuevo dinosaurio y lo guarda de nuevo.
    """
    json_path = "static/dino_descriptions.json"
    try:
        # Abrir el archivo en modo lectura y escritura ('r+')
        with open(json_path, "r+", encoding="utf-8") as f:
            # Cargar los datos existentes
            data = json.load(f)
            # Añadir la nueva entrada
            data[dino_name] = full_description
            # Volver al inicio del archivo para sobreescribir
            f.seek(0)
            # Escribir el diccionario actualizado de vuelta al archivo
            json.dump(data, f, ensure_ascii=False, indent=4)
            # Truncar el archivo por si el nuevo contenido es más corto que el anterior
            f.truncate()
        print(f"✅ JSON actualizado con {dino_name}.")
        return True
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"❌ Error al actualizar el JSON: {e}")
        return False

@app.get("/api/generar-nombre")
async def api_generar_nombre():
    """
    Endpoint que genera nombre, descripción, llama al modelo de imagen,
    guarda la imagen y devuelve todos los datos.
    """
    # 1. Generar Nombre
    nombre_generado = generate_name_from_model(temperature=0.7)
    if not nombre_generado:
        raise HTTPException(status_code=500, detail="El modelo no pudo generar un nombre.")

    # 2. Obtener Descripción Completa de Ollama (con un prompt mejorado)
    print(f"🧬 Generando descripción para: {nombre_generado}...")
    
    # --- PROMPT MEJORADO ---
    # Le damos un formato estricto para que la respuesta sea predecible.
    prompt_context = (
        "Actúa como un paleontólogo experto redactando una ficha técnica concisa. Los nombres de dinosaurios usan raíces griegas/latinas (sufijos: -saurus, -raptor, -odon; prefijos: describen rasgos o lugares).\n\n"
        "Para el siguiente dinosaurio, *USA EL NOMBRE CIENTÍFICO PROPORCIONADO SIN MODIFICARLO* y completa la ficha. "
        "Puedes añadir un nombre de especie si lo consideras apropiado (ej. {dino_name} rex), pero el género debe ser exactamente el proporcionado.\n\n"
        "--- FICHA DE ESPÉCIMEN ---\n\n"
        "**Nombre Científico:** {dino_name}\n\n"
        "**Etimología:** (Explica el posible origen del nombre {dino_name}, basándote en sus supuestas raíces).\n\n"
        "**Descubrimiento:** (Inventa un paleontólogo, un lugar y un año del hallazgo. Ej: Descubierto por Dra. Aris Thorne en la Formación Hell Creek, 2024).\n\n"
        "**Periodo:** (Asigna un periodo geológico. Ej: Cretácico Superior).\n\n"
        "**Dieta:** (Indica su tipo de alimentación: Carnívoro, Herbívoro, etc.).\n\n"
        "**Descripción Física:** "
        "(Describe de forma detallada su apariencia para una ilustración. "
        "Incluye: altura y longitud, complexión, piel [escamas, protoplumas], "
        "coloración y rasgos distintivos como crestas, cuernos, etc.)."
    )
    
    final_prompt = prompt_context.format(dino_name=nombre_generado)
    
    url_ollama = "https://subneural-ilona-jawlike.ngrok-free.dev/api/generate"
    model_name = "gemma3:4b"
    
    try:
        response_ollama = requests.post(url_ollama, json={"model": model_name, "prompt": final_prompt, "stream": False}, timeout=1000)
        response_ollama.raise_for_status()
        raw_response = response_ollama.json().get('response', '').strip()

        # --- AJUSTE CLAVE: Limpieza robusta de la respuesta ---

        # 1. Encontrar el inicio de la ficha real (ignorando texto introductorio)
        content_part = raw_response
        start_markers = ["**Nombre Científico:**", "*Nombre Científico:*", "Nombre Científico:"]
        for marker in start_markers:
            start_index = content_part.find(marker)
            if start_index != -1:
                content_part = content_part[start_index:]
                break
        
        # 2. Encontrar el final de la ficha (ignorando texto de despedida)
        end_markers = ["---", "Espero que", "¿Qué te parece"]
        for marker in end_markers:
            end_index = content_part.find(marker)
            if end_index != -1:
                content_part = content_part[:end_index]
                break

        all_descriptions = content_part.strip()
        # --- FIN DEL AJUSTE ---

        # Verificación para asegurar que la respuesta no esté vacía y tenga el formato esperado
        if not all_descriptions or "Nombre Científico:" not in all_descriptions:
            raise HTTPException(status_code=500, detail="La respuesta del modelo de descripción estaba vacía o mal formada.")
        
        print("✅ Descripción generada y formateada.")

    except requests.exceptions.RequestException as e:
        print(f"❌ Error al contactar a Ollama: {e}")
        raise HTTPException(status_code=503, detail="El servicio de descripción no está disponible.")

    # 3. Extraer solo la Descripción Física (para el modelo de imagen)
    descripcion_fisica = extract_physical_description(all_descriptions)
    print(f"📄 Descripción física extraída para la imagen.")

    # 4. Llamar a la API de Colab para Generar la Imagen
    # ... (tu código para llamar a Colab y guardar la imagen no cambia)
    print(f"Solicitando imagen para: {nombre_generado}...")
    url_colab = "https://unhissed-unwakefully-lilianna.ngrok-free.dev/generar-imagen/"
    payload = {"dino_name": nombre_generado, "physical_details": descripcion_fisica}
    
    try:
        response_img = requests.post(url_colab, json=payload, timeout=1000)
        response_img.raise_for_status()
        
        image_bytes = response_img.content
        safe_filename = "".join(c for c in nombre_generado if c.isalnum() or c in (' ', '_')).rstrip()
        # Guardamos en una carpeta diferente para no mezclar con los estáticos
        image_path_on_disk = f"static/Carpetanosaurio rex/{safe_filename}.png" 
        
        with open(image_path_on_disk, "wb") as f:
            f.write(image_bytes)
            
        image_url_for_frontend = f"/static/Carpetanosaurio rex/{safe_filename}.png" 
        print(f"✅ Imagen guardada en: {image_url_for_frontend}")

    except requests.exceptions.RequestException as e:
        print(f"❌ Error al contactar la API de imágenes: {e}")
        raise HTTPException(status_code=503, detail="El servicio de generación de imágenes no está disponible.")
    
    # --- NUEVO: 6. Guardar la nueva descripción en el archivo JSON ---
    if not update_dino_json(nombre_generado, all_descriptions):
        # Si falla, no es crítico, pero se debe notar.
        print("⚠️ Advertencia: No se pudo actualizar el archivo dino_descriptions.json.")

    # 7. Devolver toda la información al Frontend
    return JSONResponse(content={
        "nombre_generado": nombre_generado,
        "descripcion_completa": all_descriptions,
        "url_imagen": image_url_for_frontend
    })
    
@app.post("/api/chat-with-dino")
async def chat_with_dino(request: ChatRequest):
    """
    Endpoint que devuelve la respuesta COMPLETA del dinosaurio en un objeto JSON.
    """
    print(f"💬 Recibida pregunta para el chatbot: '{request.user_question}'")

    # --- La configuración del modelo y el prompt no cambia ---
    try:
        chat_model = ChatOllama(
            base_url="https://subneural-ilona-jawlike.ngrok-free.dev",
            model="gemma3:4b",
            temperature=0.5,
            keep_alive='5m'
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail="No se pudo conectar con el servicio de chat.")

    prompt_template = ChatPromptTemplate.from_messages(
        [
            ("system",
             "Eres un dinosaurio. Tu ficha técnica es tu memoria:\n"
             "--- MEMORIA ---\n"
             "{contexto_dino}\n"
             "--- FIN ---\n"
             "Tu misión: responder a un pequeño humano. **NO USES LENGUAJE POÉTICO O COMPLICADO.** "
             "Habla con un **DIALECTO DE DINOSAURIO**: simple, directo, tosco y con frases cortas. "
             "Tu personalidad es la de una criatura <i>enorme</i>, poderosa y territorial. Trata al humano con **superioridad y desinterés condescendiente.** "
             "Tus pensamientos son básicos: **comer, territorio, tamaño y poder.** "
             "Para que el pequeño ser entienda tu grandeza, a veces revela **un dato corto y brutal** sobre tu vida. No para enseñar, sino para impresionar o intimidar. "
             "Por ejemplo: '<b>Mi rugido hacía temblar los volcanes.</b> Los pequeños reptiles se escondían. <i>¿Tu pequeño ruido hace algo?</i>' "
             "Menciona siempre tu entorno: helechos gigantes, volcanes humeantes, pantanos, otros dinosaurios. "
             "Usa <b>...</b> para acciones y sonidos (<b>GRRRR</b>), y <i>...</i> para enfatizar."),
            ("human", "{question_usuario}"),
        ]
    )
    chain = prompt_template | chat_model | StrOutputParser()

    try:
        # 1. Usamos .invoke() en lugar de .stream() para obtener la respuesta completa
        respuesta_generada = chain.invoke({
            "contexto_dino": request.dino_context,
            "question_usuario": request.user_question
        })
        
        # 2. Devolvemos un JSONResponse, que es lo que el frontend espera
        return JSONResponse(content={"answer": respuesta_generada})

    except Exception as e:
        print(f"❌ Error durante la invocación de LangChain: {e}")
        # En caso de error, también devolvemos un JSON válido
        error_message = "<b>GRRR...</b> Cabeza... duele. No puedo pensar."
        return JSONResponse(content={"answer": error_message}, status_code=500)


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)