# 検証データJSONの読み方

AI分析画面の「検証データをダウンロード」は、5モデルの比較をschema version 2で保存します。
表示は丸められますが、JSONの`probability`には順位付けに使ったfloat値が入ります。

## ルート項目

| 項目 | 内容 |
| --- | --- |
| `schemaVersion` | 現在は`2`です。 |
| `exportedAt` | UTCの出力日時です。 |
| `runtime.registry` | 使用モデル、入力契約、checkpoint hash、ONNX parityです。 |
| `turnStartState` | 分析開始時の完全なゲーム状態です。 |
| `recentHistory` | V1系に使うrolling配置履歴です。 |
| `v2Tracking` | V2系に使う完了ターン・枠・公開マイナス情報です。 |
| `plannedRefill` | プレイヤーが選んだ補充方法です。 |
| `modelResults` | モデルごとの結果です。 |

検証用の`turnStartState`には対戦相手の手札と山札順も含まれますが、モデルadapterは
各checkpointの入力契約に含まれる情報だけをtensor化します。action-deltaも相手の手札を使いません。

## modelResults

各要素は次の形です。

```json
{
  "modelId": "v2-generation0-epoch001",
  "label": "V2 gen0 epoch001",
  "scoreKind": "probability",
  "status": "ok",
  "error": null,
  "playerSelection": {},
  "aiTop3": [],
  "allAiCandidates": []
}
```

- `scoreKind: "probability"`の`probability`は0から1の推定勝率です。
- `scoreKind: "delta"`では同じフィールドが次状態への改善度です。勝率ではなく、
  画面では100倍して符号付きptとして表示します。
- 1モデルのロードや推論だけが失敗した場合、その要素は`status: "error"`になり、
  残りのモデル結果は保存されます。

## 候補

候補には`playedCardsSignature`、`refillDecision`、`candidateGroupSignature`、
`actions`、`historyAfter`が入ります。自分の手とTop3には`resultingState`も入ります。

- Original V1 2モデルは補充直前の候補状態とrolling直近2配置を評価します。
- V2とV2-liteは補充予定も入力し、カード組＋補充方法で候補をまとめます。
- action-deltaは、他モデルによる事前選抜を行わず、列挙された全候補を評価します。
  カード順と補充方法は差分候補の意味に含みません。

カード配置の`handIndex`は各action実行直前の手札位置です。2枚目は
`turnStartState`の同じindexを指すとは限らないため、`actions`を順番に適用してください。

## PowerShell確認例

```powershell
$data = Get-Content -Raw -Encoding utf8 ".\yellowstone-analysis-....json" |
  ConvertFrom-Json

$data.modelResults |
  Select-Object label, scoreKind, status,
    @{n="own";e={$_.playerSelection.probability}}
```
