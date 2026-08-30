# NKYS Tube Pro

単一HTML（`public/index.html`）で完結する YouTube スタイルの動画ビューア。
依存パッケージゼロ、Node 18+ の標準モジュールのみ。

## API の役割分担

| 役割 | 使用先 |
| --- | --- |
| **ストリーム取得（最優先）** | `https://yt.omada.cafe` のみ（失敗時のみ他へフォールバック） |
| 動画メタ情報 | omada / nadeko / nerdvpn / jing / yewtu |
| 検索 | nerdvpn / nadeko / privacyredirect / reallyaweso / melmac |
| 急上昇（ホーム） | jing / yewtu / nadeko / materialio / privacyredirect |
| コメント | yewtu / nerdvpn / melmac / jing / nadeko |
| チャンネル・登録フィード | nadeko / nerdvpn / yewtu / jing / melmac |

速度と安定性のため、ウェーブ並列レース（速い順に同時投げ）＋インスタンス健全性スコア（応答時間/失敗回数の学習）＋
レスポンスキャッシュ＋同一リクエストのデデュープ＋全プール総当たりの二段フォールバックを実装。

## 機能

ホーム（急上昇＋カテゴリチップ）／検索／視聴ページ（画質切替・シアター・PiP・自動再生・キーボード操作
`k j l f m t i 0-9 < >`）／関連動画／コメント／チャンネル（バナー・登録）／ショート（縦スクロールスナップ）／
登録チャンネルフィード／履歴／高評価／後で見る／再生リスト／ダーク・ライトテーマ／サーバープロキシ切替。

### v2 の変更点

- ストリーム取得を `local=true` 付きで `yt.omada.cafe` にリクエストし、googlevideo 直リンクの
  CORS/帯域制限を回避してより確実に再生できるように改善。再生失敗を検知すると自動で Nocookie 埋め込みに切替。
- 視聴ページに **ストリーム再生 ⇄ Nocookie 再生**（`youtube-nocookie.com` 埋め込み）の切替ボタンを追加。
  設定ダイアログから既定モードも指定可能。
- 視聴ページを先にスケルトン表示してから動画データを読み込むよう変更し、体感の表示速度を向上。
  主要ドメインへ `preconnect`/`dns-prefetch` を追加。
- UI 全体に少し丸みを追加（ボタン・チップ・サムネイル・プレーヤー枠など）。
- チャンネルページを刷新：バナーに重なるアバター、タブ（動画・ショート・概要）を追加し、より YouTube に近い見た目に。

## ローカル実行

```bash
node server.js   # http://localhost:3000
```

## デプロイ

- **Vercel**: リポジトリを import するだけ（`vercel.json` で `server.js` にルーティング）
- **Render**: Blueprint から `render.yaml` を使用、または Web Service で Start Command `node server.js`
- **Railway**: `railway.json`（NIXPACKS）でそのままデプロイ

`/px?u=<url>` はレンジ対応の許可ホスト限定プロキシ。CORS やインスタンス制限で
再生が不安定な場合に、設定ダイアログの「サーバープロキシ経由」で有効化できます。
