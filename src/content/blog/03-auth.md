---
title: "Construyendo a hey-frank #3 — Auth con Firebase"
fecha: 2026-06-18
tipo: "hey frank"
resumen: "Login con Firebase: verificar el ID token, la cookie firmada para SSE y proteger los endpoints."
draft: false
---

> **Qué conseguimos al terminar:** login real (Google y/o email) con **Firebase**, verificación del token en la
> API, la cookie firmada para el streaming (SSE), y el reemplazo del `user_id = 1` placeholder por
> la identidad real.

> **Crédito:** estas notas están fuertemente basadas en la serie *Building a Production-Ready Agent
> Stack* de **Bedir Tapkan** ([bedirtapkan.com](https://bedirtapkan.com)). Gracias por el material
> original; acá lo adapté a mi stack (Gemini/ADK + Firebase).

---

## Cuál es el plan

Queremos proteger con autenticación dos cosas, y necesitan **dos mecanismos**:

1. **La API REST** → la llamas con `fetch()`, que sí manda headers. Usas un **JWT** (JSON Web Token:
   un "pase" firmado) en `Authorization: Bearer <token>`.
2. **El streaming (SSE)** → se abre con `EventSource`, que **NO permite headers custom**. Solución:
   una **cookie firmada** que el navegador manda solo.

```
API REST  →  Authorization: Bearer <ID token de Firebase>
SSE       →  Cookie firmada HttpOnly (el navegador la manda solo)
```

Firebase es el **proveedor OIDC**: maneja el login y le da al frontend un **ID token** (JWT firmado
por Firebase). Tu backend solo lo **verifica**. El `audience` e `issuer` se derivan de tu
**project id**.

> Para *verificar* tokens NO necesitas la SDK `firebase-admin` ni un service account — basta
> `google-auth` con el project id. (La SDK admin solo hace falta para operaciones server-side como
> revocar sesiones o gestionar usuarios.)

---

## Paso 1 — Crear el proyecto Firebase

**📋 En console.firebase.google.com:**
1. **Add project**.
2. **Build → Authentication → Get started.**
3. **Sign-in method**: habilita **Google** (y **Email/Password** si quieres).
4. **Project settings → Your apps → Web app (`</>`)**: registra una app web y copia el objeto
   `firebaseConfig` (apiKey, authDomain, projectId, appId) — **son públicos**, van en el frontend.
5. Anota el **Project ID** (lo usa el backend como audience).

---

## Paso 2 — Dependencias del backend

**📋 Comando — desde `backend/`:**
```bash
uv add google-auth requests itsdangerous
```
- **google-auth** + **requests** → verifican el ID token de Firebase (firma, issuer, audience, exp).
- **itsdangerous** → firma la cookie de SSE (HMAC).
> ⚠️ `requests` es obligatorio: lo usa el transport de google-auth.

---

## Paso 3 — Settings + `.env`

**📋 Agregar a `core/settings.py`:**
```python
# Firebase
firebase_project_id: str

# Firma de la cookie de SSE
cookie_secret: str
session_cookie_name: str = "stream_session"
session_cookie_max_age: int = 600  # 10 minutos
api_base_url: str | None = None

@field_validator("cookie_secret")
@classmethod
def validate_cookie_secret(cls, v: str) -> str:
    if len(v) < 32:
        raise ValueError("COOKIE_SECRET must be at least 32 characters.")
    return v
```
**📋 `backend/.env`:**
```bash
FIREBASE_PROJECT_ID=mi-proyecto-firebase
COOKIE_SECRET=<mín 32 chars: python -c "import secrets; print(secrets.token_urlsafe(32))">
SESSION_COOKIE_NAME=stream_session
SESSION_COOKIE_MAX_AGE=600
```

---

## Paso 4 — `core/auth.py`: verificación + cookie

**Por qué:** lógica pura de auth. 
- (a) Verifica el ID token de Firebase, 
- (b) Firma/verifica la cookie de SSE, 
- (c) Expone dependencies de FastAPI.

> **En puertos y adaptadores:** `verify_jwt` es el **adaptador de salida de identidad**. Su contrato:
> "dame un token, te digo quién es". Hoy lo cumple Firebase; cambiarlo por Auth0 sería otro
> adaptador, sin tocar el núcleo.

**📋 Código — `backend/app/core/auth.py`:**
```python
import hashlib

from fastapi import HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from app.core.settings import settings

security = HTTPBearer()                        # hace que Swagger muestre "Authorize"
_google_request = google_requests.Request()    # cachea los certs de Firebase


# --- Verificación del ID token de Firebase ---
async def verify_jwt(token: str) -> dict:
    """Verifica un ID token de Firebase. Devuelve el payload o lanza 401."""
    try:
        # firma + exp + issuer (securetoken.google.com/<pid>) + audience (<pid>)
        return id_token.verify_firebase_token(token, _google_request, settings.firebase_project_id)
    except ValueError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {e}")


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(security),
) -> dict:
    return await verify_jwt(credentials.credentials)


async def get_current_user_id(user: dict = Security(get_current_user)) -> str:
    return user["sub"]   # el uid de Firebase


# --- Cookie firmada para SSE (HMAC-SHA256) — agnóstica del proveedor ---
cookie_signer = URLSafeTimedSerializer(
    settings.cookie_secret, salt="stream-session",
    signer_kwargs={"digest_method": hashlib.sha256},
)


def create_stream_cookie(user_id: str) -> str:
    return cookie_signer.dumps(user_id)


def verify_stream_cookie(cookie_value: str) -> str:
    try:
        return cookie_signer.loads(cookie_value, max_age=settings.session_cookie_max_age)
    except SignatureExpired:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Stream session expired.")
    except BadSignature:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid stream session cookie")


async def get_user_from_stream_cookie(request: Request) -> str:
    cookie_value = request.cookies.get(settings.session_cookie_name)
    if not cookie_value:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "No stream session. Call POST /auth/session first.")
    return verify_stream_cookie(cookie_value)
```


---

## Paso 5 — `core/cookies.py`: atributos según entorno

**Por qué:** una cookie no es solo un valor — viaja con **atributos** que le dicen al navegador
*cuándo* mandarla y *cuándo* protegerla. Si los pones mal, pasa una de dos: o el navegador **no
manda** la cookie (y el SSE falla con 401), o la manda de forma **insegura** (viaja por HTTP plano y
cualquiera la lee). El problema es que los valores correctos **dependen del entorno**: en `localhost`
(dev) y en producción con HTTPS las reglas del navegador son distintas. Esta función calcula los
atributos correctos para cada caso, en un solo lugar.

**📋 Código:**
```python
from urllib.parse import urlparse

from app.core.settings import settings


def cookie_attrs_for_sse():
    origin = (settings.cors_origins or [""])[0]
    api = settings.api_base_url or origin
    o, a = urlparse(origin), urlparse(api)
    cross_site = (o.scheme, o.hostname, o.port) != (a.scheme, a.hostname, a.port)
    same_site = "none" if cross_site else "lax"
    secure = settings.env != "development" or cross_site
    return same_site, secure, "/stream/"   # la cookie solo viaja a /stream/
```
### Los cuatro atributos, uno por uno

- **HttpOnly** — la cookie es **invisible a JavaScript** (`document.cookie` no la ve). Protege de
  XSS (Cross-Site Scripting: si un atacante logra inyectar JS en tu página, igual no puede robar la
  cookie). Tu sesión de stream nunca necesita leerse desde JS, así que va `HttpOnly` siempre.
- **Path=/stream/** — la cookie **solo se manda a URLs que empiezan con `/stream/`** (los endpoints
  del agente, receta 04). A `/api/...` no viaja. Es el principio de mínimo privilegio: la credencial
  de SSE no anda paseándose por toda la app.
- **Max-Age=600** — vive **10 minutos** y el navegador la borra sola. Una sesión de stream es de
  corta duración; no queremos una cookie eterna. (Sale de `settings.session_cookie_max_age`.)
- **Secure** — si está activo, el navegador **solo manda la cookie por HTTPS** (no por HTTP plano).
  Imprescindible en producción; en `localhost` (que es HTTP) tiene que ir apagado, o el navegador
  nunca mandaría la cookie en dev. De ahí que se calcule según el entorno (ver abajo).

### Por qué `SameSite` y `Secure` se calculan (no son fijos)

El meollo de la función es decidir dos atributos que **dependen de si el front y el back están en el
mismo sitio o no**:

```python
cross_site = (o.scheme, o.hostname, o.port) != (a.scheme, a.hostname, a.port)
```
**`cross_site`** = ¿el origen del frontend y el de la API son *distintos sitios*? Compara esquema
(`http`/`https`), host y puerto. En dev, front en `:5173` y back en `:8000` → puertos distintos →
`cross_site = True`. En producción, si ambos cuelgan del mismo dominio → `False`.

```python
same_site = "none" if cross_site else "lax"
```
**`SameSite`** controla si la cookie viaja en peticiones **entre sitios** (otra reglas del navegador
contra CSRF):
- `"lax"` → solo viaja dentro del mismo sitio. Sirve cuando front y back comparten dominio.
- `"none"` → viaja también entre sitios distintos. **Necesario** cuando el front está en otro
  origen que la API (tu caso en dev). Ojo: el navegador exige que `SameSite=None` venga **siempre
  con `Secure`** — por eso la línea de abajo fuerza `secure` cuando hay cross-site.

```python
secure = settings.env != "development" or cross_site
```
**`Secure`** queda activo si **(a)** no estás en development (producción → HTTPS), **o** **(b)** hay
cross-site (porque `SameSite=None` lo obliga). Solo se apaga en el caso "dev y mismo sitio", que es
HTTP plano y donde un `Secure=True` rompería el envío de la cookie.

> **En una frase:** `HttpOnly` y `Path` son fijos (seguridad siempre); `SameSite` y `Secure` se
> ajustan según si front/back comparten sitio y si estás en dev o prod, para que la cookie **se mande
> cuando debe y solo de forma segura**.

**Cómo conecta:** esta función la llama `api/auth.py` (Paso 7) justo cuando hace `response.set_cookie(...)`
en `POST /auth/session`. Devuelve la tripleta `(same_site, secure, path)` que se le pasa a esa
llamada. Si alguna vez tu SSE "no recibe la cookie", el 90% de las veces el culpable es uno de estos
atributos mal calculado para tu entorno.

---

## Paso 6 — `user_service.py`: el puente de identidad

**Por qué:** el token trae el `sub` (el uid externo de Firebase). Internamente usamos un `user.id`
entero. Este service traduce uno en otro, creando el usuario en su primer login.

**📋 Código — `backend/app/domain/services/user_service.py`:**
```python
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import User
from app.persistence.repositories.user_repo import user_repo


class UserService:
    async def get_or_create_from_subject(   # "subject" = el claim "sub" del token de Firebase
        self, db: AsyncSession, subject: str,
        email: str | None = None, name: str | None = None,
    ) -> User:
        user = await user_repo.get_by_subject(db, subject)
        if user:
            updated = False
            if email is not None and user.email != email:
                user.email = email; updated = True
            if name is not None and user.name != name:
                user.name = name; updated = True
            if updated:
                await db.flush(); await db.refresh(user)
            return user

        from sqlalchemy.exc import IntegrityError
        try:
            return await user_repo.create(db, subject=subject, email=email, name=name)
        except IntegrityError:        # race condition: dos logins simultáneos
            await db.rollback()
            return await user_repo.get_by_subject(db, subject)


user_service = UserService()
```
> `subject` es el claim `sub` del token (el uid de Firebase). Nombre neutro, agnóstico del proveedor.

---

## Paso 7 — `api/auth.py`: endpoints de auth

**Por qué:** el endpoint que **intercambia el JWT por la cookie de SSE**, más perfil y logout.

**📋 Código — `backend/app/api/auth.py`:**
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
    user_id: str = Depends(get_current_user_id),   # verifica el ID token
):
    async with db.begin():
        await user_service.get_or_create_from_subject(db, user_id)
    cookie_value = create_stream_cookie(user_id)
    same_site, secure, path = cookie_attrs_for_sse()
    response.set_cookie(
        key=settings.session_cookie_name, value=cookie_value,
        max_age=settings.session_cookie_max_age,
        httponly=True, secure=secure, samesite=same_site, path=path,
    )


@router.get("/me")
async def get_current_user_info(
    user_data: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    user = await user_service.get_or_create_from_subject(
        db, subject=user_data["sub"],
        email=user_data.get("email", ""), name=user_data.get("name", ""),
    )
    return {"id": user.id, "subject": user.subject,
            "email": user.email, "name": user.name,
            "created_at": user.created_at.isoformat()}


@router.delete("/session", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session_cookie(response: Response):
    response.delete_cookie(key=settings.session_cookie_name, path="/stream/")
```
Registra el router en `main.py`: `from app.api import auth; app.include_router(auth.router)`.

---

## Paso 8 — Proteger los endpoints (¡adiós `user_id = 1`!)

Antes de tener auth, los endpoints usaban `user_id: int = 1`. Ahora sacamos la identidad real del token.
El patrón se repite en cada handler de **dos archivos**:

- `backend/app/api/sessions.py` — **4 handlers**: `create_session`, `list_sessions`, `get_session`, `delete_session`.
- `backend/app/api/messages.py` — **2 handlers**: `create_message`, `list_messages`.

En los 6 es el mismo cambio: borras el `user_id: int = 1` y lo reemplazas por
`subject: str = Depends(get_current_user_id)`, y al inicio del handler traduces `subject → user.id`
con `user_service.get_or_create_from_subject`.

```python
# ANTES:
async def create_session(data, db=Depends(get_session), user_id: int = 1):
    return await session_service.create_session(db, user_id, data.title)

# AHORA:
from app.core.auth import get_current_user_id
from app.domain.services.user_service import user_service

async def create_session(data, db=Depends(get_session),
                         subject: str = Depends(get_current_user_id)):   # verifica el JWT
    user = await user_service.get_or_create_from_subject(db, subject)   # sub -> user.id
    return await session_service.create_session(db, user.id, data.title)
```
Aplica lo mismo a los 4 handlers de `backend/app/api/sessions.py` y los 2 de
`backend/app/api/messages.py`. Resultado: cualquier llamada sin un token válido → **401** automático.

> 💡 **Ojo con los imports:** además de cambiar las firmas, agrega arriba de cada archivo
> `from app.core.auth import get_current_user_id` y `from app.domain.services.user_service import user_service`.
> Y como ahora `user_service.get_or_create_from_subject` puede escribir (crea el usuario en su primer
> login), recuerda que el commit lo sigue haciendo `get_db()` — no metas `db.begin()` en el handler.

---

## Paso 9 — Frontend: login con Firebase

**📋 Dependencia:**

Como el frontend corre en Docker y su `node_modules` es un **volumen aparte**
(`node_modules:/app/node_modules` en el compose), instala **dentro del container** para que Vite lo
vea. Desde `infra/`:
```bash
docker compose exec frontend npm install firebase
```
Eso instala `firebase` en el volumen del container y, como `/app` está bind-montado, actualiza tu
`package.json` y `package-lock.json` en el host. Si Vite no recarga solo: `docker compose restart frontend`.

> 🔁 **Discrepancia doc-vs-Docker:** un `npm install firebase` corrido solo en el host **no** llega
> al `node_modules` del container → Vite falla con `Failed to resolve import "firebase/auth"`. O lo
> instalas en el container (arriba), o instalas en el host y reinicias el frontend (el `command`
> corre `npm ci` al arrancar).
**📋 `frontend/.env`** (valores públicos):
```bash
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=mi-proyecto.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=mi-proyecto-firebase
VITE_FIREBASE_APP_ID=1:123:web:abc
VITE_API_URL=http://localhost:8000
```
**📋 `frontend/src/firebase.ts`:**
```ts
import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
})
export const auth = getAuth(app)   // los nombres pueden variar según tu versión de firebase
```
**📋 Login / logout / token — `frontend/src/auth.ts`:**

Un módulo pequeño que envuelve el SDK de Firebase en **tres funciones** que tu app React va a llamar.
(Va aparte de `firebase.ts`: ese **inicializa** la conexión al proyecto; este expone las **acciones**
de auth.)

```ts
import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'
import { auth } from './firebase'

export const loginWithGoogle = () => signInWithPopup(auth, new GoogleAuthProvider())
export const logout = () => signOut(auth)

// getIdToken() REFRESCA solo si expiró -> no te desloguea cada hora
export async function getToken(): Promise<string | null> {
  return auth.currentUser ? await auth.currentUser.getIdToken() : null
}
```

- **`loginWithGoogle`** — abre el **popup de Google**; el usuario elige su cuenta, Firebase lo
  autentica y **guarda la sesión en el navegador**. La conectas a un botón "Iniciar sesión".
- **`logout`** — **cierra la sesión**: borra el estado que Firebase guardó; tras esto
  `auth.currentUser` queda `null`.
- **`getToken`** — devuelve el **ID token** (el JWT) del usuario logueado, o `null` si no hay nadie.
  `getIdToken()` **refresca solo si expiró** (los tokens duran 1 h) → no te desloguea cada hora.

Ese ID token va como `Authorization: Bearer <token>` en `fetchWithAuth`, y en `POST /auth/session`
para obtener la cookie de SSE — igual que un JWT normal. (El `client.ts` y `sse.ts` quedan como en
el patrón estándar; solo cambia que el token sale de `getToken()`.)

```
loginWithGoogle()  →  Firebase guarda la sesión
       │
       ▼
   getToken()  →  el ID token (JWT)
       │
       ├──►  Authorization: Bearer <token>   en cada fetch a /api/...   (auth REST, Paso 8)
       └──►  POST /auth/session con ese Bearer  →  el backend devuelve la cookie de SSE (Paso 7)
```

> 💡 Ventaja Firebase: `getIdToken()` refresca en segundo plano. Usa `onIdTokenChanged(auth, cb)`
> para reaccionar en la UI. Los nombres pueden variar según el SDK que tengas instalado.

---

## Paso 10 — Probar que funciona (end-to-end)

La auth se prueba en **dos tandas**: lo que puedes verificar ya mismo (el rechazo, sin login), y el
camino feliz (con un token real). Hazlas en ese orden.

### A) El rechazo — pruébalo YA, sin frontend ni token

Esto no necesita Firebase configurado: solo confirma que los endpoints quedaron protegidos. Desde
`infra/`:

```bash
# Sin token → 401 (antes esto devolvía datos con user_id=1)
curl -i http://localhost:8000/api/sessions/

# Sin token tampoco te deja crear la cookie de SSE → 401/403
curl -i -X POST http://localhost:8000/auth/session
```

Si ves `HTTP/1.1 401 Unauthorized` en ambos, el Paso 8 quedó bien: ya nadie entra sin identidad.

> ✅ Marca del checklist: *`GET /api/sessions/` sin token → 401*.

### B) Conseguir un ID token real — dos caminos

El resto del checklist necesita un token de verdad. Tienes dos formas según qué proveedor activaste:

**Camino 1 — desde el navegador (Google).** Es el real de producción; lo haces en la parte C.

**Camino 2 — por `curl`, sin frontend (solo si activaste Email/Password).** Atajo para verificar el
backend sin UI. Pídele un token a la API REST de Firebase con tu `apiKey`:

```bash
# (una vez) crear un usuario de prueba
curl "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=TU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test1234","returnSecureToken":true}'

# loguearte para obtener el idToken
curl "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=TU_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test1234","returnSecureToken":true}'
```

Copia el `idToken` de la respuesta y úsalo contra tu backend:

```bash
TOKEN="pega-aquí-el-idToken"

# /auth/me debe devolver tu perfil (sub, email, name)
curl -s http://localhost:8000/auth/me -H "Authorization: Bearer $TOKEN"

# /auth/session debe devolver 204 + Set-Cookie (mira el -v)
curl -v -X POST http://localhost:8000/auth/session -H "Authorization: Bearer $TOKEN"
```

En el segundo, busca en la salida el header `Set-Cookie: stream_session=...; HttpOnly; Path=/stream/`.

### C) El camino feliz completo, en el navegador

La receta da las funciones de auth (`auth.ts`) pero no una UI con botones. Para probar, arma un
**componente de prueba desechable** en `frontend/src/App.tsx` (luego lo reemplazas por la UI real):

```tsx
import { useState } from 'react'
import { loginWithGoogle, logout, getToken } from './auth'

export default function App() {
  const [out, setOut] = useState('')

  async function probarMe() {
    const token = await getToken()
    const r = await fetch(`${import.meta.env.VITE_API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    setOut(JSON.stringify(await r.json(), null, 2))
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <button onClick={loginWithGoogle}>Login con Google</button>
      <button onClick={logout}>Logout</button>
      <button onClick={probarMe}>Probar /auth/me</button>
      <pre>{out}</pre>
    </div>
  )
}
```

Luego:

1. **Levanta todo** (desde la raíz): `make dev`. El front queda en `http://localhost:5173`.
2. **Abre** `http://localhost:5173` y abre las **DevTools** (F12) → pestaña **Network**.
3. Clic en **"Login con Google"** → elige tu cuenta en el popup. Si el navegador bloquea el popup,
   permítelo (gotcha `auth/popup-blocked`).
4. Clic en **"Probar /auth/me"** → abajo debe imprimirse tu perfil (`id`, `sub`, `email`, `name`).
   En Network verás el request a `/auth/me` con `Authorization: Bearer ...` y status `200`.
5. **Verifica la cookie de SSE**: en otra interacción que llame `POST /auth/session`, en Network ese
   request da `204` con `Set-Cookie`; en **Application → Cookies** verás `stream_session` marcada
   `HttpOnly` y `Path=/stream/` (no la puedes leer desde JS, por eso no aparece en `document.cookie`).
6. **Confírmalo en la consola de Firebase**: **Authentication → Users** — tu usuario debe aparecer
   listado tras el primer login.

> Si `/auth/me` da `401` con `Invalid token: ... audience`, casi seguro el `projectId` del frontend
> (`VITE_FIREBASE_PROJECT_ID`) y el `FIREBASE_PROJECT_ID` del backend no coinciden. Es el gotcha #1.

Con esto recorres el checklist de abajo de punta a punta.

---

## Conceptos clave

- **ID token, no access token:** usas el token de *identidad*; el `audience` es tu **project id**.
- **El proveedor OIDC es intercambiable:** el 95% de la auth no se entera del cambio.
- **La cookie de SSE es agnóstica:** la firmas con tu `COOKIE_SECRET`, da igual quién emitió el JWT.

## Transparencia y debugging (auth)

- **Ver qué trae el token:** un JWT no está encriptado, solo firmado. Decodifícalo en https://jwt.io
  (nunca un token de prod) o con `python -c "from jose import jwt; print(jwt.get_unverified_claims(t))"`.
  Revisa que `aud` == tu project id y que `exp` no haya pasado.
- **Inspeccionar la cookie:** `curl -v -X POST .../auth/session -H "Authorization: Bearer $TOKEN"` →
  mira el `Set-Cookie` (debe tener `HttpOnly; Path=/stream/`).
- **Sonda rápida:** `GET /auth/me` — si devuelve tu perfil, el token está OK.
- **DevTools:** Network (Authorization + Set-Cookie), Application→Cookies (la HttpOnly se ve ahí),
  Console (errores de Firebase como `auth/popup-blocked`).

## Checklist de "auth lista"

- [ ] `GET /api/sessions/` sin token → `401`
- [ ] `POST /auth/session` con un ID token de Firebase → `204` + `Set-Cookie`
- [ ] `GET /auth/me` devuelve `sub` (uid), `email`, `name`
- [ ] Tras ~1h la sesión sigue viva (refresh automático)
- [ ] El usuario aparece en Firebase → Authentication → Users
