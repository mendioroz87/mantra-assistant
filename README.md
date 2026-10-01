# Voz Clara

Estudio de pronunciación con GPT-Live-1, audio continuo por WebRTC y subtítulos incrementales. Permite practicar mantras o frases, escuchar una referencia y recibir un consejo breve del coach.

## Integración

El navegador usa `hooks/useLiveSession.ts` y envía la oferta SDP a `POST /api/live/session`. El servidor crea una sesión JSON en `https://api.openai.com/v1/live/sessions` y devuelve solamente la respuesta SDP, el identificador y el modelo. La clave permanece en el servidor. Se preserva el SDP completo, incluido su CRLF final, y la interfaz espera `session.started` antes de mostrar conexión.

El modelo de voz es `gpt-live-1`. El backend delegado `gpt-5.6-luna` registra un resumen del consejo que el coach ya expresó; no escucha audio ni evalúa pronunciación desde el transcript. Los subtítulos son fragmentos continuos, no turnos finalizados. La ruta y el adaptador Realtime anteriores se conservan como código de referencia y no son utilizados por la interfaz.

## Configuración

Copia `.env.example` a `.env.local`, configura `OPENAI_API_KEY` y ejecuta:

```sh
npm install
npm run dev
```

En Railway, configura `OPENAI_API_KEY` en el servicio. `OPENAI_REALTIME_VOICE` conserva su nombre por compatibilidad y selecciona la voz (predeterminada: `marin`). Las antiguas variables de modelo Realtime y transcripción no cambian la sesión Live. El navegador requiere permiso de micrófono y HTTPS, salvo en localhost.

## Controles y límites

- Micrófono, pausa, repetición, selección de frase y subtítulos.
- El ritmo y la preferencia de ceder la palabra son instrucciones conversacionales, no controles exactos del audio.
- Pausar silencia la captura y la reproducción local; la sesión permanece abierta. Finalizar solicita `session.close` y espera brevemente el cierre antes de liberar los recursos.
- El coach escucha el audio. Su consejo puede ser incierto; no se presentan puntuaciones acústicas calculadas desde texto.
- La transliteración ritual requiere contexto de tradición o maestro. Esta versión no admite subir grabaciones de referencia.
- La aplicación no guarda audio ni progreso en una base de datos. `store: false` se solicita para la sesión Live; el backend delegado tiene las políticas de retención de OpenAI correspondientes.
- Los límites de inicio por IP y concurrencia son locales al proceso del servidor.

## Verificación

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Las pruebas unitarias cubren validación del servidor, protocolo y conservación del SDP. La conexión real debe verificarse además con una sesión WebRTC: un despliegue exitoso por sí solo no demuestra que funcione el audio.

[Documentación GPT-Live](https://developers.openai.com/api/docs/guides/live) · [Migración](https://developers.openai.com/api/docs/guides/live-migration)
