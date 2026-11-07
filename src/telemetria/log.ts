import { isSpanContextValid, trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

function escrever(level: Nivel, msg: string, pedidoId?: number): void {
  // Resolver o contexto na escrita acompanha o span ativo do OpenTelemetry.
  // O esquema do projeto exige trace_id/span_id em toda linha, vazios sem span válido,
  // e pedido_id quando o pedido é conhecido, para correlação por campo estruturado.
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

  // Um objeto JSON por linha no stdout permite busca e parsing dos dois processos.
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
