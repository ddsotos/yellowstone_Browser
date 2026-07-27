# Yellowstone park Browser

非商用のファン制作ブラウザ実装です。現在はAMIGO社へ公開許可を確認中のため、
このブランチはローカル開発用途です。許可条件を確認するまで公開デプロイしません。

商品版の画像、ロゴ、イラスト、盤面デザインは使用していません。カードは色と数字だけの
独自UIです。

## 現在の機能

- 人間1人 + NPC3人の4人戦
- 通常NPCと価値モデルを使う強化NPC
- 勝率を表示しないモードとAI分析モード
- 自分の手と、カード構成または補充判断が異なるAI上位3択の勝率・盤面プレビュー比較
- 2枚プレイ後の「補充しない」を勝率表示・AI候補・強化NPCの選択から除外
- 完全なゲーム状態と全候補評価を含む検証JSONのダウンロード
- 確定前の選び直し
- localStorageへの1対局自動保存
- 10秒を超えたAI処理のターン単位heuristicフォールバック
- 日本語のルール・AI詳細説明

## ローカル実行

Node.js 18以上が必要です。

```powershell
npm install
npm run dev
```

表示された `http://localhost:5173/` を開きます。AI利用時は、固定バージョンの
ONNX Runtime WebをjsDelivrから取得するためインターネット接続が必要です。

## 検証

```powershell
npm test
npm run build
```

WindowsにMicrosoft Edgeがインストールされている場合は、ローカルサーバー起動中に
次のブラウザスモークテストも実行できます。

```powershell
npm run smoke
```

ダウンロードした検証JSONの各項目と確認方法は、
[検証データJSONの読み方](docs/analysis-json.md)を参照してください。

## モデル更新

`../online_bundle_v2_preview/models/win_value_v2.pt` からONNXを再生成する場合：

```powershell
python -m pip install --target .tools/py onnx==1.18.0 onnxscript==0.3.2
python scripts/export_model_onnx.py
```

変換スクリプトはPyTorch出力とONNX出力の最大絶対誤差を検証し、
`public/models/win_value_v2.json`へ記録します。
ブラウザ推論では、学習時と同じ `strict_residual_v2` 正規化を
盤面・手札・直近3手番・枠移動・公開マイナス情報へ適用してからONNXへ渡します。

## 権利と公開

Original game design: Uwe Rosenberg / Publisher: AMIGO

ゲーム名称、公開条件、第三者による再利用、リポジトリのライセンスは、
AMIGO社からの返信内容を確認した後に確定します。
