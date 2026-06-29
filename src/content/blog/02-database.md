---
title: "Construyendo a hey-frank #2 — Bases de datos"
fecha: 2026-06-11
tipo: "hey frank"
resumen: "La capa de datos: modelos ORM, migraciones con Alembic, repositories, services, DTOs y endpoints REST."
draft: false
---

> **Qué conseguimos al terminar:** la capa de datos completa y funcionando — tablas en Postgres,
> migraciones versionadas con Alembic, el patrón repository (acceso a datos limpio), services con
> la lógica de negocio, DTOs (contratos de la API) y endpoints REST que crean/listan sesiones y
> mensajes.
>
> **Crédito:** estas notas están fuertemente basadas en la serie *Building a Production-Ready Agent
> Stack* de **Bedir Tapkan** ([bedirtapkan.com](https://bedirtapkan.com)). Gracias por el material
> original; acá lo adapté a mi stack (Gemini/ADK + Firebase).

---

## Por qué "async" importa tanto aquí

Un agente es **I/O-heavy** (pasa la mayor parte del tiempo *esperando*: a la base de datos, a la
LLM). Un request típico se ve así:

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
por relaciones. Detalles clave entre paréntesis abajo: *primary key* (clave primaria:
identificador único de cada fila), *foreign key* (clave foránea: apunta a la fila de otra tabla),
*cascade delete* (borrado en cascada) e *index* (índice: estructura que acelera las búsquedas).

**📋 Código — `backend/app/persistence/models.py`:**
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
    # subject: el id externo del usuario = el claim "sub" del token (uid de Firebase).
    # unique + index porque se busca en cada request autenticado.
    subject: Mapped[str] = mapped_column(String(255), unique=True, index=True)
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
    # trace_id / span_id: enlazan el mensaje con sistemas de tracing externos (se usan más
    # adelante, cuando sumemos observabilidad; las columnas existen desde ya).
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

**Cómo conecta:** cuando un usuario chatee, cada mensaje será una fila `Message` colgando de una
`Session`, que cuelga de un `User`. Por las cascadas, si borras un usuario, Postgres borra solo todas
sus sesiones y mensajes. Estos tres modelos son la base sobre la que trabajan
TODAS las capas siguientes (repos, services, endpoints) y también el agente cuando guarde sus
respuestas.

---

## Paso 2 — Alembic: control de versiones de la BD

**Por qué:** Alembic es *"el git de nuestra base de datos"*. Cada vez que cambiamos un modelo, genera un
archivo de **migración** (instrucciones para llevar la BD de un estado al siguiente) con dos
funciones: 
- `upgrade()` (aplicar el cambio) y 
- `downgrade()` (revertirlo). 

Las migraciones se versionan junto al código.

**📋 Inicializar Alembic — desde `backend/`:**
```bash
cd backend
uv run alembic init alembic   # crea la carpeta alembic/ + alembic.ini + versions/
```

Esto genera un `alembic/env.py` genérico. Como nuestra BD es **async**, hay que reemplazarlo.

**📋 Código — `backend/alembic/env.py`** (versión async, conectada a nuestros modelos):
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

**Cómo conecta:** en unas semanas vas a querer agregar, digamos, una columna `archived` a
`sessions`. En vez de tocar la BD a mano, cambias el modelo, corres `make migrate-create`, y Alembic
escribe el SQL del cambio. Ese mismo archivo se aplica **idéntico** en tu máquina, en la de un
compañero y en producción. Es lo que mantiene el esquema sincronizado en todos lados.

---

## Paso 3 — Crear y aplicar la primera migración

**Por qué:** con los modelos y Alembic listos, generamos la migración que crea las tablas y la
aplicamos. **Regla de oro:** nunca correr `alembic` directo; usemos los targets del Makefile, que lo
ejecutan *dentro del container* (donde vive la BD).

> ⚠️ **Antes de migrar, actualiza el `Dockerfile`.** El de la receta 01 solo copiaba `app/`. Para
> que `make migrate` (que corre dentro del container) encuentre Alembic, el container necesita
> tener `alembic/` y `alembic.ini`. Agrega al `backend/Dockerfile`, después del `COPY app/`:
> ```dockerfile
> COPY alembic/ ./alembic/
> COPY alembic.ini ./
> ```
> y **reconstruye la imagen** del backend. Ojo: `make dev` hace `up -d` y NO reconstruye, así que
> hazlo explícito:
> ```bash
> cd infra && docker compose up -d --build backend
> ```
> Sin esto, `make migrate` falla con `No 'script_location' key found` (la imagen vieja no tiene
> alembic adentro).

> ⚠️ **Y monta `alembic/` como volumen en dev.** El `COPY` del Dockerfile es para producción; en
> desarrollo necesitas que `migrate-create` escriba la migración **en tu disco** (host), no dentro
> del container —si no, la generas, se queda en el container, y la pierdes al recrearlo (y no la
> puedes commitear). En `infra/docker-compose.yml`, servicio `backend`, junto al volumen de `app/`:
> ```yaml
>     volumes:
>       - ../backend/app:/app/app:ro
>       - ../backend/alembic:/app/alembic     # migrate-create persiste en el host
> ```
> Recrea el backend para que tome el volumen: `cd infra && docker compose up -d backend`.

**Código — agregar al final del `Makefile`:**
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

**Comandos — generar y aplicar:**
```bash
# Autogenera el archivo
make migrate-create msg="initial schema (users, sessions, messages)"   

# REVISA SIEMPRE el archivo generado en alembic/versions/ antes de aplicar
# Aplica contra la BD                                                            
make migrate 
```

`--autogenerate` (autogenerar) significa que Alembic **compara tus modelos contra la BD real** y
escribe el SQL de la diferencia. El workflow correcto siempre es: cambias `models.py` →
`make migrate-create` → **revisas el diff** → `make migrate`.

**Cómo conecta:** esta es la acción que de verdad **crea** las tablas en Postgres. Un compañero
clona el repo, corre `make migrate`, y tiene exactamente tu mismo esquema. Al desplegar, lo corres
(o lo corre CI) y producción queda al día. Sin este paso, tus modelos existen en Python pero no en
la BD —y eso era justo el error `database "hey_frank" does not exist` / tablas inexistentes—.

---

## Paso 4 — El patrón Repository (`persistence/repositories/`)

**Por qué:** un *repository* (repositorio) es la única capa que toca SQL. Recibe parámetros,
devuelve modelos ORM, y **no sabe nada de HTTP ni de reglas de negocio**. Cada uno es un
*singleton* (una sola instancia compartida, creada al final del archivo) porque no guarda estado.

> **En puertos y adaptadores:** el repository es un **adaptador de salida**. El service (núcleo) le
> pide datos sin saber que detrás hay Postgres; cambiar de base = cambiar solo este adaptador.

Detalle central — **`flush()` vs `commit()`**:
- `flush()` → manda el SQL a Postgres **dentro** de la transacción actual, sin cerrarla.
- `commit()` → cierra y confirma la transacción. **Eso lo hace `get_db()`**, nunca el repository.

**📋 Código — `persistence/repositories/user_repo.py`:**
```python
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import User


class UserRepository:
    async def get_by_id(self, db: AsyncSession, user_id: int) -> Optional[User]:
        result = await db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()   # el user o None

    async def get_by_subject(self, db: AsyncSession, subject: str) -> Optional[User]:
        result = await db.execute(select(User).where(User.subject == subject))
        return result.scalar_one_or_none()

    async def create(self, db: AsyncSession, subject: str, email: str | None,
                     name: str | None = None) -> User:
        user = User(subject=subject, email=email, name=name)
        db.add(user)
        await db.flush()      # manda el INSERT (sin cerrar la transacción)
        await db.refresh(user)  # recarga el objeto con el id que asignó la BD
        return user


user_repo = UserRepository()  # singleton
```

**📋 Código — `persistence/repositories/session_repo.py`** (incluye el truco anti-N+1):
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

**📋 Código — `persistence/repositories/message_repo.py`:**
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

**Cómo conecta:** cuando el agente termine de responder, el código hará
`message_repo.create(...)` para guardar el mensaje del asistente. El repo es el **único** lugar que
sabe SQL: el resto de la app le pide datos sin saber cómo están guardados. Si mañana cambiaras
Postgres por otra base, tocarías solo los repos y nada más.

---

## Paso 5 — Los DTOs (`domain/dtos.py`)

**La idea en una analogía.** Piensa en un restaurante. La **cocina** es tu base de datos: ahí está
todo crudo —ingredientes, notas internas, precios de proveedor—. El **menú** es lo que le entregas
al cliente: una versión ordenada y presentable, con solo lo que le interesa ver. No le pasas el
inventario de la cocina al comensal; le pasas el menú.

Un **DTO** (Data Transfer Object) es ese menú: la forma de los datos **que entra y sale por la API**,
separada de la forma que tienen en la BD.

¿Por qué no devolver directamente el modelo de la tabla? Porque la tabla y la API
quieren cosas distintas. Cuatro razones, con ejemplos:

1. **No exponer lo interno.** Tu tabla `users` tiene la columna `subject` (el uid de Firebase). Eso
   es de cocina; no tiene por qué viajar al frontend. El DTO decide qué se muestra y qué no.
2. **Campos calculados que no existen como columna.** `SessionDTO` tiene `message_count` (cuántos
   mensajes tiene la sesión). En la tabla `sessions` **no hay** una columna `message_count`; se
   calcula al vuelo. El DTO sí puede tenerlo.
3. **Validar lo que entra.** Hay dos tipos de DTO: los de *salida* (lo que el cliente recibe, como
   `SessionDTO`) y los de *entrada* (lo que el cliente envía, como `SessionCreateDTO`). En los de
   entrada, Pydantic **valida solo**: si el título viene vacío o el `role` no es uno de los
   permitidos, FastAPI rechaza el request con un error claro, sin que escribas un solo `if`.
4. **Desacoplar.** Si mañana cambias una columna de la BD, no rompes a quien consume tu API: ajustas
   la traducción ORM → DTO y el "menú" sigue igual.

En resumen: el **modelo ORM** es la forma de la BD; el **DTO** es la forma de la API. La pieza que
traduce de uno a otro es el método `from_orm` que verás abajo.

**📋 Código — `backend/app/domain/dtos.py`:**
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

**Cómo conecta:** el sidebar del chat mostrará "Chat sobre Python — 5 mensajes". Ese "5" es el
`message_count` del `SessionDTO`. Y cuando el usuario escribe el título de una sesión nueva,
`SessionCreateDTO` valida que no venga vacío **antes** de tocar la BD. Cada JSON que entra o sale de
tu API tiene la forma de un DTO.

---

## Paso 6 — Domain Services (`domain/services/`)

**Por qué:** el *service* es donde vive la **lógica de negocio**: validar, autorizar y orquestar.
Recibe `user_id` (un entero), no un objeto HTTP. Devuelve DTOs, nunca modelos ORM.

Dos tipos de error que el service levanta y el endpoint traduce a HTTP:
- `ValueError` → datos inválidos → **HTTP 400**
- `PermissionError` → el recurso no es tuyo → **HTTP 403**

**📋 Código — `domain/services/session_service.py`:**
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

**📋 Código — `domain/services/message_service.py`:**
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

**Cómo conecta:** si el usuario A intenta abrir una sesión del usuario B, el service lanza
`PermissionError` y el endpoint lo traduce a un `403`. Esa regla de "solo ves lo tuyo" vive acá, una
sola vez, y la reusan tanto los endpoints REST como el endpoint de streaming del agente.
Toda regla de negocio nueva (cuotas, límites de uso) entra en esta capa, no en los endpoints.

---

## Paso 7 — Los endpoints REST (`api/`)

**Por qué:** el endpoint (manejador) debe ser **delgadísimo** (5–10 líneas). Su único trabajo:

- (1) sacar datos del request
- (2) llamar al service
- (3) traducir excepciones a códigos HTTP
- (4) devolver la respuesta. Nada de SQL ni reglas de negocio.

> **En puertos y adaptadores:** el endpoint es un **adaptador de entrada**: traduce HTTP y llama al
> núcleo (el service). Una CLI o un test serían otros adaptadores de entrada sobre el mismo service.


**📋 Código — `backend/app/api/dependencies.py`** (envoltorio fino sobre `get_db`):
```python
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Dependency de FastAPI para inyectar una sesión de BD en los endpoints."""
    async for session in get_db():
        yield session
```

**📋 Código — `backend/app/api/sessions.py`:**
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

**📋 Código — `backend/app/api/messages.py`:**
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

**Cómo conecta:** estos son los URLs que tu frontend React va a llamar de verdad: `GET /api/sessions/`
para pintar el listado de chats, `POST /api/sessions/` cuando aprietas "Nuevo chat",
`GET /api/messages/?session_id=...` para cargar una conversación. Son la superficie HTTP de tu app —
todo lo que el navegador toca pasa por acá.

---

## Paso 8 — Conectar los routers en `main.py`

**Por qué:** un router existe para el mundo solo cuando `main.py` lo enchufa con
`include_router`.

**📋 Código — agregar a `backend/app/main.py`:**
```python
from app.api import messages, sessions

app.include_router(sessions.router)
app.include_router(messages.router)
```

**Cómo conecta:** sin esta línea, `GET /api/sessions/` responde `404` aunque el endpoint exista —
nadie lo conectó. `main.py` es el tablero que enchufa cada grupo de rutas a la app. Acá iremos sumando
después los routers de auth y de streaming del agente.

---

## Paso 9 — Sembrar datos de dev + probar

**Por qué:** como los endpoints usan `user_id = 1` fijo, necesitamos que exista un usuario con
id 1 (por la foreign key). Un script de *seed* (sembrado) crea datos de prueba.

**📋 Código — `backend/scripts/seed_dev.py`:**
```python
import asyncio

from app.core.database import SessionLocal
from app.persistence.repositories.message_repo import message_repo
from app.persistence.repositories.session_repo import session_repo
from app.persistence.repositories.user_repo import user_repo


async def main():
    async with SessionLocal() as db:
        async with db.begin():   # en un script suelto sí abrimos transacción a mano
            user = await user_repo.create(db, subject="seed-user", email="seed@example.com")
            s1 = await session_repo.create(db, user_id=user.id, title="Welcome Chat")
            await message_repo.create(db, session_id=s1.id, role="user", content="Hello!")
            await message_repo.create(db, session_id=s1.id, role="assistant", content="Hey there 👋")


if __name__ == "__main__":
    asyncio.run(main())
```


**📋 Código — agregar a `backend/Dockerfile`, debajo del `COPY app/`:**
```dockerfile
# Código después
COPY app/ ./app/
# seed y otros scripts de dev (receta 02, Paso 9)
COPY scripts/ ./scripts/
```

Como cambiaste el `Dockerfile`, reconstruye el backend (un `make dev`/`up -d` normal **no**
reconstruye):
```bash
cd infra && docker compose up -d --build backend
```

No hace falta `scripts/__init__.py`: con `python -m`, Python 3 trata `scripts` como *namespace
package* y lo encuentra igual.

**📋 Comandos — sembrar y probar:**
```bash
# correr el seed dentro del container
cd infra && docker compose exec backend uv run python -m scripts.seed_dev

# probar los endpoints (la doc interactiva sale gratis en /docs)
curl http://localhost:8000/api/sessions/                                   # listar
curl -X POST http://localhost:8000/api/sessions/ \
  -H "Content-Type: application/json" -d '{"title":"Mi primera sesión"}'   # crear
```

**Cómo conecta:** como los endpoints aún usan `user_id = 1` fijo (la auth real llega en la receta
03), necesitas que exista un usuario con id 1 para poder crear sesiones. El seed te deja desarrollar
y probar el frontend con datos realistas **antes** de que existan el login o el agente. Es puro
andamiaje de desarrollo: en la receta 03, los usuarios reales de Firebase reemplazan al sembrado.

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


## Transparencia y debugging (BD + Alembic)

> Esto es lo que más vamos a usar en el día a día para entender qué está pasando con los datos.

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
| `No 'script_location' key found` | el container no tiene Alembic: falta el `COPY` en el Dockerfile, **o la imagen no se reconstruyó** (`make dev` no hace `--build`) | ver la nota del Paso 3 |

### Mirar el contenido de la base de datos

`psql` es el cliente de línea de comandos de Postgres. Entra al container de la db:

```bash
cd infra
docker compose exec db psql -U postgres -d hey_frank
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
docker compose exec db psql -U postgres -d hey_frank -c "SELECT id, title FROM sessions;"
```

> 💡 También puedes conectar un cliente gráfico (TablePlus, DBeaver, pgAdmin) a
> `postgresql://postgres:postgres@localhost:5432/hey_frank` para navegar las tablas con mouse.

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
