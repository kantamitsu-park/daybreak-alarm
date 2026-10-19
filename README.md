# Daybreak

[公開アプリ](https://daybreak-alarm.kantapark-work.workers.dev) · [GitHub](https://github.com/kantamitsu-park/daybreak-alarm)

モバイルファーストの目覚ましWebアプリ。アラーム起動時にミッションを表示し、カメラで撮影した動作の判定に合格すると、右フリックで停止・左フリックでスヌーズできます。

白を基調としたLiquid Glass風の画面、画面遷移・カード・フリックのアニメーション、全画面スケルトンローディングを実装しています。

## 利用できる機能

- 時刻・曜日・ミッション・制限時間・回数・スヌーズ時間の設定。
- 水・コーヒー・腕立て伏せのミッションと、その場で提示される手の動作の指示。
- 音声を有効にする就寝モードと、対応ブラウザでの画面消灯防止。
- 動画の撮影、サーバーでの動画フレーム抽出、Workers AIによる達成判定。
- 判定合格前の停止・スヌーズをサーバーでも拒否。合格後の操作は一度だけ有効。
- Googleログイン、アラームの保存、履歴、スヌーズ時刻の保存。
- 未ログイン時の端末内アラーム編集と撮影プレビュー。プレビューには達成扱いにする機能はありません。

技術の選定理由、データ処理、不正対策、テスト範囲は [技術資料](docs/TECHNOLOGY.md) にまとめています。

## 現在の接続・検証状態

Google OAuthとWorkers AI／Media Transformationsの接続コードを実装しています。**Google OAuthのクライアント設定と、実際のGoogleログインから実際の人のミッションを撮影して達成する通しの検証は未完了です。** Google Cloudの新規プロジェクト作成上限に達しており、利用する既存プロジェクトの指定、または上限解除が必要です。

Cloudflareの実環境で、合成動画からのJPEG抽出とWorkers AIへの入力が成功し、ミッションを行っていない合成動画が不合格になることを確認しました。設定画面の「設定済み」はバインディング・設定値の存在を示し、判定精度の保証ではありません。

自動テスト、実ブラウザ操作、実サービスへの接続を分けた検証記録は [テスト記録](docs/TESTING.md) にあります。

## アラームとしての制限

**就寝モード中は、充電しながら画面を開いたまま使用してください。** スマホのロック中、バックグラウンド、ブラウザ終了後の鳴動は保証できません。OSによるページ停止・音声制限があり、Webアプリから標準の目覚ましと同じ動作を強制できないためです。[ブラウザのページライフサイクル](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)、[Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) を参照してください。

本実装はWeb Pushによる通知配信やOSのアラーム予約を行いません。ホーム画面用manifestを備えていますが、オフラインでの判定・バックグラウンド鳴動の保証は追加されません。判定にはインターネット接続とカメラ許可が必要です。

動画の再利用や不自然な動作を検出する仕組みを備えますが、仮想カメラ、改変クライアント、編集動画、AIの誤判定を完全には排除できません。顔の本人認証・生体識別は行いません。

## ローカル開発

Node.js 24以降とnpmを使用してください。バックエンドのテストはNode標準の `node:sqlite` を利用します。

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run build
npm run db:local
```

`.dev.vars` の `APP_ORIGIN` は `http://127.0.0.1:5173` にします。Googleの値を空にした状態でも、編集・プレビューの確認は可能です。秘密値を `VITE_` で始まる変数やフロントエンドのソースへ入れないでください。

ターミナルを2つ開きます。

```sh
# ターミナル1: API
npm run worker:dev
```

```sh
# ターミナル2: フロントエンド
npm run dev
```

[ローカルアプリ](http://127.0.0.1:5173) を開きます。Viteが `/api` をポート8787のWorkerへ転送します。送信元検証を行うため、`localhost` と `127.0.0.1`、ポート番号を混在させないでください。

ローカルD1は `.wrangler` 配下へ保存され、本番D1とは別です。Wranglerのローカル開発だけでAIとMedia Transformationsの本番動作まで確認できるわけではありません。Google認証のSecure Cookieとカメラを含めた通しの確認には、公開したHTTPSの同一オリジンを使ってください。

## Cloudflareへの公開

Cloudflare Workers、D1、Workers AI、Media Transformationsを使います。R2バケットは任意です。動画はR2が設定されていればR2、未設定なら非公開のD1 BLOBへ一時保存します。

別のCloudflareアカウントで初めて構築する場合は、次を実行し、返された `database_id` を `wrangler.jsonc` のD1設定へ反映します。既存のDBがある場合はそのIDを使用してください。

```sh
npx wrangler login
npx wrangler d1 create daybreak
```

`wrangler.jsonc` の `vars.APP_ORIGIN` には本番オリジンを設定済みです。別アカウントへ複製する場合は、この値とGoogleのリダイレクトURIを新しい公開先に置き換えてください。ローカル用の `.dev.vars` は公開時の設定として使用されません。

```sh
npm run db:remote
npm run deploy
```

初回公開でURLが決まった場合は、そのURLを `APP_ORIGIN` とGoogle OAuthの設定へ反映して再デプロイします。公開画面が表示されても、Google認証の設定が終わるまで本番の就寝モードは使えません。

### Google認証

1. Google Cloud Consoleでアプリ用のプロジェクトとOAuth同意画面を設定します。テスト公開の場合は、使用するGoogleアカウントをテストユーザーへ追加します。
2. OAuthクライアントを「ウェブアプリケーション」で作成します。
3. 承認済みリダイレクトURIへ `https://daybreak-alarm.kantapark-work.workers.dev/api/auth/google/callback` を登録します。アプリが要求するスコープは `openid email profile` です。
4. クライアントID・シークレットをWorkerのSecretsへ登録します。コマンドの対話入力で値を渡します。

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Googleの設定変更が必要なのは公開先を変えた場合も同じです。リダイレクトURIと `APP_ORIGIN` が一致していることを確認してください。[GoogleのOAuth Webサーバーフロー](https://developers.google.com/identity/protocols/oauth2/web-server) が設定の参照先です。

### 任意のR2設定

R2を有効にして非公開バケットを作成し、`wrangler.jsonc` に以下を追加すると、一時動画・フレームの保存先がR2へ切り替わります。

```json
"r2_buckets": [
  { "binding": "EVIDENCE", "bucket_name": "YOUR_PRIVATE_BUCKET" }
]
```

公開バケットURLは不要です。保存先を切り替える場合は、進行中の録画・判定がない状態で行ってください。

## データの扱い

- D1にはGoogleアカウントとの対応、名前・メール、セッションのハッシュ、アラーム、ミッション結果を保存します。Googleのパスワードは扱いません。
- 撮影動画と画像は非公開の一時領域に保存し、判定・中断の処理後に稼働中の保存先から削除します。取り残されたデータは15分おきの清掃で、保存後15分を超えたものを対象に削除します。処理失敗や次回実行までの待ち時間があるため、厳密な15分以内の消去保証ではありません。
- D1の削除はバックアップからの即時消去を意味しません。CloudflareのTime Travelには過去のデータが保持され得ます。[D1のTime Travelとバックアップ](https://developers.cloudflare.com/d1/reference/time-travel/) を参照してください。
- 重複検出用ハッシュ・受信時刻などのメタデータは清掃対象になるまで保持します。動画の閲覧・ダウンロード用の公開APIはありません。
- AI推論の処理にはCloudflare側のデータ取り扱いも適用されます。[Workers AIのデータ取り扱い](https://developers.cloudflare.com/workers-ai/platform/data-usage/) を参照してください。

## 検証

```sh
npm run typecheck
npm test
npm run build
```

| 検証 | 確認する内容 | 確認できない内容 |
| --- | --- | --- |
| `tests/alarm.test.ts` | 日時・曜日・日付境界・時刻変更・重複鳴動・端末内保存 | OSによる背景ページ停止、実機の音量 |
| `tests/backend.test.ts` | 実SQLiteのSQL、ユーザー分離、入力検証、停止制限、判定結果の扱い、証拠保存・削除 | Googleの実ログイン、Cloudflare本番AI・Mediaの応答 |
| `tests/camera.test.ts` | 連続撮影、時刻、送信失敗、画面非表示、トラック終了、カメラ解放 | 実機固有のカメラ・録画コーデック |
| `tests/ui.test.tsx` | 設定フォーム、ダイアログ、フリック制限、ミッション画面の状態遷移 | 実ブラウザの描画・タッチ慣性・音声再生 |
| ブラウザ操作と実機確認 | 見た目、操作、実通信、権限、録画、実判定 | 他の全機種・全条件での動作保証 |

実機で完了を確認するには、公開HTTPS URLでGoogleログイン→時刻設定→就寝モード→アラーム起動→実撮影→判定→左右のフリックを通してください。失敗時の再撮影、カメラ拒否、通信断、再読み込み、スヌーズ後の再起動も確認します。未達成動画・静止画・録画画面の再撮影が解除につながらないかも、合格動画と分けて記録します。

## ディレクトリ

```text
src/          React画面、アラーム・音声・カメラ制御
worker/       Google認証、API、動画判定、保存、清掃
shared/       フロントエンドとWorkerが共有する型
migrations/   D1のスキーマ変更
public/       manifest、アイコン、静的配信用ヘッダー
tests/        自動テスト
docs/         技術選定と検証上の説明
```
