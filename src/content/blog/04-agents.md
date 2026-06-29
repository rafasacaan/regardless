---
title: "Construyendo a hey-frank #4 — Agents y streaming con Google ADK"
fecha: 2026-06-25
tipo: "hey frank"
resumen: "El agente con Google ADK y Gemini: streaming SSE, tools, memoria y tracking de uso."
draft: false
---

> Hoy, cuarta receta del set para construir una app agéntica.
>
> **Crédito:** estas notas están fuertemente basadas en la serie *Building a Production-Ready Agent
> Stack* de **Bedir Tapkan** ([bedirtapkan.com](https://bedirtapkan.com)). Gracias por el material
> original; acá lo adapté a mi stack (Gemini/ADK + Firebase).



Partamos sin más preámbulos!

## El mapa mental: las piezas de Google ADK

Antes de escribir código, conviene entender las **5 piezas** con las que ADK arma un agente. Son
pocas y encajan limpio:

- **`Agent`** — la *definición* del agente: un modelo (Gemini) + sus instrucciones (el system prompt)
  + sus tools. Es el "quién es y qué sabe hacer". No corre nada por sí solo; es la receta.
- **Tools** — funciones Python normales que el agente *puede llamar* (ej. "dame la hora"). ADK las
  envuelve solas a partir de su firma y su docstring; no hay decorador obligatorio.
- **`SessionService`** — la **memoria**. Administra las conversaciones, cada una identificada por la
  tripleta `(app_name, user_id, session_id)`. Importante: **la sesión de ADK ya lleva el `user_id`
  adentro**, así que ADK sabe de quién es cada conversación. Hay dos versiones: `InMemory...` (se
  pierde al reiniciar, sirve para probar) y `Database...` (persiste en Postgres).
- **`Runner`** — el **motor** que corre el agente. Le das un mensaje y él ejecuta el loop: llama al
  modelo, si el modelo pide una tool la ejecuta, vuelve a llamar al modelo, y así hasta tener la
  respuesta. Tú no escribes ese loop — ADK lo maneja.
- **`Event`** — cada cosa que ocurre *durante* un run llega como un objeto `Event`: un pedacito de
  texto, una llamada a tool, su resultado, el conteo de tokens. El `Runner` te entrega un **stream de
  Events** que tú vas leyendo.

Cómo se conectan, en una frase:
```
Agent (modelo + prompt + tools)  +  SessionService (memoria)  →  Runner  →  stream de Events
```

Y una distinción que ordena toda la receta: **unas piezas son de ADK, otras son tuyas.**
- **De ADK:** `Agent`, `Runner`, `SessionService`, los `Event` (el cerebro y su loop).
- **Tuyo:** el endpoint SSE que expone todo eso por HTTP — auth por cookie, query params, y el
  contrato de eventos `token`/`tool_call`/`usage`/`done` que tu frontend espera. Eso lo decides tú,
  ADK no se mete.



## Paso 1 — Dependencias

**📋 Comando — desde `backend/`:**
```bash
uv add google-adk
```


## Paso 2 — Config de Gemini

**Por qué una sola fuente de config:** no creamos un `core/config.py` aparte para el agente — eso
sería duplicar config. Sumamos los dos campos del agente a la clase `Settings` que ya existe en
`core/settings.py`. Una sola fuente de verdad, importada igual en todo el backend.

**📋 Agregar a `core/settings.py`** (junto al resto de campos, en minúsculas como el resto):
```python
# Agente (Gemini / ADK)
gemini_model: str = "gemini-2.5-flash"
agent_max_turns: int = 10
# Nota: GOOGLE_API_KEY NO va acá. ADK la lee del entorno del SO directamente,
# no del objeto settings (ver el ⚠️ de abajo).
```

**📋 `backend/.env`:**
```bash
GOOGLE_API_KEY=...tu-key-de-google-ai-studio...
GEMINI_MODEL=gemini-2.5-flash
```

> ⚠️ **Gotcha — modelo y cuota (verificado jun 2026):**
> - **`gemini-2.0-flash` está retirado** → da `404 NOT_FOUND` ("model is no longer available"). Usa un
>   modelo actual: **`gemini-2.5-flash`** (o `gemini-2.5-flash-lite` / `gemini-flash-latest`).
> - **429 RESOURCE_EXHAUSTED con `limit: 0`** al primer run = tu proyecto **no tiene free tier** para
>   ese modelo. No es un rate limit pasajero (esperar no ayuda). Fix: genera la key en
>   [Google AI Studio](https://aistudio.google.com/apikey) (auto-provisiona free tier) y/o **habilita
>   billing** en el proyecto. El 429 desaparece cuando la cuota deja de ser 0.


## Paso 3 — Modelo `Message`, migración y repo

**Por qué:** input y output cuestan distinto; para calcular costo real los guardamos por separado.

**📋 Agregar al modelo `Message` en `persistence/models.py`** (junto al `tokens` que ya existe):
```python
tokens: Mapped[int] = mapped_column(Integer, default=0)                            # total
input_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
output_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
```

**📋 Actualizar `repositories/message_repo.create()`** :
```python
async def create(self, db, session_id, role, content,
                 tool_name=None, trace_id=None, span_id=None,
                 tokens=0, input_tokens=0, output_tokens=0) -> Message:   # ← nuevos params
    message = Message(session_id=session_id, role=role, content=content,
                      tool_name=tool_name, trace_id=trace_id, span_id=span_id,
                      tokens=tokens, input_tokens=input_tokens, output_tokens=output_tokens)
    db.add(message); await db.flush(); await db.refresh(message)
    return message
```

**📋 Migración:**
```bash
make migrate-create msg="add input_tokens and output_tokens to messages"
# revisa el archivo generado, luego:
make migrate
```


## Paso 4 — Las tools (`agents/agent_assistant/tools.py`)

**Por qué:** en ADK una tool es una **función Python normal** con type hints y docstring; el SDK la
envuelve sola. No hay decorador obligatorio.

**📋 Código:**
```python
from datetime import datetime
from zoneinfo import ZoneInfo

DEFAULT_TZ = ZoneInfo("America/Santiago")


def get_current_time() -> dict:
    """Get the current time in HH:MM:SS format, in America/Santiago timezone."""
    return {"time": datetime.now(DEFAULT_TZ).strftime("%H:%M:%S (%Z)")}


def get_current_date() -> dict:
    """Get the current date in YYYY-MM-DD format, in America/Santiago timezone."""
    return {"date": datetime.now(DEFAULT_TZ).strftime("%Y-%m-%d")}
```
> 💡 ADK recomienda que las tools **devuelvan un `dict`** (no un string), con una clave
> descriptiva. El docstring sigue siendo lo que el modelo lee para decidir cuándo usarla.


## Paso 5 — El system prompt

**Por qué:** el system prompt es el "carácter" del agente — define quién es, cómo responde, y cuándo
usar sus tools. El `agent.py` (Paso 6) lo lee con `load_system_prompt()`, así que **este archivo tiene
que existir** o el agente se cae al construirse. En ADK se pasa como `instruction` (singular).

**📋 Código — `backend/app/agents/agent_assistant/prompts/system.md`:**
```markdown
Eres "hey-frank", un asistente conversacional útil, directo y amable.

## Cómo respondes
- Responde en el idioma del usuario (español por defecto).
- Sé conciso: ve al grano, sin relleno ni disculpas innecesarias.
- Si no sabes algo o no tienes una tool para resolverlo, dilo con honestidad.

## Tus herramientas
- `get_current_time`: úsala cuando el usuario pregunte la hora actual.
- `get_current_date`: úsala cuando el usuario pregunte la fecha de hoy.

No inventes la hora ni la fecha: para eso usa siempre las tools. La zona horaria de referencia es
America/Santiago.
```
> El docstring de cada tool (Paso 4) es lo que el modelo lee para decidir *cuándo* llamarla; este
> prompt le da el *contexto general*. Ajústalo a gusto — es lo más fácil de iterar.


## Paso 6 — Construir el agente (`agents/agent_assistant/agent.py`)

**📋 Código:**
```python
from pathlib import Path

from google.adk.agents import Agent   # en algunas versiones se importa como LlmAgent

from app.core.settings import settings
from .tools import get_current_date, get_current_time


def load_system_prompt() -> str:
    return (Path(__file__).parent / "prompts" / "system.md").read_text()


def build_agent() -> Agent:
    return Agent(
        name="assistant",
        model=settings.gemini_model,          # "gemini-2.5-flash"
        instruction=load_system_prompt(),     # ojo: "instruction", no "instructions"
        tools=[get_current_time, get_current_date],
    )
```
> 💡 Ojo con tres detalles según tu versión de ADK: `Agent` (alias de `LlmAgent`), el parámetro
> `instruction` (singular), y que el modelo se pase como string. La key se toma del entorno
> (`GOOGLE_API_KEY`), no se inyecta a mano.

---

## Paso 7 — Session service + runner (`core/agents.py`)

**Por qué:** ADK no maneja "una sesión por conversación" como un objeto suelto que tú creas y pasas;
usa un **SessionService** central que administra todas las conversaciones, cada una identificada por
la tripleta `(app_name, user_id, session_id)`. Como el `user_id` va dentro de esa identidad, **ADK
sabe a qué usuario pertenece cada sesión** sin que tú lleves el scoping por fuera. El **Runner** se
apoya en este servicio para recuperar el historial en cada turno.

> **En puertos y adaptadores:** el agente (Gemini/ADK) es un **adaptador de salida** detrás de un
> "puerto de LLM" — por eso vive aislado en `app/agents/` y es swappable. El endpoint de streaming
> (Paso 8) es un **adaptador de entrada**.

**📋 Código:**
```python
from google.adk.runners import Runner
from google.adk.sessions import DatabaseSessionService

from app.core.settings import settings

APP_NAME = "agent_stack"

# ADK crea sus propias tablas (sessions, events, app_states...) y la suya `sessions`
# COLISIONA con la tabla `sessions` de la app. Por eso le damos una BD aparte (misma
# instancia de Postgres, otra base: `adk`). Derivamos la URL de la principal.
_adk_db_url = str(settings.database_url).rsplit("/", 1)[0] + "/adk"
_session_service = DatabaseSessionService(db_url=_adk_db_url)


def get_session_service() -> DatabaseSessionService:
    return _session_service


def build_runner(agent) -> Runner:
    return Runner(agent=agent, app_name=APP_NAME, session_service=get_session_service())
```

> ⚠️ **Gotcha importante — colisión de tablas.** Si apuntas `DatabaseSessionService` a **tu misma
> base** (`settings.database_url`), revienta al primer run con algo como:
> `column "app_name" referenced in foreign key constraint does not exist` (al crear la tabla
> `events`). La razón: ADK quiere crear sus propias tablas `sessions`/`events`/`app_states`, pero ya
> existe **tu** tabla `sessions` (con otra forma), y los FK de ADK chocan. **Fix:** darle a ADK una
> **BD separada**. Créala una vez:
> ```bash
> docker compose exec db psql -U postgres -c "CREATE DATABASE adk;"
> ```
> y apunta el service a ella (el código de arriba ya lo hace, derivando `.../adk` de tu
> `database_url`). Así las tablas de ADK viven aisladas de las tuyas.

> `DatabaseSessionService` construye su engine con `create_async_engine` y un `async_sessionmaker` —
> es **async nativo**. Le pasas la URL con `+asyncpg` tal cual; **no** hay que convertirla a sync.
> Para una primera prueba sin persistencia (y sin crear la BD `adk`) sirve
> `from google.adk.sessions import InMemorySessionService` → `InMemorySessionService()`, que no crea
> tablas.

---

## Paso 8 — El endpoint de streaming (`api/stream.py`)

**Por qué:** este es el paso donde **todo se junta**. El usuario escribe algo y necesitamos: 
- (1) correr el agente, y 
- (2) que la respuesta llegue al navegador **palabra por palabra** en vez de esperar el bloque completo. Eso se hace con **SSE** (Server-Sent Events): una respuesta HTTP que se mantiene abierta y va empujando líneas de a poco.

El archivo tiene **dos mitades**, y conviene verlas separadas:

1. **El endpoint HTTP** (`@router.get("/")`) — la parte *tuya*, no de ADK. Se encarga de la auth (por
   **cookie** de stream, no JWT — recuerda que `EventSource` no manda headers),
   chequear el `Origin` (anti-CSRF), confirmar que la sesión es del usuario, guardar el mensaje del
   usuario, y abrir el `StreamingResponse`.
2. **`generate_agent_events`** — la parte que habla con **ADK**. Es un *generador async*: corre el
   `Runner`, va recibiendo el **stream de `Event`** del agente, y **traduce** cada `Event` de ADK al
   formato de eventos SSE que tu frontend entiende (`token`, `tool_call`, `usage`, `done`...).

> **La idea clave**: ADK te da el loop y los `Event`; tu trabajo acá es **mapear esos `Event` a tu
contrato SSE** y manejar la conexión HTTP. Vamos a leer el código por esas dos mitades.

**📋 Código — `backend/app/api/stream.py` (completo, versión ADK):**
```python
import json
import logging
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from google.genai import types
from google.adk.agents.run_config import RunConfig, StreamingMode   # la ruta puede variar según la versión

from app.agents.agent_assistant.agent import build_agent
from app.core.agents import APP_NAME, build_runner, get_session_service
from app.core.auth import get_user_from_stream_cookie
from app.core.database import get_db
from app.core.settings import settings
from app.domain.services.user_service import user_service
from app.persistence.repositories.message_repo import message_repo
from app.persistence.repositories.session_repo import session_repo

logger = logging.getLogger("agent")
router = APIRouter(prefix="/stream", tags=["streaming"])


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def generate_agent_events(session_id, message_content, user_id, db):
    try:
        runner = build_runner(build_agent())
        svc = get_session_service()
        uid, sid = str(user_id), str(session_id)

        # ADK exige que la sesión exista antes de correr
        existing = await svc.get_session(app_name=APP_NAME, user_id=uid, session_id=sid)
        if not existing:
            await svc.create_session(app_name=APP_NAME, user_id=uid, session_id=sid)

        new_message = types.Content(role="user", parts=[types.Part(text=message_content)])

        final_text, usage = "", None
        async for event in runner.run_async(
            user_id=uid, session_id=sid, new_message=new_message,
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        ):
            # 1) texto (los chunks parciales traen event.partial = True)
            if event.content and event.content.parts:
                text = "".join(p.text or "" for p in event.content.parts)
                if text:
                    if getattr(event, "partial", False):
                        yield _sse("token", {"delta": text})
                    else:
                        final_text = text

            # 2) tool calls / resultados
            for fc in event.get_function_calls():
                yield _sse("tool_call", {"name": fc.name, "args": json.dumps(fc.args)})
            for fr in event.get_function_responses():
                yield _sse("tool_result", {"result": str(fr.response)})

            # 3) usage (viene en el/los eventos del modelo)
            if getattr(event, "usage_metadata", None):
                usage = event.usage_metadata

        in_tok = getattr(usage, "prompt_token_count", 0) or 0
        out_tok = getattr(usage, "candidates_token_count", 0) or 0
        total = getattr(usage, "total_token_count", 0) or 0

        msg = await message_repo.create(
            db, session_id=session_id, role="assistant", content=final_text,
            tokens=total, input_tokens=in_tok, output_tokens=out_tok,
        )
        yield _sse("usage", {"input_tokens": in_tok, "output_tokens": out_tok, "total_tokens": total})
        yield _sse("done", {"message_id": msg.id, "session_id": session_id})

    except Exception as e:
        logger.exception("agent_run_failed")
        yield _sse("error", {"code": type(e).__name__, "message": str(e)})


@router.get("/")
async def stream_agent_response(
    request: Request,
    session_id: int,
    message: str,
    subject: str = Depends(get_user_from_stream_cookie),   # cookie, no JWT
    db: AsyncSession = Depends(get_db),
):
    """SSE endpoint. Requiere la cookie de stream (llamar POST /auth/session antes)."""
    origin = request.headers.get("origin")
    if origin not in (settings.cors_origins or []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Origin not allowed")

    user = await user_service.get_or_create_from_subject(db, subject)
    session = await session_repo.get_by_id(db, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session not found")

    await message_repo.create(db, session_id=session_id, role="user", content=message)

    return StreamingResponse(
        generate_agent_events(session_id, message, user.id, db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )
```
Los eventos SSE que recibe el frontend: `token`, `tool_call`/`tool_result`, `usage`, `done`, `error`.

El endpoint `@router.get("/")` (arriba) es agnóstico del proveedor: auth por cookie, CSRF por
Origin, autorización de sesión, persistir el mensaje del usuario y `StreamingResponse`. Lo único
específico de ADK es `generate_agent_events`.


## Paso 8.5 — Resiliencia: retry ante rate limits (429/503)

**Por qué:** los modelos fallan a veces por **rate limit** (429) o por estar **sobrecargados** (503).
Son errores **transitorios**: reintentar un par de veces con espera suele resolverlos. Pero hay una
trampa con el streaming: **una vez que empezaste a mandar tokens, no puedes reintentar** sin duplicar
la salida. Así que la regla es **reintentar solo si el error pega *antes* del primer token**.

**📋 Helper en `core/agents.py`** (qué error vale la pena reintentar):
```python
AGENT_MAX_RETRIES = 3          # nº de reintentos antes de rendirse
AGENT_RETRY_BASE_DELAY = 2.0   # segundos; backoff exponencial: 2, 4, 8...


def is_retryable_error(e: Exception) -> bool:
    """Transitorio = rate limit (429) o sobrecarga (503). ADK envuelve el rate limit en
    `_ResourceExhaustedError`, que no siempre trae `.code`; de ahí el fallback por nombre/mensaje."""
    if getattr(e, "code", None) in (429, 503):
        return True
    return "ResourceExhausted" in type(e).__name__ or "RESOURCE_EXHAUSTED" in str(e).upper()
```

**📋 En `generate_agent_events` (Paso 8):** envuelve el run en un loop de reintento, con un flag
`streamed_any` que marca si ya emitiste algo:
```python
attempt = 0
while True:
    streamed_any = False
    final_text, usage = "", None
    try:
        # ... crear sesión si no existe ...
        async for event in runner.run_async(...):
            # cada vez que hagas yield de un token/tool: streamed_any = True
            ...
        # ... persistir + yield usage + yield done ...
        return
    except Exception as e:
        # reintenta SOLO si es transitorio Y todavía no streameamos nada
        if is_retryable_error(e) and not streamed_any and attempt < AGENT_MAX_RETRIES:
            attempt += 1
            await asyncio.sleep(AGENT_RETRY_BASE_DELAY * (2 ** (attempt - 1)))   # 2, 4, 8...
            continue
        yield _sse("error", {"code": type(e).__name__, "message": str(e)})
        return
```

> **El caveat del streaming** (lo advertía el template original): el retry con decorador (tipo
> `tenacity`) sirve para una llamada **no-streaming** (`Runner.run`), donde el error se levanta dentro
> de un solo `await`. Para **streaming** (`run_async`), el error aparece al iterar, posiblemente a
> mitad de la respuesta — por eso el retry va **dentro** del generador y solo **antes** del primer
> token (`not streamed_any`). Si el fallo es a mitad de stream, se emite `event: error` y listo.
>
> ⚠️ Nota: al reintentar se vuelve a llamar `run_async` con el mismo mensaje. Si ADK alcanzó a
> registrar el turno del usuario en su sesión antes de fallar, podría duplicarse en el contexto. Para
> una app de dev es aceptable; en producción querrías idempotencia más fina.


## Paso 9 — Registrar los routers

**📋 Agregar a `backend/app/main.py`:**
```python
from app.api import stream, usage

app.include_router(stream.router)
app.include_router(usage.router)
```

## Paso 10 — Usage tracking (`api/usage.py`)

**Por qué:** como en el Paso 8 guardamos `input_tokens`/`output_tokens` por cada mensaje del agente,
ahora podemos **sumarlos** y estimar el costo. Solo necesitas poner los **precios de Gemini** (USD por
1M de tokens, input y output por separado) en las constantes de abajo.

**📋 Código — `backend/app/api/usage.py`:**
```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_session
from app.core.auth import get_current_user_id
from app.domain.services.user_service import user_service
from app.persistence.models import Message, Session

router = APIRouter(prefix="/api/usage", tags=["usage"])

# ⚠️ Ajusta a los precios de Gemini (USD por 1M tokens)
INPUT_PRICE_PER_1M = 0.10
OUTPUT_PRICE_PER_1M = 0.40


def _estimate_cost(input_tokens: int, output_tokens: int) -> float:
    cost = (input_tokens / 1_000_000) * INPUT_PRICE_PER_1M
    cost += (output_tokens / 1_000_000) * OUTPUT_PRICE_PER_1M
    return round(cost, 4)


@router.get("/summary")
async def get_usage_summary(
    db: AsyncSession = Depends(get_session),
    subject: str = Depends(get_current_user_id),
):
    user = await user_service.get_or_create_from_subject(db, subject)
    query = (
        select(
            func.coalesce(func.sum(Message.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(Message.output_tokens), 0).label("output_tokens"),
            func.coalesce(func.sum(Message.tokens), 0).label("total_tokens"),
            func.count(Message.id).label("message_count"),
        )
        .join(Session, Message.session_id == Session.id)
        .where(Session.user_id == user.id, Message.role == "assistant")
    )
    row = (await db.execute(query)).first()
    return {
        "total_input_tokens": row.input_tokens,
        "total_output_tokens": row.output_tokens,
        "total_tokens": row.total_tokens,
        "message_count": row.message_count,
        "estimated_cost_usd": _estimate_cost(row.input_tokens, row.output_tokens),
    }


@router.get("/by-session/{session_id}")
async def get_session_usage(
    session_id: int,
    db: AsyncSession = Depends(get_session),
    subject: str = Depends(get_current_user_id),
):
    user = await user_service.get_or_create_from_subject(db, subject)
    session = (await db.execute(
        select(Session).where(Session.id == session_id, Session.user_id == user.id)
    )).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    query = select(
        func.coalesce(func.sum(Message.input_tokens), 0).label("input_tokens"),
        func.coalesce(func.sum(Message.output_tokens), 0).label("output_tokens"),
        func.coalesce(func.sum(Message.tokens), 0).label("total_tokens"),
        func.count(Message.id).label("message_count"),
    ).where(Message.session_id == session_id, Message.role == "assistant")
    row = (await db.execute(query)).first()
    return {
        "session_id": session_id,
        "total_input_tokens": row.input_tokens,
        "total_output_tokens": row.output_tokens,
        "total_tokens": row.total_tokens,
        "message_count": row.message_count,
        "estimated_cost_usd": _estimate_cost(row.input_tokens, row.output_tokens),
    }
```

---

## Paso 11 — Probar el agente (end-to-end)

Vamos de **lo más fácil a lo más completo**. Las primeras pruebas no necesitan ni HTTP ni cookie. Hazlas en orden.

### A) Las tools solas (5 segundos)

Las tools son funciones Python normales: pruébalas sin nada de ADK. Desde `infra/`:
```bash
docker compose exec backend uv run python -c \
  "from app.agents.agent_assistant.tools import get_current_time, get_current_date; \
   print(get_current_time()); print(get_current_date())"
```
Deberías ver algo como `{'time': '14:03:22 (-04)'}` y `{'date': '2026-06-28'}`. Si esto falla, es un
problema de la tool, no del agente.

### B) El agente, sin HTTP (la prueba clave)

Esta es **la más importante**: corre el agente directo con un `Runner` + `InMemorySessionService` (sin
BD, sin cookie, sin SSE) e imprime los `Event` crudos.

**📋 `backend/scripts/try_agent.py`:**
```python
import asyncio

from google.genai import types
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService

from app.agents.agent_assistant.agent import build_agent

APP_NAME = "agent_stack"


async def main():
    svc = InMemorySessionService()
    await svc.create_session(app_name=APP_NAME, user_id="dev", session_id="s1")
    runner = Runner(agent=build_agent(), app_name=APP_NAME, session_service=svc)

    msg = types.Content(role="user", parts=[types.Part(text="¿Qué hora es?")])
    async for event in runner.run_async(user_id="dev", session_id="s1", new_message=msg):
        if event.content and event.content.parts:
            text = "".join(p.text or "" for p in event.content.parts)
            if text:
                print(f"[texto partial={getattr(event, 'partial', None)}] {text!r}")
        for fc in event.get_function_calls():
            print(f"[tool_call] {fc.name} args={fc.args}")
        for fr in event.get_function_responses():
            print(f"[tool_result] {fr.response}")
        if getattr(event, "usage_metadata", None):
            print(f"[usage] {event.usage_metadata}")


if __name__ == "__main__":
    asyncio.run(main())
```

Como `scripts/` se **hornea en la imagen** (no es volumen), tras crear el archivo reconstruye el
backend, y corre:
```bash
cd infra && docker compose up -d --build backend
docker compose exec backend uv run python -m scripts.try_agent
```
> 💡 Si vas a iterar mucho en scripts de prueba, móntalo como volumen en el compose
> (`- ../backend/scripts:/app/scripts`, como hiciste con `alembic/`) y te ahorras el rebuild cada vez.

**Qué mirar:** que aparezca un `[tool_call] get_current_time`, luego un `[tool_result]`, después el
texto final con la hora, y un `[usage]` con los conteos. Si los **nombres de los campos** que imprime
`[usage]` no son `prompt_token_count`/`candidates_token_count`/`total_token_count`, ajústalos en el
Paso 8.

### C) El endpoint SSE completo (con cookie)

Ahora sí, el camino real. La **cookie de stream** sale de `POST /auth/session`, que a su vez necesita
un **ID token de Firebase** en el `Bearer`. Lo primero es conseguir ese token.

**Paso 0 — conseguir el ID token (`$TOKEN`)**

De dónde sale el token depende de qué proveedor activaste en la receta 03:

- **Solo Google** (sin frontend que te lo dé fácil): sácalo del **navegador**. Con tu `App.tsx` de
  prueba corriendo en `localhost:5173`, haz login con Google y abre la **consola del navegador**
  (DevTools → Console). Importa tu helper y pídelo:
  ```js
  // en la consola del navegador, ya logueado:
  const { getToken } = await import('/src/auth.ts')
  console.log(await getToken())   // copia el string largo que empieza con eyJ...
  ```
  (O agrega temporalmente un `console.log(await getToken())` a un botón del `App.tsx`.)

- **Email/Password activado**: sin navegador, pídelo a la API REST de Firebase con tu `apiKey`:
  ```bash
  curl "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=TU_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"test1234","returnSecureToken":true}'
  # copia el campo "idToken" de la respuesta
  ```

Guarda ese token en una variable de shell (dura ~1 h):
```bash
export TOKEN="eyJ...pega-aquí-el-id-token..."
```

**Pasos 1–3 — generar la cookie y abrir el stream** (desde `infra/` o tu shell):

```bash
# 1) ID token → cookie de stream (la guardamos en un cookie jar local: cookies.txt)
curl -c cookies.txt -X POST http://localhost:8000/auth/session \
  -H "Authorization: Bearer $TOKEN"
#    → debe responder 204. Revisa cookies.txt: tiene una línea con stream_session.

# 2) crear una sesión (usa el Bearer, NO la cookie) y anota el id que devuelve
curl -X POST http://localhost:8000/api/sessions/ \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"prueba agente"}'

# 3) abrir el stream (manda la cookie con -b + header Origin OBLIGATORIO; -N = sin buffer)
curl -N -b cookies.txt -H "Origin: http://localhost:5173" -G \
  --data-urlencode "session_id=1" \
  --data-urlencode "message=hola, ¿qué hora es?" \
  http://localhost:8000/stream/
```
> El `-c cookies.txt` (paso 1) **guarda** la cookie que devuelve el server; el `-b cookies.txt`
> (paso 3) la **manda** de vuelta. Es el equivalente por terminal a lo que el navegador hace solo.
> Ajusta el `session_id=1` al id real que te devolvió el paso 2.

Deberías ver fluir los eventos SSE:
```
event: tool_call
data: {"name": "get_current_time", ...}
event: token
data: {"delta": "Son las "}
...
event: usage
data: {"input_tokens": 120, "output_tokens": 18, "total_tokens": 138}
event: done
data: {"message_id": 42, "session_id": 1}
```
> Gotchas que pegan acá:
> - **500** en el paso 2 con `'str' object cannot be interpreted as an integer` (en el INSERT de
>   `sessions.user_id`): te falta traducir `subject → user.id` en los handlers de la receta 03 (Paso
>   8). El `subject` es el uid string de Firebase; el `user_id` de la BD es entero. Cada handler debe
>   hacer `user = await user_service.get_or_create_from_subject(db, subject)` y pasar `user.id`, **no**
>   `subject`. Aplica a los 6 handlers de `sessions.py`/`messages.py`.
> - **403 "Origin not allowed"**: falta o no coincide el header `Origin` (debe estar en tu
>   `cors_origins`).
> - **401**: la cookie no viajó (revisa el paso 1, o que el `Path=/stream/` calce).

### D) Desde el frontend (opcional)

El `App.tsx` de prueba (receta 03) se puede extender: tras el login + `POST /auth/session`, abre un
`EventSource` a `/stream/?session_id=...&message=...` y pinta los `token` a medida que llegan.
`EventSource` manda la cookie solo (por eso el bridge de la 03). Esta es la prueba "de verdad", pero
para verificar el agente las pruebas **A–C** alcanzan.

### Checklist de "agente listo"

- [ ] **A** — las tools devuelven su `dict`.
- [ ] **B** — `try_agent.py` imprime `tool_call` → `tool_result` → texto final → `usage` con conteos.
- [ ] Los nombres de `usage_metadata` calzan con los del Paso 8 (o los ajustaste).
- [ ] **C** — el `curl -N` fluye `token`/`tool_call`/`usage`/`done` y termina sin `error`.
- [ ] El mensaje del agente quedó guardado en `messages` (con `input_tokens`/`output_tokens`).
- [ ] `GET /api/usage/summary` (con Bearer) devuelve tokens y costo estimado.

---

## Conceptos clave de ADK (lo que conviene recordar)

- **El SessionService administra el scoping.** La sesión lleva `app_name + user_id + session_id`, así
  que ADK conoce al usuario dueño de cada conversación. Aun así, **autorizas la sesión en tu
  endpoint** antes de correr el agente (no confíes solo en ADK para la seguridad).
- **Hay que crear la sesión antes de correr** (`create_session`): ADK **no** la crea sola en el primer
  uso. Por eso el Paso 8 hace `get_session` → si no existe, `create_session`.
- **Los `Event` son un único tipo de objeto** que describe todo lo que pasa en el run: `content.parts`
  (el texto), `partial` (si es un chunk parcial o el texto final), `get_function_calls()` /
  `get_function_responses()` (tools), `usage_metadata` (tokens), `is_final_response()`. Lees todos
  los eventos del mismo modo.
- **Gemini "thinking":** `gemini-2.5-flash` razona antes de responder, y esos tokens vienen aparte en
  `usage_metadata.thoughts_token_count` (verificado: vimos `thoughts_token_count=38` en una corrida).
  Ojo para el costo: ese conteo **no** está dentro de `candidates_token_count` (el output visible),
  así que si quieres el costo real del output tienes que sumar `candidates + thoughts`.
- **DB async (verificado):** tu app usa `asyncpg` (async) y el `DatabaseSessionService` de ADK 2.3.0
  también es async por dentro (`create_async_engine`), así que comparten driver sin fricción: le pasas
  tu `database_url` con `+asyncpg` tal cual.


