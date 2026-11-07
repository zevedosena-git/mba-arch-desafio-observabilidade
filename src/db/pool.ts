import { Pool, type Client, type PoolClient } from 'pg';
import { registrarErro } from '../telemetria/tracing';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://loja:loja@localhost:5432/loja';

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

// A exportação fatal aguarda por até dois segundos. Rastrear os clientes adquiridos
// permite interromper consultas e transações antes dessa espera, como na queda da API.
// O controle usa os eventos acquire/release públicos do pool do node-postgres.
const clientesEmUso = new Set<PoolClient>();
let interrompido = false;
let fechamento: Promise<void> | undefined;

function interromperCliente(cliente: PoolClient): void {
  // O pool padrão entrega uma instância de pg.Client com release adicional.
  const conexao = cliente as PoolClient & Pick<Client, 'end'>;
  void conexao.end().catch((erro) => {
    // Falhas de limpeza seguem o registro compartilhado de exceção no span e log JSON.
    registrarErro('erro ao interromper conexao com o banco', erro);
  });
}

pool.on('acquire', (cliente) => {
  clientesEmUso.add(cliente);
  // Uma conexão iniciada antes da falha pode terminar de conectar durante a exportação.
  if (interrompido) interromperCliente(cliente);
});
pool.on('release', (_erro, cliente) => clientesEmUso.delete(cliente));

export async function esperarBanco(tentativas = 30): Promise<void> {
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (erro) {
      // Cada tentativa malsucedida segue o requisito de log error com motivo e span
      // de erro. O intervalo e a quantidade de tentativas continuam definidos aqui.
      registrarErro('banco ainda nao respondeu, tentativa ' + tentativa, erro);
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
  throw new Error('nao foi possivel conectar no banco');
}

export function fecharPool(): Promise<void> {
  // Compartilhar a Promise torna o fechamento idempotente quando um sinal de
  // encerramento e uma falha fatal chegam próximos, evitando pool.end() duplicado.
  fechamento ??= pool.end();
  return fechamento;
}

export function interromperPool(): void {
  // Fechar o pool bloqueia novas aquisições. Encerrar os clientes em uso também
  // impede que requisições concorrentes gravem enquanto os spans são enviados.
  interrompido = true;
  void fecharPool().catch((erro) => {
    registrarErro('erro ao fechar pool do banco', erro);
  });
  // pool.end() espera pelos clientes em uso. Interrompa-os antes de exportar.
  for (const cliente of clientesEmUso) interromperCliente(cliente);
}
