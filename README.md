# Company OS

Oficina visual en vivo para tus agentes de Claude Code. Lee los registros de Claude Code de todos
tus proyectos y te muestra, en un dashboard pixel-art, **qué agente te necesita** (terminó, te hizo
una pregunta o falló) y qué se mueve en cada proyecto y departamento (Dirección, Desarrollo,
Diseño, Marketing, Research).

Además trae **HATs**: agentes especializados (copywriter, dev-frontend, qa-tester, revisor-calidad,
etc.) que se instalan como subagentes de Claude Code y guardan sus entregables en un vault de
Markdown.

> Solo lee. No modifica tus transcripts ni tus proyectos. El índice local (`data/`) se puede borrar
> y se reconstruye solo.

## Requisitos

- **Node.js 24 o más nuevo** (`node -v`). Se ejecuta TypeScript directo con Node, sin compilar.
- **Claude Code** instalado y usado al menos una vez (debe existir `~/.claude/projects`).
- Windows, macOS o Linux.

## Instalación

```bash
git clone https://github.com/Darkjor/COMPANY-OS.git
cd COMPANY-OS
npm install
npm run hats            # crea el vault ~/COMPANY OS/_empresa/hats e instala los HATs en ~/.claude/agents
npm run hooks -- install  # agrega los hooks de Company OS a ~/.claude/settings.json (hace respaldo)
npm start               # compila la web y levanta el servidor
```

Abre **http://localhost:4747**. Reinicia las sesiones de Claude Code que ya tenías abiertas para
que tomen los hooks.

Para verificar los hooks: `npm run hooks -- status`. Para quitarlos: `npm run hooks -- uninstall`.

## El vault

Es la memoria de la empresa: una carpeta de Markdown (puedes abrirla con Obsidian). Por defecto
vive en `~/COMPANY OS` (en Windows `C:\Users\<tu-usuario>\COMPANY OS`).

```
COMPANY OS/
├── _empresa/
│   ├── hats/          ← definición de cada HAT (lo crea `npm run hats`)
│   ├── plantillas/    ← PROYECTO.md, brief.md, para-direccion.md
│   └── convenciones.md
└── Proyectos/
    └── <slug>/
        ├── PROYECTO.md          (nombre:, repo_path: ruta del repo del proyecto)
        └── <departamento>/AAAA-MM-DD-nombre/   ← entregables que no son código
```

`npm run hats` solo crea `_empresa/hats/`. **Las plantillas y `convenciones.md` hay que copiarlas a
mano** (pídeselas a quien te pasó el repo) o escribir las tuyas.

Si editas un HAT en el vault, vuelve a correr `npm run hats` para actualizarlo en Claude Code.

### Ojo: ruta del vault en los HATs

Los archivos de `hats/` traen escrita la ruta `C:\Users\Perez\COMPANY OS`. Después de
`npm run hats`, edita los HATs en `~/COMPANY OS/_empresa/hats/`, cambia esa ruta por la tuya y
corre `npm run hats` otra vez.

## Reglas para Claude (recomendado)

Para que Claude Code use el vault y los HATs en todos tus proyectos, agrega a tu
`~/.claude/CLAUDE.md` global las reglas de Company OS: dónde va cada entregable, delegar siempre
con un HAT y un brief corto, Opus para dirigir y Sonnet para trabajar, y la línea
`Tope: N llamadas.` al inicio de cada prompt de Agent. Pide una copia a quien te pasó el repo y
cambia las rutas por las tuyas.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Compila la web y levanta el servidor en :4747 |
| `npm run serve` | Levanta el servidor sin recompilar la web |
| `npm run dev:web` | Web en modo desarrollo (Vite) |
| `npm run scan` | Reindexa los transcripts una vez, sin servidor |
| `npm run hats` / `npm run hats -- list` | Instala o lista los HATs |
| `npm run hooks -- install\|status\|uninstall` | Maneja los hooks de Claude Code |
| `npm run spawn -- <hat> <brief.md> [--model sonnet\|opus] [--cwd <dir>]` | Lanza una sesión aparte con un HAT |
| `npm test` / `npm run typecheck` | Tests y revisión de tipos |

## Variables de entorno (opcionales)

| Variable | Por defecto |
|---|---|
| `COMPANY_OS_VAULT` | `~/COMPANY OS` |
| `COMPANY_OS_PORT` | `4747` |
| `COMPANY_OS_CLAUDE_DIR` | `~/.claude/projects` |
| `COMPANY_OS_AGENTS_DIR` | `~/.claude/agents` |
| `COMPANY_OS_DB` | `data/company-os.db` |
| `COMPANY_OS_SETTINGS` | `~/.claude/settings.json` (para los hooks) |

## Más

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): cómo funciona por dentro.
- [PRODUCT.md](PRODUCT.md): para quién es y hacia dónde va.
