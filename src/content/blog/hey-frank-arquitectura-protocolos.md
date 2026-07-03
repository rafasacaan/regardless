---
title: "Construyendo a hey-frank #5 — Arquitectura hoy, y cuándo meter MCP y A2A"
fecha: 2026-07-01
tipo: "hey frank"
resumen: "Dónde está hey-frank hoy, y un criterio simple para decidir cuándo un protocolo como MCP o A2A gana su lugar —y cuándo es solo sobreingeniería."
draft: false
---

hey-frank ya funciona. Hay un agente que conversa, usa herramientas, responde de a poco en streaming, y guarda todo. Ahora viene la parte peligrosa: hacerlo crecer sin llenarlo de piezas que se ven sofisticadas pero no ganan nada. Este post es el criterio que me di para eso.

## La arquitectura hoy

Es simple, y esa es la gracia. Cuatro capas y una regla.

- **`api/`** recibe el HTTP: los endpoints.
- **`domain/`** tiene la lógica de negocio: las reglas.
- **`persistence/`** habla con Postgres; **`agents/`** habla con el modelo (Gemini, vía ADK).
- **`core/`** es la plomería: config, base de datos, login, logs.

La regla de oro: el SQL no sale de `persistence/`, el HTTP no entra a `domain/`. Un request entra por arriba, baja al núcleo, toca el mundo externo, y vuelve. Un solo agente, ADK + Gemini, Firebase para el login, streaming por SSE.

Nada exótico. Bordes limpios y cada carpeta con un solo trabajo.

## El principio que ordena todo

Cuando uno lee sobre agentes "en producción" aparecen protocolos con siglas: MCP, A2A. Es fácil quererlos todos porque así se ve serio. Pero hay un principio que los pone en su lugar:

**Estos protocolos existen para cruzar bordes entre partes independientes.** Su valor crece con el número de partes que necesitan hablarse —otras apps, otros agentes, otros equipos, sistemas externos—. Con una app, un agente y una base de datos, el valor es casi cero y el costo (procesos extra, red, configuración) es real.

Occam: la pieza más simple que resuelve el problema. El protocolo se agrega cuando aparece la segunda parte, no antes.

## MCP: cuándo sí, cuándo no

MCP es la forma estándar de exponerle herramientas y datos a un agente.

¿Meto Postgres detrás de MCP? **Hoy no.** Postgres es mío: mi base, mi código, mis repos. Ya tengo el borde limpio sin MCP. Envolverlo en un servidor MCP agrega un proceso y un protocolo para herramientas que usa un solo agente, en el mismo código. Indirección sin un segundo consumidor.

¿Cuándo MCP sí gana su lugar? Cuando integre algo **externo** que no controlo. Ableton Live, por ejemplo. Ableton vive detrás de su propio MCP; conectarlo así es el camino corto, no reinventar el pegamento.

Y acá una trampa que vale nombrar: *"ya que Ableton va por MCP, pongo todo por MCP para que sea uniforme"*. Eso es sobreingeniería por simetría. Un mismo agente puede tener herramientas mezcladas: Postgres como función local, Ableton por MCP. Es correcto, no inconsistente. La consistencia real está en el **criterio** —externo va por MCP, interno queda local—, no en el mecanismo.

El gatillo de MCP, herramienta por herramienta: *¿es externo, o lo van a consumir varios?* Si no, se queda como función local.

## A2A: casi nunca

A2A conecta un agente con otro como **servicios independientes**, por red. Sirve cuando los agentes se despliegan, escalan o se mantienen por separado.

hey-frank tiene un agente. No hay nada que conectar. Y el día que quiera varios agentes que colaboran, ADK ya deja componerlos **dentro del mismo proceso**, sin puertos ni HTTP. A2A es para cuando de verdad son servicios separados —probablemente nunca en un proyecto de este tamaño—.

## Lo que sí es buena práctica desde el principio

Este es el matiz que más me importó entender: la buena práctica desde el día uno **no es el protocolo, es el borde limpio**. Que el agente no toque SQL directo, que las herramientas estén aisladas, que la identidad esté desacoplada. Eso hey-frank ya lo tiene.

El protocolo es solo la maquinaria para cruzar ese borde cuando se vuelve un borde entre partes independientes. Y si el borde está limpio, meterlo después sale barato. No hay que anticiparlo; hay que no ensuciarlo.

Un test para cada decisión futura:

> **¿Tengo hoy una segunda parte que consuma esto?**
> Si no, es especulativo. Si sí, el protocolo ya se justifica.

## El plan es aburrido a propósito

Lo próximo que suma valor en hey-frank no es un protocolo. Son tres cosas, y ninguna tiene sigla de moda:

- **Memoria de verdad** — que recuerde entre conversaciones: mis gustos, mis tracks, en qué ando.
- **Trazabilidad** — poder ver qué pensó el agente, qué herramienta llamó y por qué. No se puede mejorar lo que no se ve, y un agente a ciegas es imposible de depurar.
- **Guardrails** — los que hey-frank de verdad necesita: que el agente se quede en su tarea, valide lo que entra y sale, y no haga cosas caras o tontas. Los livianos primero; la fortaleza de seguridad completa es para cuando haya una segunda parte de quien defenderse, no antes.

MCP entrará cuando toque Ableton. A2A probablemente no entre nunca.

Prefiero un sistema que entiendo, que es robusto y a la medida, a uno con sobre-ingeniería con *flashy badges* que no agrega valor.

Los próximos pasos, en ese orden: **trazabilidad** (para poder ver qué hace el agente), **memoria** de verdad, y **guardrails** cuando toque publicar. En ese orden, y no antes.

Rafa.
