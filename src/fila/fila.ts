import { context, propagation, ROOT_CONTEXT, type Context } from '@opentelemetry/api';
import Redis from 'ioredis';

export const NOME_DA_FILA = 'pedidos';

export type MensagemPedido = {
  pedido_id: number;
  cliente_id: string;
  valor_total: number;
};

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function criarConexaoRedis(): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export async function publicarPedido(
  redis: Redis,
  mensagem: MensagemPedido
): Promise<void> {
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
