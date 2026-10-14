# Agent map de Anthropic y cómo empatarlo con Company OS

> Investigación: 2026-10-14 · HAT `investigador` · Claude Code local en v2.1.300
> Fuentes abiertas: 12 (10 con WebFetch y 2 docs descargadas con curl), más búsquedas web y la API de búsqueda de GitHub.

## 1. Preguntas

1. ¿Qué publicó Anthropic en 2026 para ver agentes y subagentes de Claude Code (tareas, estado, tokens)? ¿Cuál es "el git" que vio el dueño?
2. ¿Qué datos da cada fuente (transcripts, hooks, OTel, `claude agents --json`)? ¿Cuáles ya consumimos?
3. ¿Qué adoptamos, y cómo sería una vista de agentes más limpia que respete PRODUCT.md?

## 2. Resumen ejecutivo

- **Lo que vio el dueño casi seguro es el "agent map" de la extensión de Claude Code para VS Code.** Salió en **Claude Code v2.1.269 (11-sep-2026)**. Abajo de la caja de prompt aparece una píldora "N agents". Al abrirla, muestra **un árbol con los subagentes bajo el agente principal**. Cada uno lleva **estado, tiempo transcurrido y tokens**. También tiene tarjetas con el prompt y las tool calls, el transcript en solo lectura y un botón Stop. El dueño trabaja en VS Code/Antigravity con la extensión, así que encaja con lo que describe. (Confianza alta.)
  - Doc oficial: https://code.claude.com/docs/en/vs-code (sección "Use the prompt box" → *Agent map*)
  - Nota de versión: https://github.com/anthropics/claude-code/releases/tag/v2.1.269
- **"El git" es, con toda probabilidad, el repo `anthropics/claude-code`**: sus Releases y su CHANGELOG.md anuncian ahí el agent map. **No encontré ningún repo nuevo de Anthropic dedicado a un agent map o a observabilidad.** Revisé los 33 repos que creó `anthropics` desde marzo de 2026 (búsqueda `org:anthropics created:>2026-03-01`). (Confianza media-alta: es una inferencia, pero no hay otro candidato.)
- **La otra novedad grande es *Agent view* (`claude agents`, CLI, research preview).** Se anunció el 11-may-2026 en https://claude.com/blog/agent-view-in-claude-code y la doc está en https://code.claude.com/docs/en/agent-view. Es una lista de sesiones en segundo plano agrupadas por estado: *Needs input* arriba, luego *Working* y *Completed*. Cada fila tiene un resumen de una línea generado por un modelo Haiku. **No muestra tokens ni costo ni subagentes.** Sí tiene salida `claude agents --json` con `status`/`waitingFor`.
- **Para nosotros, el hallazgo más importante no es una feature nueva. Son dos huecos en nuestro estado "quién te necesita":**
  1. **Bug verificado.** Los subagentes en segundo plano, que hoy son el modo por defecto, se marcan como **"Terminado" en cuanto se lanzan**. La herramienta Agent devuelve al instante un `tool_result` con `status: "async_launched"`, y `buildAgents` toma cualquier `tool_result` del `spawn_tool_use_id` como "ya volvió".
  2. **Un agente esperando un permiso se ve como "Trabajando"**: el último evento es un `tool_use` sin resultado. Los transcripts no registran el prompt de permiso. Los hooks `Notification(permission_prompt)` / `PermissionRequest` sí, y el endpoint `/hooks/:event` ya existe pero solo escribe a un ndjson.

## 3. Hallazgos con fuentes

### 3.1 Qué publicó Anthropic (2026)

| Qué | Fecha | Qué muestra | Fuente | Verificado |
|---|---|---|---|---|
| **Agent map (VS Code)** | v2.1.269, 11-sep-2026 | Árbol de subagentes bajo el principal, con estado, tiempo y tokens; tarjeta con prompt y tool calls; transcript de solo lectura; Stop. Desde v2.1.277 también tareas de fondo (shells, monitors) con su última salida (`/tasks`). | [docs VS Code](https://code.claude.com/docs/en/vs-code), [release v2.1.269](https://github.com/anthropics/claude-code/releases/tag/v2.1.269), [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) | Sí (doc oficial + changelog) |
| Agent view (`claude agents`, CLI) | blog 11-may-2026, desde ~v2.1.139 | Una fila por sesión en segundo plano, con icono de estado, nombre, resumen de una línea (Haiku), edad y PR. Grupos: Pinned, Ready for review, Needs input, Working, Completed. Peek y respuesta inline. **Sin tokens ni costo; sin subagentes.** | [doc agent view](https://code.claude.com/docs/en/agent-view), [blog](https://claude.com/blog/agent-view-in-claude-code) | Sí |
| Panel de agentes en la CLI interactiva | varias versiones | Lista de subagentes y teammates de fondo con contador de tokens en vivo (changelog: "made background subagents' and teammates' counters update live") | CHANGELOG | Parcial (solo changelog) |
| `subagentStatusLine` | 2026 | Payload por subagente para pintar filas propias (`agentType`, modelo, effort) | CHANGELOG | Solo changelog; la doc de statusline no lo detalla |
| Notificaciones de `claude agents` | 2026 | Hook `Notification` con `agent_needs_input` / `agent_completed` | CHANGELOG + [hooks](https://code.claude.com/docs/en/hooks) | Sí |
| Telemetría OTel: métricas, eventos y traces beta | vigente | Ver 3.2 | [monitoring-usage](https://code.claude.com/docs/en/monitoring-usage) | Sí |
| `anthropics/claude-code-monitoring-guide` | **2025** (no es nuevo) | docker-compose + Prometheus + OTel collector + Grafana para ROI, costo y tokens por equipo | [repo](https://github.com/anthropics/claude-code-monitoring-guide) | Sí |
| `anthropics/claude-code-playground` | creado 25-sep-2026 | DevRel: hooks, settings, "mods" que dibujan UI, demos. **El README no menciona un agent map.** | [repo](https://github.com/anthropics/claude-code-playground) | Sí (README) |
| `anthropics/cwc-long-running-agents` | may-2026 | Primitivas de harness (hooks de verificación, kill-switch, steer). Observa con `watch`/`tail`, **sin dashboard**. | [repo](https://github.com/anthropics/cwc-long-running-agents) | Sí |

Hay terceros que hacen lo que hacemos nosotros, por ejemplo `disler/claude-code-hooks-multi-agent-observability` y `simple10/agents-observe`. Los dos son UIs locales alimentadas por hooks y no son de Anthropic. No los evalué a fondo.

**No encontrado:** ninguna feature llamada "FleetView" ni "fleet". Tampoco un agent map en Claude Desktop o en claude.ai/code. El desktop rediseñado tiene una barra lateral de sesiones filtrable por estado y proyecto (fuente secundaria: thurrott.com).

### 3.2 Qué datos da cada fuente y si ya los usamos

Verificado contra `src/core/parse.ts`, `ingest.ts`, `queries.ts` y `src/server/main.ts`, y contra un transcript real de v2.1.300 en esta máquina.

**A. Transcripts JSONL (nuestra fuente principal)**

| Dato | ¿Lo consumimos? | Nota |
|---|---|---|
| `message.usage` (input, output, cache_read, cache_creation) por `message.id` | **Sí**, tabla `usage`, por agente | Hay campos extra sin usar: `speed`, `service_tier`, `server_tool_use`, `iterations` |
| `message.model` | Sí | |
| `subagents/agent-*.jsonl` + `.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`) | **Sí** | El meta real también trae `requestShape: "background"` y `requestNonInteractive`. **No los usamos.** |
| `toolUseResult` del Agent tool: `agentId`, `status` (`async_launched`), `isAsync`, `resolvedModel`, `outputFile` | **No** | Es la causa del bug de "Terminado" prematuro (ver 2) |
| `toolUseResult` del Agent tool al terminar (síncrono): `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage` | **No** | Documentado en el `tool_response` de PostToolUse. Que aparezca igual en el transcript es **suposición**: no tuve una muestra completada para verificarlo. |
| `parentUuid`, `isSidechain` | No (no hace falta) | El árbol lo armamos con `toolUseId` y `spawnDepth` del meta, que es más fiable |
| `ai-title`, `cwd`, `gitBranch`, `turnOrigin`, `agent-setting` | Sí | |
| `system` / `stop_hook_summary`, `queue-operation`, `last-prompt`, `attachment` | No | `last-prompt.lastPrompt` sirve como "tarea actual" legible |
| Prompt de permiso pendiente | **No existe en el transcript** | Por eso hoy se ve como "Trabajando" |

**B. Hooks (endpoint `POST /hooks/:event` ya existe, pero solo hace append a `data/hooks-events.ndjson`)**

Fuente: https://code.claude.com/docs/en/hooks. Hay hooks HTTP nativos (`type: "http"`) y un timeout por defecto de 600 s.

| Evento | Campos útiles | Valor para "quién te necesita" |
|---|---|---|
| Comunes a todos | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`, `permission_mode`, `agent_id`/`agent_type` (dentro de un subagente) | Unen hooks y transcripts por `session_id` |
| `Notification` | `notification_type`: `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`, `agent_completed`…; `message` | **Muy alto**: es la señal "te necesita" exacta |
| `PermissionRequest` | `tool_name`, `tool_input` (sin `tool_use_id`) | **Muy alto**: qué permiso pide |
| `Stop` | `last_assistant_message`, `background_tasks[]` (`id`, `type`, `status`, `description`, `agent_type`) | Alto: fin de turno exacto y tareas de fondo vivas |
| `StopFailure` | `error`: rate_limit, overloaded, billing_error… | Alto: error real, que hoy no vemos |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message` | Medio: hay bugs reportados (Stop sin Start) y el transcript ya lo cubre |
| `PostToolUse` (Agent) | `tool_response.totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage` | Medio |
| `SessionEnd`, `UserPromptSubmit`, `TaskCreated/Completed`, `TeammateIdle` | | Bajo por ahora |

Ningún hook trae tokens ni costo acumulados. La doc dice que para eso se usa OTel.

**C. OpenTelemetry** (https://code.claude.com/docs/en/monitoring-usage)

- Métricas: `claude_code.token.usage` (attr `type`, `model`, `query_source` = main | subagent | auxiliary, `agent.name`…) y `claude_code.cost.usage` (USD, estimado). También `session.count` (con `start_type=agents_view`), `active_time.total`, `lines_of_code.count`, `commit.count` y `pull_request.count`.
- Eventos (logs): `claude_code.api_request` (con `cost_usd`, tokens y `duration_ms`), `tool_result` (`duration_ms`, `success`), `api_error`, `tool_decision` y otros.
- Traces beta (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`): spans `interaction → llm_request / tool → subagent`, con `agent_id`/`parent_agent_id`.
- **No lo consumimos.** Hay que activarlo con variables de entorno en cada máquina y levantar un receptor OTLP. Las métricas se exportan cada 60 s y los logs cada 5 s.

**D. `claude agents --json`** (https://code.claude.com/docs/en/agent-view)

- Devuelve `cwd`, `kind` (interactive | background), `startedAt`, `state` (working | blocked | done | failed | stopped), `status` (busy | waiting | idle), `waitingFor` ("permission prompt", "input needed"…), `sessionId` y `name`.
- **No lo consumimos.** Es una fuente de solo lectura y sin tokens del modelo.
- **Suposición sin verificar:** que liste también las sesiones interactivas de la extensión de VS Code. La doc dice que `kind` puede ser `interactive`, pero agent view excluye "interactive sessions in other terminals". Hay que probarlo en la máquina del dueño (Windows).

### 3.3 Qué ya tenemos frente al agent map

| Agent map (VS Code) | Company OS hoy |
|---|---|
| Árbol de subagentes bajo el principal | **Sí**: pantalla Sesión (`buildTree` en `Session.tsx`), por `spawn_tool_use_id` + `spawnDepth` |
| Estado por agente | Sí, pero con los dos huecos de arriba (fondo = "done", permiso = "working") |
| Tokens por agente | Parcial: solo `tokens.output` en el árbol |
| Tiempo transcurrido | **No** (tenemos `started_at`/`last_event_at` pero no los mostramos) |
| Prompt y tool calls del subagente | Sí (timeline con foco por agente) |
| Transcript de solo lectura | Parcial (resúmenes; no el contenido completo) |
| Stop agent | No (somos de solo lectura, a propósito) |
| Tareas de fondo (shells, monitors) | No |
| **Varias sesiones y proyectos a la vez** | **Sí, y el agent map no.** El agent map es por sesión. Agent view junta sesiones pero sin tokens ni subagentes. |
| Costo | No (ni nosotros ni el agent map; OTel y `/cost` sí) |

**Conclusión:** nuestra ventaja es la vista **transversal**: todos los proyectos, departamentos y HATs juntos. Lo que hay que copiar del agent map es su **densidad por fila**: estado, tarea, tiempo y tokens en una línea. El problema de "hay que excavar" viene de que el árbol con tokens solo existe tres clics adentro (Empresa → Proyecto → Sesión).

## 4. Recomendaciones (priorizadas: rápido y de alto impacto primero)

### P0. Arreglar el estado (sin esto, cualquier vista miente) · ~0,5–1 día

1. **Subagentes de fondo no son "Terminado" al lanzarse.**
   - `parse.ts`: leer `toolUseResult` de las líneas `user` y emitir en el evento `tool_result` una marca `async: true` cuando `status === "async_launched"` o `isAsync === true`.
   - `db.ts`/`ingest.ts`: guardar esa marca. Puede ser una columna `events.result_status`, o `agents.is_async` usando `meta.requestShape === "background"`, que ya leemos de `.meta.json`.
   - `queries.ts` (`buildAgents`): para un agente async, `finished` no depende del `tool_result`. Depende de su propio último evento: turno de texto final → "done"; si no, la regla de edad.
   - Test con una línea real (fixture anonimizada) en `tests/parse.test.ts`.
   - Esfuerzo: unas 3–4 h.
2. **Usar los hooks que ya recibimos para el estado "te necesita".**
   - En `main.ts`, además del ndjson, hacer upsert en una tabla nueva `hook_signals(session_id, agent_id, kind, detail, ts)`.
   - `Notification` (`permission_prompt`, `elicitation_dialog`, `agent_needs_input`) y `PermissionRequest` → `waiting`, con detalle "pide permiso: Bash npm test".
   - `StopFailure` → `error` con el motivo.
   - `Stop` → fin de turno exacto.
   - En `deriveStatus`, una señal de hook **más reciente** que el último evento del transcript gana. Un evento del transcript posterior la invalida, porque el permiso ya se resolvió. Así mantenemos el principio "lo que se ve es real": es una señal registrada, no una inferencia.
   - Documentar en ARCHITECTURE.md el bloque `settings.json` de hooks HTTP. Solo esos 4 o 5 eventos, apuntando a `http://127.0.0.1:4747/hooks/<evento>?t=<token>`, porque un 4xx o una caída no bloquean a Claude.
   - Esfuerzo: 1 día.

### P1. "Mapa de agentes" transversal en la home, sin excavar · ~1,5–2 días

Una franja nueva en `Company.tsx`, debajo de `NeedsYou` y antes de "El piso". Es la versión Company OS del agent map, con **una fila por agente vivo de toda la empresa**, agrupada por proyecto y ordenada por urgencia:

```text
TE NECESITAN (2)                                      ← NeedsYou ya existe; añadir el "qué"
  ✋ cumbre-real · DES  "Checkout Stripe"  pide permiso: Bash npm run migrate   hace 3 min
  ✕ grupoveq   · MKT  "Carrusel"         falló: rate_limit                    hace 1 min

EN CURSO
  cumbre-real
    ● Claude (Opus)  "Checkout Stripe"   Edit src/pay.ts         12 min   84k tok  ~$1.20
      ├ ⛑ dev-frontend (Sonnet)          Write Cart.tsx           4 min   21k tok
      └ ◆ Explore                        Grep "webhook"           1 min    6k tok
  company-os
    ● Claude (Opus)  "Agent map"         WebFetch code.claude…   25 min  140k tok  ~$2.10
```

- **Forma y posición antes que texto:** se reusa el sprite `Worker` o `Drone` (escala 2) como icono de estado: mano levantada, cruz, animación. La sangría marca el árbol. Una columna fija de números (tiempo, tokens) se lee de reojo. Nada de tarjetas idénticas ni números gigantes (anti-dashboard SaaS).
- **Fila = el "summary" de agent view, pero real:** el `current` (última tool call) ya existe. Para el agente principal se añade el título de sesión. El resumen de Haiku que usa agent view no se copia: cuesta tokens y viola "cero tokens".
- **Colapso por defecto:** proyectos sin nada vivo no aparecen. Subagentes "done" se ocultan, como hace el panel de la CLI.
- En móvil (360 px), tiempo y tokens bajan a una segunda línea.
- Cambios en `src/core/queries.ts`: `overview()` ya calcula `buildAgents` por sesión, pero lo tira. Hay que exponer `agents: AgentView[]` (o solo los vivos) en `SessionView`, y añadir `startedAt` y `durationMs` a `AgentView`. En `web/src/api.ts` van los tipos y en `web/src`, un componente `AgentMap.tsx`.
- Esfuerzo: 1,5 días front + 0,5 back.

### P1b. Costo estimado · ~0,5 día

- `src/core/pricing.ts` con una tabla de precio por modelo (input, output, cache read, cache write), editable en el vault (`_empresa/precios.md` o JSON). Se calcula como `SUM(usage × precio)` por agente, sesión y proyecto.
- Siempre se muestra como **"~$" estimado**, igual que hace Anthropic con `cost.total_cost_usd`. No se cablean precios en el código, porque cambian: el changelog de v2.1.296 ajustó precios de cache de Sonnet 5.5.
- El HUD de la home pasa a "tokens hoy · ~$ hoy".

### P2. Opcionales, después de medir

- **`claude agents --json` como tercera fuente.** Un poll cada 10–15 s desde `watcher.ts`. Da `waitingFor` exacto para sesiones `--bg` sin configurar hooks. Primero hay que verificar en Windows si incluye sesiones de VS Code. Esfuerzo: 0,5 día + prueba.
- **Leer `totalDurationMs`/`totalTokens`/`totalToolUseCount`** del `toolUseResult` final del Agent tool, para cerrar subagentes síncronos con datos exactos. Hay que verificar el formato primero. Esfuerzo: 2–3 h.
- **Tareas de fondo (Bash `run_in_background`, Monitor).** Se pueden inferir de `tool_use` con `run_in_background: true`, o del `background_tasks[]` del hook `Stop`. Esfuerzo: 0,5–1 día.

### Qué NO adoptar

- **Receptor OTel/OTLP + Prometheus/Grafana** (estilo `claude-code-monitoring-guide`): duplica lo que ya sacamos del transcript y obliga a configurar cada máquina. Además Grafana es justo el "dashboard SaaS genérico" que PRODUCT.md rechaza. Solo valdría por `cost_usd` oficial, y eso lo cubrimos con una estimación (P1b).
- **Leer `~/.claude/jobs/<id>/state.json`**: la doc dice explícitamente que no es interfaz estable.
- **Resúmenes con Haiku por fila**, como hace agent view: gasta tokens.
- **Stop/Responder desde la oficina**: rompe "solo lectura" en v0. Si se quiere, va en la fase del lanzador, usando `claude attach`/`claude stop` para sesiones `--bg`.
- **Depender de `SubagentStart`/`SubagentStop`** para el árbol: hay bugs reportados de eventos huérfanos, y el transcript con `.meta.json` ya es fiable.

## 5. Limitaciones

- No pude abrir el contenido de los repos `anthropics/*` por API (la sesión solo tiene acceso a este repo). Usé su página pública y el README.
- No verifiqué en Windows ni con la extensión de VS Code del dueño. El agent map lo describo por doc y changelog, no lo vi en pantalla.
- Que el transcript guarde `totalTokens`/`totalDurationMs` al terminar un subagente es una suposición basada en el schema de `PostToolUse`.
- Que `claude agents --json` incluya sesiones de VS Code está sin verificar.
- Fechas: v2.1.269 dice "11 Sep" en la página de release. El año 2026 se deduce porque el changelog sigue hasta v2.1.300, de octubre de 2026.

## 6. Fuentes

- Agent map (VS Code): https://code.claude.com/docs/en/vs-code · https://github.com/anthropics/claude-code/releases/tag/v2.1.269
- CHANGELOG de Claude Code: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Agent view: https://code.claude.com/docs/en/agent-view · https://claude.com/blog/agent-view-in-claude-code
- Hooks: https://code.claude.com/docs/en/hooks
- OTel: https://code.claude.com/docs/en/monitoring-usage
- Statusline (costo y duración de sesión): https://code.claude.com/docs/en/statusline
- Repos: https://github.com/anthropics/claude-code-monitoring-guide · https://github.com/anthropics/claude-code-playground · https://github.com/anthropics/cwc-long-running-agents
- Terceros (no evaluados a fondo): https://github.com/disler/claude-code-hooks-multi-agent-observability · https://github.com/simple10/agents-observe
