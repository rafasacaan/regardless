---
title: "Receta 03 — Auth: Auth0, JWT, PKCE y la cookie firmada para SSE"
fecha: 2026-06-18
tipo: técnico
resumen: "Autenticación de punta a punta: login con Auth0, verificación de JWT y el truco de la cookie firmada para el streaming."
draft: false
---

> **Qué consigues al terminar:** autenticación real de punta a punta — login con Auth0 en el
> frontend, verificación de JWT en la API, el truco de la cookie firmada para el streaming, y el
> reemplazo del `user_id = 1` placeholder por la identidad real del usuario.
>
> 🙏 **Gracias, Bedir.** Esta serie está fuertemente basada en los excelentes posts de [Bedir Tapkan](https://bedirtapkan.com/). Gracias por compartir tu trabajo con tanta generosidad.

---

## El problema que lo explica todo

Queremos proteger dos cosas distintas, y resulta que **necesitan dos mecanismos distintos**:

1. **La API REST** (crear sesión, listar mensajes…) → la llamamos con `fetch()`, que **sí** puede
   mandar headers. Acá usamos un **JWT** (JSON Web Token: un "pase" firmado que prueba quién eres)
   en el header `Authorization: Bearer <token>`.

2. **El streaming (SSE)** → se abre con `EventSource` (la API del navegador para Server-Sent
   Events), y **EventSource NO permite mandar headers custom**. Esto no existe:
   ```js
   new EventSource('/stream/', { headers: { Authorization: '...' } })  // ❌ imposible
   ```
   Solución: una **cookie firmada** que el navegador manda **solo** y automáticamente.

```
API REST  →  Authorization: Bearer <JWT>     (fetch sí manda headers)
SSE       →  Cookie firmada HttpOnly         (el navegador la manda solo)
```

Dos mecanismos, **una sola idea**: verificar firmas matemáticas. Ambos son *stateless* (sin
estado: no hay que consultar la BD para validar, solo verificar la firma).

---

## Tres conceptos antes de los pasos

**PKCE** (Proof Key for Code Exchange, se pronuncia "pixy"): el modo seguro de hacer login desde
una SPA (Single Page Application: app que corre entera en el navegador, sin backend propio). Como
una SPA no puede guardar secretos, en vez de un secreto fijo:
1. El frontend inventa un `code_verifier` (texto aleatorio largo).
2. Calcula `code_challenge = SHA256(code_verifier)` (SHA256 = función que resume datos y es
   irreversible: del resumen no se puede volver al original).
3. Manda el *challenge* a Auth0 al iniciar el login; al final manda el *verifier*.
4. Auth0 comprueba que `SHA256(verifier) == challenge` → recién ahí entrega el JWT.

Aunque alguien intercepte el código intermedio, sin el `verifier` no puede obtener el token.
La librería de Auth0 hace todo esto sola; tú solo la configuras.

**JWT y RS256:** un JWT tiene 3 partes (`header.payload.signature`). Auth0 lo firma con su llave
privada (que solo él tiene) usando **RS256** (algoritmo asimétrico: se firma con una llave y se
verifica con *otra*). Nosotros verificamos con su llave **pública** (descargable). Sin la privada,
nadie puede falsificar tokens. Las llaves públicas viven en una URL llamada **JWKS** (JSON Web Key
Set) que cacheamos 1 hora.

**Cookie HMAC:** la cookie de SSE se firma con **HMAC** (firma que requiere un secreto compartido,
`COOKIE_SECRET`). Diferencia con un hash simple: un SHA256 cualquiera lo puede calcular cualquiera
→ falsificable; un HMAC necesita tu secreto → infalsificable sin él.

---

## Paso 1 — Configurar Auth0 (la "capa de identidad")

**Por qué:** Auth0 es quien hace el login de verdad (maneja contraseñas, Google, etc.). Tú no
guardas contraseñas nunca. Hay que crear dos cosas (y opcionalmente una tercera para testear).

**📋 En el dashboard de Auth0:**
1. **Una "Single Page Application"** (llámala "Agent Stack Frontend"):
   - Application Type: **Single Page Application**
   - Allowed Callback URLs: `http://localhost:5173`
   - Allowed Logout URLs: `http://localhost:5173`
   - Allowed Web Origins: `http://localhost:5173`
   - En la pestaña **API Access**, dale acceso a tu API (paso 2) con *User-delegated Access*.
2. **Una "API"** (llámala "Agent Stack API"):
   - Identifier (= tu *audience*): `https://api.agent-stack.com`
3. *(Opcional)* **Una "M2M Application"** (Machine-to-Machine): solo sirve para conseguir un token
   con `curl` y probar sin navegador.

> *audience* (audiencia) = "para qué API es válido este token". *issuer* (emisor) = quién lo
> emitió (tu dominio de Auth0). Ambos se verifican al validar el JWT.

---

## Paso 2 — Dependencias del backend

**Por qué:** necesitamos librerías para verificar JWTs y firmar cookies.

**📋 Comando — desde `backend/`:**
```bash
uv add "python-jose[cryptography]" itsdangerous httpx
```
- **python-jose** → decodifica y verifica la firma de los JWT (RS256).
- **itsdangerous** → firma/verifica la cookie de SSE (HMAC).
- **httpx** → cliente HTTP async para descargar las llaves JWKS de Auth0.

---

## Paso 3 — Settings: campos de Auth0 y de la cookie

**Por qué:** centralizamos la config nueva en `settings.py`, con validators que hacen *fail fast*
(si falta algo o es inválido, la app no arranca).

**📋 Código a copiar — agregar campos a `Settings` en `backend/app/core/settings.py`:**
```python
# Auth0
auth0_domain: str
auth0_audience: str
auth0_issuer: str | None = None

# Firma de la cookie de SSE
cookie_secret: str
session_cookie_name: str = "stream_session"
session_cookie_max_age: int = 600  # 10 minutos
api_base_url: str | None = None    # para detectar cross-site

@field_validator("auth0_domain")
@classmethod
def validate_auth0_domain(cls, v: str) -> str:
    return v.replace("https://", "").replace("http://", "")  # normaliza

@field_validator("auth0_issuer", mode="before")
@classmethod
def set_auth0_issuer(cls, v: str | None, info) -> str:
    if v:
        return v
    domain = info.data.get("auth0_domain")
    if domain:
        return f"https://{domain}/"   # default: derivado del dominio
    raise ValueError("Cannot determine AUTH0_ISSUER")

@field_validator("cookie_secret")
@classmethod
def validate_cookie_secret(cls, v: str) -> str:
    if len(v) < 32:
        raise ValueError("COOKIE_SECRET must be at least 32 characters.")
    return v
```

**📋 Código a copiar — agregar a `backend/.env`:**
```bash
AUTH0_DOMAIN=dev-xxxx.us.auth0.com
AUTH0_AUDIENCE=https://api.agent-stack.com
COOKIE_SECRET=<mín 32 chars: python -c "import secrets; print(secrets.token_urlsafe(32))">
SESSION_COOKIE_NAME=stream_session
SESSION_COOKIE_MAX_AGE=600
```
> ⚠️ Gotcha real: **no** pongas comentarios en la misma línea de un valor en el `.env`
> (`SESSION_COOKIE_MAX_AGE=600 # 10 min` rompe pydantic). El comentario va en su propia línea.

---

## Paso 4 — `core/auth.py`: el corazón de la verificación

**Por qué:** lógica pura de auth, sin rutas HTTP. Hace tres cosas: (a) verifica JWTs contra las
llaves de Auth0, (b) firma/verifica la cookie de SSE, (c) expone *dependencies* de FastAPI que los
endpoints usan para exigir login.

**📋 Código a copiar — `backend/app/core/auth.py`:**
```python
import hashlib
from datetime import datetime, timedelta
from typing import Any, Optional

import httpx
from fastapi import HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from jose import JWTError, jwt
from jose.exceptions import ExpiredSignatureError, JWTClaimsError

from app.core.settings import settings

security = HTTPBearer()   # hace que Swagger muestre el botón "Authorize"

# Caché de las llaves públicas de Auth0 (JWKS). Se refresca cada hora.
_jwks_cache: Optional[dict[str, Any]] = None
_jwks_cache_time: Optional[datetime] = None
JWKS_CACHE_TTL = timedelta(hours=1)

async def get_jwks() -> dict[str, Any]:
    """Descarga las llaves públicas de Auth0 (cacheadas 1h)."""
    global _jwks_cache, _jwks_cache_time
    if _jwks_cache and _jwks_cache_time:
        if datetime.utcnow() - _jwks_cache_time < JWKS_CACHE_TTL:
            return _jwks_cache
    jwks_url = f"https://{settings.auth0_domain}/.well-known/jwks.json"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(jwks_url)
            response.raise_for_status()
        _jwks_cache = response.json()
        _jwks_cache_time = datetime.utcnow()
        return _jwks_cache
    except httpx.HTTPError:
        if _jwks_cache:        # fail-soft: si Auth0 no responde pero hay caché, úsala
            return _jwks_cache
        raise

async def verify_jwt(token: str) -> dict[str, Any]:
    """Verifica firma + claims del JWT. Devuelve el payload o lanza 401."""
    try:
        jwks = await get_jwks()
        key_id = jwt.get_unverified_header(token).get("kid")   # qué llave usar
        if not key_id:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token missing 'kid'")

        rsa_key = None
        for key in jwks.get("keys", []):
            if key["kid"] == key_id:
                rsa_key = {k: key[k] for k in ("kty", "kid", "use", "n", "e")}
                break
        if not rsa_key:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No matching public key")

        return jwt.decode(
            token, rsa_key, algorithms=["RS256"],
            audience=settings.auth0_audience,
            issuer=settings.auth0_issuer,
            options={"leeway": 60},   # tolera 60s de desfase de reloj
        )
    except ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token has expired")
    except (JWTClaimsError, JWTError) as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {e}")

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(security),
) -> dict[str, Any]:
    """Dependency: extrae y verifica el JWT del header. Devuelve el payload."""
    return await verify_jwt(credentials.credentials)

async def get_current_user_id(user: dict = Security(get_current_user)) -> str:
    """Dependency: devuelve el auth0_id (el claim 'sub')."""
    return user["sub"]   # ej. "auth0|507f1f77bcf86cd799439011"

# --- Cookie firmada para SSE (HMAC-SHA256) ---
cookie_signer = URLSafeTimedSerializer(
    settings.cookie_secret,
    salt="stream-session",   # separa esta firma de otras (domain separation)
    signer_kwargs={"digest_method": hashlib.sha256},
)

def create_stream_cookie(user_id: str) -> str:
    """Firma el user_id en una cookie. Stateless (sin lookup en BD)."""
    return cookie_signer.dumps(user_id)

def verify_stream_cookie(cookie_value: str) -> str:
    """Verifica la firma y la expiración; devuelve el user_id."""
    try:
        return cookie_signer.loads(cookie_value, max_age=settings.session_cookie_max_age)
    except SignatureExpired:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Stream session expired.")
    except BadSignature:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid stream session cookie")

async def get_user_from_stream_cookie(request: Request) -> str:
    """Dependency para los endpoints SSE: lee y verifica la cookie."""
    cookie_value = request.cookies.get(settings.session_cookie_name)
    if not cookie_value:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "No stream session. Call POST /auth/session first.")
    return verify_stream_cookie(cookie_value)
```

---

## Paso 5 — `core/cookies.py`: atributos de la cookie según entorno

**Por qué:** una cookie cross-site (frontend y backend en dominios distintos) necesita
`SameSite=None; Secure`; una same-site (mismo dominio) usa `SameSite=lax`. Esta función lo decide
sola comparando los orígenes.

**📋 Código a copiar — `backend/app/core/cookies.py`:**
```python
from urllib.parse import urlparse

from app.core.settings import settings

def cookie_attrs_for_sse():
    """Elige los atributos de la cookie según si los orígenes difieren."""
    origin = (settings.cors_origins or [""])[0]
    api = settings.api_base_url or origin
    o, a = urlparse(origin), urlparse(api)
    cross_site = (o.scheme, o.hostname, o.port) != (a.scheme, a.hostname, a.port)

    same_site = "none" if cross_site else "lax"
    secure = settings.env != "development" or cross_site
    path = "/stream/"   # la cookie solo viaja a /stream/, nunca a /api/
    return same_site, secure, path
```
> Flags de seguridad de la cookie: **HttpOnly** (invisible para JavaScript → protege de ataques
> XSS), **Path=/stream/** (solo se envía a los endpoints de streaming), **Max-Age=600** (expira en
> 10 min), **Secure** (solo por HTTPS, salvo en dev mismo-origen).

---

## Paso 6 — `user_service.py`: el puente de identidades (bridge)

**Por qué:** el JWT trae el `auth0_id` (un string externo, ej. `"auth0|507f..."`). Pero internamente
es más rápido usar un `user.id` entero (para índices y JOINs). Este service traduce uno en el otro,
creando el usuario en su primer login (*auto-registro*).

**📋 Código a copiar — `backend/app/domain/services/user_service.py`:**
```python
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import User
from app.persistence.repositories.user_repo import user_repo

class UserService:
    async def get_or_create_from_auth0_id(
        self, db: AsyncSession, auth0_id: str,
        email: str | None = None, name: str | None = None,
    ) -> User:
        user = await user_repo.get_by_auth0_id(db, auth0_id)
        if user:
            # Si cambió el email/nombre en Auth0, lo sincronizamos
            updated = False
            if email is not None and user.email != email:
                user.email = email; updated = True
            if name is not None and user.name != name:
                user.name = name; updated = True
            if updated:
                await db.flush()
                await db.refresh(user)
            return user

        # Primer login: auto-registro
        from sqlalchemy.exc import IntegrityError
        try:
            return await user_repo.create(db, auth0_id=auth0_id, email=email, name=name)
        except IntegrityError:
            # Race condition: dos requests crean el mismo user a la vez.
            # El segundo recibe IntegrityError -> hacemos un GET de fallback.
            await db.rollback()
            return await user_repo.get_by_auth0_id(db, auth0_id)

user_service = UserService()
```
> *race condition* (condición de carrera) = dos peticiones simultáneas pisándose. El
> `except IntegrityError` la maneja: si el `INSERT` choca con el del otro request, en vez de
> fallar hace un `GET`.

---

## Paso 7 — `api/auth.py`: los endpoints de auth

**Por qué:** aquí vive el endpoint "mágico" que **intercambia el JWT por la cookie de SSE**, más el
perfil del usuario y el logout.

**📋 Código a copiar — `backend/app/api/auth.py`:**
```python
from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_session
from app.core.auth import create_stream_cookie, get_current_user, get_current_user_id
from app.core.cookies import cookie_attrs_for_sse
from app.core.settings import settings
from app.domain.services.user_service import user_service

router = APIRouter(prefix="/auth", tags=["authentication"])

@router.post("/session", status_code=status.HTTP_204_NO_CONTENT)
async def create_session_cookie(
    response: Response,
    db: AsyncSession = Depends(get_session),
    user_id: str = Depends(get_current_user_id),   # verifica el JWT
):
    """Intercambia JWT por cookie de stream. El puente JWT -> cookie."""
    async with db.begin():
        await user_service.get_or_create_from_auth0_id(db, user_id)

    cookie_value = create_stream_cookie(user_id)
    same_site, secure, path = cookie_attrs_for_sse()
    response.set_cookie(
        key=settings.session_cookie_name, value=cookie_value,
        max_age=settings.session_cookie_max_age,
        httponly=True, secure=secure, samesite=same_site, path=path,
    )
    # 204 = éxito sin body; la cookie va en el header Set-Cookie

@router.get("/me")
async def get_current_user_info(
    user_data: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """Perfil del usuario autenticado (para mostrar nombre/avatar en la UI)."""
    user = await user_service.get_or_create_from_auth0_id(
        db, auth0_id=user_data["sub"],
        email=user_data.get("email", ""), name=user_data.get("name", ""),
    )
    return {"id": user.id, "auth0_id": user.auth0_id,
            "email": user.email, "name": user.name,
            "created_at": user.created_at.isoformat()}

@router.delete("/session", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session_cookie(response: Response):
    """Logout: borra la cookie de stream."""
    response.delete_cookie(key=settings.session_cookie_name, path="/stream/")
```

---

## Paso 8 — Proteger los endpoints (¡adiós `user_id = 1`!)

**Por qué:** en la receta 02 los endpoints usaban `user_id: int = 1` fijo. Ahora sacamos la
identidad **real** del JWT. El patrón se repite en cada handler: (1) registrar el router de auth,
(2) cambiar el placeholder por la auth real.

**📋 Código a copiar — agregar a `backend/app/main.py`:**
```python
from app.api import auth

app.include_router(auth.router)
```

**📋 El cambio en cada endpoint — antes y después** (ejemplo con `create_session`):
```python
# ANTES (receta 02 — placeholder):
async def create_session(
    data: SessionCreateDTO,
    db: AsyncSession = Depends(get_session),
    user_id: int = 1,                                      # ❌ fijo
):
    return await session_service.create_session(db, user_id, data.title)

# DESPUÉS (receta 03 — identidad real):
from app.core.auth import get_current_user_id
from app.domain.services.user_service import user_service

async def create_session(
    data: SessionCreateDTO,
    db: AsyncSession = Depends(get_session),
    auth0_id: str = Depends(get_current_user_id),         # ✅ verifica el JWT
):
    user = await user_service.get_or_create_from_auth0_id(db, auth0_id)  # auth0_id -> user.id
    return await session_service.create_session(db, user.id, data.title)
```

Aplica el mismo cambio en los 4 handlers de `sessions.py` y los 2 de `messages.py`: importas
`get_current_user_id` y `user_service`, reemplazas `user_id: int = 1` por
`auth0_id: str = Depends(get_current_user_id)`, y al inicio del handler haces
`user = await user_service.get_or_create_from_auth0_id(db, auth0_id)` para usar `user.id`.

> Resultado: cualquier llamada sin un JWT válido recibe **401** automáticamente (lo lanza la
> dependency `get_current_user_id`).

---

## Paso 9 — Frontend: login real con Auth0

**📋 Dependencia — desde `frontend/`:**
```bash
npm install @auth0/auth0-react
```

**📋 Código a copiar — `frontend/.env`:**
```bash
VITE_AUTH0_DOMAIN=dev-xxxx.us.auth0.com
VITE_AUTH0_CLIENT_ID=<Client ID de la SPA en Auth0>
VITE_AUTH0_AUDIENCE=https://api.agent-stack.com
VITE_API_URL=http://localhost:8000
```

**📋 Código a copiar — `frontend/src/main.tsx`** (envuelve la app con el proveedor de Auth0):
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { Auth0Provider } from '@auth0/auth0-react'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
        scope: "openid profile email",
      }}
      cacheLocation="memory"      // el token vive en memoria (no en localStorage -> seguro vs XSS)
      useRefreshTokens={true}     // renueva el token sin re-loguear
    >
      <App />
    </Auth0Provider>
  </React.StrictMode>,
)
```

**📋 Código a copiar — `frontend/src/api/client.ts`** (centraliza el JWT + las cookies):
```tsx
import { useAuth0 } from '@auth0/auth0-react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export function useApiClient() {
  const { getAccessTokenSilently } = useAuth0()

  async function fetchWithAuth(endpoint: string, options: RequestInit = {}) {
    const token = await getAccessTokenSilently()    // JWT (se renueva solo si expiró)
    const response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers,
      },
      credentials: 'include',    // manda las cookies (clave para SSE)
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
      throw new Error(error.detail || `HTTP ${response.status}`)
    }
    return response
  }

  return { fetchWithAuth }
}
```

**📋 Código a copiar — `frontend/src/api/sse.ts`** (el intercambio JWT→cookie + abrir el stream):
```tsx
import { useAuth0 } from '@auth0/auth0-react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export function useSSE() {
  const { getAccessTokenSilently } = useAuth0()

  async function streamMessage(sessionId: number, message: string) {
    // Paso 1: cambiar el JWT por la cookie de stream (EventSource no manda headers)
    const token = await getAccessTokenSilently()
    await fetch(`${API_URL}/auth/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',   // guarda la cookie
    })

    // Paso 2: abrir el SSE; el navegador manda la cookie solo
    const params = new URLSearchParams({ session_id: String(sessionId), message })
    const es = new EventSource(`${API_URL}/stream/?${params}`, { withCredentials: true })
    return es   // (en la receta 04/05 le enganchamos los handlers de eventos)
  }

  return { streamMessage }
}
```

**📋 Código a copiar — botones de login/logout:**
```tsx
// frontend/src/components/Auth/LoginButton.tsx
import { useAuth0 } from '@auth0/auth0-react'
export function LoginButton() {
  const { loginWithRedirect } = useAuth0()
  return <button onClick={() => loginWithRedirect()}>Log In</button>
}

// frontend/src/components/Auth/LogoutButton.tsx
import { useAuth0 } from '@auth0/auth0-react'
export function LogoutButton() {
  const { logout } = useAuth0()
  return <button onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
    Log Out
  </button>
}

// frontend/src/components/Auth/AuthButton.tsx  (muestra uno u otro según el estado)
import { useAuth0 } from '@auth0/auth0-react'
import { LoginButton } from './LoginButton'
import { LogoutButton } from './LogoutButton'
export function AuthButton() {
  const { isAuthenticated, isLoading, user } = useAuth0()
  if (isLoading) return <div>Loading...</div>
  if (!isAuthenticated) return <LoginButton />
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <span>Hello, {user?.name || user?.email}</span>
      <LogoutButton />
    </div>
  )
}
```

---

## Paso 10 — Probar el flujo completo

**📋 Comandos (necesitas un token; consíguelo con la app M2M o desde el navegador):**
```bash
# 1. Sin auth -> 401
curl http://localhost:8000/api/sessions/

# 2. Con JWT -> crea sesión (ahora con tu user real)
curl -X POST http://localhost:8000/api/sessions/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"title":"Test"}'

# 3. Intercambiar JWT por cookie de SSE (mira el Set-Cookie)
curl -X POST http://localhost:8000/auth/session \
  -H "Authorization: Bearer $TOKEN" -c cookies.txt -v
# -> Set-Cookie: stream_session=...; HttpOnly; Max-Age=600; Path=/stream/; SameSite=lax

# 4. En el navegador: localhost:5173 -> "Log In" -> Auth0 -> vuelve -> "Hello, [nombre]"
```

---

## Conceptos clave de esta parte

- **Auth híbrido:** JWT para la API (fetch manda headers), cookie para SSE (EventSource no puede).
- **Stateless:** ni el JWT ni la cookie requieren consultar la BD; solo se verifica una firma.
- **Bridge pattern:** `auth0_id` (externo) ↔ `user.id` (interno), traducido en `user_service`.
- **`core/auth.py` (lógica pura) vs `api/auth.py` (rutas HTTP) vs `core/cookies.py` (atributos).**
- **Reglas:** ✅ JWT en header `Authorization`; cookie corta solo para SSE; `SameSite/Secure`
  correctos. ❌ tokens en la URL (`?token=`), en `localStorage`, o `*` en CORS con credenciales.

## Gotchas (errores comunes)

| Síntoma | Causa | Fix |
|---|---|---|
| `ModuleNotFoundError: app.core.cookies` | falta el archivo | crear `core/cookies.py` |
| settings de auth0 duplicadas | declaradas dos veces (una vacía) | dejar solo las que tienen validator |
| `SESSION_COOKIE_MAX_AGE=600 # 10 min` rompe pydantic | comentario inline en el `.env` | comentario en línea aparte |
| botón de login "no hace nada" | `VITE_AUTH0_*` llegaban `undefined` al container | agregar `env_file: ../frontend/.env` al servicio + rebuild |
| Auth0 `invalid_request` al loguear | Client ID era el de la M2M, no el de la SPA; o falta User-delegated Access | usar el Client ID de la SPA; activar el toggle de la API |
| `false is not a function` en el front | ASI: `let closed = false` sin `;` antes de `(async()=>{` | poner el `;` |

## Transparencia y debugging (auth)

> Auth es donde más tiempo se pierde, casi siempre por un `401` que no sabes de dónde viene. Estas
> tácticas te dan visibilidad.

### Mirar qué trae un JWT por dentro

Un JWT no está encriptado, solo firmado: **cualquiera puede leer su contenido** (la firma solo
impide *modificarlo*). Para ver sus claims (los datos del token) sin verificar la firma:

```bash
# con la librería que ya tienes (python-jose), dentro del container
cd infra
docker compose exec backend uv run python -c "
from jose import jwt
t = '$TOKEN'
print('HEADER:', jwt.get_unverified_header(t))   # alg, kid (qué llave usar)
print('CLAIMS:', jwt.get_unverified_claims(t))    # sub, aud, iss, exp...
"
```
Qué revisar (las 3 causas más comunes de `401`):
- **`aud`** (audience) debe ser **idéntico** a tu `AUTH0_AUDIENCE`. Si no, → `Invalid token claims`.
- **`iss`** (issuer) debe coincidir con `https://<AUTH0_DOMAIN>/` (¡ojo con la barra final!).
- **`exp`** (expiración): si ya pasó, → `Token has expired`. Pide uno nuevo.

> También puedes pegar el token en https://jwt.io para verlo decodificado. **Nunca** pegues ahí un
> token de producción real.

### Conseguir un token de prueba sin navegador (M2M)

Para probar la API con `curl` necesitas un token. Con la app M2M de Auth0:
```bash
curl -X POST https://<AUTH0_DOMAIN>/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<M2M_CLIENT_ID>","client_secret":"<SECRET>","audience":"https://api.agent-stack.com","grant_type":"client_credentials"}'
export TOKEN="<access_token de la respuesta>"
```

### Inspeccionar la cookie de SSE

Usa `curl -v` para ver el header `Set-Cookie` completo (con sus flags):
```bash
curl -v -X POST http://localhost:8000/auth/session -H "Authorization: Bearer $TOKEN" -c cookies.txt
# Busca en la salida:
# < set-cookie: stream_session=...; HttpOnly; Max-Age=600; Path=/stream/; SameSite=lax
```
Verifica que tenga **`HttpOnly`**, **`Path=/stream/`** y el `Max-Age` correcto. Si falta `Path`,
la cookie viajaría a `/api/` (mal).

### Diagnosticar el `401` paso a paso

1. ¿El JWKS de Auth0 responde? `curl https://<AUTH0_DOMAIN>/.well-known/jwks.json` (debe dar JSON
   con `keys`). Si falla, `verify_jwt` no puede validar nada.
2. ¿El `aud`/`iss` del token coinciden con tus settings? (decodifícalo, arriba).
3. ¿El endpoint manda el header? `curl -v ... -H "Authorization: Bearer $TOKEN"` y confirma que
   sale en la petición.
4. **`GET /auth/me` es tu mejor sonda:** si te devuelve tu perfil, el JWT está OK y el problema está
   en otra parte; si da `401`, el problema es el token/config.

### En el navegador (DevTools)

- **Network → la petición:** mira que vaya el header `Authorization: Bearer ...` y, en la respuesta
  de `/auth/session`, el `Set-Cookie`.
- **Application → Cookies:** ahí SÍ ves la cookie `stream_session` aunque sea `HttpOnly` (lo que no
  puede es leerla el JavaScript; DevTools sí la muestra).
- **Console:** los errores de Auth0 (`invalid_request`, `login_required`) salen acá.

### Logs del backend

Con `make logs-backend` ves el auto-registro del usuario (el `INSERT` en `users` la primera vez) y,
gracias al `echo` del engine, las queries de `get_or_create_from_auth0_id`. Si un usuario "se
duplica" o no aparece, esos logs te lo muestran.

---

## Checklist de "auth lista"

- [ ] `GET /api/sessions/` **sin** token → `401`
- [ ] `GET /api/sessions/` **con** JWT válido → `200` (y usa tu user real, no el id 1)
- [ ] `POST /auth/session` con JWT → `204` + header `Set-Cookie: stream_session=...; HttpOnly`
- [ ] En el navegador: "Log In" redirige a Auth0 y al volver muestra "Hello, [tu nombre]"
- [ ] La cookie tiene `Path=/stream/` (no viaja a `/api/`)
