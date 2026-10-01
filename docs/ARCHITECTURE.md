# Company OS — Diseño v0: Observador visual

> Estado: fases 0.1–0.4 implementadas (observador + departamentos). Siguiente: 0.5 oficina visual.
> Fecha: 2026-09-30
>
> Correr: `npm install` y luego `npm start` → http://127.0.0.1:4747 · `npm run scan` (resumen en
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

Derivados solo de los eventos (no hay otra señal):

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
