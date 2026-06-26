---
title: "Receta 04 — Agentes y streaming: el cerebro de la app"
fecha: 2026-06-25
tipo: técnico
resumen: "Un agente real conectado a la API: respuestas token a token por SSE, memoria en Postgres, tools y registro de costos."
draft: false
---

> **Qué consigues al terminar:** un agente de IA real conectado a tu API — responde **token a
> token** por SSE, recuerda la conversación (memoria persistida en Postgres), puede llamar
> *tools* (funciones tuyas), y registra los tokens consumidos para calcular costos.
>
> 🙏 **Gracias, Bedir.** Esta serie está fuertemente basada en los excelentes posts de [Bedir Tapkan](https://bedirtapkan.com/). Gracias por compartir tu trabajo con tanta generosidad.

---

## Los 5 conceptos del SDK (en 30 segundos)

- **Agent** = una *configuración* reutilizable de un LLM (su modelo, su system prompt, sus tools).
  No tiene estado; se define una vez y se usa muchas veces.
- **Session** = la *memoria* de una conversación, persistida en Postgres. El SDK recupera el
  historial antes de cada run y guarda la respuesta después, solo.
- **Tools** = funciones Python que el agente puede decidir llamar (ej. "qué hora es"). El SDK genera
  el *schema* (la descripción de la función para el LLM) automáticamente desde tus type hints.
- **Streaming** = el agente emite *eventos* mientras trabaja (un token, una tool llamada…). Nosotros
  los traducimos a eventos SSE con nombre para el frontend.
- **Usage** = cada run reporta cuántos tokens gastó (input/output), para tracking de costos.

> El paquete se importa como **`agents`**, NO `openai_agents`.

---

## Paso 1 — Dependencias

**📋 Comando — desde `backend/`:**
```bash
uv add "openai-agents[sqlalchemy]" openai tenacity
```
- **openai-agents[sqlalchemy]** → el SDK de agentes + soporte para guardar la memoria en SQL.
- **openai** → el cliente base (lo usa el SDK; también nos da el tipo `RateLimitError`).
- **tenacity** → reintentos automáticos (para los rate limits del LLM).

> ⚠️ Como en la receta 02, recuerda `uv lock` antes de `make dev` (el Dockerfile usa `--frozen`).

---

## Paso 2 — Config de OpenAI

**Por qué:** el agente necesita la API key y el modelo. En la app real esto vive en un archivo
**aparte**, `core/config.py`, con nombres en MAYÚSCULA.

**📋 Código a copiar — `backend/app/core/config.py`:**
```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8",
        case_sensitive=False, extra="ignore",   # ignora vars del .env que no declara
    )

    DATABASE_URL: str
    AUTH0_DOMAIN: str
    AUTH0_AUDIENCE: str
    COOKIE_SECRET: str

    OPENAI_API_KEY: str
    OPENAI_MODEL: str = "gpt-5-nano"
    OPENAI_MAX_TOKENS: int = 4096
    OPENAI_TEMPERATURE: float = 0.7

    AGENT_MAX_TURNS: int = 10            # evita loops infinitos
    AGENT_ENABLE_TRACING: bool = True

settings = Settings()
```

**📋 Agregar a `backend/.env`:**
```bash
OPENAI_API_KEY=sk-...tu-key...
OPENAI_MODEL=gpt-5-nano
```

---

## Paso 3 — Ampliar el modelo `Message` (desglose de tokens)

**Por qué:** input y output cuestan distinto (el output, que incluye el "razonamiento" del modelo,
cuesta ~3× el input). Para calcular costo real necesitamos guardarlos por separado.

**📋 Agregar al modelo `Message` en `persistence/models.py`** (junto al `tokens` que ya existe):
```python
tokens: Mapped[int] = mapped_column(Integer, default=0)                               # total
input_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")     # costo input
output_tokens: Mapped[int] = mapped_column(Integer, default=0, server_default="0")    # costo output (~3x)
```

**📋 Actualizar `message_repo.create()`** para que acepte y guarde los nuevos campos (la receta 02
lo dejó sin ellos). En `persistence/repositories/message_repo.py`:
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
> ⚠️ **No olvides este paso.** El endpoint de streaming (Paso 8) llama
> `message_repo.create(..., input_tokens=..., output_tokens=...)`. Si el repo no acepta esos
> argumentos, el stream **funciona hasta el final pero revienta al guardar** con
> `TypeError: create() got an unexpected keyword argument 'input_tokens'` — y pierdes la respuesta.
> *(Bug encontrado y corregido al verificar esta receta en el test-app.)*

**📋 Generar y aplicar la migración:**
```bash
make migrate-create msg="add input_tokens and output_tokens to messages"
# revisa el archivo generado, luego:
make migrate
```

---

## Paso 4 — Las tools (`agents/agent_assistant/tools.py`)

**Por qué:** una *tool* es una función Python que el agente puede llamar cuando la necesita. El
decorador `@function_tool` le dice al SDK "exponé esto al agente"; el SDK arma el schema desde el
nombre, los type hints y el docstring. **El docstring importa**: es lo que el LLM lee para decidir
cuándo usar la tool.

**📋 Código a copiar — `backend/app/agents/agent_assistant/tools.py`:**
```python
from datetime import datetime
from zoneinfo import ZoneInfo

from agents import function_tool

DEFAULT_TZ = ZoneInfo("America/Santiago")   # zona de presentación (el server vive en UTC)

@function_tool
def get_current_time() -> str:
    """Get the current time in HH:MM:SS format, in America/Santiago timezone."""
    return datetime.now(DEFAULT_TZ).strftime("%H:%M:%S (%Z)")

@function_tool
def get_current_date() -> str:
    """Get the current date in YYYY-MM-DD format, in America/Santiago timezone."""
    return datetime.now(DEFAULT_TZ).strftime("%Y-%m-%d")
```

---

## Paso 5 — El system prompt (`prompts/system.md`)

**Por qué:** las *instructions* del agente (quién es, cómo se comporta). Lo guardamos en un `.md`
aparte para editarlo sin tocar código.

**📋 Código a copiar — `backend/app/agents/agent_assistant/prompts/system.md`:**
```markdown
You are a helpful AI assistant built on the OpenAI Agents SDK.

Your capabilities:
- Answer questions accurately and concisely
- Call tools when needed to provide current information
- Remember conversation context across messages
- Maintain a friendly, professional tone

Guidelines:
- Be concise but thorough
- If you don't know something, say so
- Use tools when they would provide better answers
- Always prioritize user privacy and safety
```

---

## Paso 6 — Construir el agente (`agents/agent_assistant/agent.py`)

**Por qué:** acá se arma el `Agent` con su modelo, prompt y tools.

**📋 Código a copiar — `backend/app/agents/agent_assistant/agent.py`:**
```python
from pathlib import Path

from agents import Agent, set_default_openai_key

from app.core.config import settings

# El SDK lee la key del environment; la inyectamos desde settings (.env)
set_default_openai_key(settings.OPENAI_API_KEY)

from .tools import get_current_date, get_current_time

def load_system_prompt() -> str:
    prompt_path = Path(__file__).parent / "prompts" / "system.md"
    return prompt_path.read_text()

def build_agent() -> Agent:
    return Agent(
        name="assistant",
        model=settings.OPENAI_MODEL,
        instructions=load_system_prompt(),
        tools=[get_current_time, get_current_date],
    )
```

---

## Paso 7 — La memoria del SDK (`core/agents.py`)

**Por qué:** `SQLAlchemySession` es la memoria de conversación del SDK, guardada en **tu** Postgres.

**📋 Código a copiar — `backend/app/core/agents.py`:**
```python
from agents import RunConfig, Runner
from agents.extensions.memory import SQLAlchemySession   # ← ruta real del SDK
from openai import RateLimitError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.core.database import engine

def get_agent_session(session_id: int) -> SQLAlchemySession:
    """La sesión del SDK para una conversación. Reutiliza nuestro engine de Postgres."""
    return SQLAlchemySession(
        str(session_id),          # el SDK espera el id como string
        engine=engine,
        create_tables=True,       # crea agent_sessions/agent_messages la 1ª vez (idempotente)
    )

@retry(
    retry=retry_if_exception_type(RateLimitError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    reraise=True,                 # tras agotar reintentos, propaga el RateLimitError real
)
async def run_agent_with_retry(agent, message, session, config: RunConfig | None = None):
    """Corre el agente (NO streaming) con reintentos ante rate limits."""
    return await Runner.run(agent, message, session=session, config=config)
```

> ⚠️ Ese `@retry` **solo sirve para `Runner.run`** (no streaming), porque ahí el `RateLimitError`
> se levanta dentro del `await`. Para **streaming** hay que atraparlo dentro del loop (ver Paso 8).

---

## Paso 8 — El endpoint de streaming (`api/stream.py`)

**Por qué:** este es el corazón. Corre el agente en modo *streaming* y traduce los eventos del SDK
a eventos SSE con nombre. Recuerda (receta 03): **auth por cookie, no JWT** (EventSource no manda
headers), y `session_id`/`message` van como query params (EventSource solo hace GET).

**📋 Código a copiar — `backend/app/api/stream.py`:**
```python
import json
import logging
from typing import AsyncGenerator

from agents import RunConfig, Runner, gen_trace_id
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from openai import RateLimitError
from openai.types.responses import ResponseTextDeltaEvent
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.agent_assistant.agent import build_agent
from app.core.agents import get_agent_session
from app.core.auth import get_user_from_stream_cookie
from app.core.database import get_db
from app.core.settings import settings
from app.domain.services.user_service import user_service
from app.persistence.repositories.message_repo import message_repo
from app.persistence.repositories.session_repo import session_repo

logger = logging.getLogger("agent")
router = APIRouter(prefix="/stream", tags=["streaming"])

def _sse(event: str, data: dict) -> str:
    """Formatea un evento SSE con nombre."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"

async def generate_agent_events(
    session_id: int, message_content: str, user_id: int, db: AsyncSession,
) -> AsyncGenerator[str, None]:
    """Corre el agente y mapea sus eventos a SSE."""
    trace_id = gen_trace_id()   # lo generamos nosotros para poder linkear con el trace (lo usamos en una receta futura)
    try:
        agent = build_agent()
        agent_session = get_agent_session(session_id)

        result = Runner.run_streamed(
            agent, message_content, session=agent_session,
            max_turns=10,   # red de seguridad contra loops (param de run_streamed)
            run_config=RunConfig(
                workflow_name="agent_assistant",
                group_id=str(session_id),
                trace_id=trace_id,
                trace_metadata={"user_id": str(user_id), "session_id": str(session_id)},
            ),
        )

        # El RateLimitError se levanta DENTRO de este loop (al consumir el stream).
        async for event in result.stream_events():
            if event.type == "raw_response_event":
                if isinstance(event.data, ResponseTextDeltaEvent):
                    yield _sse("token", {"delta": event.data.delta})          # texto token a token
            elif event.type == "run_item_stream_event":
                if event.name == "tool_called":
                    raw = event.item.raw_item
                    yield _sse("tool_call", {"name": getattr(raw, "name", None),
                                             "args": getattr(raw, "arguments", None)})
                elif event.name == "tool_output":
                    yield _sse("tool_result", {"result": str(event.item.output)})
            elif event.type == "agent_updated_stream_event":
                yield _sse("agent_handoff", {"to": event.new_agent.name})

        # Tras el loop, los datos finales ya están (NO se hace `await result`).
        usage = result.context_wrapper.usage

        assistant_message = await message_repo.create(
            db, session_id=session_id, role="assistant", content=result.final_output,
            tokens=usage.total_tokens, input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens, trace_id=trace_id,
        )

        yield _sse("usage", {"input_tokens": usage.input_tokens,
                             "output_tokens": usage.output_tokens,
                             "total_tokens": usage.total_tokens})
        yield _sse("done", {"message_id": assistant_message.id,
                            "session_id": session_id, "trace_id": trace_id})

    except RateLimitError:
        yield _sse("error", {"code": "rate_limit",
                             "message": "OpenAI rate limit. Intenta de nuevo en unos segundos."})
    except Exception as e:
        logger.exception("agent_run_failed")
        yield _sse("error", {"code": type(e).__name__, "message": str(e)})

@router.get("/")
async def stream_agent_response(
    request: Request,
    session_id: int,
    message: str,
    auth0_id: str = Depends(get_user_from_stream_cookie),   # cookie, no JWT
    db: AsyncSession = Depends(get_db),
):
    """SSE endpoint. Requiere la cookie de stream (llamar POST /auth/session antes)."""
    # CSRF barato: verificar Origin
    origin = request.headers.get("origin")
    if origin not in (settings.cors_origins or []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Origin not allowed")

    # Bridge auth0_id -> user.id + autorización de la sesión
    user = await user_service.get_or_create_from_auth0_id(db, auth0_id)
    session = await session_repo.get_by_id(db, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session not found")

    # Persistir el mensaje del usuario antes de correr el agente
    await message_repo.create(db, session_id=session_id, role="user", content=message)

    return StreamingResponse(
        generate_agent_events(session_id, message, user.id, db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},   # desactiva el buffering de nginx
    )
```

Los eventos SSE que el frontend recibe: `token` (texto), `tool_call`/`tool_result`,
`agent_handoff`, `usage` (tokens), `done` (fin, trae `message_id`), `error`.

---

## Paso 9 — Registrar el router y el de usage

**📋 Agregar a `backend/app/main.py`:**
```python
from app.api import stream, usage

app.include_router(stream.router)
app.include_router(usage.router)
```

---

## Paso 10 — Usage tracking (`api/usage.py`)

**Por qué:** con los tokens guardados por mensaje, podemos sumar el uso y estimar el costo.

**📋 Código a copiar — `backend/app/api/usage.py`:**
```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_session
from app.core.auth import get_current_user_id
from app.domain.services.user_service import user_service
from app.persistence.models import Message, Session

router = APIRouter(prefix="/api/usage", tags=["usage"])

# Precios gpt-5-nano (USD por 1M tokens). El output incluye reasoning y cuesta ~3x.
INPUT_PRICE_PER_1M = 5.0
OUTPUT_PRICE_PER_1M = 15.0

def _estimate_cost(input_tokens: int, output_tokens: int) -> float:
    cost = (input_tokens / 1_000_000) * INPUT_PRICE_PER_1M
    cost += (output_tokens / 1_000_000) * OUTPUT_PRICE_PER_1M
    return round(cost, 4)

@router.get("/summary")
async def get_usage_summary(
    db: AsyncSession = Depends(get_session),
    auth0_id: str = Depends(get_current_user_id),
):
    """Uso total del usuario (todas sus sesiones)."""
    user = await user_service.get_or_create_from_auth0_id(db, auth0_id)
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
    auth0_id: str = Depends(get_current_user_id),
):
    """Uso de una sesión (con authz de ownership)."""
    user = await user_service.get_or_create_from_auth0_id(db, auth0_id)
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

## Conceptos clave de esta parte

- **`session` vs `context`:** la *session* es lo que el agente **recuerda** (historial); el *context*
  (no usado aquí, pero clave en producción) son las **dependencias** del request (BD, user_id) que
  los tools necesitan. El context **nunca se manda a OpenAI** — se queda local.
- **El LLM ve:** mensajes, instructions, schemas de tools y resultados de tools. **Nunca ve:** tu
  context, conexiones a BD, API keys.
- **Two-tier:** tu **BD** guarda el historial limpio para el usuario (UI); el **tracing** (en una receta futura)
  guarda el detalle técnico para los devs. Cada uno su trabajo.
- **`gpt-5-nano` es un modelo de razonamiento:** "piensa" antes de responder y esos *reasoning
  tokens* se facturan como output. Un simple "Hi" puede gastar ~500 tokens. Tenlo en cuenta para el
  costo.
- **Retry en streaming:** el `@retry` NO sirve para `run_streamed` (el error ocurre al iterar, no en
  el `await`); por eso el rate limit se atrapa **dentro del loop**.

## Gotchas (verificados)

| Síntoma | Causa | Fix |
|---|---|---|
| `No module named 'openai_agents'` | el paquete se importa como `agents` | `from agents import Agent, Runner, function_tool` |
| `SQLAlchemySession` no se encuentra | ruta distinta en el SDK | `from agents.extensions.memory import SQLAlchemySession` |
| `OpenAIError: Missing credentials` | el SDK lee la key del entorno, no de `settings` | `set_default_openai_key(settings.OPENAI_API_KEY)` |
| `RunResult has no attribute 'usage'` | el usage no cuelga de `RunResult` | `result.context_wrapper.usage` |
| `SQLAlchemySession missing 'session_id'` | no hay "store"; es 1 instancia por conversación | `SQLAlchemySession(str(session_id), engine=engine, create_tables=True)` |
| `ValidationError: extra_forbidden` | el `.env` trae vars que `Settings` no declara | `extra="ignore"` en el `SettingsConfigDict` |
| rate limit no se reintenta en streaming | `@retry` no cubre `run_streamed` | `try/except RateLimitError` dentro del loop |

## Transparencia y debugging (agente + streaming)

### Probar el agente solo (sin HTTP)

Un script suelto es la forma más rápida de ver si el agente responde:
```bash
cd backend
PYTHONPATH=. uv run python scripts/test_agent.py
```
Si falla, casi siempre es uno de los gotchas de arriba (import, key, session_id).

### Probar el streaming por SSE (con curl)

Necesitas la cookie de stream primero (receta 03), luego abres el stream:
```bash
# 1. cookie (con un JWT válido)
curl -X POST http://localhost:8000/auth/session -H "Authorization: Bearer $TOKEN" -c cookies.txt
# 2. abrir el stream (Origin es obligatorio por el guard de CSRF)
curl -N -b cookies.txt -H "Origin: http://localhost:5173" \
  "http://localhost:8000/stream/?session_id=1&message=hola"
```
`-N` desactiva el buffering de curl → ves los eventos `token` llegar en vivo. Deberías ver
`event: token` repetidos, luego `event: usage` y `event: done`.

### Ver el "pensamiento" del agente (OpenAI Traces)

El SDK tiene tracing built-in: entra a https://platform.openai.com/traces y busca por el
`workflow_name` (`agent_assistant`) o el `trace_id` que guardamos en cada `Message`. Ahí ves cada
paso: qué tools llamó, con qué argumentos, cuántos tokens. (Más adelante lo llevamos también a
Phoenix, self-hosted.)

### Inspeccionar la memoria del SDK

El SDK guarda el historial en SUS tablas (separadas de las tuyas):
```bash
cd infra
docker compose exec db psql -U postgres -d agent_stack -c "\dt"          # verás agent_sessions, agent_messages
docker compose exec db psql -U postgres -d agent_stack -c "SELECT * FROM agent_messages LIMIT 5;"
```

### Ver el costo / tokens

- `GET /api/usage/summary` → uso total + costo estimado del usuario.
- En los logs del backend (`make logs-backend`) sale `agent_run_completed` con `total_tokens`.
- Recuerda: un mensaje corto puede traer cientos de *reasoning tokens* (modelo de razonamiento).

### Errores comunes en vivo

| Ves esto | Probablemente |
|---|---|
| `event: error` con `code: "rate_limit"` | superaste el rate limit de OpenAI; espera y reintenta |
| el stream se corta a los 60s | el `TimeoutMiddleware` (respuestas muy largas) |
| `403 Origin not allowed` | falta/está mal el header `Origin` o `cors_origins` |
| `403 Session not found` | la sesión no es del usuario, o no existe |

## Checklist de "agente listo"

- [ ] `make migrate` aplicó la migración de `input_tokens`/`output_tokens`
- [ ] El curl del SSE devuelve `event: token` en vivo, luego `usage` y `done`
- [ ] Tras una respuesta, hay un `Message` con `role="assistant"` y tokens > 0
- [ ] Existen las tablas `agent_sessions` y `agent_messages`
- [ ] `GET /api/usage/summary` devuelve tokens y `estimated_cost_usd`
- [ ] Un segundo mensaje en la misma sesión **recuerda** el contexto del primero
