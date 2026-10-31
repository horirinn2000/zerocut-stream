# Project Specification: ZeroCut Stream (公開台帳・抽選プロトコル ＆ 第1号機ポータル仕様)

## 1. プロジェクトの本質と4つの絶対原則（Iron Rules）

本プロジェクトの核心は、AI実況そのものではなく、**「動画の広告収益を公開台帳で透明化し、実費を除いた純利益100%で独立第三者インディーゲームを定価買い上げし、1人1口の完全等確率抽選で視聴者へ無料配布する」**というオープンソースの還元プロトコルである。

- **透明性のオープンソース保証と制作手段の分離**:
  - 収支計算・複数ゲーム按分・乱数抽選・公開定数・横断整合性検査・Web台帳ポータルを担う本リポジトリ（`zerocut-stream`）は **`GNU AGPLv3`** のオープンソースとして公開し、人間の生身配信者・インディー共同体・AIチャンネルの誰もがそのまま自分のチャンネルに導入できる共通規格とする。
  - 第1号機が動画制作コストを極小化するために用いる動画自動生成エンジン（プロンプト・見せ場抽出・音声合成・編集ロジック）は、模倣スパム量産を防ぐため**別の非公開リポジトリ（`zerocut-engine`：通常の著作権留保 `All Rights Reserved`）**に分離し、Prisma に直接書き込まず原価 JSON を出力して本リポジトリ側の取込 CLI で検査・登録する構成をとる。

実装にあたり以下の**「4つの絶対原則（Iron Rules）」**をコードレベルおよびデータベース制約レベルで厳守し、これに反する機能や変数を一切追加してはならない。

1. **運営利益ゼロ・実費二区分（現金支出インフラ実費と公開定数ベース人件費）の完全公開（Zero Owner Profit）**
   - 運営者の利益マージン（`ownerProfitJpy`）は常に **`0円` 固定**とし、MySQL の単一行 `CHECK (ownerProfitJpy = 0)` 制約およびドメイン不変条件で強制する。
   - **現金支出実費（`totalInfraCostJpy`）**: 動画ごとのAI生成原価（LLM使用時のみ。人間配信者モードでは `0.00円`）、収録用ソフト購入実費（同一ゲームにつき生涯1回限り・領収書URL必須、開発者提供キー時は `0円`）、およびWebサーバー固定実費の合計（1円未満切り捨て＝視聴者有利丸め）を計上する。赤字月は未回収の現金立替実費のみ負の `carryOverToNextJpy` として翌月へ繰り越し、翌月以降の売上から実費同額のみを相殺する。
   - **公開固定分数ベースの人件費実費（`totalLaborCostJpy` / `paidLaborCostJpy`）**: 自己申告や録画放置による水増しを排除するため、時給表と作業分数（および改定履歴 `allowedHistorical*`）は環境変数ではなく公開定数 JSON（`web/src/domain/public_constants.json` ＆ `docs/public_constants.json`、テストで完全一致保証）に固定公開する（`HUMAN_PLAY` 初出ゲーム公開動画1本につき固定プレイ `60分`［同月同ゲームの2本目以降は自動で `0分`］、公開動画1本につき固定確認・投稿 `20分`）。人件費はその月のインフラ控除後残高から払える範囲（`paidLaborCostJpy`）のみ支払い、**売上不足により払えなかった人件費は翌月へ繰り越さず放棄（切捨）**する。
2. **公開再生数比による「独立第三者ゲーム（複数タイトル）」純利益100%定価買い上げ（100% Multi-Game Buyback & No Self-Dealing）**
   - 1つのYouTubeチャンネルで毎日・毎回異なる独立第三者インディーゲームを投稿する運用に対応し、月次精算では当月公開された各ゲーム動画の **YouTube 公開再生数スナップショット比率** で還元可能プール（`netBuybackPoolJpy`）を按分（`SettlementGameAllocation`）して定価買い上げを行う（第三者が検証できない動画別「推定収益」は一切使用しない）。
   - 各ゲームで生じた定価未満の端数（`remainderJpy`）は合算して `carryOverToNextJpy` として翌月の全体プールへ完全繰り越しする。
   - 開発者からPR案件費は一切受け取らない。また運営者自身または関連当事者のタイトル（`isOperatorAffiliated = true`）の登録・精算はドメイン検査で厳格に拒絶する。
   - 調達経路は `PurchaseChannel` により「開発者からの直接定価買い上げ（`DIRECT_FROM_DEVELOPER`：開発者取り分100%）」と、Valveのキー審査上限到達時のフォールバック「Steamストア定価ギフト購入（`STEAM_STORE_GIFT`）」を按分レコードごとに正直に区別する。
3. **既得権益ゼロ・1人1口の完全フラット分配（Strict Flat Equality）**
   - 買い上げたゲームは、締切時刻（`entryCutoffAt`）までにエントリーした認証済み視聴者全員に対して**「完全な1人1口（重み付け係数 `1.0` 固定）」**の等確率抽選で無料配布する。
   - **【絶対禁止】** 古参優遇、課金ランク、紹介ボーナス、過去実績による当選倍率変動は一切実装しない。当選者は公開乱数順位順に並べ、配布キーは `(gameId 昇順, key.id 昇順)` に並べて上から1対1で機械的に割り当てる。
4. **視聴の摩擦ゼロ・無効トラフィック規約違反の完全回避（Zero Friction Viewing）**
   - 専用サイトでの埋め込み動画視聴の強制、視聴確認ボタン、再生連動マイクロペイメント、および「還元プールを増やすための広告視聴・ループ再生の呼びかけ」は一切行ってはならない。
   - 動画視聴は100%通常のYouTube上で行い、本Webシステムは「収支と按分の公開（`/ledger`）」「月1回の抽選エントリー（`/lottery`）」「インディー開発者からのゲーム募集（`/developers`）」「外部検証者向け公開監査API（`/api/public/ledger`）」のみを担う。

---

## 2. リポジトリ構成（公開リポジトリ `zerocut-stream`）

* **ライセンス**: `GNU AGPLv3`（台帳・抽選・検証ロジックの秘匿改変を防止。動画生成エンジン `zerocut-engine` は別リポジトリにて非公開・著作権留保）
* **アーキテクチャ原則**: 全層で依存性の注入（DI）と関心の分離を徹底し、構造化ログ（`pino` キーバリュー属性）および `i18n` メッセージ管理を適用する。

```text
zerocut-stream/
├── CLAUDE.md                             # 本仕様書（マスター設計仕様）
├── README.md                             # プロトコル宣言・数式・公開定数履歴・規約確認・起動手順
├── LICENSE                               # GNU AGPLv3
├── docker-compose.yml                    # MySQL 8.0 コンテナ定義
├── .env.example                          # 環境変数テンプレート（サーバーランタイム設定）
├── docs/
│   ├── public_constants.json             # 公開定数の単一正本（地域別時給表・固定作業分数・改定履歴）
│   ├── architecture.md                   # DIアーキテクチャ・2段階保存則・横断検査仕様
│   ├── video_cost_report_schema.md       # 非公開エンジン出力JSON契約および取込CLI仕様
│   └── gameplay_recording_guide_en.md    # 外部・海外プレイ委託者向け英語1枚録画仕様書
└── web/                                  # 【Next.js (App Router) / TypeScript / Prisma 6 / MySQL 8.0】
    ├── package.json
    ├── prisma/
    │   ├── schema.prisma                 # 複数ゲーム按分・固定分数人件費・事前コミット抽選スキーマ
    │   ├── migrations/                   # SQLマイグレーション（単一行CHECK制約3種含む）
    │   └── seed.ts                       # 複数ゲーム按分シードデータ投入＆整合性監査スクリプト
    └── src/
        ├── domain/
        │   ├── public_constants.json     # web/ バンドル用公開定数JSON（docs/ と完全一致をUT保証）
        │   ├── constants.ts              # 公開定数（時給・分数・改定履歴）の検証・公開モジュール
        │   ├── errors.ts                 # i18n対応ドメインエラー
        │   ├── settlement.ts             # 2段階資金保存則・Hamilton最大剰余法按分・5つの横断検査
        │   └── video_cost_import.ts      # エンジンJSON／人間配信者登録の検査・正規化ドメイン
        ├── cli/
        │   ├── import_video_cost.ts      # 動画原価登録CLI (--file / --human-stream 両対応)
        │   └── settle_month.ts           # 月次精算・抽選確定CLI (Milestone 3)
        ├── i18n/                         # ja / en 多言語メッセージカタログ
        ├── lib/
        │   ├── prisma.ts
        │   ├── logger.ts                 # 構造化ロガー (pino)
        │   ├── steam_key_cipher.ts       # AES-256-GCM 暗号化・復号ヘルパー
        │   └── fair_draw.ts              # drand未来ラウンド導出・SHA-256完全等確率抽選
        └── app/                          # /, /ledger, /lottery, /developers, /api/public/ledger (Milestone 3)
```

---

## 3. 公開前確認・YouTube投稿・取込ワークフロー

1. **収録前**: 対象インディーゲームの配信・収益化ガイドラインおよびBGM権利（Content ID）を確認する。
2. **動画制作**:
   - **AIエンジン利用ノード（第1号機等）**: 別リポジトリの `zerocut-engine` が `docs/public_constants.json` を参照して動画を生成し、開発者への侮辱・禁止表現フィルタと `ffprobe` 機械品質検査を通過した `.mp4`、`upload_bundle.json`、および無編集の `video_cost_report.json` を出力する。
   - **生身配信者ノード**: 配信者自身が通常通り実況動画を制作する（エンジン不要）。
3. **最終目視と YouTube Studio 手動投稿**: 映像・音声の最終確認を行い、YouTube Studio から手動アップロードする（AI音声・合成映像使用時は YouTube Studio の「改変されたコンテンツ／合成コンテンツ」開示ラベルを必ず「はい」に設定し、Content ID 状態を確認する）。
4. **台帳への取込登録（`import_video_cost.ts`）**: 公開後に確定した `youtubeVideoId` と `--ai-disclosure-ack` 等を CLI 引数で渡して `VideoCostLedger` に登録する（同月同ゲームの2本目以降は自動で `playMinutes = 0` に正規化され、同一 `rawFootageSha256` でのプレイ人件費二重計上は拒絶される）。

---

## 4. 月次精算・複数ゲーム按分・完全等確率抽選の数式と制約仕様

### 4.1 資金保存恒等式・人件費放棄ルール・Hamilton 最大剰余法按分

1. **現金支出インフラ実費と発生人件費の分離合算（各1銭単位 `BigInt` 合算後に1円未満切り捨て）**
   $$C_{\text{infra}} = \left\lfloor \sum_v \big(\text{totalGenerationCost}_v + \text{recordingGameCostJpy}_v\big) + \text{webHostingCostJpy} \right\rfloor$$
   $$L_{\text{accrued}} = \text{totalLaborCostJpy} = \left\lfloor \sum_v \big(\text{playLaborCostJpy}_v + \text{reviewLaborCostJpy}_v\big) \right\rfloor$$
2. **支払済み人件費（不足分放棄）と還元可能プール**
   $$\text{paidLaborCostJpy} = \min\Big(\text{totalLaborCostJpy},\ \max\big(0,\ \text{carryOverFromPrevJpy} + R_{\text{ad}} - C_{\text{infra}}\big)\Big)$$
   $$\text{netBuybackPoolJpy} = \text{carryOverFromPrevJpy} + R_{\text{ad}} - C_{\text{infra}} - \text{paidLaborCostJpy}$$
3. **公開再生数比による複数ゲーム予算配分（`SettlementGameAllocation`）**
   - $\text{netBuybackPoolJpy} > 0$ かつ当月総再生数 $V_{\text{total}} = \sum_{i=1}^K V_i > 0$ の場合、`gameId` 昇順のゲーム列に対し `BigInt` Hamilton 最大剰余法（剰余降順 → `gameId` 昇順タイブレーク）で `allocatedBudgetJpy` を決定する（$\sum_{i=1}^K \text{allocatedBudgetJpy}_i = \text{netBuybackPoolJpy}$）。
   - $\text{netBuybackPoolJpy} \le 0$ または $V_{\text{total}} = 0$ の場合は全按分の `allocatedBudgetJpy = 0` とし、`carryOverToNextJpy = netBuybackPoolJpy` とする。
4. **応募者数 $M$ による買上本数クリップ規則と2段階保存則**
   - 各ゲームの予算上限本数を $N_{\text{budget}, i} = \lfloor \text{allocatedBudgetJpy}_i / P_i \rfloor$、合計を $N_{\text{budget\_total}} = \sum_i N_{\text{budget}, i}$ とする。
   - $M \ge N_{\text{budget\_total}}$ なら $N_i = N_{\text{budget}, i}$、$M = 0$ なら $N_i = 0$、$0 < M < N_{\text{budget\_total}}$ なら $N_{\text{budget}, i}$ 比率の Hamilton 最大剰余法（タイブレーク順：`剰余降順 → publicViewCount 降順 → gameId 昇順`）で合計 $M$ 本に決定論的にクリップする。
   - 各ゲームについて $\text{spentJpy}_i = N_i \times P_i$、$\text{remainderJpy}_i = \text{allocatedBudgetJpy}_i - \text{spentJpy}_i$ とすると、月次全体で常に以下が成立する：
     $$\text{carryOverFromPrevJpy} + R_{\text{ad}} - C_{\text{infra}} - \text{paidLaborCostJpy} - \text{totalSpentOnKeysJpy} - \text{carryOverToNextJpy} \equiv \text{ownerProfitJpy} \equiv 0$$

### 4.2 単一行 SQL `CHECK` 制約とドメイン層 5つの横断整合性検査

- **MySQL 単一行 `CHECK` 制約（マイグレーションSQLで強制）**:
  1. `MonthlySettlement`: `chk_zero_owner_profit CHECK (ownerProfitJpy = 0)`
  2. `MonthlySettlement`: `chk_labor_cost_bounds CHECK (totalLaborCostJpy >= 0 AND paidLaborCostJpy >= 0 AND paidLaborCostJpy <= totalLaborCostJpy)`
  3. `SettlementGameAllocation`: `chk_allocation_row_bounds CHECK (allocatedBudgetJpy >= 0 AND unitRetailPriceJpy > 0 AND keysPurchased >= 0 AND spentJpy >= 0 AND remainderJpy >= 0 AND spentJpy + remainderJpy = allocatedBudgetJpy)`
- **ドメイン層 5つの横断整合性検査（`verifySettlementInvariants` で行間保存則を含め強制）**:
  1. **繰越連続性・実費＆固定分数人件費再計算・公開再生数按分一致**: 前月 `carryOverToNextJpy` 一致、公開定数（改定履歴 `allowedHistorical*` 含む）に基づく動画別人件費・収録ソフト購入費の同一ゲーム生涯1回＆領収書要件・同月同ゲーム初出1本制限の再計算一致、`paidLaborCostJpy` 上限式一致、および `viewCountSnapshot` 合計からの Hamilton 按分・行間合計（`SUM(allocatedBudgetJpy) === netBuybackPoolJpy` 等）一致。
  2. **按分レコード単位の在庫・精算枠ID・単価・買上本数・支出額一致**: 各 `SettlementGameAllocation` と紐づく `SteamKeyInventory` の `settlementId`・`gameId`・`purchasePriceJpy`・配布済み（`isDistributed = true`）本数・金額合計の完全一致。
  3. **当選本数直接検査・抽選再計算 ＆ 順位順×「ゲーム順・キー順」1対1割当一致**: `totalKeysPurchased === min(N_budget_total, entries.length)` の直接一致、`executeFairDraw` の順位順当選者リスト一致、および順位 $j$ 位当選者への `(gameId 昇順, key.id 昇順)` 第 $j$ キーの厳密1対1割当。
  4. **`drand` 事前コミットラウンドの再導出一致**: `deriveTargetDrandRound(entryCutoffAt) === committedDrandRound`。
  5. **按分レコード単位の自己取引禁止・承認済み検査**: 全 `SettlementGameAllocation` の対象ゲームが `isOperatorAffiliated === false` かつ `isApproved === true`。
