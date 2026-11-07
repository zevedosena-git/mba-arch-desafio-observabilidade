import { context, propagation, ROOT_CONTEXT, type Context } from '@opentelemetry/api';
import Redis from 'ioredis';
import { registrarErro } from '../telemetria/tracing';

export const NOME_DA_FILA = 'pedidos';

export type MensagemPedido = {
  pedido_id: number;
  cliente_id: string;
  valor_total: number;
};

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function criarConexaoRedis(): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  // ioredis emite erros por evento. Encaminhá-los ao helper compartilhado mantém
  // log JSON com motivo e span de erro para as conexões da API e do worker.
  redis.on('error', (erro) => registrarErro('erro na conexao Redis', erro));
  return redis;
}

export async function publicarPedido(
  redis: Redis,
  mensagem: MensagemPedido
): Promise<void> {
  // O carrier leva os campos traceparent/tracestate do W3C Trace Context ao Redis.
  // A extração no worker continua a árvore de spans iniciada pelo POST.
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const { traceparent, tracestate } = carrier;
  await redis.lpush(NOME_DA_FILA, JSON.stringify({
    ...mensagem,
    trace_context: { traceparent, tracestate },
  }));
}

export async function consumirPedido(
  redis: Redis,
  segundosDeEspera = 5
): Promise<Record<string, unknown> | null> {
  const resposta = await redis.brpop(NOME_DA_FILA, segundosDeEspera);

  if (!resposta) {
    return null;
  }

  return JSON.parse(resposta[1]) as Record<string, unknown>;
}

export function contextoDoPedido(mensagem: Record<string, unknown>): Context {
  // ROOT_CONTEXT evita herdar um contexto incidental do consumidor. Mensagens
  // legadas sem carrier recebem um trace próprio e continuam compatíveis.
  const carrier = mensagem.trace_context;
  if (!carrier || typeof carrier !== 'object' || !('traceparent' in carrier)) {
    return ROOT_CONTEXT;
  }

  const traceparent = carrier.traceparent;
  const tracestate = 'tracestate' in carrier ? carrier.tracestate : undefined;
  return propagation.extract(ROOT_CONTEXT, {
    traceparent: typeof traceparent === 'string' ? traceparent : undefined,
    tracestate: typeof tracestate === 'string' ? tracestate : undefined,
  });
}
