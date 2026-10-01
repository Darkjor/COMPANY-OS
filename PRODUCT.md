# Product

## Register

product

## Users

Una sola persona por ahora: el dueño de una empresa digital pequeña (desarrollo web, diseño,
marketing) que trabaja con varios agentes de Claude Code en paralelo, cada uno en su ventana de
VS Code / Antigravity y en proyectos de distintos clientes.

Contexto de uso:
- **Segundo monitor, siempre abierto**, de reojo mientras programa o revisa en el monitor
  principal. Tiene que leerse de lejos y en un segundo.
- **Celular**, fuera de la compu, para checar si algún agente se quedó esperando.

Trabajo a resolver: saber en todo momento **qué agente lo necesita** (terminó su turno, hizo una
pregunta o falló) y qué se está moviendo en cada proyecto y departamento, sin tener que revisar
ventana por ventana.

## Product Purpose

Company OS es el sistema operativo de una empresa de agentes de IA. Hoy (v0) es un observador de
solo lectura: convierte los registros de Claude Code en una oficina visual en vivo, organizada por
proyectos y departamentos (Dirección, Desarrollo, Diseño, Marketing, Research), con la memoria de
la empresa en un vault de Markdown.

Éxito: el dueño nunca deja a un agente esperando sin darse cuenta, y puede ver de un vistazo cómo
va cada proyecto. Más adelante, la misma oficina será donde se asignan HATs, se aprueban planes y
se lanzan agentes.

## Brand Personality

**Táctico, preciso, vivo.**

Una torre de control en pixel-art: la sensación de mando de un juego de estrategia (Into the
Breach, FTL). Sobria y eficiente como herramienta de trabajo, pero con personajes que se mueven
de verdad según lo que hacen los agentes. Seria sin ser fría; con juego sin ser infantil.

## Anti-references

- Dashboard SaaS genérico: tarjetas idénticas, números gigantes con etiqueta pequeña, azul oscuro
  de "analytics".
- Cyberpunk / neón: negro con verde o morado brillante, estética hacker.
- Infantil o caricaturesco: tierno, pastel, de juego para niños.
- Corporativo frío: gris, sin personalidad, software empresarial.

## Design Principles

1. **Quien te necesita va primero.** Un agente esperando o con error es la información más
   importante de toda la pantalla; nunca debe competir con nada.
2. **Lo que se ve es real.** Cada personaje, animación y estado corresponde a un evento real de
   los registros. Nada de decoración que finja actividad.
3. **Legible de reojo.** Desde el segundo monitor o el celular, el estado se entiende por forma,
   posición y color antes que por texto.
4. **El juego sirve al trabajo.** El pixel-art y los personajes existen para hacer el estado más
   rápido de leer y la oficina más tangible, no para adornar.
5. **La empresa crece encima.** Proyectos, departamentos y HATs son la estructura de la empresa;
   la interfaz debe aceptar más proyectos y departamentos sin rediseñarse.

## Accessibility & Inclusion

- Estado nunca solo por color: cada estado tiene además forma o icono (mano levantada, burbuja,
  cruz) y texto accesible.
- Respetar `prefers-reduced-motion`: las animaciones de personajes se vuelven estáticas.
- Contraste WCAG AA en todo el texto de datos.
- Funcional en pantallas de teléfono (360 px de ancho) sin scroll horizontal de página.
