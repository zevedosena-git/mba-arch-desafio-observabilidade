import { Pool } from 'pg';
import { registrarErro } from '../telemetria/tracing';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://loja:loja@localhost:5432/loja';

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function esperarBanco(tentativas = 30): Promise<void> {
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (erro) {
      registrarErro('banco ainda nao respondeu, tentativa ' + tentativa, erro);
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
  throw new Error('nao foi possivel conectar no banco');
}

export async function fecharPool(): Promise<void> {
  await pool.end();
}
