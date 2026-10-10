import { defineConfig, type PrismaConfig } from 'prisma/config';

try {
  // Like dotenv: a real environment variable wins over `.env`.
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/placeholder',
  },
}) satisfies PrismaConfig;
