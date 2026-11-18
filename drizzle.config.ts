import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.NAWAH_DATA_DIR
      ? `${process.env.NAWAH_DATA_DIR}/nawah.db`
      : './data/nawah.db',
  },
});
