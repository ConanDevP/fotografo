# Dominios white-label con Railway

LucilaMon registra cada dominio empresarial directamente en el servicio frontend de Railway. Railway devuelve los registros DNS, verifica su propagación y emite el certificado HTTPS. El panel del cliente muestra esos valores y no declara el dominio activo hasta que Railway confirma el certificado.

## Variables del backend

```env
RAILWAY_API_TOKEN="token-secreto"
RAILWAY_PROJECT_ID="uuid-del-proyecto"
RAILWAY_ENVIRONMENT_ID="uuid-del-ambiente-production"
RAILWAY_FRONTEND_SERVICE_ID="uuid-del-servicio-frontend"
RAILWAY_FRONTEND_PORT="8080"
```

Estas variables pertenecen únicamente al backend. No deben comenzar con `NEXT_PUBLIC_` ni configurarse en el servicio frontend.

## Cómo obtenerlas

1. En Railway abre **Account Settings > Tokens**.
2. Crea preferentemente un **Workspace Token** para el workspace que contiene LucilaMon. Un Account Token también funciona, pero tiene mayor alcance.
3. Copia el token una sola vez y guárdalo como `RAILWAY_API_TOKEN` en el servicio backend/API.
4. Abre el proyecto de producción y usa **Ctrl+K** para copiar el Project ID, Environment ID y Service ID.
5. El Service ID debe ser el del frontend que sirve `www.lucilamon.com`, no el API ni el worker.
6. Confirma en **Frontend > Settings > Networking** el puerto de destino. Para este Next.js es normalmente `3000`.
7. Despliega primero el backend y después el frontend.

## Flujo del cliente

1. El propietario guarda, por ejemplo, `fotos.cliente.com`.
2. El backend lo registra en Railway de forma idempotente.
3. El panel muestra el CNAME y el TXT `_railway-verify` exactos.
4. En Cloudflare el cliente debe dejar el CNAME en **DNS only** (nube gris) durante la validación.
5. **Comprobar conexión** consulta Railway nuevamente.
6. Solo el estado `ACTIVE` habilita el dominio en el middleware público.

Al cambiar o quitar un dominio, LucilaMon retira el registro anterior de Railway. Si Railway está temporalmente inaccesible, el dominio nuevo no se marca como activo y el dominio canónico `lucilamon.com/s/{slug}` continúa disponible.

El panel incluye **Desconectar dominio** con confirmación. El backend retira primero el dominio de Railway y solo entonces limpia la asociación local; la operación es idempotente. Los registros CNAME/TXT pertenecen al proveedor DNS del cliente y el panel le indica que debe eliminarlos manualmente.

## Recuperar un dominio guardado anteriormente

Los dominios que ya estaban guardados, pero fueron marcados incorrectamente como verificados, se recuperan pulsando **Preparar conexión**. LucilaMon los crea en Railway, presenta los registros correctos y elimina la verificación anterior hasta que DNS y HTTPS sean válidos.
