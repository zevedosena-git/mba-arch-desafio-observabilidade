import { isSpanContextValid, trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

function escrever(level: Nivel, msg: string, pedidoId?: number): void {
  const contexto = trace.getActiveSpan()?.spanContext();
  const spanValido = contexto && isSpanContextValid(contexto);
  const linha = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    trace_id: spanValido ? contexto.traceId : '',
    span_id: spanValido ? contexto.spanId : '',
    pedido_id: pedidoId,
  };

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string, pedidoId?: number): void {
    escrever('info', msg, pedidoId);
  },
  warn(msg: string): void {
    escrever('warn', msg);
  },
  error(msg: string, pedidoId?: number): void {
    escrever('error', msg, pedidoId);
  },
};
