# MEMORY — Orquester (fork `vk6code/Ky-Orquester`)

> Documento vivo de conocimiento del proyecto: qué es, cómo está montado, en qué
> se diferencia del upstream y qué mejoras tenemos por delante. Actualizar cuando
> cambie la arquitectura o el roadmap.
>
> Última actualización: 2026-06-28

---

## 1. Qué es

Orquester es un **orquestador de agentes de coding "local-first"**. Levanta un
daemon local que expone terminales (PTYs) sobre HTTP/WebSocket y un socket Unix,
y una UI (Electron en escritorio + web Vite remota) para gestionar workspaces,
proyectos, ficheros y sesiones de agentes de IA (Claude Code, Codex, Gemini…).

Datos de runtime por defecto en `~/.orquester` (o `./.stage` en desarrollo).
Password de staging: `123456`.

## 2. Origen / relación con el upstream

- **Upstream (original):** [`sammwyy/orquester`](https://github.com/sammwyy/orquester)
  — "Monorepo skeleton for a local-first coding orchestrator." Es un esqueleto;
  no tiene releases, issues, ni roadmap público.
- **Este repo:** `vk6code/Ky-Orquester` es el fork y **va por delante** del
  upstream (sincronizado hasta su último commit + 4 commits propios).
- **Mejoras propias ya integradas (no están en upstream):**
  - Agentes extra en el registry: **Kimi Code CLI**, **Pi Coding Agent**.
  - **gorila360 loops** + **generic loop runner** (`/api/loops`).
  - **VPS deploy playbook** y configuración de despliegue (`deploy/`).
  - Remapeo de puertos de desarrollo; fixes de node-pty y workspaces con symlink.
- **Conclusión:** no hay features exclusivas del upstream que portar hoy. Seguir
  vigilando https://github.com/sammwyy/orquester/commits/main y hacer rebase/merge
  cuando publique nuevos commits.

## 3. Arquitectura (monorepo pnpm)

```
apps/
  daemon/   Node + Fastify. PTYs (node-pty), HTTP/WS + Unix socket, registry, FS, loops.
  desktop/  Electron. Arranca el daemon embebido y hospeda la UI. Tray + background.
  web/      Cliente Vite/React para despliegues HTTP remotos.
packages/
  config/   Esquemas Zod, paths, expansión de $vars, defaults y validación.
  api/      Contratos/tipos compartidos + cliente HTTP.
  registry/ Fuente única de verdad: shells, agentes IA, IDEs, file-explorers, browsers.
  ui/       UI React compartida (desktop + web): xterm, codemirror, tailwind.
deploy/     Dockerfile, docker-compose, nginx, systemd unit, setup.sh.
scripts/    gorila360-loop.sh, gorila360-run-agent.sh, gorila360-worktree.sh, loop-run-agent.sh.
specs/      SPECs activas (loop-targets, vps-deployment) + plan gorila-dev-deploy.
```

### Daemon (apps/daemon/src)
- `index.ts` — `startDaemon()`. Dos transportes desde **un mismo set de servicios**:
  - **unix socket** (siempre activo, `mode: "local"`, sin auth): config completa,
    incluido `PUT /api/config/daemon` (solo local puede cambiar la config).
  - **HTTP** (opt-in, `mode: "remote"`, auth por bearer): hot-reload del transporte
    sin reiniciar daemon ni matar PTYs al cambiar password/host/port/enabled.
  - Auth: password → bcrypt hash en disco; el cliente deriva el bearer con el salt
    público de `GET /api/auth/info`. Comparación en tiempo constante.
  - Sirve la build estática de `web` con fallback SPA cuando `serveWeb` está activo.
- `sessions.ts` — `SessionManager`. Posee cada PTY. Las sesiones **sobreviven** a
  desconexiones: buffer de replay (256 KB) + `EventEmitter` por sesión; eventos de
  ciclo de vida (`created`/`exited`/`closed`) para sync entre clientes.
- `registry.ts` (`RegistryService`) — resuelve binarios del registry estático,
  detecta versiones, instala/actualiza, abre IDEs/explorers/browsers. Emite `changed`.
- `broadcaster.ts` — bus de eventos NDJSON (`/events`) con heartbeat cada 15 s.
- `gorila360.ts` / `gorila360-plans.ts` — bridge de worktrees + runner de loops
  (genérico `/api/loops` y preset `/api/gorila360/loops`) + pipelines Python + catálogo de planes.

### API HTTP (resumen)
`/health`, `/api/info`, `/api/config/{daemon,client,app,remotes}`,
`/api/workspaces[...]/projects`, `/api/fs[/read|/write|/create]`,
`/api/registry[/:id/version|/install|/update]`, `/api/open`,
`/api/sessions[/:id/{input,resize,output}]`, `/events`,
`/api/loops`, `/api/gorila360/{worktrees,loops,pipelines/*,plans}`.

### Config (packages/config)
- Zod schemas: `daemonConfig` (workspacesDir, logsDir, transports.http),
  `appConfig`, `remotesConfig`, `clientConfig`, conexiones local/remote.
- `$vars`: `$userhome`, `$appdir`, `$cwd`, `$user`.
- Layout: `<appdir>/{app,daemon}/...`; workspaces en `daemon.json:workspacesDir`.

### Registry (packages/registry) — datos estáticos puros
- **Shells (7):** bash, zsh, fish, nu, pwsh, cmd, sh.
- **Agentes IA (7):** Claude Code, Codex, DeepSeek, Gemini CLI, OpenCode, **Kimi**, **Pi**.
- **IDEs (12):** VS Code, Cursor, Antigravity, Windsurf, Zed, IntelliJ, Sublime,
  CLion, GoLand, PhpStorm, PyCharm, RustRover.
- **File explorers (8)** y **browsers (7)**.

## 4. Comandos

```sh
pnpm install
pnpm dev           # desktop (Electron) sobre ./.stage
pnpm dev:daemon    # daemon en watch sobre ./.stage
pnpm dev:web       # web client (apunta a VITE_ORQUESTER_API_URL)
pnpm dev:desktop
pnpm check         # typecheck -r
pnpm build         # build -r
```

## 5. Decisiones del owner (2026-06-28)

- **Foco actual:** desacoplar Gorila360 (cierra SPEC-loop-targets).
- **Gorila360 = preset de ejemplo** opcional; el runner genérico `/api/loops` es el núcleo.
- **Producto:** herramienta personal multi-proyecto (sin overhead de releases por ahora).
- **Upstream:** mantener sincronía — vigilar `sammwyy/orquester` y rebasar.

## 6. Deuda técnica / problemas conocidos

1. ✅ **Rutas hardcodeadas de macOS — RESUELTO (2026-06-28).** Gorila360 es ahora un
   preset opcional por env:
   - `ORQUESTER_GORILA360_ROOT` (activa los endpoints `/api/gorila360/*`; si no está,
     responden `501 GORILA360_NOT_CONFIGURED`).
   - `ORQUESTER_GORILA360_SCRIPTS`, `ORQUESTER_GORILA360_PLANS_DIR` (derivan del root).
   - `ORQUESTER_SCRIPTS_DIR` (scripts del repo; default módulo-relativo `scripts/`).
   - El runner genérico `/api/loops` funciona sin nada de esto.
   - Scripts (`gorila360-loop.sh`, `gorila360-worktree.sh`) parametrizados por env.
   - Documentado en `deploy/.env.example`.
2. `package.json:dev:web` apunta a una IP/puerto Tailscale concreto
   (`http://100.81.190.74:57831`) — debería venir de env. (pendiente)
3. `apps/web/package.json` aparece como **modificado** en git (cambio sin commitear).
4. `packageVersion` está hardcodeado a `"0.0.0"` en el daemon (debería leer del package.json).
5. Sin tests automatizados ni CI.

## 6. Roadmap de mejoras (candidatas)

> Pendiente de priorizar con el owner. Ver §7 (preguntas abiertas).

- **A. Desacoplar Gorila360 → presets configurables** (SPEC-loop-targets):
  ✅ rutas por env/config (hecho). ⏳ Pendiente: UI para elegir target
  (repo/directorio) y persistir targets recientes (Fases 5-6 de la SPEC).
- **B. Robustez de despliegue:** versión real, env para puertos/URLs, healthchecks,
  CI (typecheck + build), releases empaquetadas (electron-builder ya está).
- **C. Orquestación multi-agente real:** hoy el registry solo lista CLIs; no hay
  coordinación entre agentes. Posible: planificador de fases que reparte tareas.
- **D. Sistema de plugins / agentes definidos por el usuario** (sin tocar el código).
- **E. Themes** y mejoras de UX (la UI ya es responsive/mobile).
- **F. Auth más robusta:** tokens/sesiones además del password único; rate-limit.
- **G. Tests:** unit del config/registry, e2e del flujo de sesiones.

## 6.b Feature: Agent workspace multi-directorio (2026-06-28)

Lanzar un agente con una **ruta base + N directorios extra** (p. ej. frontend + backend)
para que un solo agente abarque varios roots.
- **Mecanismo:** `--add-dir` nativo. `RegistryEntry.addDirFlag` (Claude = `--add-dir`);
  agentes sin el flag ignoran los extra dirs.
- **API:** `CreateSessionRequest.extraDirs?: string[]` y `SessionSummary.extraDirs`.
- **Daemon:** `sessions.ts` construye `args = extraDirs.flatMap(d => [addDirFlag, d])`.
- **UI:** nueva vista `components/agent/AgentWorkspace.tsx` (selector de agente, ruta base,
  lista de directorios con picker sobre `/api/fs`), entrada "Agent workspace" en `NewTabMenu`,
  render en `MainView`, tab client-local `agent-launcher` en el store.
- Verificado en vivo: lanza `claude --add-dir <front> --add-dir <back>`.

## 6.c Ejecutar NaN vía OpenCode (2026-06-28)

Flujo elegido para usar los modelos NaN dentro de Orquester: **OpenCode** (mejor
soporte de proveedores custom OpenAI-compatibles).

- **NaN** = endpoint OpenAI-compatible `https://api.nan.builders/v1` (chat_completions).
  Clave en `~/.hermes/.env` como `NAN_API_KEY`. Modelos: `qwen3.6` (default, visión+tools),
  `deepseek-v4-flash`, `mimo-v2.5`, `gemma4` (+ whisper/kokoro/flux para audio/imagen).
- **Config OpenCode**: `~/.config/opencode/opencode.json` (chmod 600) con `provider.nan`
  usando `@ai-sdk/openai-compatible` (`options.baseURL` + `options.apiKey`) y
  `"model": "nan/qwen3.6"` por defecto. La key va en el fichero (600), no en el repo.
- **Uso**: en la UI, "+" → Agents → **OpenCode** arranca el TUI usando NaN/qwen3.6.
- **Nota agentes**: los "agents" del registry son binarios del host que el daemon lanza
  como PTY; deben estar instalados (claude/kimi nativos; codex/opencode/pi vía npm en
  `~/.local`). Pi usa proveedores conocidos (default google), sin base-url custom → para
  NaN se usa OpenCode, no Pi.
- **Gotcha npm**: instalar agentes requería prefijo npm escribible. `npm config set prefix
  ~/.local` (en `~/.npmrc`) + reiniciar el daemon para que herede el prefijo (las env
  `npm_config_*` ganan al `.npmrc`).

## 7. Próximos pasos sugeridos

1. **UI de target genérico** (SPEC-loop-targets fases 5-6): selector repo/directorio
   + branch + agente, y persistir targets recientes. Hoy `LoopRunner.tsx` existe pero
   la UI sigue orientada a gorila360.
2. **Limpiar `dev:web`**: IP/puerto Tailscale → variable de entorno.
3. **Versión real del daemon** (leer de package.json en vez de `"0.0.0"`).
4. **CI mínima**: typecheck + build en push.
