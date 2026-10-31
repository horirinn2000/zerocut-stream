# ZeroCut Stream（公開還元・抽選プロトコル ＆ 第1号機ポータル）

**ZeroCut Stream** は、ゲーム実況動画の広告収益を公開台帳で透明化し、実費を除いた純利益100%で独立第三者インディーゲームを定価買い上げし、1人1口の完全等確率抽選で視聴者へ無料配布するための**オープンソース還元プロトコル**です。

- **収支・抽選の透明性はオープンソース（GNU AGPLv3）、動画生成エンジンは非公開**:
  - 本リポジトリ（`zerocut-stream`）は、台帳の計算式・複数ゲーム按分・公開定数・乱数抽選・横断整合性検査・Webポータルを **`GNU AGPLv3`** で公開します。AI実況に限らず、**人間の生身配信者やスタジオ共同体も自分のチャンネルにそのまま導入できる共通規格**です。
  - 第1号機が制作費を下げる一手段として用いる動画生成エンジン（`zerocut-engine`：プロンプト・見せ場抽出・編集ロジック）は、模倣量産チャンネルによるタダ乗りを防ぐため別の非公開リポジトリ（通常の著作権留保 `All Rights Reserved`）に分離しています。エンジンはDBに直接触れず原価JSONを出力し、本リポジトリの取込CLIが横断検査を通して登録します。

---

## 1. 4つの絶対原則（Iron Rules）

1. **運営利益ゼロ・実費二区分の完全公開（Zero Owner Profit）**
   - 運営利益（`ownerProfitJpy`）は常に **`0円` 固定**とし、ドメイン検証と MySQL の単一行 `CHECK (ownerProfitJpy = 0)` 制約の双方で強制します。
   - **現金支出インフラ実費（`totalInfraCostJpy`）**: AI生成原価（人間配信者モードでは `0.00円`）、収録用ソフト購入実費（同一ゲームにつき生涯1回限り・領収書URL必須、開発者提供キー時は `0円`）、Webホスティング実費の合計（1円未満切り捨て）です。赤字月（YouTube 収益化条件到達前を含む）は、未回収の現金立替実費のみ負の `carryOverToNextJpy` として繰り越します。
   - **公開定数ベースの人件費実費（`totalLaborCostJpy` / `paidLaborCostJpy`）**: 自己申告や録画放置による水増しを排除するため、`docs/public_constants.json` の地域別公開時給と固定標準分数（初出プレイ `60分`・確認投稿 `20分`）のみで計上します。人件費はその月のインフラ控除後残高から払える範囲（`paidLaborCostJpy`）のみ支払い、**不足分は翌月へ繰り越さず当月限りで放棄**します。
2. **公開再生数比による「独立第三者インディーゲーム」純利益100%定価買い上げ（100% Multi-Game Buyback）**
   - 毎日・毎回異なるインディーゲームを投稿する運用に対応し、月末時点の各ゲーム動画の **YouTube 公開再生数スナップショット比率** で純プール（`netBuybackPoolJpy`）を按分（`SettlementGameAllocation`）して定価買い上げします。
   - 開発者からPR案件費は一切受け取りません。また運営者・関連当事者タイトルの自己取引（`isOperatorAffiliated = true`）は厳格に拒絶します。
3. **既得権益ゼロ・1人1口の完全フラット分配（Strict Flat Equality）**
   - 買い上げたゲームは、締切時刻までにエントリーした認証済み視聴者全員に対し、**完全な1人1口（重み係数 `1.0` 固定）**の等確率抽選で無料配布します。当選者は公開乱数順位順に並べ、配布キーは `(gameId 昇順, key.id 昇順)` で上から1対1に割り当てます。
4. **視聴の摩擦ゼロ・無効トラフィック規約違反の完全回避（Zero Friction Viewing）**
   - 埋め込み動画の視聴強制や視聴連動ポイントは一切設けず、動画視聴は100%通常のYouTube上で行います。

---

## 2. 公開定数と改定履歴（`docs/public_constants.json` / `web/src/domain/public_constants.json`）

時給単価および固定作業分数は `.env` には置かず、公開定数 JSON（`web/src/domain/public_constants.json` として `web/` に静的バンドル同梱し、`docs/public_constants.json` との完全一致を単体テストで自動保証）で管理します。時給・固定分数の双方に改定履歴（`allowedHistorical*`）を保持するため、将来定数を改定しても過去の全精算レコードが再検証可能です。

- **固定プレイ時間（`playMinutesPerVideo`）**: **`60分`**（`HUMAN_PLAY` の初出ゲーム公開動画1本あたり。同一月・同一ゲームの2本目以降は取込CLIが自動的に `0分` として登録し、同一録画ハッシュでの二重計上は拒絶します）
- **固定確認・投稿時間（`reviewMinutesPerVideo`）**: **`20分`**（YouTube公開動画1本あたり。最終目視確認、配信ガイドライン・Content ID確認、YouTube Studio 手動投稿を含みます）
- **地域別公開時給表（`regionalLaborRatesJpyPerHour`）と改定ルール**:
  - 毎年10月の地域別最低賃金改定時（および新たな委託地域追加時）に現地最低賃金を下回らないことを確認し、コミット履歴と下表に根拠を残して改定します。

| 適用開始日 | 地域コード | 公開時給（円/時） | 設定根拠 |
| :--- | :--- | ---: | :--- |
| `2026-10-01` | `JP` | `1,320` | 2026年10月時点の東京都地域別最低賃金を上回り、外部委託・雇用時にも適法かつ1分単価が整数（`22円/分`）となって視聴者が暗算で検算可能な初期基準値。 |

---

## 3. 分配・繰越の数式と検証可能な乱数抽選

### 3.1 資金保存恒等式と複数ゲーム按分
1. **現金インフラ実費と発生人件費の分離集計**:
   $$C_{\text{infra}} = \left\lfloor \sum_v \big(\text{totalGenerationCost}_v + \text{recordingGameCostJpy}_v\big) + \text{webHostingCostJpy} \right\rfloor$$
   $$\text{totalLaborCostJpy} = \left\lfloor \sum_v \big(\text{playLaborCostJpy}_v + \text{reviewLaborCostJpy}_v\big) \right\rfloor$$
2. **支払済み人件費（不足分放棄）と還元可能プール**:
   $$\text{paidLaborCostJpy} = \min\Big(\text{totalLaborCostJpy},\ \max\big(0,\ \text{carryOverFromPrevJpy} + R_{\text{ad}} - C_{\text{infra}}\big)\Big)$$
   $$\text{netBuybackPoolJpy} = \text{carryOverFromPrevJpy} + R_{\text{ad}} - C_{\text{infra}} - \text{paidLaborCostJpy}$$
3. **公開再生数比による按分と応募数クリップ・翌月繰越**:
   - 黒字かつ当月総再生数 $V_{\text{total}} > 0$ の場合、`BigInt` Hamilton 最大剰余法（`剰余降順 → gameId 昇順`）で $\sum_{i=1}^K \text{allocatedBudgetJpy}_i = \text{netBuybackPoolJpy}$ となるよう配分します。
   - 確定応募者数 $M$ が予算買上可能本数合計 $N_{\text{budget\_total}} = \sum_i \lfloor \text{allocatedBudgetJpy}_i / P_i \rfloor$ 未満の場合は、$N_{\text{budget}, i}$ 比率の Hamilton 最大剰余法（`剰余降順 → publicViewCount 降順 → gameId 昇順`）で合計 $M$ 本にクリップします。
   - 各ゲームの端数 $\text{remainderJpy}_i = \text{allocatedBudgetJpy}_i - N_i \times P_i$ の合計が `carryOverToNextJpy` となり、以下の資金保存恒等式が1円の誤差もなく成立します：
     $$\text{carryOverFromPrevJpy} + R_{\text{ad}} - C_{\text{infra}} - \text{paidLaborCostJpy} - \text{totalSpentOnKeysJpy} - \text{carryOverToNextJpy} \equiv \text{ownerProfitJpy} \equiv 0$$

### 3.2 `drand` 事前コミットによる等確率抽選
募集開始時に締切時刻 $T_{\text{cutoff}}$ 直後の未来ラウンド $r = \lfloor (T_{\text{cutoff,ms}} - T_{\text{genesis,ms}}) / P_{\text{ms}} \rfloor + 2$ を事前公開し、公開乱数シードと `entryId` から `SHA-256("${publicRandomSeed}:${entryId}")` 辞書順昇順で上位 `totalKeysPurchased` 名を選出します。

---

## 4. 仕様上のトレードオフ・監査境界・将来の展望

1. **公開再生数按分における公開時期の偏り**:
   - 月末締切時点の累計公開再生数を用いるため、月初に公開された動画の方が月末公開の動画より再生期間が長くなり有利になります。不透明な補正係数を入れず、第三者が公開データだけで再計算できる検証可能性を優先した設計上の割り切りです。
2. **配分額が定価未満（買上 `0本`）となったゲームおよび未配布余剰在庫キーの扱い**:
   - `allocatedBudgetJpy < unitRetailPriceJpy` となったゲームは当月の買上本数が `0本` となり、配分額は `remainderJpy` として翌月の全体プールへ合算され、翌月は改めて翌月の再生数比で按分されます（ゲーム別の個別積立残高にはならず、当月その開発者への支払いは発生しません。公開台帳 `/ledger` 上でもその旨を明示します）。
   - また、台帳のキー買上支出（`spentJpy` / `totalSpentOnKeysJpy`）に計上されるのは当月の当選者へ実際に配布されたキー（`isDistributed = true`）のみです。運営者が余分に仕入れて未配布のまま残った在庫キー（`isDistributed = false`）は当月の還元プールからは差し引かれず、運営者の自己負担（持ち出し）となります。
3. **自己申告が残る入力値とその防御手段**:
   - **広告売上総額（`grossAdRevenueJpy`）とLLMトークン数**: エンジンが公開・非公開いずれであっても運営者の申告入力となるため、AdSense確定レポート証跡URL（`adRevenueEvidenceUrl`）の添付と、公開再生数×一般的RPMレンジによる外部からの妥当性チェックが防御手段となります。
   - **AI開示ラベル設定フラグ（`aiDisclosureSet`）**: YouTube Data API v3 では Studio 上の「改変・合成コンテンツ」開示ラベルの設定状態を取得できないため、運営者の公開前チェック自己申告記録です（外部APIで機械検証できる項目ではありません）。
4. **将来の展望（自前動画サイトではなく「横断監査ディレクトリ」へ）**:
   - 視聴者基盤と広告収益網を持つ YouTube を離れて自前の動画配信サイトを作ることは原則4（視聴摩擦ゼロ）に反するため行いません。代わりに将来は、複数の配信者が各自で運用する準拠ノードの公開監査API（`/api/public/ledger`）を集約・自動検算する独立した**横断監査サイト（Verifier Hub）**へと発展させます。
5. **マイグレーション管理ルール（重要）**:
   - 初期マイグレーション（`20261031000000_init_zerocut_ledger`）の再生成は本番稼働DBが存在しない初期構築時（Milestone 1.5）限りの措置です。**リポジトリ公開および本番DB稼働開始後は、既存マイグレーションファイルの書き換えを厳禁とし、必ず前方追加マイグレーション（`prisma migrate dev --create-only` → `prisma migrate deploy`）のみで運用してください。**

---

## 5. 本番公開前のリーガル・規約・ガバナンス確認チェックリスト

- [ ] **チャンネル・AdSense 所有権の保持**: 投稿やプレイを外部へ委託する場合でも、YouTube ブランドアカウントの「オーナー権限」と紐づく AdSense 口座は必ず正当な運営主体が保持し、委託先には必要最小限の権限または録画納品窓口のみを渡すこと。
- [ ] **「ZeroCut」名称・ロゴの商標管理**: 公開台帳と等確率抽選を満たす正当な準拠ノードのみが名称を名乗れるよう商標権およびブランド利用規約を整備すること。
- [ ] **YouTube 無効トラフィック・人工的エンゲージメント規約の厳守**: **「還元プールを増やすために広告を見よう／動画をループ再生しよう」といった呼びかけは絶対に行わないこと**（YouTube の無効トラフィック規約違反となります）。また視聴・高評価・チャンネル登録を抽選応募条件に連動させないこと。
- [ ] **YouTube「反復的なコンテンツ」規制および配信ガイドラインの確認**: 各ゲームの配信・収益化ガイドラインとBGM権利（Content ID）を確認し、AI合成使用時は YouTube Studio の開示ラベルを必ず設定すること。
- [ ] **景品表示法・税務・プライバシーポリシーの専門家確認**: オープン懸賞としての整理、インフラ費・人件費・ゲーム買い上げ支出の税務処理、OAuth識別子HMACハッシュ化に関する利用規約を専門家と確認すること。

---

## 6. セットアップとテスト・CLI実行手順

```bash
# 1. 環境変数ファイルの作成
cp .env.example .env
cp .env.example web/.env

# 2. MySQL 8.0 コンテナの起動
docker compose up -d mysql

# 3. 依存インストール・マイグレーション適用・シード投入
cd web
npm install
npx prisma generate
npx prisma migrate deploy
npm run db:seed

# 4. 型チェック・全単体＆DB制約テストの実行
npm run typecheck
npm test

# 5. 公開動画の原価台帳登録 CLI（エンジンJSON取込 または 人間配信者直接登録）
npm run ledger:import-video -- --help
```
