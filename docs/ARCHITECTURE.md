# Company OS — Diseño v0: Observador visual

> Estado: fases 0.1–0.4 implementadas (observador + departamentos). Siguiente: 0.5 oficina visual.
> Fecha: 2026-09-30
>
> Correr: `npm install`, `npm run hats` (una vez) y luego `npm start` → http://127.0.0.1:4747 · `npm run scan` (resumen en
> terminal) · `npm test`

## 1. Objetivo

Ver en una interfaz visual, en tiempo real, qué están haciendo los agentes de Claude Code
en todos los proyectos de la empresa — **sin cambiar cómo se trabaja hoy** (Antigravity +
extensión de Claude para VS Code).

### No-objetivos (v0)

- No lanzar, detener ni dar instrucciones a agentes.
- No aprobaciones, no board de tareas, no Jev, no HATs ejecutables.
- No llamar a ningún modelo (cero tokens, cero horas del plan).
- No subir datos a la nube.

Todo eso viene después, construido encima de este observador (ver §10).

## 2. Principios

1. **Solo lectura.** El observador nunca escribe en `~/.claude/` ni en los repos.
2. **Local.** Los transcripts pueden contener código, rutas y secretos: no salen de la PC.
3. **Fuente de verdad = archivos.** La DB es un índice reconstruible; si se borra, se regenera.
4. **Lo que se ve es real.** La interfaz (incluida la vista tipo videojuego) solo representa
   eventos que existen en los transcripts.

## 3. Fuente de datos (verificada 2026-09-30)

Claude Code escribe un transcript JSONL por sesión:

```text
~/.claude/projects/
└── <cwd-codificado>/                     p.ej. c--Users-Perez-...-Projects-grupoveq
    ├── <sessionId>.jsonl                 sesión principal
    └── <sessionId>/subagents/
        ├── agent-<id>.jsonl              transcript del subagente
        └── agent-<id>.meta.json          {agentType, description, name, toolUseId, spawnDepth}
```

Campos útiles por línea (una línea = un evento JSON):

| Campo | Uso |
|---|---|
| `type` | `user`, `assistant`, `system`, `attachment`, `ai-title`, … |
| `sessionId`, `uuid`, `parentUuid` | identidad y encadenamiento |
| `timestamp` | orden y actividad reciente |
| `cwd`, `gitBranch` | **mapear sesión → proyecto** |
| `isSidechain` | evento de subagente |
| `aiTitle` (en `type: ai-title`) | título legible de la sesión |
| `message.model` | modelo usado (opus / sonnet / haiku) |
| `message.usage` | tokens: input, output, cache_read, cache_creation |
| `message.content[]` | bloques `text`, `thinking`, `tool_use` (`name`, `input`), `tool_result` |
| `toolUseResult` | resultado de herramienta (errores incluidos) |

### 3.1 Hooks HTTP (fuente oficial de estado)

Claude Code avisa cada evento (`SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SubagentStart/Stop`, `SessionEnd`,
`TeammateIdle`, `TaskCreated`, `TaskCompleted`…) con un `POST /hooks/<Evento>?t=<token>` a este servidor
(token en `data/hook-token.txt`; configurados en `~/.claude/settings.json`). El servidor responde siempre
`200 {}` y **solo guarda una lista blanca** de campos (`src/core/hooks.ts`, `sanitizeHook`):

| Campo guardado | Origen |
|---|---|
| sesión, evento, hora de recepción | `session_id`, ruta de la URL, reloj local |
| cwd | `cwd` |
| herramienta y archivo | `tool_name`, `tool_input.file_path` (nada más de `tool_input`) |
| tipo de aviso | `notification_type` |
| agente | `agent_id`, `agent_type` |
| equipo | `team_name`, `teammate_name` |
| (solo TaskCreated/TaskCompleted/TeammateIdle) | **nombres** de las claves del payload, nunca los valores |

Nunca se guardan prompts, comandos, contenidos de archivos ni respuestas del modelo. El payload crudo solo
se escribe con `COMPANY_OS_HOOK_DEBUG=1` en `data/hooks-events.ndjson`, con tope de 5 MB (el servidor
nunca borra ese archivo). Tablas (en `company-os.db`): `hook_events` (bitácora), `hook_state` (último
estado por sesión y agente) y `deliverables` (§3.2). **Estas tres tablas no se pueden reconstruir desde los
JSONL** y las migraciones no deben tocarlas.

### 3.2 Entregables

Un `Write`/`Edit`/`MultiEdit` con `file_path` dentro del vault, en `Proyectos/<slug>/<departamento>/…` y de
tipo texto (`.md .txt .json .csv .yaml`), crea o actualiza un entregable (ruta relativa, sesión, proyecto,
departamento, tipo, hora, HAT). Se registra por el hook `PostToolUse` (solo escrituras exitosas) y, de
respaldo, desde los `tool_use` de los JSONL (puede incluir una escritura que falló). El tipo sale del nombre
del archivo: `para-direccion` · `informe` · `revision` · `plan` · `brief` · `otro`. `GET /api/vault/file`
rechaza todo lo que no sea una ruta relativa limpia dentro del vault (`..`, absolutas, UNC, `:`, ocultas,
symlinks que salgan).

### 3.3 Respaldo de la DB

Pasados los `cleanupPeriodDays` de Claude Code los JSONL desaparecen; entonces `company-os.db` es el único
histórico de la actividad y de los hooks. Hay que tratarla como dato, no como caché (el respaldo automático
de la DB está pendiente de implementar).

Riesgo: el formato **no es una API pública** y puede cambiar entre versiones de Claude Code.
Mitigación: el parser ignora campos desconocidos, guarda `version` de cada evento, y tiene
tests con muestras reales anonimizadas.

## 4. Arquitectura

```text
~/.claude/projects/**/*.jsonl
            │  (watch: archivo nuevo / bytes nuevos)
            ▼
   ┌──────────────────┐
   │  Ingestor        │  lee incrementalmente (offset por archivo), parsea líneas,
   │                  │  tolera líneas corruptas / truncadas
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  SQLite (índice) │  company-os.db — reconstruible desde los JSONL
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  Servidor local  │  HTTP + SSE (eventos en vivo) en 127.0.0.1
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  Dashboard web   │  localhost:xxxx en el navegador
   └──────────────────┘
```

Un solo proceso Node (`company-os start`). Se puede dejar corriendo en segundo plano.

## 5. Stack

| Pieza | Elección | Por qué |
|---|---|---|
| Runtime | Node 24 + TypeScript | ya instalado; mismo lenguaje en back y front |
| DB | `node:sqlite` (integrado en Node) | sin dependencias nativas que compilar en Windows |
| Watch | `chokidar` | watch fiable en Windows/OneDrive |
| Servidor | Hono | ligero, SSE sencillo |
| Frontend | Vite + React | rápido de iterar |
| Vista "oficina" (fase posterior) | PixiJS o React Flow | animación 2D sobre eventos reales |
| Tests | Vitest | fixtures JSONL reales anonimizadas |

Monorepo simple: `packages/core` (ingestor + DB), `packages/server`, `packages/web`.

## 6. Modelo de datos (SQLite)

```text
projects      id, name, slug, root_path, vault_path?, first_seen, last_activity
sessions      id (sessionId), project_id, title, cwd, git_branch, model,
              started_at, last_event_at, status, tokens_in, tokens_out, tokens_cache
agents        id, session_id, parent_agent_id?, kind (main|subagent), agent_type,
              name, description, spawn_depth, started_at, last_event_at, status
events        id (uuid), agent_id, ts, kind (prompt|text|thinking|tool_use|tool_result|
              error|system), tool_name?, summary, tokens_in?, tokens_out?
files_touched agent_id, path, op (read|edit|write), ts
ingest_state  file_path, byte_offset, mtime            ← para lectura incremental
```

`events.summary` guarda un **resumen corto** (p.ej. `Edit src/main.py`), no el contenido
completo del mensaje. El detalle completo se lee bajo demanda del JSONL.

## 7. Estados de un agente

Hay dos fuentes, en este orden:

1. **Hooks (oficial).** El último aviso de cada agente decide su estado (agente principal = eventos sin
   `agent_id`; subagente = `agent-<agent_id>`). Tabla final:

| Aviso | Estado | Texto (`waitingKind`) |
|---|---|---|
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart` | 🟢 Trabajando | |
| `PostToolUseFailure`, `StopFailure` | 🔴 Error | |
| `PermissionRequest`, `Notification` `permission_prompt` | 🟡 Esperando | "pide permiso" (`permission`) |
| `Notification` `idle_prompt` / `elicitation_dialog`, `PreToolUse` de `AskUserQuestion` | 🟡 Esperando | "te pregunta" (`question`) |
| `Stop` | 🟡 Esperando | "terminó" (`finished`), o "entregó" (`delivered`) si ese turno escribió un entregable |
| `SessionEnd`, `SessionStart` | ⚪ Inactivo | |
| `SubagentStop` | ⚫ Terminado (subagente) | |

   Notas: un `idle_prompt` que llega después de un `Stop` no degrada "terminó/entregó" a "te pregunta" (es solo
   el recordatorio de que Claude sigue inactivo). Un subagente que pide permiso o pregunta convierte a la sesión
   entera en 🟡. Las sesiones automáticas (`claude -p`) siguen terminando en ⚫ "hecho".
   **El turno** empieza en el último `UserPromptSubmit` (o en el primer aviso visto de la sesión).
2. **JSONL (respaldo).** Se usa cuando no hay avisos recientes del agente: el último hook tiene más de 10 min
   estando en 🟢/🔴; o los JSONL traen eventos más de 2 min más nuevos que el último hook (se perdieron
   avisos: servidor apagado o hooks sin instalar). Un 🟡 de hooks vence a las 2 h (pasa a ⚪), igual que el de
   los JSONL. La API indica de dónde salió cada estado en `statusSource` (`hooks` | `transcript`).

Reglas de respaldo, derivadas solo de los eventos del transcript:

| Estado | Regla |
|---|---|
| 🟢 Trabajando | último evento < 60 s y es `tool_use`, `thinking` o salida en curso |
| 🟡 Esperando al humano | último evento es texto final del asistente (turno terminado) o una pregunta |
| 🔵 Subagentes activos | tiene subagentes en 🟢 |
| 🔴 Error | último `tool_result` con error o `system` de error |
| ⚪ Inactivo | sin eventos > 10 min |
| ⚫ Terminado | subagente cuyo resultado ya volvió al padre |

Los umbrales (60 s, 10 min) son configurables.

## 8. Mapeo sesión → proyecto

1. Si el vault tiene `proyectos/<slug>/PROYECTO.md` con `repo_path:` que coincide con el
   `cwd` de la sesión (o es prefijo) → ese proyecto.
2. Si no, se crea un proyecto "sin clasificar" con el nombre de la carpeta del `cwd`.
3. Desde el dashboard se ve qué carpetas están sin clasificar (en v0, se corrige editando
   `PROYECTO.md`, no desde la UI).

## 9. Pantallas (v0)

**A. Empresa (home)** — todos los proyectos con su actividad.

```text
🏢 EMPRESA                                  hoy: 1.2M tokens · 7 sesiones
├── orquestador v1   🟢 Opus · "Company OS diseño" · Write docs/DESIGN.md
│     └── Explore     🟢 Grep "subagents" en ~/.claude
├── grupoveq         ⚪ hace 2 h
└── cumbre-real      🟡 esperando respuesta · hace 4 min
```

**B. Proyecto** — sesiones del proyecto (activas e históricas), tokens por día, modelos
usados, archivos más tocados.

**C. Sesión / agente** — línea de tiempo en vivo: prompts, herramientas, archivos,
subagentes (árbol por `spawnDepth`), tokens acumulados, errores.

**D. (Fase posterior) Oficina** — cada proyecto es un piso, cada departamento una sala,
cada agente un personaje cuya animación depende de su estado real y herramienta actual.

## 10. Vault de la empresa

Separado del repo de código. Vive en `C:\Users\Perez\COMPANY OS` (variable `COMPANY_OS_VAULT`
para cambiarlo). No está dentro de OneDrive: conviene respaldarlo (git propio o copia periódica).

```text
COMPANY OS/
├── _empresa/
│   ├── departamentos/        direccion.md, desarrollo.md, diseno.md, marketing.md, research.md
│   ├── hats/                 backend-dev.md, copywriter.md, … (biblioteca, uso futuro)
│   ├── convenciones.md
│   └── plantillas/           PROYECTO.md, brief.md, …
└── Proyectos/
    └── <slug>/               p.ej. cumbre-real
        ├── PROYECTO.md       repo_path, stack, cliente, estado, departamentos activos
        ├── direccion/
        ├── desarrollo/       notas y decisiones; el código sigue en su repo (.ai/)
        ├── diseno/
        ├── marketing/
        │   └── 2026-09-30-carrusel-semanal/
        │       ├── brief.md
        │       ├── copys.md
        │       └── assets/
        └── research/
```

Convenciones: carpetas en minúsculas sin espacios ni acentos; fechas `AAAA-MM-DD` al inicio.

En v0 el observador **solo lee** el vault: `PROYECTO.md` para el mapeo (§8), las fichas de
departamento y los archivos de cada carpeta de departamento (visor de `.md/.txt/.json/.csv/.yaml`).

### Departamentos

Definidos en `_empresa/departamentos/<slug>.md` con `nombre:`, `icono:` y `palabras:` (editable;
crear un `.md` nuevo añade un departamento). Cada sesión se asigna así:

1. Sesión abierta dentro de `Proyectos/<proyecto>/<departamento>/` → ese departamento.
2. Palabras clave en el título de la sesión (sin acentos, palabra completa; gana la que más coincide).
3. Si nada coincide → `desarrollo`.

Los subagentes heredan el departamento de su sesión. La pantalla **Proyecto** (`#/p/<key>`)
muestra una sala por departamento: quién trabaja ahora, sesiones recientes y entregables del vault.

### HATs

Roles de agente definidos en el vault (`_empresa/hats/*.md`, formato de subagente de Claude Code
+ campo `departamento`). El repo trae 9 HATs base en `hats/` que siembran el vault la primera vez.
`npm run hats` instala los HATs del vault en `~/.claude/agents/` (nunca sobrescribe un agente
escrito a mano: solo los que llevan la marca `company-os:hat`). `npm run hats -- list` los muestra.

El observador lee el mapa HAT → departamento: un subagente cuyo `agentType` es un HAT se sienta en
la estación de ese departamento (con sombrero), aunque su sesión padre sea de otro departamento.
Los subagentes sin HAT siguen dibujándose como drones junto a su agente principal.

## 11. Privacidad y seguridad

- Servidor ligado a `127.0.0.1`, no a la red.
- El dashboard muestra resúmenes; el contenido completo solo al abrir un evento.
- Redacción básica en resúmenes: patrones de llaves (`sk-`, `eyJ…`, `SUPABASE_…=`) → `•••`.
- `company-os.db` en `.gitignore`.

## 12. Fases

| Fase | Entregable | Criterio de "listo" |
|---|---|---|
| 0.1 | Ingestor + SQLite + CLI `company-os scan` | indexa los ~32 transcripts actuales sin errores; tokens por sesión coinciden con suma manual |
| 0.2 | Watch en vivo + servidor SSE | un `Edit` en VS Code aparece en < 2 s |
| 0.3 | Dashboard: pantallas A, B, C | se ve esta misma sesión con su árbol de subagentes |
| 0.4 | Vault + mapeo por `PROYECTO.md` | sesiones de Cumbre Real agrupadas bajo `cumbre-real` |
| 0.5 | Vista "oficina" (D) | personajes animados según estados de §7 |

Después (fuera de v0): memoria de empresa consultable por agentes, biblioteca de HATs
instalable en proyectos (`.claude/agents/`), board de tareas, aprobaciones humanas,
spawner headless, Jev como decisor.

## 13. Qué se reutiliza de ai-orch

- El contrato `.ai/` de cada repo (CONTEXT, DECISIONS, ALERTS, PENDING) se mostrará en la
  pantalla de proyecto (fase posterior a 0.3).
- Lecciones: parsers tolerantes a archivos corruptos, prefijos `[OK]/[WARN]/[ERROR]` en CLI,
  contratos de datos tipados (TypedDict → tipos TS), log local de errores tragados.

## 14. Preguntas abiertas

1. ¿Qué proyectos se dan de alta en el vault? (hoy: Cumbre Real, Company OS)
2. ¿El vault va en su propio repo git para respaldo?
3. ¿El dashboard debe arrancar solo con Windows o se lanza a mano?
4. ¿Antigravity guarda logs de su agente propio en disco? (si sí, podría añadirse como
   segunda fuente)
