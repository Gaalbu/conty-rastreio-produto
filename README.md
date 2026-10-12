# Rastreio do produto enviado ao criador

O prazo do conteúdo só faz sentido depois que o pacote chega. Cada transportadora fala um dialeto, eventos chegam fora de ordem e às vezes chega um status que ninguém conhece. Este serviço guarda o histórico inteiro, deriva um status estável e diz se o envio está atrasado.

Comece a leitura por [`src/status.ts`](src/status.ts) e [`src/delay.ts`](src/delay.ts).

## Regras

**Status estável:** `posted`, `in_transit`, `out_for_delivery`, `delivered`, `exception`. O dialeto mapeado:

| Texto bruto | Status |
| --- | --- |
| `postado`, `collected` | `posted` |
| `em transito`, `em trânsito`, `transit` | `in_transit` |
| `saiu para entrega` | `out_for_delivery` |
| `entregue` | `delivered` |
| `excecao`, `exceção`, `failed` | `exception` |
| qualquer outro, ex. `TELEPORTADO`, `constructor` | `unknown` |

`unknown` entra no histórico e nunca muda o status atual, nem vira `delivered`.

**Histórico:** append-only, chave única `(shipment_id, event_id)`. O mesmo evento em dois sync não gera segunda linha, mesmo com o instante escrito em outro fuso (`occurred_at` é gravado em ISO UTC). O mesmo id com outro instante ou outro status, no lote ou contra o histórico, é `409` e nada do lote é gravado. Lote malformado (evento sem id, campos que não são texto) é `502`.

**Status atual:** entre os eventos cujo status normalizado não é `unknown`, o de maior `occurred_at`, recalculado a partir do histórico inteiro. Um `in_transit` antigo que chega depois de um `delivered` fica no histórico e não faz o pacote regredir.

**Atraso** (`assessDelay`, função pura, relógio é a query `now`):

- `delivered` → não atrasado, `já foi entregue`
- `exception` → não atrasado, `exceção da transportadora, não atraso de trânsito`
- sem evento `posted` → não atrasado, `ainda não foi postado`
- `now - posted_at` > `TRANSIT_LIMIT_HOURS` (padrão 120) → atrasado, com o limite no motivo
- senão → não atrasado, `ainda dentro do limite desde a postagem`

**Agregador:** `src/aggregator.ts` define `TrackingAggregator` (`register`, `events`). O cliente HTTP real fica em `src/http-aggregator.ts`:

```text
POST {AGGREGATOR_URL}/trackers                 {"tracking_code":"BR123"}
GET  {AGGREGATOR_URL}/trackers/BR123/events    {"tracking_code":"BR123","events":[{"id":"ev_1","occurred_at":"…","status":"Postado"}]}
```

Resposta fora desse contrato (HTML, HTTP 5xx, outro código, `events` que não é lista) vira `502`, sem gravar. Os testes do cliente sobem um servidor HTTP falso em `127.0.0.1`. Sem `AGGREGATOR_URL`, `npm run dev` usa um fake em memória com uma viagem curta. Trocar de agregador é trocar essa classe: o formato dele não passa de `src/http-aggregator.ts` e `normalizeStatus`.

**Cadastro:** o mesmo código para o mesmo criador devolve o envio existente (200); para outro criador, `409`. Dois cadastros simultâneos do mesmo código registram no agregador uma vez só: o segundo espera o primeiro, sem transação aberta durante a chamada de rede. Se o agregador falhar, a resposta é `502`, nada é gravado e o retry funciona.

**Limite:** `TRANSIT_LIMIT_HOURS` vale igual para o `GET` e para a resposta do sync.

**Aviso de atraso:** `POST /delay-checks?now=…` roda a checagem (num cron, por exemplo). Envio atrasado ganha um aviso, uma vez só: rodar de novo não duplica. Entrega encerra o aviso com `resolved_at`. `GET /alerts` lista os abertos; `?include_resolved=true`, todos. Exatamente no limite não avisa; 1 ms depois avisa.

**Prazo do agregador:** `register` e `events` têm prazo (`AGGREGATOR_TIMEOUT_MS`, padrão 10 s). No prazo, o `AbortSignal` passado ao adaptador é abortado e a resposta é `502 agregador de rastreio indisponível`, sem gravar nada; o retry funciona.

**Entrada:** corpo precisa ser `application/json` (senão 415), JSON válido e objeto (senão 400) e ter até 64 KB (senão 413). Campo fora do contrato da rota → 400 com o nome do campo. Erro inesperado vira `500 {"error":"erro interno"}`, sem stack na resposta.

## Critérios do enunciado → testes

| Critério ou entrega | Teste |
| --- | --- |
| Status desconhecido não vira entregue | `TELEPORTADO depois de um in_transit…`, `preserva constructor como unknown…` |
| Evento fora de ordem não regride | `in_transit de 2026-06-02 que chega depois do delivered…` |
| Consultar de novo não duplica o histórico | `dois sync com o mesmo event id…`, `deduplica o mesmo evento com representações equivalentes…` |
| Atraso com data controlada | `…48 horas depois…`, `…121 horas depois…`, `1 ms antes do limite não avisa…` |
| Entrega normal não vira atraso | `entregue dez dias depois da postagem não é marcado como atraso`, `entrega depois do alerta encerra o aviso…` |
| Agregador trocável, cliente HTTP atrás de interface | `cadastra o código e lê os eventos no formato do agregador`, `pela API, cadastro e sync usam o cliente HTTP…` |
| Payload bruto ao lado do normalizado | exemplo abaixo, do teste do evento atrasado |

## Decisões que eu deixaria diferentes com mais tempo

- **Push em vez de pull.** O sync consulta o agregador; com webhook do agregador o atraso seria detectado sem depender do cron.
- **Limite por transportadora.** Hoje é um limite global; transportadoras diferentes têm prazos diferentes.
- **Exceção da transportadora não conta como atraso.** Foi uma escolha para não acusar atraso de trânsito em pacote parado por problema; com mais tempo, a exceção aberta por dias também geraria aviso, com motivo próprio.
- **A fila de cadastro concorrente é em memória.** Protege um processo; com vários processos usaria uma reserva gravada no banco.

## Como rodar

Node 22.13 ou maior (primeira versão com `node:sqlite` sem flag).

```bash
npm install
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:43125`. Variável `TRANSIT_LIMIT_HOURS` muda o limite.

## Exemplo: evento antigo que chega atrasado

O teste `in_transit de 2026-06-02 que chega depois do delivered de 2026-06-03 não faz o status regredir` executa estes requests. O agregador devolve primeiro `{"id":"ev_d","occurred_at":"2026-06-03T10:00:00.000Z","status":"Entregue"}` e, no segundo sync, também `{"id":"ev_t","occurred_at":"2026-06-02T10:00:00.000Z","status":"in_transit"}`.

```bash
curl -s -X POST http://127.0.0.1:43125/shipments \
  -H 'content-type: application/json' \
  -d '{"tracking_code":"BR123","creator_id":"crt_ana"}'
# guarde o "id" em ID

curl -s -X POST "http://127.0.0.1:43125/shipments/$ID/sync"
curl -s -X POST "http://127.0.0.1:43125/shipments/$ID/sync"
curl -s "http://127.0.0.1:43125/shipments/$ID?now=2026-06-04T00:00:00.000Z"
```

Resposta do `GET` (o id varia). Cada evento tem o texto bruto ao lado do status normalizado:

```json
{
  "id": "shp_4074104e-edaa-4713-a08a-f460f07f8740",
  "tracking_code": "BR123",
  "creator_id": "crt_ana",
  "status": "delivered",
  "delayed": false,
  "delay_reason": "já foi entregue",
  "events": [
    { "id": "ev_t", "occurred_at": "2026-06-02T10:00:00.000Z", "raw_status": "in_transit", "status": "in_transit" },
    { "id": "ev_d", "occurred_at": "2026-06-03T10:00:00.000Z", "raw_status": "Entregue", "status": "delivered" }
  ]
}
```

O segundo sync responde `"inserted":1,"duplicates":1`: o `ev_d` já estava no histórico.

## Ficou de fora

Várias transportadoras de verdade e webhook push. A consulta é pull, no sync.

## Nota da entrega

Comece por `src/status.ts` e `src/delay.ts`. O status atual é o evento conhecido de maior `occurred_at`, recalculado do histórico inteiro, e não o último que chegou: um `in_transit` de ontem que chega depois do `delivered` de hoje fica no histórico e o pacote continua entregue. Texto que nenhuma transportadora usa, como `TELEPORTADO`, vira `unknown`, entra no histórico com o texto bruto e nunca muda o status nem vira entregue. O histórico é append-only com chave única `(shipment_id, event_id)`, então repetir o sync não duplica. O atraso é função pura com `now` vindo da query: entregue não atrasa, exceção da transportadora não é atraso de trânsito, e o limite padrão é 120 h desde a postagem (48 h não atrasa, 121 h atrasa).

Testes: `npm test` com 35 passando, `npm run typecheck` sem erro. O exemplo deste README é o request do teste do evento atrasado.

Ficou de fora: várias transportadoras de verdade e webhook push.

IA: código, testes e README escritos com assistente de código (Claude Code), a partir de um plano com as regras do desafio. As correções de status herdado, limite no sync, cadastro concorrente e conflito de eventos vieram de programação em pares: o Codex auditou a entrega e escreveu os testes que reproduziam os defeitos; o Claude Code implementou, validou e publicou.
