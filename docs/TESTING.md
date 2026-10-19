# 検証記録

確認日: 2026-10-19（JST）

## 自動テスト

- `npm run build`: TypeScriptと本番ビルド成功。
- `npm test`: 全144項目成功（バックエンド60、UI34、時刻・保存32、カメラ18）。
- `npm audit --audit-level=high`: 脆弱性0件。
- Google通信、カメラ、AI、MEDIAの単体テストにはテストダブルを使用。実SQLiteを使ってD1のクエリ、所有者検証、発生時刻・期限、再送拒否、明示的再試行、スヌーズ永続化、一度だけの解除、BLOBの完全性・削除を検証。
- 追加の復帰テストでは、達成後の解除期限切れからの再撮影、停止・スヌーズ完了後の応答消失、最初のミッション作成の通信失敗からの再試行を検証。状態が確認できない通信障害では、達成状態を勝手に無効化しません。

## 実ブラウザ操作

CodexブラウザでUIをクリック・入力・ドラッグして確認。DOMの読み取りと画面で結果を確認し、アプリの状態を書き換えての達成注入はしていません。

- 公開版の320px・390px・1440pxでレイアウトを確認。390pxでは一覧、ミッション、設定も確認し、横方向のはみ出しなし。
- アラーム追加、名前・時刻・ミッション・制限時間・回数変更、保存、再読み込み後の09:45復元、オン／オフ、検証用レコード削除。
- アラームプレビューでミッションが即座に表示され、カウントダウンが始まること。未達成の停止・スヌーズは無効。
- カメラ許可の応答が返らない環境で15秒後にエラーと再撮影ボタンへ復帰。解除はされない。
- 実際のFlickControlを使う開発用ハーネスで、ロック中のドラッグ無効、解除後の右ドラッグ→stop、左ドラッグ→snooze。
- 実際のModalでShift+Tabが最後の要素へ、Tabが先頭へ循環。

開発用ハーネスは `tests/browser-harness.html`。Viteの通常ビルドには含めません。ハーネスでの解除は部品の操作確認であり、本番ミッションの達成テストではありません。

## Cloudflare実接続

本番と同じMEDIA・Workers AIを持つ、ランダムな認証情報で保護した使い捨てWorkerで確認しました。入力は人が映っていない合成動画です。

- MEDIA: HTTP200、image/jpeg、10,062 bytes。
- モデル: `@cf/meta/llama-4-scout-17b-16e-instruct`。
- 本番の `verifyRecording` がサーバー抽出動画8フレームとライブ画像3枚を送信。
- 返却結果: passed=false / challengeMatched=false / continuous=false / replayDetected=true / confidence=0。
- 合成動画を正しく拒否。JSONモードで返るobjectとstringの両方を厳密に検証するよう修正済み。
- 使い捨てWorkerは全て削除済み。認証情報はリポジトリにありません。
- [実接続の結果JSON](live-smoke-result.json)。

ローカルのリモートバインディングではMEDIAのストリームがECONNRESETになったため、本番と同じCloudflare上で検証しています。

## 公開版

- URL: https://daybreak-alarm.kantapark-work.workers.dev
- Cloudflare version: `2615d314-ab8c-41cb-97c4-1b365fc4433f`。
- HTML200、未ログインのアラームAPI401、CSP／カメラ権限ポリシー／HSTSを実レスポンスで確認。
- 公開画面でGoogle認証の未設定状態を確認。ブラウザのconsole errorなし。
- [スマホ画面](screenshots/dashboard-mobile.jpg) / [ミッション画面](screenshots/mission-mobile.jpg)。

## 未完了の受け入れ確認

- Google OAuthの本番クライアント設定と、実際のアカウントでのログイン。
- 実際の人が水・コーヒー・腕立て伏せを行う動画の合格／不合格精度。
- 実機iPhone Safari／Android Chromeでのカメラ、就寝、アラーム起動、判定、フリック、スヌーズを通した確認。

この3点を、自動テストや合成動画の不合格確認に置き換えて「完成」とは扱いません。ブラウザ終了・端末ロック中の確実な鳴動、仮想カメラ等を含む完全な不正防止はWeb版の保証対象にできません。
