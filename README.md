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
| qualquer outro, ex. `TELEPORTADO` | `unknown` |

`unknown` entra no histórico e nunca muda o status atual, nem vira `delivered`.

**Histórico:** append-only, chave única `(shipment_id, event_id)`. O mesmo evento em dois sync não gera segunda linha.

**Status atual:** entre os eventos cujo status normalizado não é `unknown`, o de maior `occurred_at`, recalculado a partir do histórico inteiro. Um `in_transit` antigo que chega depois de um `delivered` fica no histórico e não faz o pacote regredir.

**Atraso** (`assessDelay`, função pura, relógio é a query `now`):

- `delivered` → não atrasado, `já foi entregue`
- `exception` → não atrasado, `exceção da transportadora, não atraso de trânsito`
- sem evento `posted` → não atrasado, `ainda não foi postado`
- `now - posted_at` > `TRANSIT_LIMIT_HOURS` (padrão 120) → atrasado, com o limite no motivo
- senão → não atrasado, `ainda dentro do limite desde a postagem`

**Agregador:** `src/aggregator.ts` define `TrackingAggregator` (`register`, `events`). O teste passa um fake; `npm run dev` passa um fake com uma viagem curta. Só `normalizeStatus` conhece o texto bruto.

## Como rodar

Node 22 ou maior.

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

Testes: `npm test` com 8 passando, `npm run typecheck` sem erro. O exemplo deste README é o request do teste do evento atrasado.

Ficou de fora: várias transportadoras de verdade e webhook push.

IA: código, testes e README escritos com assistente de código (Claude Code), a partir de um plano com as regras do desafio. O assistente rodou os testes e o typecheck e colou a resposta real acima.
