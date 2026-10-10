// Side-effect module, imported first by main.ts: OAuthModule reads env at module-definition
// time, before any provider exists. Like dotenv, a real environment variable wins over `.env`.
try {
  process.loadEnvFile();
} catch (error) {
  // No `.env` is the normal deployed case.
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
