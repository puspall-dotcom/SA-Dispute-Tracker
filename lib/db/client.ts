import postgres from "postgres";

declare global {
  var __pgClient: ReturnType<typeof postgres> | undefined;
}

function getPgClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  if (!globalThis.__pgClient) {
    globalThis.__pgClient = postgres(url, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 30,
      ssl: { rejectUnauthorized: false },
    });
  }
  return globalThis.__pgClient;
}

export const sql = getPgClient();

/**
 * Run a raw SQL query and return rows.
 */
export async function rawQuery<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await sql.unsafe<T[]>(query, params as never);
  return result as unknown as T[];
}
