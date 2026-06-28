# Spec: loops de desarrollo sobre repo o directorio

> **Objetivo:** permitir que Orquester ejecute loops de desarrollo sobre un destino local definido por el usuario, ya sea un repositorio git o un directorio cualquiera, manteniendo el flujo actual de sesiones PTY, agentes y worktrees como base, pero sin quedar atado a Gorila360 ni a rutas hardcodeadas.

## 1. Alcance

Esta spec define la evolucion del sistema para que un loop pueda apuntar a:

- un `repo` git, con soporte de worktree o ejecucion directa sobre la ruta del checkout;
- un `directory` local cualquiera, sin asumir git ni estructura de workspace previa.

El objetivo no es reemplazar los flujos actuales, sino convertirlos en un caso particular de un runner mas general.

## 2. Problema actual

Hoy el loop runner esta orientado a Gorila360 y a rutas concretas. Eso funciona para ese caso, pero limita el uso del sistema cuando se quiere:

- trabajar contra otro repo;
- usar una carpeta suelta que no forma parte del layout de Orquester;
- reutilizar la misma mecanica de agente, sesion y salida en streaming sin anadir scripts nuevos por cada proyecto.

## 3. Principios de diseno

1. **Target-first.**
   - Todo loop debe operar sobre un target explicito.
   - El target no debe inferirse de forma implicita desde el workspace activo.

2. **Repo y directorio como casos de primer nivel.**
   - Un repo git no debe tratarse igual que un directorio simple.
   - El comportamiento de worktree solo aplica cuando el target es git.

3. **No hardcodear Gorila360.**
   - Gorila360 pasa a ser un preset o integracion concreta, no el unico modo de usar el sistema.

4. **Reutilizar la infraestructura actual.**
   - El daemon, el SessionManager, el broadcaster y la UI de sesiones siguen siendo la base.
   - Lo que cambia es la capa que resuelve destino y prepara la ejecucion.

5. **Seguridad por defecto.**
   - Los targets deben validarse antes de ejecutar.
   - Un directorio arbitrario requiere confirmacion explicita.

## 4. Modelo funcional

### 4.1 Target

Se introduce un modelo conceptual unico:

- `kind`: `repo` o `directory`
- `path`: ruta absoluta del destino
- `name`: nombre visible para UI y logs
- `branch`: opcional, solo para repos

### 4.2 Comportamiento por tipo

#### Repo

- Si hay branch, se puede crear o reutilizar worktree.
- Si no se usa worktree, se ejecuta sobre la ruta del checkout.
- El runner debe validar que el destino sea un repositorio git valido.

#### Directory

- Se ejecuta directamente sobre la carpeta indicada.
- No se asume `git status`, branch ni worktree.
- La UI debe advertir que la operacion afecta una ruta arbitraria.

## 5. Cambios de arquitectura

### 5.1 API / contratos compartidos

Extender los contratos compartidos para describir targets genericos y la configuracion de loops sobre esos targets.

Debe quedar cubierto:

- seleccion de target;
- persistencia de targets recientes;
- opcion de branch cuando el target es un repo;
- resultado de la ejecucion con `sessionId` y `outputUrl`.

### 5.2 Daemon

El daemon debe convertir el loop en un flujo generico:

1. validar el target;
2. preparar el entorno;
3. escribir el task file;
4. lanzar el agente en una sesion PTY;
5. publicar eventos de inicio y finalizacion;
6. devolver la referencia de salida en streaming.

### 5.3 Scripts

Los scripts existentes deben convertirse en wrappers reutilizables:

- uno generico para loops;
- uno especifico para worktrees;
- uno especifico para Gorila360 como preset si se quiere conservar compatibilidad.

### 5.4 UI

La UI debe permitir elegir:

- repo conocido;
- directorio manual;
- branch, si aplica;
- agente;
- fase o plan.

## 6. Fases de implementacion

### Fase 1 - Modelo de target

- Definir el tipo `Target`.
- Diferenciar claramente repo y directory.
- Mantener compatibilidad con el flujo actual.

### Fase 2 - Contratos y API

- Extender tipos compartidos.
- Anadir o generalizar endpoints para loops.
- Validar entrada y devolver resultados consistentes.

### Fase 3 - Runner generico

- Extraer la logica comun de preparacion y lanzamiento.
- Resolver worktree solo para targets tipo repo.
- Dejar directorio simple como camino directo.

### Fase 4 - Scripts

- Parametrizar scripts.
- Mantener Gorila360 como preset, no como dependencia obligatoria.

### Fase 5 - UI

- Anadir selector de target.
- Permitir lanzar loops desde la interfaz.
- Mostrar el estado y la salida en streaming.

### Fase 6 - Persistencia y guardrails

- Guardar targets recientes.
- Anadir confirmaciones para directorios arbitrarios.
- Mejorar validaciones de ruta y permisos.

### Fase 7 - Verificacion

- Probar repo con worktree.
- Probar repo sin worktree.
- Probar directorio normal.

## 7. Riesgos

| Riesgo | Mitigacion |
|--------|------------|
| Exceso de complejidad en la API | Mantener un unico modelo de target y un solo flujo de loop. |
| Rutas arbitrarias inseguras | Validacion estricta y confirmacion explicita. |
| Hardcodeo residual de Gorila360 | Tratarlo como preset, no como base arquitectonica. |
| Divergencia entre UI y daemon | Centralizar los contratos compartidos. |

## 8. Resultado esperado

Al cerrar esta spec, Orquester deberia poder:

- lanzar loops sobre cualquier repo local;
- lanzar loops sobre cualquier directorio local;
- seguir usando worktrees cuando el destino sea un repo;
- reutilizar sesiones PTY, eventos y streaming de salida;
- conservar Gorila360 como una configuracion de ejemplo, no como limite del sistema.
