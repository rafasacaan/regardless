---
title: "Recipe Book #1 — Foundation: el esqueleto de tu app desde cero"
fecha: 2026-06-04
tipo: tech
resumen: "Los cimientos: Docker Compose, FastAPI con /health, config centralizada, logging estructurado y un make dev que levanta todo."
draft: false
---

> **Qué consigues al terminar:** un proyecto que *arranca* — Docker Compose (orquestador que
> levanta varios servicios juntos) con 3 servicios, un FastAPI con `/health` que verifica la base
> de datos, config centralizada, logging estructurado y un `make dev` que levanta todo con un
> comando. Todavía sin lógica de negocio: solo los cimientos.
>
> 📋 **Cómo leer esta receta:** cada paso tiene dos partes — (1) **el porqué** y (2) **el código a
> copiar**. El código está recortado a esta etapa: donde un archivo crece en recetas futuras
> (auth, agentes, observabilidad), lo verás marcado con una nota. Copiando tal cual, la app
> arranca.
>
> 🙏 **Gracias, Bedir.** Esta serie está fuertemente basada en los excelentes posts de [Bedir Tapkan](https://bedirtapkan.com/). Gracias por compartir tu trabajo con tanta generosidad.

---

## Antes de escribir código: decide tu stack (y por qué)

Para crear tu app agéntica desde cero, primero eliges las piezas. No improvises esto: cada
decisión te ahorra (o te cobra) dolor después.

| Pieza | Elección | Por qué |
|---|---|---|
| Backend | **FastAPI** | async (atiende muchas peticiones a la vez sin bloquearse), tipado, y genera solo la documentación OpenAPI (página interactiva que lista y prueba tus endpoints) |
| Frontend | **React + Vite + TS** | no necesitamos SSR (Server-Side Rendering: armar el HTML en el servidor); Vite da el ciclo de desarrollo más rápido |
| Agentes | **OpenAI Agents SDK** | poco código que aprender, hecho para Python, fácil de testear |
| Gestor de paquetes | **uv** | instala dependencias muy rápido y deja un lockfile (archivo que fija las versiones exactas para que el proyecto se reconstruya igual en cualquier máquina) |
| Streaming | **SSE** (Server-Sent Events: el servidor empuja datos al navegador) | va en un solo sentido (servidor → cliente), se reconecta solo, y es más simple que WebSockets |
| Auth | **Auth0 + cookie para SSE** | OIDC (OpenID Connect: estándar de login sobre OAuth2) maduro y fácil de reemplazar |
| Base de datos | **Postgres + asyncpg + SQLAlchemy** | mismo motor en desarrollo y producción, y cumple ACID (garantías de que cada transacción es confiable: Atómica, Consistente, Aislada y Durable) |
| Infra local | **Docker Compose** | levantas todo con un comando y se parece a producción |

**Principio rector — arquitectura hexagonal** (también llamada "puertos y adaptadores"): mantén
el corazón de tu app (la lógica de negocio) separado de las herramientas externas (Auth0,
OpenAI, Postgres), conectándolas a través de *adapters* (piezas de traducción intercambiables).
Así puedes cambiar Auth0 por otro proveedor de login, o SQLite por Postgres, sin tocar la lógica
de negocio. Los agentes viven en `app/agents/`; el resto de la app no sabe de qué SDK (kit de
herramientas del proveedor) vienen.

```
Externa (Auth0, OpenAI, Postgres)
        ↕  adapters
   Core de la app
```

---

## Paso 1 — Arma la estructura de carpetas

**Por qué:** el layout refleja las capas (ver `00-las-5-capas.md`). Cada carpeta tiene un solo
trabajo, así siempre sabes dónde buscar (y dónde poner) cada cosa.

> ⚠️ Crea siempre los `__init__.py` (archivo vacío que le dice a Python "esta carpeta es un
> módulo importable"). Un error típico es `ModuleNotFoundError: No module named
> 'app.core.settings'` por importar módulos sin su `__init__.py`.

**📋 Código a copiar — desde la raíz del proyecto:**
```bash
mkdir -p backend/app/{api,domain/services,persistence/repositories,core,agents}
mkdir -p infra frontend

# __init__.py para que Python trate cada carpeta como módulo
find backend/app -type d -exec touch {}/__init__.py \;
```

Estructura resultante:
```
backend/app/
├── main.py            # la app FastAPI: middlewares + routers
├── api/               # capa endpoint (HTTP)
├── domain/            # capa service (negocio) + dtos
├── persistence/       # capa repository (SQL) + models
├── core/              # infraestructura: settings, logging, database, auth
└── agents/            # el/los agente(s) — aislados del resto
infra/                 # docker-compose.yml
frontend/              # React + Vite
Makefile               # shortcuts desde la raíz
```

---

## Paso 2 — Gestor de paquetes: uv + `pyproject.toml`

**Por qué:** el `pyproject.toml` es el archivo donde declaras qué librerías necesita el proyecto.
`uv` las instala muy rápido y deja un lockfile (versiones exactas fijadas, para reconstruir igual
en cualquier máquina). Dependencias base: FastAPI, SQLAlchemy (hablar con la BD), asyncpg (driver
que conecta Python con Postgres de forma async), Alembic (migraciones de la BD), pydantic +
pydantic-settings (config).

**📋 Código a copiar — `backend/pyproject.toml`:**
```toml
[project]
name = "agent-stack"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.109.0",
    "uvicorn[standard]>=0.27.0",        # el servidor que corre FastAPI
    "sqlalchemy[asyncio]>=2.0.25",      # ORM (mapea tablas SQL a clases Python)
    "asyncpg>=0.29.0",                  # driver async Python <-> Postgres
    "alembic>=1.13.0",                  # migraciones de la BD
    "pydantic>=2.5.0",
    "pydantic-settings>=2.1.0",         # carga config desde .env con validación
]

[project.optional-dependencies]
dev = [
    "ruff>=0.1.11",     # linter + formateador (revisa y ordena el código)
    "mypy>=1.8.0",      # type checker (verifica los tipos)
    "pytest>=7.4.4",    # framework de tests
    "httpx>=0.26.0",    # cliente HTTP, también para testear la API
]

[tool.ruff]
line-length = 100
fix = true

[tool.ruff.lint]
select = ["E", "F", "W", "C", "N", "B", "I"]  # categorías de errores a vigilar
ignore = ["E501"]  # el formateador maneja el largo de línea

[tool.mypy]
python_version = "3.11"
strict = true
disallow_untyped_defs = true  # toda función debe llevar type hints

[tool.pytest.ini_options]
asyncio_mode = "auto"   # los tests async no necesitan decorador
testpaths = ["tests"]
```

> 🔜 En recetas futuras se agregan: `python-jose` + `itsdangerous` (auth, receta 03),
> `openai-agents` + `openai` + `tenacity` (agentes, receta 04), y los paquetes de Phoenix
> (observabilidad, en una receta futura).

Luego: `cd backend && uv sync` (crea el entorno y el lockfile).

> ⚠️ Hazlo **antes** de `make dev`. El `Dockerfile` (Paso 7) instala con `uv sync --frozen`, que
> exige que el `uv.lock` ya exista; si no, el build del backend falla. (Verificado: sin `uv.lock`
> el `docker build` se cae.)

---

## Paso 3 — Config centralizada (`core/settings.py`) — **fail fast**

**Por qué:** una sola fuente de verdad para toda la config, leída desde variables de entorno y
del archivo `.env`. Si un validator (chequeo que verifica que un valor sea válido al cargar)
falla, **la app no arranca** — mejor que explote al inicio y no a mitad de una petición en
producción.

**📋 Código a copiar — `backend/app/core/settings.py`:**
```python
from typing import Literal

from pydantic import PostgresDsn, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    """Config de la app con validación y tipos."""

    model_config = SettingsConfigDict(
        env_file=".env",          # también lee del archivo .env
        case_sensitive=False,     # DATABASE_URL o database_url da igual
        extra="ignore",           # variables de más en el .env -> se ignoran
    )

    # Entorno
    env: Literal["dev", "staging", "prod"] = "dev"
    debug: bool = False

    # API
    api_title: str = "Agent Stack Backend"
    api_version: str = "0.1.0"

    # Base de datos (obligatoria: sin default -> la app no arranca si falta)
    database_url: PostgresDsn
    database_pool_size: int = 10       # conexiones reutilizables abiertas
    database_max_overflow: int = 20    # conexiones extra bajo carga

    # CORS: quién puede llamar a la API desde el navegador
    cors_origins: list[str] = ["http://localhost:5173"]

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, v: PostgresDsn) -> str:
        if not str(v).startswith("postgresql"):
            raise ValueError("DATABASE_URL debe usar PostgreSQL (postgresql+asyncpg://)")
        return str(v)

    @property
    def is_development(self) -> bool:
        return self.env == "dev"

settings = Settings()  # se crea una sola vez al importar (singleton)
```

**Orden de prioridad al rellenar cada campo:** (1) variables de entorno del sistema → (2) archivo
`.env` → (3) el default de la clase. Por eso en producción Docker/Kubernetes inyecta variables
que pisan el `.env` sin editar archivos.

> 🔜 Más adelante esta clase crece con campos de OpenAI (receta 04), Auth0 + cookie (receta 03)
> y Phoenix (en una receta futura), cada uno con su validator.

**📋 Código a copiar — `backend/.env`** (nunca lo subas a git):
```bash
DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/agent_stack
ENV=dev
CORS_ORIGINS=["http://localhost:5173"]
```

---

## Paso 4 — Conexión a la base de datos (`core/database.py`)

**Por qué:** aquí se crea el `engine` (la "interfaz de red" hacia Postgres, que administra un
pool = bolsa de conexiones reutilizables) y la función `get_db`, que entrega una sesión de BD a
cada petición y **es la dueña de la transacción**: hace `commit` (confirmar cambios) si todo sale
bien, o `rollback` (deshacer) ante cualquier error.

**📋 Código a copiar — `backend/app/core/database.py`:**
```python
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.settings import settings

# Motor: administra las conexiones y ejecuta el SQL
engine = create_async_engine(
    settings.database_url,
    echo=settings.is_development,            # en dev, loguea el SQL
    pool_size=settings.database_pool_size,
    max_overflow=settings.database_max_overflow,
    pool_pre_ping=True,                      # verifica la conexión antes de usarla
)

# Fábrica de sesiones: crea una AsyncSession nueva por petición
SessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,   # no invalida los objetos tras el commit
)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Inyecta una sesión y es dueña de la transacción."""
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()    # confirma si todo salió bien
        except Exception:
            await session.rollback()  # deshace ante cualquier error
            raise
        finally:
            await session.close()     # devuelve la conexión al pool
```

---

## Paso 5 — Logging estructurado + request id (`core/logging.py`)

**Por qué:** un `JsonFormatter` (hace que cada log salga como una línea de JSON, fácil de buscar
y filtrar) y un `RequestIdMiddleware` (middleware = código que envuelve cada petición, antes y
después de tu endpoint). Este le pone un `x-request-id` único a cada petición y lo propaga a
todos los logs usando un `ContextVar` (variable que "viaja" sola por toda la petición, incluso
entre funciones async, sin pasarla a mano). Es lo que en producción te deja seguir el rastro de
una petición completa.

**📋 Código a copiar — `backend/app/core/logging.py`:**
```python
from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# El request_id "viaja" implícito por todo el request (incluido código async)
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

class JsonFormatter(logging.Formatter):
    """Cada log -> una línea JSON (structured logging)."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid:
            payload["request_id"] = rid
        for key, value in getattr(record, "extra_fields", {}).items():
            payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)

def configure_logging(level: int = logging.INFO) -> None:
    """Instala el JsonFormatter en el root logger. Llamar una vez al startup."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)  # baja el ruido

configure_logging()  # side-effect al importar

class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        token = request_id_var.set(request_id)        # cuelga la "mochila"
        start = time.perf_counter()
        try:
            response: Response = await call_next(request)   # deja pasar la petición
        finally:
            duration_ms = round((time.perf_counter() - start) * 1000, 1)

        response.headers["x-request-id"] = request_id      # devuelve el id al cliente
        logging.getLogger("http").info(
            "http_request",
            extra={"extra_fields": {
                "event": "http_request",
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            }},
        )
        request_id_var.reset(token)   # descuelga la "mochila" (higiene)
        return response
```

---

## Paso 6 — La app FastAPI + health check (`main.py`)

**Por qué:** el punto de entrada. Crea la `app`, registra los middlewares y expone un `/health`
que **verifica que la BD responde** (no solo que el proceso vive). Recuerda: los middlewares
corren en **orden inverso** al que los agregas (capas de cebolla — el último agregado toca la
petición primero).

**📋 Código a copiar — `backend/app/main.py`:**
```python
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.logging import RequestIdMiddleware  # también dispara configure_logging()
from app.core.settings import settings

app = FastAPI(title=settings.api_title, version=settings.api_version, debug=settings.debug)

# CORS: permite que el frontend (otro origen) llame al backend desde el navegador
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,   # ["http://localhost:5173"]
    allow_credentials=True,                # deja viajar cookies
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestIdMiddleware)    # x-request-id + logging por petición

@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Health check con prueba de conexión a la BD."""
    try:
        await db.execute(text("SELECT 1"))   # ¿la BD contesta?
        database_status = "connected"
    except Exception as e:
        database_status = f"error: {e}"
    return {"status": "ok", "env": settings.env, "database": database_status}
```

> 🔜 Más adelante `main.py` registra routers (`app.include_router(...)`) para sesiones, mensajes,
> auth, streaming (recetas 02–04) y agrega el `TimeoutMiddleware` y el arranque de Phoenix.

### 🔌 Cómo se conecta `core/logging.py` con la app

Esta conexión es sutil porque pasan **dos cosas distintas**: una al *importar* el archivo, otra en
*cada petición*. Vale la pena entenderla bien.

**Conexión 1 — al importar (un "side-effect").** Cuando Python importa un módulo, ejecuta **todo
el archivo de arriba a abajo, una sola vez**. En `main.py` tenemos:
```python
from app.core.logging import RequestIdMiddleware  # también dispara configure_logging()
```
`core/logging.py` tiene, fuera de toda función, esta línea suelta:
```python
configure_logging()  # side-effect al importar
```
Eso es un *side-effect* (efecto colateral: algo que ocurre solo por importar el archivo, sin
llamar a la función a propósito). O sea: **el solo `import` ya configura el logging de toda la
app** (instala el `JsonFormatter` en el logger raíz). Por eso el comentario en `main.py` avisa
"también dispara configure_logging()": sin ese aviso, alguien podría borrar el import creyendo que
no se usa y apagar el logging sin querer.

**Conexión 2 — registrar el middleware.** Más abajo:
```python
app.add_middleware(RequestIdMiddleware)
```
`add_middleware` recibe la **clase** (no una instancia) y le dice a FastAPI que envuelva **cada
petición** con ese middleware.

**El pegamento interno — el `ContextVar`.** El middleware y el formateador JSON **nunca se llaman
entre sí**; se comunican a través de la variable compartida `request_id_var`, como un buzón:

```
RequestIdMiddleware.dispatch:
    request_id_var.set(id)   ← ESCRIBE el id en el buzón
         await call_next()         (corre el endpoint, services, etc.)
                                    cualquier logger.info(...)
                                       └─► JsonFormatter.format() hace request_id_var.get()
                                              ← LEE el mismo buzón y mete el id en el JSON
    request_id_var.reset()   ← limpia el buzón al terminar
```

La clave de usar un `ContextVar` (y no una variable global normal) es que **cada petición tiene su
propia copia aislada**: aunque haya 100 peticiones a la vez en código async, cada log lleva el
`request_id` de *su* petición, sin mezclarse.

##### ¿Qué significa "escribir/leer en el buzón"?

"Escribir el id en el buzón" es, literalmente, esta línea del middleware:
```python
token = request_id_var.set(request_id)
```
`.set(...)` **mete un valor en la caja** (`request_id_var`). Una vez metido, **cualquier código que
corra después en la misma petición lo saca** con `.get()`, sin que tú se lo pases como parámetro:

```python
# Sin ContextVar tendrías que arrastrar el id por TODAS las funciones (❌):
async def list_sessions(request_id):
    return await session_service.list(request_id)   # pásalo...
async def list(request_id):
    logger.info("query", request_id=request_id)     # ...para usarlo acá

# Con ContextVar lo escribes 1 vez y lo lees donde quieras (✅):
request_id_var.set(request_id)   # el middleware, una sola vez
logger.info("query")             # el JsonFormatter saca el id solo, con .get()
```
El `token` que devuelve `.set()` es un "recibo" para limpiar el buzón al final con `.reset(token)`
(higiene: como las conexiones se reutilizan, evita que la próxima petición herede un id viejo).

##### ¿Dónde vive ese valor? (no en el `request`)

Importante: el `ContextVar` **no le agrega nada al objeto `request`** (queda intacto). El valor vive
en el **"contexto" de Python** (módulo `contextvars`), atado a la **tarea async (Task) que atiende
esa petición**:

- `request_id_var` es **un solo objeto global** (la "caja"), creado una vez al importar el módulo.
- Pero el **valor** que guarda es **por-tarea**: uvicorn atiende cada petición en su propia Task de
  asyncio, y cada Task tiene su **propia copia del contexto**. Es como la memoria local de hilo
  (thread-local), pero para tareas async. La caja es la misma; el contenido es de cada quien.

```
request_id_var  ← UN objeto global (la "caja")
     ├─ contexto de la petición A:  "aaa-111"
     ├─ contexto de la petición B:  "bbb-222"
     └─ contexto de la petición C:  "ccc-333"   (cada Task lee/escribe SU copia)
```

Para que quede claro qué se modifica y qué no:
- **al objeto `request`** → nada;
- **al `ContextVar`** → el valor (invisible, "al costado", en el contexto de la Task);
- **a la respuesta** → sí, el header `x-request-id` (paso aparte, no el ContextVar);
- **a cada log** → el `request_id`, que el `JsonFormatter` saca del ContextVar con `.get()`.

**Resumen:** `main.py` se conecta con `core/logging.py` de dos formas — el `import` que dispara la
configuración global (side-effect), y el `add_middleware` que activa el rastreo por petición. El
`ContextVar` es el buzón que une al middleware (escribe) con el formateador JSON (lee), y vive en el
contexto de la tarea async, no en el `request`.

### 🧱 Los middlewares en detalle

La app real registra **tres** middlewares. Ya vimos el `RequestIdMiddleware` (arriba). Acá van los
otros dos.

#### `CORSMiddleware` — parámetro por parámetro

CORS es la regla **del navegador** que bloquea llamadas entre orígenes distintos (front en `:5173`,
backend en `:8000` → distinto puerto = distinto origen). Este middleware le dice al navegador qué
está permitido, agregando headers de permiso a la respuesta. Cada parámetro controla un permiso:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,   # ① quién puede llamarte
    allow_credentials=True,                # ② ¿pueden viajar cookies/credenciales?
    allow_methods=["*"],                   # ③ qué métodos HTTP se permiten
    allow_headers=["*"],                   # ④ qué headers puede mandar el cliente
)
```

- **① `allow_origins=["http://localhost:5173"]` — la lista blanca.** Compara el header `Origin` de
  la petición contra esta lista; si coincide, agrega `Access-Control-Allow-Origin` a la respuesta.
  En producción pondrías tu dominio real.
- **② `allow_credentials=True` — deja viajar las credenciales** (cookies + header `Authorization`).
  Por defecto el navegador NO manda cookies cross-origin; con esto sí. **Imprescindible para tu
  auth.**
  > ⚠️ **Gotcha:** si `allow_credentials=True`, **no puedes usar `allow_origins=["*"]`**. La spec lo
  > prohíbe (sería un agujero de seguridad). Por eso la lista es explícita, no `*`.
- **③ `allow_methods=["*"]` — los verbos permitidos** (`GET`, `POST`, `DELETE`…). `"*"` = todos. Va
  en la respuesta del *preflight* como `Access-Control-Allow-Methods`.
- **④ `allow_headers=["*"]` — los headers que el cliente puede mandar** (ej. `Authorization`,
  `Content-Type`). `"*"` = todos. Si no incluyera `Authorization`, el navegador bloquearía tus
  llamadas con JWT.

Resumen: ① *de dónde*, ② *con credenciales o no*, ③ *con qué métodos*, ④ *con qué headers* — el
"contrato" que el navegador exige para dejar pasar llamadas cross-origin.

#### `TimeoutMiddleware` — el cortacircuitos

> 🔜 Este es el tercer middleware (vive en `app/api/middleware/timeout.py`). No es estrictamente del
> foundation, pero lo dejamos documentado aquí porque se registra junto a los otros en `main.py`.

Corta cualquier petición que tarde más de 60 s, para que un request colgado no ocupe recursos para
siempre (red de seguridad). Se registra pasándole el parámetro: `app.add_middleware(TimeoutMiddleware, timeout=60)`.

```python
import asyncio
import json   # ← necesario para el mensaje de error (la app real lo omitía: bug corregido)

class TimeoutMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, timeout: int = 60):
        super().__init__(app)
        self.timeout = timeout

    async def dispatch(self, request, call_next):
        try:
            return await asyncio.wait_for(call_next(request), timeout=self.timeout)
        except asyncio.TimeoutError:
            return StreamingResponse(
                iter([f"event: error\ndata: {json.dumps({'message': 'Request timeout'})}\n\n"]),
                media_type="text/event-stream",
            )
```

- `asyncio.wait_for(coro, timeout=60)` → corre el resto de la cadena + tu endpoint **con un
  cronómetro**. Si termina antes, devuelve su resultado normal.
- Si se pasa de 60 s, lanza `asyncio.TimeoutError`; el `except` devuelve un error **en formato SSE**
  (este middleware está pensado sobre todo para los endpoints de streaming).

**Orden de los tres** (recuerda: se ejecutan en orden **inverso** al que se agregan):
```python
app.add_middleware(CORSMiddleware, ...)            # se agrega 1° → corre último (más adentro)
app.add_middleware(TimeoutMiddleware, timeout=60)  # se agrega 2° → corre en el medio
app.add_middleware(RequestIdMiddleware)            # se agrega 3° → corre primero (más afuera)
```

---

## Paso 7 — Docker: imagen del backend + Compose

**Por qué:** el `Dockerfile` es la receta para construir la imagen (molde inmutable) del backend.
El `docker-compose.yml` levanta los servicios juntos: `db` (Postgres) + `backend` + `frontend`.
El hot-reload (recarga al guardar) se logra montando tu código como *volumen* (carpeta compartida
entre tu máquina y el container).

> **Docker layer caching:** lo que cambia más seguido va **al final**. Por eso se copian primero
> las dependencias (cambian poco) y el código después (cambia siempre): el paso lento de instalar
> se reutiliza entre builds.

**📋 Código a copiar — `backend/Dockerfile`:**
```dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc curl \
 && rm -rf /var/lib/apt/lists/*

# 1) Dependencias primero (capa cacheable: cambian poco)
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev

# 2) Código después (cambia siempre)
COPY app/ ./app/

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**📋 Código a copiar — `infra/docker-compose.yml`:**
```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: agent_stack
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:                                   # ¿la BD está lista?
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    build:
      context: ../backend
      dockerfile: Dockerfile
    ports:
      - "8000:8000"
    env_file:
      - ../backend/.env
    volumes:
      - ../backend/app:/app/app:ro                 # hot-reload (":ro" = solo lectura)
    depends_on:
      db:
        condition: service_healthy                 # espera a que la BD esté lista
    environment:
      - DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/agent_stack
      - ENV=dev
    command: uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  frontend:
    build:
      context: ../frontend
      dockerfile: Dockerfile
    ports:
      - "5173:5173"
    volumes:
      - ../frontend:/app
      - node_modules:/app/node_modules             # deps adentro del container
    depends_on:
      - backend
    environment:
      - VITE_API_URL=http://localhost:8000
    command: sh -lc "npm ci && npm run dev -- --host 0.0.0.0"

volumes:
  postgres_data:
  node_modules:
```

> 🔜 Una receta futura agrega el servicio `phoenix` y sus variables de entorno.

---

## Paso 8 — Makefile: un comando para gobernarlos a todos

**Por qué:** atajos para no recordar comandos largos de Docker.

> ⚠️ Corre `make` **siempre desde la raíz** del proyecto, no desde `infra/`.

**📋 Código a copiar — `Makefile`** (en la raíz; ojo: las indentaciones son TABS, no espacios):
```makefile
.PHONY: help dev up down logs clean

help:
	@echo "dev / up / down / logs / clean"

dev:                         ## Levanta todo en segundo plano
	cd infra && docker compose up -d

up:                          ## Levanta todo con logs a la vista
	cd infra && docker compose up

down:                        ## Detiene todo
	cd infra && docker compose down

logs:                        ## Sigue los logs de todos los servicios
	cd infra && docker compose logs -f

clean:                       ## Limpia caches de Python
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
```

---

## Paso 9 — Frontend scaffold (Vite + TypeScript)

**Por qué:** el frontend **no se escribe a mano**. Vite (la herramienta de build/dev del front)
trae un generador que crea toda la base — `package.json`, `index.html`, `src/main.tsx`,
`src/App.tsx`, `tsconfig.json` y `vite.config.ts` — lista para correr. Para Part 1 con eso basta;
la UI real del chat la construimos más adelante en la serie.

**📋 Código a copiar — generar el scaffold (desde la carpeta `frontend/`):**
```bash
cd frontend
npm create vite@latest . -- --template react-ts   # crea la base React + TypeScript
npm install                                        # instala dependencias (genera package-lock.json)
```
Esto te deja la estructura por defecto de Vite:
```
frontend/
├── src/ (App.tsx, main.tsx, index.css, ...)
├── index.html            # punto de entrada HTML
├── package.json          # dependencias
├── tsconfig.json
└── vite.config.ts
```

**📋 Ajuste recomendado — `frontend/vite.config.ts`:** reemplaza el generado para (1) escuchar en
toda la red (accesible desde Docker) y (2) habilitar el alias `@ → ./src` (atajo para importar
`@/components/...` en vez de rutas relativas largas).
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },  // atajo de import
  },
  server: {
    host: '0.0.0.0',  // escucha en toda la red -> accesible desde Docker
    port: 5173,
  },
})
```
Si quieres que TypeScript también entienda el alias `@`, agrega en `tsconfig.app.json` (dentro de
`compilerOptions`): `"baseUrl": ".", "paths": { "@/*": ["./src/*"] }`.

**📋 Código a copiar — `frontend/Dockerfile`** (lo necesita el servicio `frontend` del Compose):
```dockerfile
FROM node:20-alpine

WORKDIR /app

# Dependencias primero (capa cacheable)
COPY package*.json ./
RUN npm ci

# Código después
COPY . .
RUN npm run build           # compila para producción (genera dist/)

EXPOSE 5173
# En dev, docker-compose sobreescribe este CMD con "npm run dev"
CMD ["npm", "run", "preview", "--", "--host", "--port", "5173"]
```

> 💡 Notas: `node:20-alpine` es una imagen mínima (~120 MB vs ~1 GB). `npm ci` (clean install)
> instala las versiones exactas del `package-lock.json` y es más rápido/reproducible que
> `npm install` — por eso se usa en containers. El `Dockerfile` está escrito para producción
> (build optimizado), pero en `docker-compose.yml` se sobreescribe el comando para correr el
> servidor de desarrollo con hot-reload.

---

## Conceptos clave de esta parte

- **Imagen vs container:** la imagen es la receta (un molde inmutable); el container (contenedor)
  es el plato ya cocinado y corriendo. De una misma imagen salen muchos containers idénticos.
- **Docker layer caching** (caché por capas): un Dockerfile se arma en capas y Docker reutiliza
  las que no cambiaron → por eso dependencias primero, código después.
- **`credentials: include` en fetch:** opción de `fetch` (la función del navegador para llamar al
  backend) que dice "manda también las cookies". Se centraliza en `frontend/src/api/client.ts`
  para que ningún endpoint olvide mandar las cookies del SSE (lo verás en la receta 03).

## Gotchas (errores comunes)

| Síntoma | Causa | Fix |
|---|---|---|
| `ModuleNotFoundError: app.core.settings` | módulo mencionado antes de crearse / falta `__init__.py` | crear el archivo + `__init__.py` |
| `make migrate-create` se cuelga | `read -p` interactivo no corre en subshells de Make | pasar `msg="..."` como parámetro |
| `make: target no encontrado` | corriste `make` desde `infra/` | correr desde la raíz |
| El Makefile no corre | usaste espacios en vez de TABS para indentar | reemplazar por TABS |

## Checklist de "foundation lista"

- [ ] `make dev` levanta los 3 servicios sin error
- [ ] `GET /health` responde `{"status":"ok", "database":"connected"}`
- [ ] Cambiar un `.py` recarga el backend sin rebuild (hot-reload)
- [ ] Los logs salen como JSON con `request_id`
- [ ] La app **no arranca** si falta una env var obligatoria (fail fast)

---

## Recapitulemos desde otra perspectiva... ¿en qué orden corre todo?

Separemos dos niveles que suelen confundirse: **(A)** lo que *tú* corres, y **(B/C/D)** lo que pasa
*adentro* cuando arranca.

### Nivel A — Lo que tú corres (1 comando)

```bash
make dev
```

Eso es todo. Ese target hace `cd infra && docker compose up -d` (el `-d` = *detached*: corre en
segundo plano). A partir de ahí, Docker Compose toma el control.

### Nivel B — Lo que hace Docker Compose, en orden

Compose lee `infra/docker-compose.yml` y levanta los 3 servicios respetando dependencias:

1. **Construye las imágenes** (si no existen): ejecuta los `Dockerfile` → corre `uv sync` (deps de
   Python) y `npm ci` (deps del front). Solo la primera vez o si algo cambió (layer caching).
2. **Crea la red y arranca la base de datos (`db`) primero.** ¿Por qué primero? Porque el backend
   depende de ella:
   ```yaml
   backend:
     depends_on:
       db:
         condition: service_healthy   # espera a que la BD esté SANA, no solo "arrancada"
   ```
   `service_healthy` espera a que pase el `healthcheck` de la db (`pg_isready`), que confirma que
   Postgres **acepta conexiones**. Sin esto, el backend arrancaría antes de tiempo y reventaría.
3. **Arranca el `backend`** (cuando la db está sana): ejecuta
   `uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload`. Aquí empieza el Nivel C.
4. **Arranca el `frontend`** (depende del backend): corre `npm run dev` (servidor de Vite).

```
make dev → build imágenes → red → db (healthcheck) SANA → backend (uvicorn) → frontend (vite)
```

### Nivel C — Qué pasa adentro del backend al arrancar

uvicorn (el servidor que corre FastAPI) necesita el objeto `app`. Para conseguirlo **importa
`app/main.py`, y Python ejecuta ese archivo de arriba a abajo, una sola vez.** Ese recorrido ES el
orden de arranque:

1. **Se ejecutan los imports** (y sus *side-effects*):
   - `import ...logging` → dispara `configure_logging()` → **logging JSON instalado**.
   - `import ...settings` → construye `settings = Settings()` → **lee el `.env` + validators**. Si
     falta una variable obligatoria, **la app muere aquí** (*fail fast*).
   - `import ...database` → crea el `engine` (interfaz hacia Postgres). Crear el engine **no abre
     conexiones todavía**; solo prepara el pool.
2. **Se crea el objeto** `app = FastAPI(...)`.
3. **Se registran los middlewares** (y el orden importa: se ejecutan en orden **inverso** al que
   se agregan — capas de cebolla).
4. **Se registran las rutas** (en foundation, solo `/health`).
5. **uvicorn empieza a escuchar** en el puerto 8000. **Listo.** (Nadie tocó la BD todavía.)

```
uvicorn carga app.main:app
   └─ ejecuta main.py de arriba a abajo:
        import logging   → configure_logging()  (logging JSON listo)
        import settings  → lee .env + validators (fail fast)
        import database  → crea el engine (sin conectar aún)
        app = FastAPI(...)
        add_middleware(CORS), add_middleware(RequestId)
        @app.get("/health")
   └─ uvicorn escucha en :8000  → LISTO
```

### Nivel D — Qué pasa en la primera petición (`GET /health`)

Recordemos el handler:
```python
@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    await db.execute(text("SELECT 1"))
    return {"status": "ok", ...}
```

**1. Llega `GET /health`** a la "puerta" (el objeto `app`). Un *request* es el mensaje HTTP: un
**método** (`GET`), una **ruta** (`/health`), unos **headers** (cabeceras clave-valor) y a veces un
**body**.

**2. Pasa por los middlewares** (cebolla, de afuera hacia adentro): primero `RequestIdMiddleware`,
luego `CORSMiddleware` (ver el detalle de tagging y CORS más abajo).

**3. El router hace match:** `GET` + `/health` → la función `health`.

**4. FastAPI resuelve `Depends(get_db)` ANTES de correr `health`.**
   - `get_db` es un **generador async** (función con `yield`: produce un valor, se pausa, y
     continúa después). FastAPI lo corre **hasta el `yield`**, agarra el `session` que produce, y
     lo **inyecta** como el parámetro `db`. El resto de `get_db` (el `commit`) queda *en pausa*.
   - `SessionLocal()` crea la **sesión** (el objeto con el que se habla a la BD en esta petición).
   - Hasta aquí **todavía no hay conexión real**: la sesión saca una conexión del **pool** (bolsa
     de conexiones ya abiertas y reutilizables) recién al primer query. ¿Por qué un pool? Abrir una
     conexión a Postgres (TCP + login) es lento; mejor tener varias abiertas y reusarlas.

**5. `health` corre y ejecuta `SELECT 1`.**
   - `text("SELECT 1")` envuelve SQL crudo para ejecutarlo tal cual.
   - `await db.execute(...)` **saca una conexión del pool** (aquí sí se conecta a Postgres) y manda
     el query. `SELECT 1` no lee ninguna tabla: solo pide que la BD devuelva `1`. Su único fin es
     **probar que la BD está viva y responde**. Si responde → `"connected"`; si falla → el
     `try/except` lo atrapa y pone `"error: ..."` (por eso `/health` nunca revienta).
   - `health` arma y devuelve el `dict`.

**6. Se cierra la transacción y la conexión vuelve al pool.** Cuando `health` retorna, FastAPI
**reanuda `get_db`** después del `yield`:
   - `await session.commit()` → confirma la transacción (aunque solo leímos, cerrarla limpiamente
     es lo correcto). Si `health` hubiera lanzado un error, correría `session.rollback()` en su
     lugar — eso es *transaction ownership*: una sola pieza decide commit/rollback.
   - El `async with` termina → la sesión se cierra → **la conexión no se destruye, vuelve al pool**.

**7. La respuesta sube de vuelta por los middlewares:** `RequestIdMiddleware` calcula la duración,
loguea la línea `http_request` (con el `request_id`) y pega el header `x-request-id`.

**8. El cliente recibe** `{"status":"ok","database":"connected"}`.

### Cómo se identifica y se "taggea" el request (y qué hace CORS)

**¿Qué es exactamente `x-request-id`?** Es un **header HTTP** (cabecera: un par `nombre: valor` que
viaja con la petición y la respuesta, fuera del cuerpo). Su valor es un **identificador único por
petición** — una "matrícula" para rastrear ese viaje. El prefijo `x-` marcaba históricamente un
header **no oficial**: `x-request-id` **no es un estándar de HTTP**, es una **convención de-facto**
(la usan nginx, Heroku, muchos frameworks). Para qué sirve: en producción, con miles de peticiones
mezclando logs, le pones la misma matrícula a todos los logs de una petición y luego buscas por ese
id para ver **solo ese viaje completo**. Y entre varios servicios (microservicios), el id se
propaga de uno a otro → puedes seguir un request que cruzó 5 servicios como un solo hilo
(*distributed tracing*).

**Cómo se taggea (el `request_id`):** lo hace el `RequestIdMiddleware`:
1. Mira si el cliente ya mandó un header `x-request-id` (pasaría si otro servicio te llama y quiere
   rastrear el mismo "hilo" de punta a punta).
2. Si no vino, **genera uno nuevo** con `uuid4()` (string aleatorio casi único).
3. Ese id es la **etiqueta** de la petición: se guarda en el `ContextVar` para que **todos los logs
   la lleven**, y se devuelve en el header `x-request-id` de la respuesta, para que puedas
   correlacionar "esta respuesta" con "estas líneas de log del servidor".

**Por qué CORS la acepta (y qué hace realmente):** CORS es una regla **del navegador**, no del
servidor. El navegador prohíbe por defecto que una página de un origen (`http://localhost:5173`)
llame a un servidor de otro origen (`http://localhost:8000`) — distinto puerto = distinto origen.
El `CORSMiddleware`:
1. Mira el header `Origin` (el navegador lo pone solo: "vengo de `http://localhost:5173`").
2. Lo compara contra tu lista `allow_origins`. Si está, **agrega a la respuesta** el header
   `Access-Control-Allow-Origin` (+ `Allow-Credentials` si configuraste credenciales).
3. El **navegador** lee ese permiso: si está, deja que tu JavaScript vea la respuesta; si no, el
   servidor igual procesó la petición pero el navegador **bloquea** que el JS lea el resultado.

Dos matices:
- **`curl` no manda `Origin`** → CORS no le aplica (solo protege navegadores). Por eso tus pruebas
  con `curl` funcionan sin tocar CORS.
- Para peticiones "no simples" (con `Authorization` o `Content-Type: application/json`), el
  navegador manda primero un **preflight**: un `OPTIONS` que pregunta "¿me dejas?". El
  `CORSMiddleware` lo responde directo, sin molestar a tu endpoint.

**En una frase:** `make dev` → Docker levanta **db (sana) → backend → frontend**; dentro del
backend, uvicorn **importa `main.py`** y eso configura logging, lee settings, crea el engine, arma
el `app` con middlewares y rutas, y se pone a escuchar; **la BD se conecta de verdad recién en la
primera petición**.

---

## Dónde quedan los logs y cómo debuggear

### ¿Dónde quedan los logs?

En esta app los logs **no van a un archivo**: van a **stdout** (la salida estándar del proceso). El
handler en `core/logging.py` es `logging.StreamHandler(sys.stdout)`. Es a propósito (principio
*12-factor app*: la app escribe a stdout y deja que la plataforma —Docker, Kubernetes— los
recolecte). Como el backend corre en un container, **Docker captura ese stdout**:

```bash
make logs                                     # todos los servicios, en vivo
cd infra && docker compose logs -f backend    # solo el backend (-f = "follow")
```

### Cómo debuggear

1. **Logs en vivo:** `make logs` y reproduce el error. Cada línea es JSON con su `request_id`.

2. **Aísla una petición por su `request_id`** (sácalo del header `x-request-id` de la respuesta):
   ```bash
   cd infra && docker compose logs backend | grep "82087962-b73b-..."
   ```
   Ves solo el viaje de esa petición (entró → query → error → respuesta).

3. **Lee el JSON bonito con `jq`** (herramienta para procesar JSON en la terminal). Docker antepone
   `backend-1 | ` a cada línea, así que usa `--no-log-prefix`:
   ```bash
   cd infra && docker compose logs -f --no-log-prefix backend | jq 'select(.status >= 500)'
   ```

4. **Mira el SQL real:** en dev, el engine usa `echo=settings.is_development`, así que **cada query
   SQL aparece en los logs**. Si la BD anda rara, ves la query exacta.

5. **`/health` y `/docs`:** `GET /health` dice si la BD responde; `http://localhost:8000/docs`
   (Swagger) te deja **probar cada endpoint a mano** desde el navegador.

6. **¿La app no arranca?** Por el *fail fast*, el error sale al tope de `docker compose logs
   backend`: casi siempre un validator de settings (falta una env var) o un `ModuleNotFoundError`
   (falta un `__init__.py`).

7. **Métete al container a hurgar:**
   ```bash
   cd infra && docker compose exec backend sh            # shell dentro del container
   cd infra && docker compose exec backend uv run python # REPL de Python con tus módulos
   cd infra && docker compose ps                         # ¿qué containers están arriba/sanos?
   ```

8. **Hot-reload:** como el código está montado como volumen y uvicorn corre con `--reload`, guardas
   un `.py` y se recarga solo; un error de sintaxis/import aparece de inmediato en los logs.
