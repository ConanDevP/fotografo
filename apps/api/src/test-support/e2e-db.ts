/**
 * URL de la base para las pruebas de integración, o undefined si no se pidieron.
 * Se niega a usar cualquier base cuyo nombre no contenga "e2e" o "test": estas pruebas
 * crean datos y no deben tocar nunca una base real (producción, Neon, staging...).
 */
export function e2eDatabaseUrl(): string | undefined {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) return undefined;
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/(e2e|test)/i.test(name)) {
    throw new Error(`E2E_DATABASE_URL apunta a "${name}": el nombre de la base debe contener "e2e" o "test".`);
  }
  return url;
}
