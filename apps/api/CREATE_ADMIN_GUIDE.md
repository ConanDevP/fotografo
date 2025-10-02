# Guía para Crear Usuario Administrador

Existen **3 formas** de crear el usuario administrador inicial en la plataforma:

---

## ✅ **Opción 1: Script de Seed (Recomendada)**

La forma más segura y simple.

### **Paso 1: Configurar variables de entorno (opcional)**

Edita tu archivo `.env`:

```bash
ADMIN_EMAIL=admin@tudominio.com
ADMIN_PASSWORD=TuPasswordSegura123!
ADMIN_NAME=Tu Nombre Completo
```

Si no configuras estas variables, se usarán los valores por defecto:
- Email: `admin@fotografo.com`
- Password: `Admin123456!`
- Nombre: `Super Admin`

### **Paso 2: Ejecutar el script**

```bash
npm run seed:admin
```

### **Resultado esperado:**

```
🌱 Creando usuario administrador...
✅ Usuario administrador creado exitosamente!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📧 Email: admin@fotografo.com
🔑 Password: Admin123456!
👤 Nombre: Super Admin
🆔 ID: abc-123-def-456
⚡ Rol: ADMIN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  IMPORTANTE: Cambia la contraseña después del primer login!
```

---

## ✅ **Opción 2: Endpoint API con clave secreta**

Útil si necesitas crear admin desde una aplicación o script externo.

### **Paso 1: Configurar clave secreta en `.env`**

```bash
ADMIN_SECRET_KEY=mi-super-clave-secreta-123
```

Si no la configuras, se usa por defecto: `change-this-secret-key-in-production`

### **Paso 2: Hacer request POST**

```bash
curl -X POST http://localhost:3000/auth/create-admin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@tudominio.com",
    "password": "TuPasswordSegura123!",
    "name": "Tu Nombre Completo",
    "secretKey": "mi-super-clave-secreta-123"
  }'
```

### **O usando Postman/Insomnia:**

```
POST http://localhost:3000/auth/create-admin

Body (JSON):
{
  "email": "admin@tudominio.com",
  "password": "TuPasswordSegura123!",
  "name": "Tu Nombre Completo",
  "secretKey": "mi-super-clave-secreta-123"
}
```

### **Respuesta exitosa:**

```json
{
  "data": {
    "message": "Usuario administrador creado exitosamente",
    "user": {
      "id": "abc-123-def-456",
      "email": "admin@tudominio.com",
      "name": "Tu Nombre Completo",
      "role": "ADMIN"
    }
  }
}
```

---

## ✅ **Opción 3: Directamente en la base de datos**

Si tienes acceso directo a PostgreSQL.

### **Script SQL:**

```sql
-- Reemplaza los valores con tus datos
-- Nota: La contraseña debe hashearse con Argon2 o bcrypt

INSERT INTO users (
  id,
  email,
  password_hash,
  name,
  role,
  is_verified,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  'admin@tudominio.com',
  -- Hash de 'Admin123456!' con bcrypt (costo 10)
  '$2b$10$XYZ...', -- Debes generar este hash
  'Super Admin',
  'ADMIN',
  true,
  NOW(),
  NOW()
);
```

### **Para generar el hash de la contraseña:**

Puedes usar Node.js:

```javascript
const bcrypt = require('bcrypt');
const hash = await bcrypt.hash('TuPassword123!', 10);
console.log(hash);
```

O Argon2 (recomendado):

```javascript
const argon2 = require('argon2');
const hash = await argon2.hash('TuPassword123!');
console.log(hash);
```

---

## 🔐 **Después de crear el admin**

1. **Haz login** con las credenciales:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@fotografo.com",
    "password": "Admin123456!"
  }'
```

2. **Cambia la contraseña** desde el endpoint de perfil o usando el endpoint admin:

```bash
# Obtener token del login anterior
curl -X POST http://localhost:3000/admin/users/{userId}/reset-password \
  -H "Authorization: Bearer TU_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "newPassword": "NuevaPasswordSegura123!"
  }'
```

---

## 🛡️ **Seguridad**

### **IMPORTANTE en producción:**

1. ✅ **Cambia `ADMIN_SECRET_KEY`** a un valor único y seguro
2. ✅ **Cambia la contraseña del admin** después del primer login
3. ✅ **Desactiva el endpoint `/auth/create-admin`** en producción (comentar o eliminar)
4. ✅ **Usa contraseñas fuertes** (mínimo 12 caracteres, mayúsculas, minúsculas, números, símbolos)
5. ✅ **Limita acceso a la base de datos** solo a IPs autorizadas

### **Ejemplo de contraseña segura:**

```
A1b2C3d4!@#$XyZ
```

- Mínimo 12 caracteres
- Mayúsculas y minúsculas
- Números
- Símbolos especiales

---

## 🧪 **Verificar que el admin fue creado**

```bash
# Listar todos los usuarios admin (requiere estar logueado como admin)
curl -X GET http://localhost:3000/admin/users?role=ADMIN \
  -H "Authorization: Bearer TU_ACCESS_TOKEN"
```

---

## ❓ **Problemas comunes**

### **"El usuario ya existe"**

El email ya está registrado. Usa otro email o elimina el usuario existente.

### **"Clave secreta inválida"**

El `secretKey` en el request no coincide con `ADMIN_SECRET_KEY` en `.env`.

### **"Script no encuentra bcrypt o argon2"**

Instala las dependencias:

```bash
npm install bcrypt argon2
```

---

## 📝 **Resumen de comandos**

```bash
# Opción 1: Script de seed (RECOMENDADO)
npm run seed:admin

# Opción 2: Endpoint API
curl -X POST http://localhost:3000/auth/create-admin \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!","name":"Admin","secretKey":"mi-clave"}'

# Verificar login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin123!"}'
```

---

**¡Listo! Ya puedes administrar toda la plataforma con los endpoints creados.** 🚀
