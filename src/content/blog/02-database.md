---
title: "Recipe Book #2 — Database: modelos, migraciones, repositorios y endpoints"
fecha: 2026-06-11
tipo: tech
resumen: "La capa de datos completa: Postgres, migraciones con Alembic, patrón repository, services, DTOs y endpoints REST."
draft: false
---

> **Qué consigues al terminar:** la capa de datos completa y funcionando — tablas en Postgres,
> migraciones versionadas con Alembic, el patrón repository (acceso a datos limpio), services con
> la lógica de negocio, DTOs (contratos de la API) y endpoints REST que crean/listan sesiones y
> mensajes.
>
> 🙏 **Gracias, Bedir.** Esta serie está fuertemente basada en los excelentes posts de [Bedir Tapkan](https://bedirtapkan.com/). Gracias por compartir tu trabajo con tanta generosidad.

---

## Por qué "async" importa tanto aquí

Un agente es **I/O-heavy** (pasa la mayor parte del tiempo *esperando*: a la base de datos, al
LLM). Mira un request típico:

1. Guardar el mensaje del usuario en la BD → ~20 ms esperando disco
2. Llamar al LLM y recibir la respuesta → **5–30 segundos** esperando la red
3. Guardar la respuesta en la BD → ~20 ms

Con código **sync** (síncrono: una cosa a la vez), ese LLM call de 10 s **bloquea a todos los
demás usuarios**. Con código **async** (asíncrono: mientras una tarea espera, el programa atiende
otras), el servidor sirve a otros usuarios durante la espera. 10 usuarios a la vez terminan en
~10 s en vez de ~100 s. Por eso toda esta capa usa `async`/`await`.

---

## Paso 1 — Los modelos ORM (`persistence/models.py`)

**Por qué:** un modelo ORM (Object-Relational Mapping: mapea una tabla de la BD a una clase de
Python) describe la forma de cada tabla. Definimos tres: `User` → `Session` → `Message`, unidas
por relaciones. Detalles clave que pongo entre paréntesis abajo: *primary key* (clave primaria:
identificador único de cada fila), *foreign key* (clave foránea: apunta a la fila de otra tabla),
*cascade delete* (borrado en cascada) e *index* (índice: estructura que acelera las búsquedas).

**📋 Código a copiar — `backend/app/persistence/models.py`:**
```python
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

class Base(DeclarativeBase):
    """Clase base de todos los modelos ORM."""
    pass

class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # auth0_id: el id que da Auth0 al loguear (ej. "auth0|507f...").
    # unique + index porque se busca en cada request autenticado.
    auth0_id: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), unique=True, index=True, nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Relación: un usuario tiene muchas sesiones. cascade="all, delete-orphan"
    # = borrar el usuario borra sus sesiones (sin datos huérfanos).
    sessions: Mapped[list["Session"]] = relationship(
        "Session", back_populates="user", cascade="all, delete-orphan"
    )

class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # ForeignKey con ondelete="CASCADE": si se borra el user, Postgres borra sus sesiones.
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # onupdate=func.now(): se actualiza solo cada vez que cambia la fila (para ordenar por
    # "actividad reciente" en la UI).
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    user: Mapped["User"] = relationship("User", back_populates="sessions")
    messages: Mapped[list["Message"]] = relationship(
        "Message", back_populates="session", cascade="all, delete-orphan"
    )

    # Índice compuesto: acelera "dame las sesiones de este user ordenadas por fecha".
    __table_args__ = (Index("idx_user_updated", "user_id", "updated_at"),)

class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(50), nullable=False)   # user / assistant / tool_call / system
    content: Mapped[str] = mapped_column(Text, nullable=False)      # Text = string largo sin límite

    tool_name: Mapped[str | None] = mapped_column(String(255), nullable=True)  # solo en tool calls
    # trace_id / span_id: enlazan el mensaje con sistemas de tracing externos (se usan en la
    # una receta futura de observabilidad; las columnas existen desde ya).
    trace_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    span_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    tokens: Mapped[int] = mapped_column(Integer, default=0)         # para tracking de costo
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    session: Mapped["Session"] = relationship("Session", back_populates="messages")

    # Índice: acelera "dame los mensajes de esta sesión en orden cronológico".
    __table_args__ = (Index("idx_session_created", "session_id", "created_at"),)
```

> 🔜 En la receta 04 (agentes) el modelo `Message` gana dos columnas más: `input_tokens` y
> `output_tokens` (para calcular el costo real, porque el output cuesta ~3× el input).

---

## Paso 2 — Alembic: control de versiones de la BD

**Por qué:** Alembic es *"el git de tu base de datos"*. Cada vez que cambias un modelo, genera un
archivo de **migración** (instrucciones para llevar la BD de un estado al siguiente) con dos
funciones: `upgrade()` (aplicar el cambio) y `downgrade()` (revertirlo). Las migraciones se
versionan junto al código.

**📋 Inicializar Alembic — desde `backend/`:**
```bash
cd backend
uv run alembic init alembic   # crea la carpeta alembic/ + alembic.ini + versions/
```

Esto genera un `alembic/env.py` genérico. Como nuestra BD es **async**, hay que reemplazarlo.

**📋 Código a copiar — `backend/alembic/env.py`** (versión async, conectada a nuestros modelos):
```python
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# Importamos la metadata de NUESTROS modelos: así Alembic sabe cómo deben verse las tablas.
from app.persistence.models import Base
from app.core.settings import settings

config = context.config

# Override de la URL: la tomamos de settings (no hardcodeada en alembic.ini).
# Así dev/staging/prod usan su propia BD.
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata   # el "estado deseado" contra el que Alembic compara

def run_migrations_offline() -> None:
    """Modo offline: solo genera el SQL, sin conectarse."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url, target_metadata=target_metadata,
        literal_binds=True, dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()

async def run_migrations_online() -> None:
    """Modo online: se conecta a la BD y aplica."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.", poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()

def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    import asyncio
    asyncio.run(run_migrations_online())
```

> Sobre `alembic.ini` (generado por `alembic init`): lo único que importa es que
> `script_location = %(here)s/alembic` apunte a la carpeta de migraciones y `prepend_sys_path = .`
> esté presente. La URL de la BD **no** se pone aquí: la inyecta `env.py` desde `settings`.

---

## Paso 3 — Crear y aplicar la primera migración

**Por qué:** con los modelos y Alembic listos, generamos la migración que crea las tablas y la
aplicamos. **Regla de oro:** nunca corras `alembic` directo; usa los targets del Makefile, que lo
ejecutan *dentro del container* (donde vive la BD).

> ⚠️ **Antes de migrar, actualiza el `Dockerfile`.** El de la receta 01 solo copiaba `app/`. Para
> que `make migrate` (que corre dentro del container) encuentre Alembic, el container necesita
> tener `alembic/` y `alembic.ini`. Agrega al `backend/Dockerfile`, después del `COPY app/`:
> ```dockerfile
> COPY alembic/ ./alembic/
> COPY alembic.ini ./
> ```
> y rebuildea (`make down && make dev`). Sin esto, `make migrate` falla con
> `No 'script_location' key found` (el gotcha de abajo). *(Verificado en el test-app.)*

**📋 Código a copiar — agregar al `Makefile`:**
```makefile
# Migraciones (corren dentro del container backend)
migrate:
	cd infra && docker compose exec backend uv run alembic upgrade head

migrate-create:
	@test -n "$(msg)" || (echo "Uso: make migrate-create msg='tu mensaje'"; exit 1)
	cd infra && docker compose exec backend uv run alembic revision --autogenerate -m "$(msg)"

migrate-rollback:
	cd infra && docker compose exec backend uv run alembic downgrade -1
```

**📋 Comandos — generar y aplicar:**
```bash
make migrate-create msg="initial schema (users, sessions, messages)"   # autogenera el archivo
# 👀 REVISA SIEMPRE el archivo generado en alembic/versions/ antes de aplicar
make migrate                                                            # aplica contra la BD
```

`--autogenerate` (autogenerar) significa que Alembic **compara tus modelos contra la BD real** y
escribe el SQL de la diferencia. El workflow correcto siempre es: cambias `models.py` →
`make migrate-create` → **revisas el diff** → `make migrate`.

---

## Paso 4 — El patrón Repository (`persistence/repositories/`)

**Por qué:** un *repository* (repositorio) es la única capa que toca SQL. Recibe parámetros,
devuelve modelos ORM, y **no sabe nada de HTTP ni de reglas de negocio**. Cada uno es un
*singleton* (una sola instancia compartida, creada al final del archivo) porque no guarda estado.

Detalle central — **`flush()` vs `commit()`**:
- `flush()` → manda el SQL a Postgres **dentro** de la transacción actual, sin cerrarla.
- `commit()` → cierra y confirma la transacción. **Eso lo hace `get_db()`**, nunca el repository
  (ver receta 01, Paso 4).

**📋 Código a copiar — `persistence/repositories/user_repo.py`:**
```python
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import User

class UserRepository:
    async def get_by_id(self, db: AsyncSession, user_id: int) -> Optional[User]:
        result = await db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()   # el user o None

    async def get_by_auth0_id(self, db: AsyncSession, auth0_id: str) -> Optional[User]:
        result = await db.execute(select(User).where(User.auth0_id == auth0_id))
        return result.scalar_one_or_none()

    async def create(self, db: AsyncSession, auth0_id: str, email: str | None,
                     name: str | None = None) -> User:
        user = User(auth0_id=auth0_id, email=email, name=name)
        db.add(user)
        await db.flush()      # manda el INSERT (sin cerrar la transacción)
        await db.refresh(user)  # recarga el objeto con el id que asignó la BD
        return user

user_repo = UserRepository()  # singleton
```

**📋 Código a copiar — `persistence/repositories/session_repo.py`** (incluye el truco anti-N+1):
```python
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import Message, Session

class SessionRepository:
    async def create(self, db: AsyncSession, user_id: int, title: str) -> Session:
        session = Session(user_id=user_id, title=title)
        db.add(session)
        await db.flush()
        await db.refresh(session)
        return session

    async def get_by_id(self, db: AsyncSession, session_id: int) -> Session | None:
        result = await db.execute(select(Session).where(Session.id == session_id))
        return result.scalar_one_or_none()

    async def list_by_user_with_counts(
        self, db: AsyncSession, user_id: int, skip: int = 0, limit: int = 50
    ) -> list[tuple[Session, int]]:
        # Anti N+1: UNA query con JOIN + COUNT, en vez de 1 query por sesión.
        stmt = (
            select(Session, func.count(Message.id).label("message_count"))
            .outerjoin(Message, Message.session_id == Session.id)
            .where(Session.user_id == user_id)
            .group_by(Session.id)
            .order_by(desc(Session.updated_at))   # más recientes primero
            .offset(skip).limit(limit)            # paginación
        )
        result = await db.execute(stmt)
        return [(row[0], int(row[1])) for row in result.all()]

    async def delete(self, db: AsyncSession, session_id: int) -> bool:
        session = await self.get_by_id(db, session_id)
        if session:
            await db.delete(session)
            await db.flush()
            return True
        return False

session_repo = SessionRepository()
```

> **¿Qué es el problema N+1?** Si listas 50 sesiones y por cada una haces otra query para contar
> sus mensajes, son 1 + 50 = 51 queries. El `JOIN` (cruce de tablas) + `COUNT` lo resuelve en
> **una sola**.

**📋 Código a copiar — `persistence/repositories/message_repo.py`:**
```python
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import Message

class MessageRepository:
    async def create(self, db: AsyncSession, session_id: int, role: str, content: str,
                     tool_name: str | None = None, trace_id: str | None = None,
                     span_id: str | None = None, tokens: int = 0) -> Message:
        message = Message(session_id=session_id, role=role, content=content,
                          tool_name=tool_name, trace_id=trace_id, span_id=span_id, tokens=tokens)
        db.add(message)
        await db.flush()
        await db.refresh(message)
        return message

    async def list_by_session(self, db: AsyncSession, session_id: int,
                              skip: int = 0, limit: int = 100) -> list[Message]:
        result = await db.execute(
            select(Message).where(Message.session_id == session_id)
            .order_by(Message.created_at)   # orden cronológico
            .offset(skip).limit(limit)
        )
        return list(result.scalars().all())

    async def count_by_session(self, db: AsyncSession, session_id: int) -> int:
        result = await db.execute(
            select(func.count(Message.id)).where(Message.session_id == session_id)
        )
        return result.scalar() or 0

message_repo = MessageRepository()
```

---

## Paso 5 — Los DTOs (`domain/dtos.py`)

**Por qué:** un DTO (Data Transfer Object: objeto de transferencia de datos) es la **forma que ve
la API**, separada de la forma de la BD. Ventajas: (1) no filtras columnas internas, (2) puedes
agregar campos calculados (ej. `message_count`, que no existe en la tabla), (3) validas la entrada
y (4) puedes cambiar la BD sin romper el contrato público.

**📋 Código a copiar — `backend/app/domain/dtos.py`:**
```python
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

class SessionDTO(BaseModel):
    """Lo que el cliente recibe al pedir una sesión."""
    id: int
    user_id: int
    title: str
    message_count: int          # calculado, ¡no existe en la BD!
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)  # permite construir desde un objeto ORM

    @classmethod
    def from_orm(cls, session, message_count: int) -> "SessionDTO":
        # Convertimos el modelo ORM en DTO, inyectando el conteo calculado aparte.
        return cls(
            id=session.id, user_id=session.user_id, title=session.title,
            message_count=message_count,
            created_at=session.created_at, updated_at=session.updated_at,
        )

class SessionCreateDTO(BaseModel):
    """Lo que el cliente ENVÍA para crear una sesión (solo lo que puede setear)."""
    title: str = Field(..., min_length=1, max_length=500)   # validación estructural

class MessageDTO(BaseModel):
    id: int
    session_id: int
    role: str
    content: str
    tool_name: str | None = None
    trace_id: str | None = None
    span_id: str | None = None
    tokens: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_orm(cls, message) -> "MessageDTO":
        return cls(
            id=message.id, session_id=message.session_id, role=message.role,
            content=message.content, tool_name=message.tool_name,
            trace_id=message.trace_id, span_id=message.span_id,
            tokens=message.tokens, created_at=message.created_at,
        )

class MessageCreateDTO(BaseModel):
    # MessageRole es un Enum (lista cerrada de valores válidos). Si llega un role
    # fuera de la lista, FastAPI responde HTTP 422 automáticamente.
    class MessageRole(str, Enum):
        user = "user"
        assistant = "assistant"
        tool_call = "tool_call"
        system = "system"

    role: MessageRole
    content: str = Field(..., min_length=1)
    tool_name: str | None = Field(default=None, max_length=255)
    trace_id: str | None = Field(default=None, max_length=255)
    span_id: str | None = Field(default=None, max_length=255)
    tokens: int = Field(default=0, ge=0)   # ge=0: no negativos
```

---

## Paso 6 — Domain Services (`domain/services/`)

**Por qué:** el *service* es donde vive la **lógica de negocio**: validar, autorizar y orquestar.
Recibe `user_id` (un entero), no un objeto HTTP. Devuelve DTOs, nunca modelos ORM.

Dos tipos de error que el service levanta y el endpoint traduce a HTTP:
- `ValueError` → datos inválidos → **HTTP 400**
- `PermissionError` → el recurso no es tuyo → **HTTP 403**

**📋 Código a copiar — `domain/services/session_service.py`:**
```python
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.dtos import SessionDTO
from app.persistence.repositories.message_repo import message_repo
from app.persistence.repositories.session_repo import session_repo

class SessionService:
    async def create_session(self, db: AsyncSession, user_id: int, title: str) -> SessionDTO:
        # Validación = lógica de negocio (no de BD)
        if not title or len(title.strip()) == 0:
            raise ValueError("Session title cannot be empty")
        if len(title) > 500:
            raise ValueError("Session title too long (max 500 characters)")

        session = await session_repo.create(db, user_id=user_id, title=title.strip())
        return SessionDTO.from_orm(session, message_count=0)

    async def get_session(self, db: AsyncSession, session_id: int, user_id: int) -> SessionDTO | None:
        session = await session_repo.get_by_id(db, session_id)
        # Autorización: existe pero no es del usuario -> 403 (no 404)
        if session and session.user_id != user_id:
            raise PermissionError("Session does not belong to user")
        if not session:
            return None
        message_count = await message_repo.count_by_session(db, session_id)
        return SessionDTO.from_orm(session, message_count=message_count)

    async def list_user_sessions(self, db: AsyncSession, user_id: int,
                                 skip: int = 0, limit: int = 50) -> list[SessionDTO]:
        rows = await session_repo.list_by_user_with_counts(db, user_id, skip, limit)
        return [SessionDTO.from_orm(sess, message_count=count) for (sess, count) in rows]

    async def delete_session(self, db: AsyncSession, session_id: int, user_id: int) -> bool:
        session = await session_repo.get_by_id(db, session_id)
        if not session:
            return False
        if session.user_id != user_id:
            raise PermissionError("Cannot delete another user's session")
        return await session_repo.delete(db, session_id)

session_service = SessionService()
```

**📋 Código a copiar — `domain/services/message_service.py`:**
```python
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.dtos import MessageCreateDTO, MessageDTO
from app.persistence.repositories.message_repo import message_repo
from app.persistence.repositories.session_repo import session_repo

class MessageService:
    async def create_message(self, db: AsyncSession, session_id: int,
                             user_id: int, data: MessageCreateDTO) -> MessageDTO:
        # Autorización cross-entidad: el mensaje va a una sesión que debe ser del user.
        session = await session_repo.get_by_id(db, session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        if session.user_id != user_id:
            raise PermissionError("Cannot add messages to another user's session")

        message = await message_repo.create(
            db, session_id=session_id, role=data.role, content=data.content,
            tool_name=data.tool_name, trace_id=data.trace_id,
            span_id=data.span_id, tokens=data.tokens,
        )
        return MessageDTO.from_orm(message)

    async def list_session_messages(self, db: AsyncSession, session_id: int,
                                    user_id: int, skip: int = 0, limit: int = 100) -> list[MessageDTO]:
        session = await session_repo.get_by_id(db, session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        if session.user_id != user_id:
            raise PermissionError("Cannot view messages from another user's session")
        messages = await message_repo.list_by_session(db, session_id, skip, limit)
        return [MessageDTO.from_orm(msg) for msg in messages]

message_service = MessageService()
```

---

## Paso 7 — Los endpoints REST (`api/`)

**Por qué:** el endpoint (manejador) debe ser **delgadísimo** (5–10 líneas). Su único trabajo:
(1) sacar datos del request, (2) llamar al service, (3) traducir excepciones a códigos HTTP, (4)
devolver la respuesta. Nada de SQL ni reglas de negocio.

**📋 Código a copiar — `backend/app/api/dependencies.py`** (envoltorio fino sobre `get_db`):
```python
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db

async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Dependency de FastAPI para inyectar una sesión de BD en los endpoints."""
    async for session in get_db():
        yield session
```

**📋 Código a copiar — `backend/app/api/sessions.py`:**
```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_session
from app.domain.dtos import SessionCreateDTO, SessionDTO
from app.domain.services.session_service import session_service

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

@router.post("/", response_model=SessionDTO, status_code=status.HTTP_201_CREATED)
async def create_session(
    data: SessionCreateDTO,                       # FastAPI valida el body solo
    db: AsyncSession = Depends(get_session),
    user_id: int = 1,                             # TODO: del auth en receta 03
):
    try:
        return await session_service.create_session(db, user_id, data.title)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

@router.get("/", response_model=list[SessionDTO])
async def list_sessions(
    skip: int = 0, limit: int = 50,
    db: AsyncSession = Depends(get_session),
    user_id: int = 1,                             # TODO: del auth
):
    return await session_service.list_user_sessions(db, user_id, skip, limit)

@router.get("/{session_id}", response_model=SessionDTO)
async def get_session(
    session_id: int,
    db: AsyncSession = Depends(get_session),
    user_id: int = 1,
):
    try:
        session = await session_service.get_session(db, session_id, user_id)
        if not session:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
        return session
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))

@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: int,
    db: AsyncSession = Depends(get_session),
    user_id: int = 1,
):
    try:
        deleted = await session_service.delete_session(db, session_id, user_id)
        if not deleted:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
```

**📋 Código a copiar — `backend/app/api/messages.py`:**
```python
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_session
from app.domain.dtos import MessageCreateDTO, MessageDTO
from app.domain.services.message_service import message_service

router = APIRouter(prefix="/api/messages", tags=["messages"])

@router.post("/", response_model=MessageDTO, status_code=status.HTTP_201_CREATED)
async def create_message(
    data: MessageCreateDTO,
    session_id: int = Query(...),                 # va como query param (?session_id=)
    db: AsyncSession = Depends(get_session),
    user_id: int = 1,                             # TODO: del auth en receta 03
):
    try:
        return await message_service.create_message(db, session_id, user_id, data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))

@router.get("/", response_model=list[MessageDTO])
async def list_messages(
    session_id: int = Query(...),
    skip: int = 0, limit: int = 100,
    db: AsyncSession = Depends(get_session),
    user_id: int = 1,
):
    try:
        return await message_service.list_session_messages(db, session_id, user_id, skip, limit)
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
```

---

## Paso 8 — Conectar los routers en `main.py`

**Por qué:** un router existe para el mundo solo cuando `main.py` lo enchufa con
`include_router` (ver receta 01, concepto de ruteo).

**📋 Código a copiar — agregar a `backend/app/main.py`:**
```python
from app.api import messages, sessions

app.include_router(sessions.router)
app.include_router(messages.router)
```

---

## Paso 9 — Sembrar datos de dev + probar

**Por qué:** como los endpoints usan `user_id = 1` fijo, necesitamos que exista un usuario con
id 1 (por la foreign key). Un script de *seed* (sembrado) crea datos de prueba.

**📋 Código a copiar — `backend/scripts/seed_dev.py`:**
```python
import asyncio

from app.core.database import SessionLocal
from app.persistence.repositories.message_repo import message_repo
from app.persistence.repositories.session_repo import session_repo
from app.persistence.repositories.user_repo import user_repo

async def main():
    async with SessionLocal() as db:
        async with db.begin():   # en un script suelto sí abrimos transacción a mano
            user = await user_repo.create(db, auth0_id="seed-user", email="seed@example.com")
            s1 = await session_repo.create(db, user_id=user.id, title="Welcome Chat")
            await message_repo.create(db, session_id=s1.id, role="user", content="Hello!")
            await message_repo.create(db, session_id=s1.id, role="assistant", content="Hey there 👋")

if __name__ == "__main__":
    asyncio.run(main())
```

**📋 Comandos — sembrar y probar:**
```bash
# correr el seed dentro del container
cd infra && docker compose exec backend uv run python -m scripts.seed_dev

# probar los endpoints (la doc interactiva sale gratis en /docs)
curl http://localhost:8000/api/sessions/                                   # listar
curl -X POST http://localhost:8000/api/sessions/ \
  -H "Content-Type: application/json" -d '{"title":"Mi primera sesión"}'   # crear
```

---

## Conceptos clave de esta parte

- **`flush()` vs `commit()`:** `flush` manda el SQL dentro de la transacción; `commit` la cierra.
  El commit lo hace `get_db()`, no los repos. **Los services nunca abren transacciones** con
  `db.begin()` (excepto un script suelto como el seed).
- **Transaction ownership:** una sola pieza (`get_db`) es dueña del commit/rollback. Esto evita el
  error `A transaction is already begun on this Session`.
- **ORM vs DTO:** el modelo ORM es la forma de la BD; el DTO es el contrato de la API. Nunca
  devuelvas un modelo ORM directo desde un endpoint.
- **403 vs 404:** recurso que existe pero no es tuyo → este proyecto usa **403 explícito** (no el
  404 "no te enteras de que existe").
- **Validación en dos niveles:** estructural (longitud, enum) en los DTOs → HTTP **422** automático;
  reglas de negocio (ownership, cuotas) en los services → `ValueError`/`PermissionError` → 400/403.

## Gotchas (errores comunes)

| Síntoma | Causa | Fix |
|---|---|---|
| `A transaction is already begun on this Session` | un service hacía `async with db.begin()` y `get_db()` ya había abierto la transacción | quitar `db.begin()` de los services; el commit lo hace `get_db()` |
| `Can't locate revision identified by '...'` | la tabla `alembic_version` apunta a una migración que ya no existe en archivos | `DELETE FROM alembic_version;`, rebuild, y migrar de cero |
| `No 'script_location' key found` | falta `alembic.ini` o se corre Alembic fuera del container | `alembic.ini` en `backend/`; usar los targets de Make |
| carpeta `persistance` | typo por `persistence` | renombrar y arreglar imports |

## Transparencia y debugging (BD + Alembic)

> Esto es lo que más vas a usar en el día a día para entender qué está pasando con tus datos.

### Debuggear las migraciones de Alembic

Todos los comandos corren **dentro del container** (donde vive Alembic y la conexión a la BD):

```bash
cd infra

# ¿En qué migración está la BD ahora mismo?
docker compose exec backend uv run alembic current

# Historial completo de migraciones (orden y descripción)
docker compose exec backend uv run alembic history --verbose

# La(s) "cabeza(s)": la última migración de la cadena
docker compose exec backend uv run alembic heads

# DRY-RUN: imprime el SQL que aplicaría, SIN tocar la BD (modo offline)
docker compose exec backend uv run alembic upgrade head --sql
```

- **`current`** te dice el id de revisión en el que está la BD. Si no coincide con tu `head`, hay
  migraciones sin aplicar → corre `make migrate`.
- **`--sql`** (dry-run) es oro: ves exactamente el SQL que se ejecutaría antes de comprometerte.
- **Revisa SIEMPRE el archivo autogenerado** en `alembic/versions/` antes de `make migrate`. El
  `--autogenerate` se equivoca a veces (no detecta renombres, cambios de tipo sutiles, etc.).

Errores típicos y cómo leerlos:

| Síntoma | Qué significa | Fix |
|---|---|---|
| `Can't locate revision identified by '...'` | la tabla `alembic_version` apunta a una migración que no existe en `alembic/versions/` | `DELETE FROM alembic_version;`, rebuild, y migrar de cero |
| `Target database is not up to date` | intentas autogenerar con migraciones pendientes | corre `make migrate` primero, luego `make migrate-create` |
| `No 'script_location' key found` | el container no tiene Alembic (falta el `COPY` en el Dockerfile) | ver la nota del Paso 3 |

### Mirar el contenido de la base de datos

`psql` es el cliente de línea de comandos de Postgres. Entra al container de la db:

```bash
cd infra
docker compose exec db psql -U postgres -d agent_stack
```

Dentro de `psql`, comandos útiles (empiezan con `\`):

```sql
\dt                      -- lista las tablas
\d users                 -- describe la tabla users (columnas, tipos, índices, FKs)
\di                      -- lista todos los índices
\d+ sessions             -- describe con MÁS detalle (tamaños, etc.)
SELECT * FROM users;     -- ver el contenido
SELECT * FROM alembic_version;   -- ver en qué revisión cree la BD que está
\q                       -- salir
```

O una sola línea sin entrar al shell (útil para scripts):
```bash
docker compose exec db psql -U postgres -d agent_stack -c "SELECT id, title FROM sessions;"
```

> 💡 También puedes conectar un cliente gráfico (TablePlus, DBeaver, pgAdmin) a
> `postgresql://postgres:postgres@localhost:5432/agent_stack` para navegar las tablas con mouse.

### Otras tácticas de transparencia

1. **Ver el SQL real que corre la app.** En dev el engine usa `echo=settings.is_development`, así
   que **cada query SQL aparece en los logs** (`make logs-backend`). Es la mejor forma de:
   - confirmar que el **anti-N+1** funciona: al listar sesiones debe salir **UNA** query con
     `JOIN ... COUNT`, no una por sesión;
   - ver exactamente qué WHERE/JOIN se está ejecutando cuando algo devuelve datos raros.

2. **Probar los cascades de verdad.** Borra un user y confirma que sus sesiones y mensajes
   desaparecen solos:
   ```sql
   DELETE FROM users WHERE id = 1;
   SELECT count(*) FROM sessions;   -- debería bajar
   ```

3. **`/docs` (Swagger):** `http://localhost:8000/docs` te deja crear/listar sesiones y mensajes a
   mano desde el navegador, sin escribir `curl`.

4. **Inspeccionar un objeto ORM desde un REPL** con tus propios repos:
   ```bash
   docker compose exec backend uv run python
   >>> import asyncio
   >>> from app.core.database import SessionLocal
   >>> from app.persistence.repositories.session_repo import session_repo
   >>> async def go():
   ...     async with SessionLocal() as db:
   ...         print(await session_repo.list_by_user_with_counts(db, user_id=1))
   >>> asyncio.run(go())
   ```

---

## Checklist de "database lista"

- [ ] `make migrate` aplica sin error y crea las 3 tablas
- [ ] `GET /api/sessions/` responde `200` con la lista (tras el seed)
- [ ] `POST /api/sessions/` con título vacío responde `400`
- [ ] `POST /api/sessions/` con body sin `title` responde `422` (validación del DTO)
- [ ] La respuesta es JSON con `message_count` (campo calculado, no está en la tabla)
