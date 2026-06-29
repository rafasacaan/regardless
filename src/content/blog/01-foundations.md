---
title: "Construyendo a hey-frank #1 — Arrancando desde cero"
fecha: 2026-06-04
tipo: "hey frank"
resumen: "Construyendo la casa para los agentes: Docker, FastAPI y /health."
draft: false
---

> **Qué conseguimos al terminar:** el esqueleto de una app full-stack con un agente de IA —
> backend con FastAPI, base de datos en Postgres, todo orquestado con Docker, y una ruta `/health`
> que confirma que el sistema está vivo. Todavía nada "inteligente": solo los cimientos, paso a paso.
>
> **Crédito:** estas notas están fuertemente basadas en la serie *Building a Production-Ready Agent
> Stack* de **Bedir Tapkan** ([bedirtapkan.com](https://bedirtapkan.com)). El esqueleto y muchas de
> las decisiones de diseño vienen de sus artículos; yo los adapté a mi stack (Gemini/ADK + Firebase)
> y los reescribí a mi manera. Gracias, Bedir!

---

Me gustan las recetas. Esto es igual que cocinar: uno repite lo que le ha funcionado, los ingredientes, los cuchillos, los condimentos. Y a partir de ahí, uno prueba cosas nuevas. Siempre que parto un proyecto nuevo, me veo repitiendo patrones. Este es mi intento por recopilar las mejores prácticas y revisitarlas. Y aprovechar de esclarecer muchos conceptos de arquitectura que me veo nombrando y que nunca entendí del todo qué hacían.

Vamos a armar el esqueleto de una app full-stack con un agente de IA: el backend, la base de datos, Docker, y una ruta simple: `/health`. Al final de esto no hay nada "inteligente" todavía. Paciencia, que esto se construye paso a paso, y todas las piezas son importantes. Y perdón si me extiendo!

## Primera decisión: elegir el stack.

Estas son las piezas que elegí para este proyecto, y por qué cada una.

| Pieza | Elección | Por qué |
|---|---|---|
| Backend | FastAPI | async (atiende muchas peticiones a la vez sin bloquearse), tipado, y te regala la documentación OpenAPI (una página interactiva que lista y prueba tus endpoints) |
| Frontend | React + Vite + TS | no necesitamos SSR (armar el HTML en el servidor); Vite da el ciclo de desarrollo más rápido |
| Agente | Google ADK + Gemini | hecho para Python, async nativo, y de la mano con Gemini |
| Paquetes | uv | instala rapidísimo y deja un lockfile (un archivo que congela las versiones exactas, para que el proyecto se reconstruya igual en cualquier máquina) |
| Streaming | SSE (Server-Sent Events) | el servidor empuja datos al navegador en un solo sentido, se reconecta solo, y es más simple que WebSockets |
| Auth | Firebase Authentication | login con Google/email, refresh automático, consola de usuarios; gratis para uso normal |
| Base de datos | Postgres + asyncpg + SQLAlchemy | el mismo motor en desarrollo y producción, y cumple ACID (cada transacción es confiable: atómica, consistente, aislada y durable) |
| Infra local | Docker Compose | levantas todo con un comando, y se parece a producción |

Y una idea que ordena todo lo demás: **arquitectura hexagonal**. No tiene nada que ver con 6 lados, el nombre real es **Ports & Adapters**. Se basa en 3 piezas:
1. **El núcleo (core/dominio)**: 
  la lógica de negocio. No sabe nada del mundo exterior - ni de HTTP, ni de SQL, ni de LLMs.
2. **Puertos**: 
  los "contratos" o interfaces. Definen *qué* se puede hacer, no *cómo*. Hay de entrada y de salida.
3. **Adaptadores**: 
  la implementación concreta que conecta un puerto con una tecnología real (el adaptador de Postgres, de Firebase, de Gemini).

Y tiene dos lados:
- Driving: *quien usa* nuestra app (ej. API HTTP, una CLI, los tests)
- Driven: *lo que usa* nuestra app (la base de datos, una LLM)


> La máxima acá es: el *core* no depende de la infraestructura. El núcleo o core es el que define el port. Luego, se implementa el adapter según el contrato.

En los próximos posts, esto se verá como:
- Núcleo: los *services* + *models/dtos*
- Adaptadores de salida: los *repositories* (Postgres), *agents/* (Gemini/ADK), *auth* (Firebase).
- Adaptadores de entrada: los endpoints en *api/* (HTTP), y los tests.

Por eso los agentes viven aislados en *app/agents/*: son un adaptador, swappable. Y por eso la "regla de oro" del proyecto —el SQL no sale del repository, el HTTP no entra al service— es hexagonal en la práctica: estás manteniendo el núcleo limpio de los detalles de los bordes.


```
        SERVICIOS EXTERNOS
  (ej. Firebase, Gemini, Postgres)
        
        ↕  Ports & Adapters

        CORE de la APP
```

## El mapa completo — tenlo claro desde el principio

Esto es **todo lo que vamos a construir** a lo largo de las 4 recetas, ya ordenado por su rol en el
hexágono. No lo crearemos de golpe (cada archivo llega en su receta — abajo marco con `[02]`/`[03]`/
`[04]` cuál lo agrega), pero conviene tener el destino claro desde ahora: cuando construyas una pieza,
vas a saber *en qué capa vive y por qué*.

```
backend/app/
│
├── main.py                  ← punto de entrada: arma la app, middlewares, registra routers
│
├── api/                     🟢 ADAPTADORES DE ENTRADA (driving) — HTTP
│   ├── sessions.py             endpoints de sesiones            [02]
│   ├── messages.py             endpoints de mensajes            [02]
│   ├── auth.py                 login → cookie, /me              [03]
│   └── dependencies.py         get_session (inyecta la sesión)  [02]
│
├── domain/                  🔵 NÚCLEO — lógica de negocio (no sabe de HTTP ni SQL)
│   ├── dtos.py                 contratos de la API              [02]
│   └── services/
│       ├── session_service.py                                   [02]
│       ├── message_service.py                                   [02]
│       └── user_service.py     sub → user.id                    [03]
│
├── persistence/             🟠 ADAPTADOR DE SALIDA (driven) — Postgres
│   ├── models.py               modelos ORM (la forma de la BD)  [02]
│   └── repositories/
│       ├── session_repo.py                                      [02]
│       ├── message_repo.py                                      [02]
│       └── user_repo.py                                         [02]
│
├── agents/                  🟠 ADAPTADOR DE SALIDA (driven) — el LLM
│   └── (el agente Gemini/ADK, aislado y swappable)             [04]
│
└── core/                    ⚙️ INFRA transversal (no es negocio)
    ├── settings.py             config general (fail-fast)       [01]
    ├── database.py             engine + get_db (transacción)    [01]
    ├── logging.py              JSON logs + request_id           [01]
    ├── auth.py                 verificar token + firmar cookie  [03]
    └── cookies.py              atributos de cookie según entorno [03]
```

**La regla de oro, en una línea:**
```
api/ (HTTP)  →  domain/services/ (negocio)  →  persistence | agents (mundo externo)
                         ↑ devuelve DTOs
```
El SQL nunca sale de `persistence/`; el HTTP nunca entra a `domain/`. `core/` es plomería que todos
usan pero que no es negocio. Y los dos adaptadores de salida son intercambiables: `persistence/` habla
con Postgres, `agents/` hablará con el LLM — misma posición en el hexágono, distinta tecnología.

> En este foundation construyes solo lo marcado `[01]` (`main.py` + `core/` + las carpetas vacías).
> El resto del mapa son los lugares ya reservados para que cada receta siguiente sepa exactamente
> dónde poner su pieza.

---

## Paso 1 — Directorios

Construyamos un layout para organizar nuestra app. Cada carpeta tiene un solo trabajo, y eso significa que siempre sabemos dónde buscar algo y dónde ponerlo. No queremos enredos cuando nuestra app crezca.

Pequeño tip: crea siempre los `__init__.py` (archivos vacíos que le
dicen a Python "esta carpeta es un módulo"). Si no, Python te tira un `ModuleNotFoundError`.

Partamos corriendo los siguientes comandos desde la raíz del proyecto:
```bash
mkdir -p backend/app/{api,domain/services,persistence/repositories,core,agents}
mkdir -p infra frontend
find backend/app -type d -exec touch {}/__init__.py \;
```

El resultado es un *árbol* de carpetas que se ve así:
```
backend/app/
├── main.py            # la app FastAPI: middlewares + routers
├── api/               # capa endpoint (HTTP)
├── domain/            # capa service (negocio) + dtos
├── persistence/       # capa repository (SQL) + models
├── core/              # infraestructura: settings, logging, database, auth
└── agents/            # el/los agente(s), aislados del resto
infra/                 # docker-compose.yml
frontend/              # React + Vite
Makefile
```
Bien! Con esto ya tenemos el espacio de nuestra app cubierto.

---

## Paso 2 — uv y el pyproject

El `pyproject.toml` es donde declaramos qué librerías necesita el proyecto. `uv` las instala muy rápido
y deja un lockfile, que es lo que hace que en el futuro, en otra máquina, todo se reconstruya idéntico.

`backend/pyproject.toml`:
```toml
[project]
name = "hey-frank"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.109.0",
    "uvicorn[standard]>=0.27.0",        # el servidor que corre FastAPI
    "sqlalchemy[asyncio]>=2.0.25",      # ORM: mapea tablas SQL a clases Python
    "asyncpg>=0.29.0",                  # driver async entre Python y Postgres
    "alembic>=1.13.0",                  # migraciones de la BD
    "pydantic>=2.5.0",
    "pydantic-settings>=2.1.0",         # carga config desde .env con validación
]

[project.optional-dependencies]
dev = [
    "ruff>=0.1.11",     # linter y formateador
    "mypy>=1.8.0",      # type checker
    "pytest>=7.4.4",    # tests
    "httpx>=0.26.0",    # cliente HTTP, también para testear la API
]

[tool.ruff]
line-length = 100
fix = true

[tool.ruff.lint]
select = ["E", "F", "W", "C", "N", "B", "I"]
ignore = ["E501"]

[tool.mypy]
python_version = "3.11"
strict = true
disallow_untyped_defs = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

Más adelante se suman: `google-auth` + `requests` + `itsdangerous` (auth Firebase), `google-adk`
(el agente con Gemini), y los paquetes de observabilidad. Por ahora con esto basta.

Después: `cd backend && uv sync`, que crea el entorno y el lockfile. Hazlo antes de levantar Docker:
el Dockerfile instala con `uv sync --frozen`, que exige que el `uv.lock` ya exista. Si no está, el
build se cae.

---

## Paso 3 — La config en un solo lugar: *fail fast*

Una sola fuente de verdad para toda la configuración, leída desde variables de entorno y del archivo
`.env`. Lo importante acá es una idea que me gusta: *fail fast*. Si falta una variable o algo no
cuadra, la app **no arranca**. Falla al inicio con un mensaje claro.

`backend/app/core/settings.py`:
```python
from typing import Literal

from pydantic import PostgresDsn, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Config de la app, con validación y tipos."""

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,     # DATABASE_URL o database_url, da lo mismo
        extra="ignore",           # variables de más en el .env, se ignoran
    )

    env: Literal["dev", "staging", "prod"] = "dev"
    debug: bool = False

    api_title: str = "hey-frank"
    api_version: str = "0.1.0"

    # Obligatoria: sin default, si falta la app no arranca
    database_url: PostgresDsn
    database_pool_size: int = 10
    database_max_overflow: int = 20

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


settings = Settings()   # se crea una sola vez al importar
```

El orden en que rellena cada campo: primero las variables de entorno del sistema, después el `.env`,
y por último el default escrito en la clase. Por eso en producción Docker o Kubernetes pueden inyectar
variables que pisan el `.env` sin que toques un archivo.

Más adelante esta clase crece con campos de Firebase, Gemini y observabilidad. Cada uno con su
validator.

Y el `backend/.env` (que nunca, nunca, va a git):
```bash
DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/hey_frank
ENV=dev
CORS_ORIGINS=["http://localhost:5173"]
```

Aprovechemos de crear el `.gitignore` global en el *root*:
```bash
# === Secretos / entorno ===
.env
*.env
!.env.example          # plantilla, esta sí se versiona

# === Python (backend) ===
__pycache__/
*.pyc
.venv/
.mypy_cache/
.ruff_cache/
.pytest_cache/
# uv.lock SÍ se versiona (no lo ignores)

# === Node (frontend) ===
node_modules/
dist/
.vite/
# package-lock.json SÍ se versiona (no lo ignores)

# === Sistema / editor ===
.DS_Store
.idea/
.vscode/
*.log
```
---

## Paso 4 — La conexión a la base de datos

Acá creamos el `engine` (la interfaz hacia Postgres, que administra un *pool* de conexiones
reutilizables) y la función `get_db`, que le entrega una sesión a cada petición. Y un detalle: `get_db` es **la dueña de la transacción**. Confirma los cambios si todo salió bien,
o los deshace si algo falló. Es la pieza que decide. 

`backend/app/core/database.py`:
```python
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.settings import settings

engine = create_async_engine(
    settings.database_url,
    echo=settings.is_development,            # en dev, loguea el SQL
    pool_size=settings.database_pool_size,
    max_overflow=settings.database_max_overflow,
    pool_pre_ping=True,                      # verifica la conexión antes de usarla
)

SessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
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

## Paso 5 — Logs

Dos piezas:
- Un formateador que hace que cada log salga como una línea de JSON (fácil de buscar y filtrar), y 
- Un middleware que le asigna a cada petición un identificador único y lo arrastra por todos los logs de esa petición. Así, cuando algo falle en producción, vamos a poder seguir el rastro de *una* petición entre
muchas.

El truco para arrastrar ese *id* sin pasarlo de mano en mano a través de las funciones es un `ContextVar`: una variable que "viaja" sola por toda la petición, incluso entre funciones async.

`backend/app/core/logging.py`:
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

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


class JsonFormatter(logging.Formatter):
    """Cada log, una línea JSON."""

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
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)


configure_logging()   # corre solo al importar el módulo


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        token = request_id_var.set(request_id)
        start = time.perf_counter()
        try:
            response: Response = await call_next(request)
        finally:
            duration_ms = round((time.perf_counter() - start) * 1000, 1)

        response.headers["x-request-id"] = request_id
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
        request_id_var.reset(token)
        return response
```

Una cosa importante a notar: el `configure_logging()` corre **solo con importar el archivo** de *logging.py*. Así que el simple hecho de que `main.py` importe algo de acá ya deja
el logging configurado para toda la app. Por eso conviene no borrar ese import "que no se usa".

---

## Paso 6 — La app y un health 

El punto de entrada. Crea la `app`, registra los middlewares, y expone un `/health`que verifica que la base de datos **responde**. El proceso corriendo no sirve si la BD está caída.

`backend/app/main.py`:
```python
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.logging import RequestIdMiddleware   # esto también configura el logging
from app.core.settings import settings

app = FastAPI(
  title=settings.api_title, 
  version=settings.api_version, 
  debug=settings.debug
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,   # ["http://localhost:5173"]
    allow_credentials=True,                # deja viajar cookies
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestIdMiddleware)


@app.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    try:
        await db.execute(text("SELECT 1"))   # ¿la BD contesta?
        database_status = "connected"
    except Exception as e:
        database_status = f"error: {e}"
    return {"status": "ok", "env": settings.env, "database": database_status}
```

Un detalle: los middlewares corren en **orden inverso** al que los agregas. El último que agregas es el primero que toca la petición que entra.



Más adelante, `main.py` registra más routers (sesiones, mensajes, auth, streaming) y suma otros
middlewares. Por ahora, esto.

---

## Paso 7 — Docker: empaquetar el backend y levantar todo junto

El `Dockerfile` es la receta para construir la imagen del backend. El `docker-compose.yml` levanta los
servicios juntos: la base de datos, el backend y el frontend. El hot-reload —que cambies un archivo y
se recargue solo— se logra montando tu código como un *volumen*, una carpeta compartida entre tu
máquina y el contenedor.

Una idea que vale la pena interiorizar: en un Dockerfile, lo que cambia más seguido va al final.
Primero las dependencias (cambian poco), después el código (cambia siempre). Así el paso lento de
instalar se reutiliza entre builds y no esperas de más.

`backend/Dockerfile`:
```dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc curl \
 && rm -rf /var/lib/apt/lists/*

# Dependencias primero (capa cacheable)
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev

# Código después
COPY app/ ./app/

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`infra/docker-compose.yml`:
```yaml
name: hey-frank          # el nombre del proyecto Docker. No es opcional, ver la nota de abajo.

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: hey_frank
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
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
      - ../backend/app:/app/app:ro          # hot-reload (:ro = solo lectura)
    depends_on:
      db:
        condition: service_healthy          # espera a que la BD esté lista
    environment:
      - DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/hey_frank
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
      - node_modules:/app/node_modules
    depends_on:
      - backend
    environment:
      - VITE_API_URL=http://localhost:8000
    command: sh -lc "npm ci && npm run dev -- --host 0.0.0.0"

volumes:
  postgres_data:
  node_modules:
```

Docker Compose le pone al proyecto el nombre de la carpeta donde vive el compose. Como el mío está en `infra/`, el proyecto se llamaba "infra"... igual que otro
proyecto viejo que también tenía su compose en una carpeta `infra/`. Resultado: compartían
contenedores y, **el volumen de la base de datos**. Esto se resuelve asignando una *name* al principio del file.

---

## Paso 8 — Un comando para todos

Atajos, para no andar recordando comandos largos de Docker. Detalle importante: las indentaciones del Makefile son TABS, no espacios. Usa tabs. Espacios, no.

`Makefile` (en la raíz):
```makefile
.PHONY: help dev up down logs clean

help:
	@echo "dev / up / down / logs / clean"

dev:
	cd infra && docker compose up -d

up:
	cd infra && docker compose up

down:
	cd infra && docker compose down

logs:
	cd infra && docker compose logs -f

clean:
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
```

Y corre `make` siempre desde la raíz, no desde `infra/`.

---

## Paso 9 — Un frontend mínimo

No escribimos el frontend a mano. Vite trae un generador que crea toda la base. Para esta etapa con
eso basta; la UI de verdad viene después.

```bash
cd frontend
npm create vite@latest . -- --template react-ts
npm install
```

Eso deja `package.json`, `index.html`, `src/` y compañía. Un ajuste que conviene en `vite.config.ts`:
escuchar en toda la red (para que Docker lo alcance) y un alias para importar más cómodo.
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { host: '0.0.0.0', port: 5173 },
})
```

Y un `frontend/Dockerfile` chico, que el compose necesita:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 5173
CMD ["npm", "run", "preview", "--", "--host", "--port", "5173"]
```

---

## ¿Cuál es el orden en que todo corre?

Lo que corremos: `make dev`. De ahí, Docker Compose toma el control. Construye las imágenes si no
existen, levanta la base de datos **primero** (y espera a que esté sana, no solo "arrancada"), después
el backend, y por último el frontend.

Adentro del backend, uvicorn necesita el objeto `app`, así que importa `main.py` y lo ejecuta de
arriba a abajo, una sola vez. Ese recorrido *es* el arranque: se configura el logging, se lee la
config (y si falta algo, se cae acá mismo), se crea el engine —sin conectarse todavía—, se arma la app
con sus middlewares y rutas, y uvicorn se pone a escuchar. En este punto nadie tocó la base de datos.

La base se conecta de verdad recién en la primera petición. Cuando llega un `GET /health`, pasa por
los middlewares, el router lo manda a la función `health`, y ahí —recién ahí— se saca una conexión del
pool y se manda el `SELECT 1`. Si la BD contesta, dice "connected". Si no, lo atrapa el `try` y nunca
revienta. La respuesta sale, el middleware calcula cuánto tardó y lo loguea, y el cliente recibe su
JSON.

En una frase: `make dev` levanta base, backend y frontend; el backend importa `main.py` y eso prende
el logging, lee la config, crea el engine y se pone a escuchar; la base se conecta en la primera
petición.

---

## Cuando algo se rompe (que se va a romper)

Los logs no van a un archivo. Van a la salida estándar, y Docker los captura. Los ves con `make logs`,
o `cd infra && docker compose logs -f backend` para solo el backend. Como cada línea es JSON y lleva su
`request_id`, puedes filtrar por una petición y ver su viaje completo.

Cuatro cosas para usar con frecuencia:
- `make logs` y reproducir el error. Cada línea trae su id.
- En dev sale el SQL real en los logs (por el `echo`), así ves exactamente qué query corre.
- `/health` para saber si la BD responde; `http://localhost:8000/docs` para probar endpoints a mano.
- Si la app no arranca, el error sale arriba de todo en los logs: casi siempre una variable de entorno
  que falta, o un `__init__.py` olvidado.

---

## Qué queda levantado

Si llegaste hasta acá y `make dev` levanta los tres servicios, y `/health` te responde `connected`,
estamos. No hay agente, no hay login, no hay nada que mostrar en una demo. Pero tenemos las fundaciones construidas, con buenos cimientos, lista para que entre encima todo lo demás.

Si ves esto en `http://localhost:8000/health`, vamos bien.

```json
{
  "status": "ok",
  "env": "dev",
  "database": "connected"
}
```

Seguimos!

## Notas sobre el Middleware
Registrar el middleware:

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