# 動画原価レポート JSON 契約および取込 CLI 仕様書

本ドキュメントは、非公開リポジトリの動画生成エンジン（`zerocut-engine`）と公開リポジトリの台帳システム（`zerocut-stream`）の間の疎結合データ境界、および人間の生身配信者がエンジン無しで公開動画を登録するための CLI 仕様を定義します。

---

## 1. 設計原則（なぜ JSON 境界と CLI 引数分離を採るのか）

1. **Prisma・内部DBスキーマからの完全分離**:
   - 非公開エンジンは Prisma や MySQL に一切接続せず、内部主キー（`IndieGame.id`）も参照しません。ゲーム識別には公開情報である Steam App ID（`steamAppId`）のみを使用します。
2. **エンジン出力 JSON の無編集（イミュータブル）維持**:
   - エンジンは **YouTube への手動アップロード前** に実行されるため、出力時点では `youtubeVideoId` や YouTube Studio 上での AI 開示ラベル設定（`aiDisclosureSet`）は確定していません。
   - 運営者がエンジン出力後の JSON ファイルを手で書き換える運用（改ざんと区別がつかない運用）を排除するため、**JSON には生成時点で確定している事実のみを含め、公開後に確定する属性はすべて `web` 側取込 CLI の引数で渡す**設計とします。
3. **人間の生身配信者によるエンジンレス運用（`--human-stream`）**:
   - AI エンジンを使わずに生身で実況配信を行うチャンネル運営者は、JSON ファイルを用意することなく `--human-stream` モードで直接 `VideoCostLedger` に公開動画を登録できます（AI生成原価は自動的に `0.00円`、`isSyntheticContent = false`・`aiDisclosureSet = false` 固定となります）。
4. **公開日時（`--published-at`）の明示指定必須**:
   - 実行時刻による月次帰属ズレ（`Asia/Tokyo` 基準）を防ぐため、両モードとも YouTube 上の実際の公開日時（ISO8601）を `--published-at` で明示指定することを必須とします。

---

## 2. エンジン出力 JSON スキーマ（`schemaVersion: "1.0"`）

```json
{
  "schemaVersion": "1.0",
  "steamAppId": "2987650",
  "videoTitle": "【原価公開】激ムズ登山アクションで42分の苦労が1秒で溶ける実況",
  "generatedAt": "2026-10-12T09:30:00.000Z",
  "isSyntheticContent": true,
  "aiGeneration": {
    "llmModelName": "claude-sonnet-4-20250514",
    "inputTokens": 48200,
    "outputTokens": 15100,
    "inputRateUsdPer1M": "3.0000",
    "outputRateUsdPer1M": "15.0000",
    "usdJpyRate": "152.5000",
    "llmCostJpy": "56.59",
    "ttsCostJpy": "0.00",
    "computeCostJpy": "5.81",
    "totalGenerationCostJpy": "62.40"
  },
  "recordingAcquisition": {
    "recordingGameCostJpy": 0,
    "recordingGameReceiptUrl": null
  },
  "footage": {
    "footageSource": "HUMAN_PLAY",
    "rawFootageSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "rawFootageSec": 3720,
    "playRegionCode": "JP"
  }
}
```

### AI 原価の厳密検算式（1銭単位 `ROUND_HALF_UP`）
`inputRateUsdPer1M`・`outputRateUsdPer1M`・`usdJpyRate` をそれぞれ小数第4位までの整数（$10^{-4}$ 単位の `BigInt`）に変換した値を $R_{\text{in}}, R_{\text{out}}, FX$ とすると、`llmCostJpy`（銭単位）は以下の整数演算で一意に定まります：
$$J_{14} = (\text{inputTokens} \times R_{\text{in}} + \text{outputTokens} \times R_{\text{out}}) \times FX$$
$$\text{llmCostSen} = \left\lfloor \frac{J_{14} + 5 \times 10^{11}}{10^{12}} \right\rfloor, \quad \text{totalGenerationCostSen} = \text{llmCostSen} + \text{ttsCostSen} + \text{computeCostSen}$$

---

## 3. 取込 CLI（`web/src/cli/import_video_cost.ts`）実行仕様

### モードA：非公開エンジンの原価 JSON を取り込む場合
```bash
cd web
npm run ledger:import-video -- \
  --file /path/to/video_cost_report.json \
  --youtube-video-id dQw4w9WgXcQ \
  --ai-disclosure-ack \
  --published-at 2026-10-12T10:00:00.000Z \
  --review-region JP \
  --content-id-status CLEAR
```

### モードB：人間の生身配信者がエンジン無しで公開動画を登録する場合
```bash
cd web
npm run ledger:import-video -- \
  --human-stream \
  --steam-app-id 2987650 \
  --title "初見で挑む激ムズ登山インディー実況 #1" \
  --youtube-video-id aBcDeFgHiJk \
  --play-region JP \
  --review-region JP \
  --published-at 2026-10-12T10:00:00.000Z
```

---

## 4. 取込時の横断検査および自動正規化ルール

1. **対象ゲームの適格性・自己取引拒絶**:
   - `steamAppId` に対応する `IndieGame` が DB 上に存在し、`isApproved === true` かつ `isOperatorAffiliated === false` でなければ拒絶します。
2. **確定済み月への後出し登録ロック**:
   - `publishedAt` の `Asia/Tokyo` 暦月（`YYYY-MM`）に対応する `MonthlySettlement` が既に `isSettled === true` の場合は、過去確定台帳の改ざん防止のため登録を拒絶します。
3. **公開要件と AI 開示確認**:
   - `youtubeVideoId` が空または既存レコードと重複する場合は拒絶します。
   - `contentIdStatus === "RESTRICTED"`（公開ブロック動画）は精算対象外のため拒絶します。
   - `isSyntheticContent === true`（AI音声・合成映像使用）の場合、`--ai-disclosure-ack`（`aiDisclosureSet = true`）が指定されていなければ拒絶します。一方、`isSyntheticContent === false`（人間配信者モード等）の場合は `--ai-disclosure-ack` の有無によらず常に `aiDisclosureSet = false` を記録します。
4. **同月・同ゲーム2本目以降の自動 `0分` 正規化と、同一録画ハッシュ二重計上の拒絶**:
   - **拒絶条件**: 既に DB 上に `playMinutes > 0` で登録されている `rawFootageSha256` と同一の録画ハッシュを持つレポートが再び `footageSource = "HUMAN_PLAY"` として投入された場合（月またぎを含む同一生素材の使い回し二重請求）はエラーとして拒絶します。
   - **自動正規化条件**: 異なる録画であっても、同一の `Asia/Tokyo` 暦月（`YYYY-MM`）・同一 `gameId` において既に `playMinutes > 0` の動画が登録済みの場合は、連載動画や切り出し動画を妨げないよう**エラー拒絶せず、2本目以降を自動的に `footageSource = "SECONDARY_CLIP"`・`playMinutes = 0`・`playLaborRateJpyPerHour = 0`・`playLaborCostJpy = "0.00"` に正規化して登録**します（確認・投稿人件費 `reviewMinutes = 20` は公開1本ごとに通常どおり計上されます）。
5. **公開定数（`web/src/domain/public_constants.json` / `docs/public_constants.json`）との完全一致**:
   - 新規登録時の `playRegionCode` / `reviewRegionCode` に対応する時給と固定分数（`60分` / `20分`）は現在有効な公開定数から決定論的に解決し、過去の精算監査時は改定履歴（`allowedHistorical*`）に含まれる値であることを検証します。
6. **収録用ソフト購入実費の生涯1回制限と証跡検査**:
   - `recordingGameCostJpy > 0` の計上は、**同一ゲーム（`gameId`）につき過去月を含め生涯で1回限り**（初回の `HUMAN_PLAY` 動画のみ）とし、かつ有効な領収書URL（`recordingGameReceiptUrl`）の指定を必須とします。
